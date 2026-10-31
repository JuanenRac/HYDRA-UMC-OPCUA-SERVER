// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/historyEvents.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Event history (HistoryRead with ReadEventDetails). HYDRA-UMC-DATALAKE stores numbers, not events, so the events are DERIVED from the stored
// series by rules that the operator writes in a JSON file; nothing is invented and nothing is stored. It is OFF unless
// HYDRA_UMC_OPCUA_HISTORY_EVENTS=1 (and HYDRA_UMC_OPCUA_HISTORY=1), and then needs HYDRA_UMC_OPCUA_HISTORY_EVENTS_MAP:
//
//   {"HydraNode_1": [{"name": "SpindleHot", "series": {"sourceId": "arm-1", "kind": "spindle", "field": "temp"},
//                     "high": 80, "severity": 700, "message": "Spindle temperature above 80"}]}
//
// The key is the object (the NodeId without `s=`: HydraNode_1 or Robot_<id>). A rule has a name, a series, `high` and/or `low` (the event happens
// when the value rises above `high` or falls below `low`), and optionally a severity (1 to 1000, default 500) and a message. An event is one
// transition from "within limits" to "outside the limits": the first point of the stored history counts as a transition when it is already outside.
// The event carries the standard fields of BaseEventType: EventId, EventType, SourceNode, SourceName, Time, ReceiveTime, Message and Severity.
//
// Limits: the where clause of the event filter is not evaluated (a filter with one is refused with BadEventFilterInvalid), a field that is not
// one of those above is returned as BadNoData, and a window with more points than HYDRA_UMC_OPCUA_HISTORY_MAX_POINTS in one rule is refused
// (BadResponseTooLarge) instead of answering with events missing. A continuation point is a position in the list of events of the read: if the
// history changes between two calls the pages can shift.
// =============================================================================

import { createHash } from "node:crypto";
import { DataType, HistoryReadResult, LocalizedText, NodeId, PermissionType, ReadEventDetails, StatusCode, StatusCodes, Variant } from "node-opcua";
// not exported by node-opcua itself (its name clashes with a data type of the standard model), hence the dependency of its own
import { HistoryEvent, HistoryEventFieldList } from "node-opcua-types";
import { fetchHistory, isUnspecified, type HistoryConfig, type HistoryPoint, type SeriesRef } from "./history.js";

export interface EventRule {
  name: string;
  series: SeriesRef;
  high?: number;
  low?: number;
  severity: number;
  message: string;
}

export interface HistoricalEvent {
  /** Rule that produced it, the object it belongs to, the instant and the value that crossed the limit. */
  rule: EventRule;
  objectKey: string;
  timestamp: number;
  value: number;
}

export const DEFAULT_EVENT_SEVERITY = 500;

/** Reads and checks the events file: {objectKey: [rule, ...]}. */
export function parseEventsMap(text: string): Record<string, EventRule[]> {
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("the events map must be a JSON object");
  const out: Record<string, EventRule[]> = {};
  for (const [objectKey, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) throw new Error(`events map entry ${objectKey}: must be a list of rules`);
    out[objectKey] = list.map((item, index) => {
      const where = `events map entry ${objectKey}[${index}]`;
      const rule = (item ?? {}) as Record<string, unknown>;
      if (typeof rule.name !== "string" || rule.name === "") throw new Error(`${where}: name must be a non-empty string`);
      const series = (rule.series ?? {}) as Record<string, unknown>;
      for (const part of ["sourceId", "kind", "field"]) {
        if (typeof series[part] !== "string" || series[part] === "") throw new Error(`${where}: series.${part} must be a non-empty string`);
      }
      for (const limit of ["high", "low"]) {
        if (rule[limit] !== undefined && (typeof rule[limit] !== "number" || !Number.isFinite(rule[limit]))) throw new Error(`${where}: ${limit} must be a number`);
      }
      if (rule.high === undefined && rule.low === undefined) throw new Error(`${where}: needs high, low or both`);
      if (typeof rule.high === "number" && typeof rule.low === "number" && rule.low >= rule.high) throw new Error(`${where}: low must be below high`);
      const severity = rule.severity === undefined ? DEFAULT_EVENT_SEVERITY : rule.severity;
      if (typeof severity !== "number" || !Number.isInteger(severity) || severity < 1 || severity > 1000) throw new Error(`${where}: severity must be an integer from 1 to 1000`);
      if (rule.message !== undefined && typeof rule.message !== "string") throw new Error(`${where}: message must be a string`);
      return {
        name: rule.name,
        series: { sourceId: series.sourceId as string, kind: series.kind as string, field: series.field as string },
        high: rule.high as number | undefined,
        low: rule.low as number | undefined,
        severity,
        message: (rule.message as string | undefined) ?? rule.name,
      };
    });
  }
  return out;
}

function outside(rule: EventRule, value: number): boolean {
  return (rule.high !== undefined && value > rule.high) || (rule.low !== undefined && value < rule.low);
}

/**
 * The transitions to "outside the limits" among `points` (oldest first). `previous` is the point just before the first one, when there is one:
 * with none, the history is taken to start within limits.
 */
export function deriveEvents(rule: EventRule, objectKey: string, points: HistoryPoint[], previous: HistoryPoint | null | undefined): HistoricalEvent[] {
  const events: HistoricalEvent[] = [];
  let wasOutside = previous ? outside(rule, previous.value) : false;
  for (const p of points) {
    const now = outside(rule, p.value);
    if (now && !wasOutside) events.push({ rule, objectKey, timestamp: p.timestamp, value: p.value });
    wasOutside = now;
  }
  return events;
}

/** A stable 8-byte identifier, so the same event has the same id in every read. */
export function eventIdOf(event: HistoricalEvent): Buffer {
  return createHash("sha256").update(`${event.objectKey}|${event.rule.name}|${event.timestamp}`).digest().subarray(0, 8);
}

const BASE_EVENT_TYPE = new NodeId(NodeId.NodeIdType.NUMERIC, 2041, 0);

/** The value of one field of an event, by the browse name of its select clause. */
export function eventField(event: HistoricalEvent, objectNodeId: NodeId, browsePath: string[]): Variant {
  if (browsePath.length === 1) {
    const when = new Date(event.timestamp);
    switch (browsePath[0]) {
      case "EventId":
        return new Variant({ dataType: DataType.ByteString, value: eventIdOf(event) });
      case "EventType":
        return new Variant({ dataType: DataType.NodeId, value: BASE_EVENT_TYPE });
      case "SourceNode":
        return new Variant({ dataType: DataType.NodeId, value: objectNodeId });
      case "SourceName":
        return new Variant({ dataType: DataType.String, value: event.rule.name });
      case "Time":
      case "ReceiveTime":
        return new Variant({ dataType: DataType.DateTime, value: when });
      case "Message":
        return new Variant({ dataType: DataType.LocalizedText, value: new LocalizedText({ locale: "en", text: event.rule.message }) });
      case "Severity":
        return new Variant({ dataType: DataType.UInt16, value: event.rule.severity });
    }
  }
  return new Variant({ dataType: DataType.StatusCode, value: StatusCodes.BadNoData });
}

function failure(statusCode: StatusCode): HistoryReadResult {
  return new HistoryReadResult({ statusCode, historyData: new HistoryEvent({ events: [] }) });
}

function decodeContinuation(buffer: Buffer | null | undefined): number | null {
  if (!buffer || buffer.length === 0) return 0;
  try {
    const parsed = JSON.parse(buffer.toString("utf-8")) as { o?: unknown };
    return typeof parsed.o === "number" && Number.isInteger(parsed.o) && parsed.o >= 0 ? parsed.o : null;
  } catch {
    return null;
  }
}

/** Answers a ReadEventDetails for one object: the events derived from the series of its rules inside the window. */
export async function readEvents(
  config: HistoryConfig,
  objectKey: string,
  objectNodeId: NodeId,
  rules: EventRule[],
  details: ReadEventDetails,
  continuationPoint: Buffer | null | undefined,
): Promise<HistoryReadResult> {
  const offset = decodeContinuation(continuationPoint);
  if (offset === null) return failure(StatusCodes.BadContinuationPointInvalid);
  const filter = details.filter;
  if (!filter || (filter.whereClause?.elements?.length ?? 0) > 0) return failure(StatusCodes.BadEventFilterInvalid);
  const hasStart = !isUnspecified(details.startTime);
  const hasEnd = !isUnspecified(details.endTime);
  if (!hasStart && !hasEnd) return failure(StatusCodes.BadInvalidArgument);
  const start = hasStart ? details.startTime!.getTime() : undefined;
  const end = hasEnd ? details.endTime!.getTime() : undefined;
  const reverse = (hasStart && hasEnd && end! < start!) || (!hasStart && hasEnd);
  const low = hasStart && hasEnd ? Math.min(start!, end!) : start;
  const high = hasStart && hasEnd ? Math.max(start!, end!) : end;
  // a read with the same instant twice asks for that instant only
  const beforeMs = high === undefined ? undefined : hasStart && hasEnd && start === end ? high + 1 : high;

  const events: HistoricalEvent[] = [];
  try {
    for (const rule of rules) {
      const result = await fetchHistory(config, rule.series, { startMs: low, beforeMs, descending: false, limit: 0, bounds: true });
      if (result.truncated) {
        console.warn(`[HYDRA-UMC-OPCUA-SERVER] an event read of ${objectKey}/${rule.name} needs more than ${config.maxPoints} points and was refused`);
        return failure(StatusCodes.BadResponseTooLarge);
      }
      events.push(...deriveEvents(rule, objectKey, result.points, result.before));
    }
  } catch (error) {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] event history read failed: ${error instanceof Error ? error.message : String(error)}`);
    return failure(StatusCodes.BadResourceUnavailable);
  }
  events.sort((a, b) => a.timestamp - b.timestamp || a.rule.name.localeCompare(b.rule.name));
  if (reverse) events.reverse();

  const wanted = details.numValuesPerNode > 0 ? details.numValuesPerNode : events.length;
  const page = events.slice(offset, offset + wanted);
  const clauses = filter.selectClauses ?? [];
  const fields = page.map(
    (event) =>
      new HistoryEventFieldList({
        eventFields: clauses.map((clause) => eventField(event, objectNodeId, (clause.browsePath ?? []).map((name) => name.name ?? ""))),
      }),
  );
  const more = offset + wanted < events.length;
  const result = new HistoryReadResult({
    statusCode: page.length === 0 ? StatusCodes.GoodNoData : StatusCodes.Good,
    historyData: new HistoryEvent({ events: fields }),
  });
  if (more) result.continuationPoint = Buffer.from(JSON.stringify({ o: offset + wanted }), "utf-8");
  return result;
}

/** The EventNotifier attribute of an object whose events can be read from the history (the HistoryRead bit). */
export const EVENT_NOTIFIER_HISTORY_READ = 4;

/**
 * Makes an object answer HistoryRead of events from the rules of its key. The object needs the HistoryRead bit in its EventNotifier and the
 * ReadHistory permission for the roles that may read it (see server.ts); the permission is checked here as well.
 */
export function installEvents(object: any, config: HistoryConfig, objectKey: string, rules: EventRule[]): void {
  object.historyRead = function (
    this: any,
    context: { checkPermission?: (node: unknown, permission: PermissionType) => boolean },
    details: unknown,
    _indexRange: unknown,
    _dataEncoding: unknown,
    continuationData: { continuationPoint?: Buffer | null } | undefined,
    callback?: (error: Error | null, result?: HistoryReadResult) => void,
  ): Promise<HistoryReadResult> {
    let answer: Promise<HistoryReadResult>;
    if (context?.checkPermission && !context.checkPermission(this, PermissionType.ReadHistory)) {
      answer = Promise.resolve(failure(StatusCodes.BadUserAccessDenied));
    } else if (!(details instanceof ReadEventDetails)) {
      answer = Promise.resolve(failure(StatusCodes.BadHistoryOperationUnsupported));
    } else {
      answer = readEvents(config, objectKey, this.nodeId, rules, details, continuationData?.continuationPoint);
    }
    if (callback) answer.then((r) => callback(null, r), (e: unknown) => callback(e instanceof Error ? e : new Error(String(e))));
    return answer;
  };
}
