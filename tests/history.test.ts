// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/history.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Historical Access: a real OPC-UA client reads the history of a variable and the server answers from a stand-in data lake (a small local HTTP
// server that speaks GET /history). Also the configuration (the switch is off by default) and the permissions (no history for anonymous sessions).
// =============================================================================
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy, StatusCodes, type ClientSession, type HistoryReadResult, type OPCUAServer } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { convertValue, fetchHistory, historyConfigFromEnv, parseHistoryMap, queryFromDetails, type HistoryConfig } from "../src/history.js";
import { DataType } from "node-opcua";

process.env.OPCUA_AUTO_ACCEPT = "1";

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const SERIES = { sourceId: "arm-1", kind: "spindle", field: "temp" };

/** A stand-in data lake: ten points one second apart, 20.0 .. 29.0, served the way GET /history does. */
function fakeDatalake(): { server: http.Server; requests: string[]; url: () => string } {
  const all = Array.from({ length: 10 }, (_, i) => ({ timestamp: BASE + i * 1000, value: 20 + i }));
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/history" || req.headers.authorization !== "Bearer lake-token-lake") {
      res.writeHead(url.pathname === "/history" ? 401 : 404).end("{}");
      return;
    }
    const q = url.searchParams;
    const start = q.has("start") ? Number(q.get("start")) : -Infinity;
    const before = q.has("before") ? Number(q.get("before")) : Infinity;
    const desc = q.get("order") === "desc";
    const limit = Number(q.get("limit") ?? 1000);
    let inside = all.filter((p) => p.timestamp >= start && p.timestamp < before);
    if (desc) inside = inside.reverse();
    const offset = q.has("cursor") ? Number(q.get("cursor")) : 0;
    const page = inside.slice(offset, offset + limit);
    const next = offset + limit < inside.length ? String(offset + limit) : null;
    const body: Record<string, unknown> = { order: desc ? "desc" : "asc", points: page, nextCursor: next };
    if (q.get("bounds") === "1") {
      body.bounds = {
        before: [...all].reverse().find((p) => p.timestamp < start) ?? null,
        after: all.find((p) => p.timestamp >= before) ?? null,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { server, requests, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

describe("history configuration", () => {
  it("is off unless the switch says 1, and then needs the address and the map", () => {
    expect(historyConfigFromEnv({})).toBeNull();
    expect(historyConfigFromEnv({ HYDRA_UMC_OPCUA_HISTORY: "0" })).toBeNull();
    expect(() => historyConfigFromEnv({ HYDRA_UMC_OPCUA_HISTORY: "1" })).toThrow(/HISTORY_URL/);
    expect(() => historyConfigFromEnv({ HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake" })).toThrow(/HISTORY_MAP/);
  });

  it("reads the map file, the limits and the anonymous switch", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "opcua-history-"));
    const file = path.join(dir, "map.json");
    writeFileSync(file, JSON.stringify({ "HydraNode_1.SpindleTemp": SERIES }));
    const config = historyConfigFromEnv({
      HYDRA_UMC_OPCUA_HISTORY: "1",
      HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake",
      HYDRA_UMC_OPCUA_HISTORY_MAP: file,
      HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS: "50",
    });
    expect(config?.mapping["HydraNode_1.SpindleTemp"]).toEqual(SERIES);
    expect(config?.maxPoints).toBe(50);
    expect(config?.allowAnonymous).toBe(false);
    expect(() => historyConfigFromEnv({ HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake", HYDRA_UMC_OPCUA_HISTORY_MAP: file, HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS: "0" })).toThrow(/MAX_POINTS/);
  });

  it("refuses a map with a missing part", () => {
    expect(() => parseHistoryMap("[]")).toThrow(/object/);
    expect(() => parseHistoryMap(JSON.stringify({ x: { sourceId: "a", kind: "b" } }))).toThrow(/field/);
  });
});

describe("converting what the data lake stores", () => {
  it("gives each variable its own data type", () => {
    expect(convertValue(1, DataType.Boolean).value).toBe(true);
    expect(convertValue(0, DataType.Boolean).value).toBe(false);
    expect(convertValue(3.6, DataType.UInt32).value).toBe(4);
    expect(convertValue(-2, DataType.UInt32).value).toBe(0);
    expect(convertValue(21.5, DataType.Double).value).toBe(21.5);
  });

  it("turns the details of a read into a window of the data lake", () => {
    const t0 = new Date(BASE);
    const t1 = new Date(BASE + 5000);
    const min = new Date(Date.UTC(1601, 0, 1));
    expect(queryFromDetails({ startTime: t0, endTime: t1, numValuesPerNode: 0, returnBounds: false }, 0, false)).toMatchObject({ startMs: BASE, beforeMs: BASE + 5000, descending: false });
    expect(queryFromDetails({ startTime: t0, endTime: t0, numValuesPerNode: 0, returnBounds: false }, 0, false)).toMatchObject({ startMs: BASE, beforeMs: BASE + 1 });
    expect(queryFromDetails({ startTime: min, endTime: t1, numValuesPerNode: 3, returnBounds: false }, 3, true)).toMatchObject({ startMs: undefined, beforeMs: BASE + 5000, descending: true, limit: 3 });
    expect(queryFromDetails({ startTime: min, endTime: min, numValuesPerNode: 3, returnBounds: false }, 3, false)).toBeNull();
  });
});

describe("fetchHistory against a stand-in data lake", () => {
  const lake = fakeDatalake();
  beforeAll(() => new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve)));
  afterAll(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));
  const config = (extra: Partial<HistoryConfig> = {}): HistoryConfig => ({ url: lake.url(), token: "lake-token-lake", mapping: {}, maxPoints: 10_000, timeoutMs: 5000, allowAnonymous: false, ...extra });

  it("follows the pages of the data lake up to the wanted number of points", async () => {
    const result = await fetchHistory(config(), SERIES, { descending: false, limit: 0, bounds: false });
    expect(result.points.map((p) => p.value)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    const capped = await fetchHistory(config({ maxPoints: 4 }), SERIES, { descending: true, limit: 0, bounds: false });
    expect(capped.points.map((p) => p.value)).toEqual([29, 28, 27, 26]);
    expect(capped.truncated).toBe(true);
  });

  it("reports a refusal of the data lake as an error", async () => {
    await expect(fetchHistory(config({ token: "wrong-token-wrong" }), SERIES, { descending: false, limit: 0, bounds: false })).rejects.toThrow(/401/);
  });
});

describe("HistoryRead over the real protocol", () => {
  const lake = fakeDatalake();
  let server: OPCUAServer;
  let endpoint: string;
  const config = (): HistoryConfig => ({
    url: lake.url(),
    token: "lake-token-lake",
    mapping: { "HydraNode_1.SpindleTemp": SERIES },
    maxPoints: 10_000,
    timeoutMs: 5000,
    allowAnonymous: false,
  });

  beforeAll(async () => {
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
    process.env.OPCUA_ADMIN_USERNAME = "admin";
    process.env.OPCUA_ADMIN_PASSWORD = "history-pass-1234";
    const built = await buildAddressSpaceServer(0, { history: config() });
    server = built.server;
    endpoint = server.getEndpointUrl();
  });
  afterAll(async () => {
    await server?.shutdown();
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    delete process.env.OPCUA_ADMIN_USERNAME;
    delete process.env.OPCUA_ADMIN_PASSWORD;
  });

  async function withSession<T>(fn: (session: ClientSession) => Promise<T>, login = true): Promise<T> {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(endpoint);
    const session = login ? await client.createSession({ type: 1, userName: "admin", password: "history-pass-1234" } as never) : await client.createSession();
    try {
      return await fn(session);
    } finally {
      await session.close();
      await client.disconnect();
    }
  }

  const node = "ns=1;s=HydraNode_1.SpindleTemp";
  const at = (n: number) => new Date(BASE + n * 1000);
  const dataValues = (result: HistoryReadResult) => ((result.historyData as unknown as { dataValues?: Array<{ value: { value: unknown }; statusCode: unknown }> } | null)?.dataValues ?? []);
  const values = (result: HistoryReadResult) => dataValues(result).map((v) => v.value.value);
  const read = (s: ClientSession, start: Date, end: Date, options: Record<string, unknown> = {}): Promise<HistoryReadResult> =>
    (s.readHistoryValue as (...a: unknown[]) => Promise<HistoryReadResult>).call(s, node, start, end, { returnBounds: false, ...options });

  it("answers a read of a window from the data lake, oldest first, the end not included", async () => {
    const result = await withSession((s) => read(s, at(2), at(6)));
    expect(result.statusCode.isGood()).toBe(true);
    expect(values(result)).toEqual([22, 23, 24, 25]);
  });

  it("answers the newest values when only the end is given, and reverses a window asked backwards", async () => {
    const newest = await withSession((s) => read(s, new Date(Date.UTC(1601, 0, 1)), at(10), { numValuesPerNode: 3 }));
    expect(values(newest)).toEqual([29, 28, 27]);
    const backwards = await withSession((s) => read(s, at(5), at(2)));
    expect(values(backwards)).toEqual([24, 23, 22]);
  });

  it("returns the bounding values when asked, and a bound that is not found says so", async () => {
    const result = await withSession((s) => read(s, at(2), at(4), { returnBounds: true }));
    expect(values(result)).toEqual([21, 22, 23, 24]);
    const edge = await withSession((s) => read(s, at(0), at(3), { returnBounds: true }));
    const codes = dataValues(edge).map((v) => v.statusCode);
    expect(codes[0]).toBe(StatusCodes.BadBoundNotFound);
  });

  it("pages a long answer with continuation points", async () => {
    await withSession(async (s) => {
      const first = await read(s, at(0), at(10), { numValuesPerNode: 4 });
      expect(values(first)).toEqual([20, 21, 22, 23]);
      expect(first.continuationPoint).toBeTruthy();
    });
  });

  it("does not give history to an anonymous session unless it is allowed", async () => {
    const result = await withSession((s) => read(s, at(2), at(6)), false);
    expect(result.statusCode.isGood()).toBe(false);
  });

  it("makes only the mapped variables historical, and leaves them read-only", async () => {
    await withSession(async (s) => {
      const mapped = await s.read({ nodeId: node, attributeId: AttributeIds.UserAccessLevel });
      const plain = await s.read({ nodeId: "ns=1;s=HydraNode_1.MaintenanceMode", attributeId: AttributeIds.UserAccessLevel });
      expect(Number(mapped.value.value) & 4).toBe(4); // HistoryRead
      expect(Number(mapped.value.value) & 2).toBe(0); // CurrentWrite
      expect(Number(plain.value.value) & 4).toBe(0);
    });
  });
});
