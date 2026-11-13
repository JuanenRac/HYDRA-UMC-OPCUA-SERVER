// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/simulation-bench.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Simulation bench: the real history reader of the server against a simulated data lake that holds a synthetic machine history (a fixed seed, 5400 points
// over several pages) and fails on command: an error status, a body that is not JSON, a body of the wrong shape, a body cut short, a body far too big, a stall
// longer than the timeout, a refused token, a cursor that never ends, and a link that flaps. No hardware is involved. What the bench proves is that the history
// read ends in either the exact points of the machine or an error, never in invented points and never in a loop.
// =============================================================================

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fetchHistory, type HistoryConfig } from "../src/history.js";

const SEED = 20260101;
const TOKEN = "lake-token-lake";
const SERIES = { sourceId: "arm-1", kind: "spindle", field: "temp" };
const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const POINTS = 5400;

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The synthetic history: one point a second, a temperature that drifts by a seeded random walk. */
function history(): Array<{ timestamp: number; value: number }> {
  const random = seeded(SEED);
  let value = 40;
  return Array.from({ length: POINTS }, (_, index) => {
    value += (random() - 0.5) * 0.4;
    return { timestamp: BASE + index * 1000, value: Math.round(value * 1000) / 1000 };
  });
}

type Mode = "ok" | "http500" | "http503" | "garbage" | "wrong_shape" | "short_body" | "huge_body" | "stall" | "unauthorized" | "endless_cursor" | "junk_points" | "flap";

let mode: Mode = "ok";
let requests = 0;
let failFirst = 0;
const all = history();

const lake = http.createServer((req, res) => {
  requests += 1;
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname !== "/history") return void res.writeHead(404).end("{}");
  if (mode === "unauthorized" || req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('{"error":"token"}');
  if (requests <= failFirst) return void res.writeHead(503).end('{"error":"starting"}');
  if (mode === "http500") return void res.writeHead(500).end('{"error":"internal"}');
  if (mode === "http503") return void res.writeHead(503).end("{}");
  if (mode === "garbage") return void res.writeHead(200, { "Content-Type": "application/json" }).end("<html>not json</html>");
  if (mode === "wrong_shape") return void res.writeHead(200, { "Content-Type": "application/json" }).end('["points","are","a","list"]');
  if (mode === "short_body") {
    const body = JSON.stringify({ points: all.slice(0, 1000), nextCursor: "1000" });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(body.length) });
    res.write(body.slice(0, body.length / 2));
    return void res.destroy();
  }
  if (mode === "huge_body") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"points":[');
    const chunk = '{"timestamp":1,"value":1},'.repeat(40_000);
    for (let i = 0; i < 40; i++) res.write(chunk);
    return void res.end('{"timestamp":1,"value":1}]}');
  }
  if (mode === "stall") return void setTimeout(() => res.writeHead(200).end('{"points":[]}'), 3000).unref();
  const q = url.searchParams;
  const limit = Number(q.get("limit") ?? 1000);
  const offset = q.has("cursor") ? Number(q.get("cursor")) : 0;
  if (mode === "endless_cursor") {
    // every page carries one valid point and points to the same cursor again
    return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ points: [all[0]], nextCursor: String(offset) }));
  }
  let page: unknown[] = all.slice(offset, offset + limit);
  if (mode === "junk_points") page = page.map((p, i) => (i % 3 === 0 ? { timestamp: "now", value: 1 } : i % 3 === 1 ? { timestamp: 5 } : p));
  const next = offset + limit < all.length ? String(offset + limit) : null;
  res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ points: page, nextCursor: next }));
});

beforeAll(() => new Promise<void>((resolve) => lake.listen(0, "127.0.0.1", resolve)));
afterAll(() => new Promise<void>((resolve) => lake.close(() => resolve())));
beforeEach(() => {
  mode = "ok";
  requests = 0;
  failFirst = 0;
});

const config = (extra: Partial<HistoryConfig> = {}): HistoryConfig => ({
  url: `http://127.0.0.1:${(lake.address() as AddressInfo).port}`,
  token: TOKEN,
  mapping: {},
  maxPoints: 10_000,
  timeoutMs: 1000,
  allowAnonymous: false,
  ...extra,
});

const read = (extra: Partial<HistoryConfig> = {}, query: { limit?: number; descending?: boolean } = {}) =>
  fetchHistory(config(extra), SERIES, { descending: query.descending ?? false, limit: query.limit ?? 0, bounds: false });

describe("a healthy simulated data lake", () => {
  it("returns every point of the machine, in order, across six pages", async () => {
    const result = await read();
    expect(result.points).toHaveLength(POINTS);
    expect(result.points.map((p) => p.value)).toEqual(all.map((p) => p.value));
    expect(result.truncated).toBe(false);
    expect(requests).toBe(6);
  });

  it("stops at the number of points that was wanted and says it left some behind", async () => {
    const result = await read({ maxPoints: 2500 });
    expect(result.points).toHaveLength(2500);
    expect(result.points[2499]).toEqual(all[2499]);
    expect(result.truncated).toBe(true);
    expect(requests).toBe(3);
  });

  it("asks for no more than the caller wanted", async () => {
    const result = await read({}, { limit: 7 });
    expect(result.points).toEqual(all.slice(0, 7));
    expect(result.truncated).toBe(false);
  });

  it("gives the same answer twice (the history is a pure function of the data)", async () => {
    expect(await read()).toEqual(await read());
  });
});

describe("a data lake that fails", () => {
  it.each([
    ["http500", /HTTP 500/],
    ["http503", /HTTP 503/],
    ["unauthorized", /HTTP 401/],
  ] as const)("reports %s as an error and no points", async (failing, message) => {
    mode = failing;
    await expect(read()).rejects.toThrow(message);
  });

  it("refuses a body that is not JSON or not the shape of a history", async () => {
    mode = "garbage";
    await expect(read()).rejects.toThrow();
    mode = "wrong_shape";
    const shaped = await read().catch((error: unknown) => error);
    // a list is not a history: either an error, or no points at all; never points out of nothing
    if (shaped instanceof Error) expect(shaped.message.length).toBeGreaterThan(0);
    else expect((shaped as { points: unknown[] }).points).toEqual([]);
  });

  it("does not return the first half of a body that was cut short", async () => {
    mode = "short_body";
    await expect(read()).rejects.toThrow();
  });

  it("refuses a body that is far bigger than any history page", async () => {
    mode = "huge_body";
    await expect(read()).rejects.toThrow();
  });

  it("ends in an error when the lake stalls longer than the timeout", async () => {
    mode = "stall";
    const started = Date.now();
    await expect(read({ timeoutMs: 300 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2500);
  });

  it("keeps only the valid points of a page that holds junk", async () => {
    mode = "junk_points";
    const result = await read();
    expect(result.points.length).toBeGreaterThan(0);
    expect(result.points.length).toBeLessThan(POINTS);
    for (const point of result.points) {
      expect(typeof point.timestamp).toBe("number");
      expect(typeof point.value).toBe("number");
    }
  });

  it("does not loop forever on a cursor that never ends", async () => {
    mode = "endless_cursor";
    const result = await read({ maxPoints: 50 });
    expect(result.points).toHaveLength(50);
    expect(requests).toBeLessThanOrEqual(60);
  });

  it("recovers after a lake that was still starting", async () => {
    failFirst = 1;
    await expect(read()).rejects.toThrow(/HTTP 503/);
    const result = await read();
    expect(result.points).toHaveLength(POINTS);
  });

  it("reports a link that is cut at the connection and not only at the status", async () => {
    const cut = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(read({ fetchImpl: cut })).rejects.toThrow(/fetch failed/);
  });

  it("never sends the token anywhere but the lake it was given", async () => {
    const seen: string[] = [];
    const spy = (async (input: URL | RequestInfo, init?: RequestInit) => {
      seen.push(String(input), JSON.stringify(init?.headers ?? {}));
      return new Response(JSON.stringify({ points: [], nextCursor: null }), { status: 200 });
    }) as unknown as typeof fetch;
    await read({ fetchImpl: spy });
    expect(seen[0]).toContain(`127.0.0.1:${(lake.address() as AddressInfo).port}/history`);
    expect(seen[0]).toContain("sourceId=arm-1");
    expect(seen[1]).toContain(`Bearer ${TOKEN}`);
  });
});
