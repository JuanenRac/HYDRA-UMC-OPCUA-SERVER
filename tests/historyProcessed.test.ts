// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/historyProcessed.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Processed history and event history: the pure computations, the configuration (both switches are off by default) and, over the real protocol,
// a real OPC-UA client reading aggregates and events from a server whose data lake is a stand-in HTTP server.
// =============================================================================
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AggregateFunction,
  DataType,
  HistoryReadRequest,
  HistoryReadValueId,
  MessageSecurityMode,
  OPCUAClient,
  ReadEventDetails,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  constructEventFilter,
  type ClientSession,
  type HistoryReadResult,
  type OPCUAServer,
} from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { historyConfigFromEnv, type HistoryConfig } from "../src/history.js";
import { computeAggregate, planIntervals, type Interval } from "../src/historyProcessed.js";
import { deriveEvents, eventIdOf, parseEventsMap, type EventRule } from "../src/historyEvents.js";
import { fakeDatalake, LAKE_TOKEN, type FakePoint } from "./fakeDatalake.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

const BASE = Date.UTC(2026, 5, 1, 12, 0, 0);
const SERIES = { sourceId: "arm-1", kind: "spindle", field: "temp" };
const TEMPS = [20, 30, 90, 95, 70, 85, 60, 40, 82, 10];
const LAKE_POINTS: Record<string, FakePoint[]> = {
  temp: TEMPS.map((value, i) => ({ timestamp: BASE + i * 1000, value })),
};
const RAMP: FakePoint[] = Array.from({ length: 10 }, (_, i) => ({ timestamp: BASE + i * 1000, value: 20 + i }));

const HOT_RULE: EventRule = { name: "SpindleHot", series: SERIES, high: 80, severity: 700, message: "Spindle temperature above 80" };

function mapFile(content: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "opcua-processed-"));
  const file = path.join(dir, "map.json");
  writeFileSync(file, JSON.stringify(content));
  return file;
}

describe("the intervals of a processed read", () => {
  it("cuts a forward domain, with the last interval partial", () => {
    const plan = planIntervals(0, 12_000, 5000, 100);
    if (!("intervals" in plan)) throw new Error("expected a plan");
    expect(plan.reverse).toBe(false);
    expect(plan.intervals).toEqual([
      { low: 0, high: 5000, stamp: 0, partial: false },
      { low: 5000, high: 10_000, stamp: 5000, partial: false },
      { low: 10_000, high: 12_000, stamp: 10_000, partial: true },
    ]);
  });

  it("cuts a backwards domain from the later end", () => {
    const plan = planIntervals(12_000, 0, 5000, 100);
    if (!("intervals" in plan)) throw new Error("expected a plan");
    expect(plan.reverse).toBe(true);
    expect(plan.intervals.map((i) => [i.low, i.high, i.stamp, i.partial])).toEqual([
      [7000, 12_000, 12_000, false],
      [2000, 7000, 7000, false],
      [0, 2000, 2000, true],
    ]);
    expect(plan.beforeMs).toBe(12_001); // the later end belongs to the first interval
  });

  it("takes an interval of zero as one interval for the whole domain, and refuses what cannot be served", () => {
    const plan = planIntervals(0, 9000, 0, 100);
    if (!("intervals" in plan)) throw new Error("expected a plan");
    expect(plan.intervals).toHaveLength(1);
    expect(planIntervals(5, 5, 1000, 100)).toBe(StatusCodes.BadInvalidArgument);
    expect(planIntervals(0, 1000, -1, 100)).toBe(StatusCodes.BadInvalidArgument);
    expect(planIntervals(0, 1_000_000, 1, 100)).toBe(StatusCodes.BadResponseTooLarge);
  });
});

describe("the aggregates of one interval", () => {
  const points = RAMP; // 20 .. 29, one per second from BASE
  const interval = (lowS: number, highS: number, partial = false): Interval => ({ low: BASE + lowS * 1000, high: BASE + highS * 1000, stamp: BASE + lowS * 1000, partial });

  it("computes average, minimum, maximum and count over the points inside, the end excluded", () => {
    const i = interval(0, 5);
    expect(computeAggregate("average", points, i, false).value).toBe(22);
    expect(computeAggregate("minimum", points, i, false).value).toBe(20);
    expect(computeAggregate("maximum", points, i, false).value).toBe(24);
    expect(computeAggregate("count", points, i, false).value).toBe(5);
  });

  it("marks a cut interval as partial, and an interval without points as no data (a count says zero)", () => {
    expect(computeAggregate("average", points, interval(5, 8, true), false).status.value & 0x4).toBe(0x4);
    expect(computeAggregate("average", points, interval(0, 5), false).status.value & 0x4).toBe(0);
    const empty = interval(40, 45);
    expect(computeAggregate("average", points, empty, false)).toEqual({ status: StatusCodes.BadNoData });
    expect(computeAggregate("count", points, empty, false).value).toBe(0);
  });

  it("interpolates in a straight line at the start of the interval and says so", () => {
    const between = computeAggregate("interpolative", points, { low: BASE + 500, high: BASE + 1500, stamp: BASE + 500, partial: false }, false);
    expect(between.value).toBeCloseTo(20.5, 10);
    expect(between.status.value & 0x2).toBe(0x2);
    const exact = computeAggregate("interpolative", points, interval(2, 3), false);
    expect(exact.value).toBe(22);
    expect(exact.status).toBe(StatusCodes.Good);
    expect(computeAggregate("interpolative", points, interval(20, 21), false).status).toBe(StatusCodes.BadNoData); // nothing after
  });

  it("counts a point on the later end for a backwards read, and not on the earlier one", () => {
    const i: Interval = { low: BASE + 2000, high: BASE + 5000, stamp: BASE + 5000, partial: false };
    expect(computeAggregate("count", points, i, true).value).toBe(3); // 3 s, 4 s and 5 s
    expect(computeAggregate("count", points, i, false).value).toBe(3); // 2 s, 3 s and 4 s
  });
});

describe("the event rules", () => {
  it("are read from a file and checked", () => {
    const parsed = parseEventsMap(JSON.stringify({ HydraNode_1: [{ name: "Hot", series: SERIES, high: 80 }] }));
    expect(parsed.HydraNode_1[0]).toMatchObject({ name: "Hot", high: 80, severity: 500, message: "Hot" });
    expect(() => parseEventsMap("[]")).toThrow(/object/);
    expect(() => parseEventsMap(JSON.stringify({ A: [{ name: "x", series: SERIES }] }))).toThrow(/high, low or both/);
    expect(() => parseEventsMap(JSON.stringify({ A: [{ name: "x", series: SERIES, high: 1, low: 2 }] }))).toThrow(/below high/);
    expect(() => parseEventsMap(JSON.stringify({ A: [{ name: "x", series: SERIES, high: 1, severity: 0 }] }))).toThrow(/severity/);
    expect(() => parseEventsMap(JSON.stringify({ A: [{ name: "x", series: { sourceId: "a" }, high: 1 }] }))).toThrow(/series.kind/);
  });

  it("turn each rise above the limit into one event, and count a history that starts outside the limit", () => {
    const points = TEMPS.map((value, i) => ({ timestamp: BASE + i * 1000, value }));
    const events = deriveEvents(HOT_RULE, "HydraNode_1", points, null);
    expect(events.map((e) => [e.timestamp - BASE, e.value])).toEqual([[2000, 90], [5000, 85], [8000, 82]]);
    // starting inside the window while the point before was already hot: no new event for the first point
    const hotBefore = deriveEvents(HOT_RULE, "HydraNode_1", points.slice(2, 5), { timestamp: BASE + 1500, value: 99 });
    expect(hotBefore).toEqual([]);
    const lowRule: EventRule = { ...HOT_RULE, name: "Cold", high: undefined, low: 25 };
    expect(deriveEvents(lowRule, "HydraNode_1", points, null).map((e) => e.timestamp - BASE)).toEqual([0, 9000]);
    expect(eventIdOf(events[0]).equals(eventIdOf(deriveEvents(HOT_RULE, "HydraNode_1", points, null)[0]))).toBe(true);
    expect(eventIdOf(events[0]).equals(eventIdOf(events[1]))).toBe(false);
  });
});

describe("configuration of processed and event history", () => {
  it("is off unless its own switch says 1", () => {
    const base = { HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake", HYDRA_UMC_OPCUA_HISTORY_MAP: mapFile({ "HydraNode_1.SpindleTemp": SERIES }) };
    const plain = historyConfigFromEnv(base);
    expect(plain?.aggregates).toBeUndefined();
    expect(plain?.events).toBeUndefined();
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "0", HYDRA_UMC_OPCUA_HISTORY_EVENTS: "0" })?.aggregates).toBeUndefined();
    // the switches do nothing while history itself is off
    expect(historyConfigFromEnv({ HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1", HYDRA_UMC_OPCUA_HISTORY_EVENTS: "1" })).toBeNull();
  });

  it("reads the interval limit and the events file, and refuses a missing or wrong value", () => {
    const eventsFile = mapFile({ HydraNode_1: [{ name: "Hot", series: SERIES, high: 80 }] });
    const base = { HYDRA_UMC_OPCUA_HISTORY: "1", HYDRA_UMC_OPCUA_HISTORY_URL: "http://lake", HYDRA_UMC_OPCUA_HISTORY_MAP: mapFile({ "HydraNode_1.SpindleTemp": SERIES }) };
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1" })?.aggregates).toEqual({ maxIntervals: 1000 });
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1", HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS: "50" })?.aggregates).toEqual({ maxIntervals: 50 });
    expect(() => historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_AGGREGATES: "1", HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS: "0" })).toThrow(/MAX_INTERVALS/);
    expect(() => historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_EVENTS: "1" })).toThrow(/EVENTS_MAP/);
    expect(historyConfigFromEnv({ ...base, HYDRA_UMC_OPCUA_HISTORY_EVENTS: "1", HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP: eventsFile })?.events?.HydraNode_1[0].name).toBe("Hot");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// over the real protocol
// ---------------------------------------------------------------------------------------------------------------------------------

const NODE = "ns=1;s=HydraNode_1.SpindleTemp";
const OBJECT = "ns=1;s=HydraNode_1";
const at = (ms: number) => new Date(BASE + ms);

function historyConfig(url: string, extra: Partial<HistoryConfig> = {}): HistoryConfig {
  return {
    url,
    token: LAKE_TOKEN,
    mapping: { "HydraNode_1.SpindleTemp": SERIES },
    maxPoints: 10_000,
    timeoutMs: 5000,
    allowAnonymous: false,
    ...extra,
  };
}

async function withServer(config: HistoryConfig, run: (open: <T>(fn: (session: ClientSession) => Promise<T>, login?: boolean) => Promise<T>) => Promise<void>): Promise<void> {
  process.env.OPCUA_ADMIN_USERNAME = "admin";
  process.env.OPCUA_ADMIN_PASSWORD = "history-pass-1234";
  const built = await buildAddressSpaceServer(0, { history: config });
  const server: OPCUAServer = built.server;
  const endpoint = server.getEndpointUrl();
  const open = async <T,>(fn: (session: ClientSession) => Promise<T>, login = true): Promise<T> => {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(endpoint);
    const session = login ? await client.createSession({ type: 1, userName: "admin", password: "history-pass-1234" } as never) : await client.createSession();
    try {
      return await fn(session);
    } finally {
      await session.close();
      await client.disconnect();
    }
  };
  try {
    await run(open);
  } finally {
    await server.shutdown();
    delete process.env.OPCUA_ADMIN_USERNAME;
    delete process.env.OPCUA_ADMIN_PASSWORD;
  }
}

const dataValues = (result: HistoryReadResult) => ((result.historyData as unknown as { dataValues?: Array<{ value: { value: unknown }; statusCode: { value: number; name: string }; sourceTimestamp: Date }> } | null)?.dataValues ?? []);

const aggregate = (s: ClientSession, fn: AggregateFunction, startMs: number, endMs: number, intervalMs: number): Promise<HistoryReadResult> =>
  (s.readAggregateValue as (...a: unknown[]) => Promise<HistoryReadResult>).call(s, { nodeId: NODE }, at(startMs), at(endMs), fn, intervalMs);

describe("processed HistoryRead over the real protocol", () => {
  const lake = fakeDatalake(RAMP);
  beforeAll(() => new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve)));
  afterAll(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));

  it("stays unsupported while its switch is off (history itself still works)", async () => {
    await withServer(historyConfig(lake.url()), async (open) => {
      const result = await open((s) => aggregate(s, AggregateFunction.Average, 0, 10_000, 5000));
      expect(result.statusCode.name).toBe("BadHistoryOperationUnsupported");
      expect(dataValues(result)).toEqual([]);
      const raw = await open((s) => (s.readHistoryValue as (...a: unknown[]) => Promise<HistoryReadResult>).call(s, NODE, at(0), at(3000), { returnBounds: false }));
      expect(dataValues(raw).map((v) => v.value.value)).toEqual([20, 21, 22]);
    });
  });

  it("answers the average, minimum, maximum and count of every interval", async () => {
    await withServer(historyConfig(lake.url(), { aggregates: { maxIntervals: 1000 } }), async (open) => {
      const cases: Array<[AggregateFunction, unknown[]]> = [
        [AggregateFunction.Average, [22, 27]],
        [AggregateFunction.Minimum, [20, 25]],
        [AggregateFunction.Maximum, [24, 29]],
        [AggregateFunction.Count, [5, 5]],
      ];
      for (const [fn, expected] of cases) {
        const result = await open((s) => aggregate(s, fn, 0, 10_000, 5000));
        expect(result.statusCode.isGood()).toBe(true);
        const values = dataValues(result);
        expect(values.map((v) => v.value.value)).toEqual(expected);
        expect(values.map((v) => v.sourceTimestamp.getTime())).toEqual([BASE, BASE + 5000]);
        expect(values.every((v) => (v.statusCode.value & 0x1) === 0x1)).toBe(true); // HistorianCalculated
      }
    });
  });

  it("marks the cut last interval as partial, answers one interval for a processing interval of zero and reads backwards", async () => {
    await withServer(historyConfig(lake.url(), { aggregates: { maxIntervals: 1000 } }), async (open) => {
      const cut = dataValues(await open((s) => aggregate(s, AggregateFunction.Average, 0, 8000, 5000)));
      expect(cut.map((v) => v.value.value)).toEqual([22, 26]);
      expect((cut[1].statusCode.value & 0x4) === 0x4).toBe(true);
      expect((cut[0].statusCode.value & 0x4) === 0).toBe(true);

      const whole = dataValues(await open((s) => aggregate(s, AggregateFunction.Maximum, 0, 10_000, 0)));
      expect(whole.map((v) => v.value.value)).toEqual([29]);

      const backwards = dataValues(await open((s) => aggregate(s, AggregateFunction.Count, 10_000, 0, 5000)));
      expect(backwards.map((v) => v.value.value)).toEqual([4, 5]); // (5 s, 10 s] holds 6..9 s; (0, 5 s] holds 1..5 s
      expect(backwards.map((v) => v.sourceTimestamp.getTime())).toEqual([BASE + 10_000, BASE + 5000]);
    });
  });

  it("interpolates at the start of each interval, with the bounding values from outside the domain", async () => {
    await withServer(historyConfig(lake.url(), { aggregates: { maxIntervals: 1000 } }), async (open) => {
      const values = dataValues(await open((s) => aggregate(s, AggregateFunction.Interpolative, 500, 3500, 1000)));
      expect(values.map((v) => Number(v.value.value))).toEqual([20.5, 21.5, 22.5]);
      expect(values.every((v) => (v.statusCode.value & 0x2) === 0x2)).toBe(true);
      const onPoint = dataValues(await open((s) => aggregate(s, AggregateFunction.Interpolative, 2000, 4000, 1000)));
      expect(onPoint.map((v) => v.value.value)).toEqual([22, 23]);
      const beyond = dataValues(await open((s) => aggregate(s, AggregateFunction.Interpolative, 9000, 12_000, 1000)));
      expect(beyond.map((v) => v.statusCode.name)).toEqual(["Good", "BadNoData", "BadNoData"]);
    });
  });

  it("says what it cannot do: another aggregate, too many intervals, too many points, no length", async () => {
    await withServer(historyConfig(lake.url(), { aggregates: { maxIntervals: 20 }, maxPoints: 5 }), async (open) => {
      expect((await open((s) => aggregate(s, AggregateFunction.TimeAverage, 0, 3000, 1000))).statusCode.name).toBe("BadAggregateNotSupported");
      expect((await open((s) => aggregate(s, AggregateFunction.Average, 0, 100_000, 1000))).statusCode.name).toBe("BadResponseTooLarge"); // 100 intervals
      expect((await open((s) => aggregate(s, AggregateFunction.Average, 0, 10_000, 5000))).statusCode.name).toBe("BadResponseTooLarge"); // 10 points, at most 5
      expect((await open((s) => aggregate(s, AggregateFunction.Average, 2000, 2000, 1000))).statusCode.isGood()).toBe(false);
      expect(dataValues(await open((s) => aggregate(s, AggregateFunction.Average, 0, 4000, 2000))).map((v) => v.value.value)).toEqual([20.5, 22.5]);
    });
  });

  it("does not give processed history to an anonymous session, and reports a data lake that fails", async () => {
    await withServer(historyConfig(lake.url(), { aggregates: { maxIntervals: 1000 } }), async (open) => {
      const anonymous = await open((s) => aggregate(s, AggregateFunction.Average, 0, 10_000, 5000), false);
      expect(anonymous.statusCode.isGood()).toBe(false);
    });
    await withServer(historyConfig(lake.url(), { token: "wrong-token-wrong", aggregates: { maxIntervals: 1000 } }), async (open) => {
      expect((await open((s) => aggregate(s, AggregateFunction.Average, 0, 10_000, 5000))).statusCode.name).toBe("BadResourceUnavailable");
    });
  });
});

describe("event HistoryRead over the real protocol", () => {
  const lake = fakeDatalake(LAKE_POINTS);
  beforeAll(() => new Promise<void>((resolve) => lake.server.listen(0, "127.0.0.1", resolve)));
  afterAll(() => new Promise<void>((resolve) => lake.server.close(() => resolve())));

  const FIELDS = ["EventId", "SourceName", "Message", "Severity", "Time", "Unknown"];
  const readEvents = async (s: ClientSession, startMs: number | null, endMs: number, options: { numValuesPerNode?: number; continuation?: Buffer; where?: boolean } = {}) => {
    const filter = constructEventFilter(FIELDS.slice(0, 5).concat(["Unknown"]));
    if (options.where) {
      (filter as unknown as { whereClause: { elements: unknown[] } }).whereClause.elements = [{ filterOperator: 1, filterOperands: [] }];
    }
    const request = new HistoryReadRequest({
      historyReadDetails: new ReadEventDetails({ startTime: startMs === null ? new Date(Date.UTC(1601, 0, 1)) : at(startMs), endTime: at(endMs), numValuesPerNode: options.numValuesPerNode ?? 0, filter }),
      timestampsToReturn: TimestampsToReturn.Both,
      releaseContinuationPoints: false,
      nodesToRead: [new HistoryReadValueId({ nodeId: OBJECT, continuationPoint: options.continuation })],
    });
    const response = await (s as unknown as { historyRead: (r: HistoryReadRequest) => Promise<{ results: HistoryReadResult[] }> }).historyRead(request);
    return response.results[0];
  };
  const eventRows = (result: HistoryReadResult): unknown[][] => {
    const events = (result.historyData as unknown as { events?: Array<{ eventFields: Array<{ value: unknown; dataType: DataType }> }> } | null)?.events ?? [];
    return events.map((e) => e.eventFields.map((f) => f.value));
  };
  const config = (extra: Partial<HistoryConfig> = {}) => historyConfig(lake.url(), { events: { HydraNode_1: [HOT_RULE] }, ...extra });

  it("answers the events derived from the rules, oldest first, with the standard fields", async () => {
    await withServer(config(), async (open) => {
      const result = await open((s) => readEvents(s, 0, 10_000));
      expect(result.statusCode.isGood()).toBe(true);
      const rows = eventRows(result);
      expect(rows).toHaveLength(3);
      expect(rows.map((r) => (r[4] as Date).getTime() - BASE)).toEqual([2000, 5000, 8000]);
      expect(rows.map((r) => r[3])).toEqual([700, 700, 700]);
      expect(rows[0][1]).toBe("SpindleHot");
      expect((rows[0][2] as { text: string }).text).toBe("Spindle temperature above 80");
      expect(rows[0][0]).toBeInstanceOf(Buffer);
      expect(new Set(rows.map((r) => (r[0] as Buffer).toString("hex"))).size).toBe(3); // distinct ids
      expect((rows[0][5] as { name?: string } | undefined)?.name ?? String(rows[0][5])).toMatch(/BadNoData|2147/); // a field it does not know
    });
  });

  it("reads a window, newest first when only the end is given, and a single instant", async () => {
    await withServer(config(), async (open) => {
      const window = eventRows(await open((s) => readEvents(s, 3000, 9000)));
      expect(window.map((r) => (r[4] as Date).getTime() - BASE)).toEqual([5000, 8000]);
      const newest = eventRows(await open((s) => readEvents(s, null, 10_000, { numValuesPerNode: 2 })));
      expect(newest.map((r) => (r[4] as Date).getTime() - BASE)).toEqual([8000, 5000]);
      const instant = eventRows(await open((s) => readEvents(s, 5000, 5000)));
      expect(instant.map((r) => (r[4] as Date).getTime() - BASE)).toEqual([5000]);
      const none = await open((s) => readEvents(s, 6000, 8000));
      expect(eventRows(none)).toEqual([]);
      expect(none.statusCode.name).toBe("GoodNoData");
    });
  });

  it("pages a long answer with continuation points", async () => {
    await withServer(config(), async (open) => {
      const first = await open((s) => readEvents(s, 0, 10_000, { numValuesPerNode: 2 }));
      expect(eventRows(first)).toHaveLength(2);
      expect(first.continuationPoint).toBeTruthy();
      const second = await open((s) => readEvents(s, 0, 10_000, { numValuesPerNode: 2, continuation: first.continuationPoint as Buffer }));
      expect(eventRows(second).map((r) => (r[4] as Date).getTime() - BASE)).toEqual([8000]);
      expect(second.continuationPoint).toBeFalsy();
    });
  });

  it("merges the rules of one object by time, and a rule for low values counts a start outside the limit", async () => {
    const cold: EventRule = { name: "SpindleCold", series: SERIES, low: 25, severity: 300, message: "cold" };
    await withServer(config({ events: { HydraNode_1: [HOT_RULE, cold] } }), async (open) => {
      const rows = eventRows(await open((s) => readEvents(s, 0, 10_000)));
      expect(rows.map((r) => [(r[4] as Date).getTime() - BASE, r[1]])).toEqual([
        [0, "SpindleCold"],
        [2000, "SpindleHot"],
        [5000, "SpindleHot"],
        [8000, "SpindleHot"],
        [9000, "SpindleCold"],
      ]);
    });
  });

  it("refuses a filter with a where clause, an anonymous session, and a window with too many points", async () => {
    await withServer(config(), async (open) => {
      expect((await open((s) => readEvents(s, 0, 10_000, { where: true }))).statusCode.name).toBe("BadEventFilterInvalid");
      expect((await open((s) => readEvents(s, 0, 10_000), false)).statusCode.isGood()).toBe(false);
    });
    await withServer(config({ maxPoints: 4 }), async (open) => {
      expect((await open((s) => readEvents(s, 0, 10_000))).statusCode.name).toBe("BadResponseTooLarge");
    });
  });

  it("gives no event history while its switch is off", async () => {
    await withServer(historyConfig(lake.url()), async (open) => {
      const outcome = await open((s) => readEvents(s, 0, 10_000).then((r) => r.statusCode.name, (e: Error) => `error: ${e.message.slice(0, 80)}`));
      expect(outcome).toMatch(/BadHistoryOperationInvalid/); // the service refuses: an object without rules has no history to read
    });
  });

  it("exposes the HistoryRead bit only on the objects that have rules", async () => {
    await withServer(config(), async (open) => {
      await open(async (s) => {
        const withRules = await s.read({ nodeId: OBJECT, attributeId: 12 /* EventNotifier */ });
        expect(Number(withRules.value.value) & 4).toBe(4);
        const without = await s.read({ nodeId: "ns=1;s=Robots", attributeId: 12 });
        expect(Number(without.value.value) & 4).toBe(0);
      });
    });
  });
});
