// =============================================================================
// HYDRA-UMC OPCUA SERVER - Alarms and Conditions from controller faults: src/faults.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// With HYDRA_UMC_OPCUA_FAULTS_URL set (off by default) the server reads the active faults of the controllers and the tool heads (URTC) and shows them as two
// OPC UA alarms (AlarmConditionType) under HydraNode_1: `McuAlarm` for the microcontroller faults and `UrtcAlarm` for the tool-head ones. An alarm is active
// while a fault of its group is active; its severity is 800 for a fault that stops a machine and 400 for a warning, and its message names the component and
// the error code of the worst active fault (the newest among equals). When the feed cannot be read, the alarms keep their state but their quality says that
// the last value is no longer being confirmed.
//
// The feed is a JSON document `{"faults": [{"robot_id", "component", "error_code", "detail", "at_utc", "severity"?, "active"?}]}` (see docs/API.md). The
// error codes are those of the controllers' adapter vocabulary: ESTOP_ACTIVE, OUT_OF_RANGE, TOOL_INCOMPATIBLE and GRIP_LOST_SEAL are faults; everything
// else is a warning. HYDRA_UMC_OPCUA_FAULTS_TOKEN (or _TOKEN_FILE) is the bearer token of the feed, HYDRA_UMC_OPCUA_FAULTS_POLL_MS how often it is read
// (1000 or more, default 5000).
// =============================================================================

import { DataType, StatusCodes, Variant } from "node-opcua";
import fs from "node:fs";

export interface GroupState {
  active: boolean;
  /** 800 for a fault, 400 for a warning, 0 when nothing is active. */
  severity: number;
  message: string;
  errorCode?: string;
}

export interface FaultSummary {
  mcu: GroupState;
  urtc: GroupState;
}

const FAULT_CODES = new Set(["ESTOP_ACTIVE", "OUT_OF_RANGE", "TOOL_INCOMPATIBLE", "GRIP_LOST_SEAL"]);

interface Fault {
  component: string;
  errorCode: string;
  detail: string;
  atMs: number;
  fault: boolean;
}

function readFaults(body: unknown): Fault[] {
  const list = (body as { faults?: unknown } | null)?.faults;
  if (!Array.isArray(list)) throw new Error("the fault feed has no faults list");
  const out: Fault[] = [];
  for (const entry of list) {
    const item = entry as { component?: unknown; error_code?: unknown; detail?: unknown; at_utc?: unknown; severity?: unknown; active?: unknown } | null;
    if (typeof item?.error_code !== "string" || item.error_code === "" || item.active === false) continue;
    const at = typeof item.at_utc === "string" ? Date.parse(item.at_utc) : NaN;
    out.push({
      component: typeof item.component === "string" ? item.component : "unknown",
      errorCode: item.error_code,
      detail: typeof item.detail === "string" ? item.detail : "",
      atMs: Number.isFinite(at) ? at : 0,
      fault: item.severity === "fault" ? true : item.severity === "warning" ? false : FAULT_CODES.has(item.error_code.toUpperCase()),
    });
  }
  return out;
}

function group(faults: Fault[]): GroupState {
  if (faults.length === 0) return { active: false, severity: 0, message: "no active fault" };
  const worst = [...faults].sort((a, b) => (a.fault === b.fault ? b.atMs - a.atMs : a.fault ? -1 : 1))[0];
  const more = faults.length > 1 ? ` (+${faults.length - 1} more)` : "";
  return { active: true, severity: worst.fault ? 800 : 400, message: `${worst.component}: ${worst.detail || worst.errorCode}${more}`.slice(0, 200), errorCode: worst.errorCode };
}

/** The two groups from a feed document: the tool-head (URTC) faults on one, every other component on the other. */
export function summarizeFaults(body: unknown): FaultSummary {
  const faults = readFaults(body);
  const isUrtc = (fault: Fault) => /urtc/i.test(fault.component);
  return { mcu: group(faults.filter((f) => !isUrtc(f))), urtc: group(faults.filter(isUrtc)) };
}

export interface FaultAlarms {
  /** The state of the alarms now; `null` says the feed could not be read. */
  apply(summary: FaultSummary | null): void;
  /** For tests and diagnostics: the alarm of a group. */
  alarms: Record<"mcu" | "urtc", any>;
}

/** Builds the two alarms under `source`. Needs the namespace and the address space of the running server. */
export function installFaultAlarms(addressSpace: any, namespace: any, source: any): FaultAlarms {
  // a condition source must be an event source of the Server object (Part 9)
  source.setEventNotifier(1);
  addressSpace.rootFolder.objects.server.addReference({ referenceType: "HasEventSource", nodeId: source.nodeId });
  const make = (name: string) => {
    const state = { active: false };
    const input = namespace.addVariable({
      componentOf: source,
      browseName: `${name}Active`,
      nodeId: `s=HydraNode_1.${name}Active`,
      dataType: "Boolean",
      value: { get: () => new Variant({ dataType: DataType.Boolean, value: state.active }) },
    });
    const alarm = namespace.instantiateAlarmCondition(
      "AlarmConditionType",
      {
        browseName: `${name}Alarm`,
        nodeId: `s=HydraNode_1.${name}Alarm`,
        conditionName: `${name}Alarm`,
        componentOf: source,
        conditionSource: source,
        inputNode: input,
        optionals: ["ConfirmedState", "Confirm"],
      },
      {},
    );
    alarm.setEnabledState(true);
    return { alarm, state };
  };
  const mcu = make("Mcu");
  const urtc = make("Urtc");
  const set = (target: { alarm: any; state: { active: boolean } }, group: GroupState, quality: any) => {
    target.alarm.raiseNewCondition({ message: group.message, severity: group.severity, quality, retain: group.active });
    if (group.active && !target.state.active) {
      target.state.active = true;
      target.alarm.activateAlarm();
    } else if (!group.active && target.state.active) {
      target.state.active = false;
      target.alarm.deactivateAlarm();
    }
  };
  return {
    alarms: { mcu: mcu.alarm, urtc: urtc.alarm },
    apply(summary) {
      if (summary === null) {
        // unreadable: the state stays, the quality says it is the last one that was usable
        const quality = StatusCodes.UncertainLastUsableValue;
        mcu.alarm.raiseNewCondition({ message: "the fault feed cannot be read; the state shown is the last one", severity: mcu.state.active ? 800 : 100, quality, retain: mcu.state.active });
        urtc.alarm.raiseNewCondition({ message: "the fault feed cannot be read; the state shown is the last one", severity: urtc.state.active ? 800 : 100, quality, retain: urtc.state.active });
        return;
      }
      set(mcu, summary.mcu, StatusCodes.Good);
      set(urtc, summary.urtc, StatusCodes.Good);
    },
  };
}

export interface FaultSource {
  url: string;
  token?: string;
  intervalMs: number;
}

/** The feed from the environment, or null while it is off. */
export function faultSourceFromEnv(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): FaultSource | null {
  const url = env.HYDRA_UMC_OPCUA_FAULTS_URL?.trim();
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_FAULTS_URL must be an http(s) URL");
  }
  const file = env.HYDRA_UMC_OPCUA_FAULTS_TOKEN_FILE?.trim();
  const token = (file ? read(file) : env.HYDRA_UMC_OPCUA_FAULTS_TOKEN ?? "").trim();
  const raw = env.HYDRA_UMC_OPCUA_FAULTS_POLL_MS?.trim();
  const interval = raw ? Number(raw) : 5000;
  if (!Number.isInteger(interval) || interval < 1000) throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_FAULTS_POLL_MS must be an integer of at least 1000, got ${raw}`);
  return { url, ...(token ? { token } : {}), intervalMs: interval };
}

/** Reads the feed now and then every intervalMs; returns a function that stops it. */
export function startFaultPolling(source: FaultSource, target: Pick<FaultAlarms, "apply">, doFetch: typeof fetch = fetch): () => void {
  let stopped = false;
  let busy = false;
  const poll = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      const response = await doFetch(source.url, { headers: source.token ? { Authorization: `Bearer ${source.token}` } : {}, signal: AbortSignal.timeout(Math.max(1000, source.intervalMs)) });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        throw new Error(`HTTP ${response.status}`);
      }
      target.apply(summarizeFaults(await response.json()));
    } catch (error) {
      console.warn(`[HYDRA-UMC-OPCUA-SERVER] fault feed unavailable: ${error instanceof Error ? error.message : String(error)}`);
      target.apply(null);
    } finally {
      busy = false;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), source.intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
