// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/historyWindows.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Processed history from the aggregates of HYDRA-UMC-DATALAKE instead of from its raw points. It is OFF unless
// HYDRA_UMC_OPCUA_HISTORY_USE_DATALAKE_WINDOWS=1 (and HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1); when it is off, or whenever it cannot answer, the
// processed read is computed from the raw points exactly as before (historyProcessed.ts).
//
//   - GET /windows gives count, min, max and sum per interval of the raw points that are still stored (one request, however many points).
//   - GET /rollups gives the same four numbers for the data that downsampling already replaced by rollups, so an old domain is not empty.
//     A rollup is used only when the whole bucket lies inside one interval; a bucket that straddles the edge of an interval cannot be split,
//     so the interval is answered from what can be used and marked Uncertain (UncertainDataSubNormal) instead of looking complete.
//
// Served this way: Average, Minimum, Maximum and Count, forwards ([low, high) intervals) and backwards ((low, high] intervals, asked with order=desc
// so the windows of the data lake line up with them). NOT served (they use the raw points): Interpolative, which needs the bounding values; it
// is only checked against the rollups (see rolledUpSpans) so a straight line is never drawn across data that downsampling already replaced.
//
// A rollup bucket covers [bucketStart, bucketStart + bucketMs - 1]. It joins an interval only when all of it lies inside ([low, high) forwards,
// (low, high] backwards). The raw points of a bucket that was rolled up are gone, so a bucket that straddles an edge cannot be split again: the
// intervals it touches are marked Uncertain. The intervals are exact when their edges fall on the edges of the buckets (backwards: one millisecond
// before them, because the early edge is open).
//
// The answer falls back to the raw calculation (null here) when: /windows answers anything but 200 or something unreadable, /rollups answers
// an error other than 404 (404 means downsampling is off there, so there are no rollups), the rollups are not exact (more than one bucket
// width in the domain, which would count a point twice, or a page full to the limit) or a window does not line up with an interval.
// =============================================================================

import { HistoryData, HistoryReadResult, StatusCode, StatusCodes } from "node-opcua";
import { fetchWithToken, type HistoryConfig, type SeriesRef } from "./history.js";
import { type AggregateKind, type Interval, type IntervalPlan, type AggregateOutcome, dataValueOf } from "./historyProcessed.js";
import { readJsonCapped } from "./robotSource.js";

export const ROLLUP_LIMIT = 200_000;
/** Default of how far before a time the rollups are looked at (HYDRA_UMC_OPCUA_HISTORY_ROLLUP_LOOKBACK_MS). */
export const DEFAULT_ROLLUP_LOOKBACK_MS = 7 * 24 * 3_600_000;

const CALCULATED = StatusCode.makeStatusCode(StatusCodes.Good, "HistorianCalculated");
const CALCULATED_PARTIAL = StatusCode.makeStatusCode(StatusCodes.Good, "HistorianCalculated | HistorianPartial");
const INCOMPLETE = StatusCode.makeStatusCode(StatusCodes.UncertainDataSubNormal, "HistorianCalculated | HistorianPartial");

interface Totals {
  count: number;
  min: number;
  max: number;
  sum: number;
  /** A rollup bucket reaches into this interval without lying inside it. */
  incomplete: boolean;
}

interface WindowRow {
  bucketStart: number;
  count: number;
  min: number;
  max: number;
  sum: number;
}

interface RollupRow extends WindowRow {
  bucketMs: number;
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function parseRows<T extends WindowRow>(rows: unknown, extra?: (r: Record<string, unknown>) => boolean): T[] | null {
  if (!Array.isArray(rows)) return null;
  const out: T[] = [];
  for (const raw of rows) {
    const r = raw as Record<string, unknown>;
    if (!r || !finite(r.bucketStart) || !finite(r.count) || !finite(r.min) || !finite(r.max) || !finite(r.sum)) return null;
    if (extra && !extra(r)) return null;
    out.push(r as unknown as T);
  }
  return out;
}

async function getJson(config: HistoryConfig, path: string, params: Record<string, string>): Promise<{ status: number; body?: unknown }> {
  const response = await fetchWithToken(config, path, params);
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return { status: response.status };
  }
  return { status: response.status, body: await readJsonCapped(response) };
}

/** Which interval of the plan holds the instant `t`, or -1 when none does (forwards [low, high), backwards (low, high]). */
function intervalIndexAt(plan: IntervalPlan, early: number, late: number, step: number, t: number): number {
  if (plan.reverse) {
    if (t <= early || t > late) return -1;
    return Math.min(Math.floor((late - t) / step), plan.intervals.length - 1);
  }
  if (t < early || t >= late) return -1;
  return Math.min(Math.floor((t - early) / step), plan.intervals.length - 1);
}

/** The totals of every interval from the windows and rollups of the data lake, or null when the raw calculation must be used. */
export async function intervalTotals(config: HistoryConfig, series: SeriesRef, plan: IntervalPlan): Promise<Totals[] | null> {
  const early = Math.min(...plan.intervals.map((i) => i.low));
  const late = Math.max(...plan.intervals.map((i) => i.high));
  const step = plan.intervals.length === 1 ? late - early : plan.intervals[0].high - plan.intervals[0].low;
  const ident = { sourceId: series.sourceId, kind: series.kind, field: series.field };

  const win = await getJson(config, "/windows", {
    ...ident,
    bucketMs: String(step),
    start: String(early),
    ...(plan.reverse ? { end: String(late), order: "desc" } : { before: String(late) }),
    stats: "count,min,max,sum",
  });
  if (win.status !== 200) return null;
  const windowBody = win.body as { buckets?: unknown; order?: unknown } | undefined;
  // a data lake that does not know order=desc answers with windows aligned to the start: those would not line up, so they are not used
  if (plan.reverse && windowBody?.order !== "desc") return null;
  const windows = parseRows<WindowRow>(windowBody?.buckets, plan.reverse ? (r) => finite(r.bucketEnd) && r.bucketStart === (r.bucketEnd as number) - step : undefined);
  if (!windows) return null;

  const rollupResponse = await getJson(config, "/rollups", { ...ident, [plan.reverse ? "end" : "before"]: String(late), limit: String(ROLLUP_LIMIT) });
  let rollups: RollupRow[] = [];
  if (rollupResponse.status !== 404) {
    if (rollupResponse.status !== 200) return null;
    const parsed = parseRows<RollupRow>(rollupResponse.body, (r) => finite(r.bucketMs) && r.bucketMs > 0);
    if (!parsed || parsed.length >= ROLLUP_LIMIT) return null;
    // the buckets that reach into the domain: [bucketStart, bucketStart + bucketMs - 1] meets [early, late) forwards, (early, late] backwards
    rollups = parsed.filter((r) => r.bucketStart + r.bucketMs > (plan.reverse ? early + 1 : early));
    if (new Set(rollups.map((r) => r.bucketMs)).size > 1) return null;
  }

  const totals: Totals[] = plan.intervals.map(() => ({ count: 0, min: Infinity, max: -Infinity, sum: 0, incomplete: false }));
  const add = (t: Totals, row: WindowRow): void => {
    t.count += row.count;
    t.min = Math.min(t.min, row.min);
    t.max = Math.max(t.max, row.max);
    t.sum += row.sum;
  };
  for (const w of windows) {
    // forwards the row says where the window starts; backwards where it ends (the intervals of the plan run from the late end)
    const index = plan.reverse ? ((late - (w as unknown as { bucketEnd: number }).bucketEnd) / step) : (w.bucketStart - early) / step;
    if (!Number.isInteger(index) || index < 0 || index >= totals.length) return null;
    add(totals[index], w);
  }
  for (const r of rollups) {
    const first = r.bucketStart;
    const last = r.bucketStart + r.bucketMs - 1;
    const from = intervalIndexAt(plan, early, late, step, plan.reverse ? Math.max(first, early + 1) : Math.max(first, early));
    const to = intervalIndexAt(plan, early, late, step, Math.min(last, plan.reverse ? late : late - 1));
    if (from < 0 || to < 0) continue; // nothing of the bucket lies in the domain
    // forwards the later instant is in the later interval; backwards the later instant is in the lower index
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const own = plan.intervals[lo];
    const whole = plan.reverse ? first > own.low && last <= own.high : first >= own.low && last < own.high;
    if (lo === hi && whole) {
      add(totals[lo], r);
    } else {
      for (let i = lo; i <= hi; i += 1) totals[i].incomplete = true;
    }
  }
  return totals;
}

/** A stretch of time (milliseconds, both ends included) that downsampling already replaced by a rollup bucket. */
export interface Span {
  from: number;
  to: number;
}

/**
 * The stretches in [fromMs, toMs] that only exist as rollups now (their raw points are gone), or null when that cannot be told (the rollups
 * could not be read, the list is as long as the limit, or a bucket is wider than `rollupLookbackMs`, so older buckets might reach in unseen).
 * A data lake without rollups (404) has none.
 */
export async function rolledUpSpans(config: HistoryConfig, series: SeriesRef, fromMs: number, toMs: number): Promise<Span[] | null> {
  const lookback = config.rollupLookbackMs ?? DEFAULT_ROLLUP_LOOKBACK_MS;
  let response;
  try {
    response = await getJson(config, "/rollups", {
      sourceId: series.sourceId,
      kind: series.kind,
      field: series.field,
      start: String(Math.floor(fromMs - lookback)),
      end: String(Math.ceil(toMs)),
      limit: String(ROLLUP_LIMIT),
    });
  } catch (error) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] rollups of the data lake unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (response.status === 404) return [];
  if (response.status !== 200) return null;
  const rows = parseRows<RollupRow>(response.body, (r) => finite(r.bucketMs) && r.bucketMs > 0);
  if (!rows || rows.length >= ROLLUP_LIMIT || rows.some((r) => r.bucketMs > lookback)) return null;
  return rows.map((r) => ({ from: r.bucketStart, to: r.bucketStart + r.bucketMs - 1 })).filter((span) => span.to >= fromMs);
}

export function outcomeOf(kind: AggregateKind, t: Totals, interval: Interval): AggregateOutcome {
  const status = t.incomplete ? INCOMPLETE : interval.partial ? CALCULATED_PARTIAL : CALCULATED;
  if (kind === "count") return { value: t.count, status };
  if (t.count === 0) return { status: t.incomplete ? INCOMPLETE : StatusCodes.BadNoData };
  switch (kind) {
    case "average":
      return { value: t.sum / t.count, status };
    case "minimum":
      return { value: t.min, status };
    default:
      return { value: t.max, status };
  }
}

/** Answers a processed read from the windows and rollups of the data lake; null means "use the raw points". */
export async function readProcessedFromWindows(config: HistoryConfig, series: SeriesRef, kind: AggregateKind, plan: IntervalPlan): Promise<HistoryReadResult | null> {
  if (kind === "interpolative" || plan.intervals.length === 0) return null;
  let totals: Totals[] | null;
  try {
    totals = await intervalTotals(config, series, plan);
  } catch (error) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] windows of the data lake unavailable, using the raw points: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!totals) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] the data lake could not answer from its windows and rollups for ${series.sourceId}/${series.kind}/${series.field}; using the raw points`);
    return null;
  }
  const dataValues = plan.intervals.map((interval, i) => dataValueOf(kind, interval, outcomeOf(kind, totals![i], interval)));
  return new HistoryReadResult({ statusCode: StatusCodes.Good, historyData: new HistoryData({ dataValues }) });
}
