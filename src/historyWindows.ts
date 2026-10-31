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
// Served this way: Average, Minimum, Maximum and Count of a forward read. NOT served (they use the raw points): Interpolative, which needs the
// bounding values, and a backwards read, whose intervals are open at the early end and would not line up with the windows of the data lake.
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

/** The totals of every interval from the windows and rollups of the data lake, or null when the raw calculation must be used. */
export async function intervalTotals(config: HistoryConfig, series: SeriesRef, plan: IntervalPlan): Promise<Totals[] | null> {
  const first = plan.intervals[0];
  const last = plan.intervals[plan.intervals.length - 1];
  const early = first.low;
  const late = last.high;
  const step = plan.intervals.length === 1 ? late - early : first.high - first.low;
  const ident = { sourceId: series.sourceId, kind: series.kind, field: series.field };

  const win = await getJson(config, "/windows", {
    ...ident,
    bucketMs: String(step),
    start: String(early),
    before: String(late),
    stats: "count,min,max,sum",
  });
  if (win.status !== 200) return null;
  const windows = parseRows<WindowRow>((win.body as { buckets?: unknown } | undefined)?.buckets);
  if (!windows) return null;

  const rollupResponse = await getJson(config, "/rollups", { ...ident, before: String(late), limit: String(ROLLUP_LIMIT) });
  let rollups: RollupRow[] = [];
  if (rollupResponse.status !== 404) {
    if (rollupResponse.status !== 200) return null;
    const parsed = parseRows<RollupRow>(rollupResponse.body, (r) => finite(r.bucketMs) && r.bucketMs > 0);
    if (!parsed || parsed.length >= ROLLUP_LIMIT) return null;
    rollups = parsed.filter((r) => r.bucketStart + r.bucketMs > early);
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
    const index = (w.bucketStart - early) / step;
    if (!Number.isInteger(index) || index < 0 || index >= totals.length) return null;
    add(totals[index], w);
  }
  for (const r of rollups) {
    const from = Math.max(0, Math.floor((r.bucketStart - early) / step));
    const to = Math.min(totals.length - 1, Math.floor((r.bucketStart + r.bucketMs - 1 - early) / step));
    if (from === to && r.bucketStart >= plan.intervals[from].low && r.bucketStart + r.bucketMs <= plan.intervals[from].high) {
      add(totals[from], r);
    } else {
      for (let i = from; i <= to; i += 1) totals[i].incomplete = true;
    }
  }
  return totals;
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
  if (kind === "interpolative" || plan.reverse || plan.intervals.length === 0) return null;
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
