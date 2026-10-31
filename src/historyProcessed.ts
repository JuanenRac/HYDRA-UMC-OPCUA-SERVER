// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/historyProcessed.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Processed history (HistoryRead with ReadProcessedDetails): the time domain is cut into intervals and one aggregate is computed for each, from
// the raw points of HYDRA-UMC-DATALAKE (or, with HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS=1, from its windows and rollups; see historyWindows.ts). It is OFF unless HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1 (and HYDRA_UMC_OPCUA_HISTORY=1); when it is off a
// processed read answers BadHistoryOperationUnsupported, as before.
//
// Supported aggregates (OPC UA Part 13 names): Average, Minimum, Maximum, Count and Interpolative. Every other aggregate answers
// BadAggregateNotSupported. How each one is computed:
//   - An interval takes the raw points with start <= time < end (read forwards) or start < time <= end (read backwards, the later time begins
//     the interval). The last interval is cut at the end of the domain and then carries the Partial bit.
//   - Average is the arithmetic mean of the raw points of the interval (not time weighted), Minimum and Maximum their smallest and largest, Count
//     their number. Average, Minimum and Maximum of an interval without points are BadNoData; Count of one is 0. They carry HistorianCalculated.
//   - Interpolative gives, at the start of each interval, the raw value if a point sits exactly there, otherwise the straight line between the
//     nearest point before and the nearest point after ("simple bounding values", HistorianInterpolated); with no point on one side it is BadNoData.
//   - The raw points the answer is computed from are never invented: a window with more points than HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS is
//     refused (BadResponseTooLarge) instead of answering an aggregate over part of the data.
// =============================================================================

import { AggregateFunction, DataType, DataValue, HistoryData, HistoryReadResult, StatusCode, StatusCodes, Variant, type ReadProcessedDetails } from "node-opcua";
import { readProcessedFromWindows, rolledUpSpans, type Span } from "./historyWindows.js";
import { fetchHistory, isUnspecified, type HistoryConfig, type HistoryPoint, type SeriesRef } from "./history.js";

export type AggregateKind = "average" | "minimum" | "maximum" | "count" | "interpolative";

/** The aggregates this server computes, by the numeric id of their node in namespace 0. */
export const SUPPORTED_AGGREGATES: ReadonlyMap<number, AggregateKind> = new Map([
  [AggregateFunction.Average, "average"],
  [AggregateFunction.Minimum, "minimum"],
  [AggregateFunction.Maximum, "maximum"],
  [AggregateFunction.Count, "count"],
  [AggregateFunction.Interpolative, "interpolative"],
]);

export const DEFAULT_MAX_INTERVALS = 1000;
export const MAX_INTERVALS_LIMIT = 100_000;

export interface Interval {
  /** Lower end of the interval in milliseconds, and its upper end. */
  low: number;
  high: number;
  /** The time the aggregate is stamped with: the start of the interval in the direction of the read. */
  stamp: number;
  /** The interval was cut by the end of the time domain. */
  partial: boolean;
}

export interface IntervalPlan {
  reverse: boolean;
  intervals: Interval[];
  /** The window of raw points to read: [fromMs, beforeMs). */
  fromMs: number;
  beforeMs: number;
}

/**
 * Cuts the time domain into intervals. `intervalMs` 0 means one interval for the whole domain. Returns a status when the request cannot be served:
 * BadInvalidArgument for a domain without length or a negative interval, BadResponseTooLarge for more than `maxIntervals` intervals.
 */
export function planIntervals(startMs: number, endMs: number, intervalMs: number, maxIntervals: number): IntervalPlan | StatusCode {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs === endMs) return StatusCodes.BadInvalidArgument;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) return StatusCodes.BadInvalidArgument;
  const reverse = endMs < startMs;
  const early = Math.min(startMs, endMs);
  const late = Math.max(startMs, endMs);
  const step = intervalMs === 0 ? late - early : intervalMs;
  if (Math.ceil((late - early) / step) > maxIntervals) return StatusCodes.BadResponseTooLarge;
  const intervals: Interval[] = [];
  if (!reverse) {
    for (let low = early; low < late; low += step) {
      const high = Math.min(low + step, late);
      intervals.push({ low, high, stamp: low, partial: high < low + step });
    }
    return { reverse, intervals, fromMs: early, beforeMs: late };
  }
  for (let high = late; high > early; high -= step) {
    const low = Math.max(high - step, early);
    intervals.push({ low, high, stamp: high, partial: low > high - step });
  }
  // the later end belongs to the first interval of a backwards read, so the window of raw points includes it
  return { reverse, intervals, fromMs: early, beforeMs: late + 1 };
}

function insideInterval(p: HistoryPoint, interval: Interval, reverse: boolean): boolean {
  return reverse ? p.timestamp > interval.low && p.timestamp <= interval.high : p.timestamp >= interval.low && p.timestamp < interval.high;
}

export interface AggregateOutcome {
  /** undefined when there is no value (status says why). */
  value?: number;
  status: StatusCode;
}

const CALCULATED = StatusCode.makeStatusCode(StatusCodes.Good, "HistorianCalculated");
const CALCULATED_PARTIAL = StatusCode.makeStatusCode(StatusCodes.Good, "HistorianCalculated | HistorianPartial");
const INTERPOLATED = StatusCode.makeStatusCode(StatusCodes.Good, "HistorianInterpolated");

/**
 * One aggregate of one interval. `points` are the raw points of the whole window plus the nearest point before and after it, oldest first.
 */
export function computeAggregate(kind: AggregateKind, points: HistoryPoint[], interval: Interval, reverse: boolean): AggregateOutcome {
  if (kind === "interpolative") {
    let before: HistoryPoint | undefined;
    let after: HistoryPoint | undefined;
    for (const p of points) {
      if (p.timestamp <= interval.stamp) before = p;
      if (p.timestamp >= interval.stamp && !after) after = p;
    }
    if (before && before.timestamp === interval.stamp) return { value: before.value, status: StatusCodes.Good };
    if (!before || !after) return { status: StatusCodes.BadNoData };
    const fraction = (interval.stamp - before.timestamp) / (after.timestamp - before.timestamp);
    return { value: before.value + (after.value - before.value) * fraction, status: INTERPOLATED };
  }
  const inside = points.filter((p) => insideInterval(p, interval, reverse));
  const status = interval.partial ? CALCULATED_PARTIAL : CALCULATED;
  if (kind === "count") return { value: inside.length, status };
  if (inside.length === 0) return { status: StatusCodes.BadNoData };
  const values = inside.map((p) => p.value);
  switch (kind) {
    case "average":
      return { value: values.reduce((sum, v) => sum + v, 0) / values.length, status };
    case "minimum":
      return { value: Math.min(...values), status };
    default:
      return { value: Math.max(...values), status };
  }
}

const UNCERTAIN_GAP = StatusCode.makeStatusCode(StatusCodes.UncertainDataSubNormal, "HistorianInterpolated");

/**
 * An interpolated (or "no data") answer is only as good as the points around it. When the stretch between the nearest point before and the nearest
 * point after the stamp holds rollup buckets, raw points existed there and were replaced by a summary: a straight line across it would invent a
 * value, and "no data" would deny data that exists. Such an answer carries no value and is Uncertain. A point exactly on the stamp is always used.
 * `spans` null means the rollups could not be read: nothing can be ruled out, so the answer is Uncertain too.
 */
export function guardInterpolation(points: HistoryPoint[], interval: Interval, outcome: AggregateOutcome, spans: Span[] | null): AggregateOutcome {
  if (points.some((p) => p.timestamp === interval.stamp)) return outcome;
  let low = -Infinity;
  let high = Infinity;
  for (const p of points) {
    if (p.timestamp < interval.stamp && p.timestamp > low) low = p.timestamp;
    if (p.timestamp > interval.stamp && p.timestamp < high) high = p.timestamp;
  }
  const crosses = spans === null || spans.some((span) => span.from < high && span.to > low);
  return crosses ? { status: UNCERTAIN_GAP } : outcome;
}

export function dataValueOf(kind: AggregateKind, interval: Interval, outcome: AggregateOutcome): DataValue {
  const when = new Date(interval.stamp);
  if (outcome.value === undefined) return new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: outcome.status, sourceTimestamp: when, serverTimestamp: when });
  const value = kind === "count" ? new Variant({ dataType: DataType.UInt32, value: outcome.value }) : new Variant({ dataType: DataType.Double, value: outcome.value });
  return new DataValue({ value, statusCode: outcome.status, sourceTimestamp: when, serverTimestamp: when });
}

function failure(statusCode: StatusCode): HistoryReadResult {
  return new HistoryReadResult({ statusCode, historyData: new HistoryData({ dataValues: [] }) });
}

/** Answers a ReadProcessedDetails for one variable: the aggregate of every interval, computed from the points of the data lake. */
export async function readProcessed(config: HistoryConfig, series: SeriesRef, details: ReadProcessedDetails): Promise<HistoryReadResult> {
  const aggregate = details.aggregateType?.[0];
  const kind = aggregate && aggregate.namespace === 0 ? SUPPORTED_AGGREGATES.get(Number(aggregate.value)) : undefined;
  if (!kind) return failure(StatusCodes.BadAggregateNotSupported);
  if (isUnspecified(details.startTime) || isUnspecified(details.endTime)) return failure(StatusCodes.BadInvalidArgument);
  const plan = planIntervals(details.startTime!.getTime(), details.endTime!.getTime(), details.processingInterval ?? 0, config.aggregates?.maxIntervals ?? DEFAULT_MAX_INTERVALS);
  if (!("intervals" in plan)) return failure(plan);

  // With the switch on, the data lake's own windows and rollups answer first; null means it could not, and the raw points are used as before.
  if (config.useDatalakeWindows) {
    const fromWindows = await readProcessedFromWindows(config, series, kind, plan);
    if (fromWindows) return fromWindows;
  }

  let result;
  try {
    result = await fetchHistory(config, series, { startMs: plan.fromMs, beforeMs: plan.beforeMs, descending: false, limit: 0, bounds: kind === "interpolative" });
  } catch (error) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] processed history read failed: ${error instanceof Error ? error.message : String(error)}`);
    return failure(StatusCodes.BadResourceUnavailable);
  }
  if (result.truncated) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] a processed read of ${series.sourceId}/${series.kind}/${series.field} needs more than ${config.maxPoints} points and was refused`);
    return failure(StatusCodes.BadResponseTooLarge);
  }
  const points = [...(result.before ? [result.before] : []), ...result.points, ...(result.after ? [result.after] : [])];
  let spans: Span[] | null = [];
  if (kind === "interpolative" && config.useDatalakeWindows) {
    // with the windows switch on the data lake may have replaced old points by rollups: look for them around the stamps before trusting a line
    const stamps = plan.intervals.map((i) => i.stamp);
    const lowest = Math.min(plan.fromMs, ...stamps, ...(result.before ? [result.before.timestamp] : []));
    const highest = Math.max(plan.beforeMs, ...stamps, ...(result.after ? [result.after.timestamp] : []));
    spans = await rolledUpSpans(config, series, lowest, highest);
  }
  const dataValues = plan.intervals.map((interval) => {
    const outcome = computeAggregate(kind, points, interval, plan.reverse);
    return dataValueOf(kind, interval, kind === "interpolative" && config.useDatalakeWindows ? guardInterpolation(points, interval, outcome, spans) : outcome);
  });
  return new HistoryReadResult({ statusCode: StatusCodes.Good, historyData: new HistoryData({ dataValues }) });
}
