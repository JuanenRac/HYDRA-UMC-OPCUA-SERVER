// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/history.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Historical Access: a SCADA client asks for the past of a variable (HistoryRead, raw values) and the server answers from HYDRA-UMC-DATALAKE
// (GET /history), so there is no second database. It is OFF unless HYDRA_UMC_OPCUA_HISTORY=1: the switch, the address of the data lake and a map
// from variables to series are all configuration, and a variable that is not in the map has no history at all.
//
//   HYDRA_UMC_OPCUA_HISTORY=1            the switch (default off)
//   HYDRA_UMC_OPCUA_HISTORY_URL          address of HYDRA-UMC-DATALAKE
//   HYDRA_UMC_OPCUA_HISTORY_TOKEN        its read token, when it has one
//   HYDRA_UMC_OPCUA_HISTORY_MAP          path of a JSON file {"HydraNode_1.SpindleTemp": {"sourceId": "...", "kind": "...", "field": "..."}}
//   HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS   most points one read may take from the data lake (default 10000, at most 200000)
//   HYDRA_UMC_OPCUA_HISTORY_TIMEOUT_MS   timeout of each request to the data lake (default 10000)
//   HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS=1  lets anonymous sessions read history too (default: only sessions that logged in or use a certificate)
//   HYDRA_UMC_OPCUA_HISTORY_AGGREGATES=1 also answers processed reads (Average, Minimum, Maximum, Count, Interpolative); see historyProcessed.ts (default off)
//   HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS  most intervals one processed read may ask for (default 1000, at most 100000)
//   HYDRA_UMC_OPCUA_HISTORY_EVENTS=1     also answers event history, derived from limit rules in a JSON file; see historyEvents.ts (default off)
//   HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP   path of that file (required with the switch above)
//
// The time window of a read is [start, end): the start is included, the end is not (a read with start == end returns that one instant).
// A window with more points than the maximum is cut at the maximum and says so on the console.
// =============================================================================

import { readFileSync } from "node:fs";
import { DataType, DataValue, HistoryReadResult, ReadProcessedDetails, StatusCodes, Variant } from "node-opcua";
import { apiUrl, readJsonCapped } from "./robotSource.js";
import { DEFAULT_MAX_INTERVALS, MAX_INTERVALS_LIMIT, readProcessed } from "./historyProcessed.js";
import { parseEventsMap, type EventRule } from "./historyEvents.js";

/** Which series of the data lake a variable shows. */
export interface SeriesRef {
  sourceId: string;
  kind: string;
  field: string;
}

export interface HistoryConfig {
  url: string;
  token?: string;
  /** Variable (the node id without `s=`, like `HydraNode_1.SpindleTemp`) -> series. */
  mapping: Record<string, SeriesRef>;
  maxPoints: number;
  timeoutMs: number;
  allowAnonymous: boolean;
  /** Present when processed reads are switched on. */
  aggregates?: { maxIntervals: number };
  /** Present when event history is switched on: the rules by object (the NodeId without `s=`). */
  events?: Record<string, EventRule[]>;
  fetchImpl?: typeof fetch;
}

export const HISTORY_MAX_POINTS_LIMIT = 200_000;
const PAGE_SIZE = 1000;

/** Reads and checks the map file: every entry needs a non-empty sourceId, kind and field. */
export function parseHistoryMap(text: string): Record<string, SeriesRef> {
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the history map must be a JSON object");
  const mapping: Record<string, SeriesRef> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<SeriesRef> | null;
    for (const part of ["sourceId", "kind", "field"] as const) {
      if (typeof entry?.[part] !== "string" || entry[part] === "") throw new Error(`history map entry ${key}: ${part} must be a non-empty string`);
    }
    mapping[key] = { sourceId: entry!.sourceId!, kind: entry!.kind!, field: entry!.field! };
  }
  return mapping;
}

/** null while the switch is off; throws when it is on and the rest of the configuration is missing or wrong. */
export function historyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HistoryConfig | null {
  if ((env.HYDRA_UMC_OPCUA_HISTORY ?? "").trim() !== "1") return null;
  const url = env.HYDRA_UMC_OPCUA_HISTORY_URL?.trim();
  if (!url) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_HISTORY=1 needs HYDRA_UMC_OPCUA_HISTORY_URL");
  const mapFile = env.HYDRA_UMC_OPCUA_HISTORY_MAP?.trim();
  if (!mapFile) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_HISTORY=1 needs HYDRA_UMC_OPCUA_HISTORY_MAP (a JSON file)");
  const intIn = (name: string, fallback: number, min: number, max: number): number => {
    const text = env[name]?.trim();
    if (!text) return fallback;
    const value = Number(text);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`HYDRA-UMC-OPCUA-SERVER: ${name} must be an integer from ${min} to ${max}, got ${text}`);
    return value;
  };
  const on = (name: string): boolean => (env[name] ?? "").trim() === "1";
  let events: Record<string, EventRule[]> | undefined;
  if (on("HYDRA_UMC_OPCUA_HISTORY_EVENTS")) {
    const eventsFile = env.HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP?.trim();
    if (!eventsFile) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_HISTORY_EVENTS=1 needs HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP (a JSON file)");
    events = parseEventsMap(readFileSync(eventsFile, "utf-8"));
  }
  return {
    url,
    token: env.HYDRA_UMC_OPCUA_HISTORY_TOKEN?.trim() || undefined,
    mapping: parseHistoryMap(readFileSync(mapFile, "utf-8")),
    maxPoints: intIn("HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS", 10_000, 1, HISTORY_MAX_POINTS_LIMIT),
    timeoutMs: intIn("HYDRA_UMC_OPCUA_HISTORY_TIMEOUT_MS", 10_000, 100, 120_000),
    allowAnonymous: on("HYDRA_UMC_OPCUA_HISTORY_ANONYMOUS"),
    aggregates: on("HYDRA_UMC_OPCUA_HISTORY_AGGREGATES") ? { maxIntervals: intIn("HYDRA_UMC_OPCUA_HISTORY_MAX_INTERVALS", DEFAULT_MAX_INTERVALS, 1, MAX_INTERVALS_LIMIT) } : undefined,
    events,
  };
}

export interface HistoryPoint {
  timestamp: number;
  value: number;
}

export interface HistoryQuery {
  /** Inclusive, unix milliseconds. */
  startMs?: number;
  /** Exclusive, unix milliseconds. */
  beforeMs?: number;
  descending: boolean;
  /** Most points wanted; 0 means as many as the configuration allows. */
  limit: number;
  bounds: boolean;
}

export interface HistoryResult {
  points: HistoryPoint[];
  /** Newest point before the window (only when bounds were asked for; null where there is none). */
  before?: HistoryPoint | null;
  /** Oldest point at or after the end of the window. */
  after?: HistoryPoint | null;
  truncated: boolean;
}

/** Reads one series from the data lake, page after page, up to the configured maximum. */
export async function fetchHistory(config: HistoryConfig, series: SeriesRef, query: HistoryQuery): Promise<HistoryResult> {
  const doFetch = config.fetchImpl ?? fetch;
  const wanted = Math.min(query.limit > 0 ? query.limit : config.maxPoints, config.maxPoints);
  const points: HistoryPoint[] = [];
  let cursor: string | undefined;
  let before: HistoryPoint | null | undefined;
  let after: HistoryPoint | null | undefined;
  let more = false;
  while (points.length < wanted) {
    const url = apiUrl(config.url, "/history");
    url.searchParams.set("sourceId", series.sourceId);
    url.searchParams.set("kind", series.kind);
    url.searchParams.set("field", series.field);
    if (query.startMs !== undefined) url.searchParams.set("start", String(query.startMs));
    if (query.beforeMs !== undefined) url.searchParams.set("before", String(query.beforeMs));
    url.searchParams.set("order", query.descending ? "desc" : "asc");
    url.searchParams.set("limit", String(Math.min(PAGE_SIZE, wanted - points.length)));
    if (query.bounds && cursor === undefined) url.searchParams.set("bounds", "1");
    if (cursor !== undefined) url.searchParams.set("cursor", cursor);
    const response = await doFetch(url, {
      headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new Error(`the data lake answered HTTP ${response.status}`);
    }
    const body = (await readJsonCapped(response)) as {
      points?: Array<{ timestamp?: unknown; value?: unknown }>;
      nextCursor?: unknown;
      bounds?: { before?: HistoryPoint | null; after?: HistoryPoint | null };
    };
    for (const p of body.points ?? []) {
      if (typeof p.timestamp === "number" && typeof p.value === "number") points.push({ timestamp: p.timestamp, value: p.value });
    }
    if (body.bounds) {
      before = body.bounds.before ?? null;
      after = body.bounds.after ?? null;
    }
    if (typeof body.nextCursor !== "string") {
      more = false;
      break;
    }
    cursor = body.nextCursor;
    more = true;
  }
  return { points, before, after, truncated: more && points.length >= wanted && query.limit === 0 };
}

/** The value a stored number has in the data type of a variable. */
export function convertValue(value: number, dataType: DataType): Variant {
  switch (dataType) {
    case DataType.Boolean:
      return new Variant({ dataType, value: value !== 0 });
    case DataType.UInt32:
      return new Variant({ dataType, value: Math.max(0, Math.round(value)) });
    case DataType.Double:
    default:
      return new Variant({ dataType: DataType.Double, value });
  }
}

const MIN_DATE_MS = Date.UTC(1700, 0, 1);
/** The OPC UA "not specified" time is the year 1601. */
export function isUnspecified(date: Date | null | undefined): boolean {
  return !date || date.getTime() < MIN_DATE_MS;
}

/** What a raw HistoryRead asks for, in the terms of the data lake. */
export function queryFromDetails(
  details: { startTime?: Date | null; endTime?: Date | null; numValuesPerNode: number; returnBounds: boolean },
  maxNumberToExtract: number,
  isReversed: boolean,
): HistoryQuery | null {
  const hasStart = !isUnspecified(details.startTime);
  const hasEnd = !isUnspecified(details.endTime);
  if (!hasStart && !hasEnd) return null;
  const start = hasStart ? details.startTime!.getTime() : undefined;
  const end = hasEnd ? details.endTime!.getTime() : undefined;
  // a read with the same instant twice asks for that instant only
  const beforeMs = end !== undefined && start !== undefined && end === start ? end + 1 : end;
  return {
    startMs: start,
    beforeMs,
    descending: isReversed,
    limit: maxNumberToExtract,
    bounds: details.returnBounds,
  };
}

function dataValueOf(point: HistoryPoint, dataType: DataType): DataValue {
  const when = new Date(point.timestamp);
  return new DataValue({ value: convertValue(point.value, dataType), statusCode: StatusCodes.Good, sourceTimestamp: when, serverTimestamp: when });
}

function boundValue(point: HistoryPoint | null | undefined, at: Date | null | undefined, dataType: DataType): DataValue {
  if (point) return dataValueOf(point, dataType);
  return new DataValue({ value: new Variant({ dataType: DataType.Null }), statusCode: StatusCodes.BadBoundNotFound, sourceTimestamp: at ?? undefined });
}

/**
 * Installs the history of one variable: node-opcua's own HistoryRead handling (continuation points, order, windows) with the values taken
 * from the data lake instead of an in-memory timeline.
 */
export function installHistory(variable: any, config: HistoryConfig, series: SeriesRef, dataType: DataType): void {
  variable.addressSpace.installHistoricalDataNode(variable, { maxOnlineValues: 1 });
  // The library answers "access denied" to a session without the permission and then goes on reading anyway; stop after the refusal.
  const libraryRead = variable._historyRead;
  variable._historyRead = function (this: any, context: unknown, details: unknown, indexRange: unknown, encoding: unknown, continuation: unknown, callback: (e: Error | null, r?: unknown) => void): void {
    if (!this.canUserReadHistory(context)) {
      callback(null, new HistoryReadResult({ statusCode: StatusCodes.BadUserAccessDenied }));
      return;
    }
    if (config.aggregates && details instanceof ReadProcessedDetails) {
      readProcessed(config, series, details).then(
        (result) => callback(null, result),
        (error: unknown) => callback(error instanceof Error ? error : new Error(String(error))),
      );
      return;
    }
    libraryRead.call(this, context, details, indexRange, encoding, continuation, callback);
  };
  variable._historyReadRawAsync = (
    details: { startTime?: Date | null; endTime?: Date | null; numValuesPerNode: number; returnBounds: boolean },
    maxNumberToExtract: number,
    isReversed: boolean,
    reverseDataValue: boolean,
    callback: (err: Error | null, values?: DataValue[]) => void,
  ): void => {
    const query = queryFromDetails(details, maxNumberToExtract, isReversed);
    if (!query) return callback(null, []);
    fetchHistory(config, series, query).then(
      (result) => {
        if (result.truncated) {
          console.warn(`[HYDRA-UMC-OPCUA-SERVER] a history read of ${series.sourceId}/${series.kind}/${series.field} was cut at ${config.maxPoints} points`);
        }
        let values = result.points.map((p) => dataValueOf(p, dataType));
        if (reverseDataValue) values = values.reverse();
        if (details.returnBounds) {
          const startBound = boundValue(result.before, details.startTime, dataType);
          const endBound = boundValue(result.after, details.endTime, dataType);
          values = reverseDataValue || isReversed ? [endBound, ...values, startBound] : [startBound, ...values, endBound];
        }
        callback(null, values);
      },
      (error: unknown) => {
        console.warn(`[HYDRA-UMC-OPCUA-SERVER] history read failed: ${error instanceof Error ? error.message : String(error)}`);
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
  };
}
