// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/historyBackward.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Processed history that runs backwards in time, the edges of the rollup buckets, and the check of Interpolative against the rollups:
// the windows of the data lake answer a backwards read the same as the raw points, a rollup joins an interval only when all of it lies inside
// (the early edge of a backwards interval is open), and a line is never drawn across data that downsampling already replaced.
// The data lake is a stand-in HTTP server and the reader is a real OPC-UA client, like in historyWindows.test.ts.
// =============================================================================
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AggregateFunction, MessageSecurityMode, OPCUAClient, SecurityPolicy, type ClientSession, type HistoryReadResult, type OPCUAServer } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { historyConfigFromEnv, type HistoryConfig } from "../src/history.js";
import { guardInterpolation, type Interval } from "../src/historyProcessed.js";
import { fakeDatalake, LAKE_TOKEN, type FakePoint, type FakeRollup } from "./fakeDatalake.js";

process.env.OPCUA_AUTO_ACCEPT = "1";
// each test starts a real OPC-UA server (two in the differential ones): leave room on a loaded machine
vi.setConfig({ testTimeout: 30_000 });

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const SERIES = { sourceId: "arm-1", kind: "spindle", field: "temp" };
const NODE = "ns=1;s=HydraNode_1.SpindleTemp";
const at = (ms: number) => new Date(BASE + ms);
const RAMP: FakePoint[] = Array.from({ length: 10 }, (_, i) => ({ timestamp: BASE + i * 1000, value: 20 + i }));

function mapFile(content: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opcua-backward-"));
  const file = path.join(dir, "map.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

function historyConfig(url: string, extra: Partial<HistoryConfig> = {}): HistoryConfig {
  return { url, token: LAKE_TOKEN, mapping: { "HydraNode_1.SpindleTemp": SERIES }, maxPoints: 10_000, timeoutMs: 5000, allowAnonymous: false, aggregates: { maxIntervals: 1000 }, ...extra };
}

async function withServer(config: HistoryConfig, run: (read: (fn: AggregateFunction, startMs: number, endMs: number, intervalMs: number) => Promise<HistoryReadResult>) => Promise<void>): Promise<void> {
  process.env.OPCUA_ADMIN_USERNAME = "admin";
  process.env.OPCUA_ADMIN_PASSWORD = "history-pass-1234";
  const built = await buildAddressSpaceServer(0, { history: config });
  const server: OPCUAServer = built.server;
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(server.getEndpointUrl());
  const session: ClientSession = await client.createSession({ type: 1, userName: "admin", password: "history-pass-1234" } as never);
  const read = (fn: AggregateFunction, startMs: number, endMs: number, intervalMs: number): Promise<HistoryReadResult> =>
    (session.readAggregateValue as (...a: unknown[]) => Promise<HistoryReadResult>).call(session, { nodeId: NODE }, at(startMs), at(endMs), fn, intervalMs);
  try {
    await run(read);
  } finally {
    await session.close();
    await client.disconnect();
    await server.shutdown();
    delete process.env.OPCUA_ADMIN_USERNAME;
    delete process.env.OPCUA_ADMIN_PASSWORD;
  }
}

type Cell = { value: { value: unknown }; statusCode: { value: number; name: string } };
const cells = (result: HistoryReadResult): Cell[] => (result.historyData as unknown as { dataValues?: Cell[] } | null)?.dataValues ?? [];
const numbers = (result: HistoryReadResult) => cells(result).map((v) => (v.value.value === null || v.value.value === undefined ? null : Number(v.value.value)));
const isUncertain = (code: number) => ((code >>> 0) & 0xc0000000) === 0x40000000;
const uncertain = (result: HistoryReadResult) => cells(result).map((v) => isUncertain(v.statusCode.value));
const paths = (requests: string[]) => requests.map((r) => new URL(r, "http://x").pathname);

let lake: ReturnType<typeof fakeDatalake>;
const start = async (points: FakePoint[], options: Parameters<typeof fakeDatalake>[1] = {}) => {
  lake = fakeDatalake(points, options);
  await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
};
afterEach(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));

const rollup = (bucketStart: number, bucketMs: number, count: number, min: number, max: number, sum: number): FakeRollup => ({
  sourceId: "arm-1", bucketMs, bucketStart: BASE + bucketStart, count, min, max, sum, avg: sum / count,
});

describe("a backwards processed read from the windows of the data lake", () => {
  it.each([
    ["Average", AggregateFunction.Average],
    ["Minimum", AggregateFunction.Minimum],
    ["Maximum", AggregateFunction.Maximum],
    ["Count", AggregateFunction.Count],
  ])("%s gives the same as the raw points, with the intervals open at the early edge", async (_name, fn) => {
    await start(RAMP, { windows: true });
    let viaRaw: Array<number | null> = [];
    await withServer(historyConfig(lake.url()), async (read) => {
      viaRaw = numbers(await read(fn, 9500, 0, 3000)); // (6500, 9500], (3500, 6500], (500, 3500], (0, 500]
    });
    const before = lake.requests.length;
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(fn, 9500, 0, 3000))).toEqual(viaRaw);
    });
    const used = paths(lake.requests.slice(before));
    expect(used.includes("/windows")).toBe(true);
    expect(used.includes("/history")).toBe(false);
    expect(lake.requests.slice(before).some((r) => r.includes("order=desc") && r.includes("end="))).toBe(true);
  });

  it("matches the raw calculation over random data, forwards and backwards (differential)", async () => {
    let seed = 20261031;
    const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    const points: FakePoint[] = [];
    const seen = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const t = BASE + Math.floor(rand() * 60_000);
      if (seen.has(t)) continue;
      seen.add(t);
      points.push({ timestamp: t, value: Math.round(rand() * 1000) / 10 });
    }
    points.sort((a, b) => a.timestamp - b.timestamp);
    await start(points, { windows: true });
    const reads = [
      [60_000, 0, 7000],
      [59_999, 1, 5000],
      [45_000, 3000, 0],
      [30_000, 29_999, 1],
      [60_000, 0, 0],
    ] as const;
    const out = { raw: [] as unknown[], windows: [] as unknown[] };
    for (const [target, config] of [["raw", historyConfig(lake.url())], ["windows", historyConfig(lake.url(), { useDatalakeWindows: true })]] as const) {
      await withServer(config, async (read) => {
        for (const fn of [AggregateFunction.Average, AggregateFunction.Minimum, AggregateFunction.Maximum, AggregateFunction.Count]) {
          for (const [s, e, step] of reads) {
            const result = await read(fn, s, e, step);
            out[target].push([result.statusCode.name, numbers(result), cells(result).map((c) => c.statusCode.name)]);
          }
        }
      });
    }
    expect(out.windows).toEqual(out.raw);
  });

  it("falls back to the raw points when the data lake ignores order=desc (its windows would not line up)", async () => {
    await start(RAMP, { windows: true, ignoreOrder: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Count, 10_000, 0, 5000))).toEqual([4, 5]);
    });
    expect(paths(lake.requests).includes("/history")).toBe(true);
  });

  it("falls back to the raw points when a backwards window does not line up with its interval", async () => {
    // a data lake that answers order=desc with windows of another width cannot be used
    await start(RAMP, { windows: true });
    const original = lake.server.listeners("request")[0] as (req: unknown, res: { writeHead: (c: number, h?: object) => { end: (b: string) => void } }) => void;
    lake.server.removeAllListeners("request");
    lake.server.on("request", (req: { url?: string }, res: { writeHead: (c: number, h?: object) => { end: (b: string) => void } }) => {
      if ((req.url ?? "").startsWith("/windows")) {
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ order: "desc", buckets: [{ bucketStart: BASE, bucketEnd: BASE + 777, count: 1, min: 1, max: 1, sum: 1 }] }));
        return;
      }
      original(req, res);
    });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Count, 10_000, 0, 5000))).toEqual([4, 5]);
    });
    expect(paths(lake.requests).includes("/history")).toBe(true);
  });
});

describe("the edges of the rollup buckets", () => {
  // the first five seconds (20..24) only exist as rollups; the seconds from the sixth on are raw
  const recent = RAMP.slice(5);

  it("backwards: a bucket inside (low, high] joins the interval, one that starts on the open early edge does not", async () => {
    await start(RAMP.slice(6), { windows: true, rollups: [rollup(1, 5000, 5, 20, 24, 110)] }); // [1, 5000] lies inside (0, 5000]
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 10_000, 0, 5000);
      expect(numbers(count)).toEqual([4, 5]);
      expect(uncertain(count)).toEqual([false, false]);
      expect(numbers(await read(AggregateFunction.Average, 10_000, 0, 5000))[1]).toBe(22);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(recent, { windows: true, rollups: [rollup(0, 5000, 5, 20, 24, 110)] }); // [0, 4999]: the point at 0 is outside (0, 5000]
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 10_000, 0, 5000);
      expect(uncertain(count)).toEqual([false, true]);
      expect(numbers(count)[1]).toBe(1); // only the raw point at 5000 is counted; the bucket is not split
    });
  });

  it("backwards: a bucket on the late edge and one beyond it", async () => {
    await start(RAMP.slice(0, 5), { windows: true, rollups: [rollup(5001, 5000, 4, 26, 29, 110)] }); // [5001, 10000] lies inside (5000, 10000]
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 10_000, 0, 5000);
      expect(numbers(count)).toEqual([4, 4]);
      expect(uncertain(count)).toEqual([false, false]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(RAMP.slice(0, 5), { windows: true, rollups: [rollup(5001, 5000, 4, 26, 29, 110)] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 9000, 0, 5000); // the bucket reaches past the late edge (9000): not whole
      expect(uncertain(count)[0]).toBe(true);
    });
  });

  it("forwards: a bucket that ends exactly on the late edge or starts exactly on the early one is whole; one millisecond more is not", async () => {
    await start(recent, { windows: true, rollups: [rollup(0, 5000, 5, 20, 24, 110)] }); // [0, 4999] in [0, 5000)
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 0, 10_000, 5000);
      expect(numbers(count)).toEqual([5, 5]);
      expect(uncertain(count)).toEqual([false, false]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(recent, { windows: true, rollups: [rollup(0, 5001, 5, 20, 24, 110)] }); // [0, 5000] spills into the next interval
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(uncertain(await read(AggregateFunction.Count, 0, 10_000, 5000))).toEqual([true, true]);
    });
  });

  it("a bucket wholly outside the domain does not mark anything, forwards or backwards", async () => {
    await start(recent, { windows: true, rollups: [rollup(-20_000, 5000, 5, 20, 24, 110)] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(uncertain(await read(AggregateFunction.Count, 0, 10_000, 5000)).some(Boolean)).toBe(false);
      expect(uncertain(await read(AggregateFunction.Count, 10_000, 0, 5000)).some(Boolean)).toBe(false);
    });
  });

  it("a bucket wider than the interval marks every interval it touches, in either direction", async () => {
    await start(recent, { windows: true, rollups: [rollup(-1000, 8000, 8, 20, 27, 200)] }); // [-1000, 6999]
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(uncertain(await read(AggregateFunction.Count, 0, 10_000, 2500))).toEqual([true, true, true, false]);
      expect(uncertain(await read(AggregateFunction.Count, 10_000, 0, 2500))).toEqual([false, true, true, true]);
    });
  });
});

describe("Interpolative is checked against the rollups", () => {
  // no raw point between 2000 and 7000: that stretch was replaced by a rollup
  const gapped = RAMP.filter((p) => p.timestamp - BASE <= 2000 || p.timestamp - BASE >= 7000);
  const gapRollup = rollup(3000, 4000, 4, 23, 26, 98); // [3000, 6999]

  it("gives no value, and Uncertain, where the line would cross the replaced stretch", async () => {
    await start(gapped, { windows: true, rollups: [gapRollup] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const result = await read(AggregateFunction.Interpolative, 1500, 8000, 1000);
      // stamps 1500, 2500 .. 7500: the ones whose neighbours lie on both sides of the replaced stretch are uncertain
      expect(numbers(result)).toEqual([21.5, null, null, null, null, null, 27.5]);
      expect(uncertain(result)).toEqual([false, true, true, true, true, true, false]);
    });
  });

  it("uses the raw point when one sits exactly on the stamp, even next to a rollup", async () => {
    await start(gapped, { windows: true, rollups: [gapRollup] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Interpolative, 2000, 12_000, 5000))).toEqual([22, 27]);
    });
  });

  it("interpolates as before when the rollups are elsewhere, when the data lake has none (404), and with the switch off", async () => {
    await start(gapped, { windows: true, rollups: [rollup(9000, 1000, 1, 29, 29, 29)] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Interpolative, 3500, 3600, 0))).toEqual([23.5]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(gapped, { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Interpolative, 3500, 3600, 0))).toEqual([23.5]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(gapped, { windows: true, rollups: [gapRollup] });
    await withServer(historyConfig(lake.url()), async (read) => {
      expect(numbers(await read(AggregateFunction.Interpolative, 3500, 3600, 0))).toEqual([23.5]); // the switch is off: nothing else is asked
    });
    expect(paths(lake.requests).includes("/rollups")).toBe(false);
  });

  it("is Uncertain when the rollups cannot be read or cannot be trusted (fail closed)", async () => {
    await start(RAMP, { windows: true, rollups: 500 });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const result = await read(AggregateFunction.Interpolative, 500, 3500, 1000);
      expect(numbers(result)).toEqual([null, null, null]);
      expect(uncertain(result)).toEqual([true, true, true]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    // a bucket wider than the lookback: older buckets of that width might reach in unseen
    await start(RAMP, { windows: true, rollups: [rollup(-10_000, 60_000, 6, 1, 2, 9)] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true, rollupLookbackMs: 30_000 }), async (read) => {
      expect(uncertain(await read(AggregateFunction.Interpolative, 500, 3500, 1000))).toEqual([true, true, true]);
    });
  });

  it("does not answer 'no data' where rollups show that data existed before the first raw point", async () => {
    await start(RAMP.slice(5), { windows: true, rollups: [rollup(0, 5000, 5, 20, 24, 110)] });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const result = await read(AggregateFunction.Interpolative, 1000, 3000, 1000);
      expect(numbers(result)).toEqual([null, null]);
      expect(uncertain(result)).toEqual([true, true]);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(RAMP.slice(5), { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(cells(await read(AggregateFunction.Interpolative, 1000, 3000, 1000)).map((c) => c.statusCode.name)).toEqual(["BadNoData", "BadNoData"]);
    });
  });
});

describe("guardInterpolation", () => {
  const interval: Interval = { low: 0, high: 10, stamp: 5, partial: false };
  const outcome = { value: 3, status: { value: 0 } as never };
  it("keeps the outcome when there is no rollup, when a point sits on the stamp, and when the rollups do not touch the stretch", () => {
    const points = [{ timestamp: 2, value: 1 }, { timestamp: 8, value: 5 }];
    expect(guardInterpolation(points, interval, outcome, [])).toBe(outcome);
    expect(guardInterpolation(points, interval, outcome, [{ from: 9, to: 20 }])).toBe(outcome);
    expect(guardInterpolation(points, interval, outcome, [{ from: -9, to: 2 }])).toBe(outcome); // ends on the point before: not inside the open stretch
    expect(guardInterpolation([...points, { timestamp: 5, value: 3 }], interval, outcome, [{ from: 3, to: 6 }])).toBe(outcome);
  });
  it("has no value and is Uncertain when a rollup lies inside the stretch, or when nothing is known", () => {
    const points = [{ timestamp: 2, value: 1 }, { timestamp: 8, value: 5 }];
    for (const spans of [[{ from: 3, to: 4 }], [{ from: 7, to: 7 }], null]) {
      const guarded = guardInterpolation(points, interval, outcome, spans);
      expect(guarded.value).toBeUndefined();
      expect(isUncertain(guarded.status.value)).toBe(true);
    }
  });
});

describe("the lookback setting", () => {
  const base = { HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake", HYDRA_UMC_OPCUA_HISTORY_MAP: mapFile({ "HydraNode_1.SpindleTemp": SERIES }), HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1" };
  it("comes from the environment, only with the windows switch, and is validated", () => {
    expect(historyConfigFromEnv(base)?.rollupLookbackMs).toBeUndefined();
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "1" })?.rollupLookbackMs).toBe(604_800_000);
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "1", HYDRA_UMC_OPCUA_HISTORY_ROLLUP_LOOKBACK_MS: "86400000" })?.rollupLookbackMs).toBe(86_400_000);
    for (const bad of ["0", "-5", "abc", "1.5", "99999999999999"]) {
      expect(() => historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "1", HYDRA_UMC_OPCUA_HISTORY_ROLLUP_LOOKBACK_MS: bad })).toThrow(/ROLLUP_LOOKBACK_MS/);
    }
  });
});
