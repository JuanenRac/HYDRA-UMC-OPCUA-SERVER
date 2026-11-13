// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/historyWindows.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Processed history answered from the windows and rollups of the data lake: the switch (off by default), the same answers as the raw
// calculation, the rollups of data that downsampling already replaced, and the fallback to the raw points whenever the data lake cannot answer.
// The data lake is a stand-in HTTP server and the reader is a real OPC-UA client, like in historyProcessed.test.ts.
// =============================================================================
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AggregateFunction, MessageSecurityMode, OPCUAClient, SecurityPolicy, type ClientSession, type HistoryReadResult, type OPCUAServer } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { historyConfigFromEnv, type HistoryConfig } from "../src/history.js";
import { mergeRollupLevels } from "../src/historyWindows.js";
import { fakeDatalake, LAKE_TOKEN, type FakePoint, type FakeRollup } from "./fakeDatalake.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const SERIES = { sourceId: "arm-1", kind: "spindle", field: "temp" };
const NODE = "ns=2;s=HydraNode_1.SpindleTemp";
const at = (ms: number) => new Date(BASE + ms);
const RAMP: FakePoint[] = Array.from({ length: 10 }, (_, i) => ({ timestamp: BASE + i * 1000, value: 20 + i }));

function mapFile(content: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opcua-windows-"));
  const file = path.join(dir, "map.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

function historyConfig(url: string, extra: Partial<HistoryConfig> = {}): HistoryConfig {
  return {
    url,
    token: LAKE_TOKEN,
    mapping: { "HydraNode_1.SpindleTemp": SERIES },
    maxPoints: 10_000,
    timeoutMs: 5000,
    allowAnonymous: false,
    aggregates: { maxIntervals: 1000 },
    ...extra,
  };
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

const values = (result: HistoryReadResult) => ((result.historyData as unknown as { dataValues?: Array<{ value: { value: unknown }; statusCode: { value: number; name: string } }> } | null)?.dataValues ?? []);
const numbers = (result: HistoryReadResult) => values(result).map((v) => (v.value.value === null || v.value.value === undefined ? null : Number(v.value.value)));
const isUncertain = (code: number) => ((code >>> 0) & 0xc0000000) === 0x40000000;
const paths = (requests: string[]) => requests.map((r) => new URL(r, "http://x").pathname);

describe("the switch", () => {
  const base = { HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake", HYDRA_UMC_OPCUA_HISTORY_MAP: mapFile({ "HydraNode_1.SpindleTemp": SERIES }) };

  it("is off by default, and needs the processed reads", () => {
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1" })?.useDatalakeWindows).toBeUndefined();
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1", HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "0" })?.useDatalakeWindows).toBeUndefined();
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1", HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "1" })?.useDatalakeWindows).toBe(true);
    expect(() => historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS: "1" })).toThrow(/AGGREGATES/);
  });
});

describe("processed history from the windows of the data lake", () => {
  let lake: ReturnType<typeof fakeDatalake>;
  const start = async (points: FakePoint[], options: Parameters<typeof fakeDatalake>[1] = {}) => {
    lake = fakeDatalake(points, options);
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
  };
  afterEach(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));

  it("with the switch off never asks for the windows (the behaviour before it existed)", async () => {
    await start(RAMP, { windows: true, rollups: [] });
    await withServer(historyConfig(lake.url()), async (read) => {
      expect(numbers(await read(AggregateFunction.Average, 0, 10_000, 5000))).toEqual([22, 27]);
    });
    expect(paths(lake.requests).every((p) => p === "/history")).toBe(true);
  });

  it("answers average, minimum, maximum and count of a forward read from one request, the same as the raw points", async () => {
    await start(RAMP, { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const cases: Array<[AggregateFunction, number[]]> = [
        [AggregateFunction.Average, [22, 27]],
        [AggregateFunction.Minimum, [20, 25]],
        [AggregateFunction.Maximum, [24, 29]],
        [AggregateFunction.Count, [5, 5]],
      ];
      for (const [fn, expected] of cases) expect(numbers(await read(fn, 0, 10_000, 5000))).toEqual(expected);
      const cut = await read(AggregateFunction.Average, 0, 8000, 5000);
      expect(numbers(cut)).toEqual([22, 26]);
      expect((values(cut)[1].statusCode.value & 0x4) === 0x4).toBe(true); // the cut last interval is Partial
      expect((values(cut)[0].statusCode.value & 0x4) === 0).toBe(true);
      expect(numbers(await read(AggregateFunction.Maximum, 0, 10_000, 0))).toEqual([29]);
    });
    expect(paths(lake.requests).some((p) => p === "/windows")).toBe(true);
    expect(paths(lake.requests).includes("/history")).toBe(false); // not a single raw point was read
  });

  it("gives BadNoData for an empty interval and 0 for its count, as the raw calculation does", async () => {
    await start(RAMP, { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(values(await read(AggregateFunction.Average, 10_000, 20_000, 5000)).map((v) => v.statusCode.name)).toEqual(["BadNoData", "BadNoData"]);
      expect(numbers(await read(AggregateFunction.Count, 10_000, 20_000, 5000))).toEqual([0, 0]);
    });
  });

  it("matches the raw calculation over random data (differential)", async () => {
    let seed = 12345;
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const points: FakePoint[] = [];
    for (let t = 0; t < 60_000; t += 700 + Math.floor(random() * 900)) points.push({ timestamp: BASE + t, value: Math.round(random() * 1000) / 10 });
    const results: Record<string, number[][]> = {};
    for (const mode of ["raw", "windows"] as const) {
      await start(points, { windows: true });
      await withServer(historyConfig(lake.url(), { useDatalakeWindows: mode === "windows" }), async (read) => {
        results[mode] = [];
        for (const fn of [AggregateFunction.Average, AggregateFunction.Minimum, AggregateFunction.Maximum, AggregateFunction.Count]) {
          for (const [from, to, step] of [[0, 60_000, 10_000], [1500, 47_300, 4000], [0, 61_000, 0]]) {
            results[mode].push(numbers(await read(fn, from, to, step)).map((n) => n ?? -1));
          }
        }
      });
      await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    }
    expect(results.windows).toHaveLength(results.raw.length);
    results.raw.forEach((row, i) => {
      expect(results.windows[i]).toHaveLength(row.length);
      row.forEach((v, j) => expect(results.windows[i][j]).toBeCloseTo(v, 9));
    });
  });

  it("uses the raw points for Interpolative, and the windows for a backwards read", async () => {
    await start(RAMP, { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Interpolative, 500, 3500, 1000))).toEqual([20.5, 21.5, 22.5]);
      expect(paths(lake.requests).includes("/windows")).toBe(false);
      expect(numbers(await read(AggregateFunction.Count, 10_000, 0, 5000))).toEqual([4, 5]);
    });
    expect(paths(lake.requests).includes("/windows")).toBe(true);
  });

  it.each([
    ["the windows are not offered (404)", { windows: undefined }],
    ["the windows fail (500)", { windows: 500 }],
    ["the rollups fail (500)", { windows: true, rollups: 500 }],
  ])("falls back to the raw points when %s", async (_name, options) => {
    await start(RAMP, options as Parameters<typeof fakeDatalake>[1]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Average, 0, 10_000, 5000))).toEqual([22, 27]);
      expect(numbers(await read(AggregateFunction.Count, 0, 10_000, 5000))).toEqual([5, 5]);
    });
    expect(paths(lake.requests).includes("/history")).toBe(true);
  });

  it("falls back when the data lake cannot be reached for the windows, and still reports a lake that is really down", async () => {
    await start(RAMP, { windows: true });
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true, token: "wrong-token-wrong" }), async (read) => {
      expect((await read(AggregateFunction.Average, 0, 10_000, 5000)).statusCode.name).toBe("BadResourceUnavailable");
    });
  });
});

describe("rollups of data that downsampling already replaced", () => {
  let lake: ReturnType<typeof fakeDatalake>;
  beforeEach(() => undefined);
  afterEach(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));
  const start = async (points: FakePoint[], rollups: FakeRollup[]) => {
    lake = fakeDatalake(points, { windows: true, rollups });
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
  };
  // 20..24 (the first five seconds) live only as one rollup of 5 s; 25..29 are still raw
  const oldRollup: FakeRollup = { sourceId: "arm-1", bucketMs: 5000, bucketStart: BASE, count: 5, min: 20, max: 24, sum: 110, avg: 22 };
  const recent = RAMP.slice(5);

  it("adds the rollups that lie inside an interval to its raw part", async () => {
    await start(recent, [oldRollup]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Average, 0, 10_000, 5000))).toEqual([22, 27]);
      expect(numbers(await read(AggregateFunction.Minimum, 0, 10_000, 5000))).toEqual([20, 25]);
      expect(numbers(await read(AggregateFunction.Maximum, 0, 10_000, 5000))).toEqual([24, 29]);
      expect(numbers(await read(AggregateFunction.Count, 0, 10_000, 0))).toEqual([10]);
      const exact = await read(AggregateFunction.Count, 0, 10_000, 5000);
      expect(values(exact).every((v) => !isUncertain(v.statusCode.value))).toBe(true);
    });
  });

  it("marks an interval Uncertain when a rollup straddles its edge, and counts only what can be used", async () => {
    await start(recent, [{ ...oldRollup, bucketStart: BASE + 2500 }]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const result = await read(AggregateFunction.Count, 0, 10_000, 5000);
      expect(numbers(result)).toEqual([0, 5]);
      expect(values(result).map((v) => isUncertain(v.statusCode.value))).toEqual([true, true]);
      const average = await read(AggregateFunction.Average, 0, 10_000, 5000);
      expect(numbers(average)[1]).toBe(27);
      expect(isUncertain(values(average)[0].statusCode.value)).toBe(true);
    });
  });

  it("ignores a rollup that ends before the domain and uses the raw points when three bucket widths overlap", async () => {
    await start(recent, [{ ...oldRollup, bucketStart: BASE - 5000 }]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Count, 0, 10_000, 5000))).toEqual([0, 5]);
      expect(values(await read(AggregateFunction.Count, 0, 10_000, 5000)).some((v) => isUncertain(v.statusCode.value))).toBe(false);
    });
    await new Promise<void>((resolve) => lake.server.close(() => resolve()));
    await start(RAMP, [oldRollup, { ...oldRollup, bucketMs: 1000 }, { ...oldRollup, bucketMs: 2500 }]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Count, 0, 10_000, 5000))).toEqual([5, 5]); // the raw calculation, not a double count
    });
    expect(paths(lake.requests).includes("/history")).toBe(true);
  });

  it("treats a data lake without rollups (404) as having none", async () => {
    lake = fakeDatalake(RAMP, { windows: true });
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(numbers(await read(AggregateFunction.Average, 0, 10_000, 5000))).toEqual([22, 27]);
    });
    expect(paths(lake.requests).includes("/history")).toBe(false);
  });
});

describe("the second (fine) rollup level of the data lake", () => {
  let lake: ReturnType<typeof fakeDatalake>;
  afterEach(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));
  const start = async (points: FakePoint[], rollups: FakeRollup[], windows: boolean | number = true) => {
    lake = fakeDatalake(points, { windows, rollups });
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
  };
  const coarse: FakeRollup = { sourceId: "arm-1", bucketMs: 5000, bucketStart: BASE, count: 5, min: 20, max: 24, sum: 110, avg: 22 };
  // the same five points as five fine buckets of one second (20..24)
  const fine: FakeRollup[] = Array.from({ length: 5 }, (_, i) => ({ sourceId: "arm-1", bucketMs: 1000, bucketStart: BASE + i * 1000, count: 1, min: 20 + i, max: 20 + i, sum: 20 + i, avg: 20 + i }));
  const recent = RAMP.slice(5);

  it("lets an interval edge fall inside a coarse bucket and still answers exactly", async () => {
    await start(recent, [coarse, ...fine]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 0, 10_000, 2000);
      expect(numbers(count)).toEqual([2, 2, 2, 2, 2]);
      expect(values(count).some((v) => isUncertain(v.statusCode.value))).toBe(false);
      const average = await read(AggregateFunction.Average, 0, 10_000, 2000);
      expect(numbers(average)).toEqual([20.5, 22.5, 24.5, 26.5, 28.5]);
      expect(values(average).some((v) => isUncertain(v.statusCode.value))).toBe(false);
    });
    expect(paths(lake.requests).includes("/history")).toBe(false);
  });

  it("without the fine rows the same read is Uncertain where the coarse bucket straddles the edge", async () => {
    await start(recent, [coarse]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 0, 10_000, 2000);
      expect(values(count).slice(0, 3).every((v) => isUncertain(v.statusCode.value))).toBe(true);
    });
  });

  it("works backwards too", async () => {
    await start(recent, [coarse, ...fine]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      // the early edge is open, so the edges sit one millisecond before the buckets: (7999,9999], (5999,7999], (3999,5999], (1999,3999], (-1,1999]
      const count = await read(AggregateFunction.Count, 9_999, -1, 2000);
      expect(values(count).some((v) => isUncertain(v.statusCode.value))).toBe(false);
      expect(numbers(count)).toEqual([2, 2, 2, 2, 2]);
    });
  });

  it("uses the coarse bucket when the fine rows do not add up to it", async () => {
    await start(recent, [coarse, ...fine.slice(0, 3)]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 0, 10_000, 5000);
      expect(numbers(count)).toEqual([5, 5]);
      expect(values(count).some((v) => isUncertain(v.statusCode.value))).toBe(false);
    });
  });
});

describe("mergeRollupLevels", () => {
  const row = (bucketMs: number, bucketStart: number, count: number, sourceId = "a") => ({ sourceId, bucketMs, bucketStart, count, min: 0, max: 0, sum: 0 });

  it("returns a single width unchanged", () => {
    const rows = [row(1000, 0, 1), row(1000, 1000, 2)];
    expect(mergeRollupLevels(rows)).toEqual(rows);
    expect(mergeRollupLevels([])).toEqual([]);
  });

  it("replaces a coarse bucket by its fine buckets only when the counts add up", () => {
    const exact = mergeRollupLevels([row(4000, 0, 3), row(1000, 0, 1), row(1000, 2000, 2)])!;
    expect(exact.map((r) => [r.bucketMs, r.bucketStart])).toEqual([[1000, 0], [1000, 2000]]);
    const partial = mergeRollupLevels([row(4000, 0, 4), row(1000, 0, 1), row(1000, 2000, 2)])!;
    expect(partial.map((r) => [r.bucketMs, r.bucketStart])).toEqual([[4000, 0]]);
  });

  it("keeps fine buckets that have no coarse bucket, and tells the sources apart", () => {
    const merged = mergeRollupLevels([row(4000, 0, 1, "a"), row(1000, 0, 1, "a"), row(1000, 0, 1, "b"), row(1000, 8000, 1, "a")])!;
    expect(merged.map((r) => [r.sourceId, r.bucketMs, r.bucketStart])).toEqual([["a", 1000, 0], ["b", 1000, 0], ["a", 1000, 8000]]);
  });

  it("refuses more than two widths, or two that do not divide each other", () => {
    expect(mergeRollupLevels([row(1000, 0, 1), row(2000, 0, 1), row(4000, 0, 1)])).toBeNull();
    expect(mergeRollupLevels([row(3000, 0, 1), row(5000, 0, 1)])).toBeNull();
  });
});

describe("raw fallback over data that downsampling replaced", () => {
  let lake: ReturnType<typeof fakeDatalake>;
  afterEach(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));
  const start = async (points: FakePoint[], rollups: FakeRollup[] | number | undefined) => {
    lake = fakeDatalake(points, { windows: 500, rollups }); // the windows fail, so the raw points answer
    await new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve));
  };
  const oldRollup: FakeRollup = { sourceId: "arm-1", bucketMs: 5000, bucketStart: BASE, count: 5, min: 20, max: 24, sum: 110, avg: 22 };
  const recent = RAMP.slice(5);

  it("answers Uncertain, not BadNoData, for an interval whose points were replaced by a rollup", async () => {
    await start(recent, [oldRollup]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const average = await read(AggregateFunction.Average, 0, 10_000, 5000);
      const [old, now] = values(average);
      expect(isUncertain(old.statusCode.value)).toBe(true);
      expect(old.statusCode.name).not.toBe("BadNoData");
      expect(isUncertain(now.statusCode.value)).toBe(false);
      expect(numbers(average)[1]).toBe(27);
      for (const fn of [AggregateFunction.Minimum, AggregateFunction.Maximum]) {
        expect(isUncertain(values(await read(fn, 0, 10_000, 5000))[0].statusCode.value)).toBe(true);
      }
      // a count keeps the number of points that remain, marked Uncertain
      const count = await read(AggregateFunction.Count, 0, 10_000, 5000);
      expect(numbers(count)).toEqual([0, 5]);
      expect(values(count).map((v) => isUncertain(v.statusCode.value))).toEqual([true, false]);
    });
  });

  it("also backwards", async () => {
    await start(recent, [oldRollup]);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const count = await read(AggregateFunction.Count, 10_000, 0, 5000);
      expect(values(count).map((v) => isUncertain(v.statusCode.value))).toEqual([false, true]);
    });
  });

  it("keeps BadNoData where no rollup lies and nothing was replaced", async () => {
    await start(recent, []);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      expect(values(await read(AggregateFunction.Average, 0, 5000, 5000)).map((v) => v.statusCode.name)).toEqual(["BadNoData"]);
    });
  });

  it("is Uncertain when the rollups cannot be read, because nothing can be ruled out", async () => {
    await start(recent, 500);
    await withServer(historyConfig(lake.url(), { useDatalakeWindows: true }), async (read) => {
      const average = await read(AggregateFunction.Average, 0, 10_000, 5000);
      expect(values(average).every((v) => isUncertain(v.statusCode.value))).toBe(true);
      expect(numbers(average)[1]).toBe(27);
    });
  });

  it("does not change anything with the switch off (BadNoData, as before)", async () => {
    await start(recent, [oldRollup]);
    await withServer(historyConfig(lake.url()), async (read) => {
      expect(values(await read(AggregateFunction.Average, 0, 5000, 5000)).map((v) => v.statusCode.name)).toEqual(["BadNoData"]);
    });
  });
});
