// =============================================================================
// HYDRA-UMC OPCUA SERVER - Controlled methods StartJob and AbortJob: src/methods.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The address space is read-only. These two OPC UA methods are the only way a client can ask for something to happen, and they exist only when
// HYDRA_UMC_OPCUA_METHODS=1 (off by default). Each call goes through the same steps, in this order, and stops at the first that refuses:
//
//   1. The session must be the administrator's (user name and password; never anonymous, never a certificate alone, never the viewer account).
//   2. The arguments must be what they say (a job id of letters, digits, '.', '_' and '-', a tool name, a priority).
//   3. The call is written to the audit trail in HYDRA-UMC-DATALAKE BEFORE anything else is asked. If it cannot be written the call is refused.
//   4. The capability gate (the service of HYDRA-UMC-CONNECTOR-HUB, which is the safety gate of HYDRA-UMC-SDK) is asked. Its answer must say
//      `allowed: true`; a denial, an error, a timeout or an answer that cannot be read is a refusal. This server attests only the permission it
//      checked itself (that the session is the administrator's); the state of the cell is read by the gate service.
//   5. Only then is the job queue of HYDRA-UMC-JOB-DISPATCHER told: StartJob submits the job (`POST /jobs/submit`, with the job id as its dedup key, so
//      calling it twice is the same job), AbortJob withdraws it (`POST /jobs/cancel`). A job that is already on a robot cannot be withdrawn by the
//      queue: the answer says so and nothing is reported as stopped.
//   6. The outcome is written to the audit trail (best effort: the order itself was recorded in step 3).
//
// Settings (all from the environment; the start fails when the switch is on and one is missing):
//   HYDRA_UMC_OPCUA_METHODS=1             the switch
//   HYDRA_UMC_OPCUA_GATE_URL / _GATE_TOKEN        the gate service (http://host:port) and its bearer token
//   HYDRA_UMC_OPCUA_JOBS_URL / _JOBS_TOKEN        the job queue and its token (the token may be empty for a loopback dispatcher)
//   HYDRA_UMC_OPCUA_AUDIT_URL / _AUDIT_TOKEN      the data lake that keeps the audit trail
//   HYDRA_UMC_OPCUA_METHOD_TIMEOUT_MS             how long each of those services may take (200 to 30000, default 3000)
// Each *_TOKEN may be given as *_TOKEN_FILE instead (a path).
// =============================================================================

import fs from "node:fs";

export interface ServiceRef {
  url: string;
  token?: string;
}

export interface MethodsConfig {
  gate: ServiceRef;
  jobs: ServiceRef;
  audit: ServiceRef;
  timeoutMs: number;
}

export type MethodCode = "ok" | "bad_arguments" | "not_admin" | "audit_unavailable" | "gate_denied" | "gate_unavailable" | "dispatcher_refused" | "dispatcher_unavailable";

export interface MethodResult {
  accepted: boolean;
  code: MethodCode;
  message: string;
}

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
const MAX_PRIORITY = 1000;

export function methodsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HYDRA_UMC_OPCUA_METHODS ?? "").trim() === "1";
}

function service(env: NodeJS.ProcessEnv, name: string, tokenOptional: boolean, read: (file: string) => string): ServiceRef {
  const url = env[`HYDRA_UMC_OPCUA_${name}_URL`]?.trim();
  if (!url) throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_METHODS=1 needs HYDRA_UMC_OPCUA_${name}_URL`);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("scheme");
  } catch {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_${name}_URL must be an http(s) URL`);
  }
  const file = env[`HYDRA_UMC_OPCUA_${name}_TOKEN_FILE`]?.trim();
  const token = (file ? read(file) : env[`HYDRA_UMC_OPCUA_${name}_TOKEN`] ?? "").trim();
  if (!token && !tokenOptional) throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_METHODS=1 needs HYDRA_UMC_OPCUA_${name}_TOKEN (or _TOKEN_FILE)`);
  return { url: url.replace(/\/+$/, ""), ...(token ? { token } : {}) };
}

/** The settings of the methods, or undefined while the switch is off. */
export function methodsConfigFromEnv(env: NodeJS.ProcessEnv = process.env, read: (file: string) => string = (file) => fs.readFileSync(file, "utf8")): MethodsConfig | undefined {
  if (!methodsEnabled(env)) return undefined;
  const timeout = Number(env.HYDRA_UMC_OPCUA_METHOD_TIMEOUT_MS);
  return {
    gate: service(env, "GATE", false, read),
    jobs: service(env, "JOBS", true, read),
    audit: service(env, "AUDIT", true, read),
    timeoutMs: Number.isInteger(timeout) && timeout >= 200 && timeout <= 30_000 ? timeout : 3000,
  };
}

const refuse = (code: MethodCode, message: string): MethodResult => ({ accepted: false, code, message });

export class JobMethods {
  constructor(
    private readonly config: MethodsConfig,
    private readonly doFetch: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private headers(ref: ServiceRef): Record<string, string> {
    return { "Content-Type": "application/json", ...(ref.token ? { Authorization: `Bearer ${ref.token}` } : {}) };
  }

  private async send(ref: ServiceRef, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const response = await this.doFetch(`${ref.url}${path}`, { method: "POST", headers: this.headers(ref), body: JSON.stringify(body), signal: AbortSignal.timeout(this.config.timeoutMs) });
    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: response.status, body: parsed };
  }

  /** One sample of the audit trail. The strings go into the identity of the series (the lake keeps numbers): sourceId opcua:<caller>, kind method.<name>. */
  private async audit(method: string, caller: string, jobId: string, phase: string): Promise<boolean> {
    const safe = (text: string) => text.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 96);
    try {
      const { status } = await this.send(this.config.audit, "/ingest", {
        sourceId: `opcua:${safe(caller)}`,
        kind: `method.${method}`,
        timestamp: this.lastAuditAt(),
        fields: { [`job:${safe(jobId)}`]: 1, [`phase.${safe(phase)}`]: 1 },
      });
      return status === 202 || status === 200;
    } catch {
      return false;
    }
  }

  private auditClock = 0;
  /** Every audit sample has a millisecond of its own, so two calls in the same millisecond do not replace one another in the lake. */
  private lastAuditAt(): number {
    this.auditClock = Math.max(this.now(), this.auditClock + 1);
    return this.auditClock;
  }

  private async gate(capability: string, caller: string, jobId: string): Promise<MethodResult | null> {
    let answer: { status: number; body: unknown };
    try {
      answer = await this.send(this.config.gate, "/gate/evaluate", {
        adapterId: "hydra-umc-opcua-server",
        capability,
        jobId,
        source: `opcua:${caller}`,
        idempotencyKey: `${jobId}:${capability}`,
        machineState: "IDLE",
        // This server cannot read a machine: it says so, and the answer carries observed:false.
        allowUnobserved: true,
        grantedPermissions: [capability === "startJob" ? "opcua.job.start" : "opcua.job.abort"],
        cellMode: "operational",
        humanConfirmed: false,
        satisfiedSafetyGates: ["cell.estop.clear"],
        // used only when the gate service has no provider of its own
        cellState: "READY",
      });
    } catch (error) {
      return refuse("gate_unavailable", `the capability gate could not be asked: ${(error as Error).message}`);
    }
    const body = answer.body as { allowed?: unknown; reason?: unknown } | null;
    if (answer.status !== 200 || typeof body?.allowed !== "boolean") return refuse("gate_unavailable", `the capability gate gave no usable answer (HTTP ${answer.status})`);
    if (!body.allowed) return refuse("gate_denied", `the capability gate refused: ${typeof body.reason === "string" ? body.reason : "no reason given"}`);
    return null;
  }

  async startJob(admin: boolean, caller: string, args: { jobId: unknown; requiredTool?: unknown; priority?: unknown }): Promise<MethodResult> {
    if (!admin) return refuse("not_admin", "StartJob is for the administrator's session only");
    const jobId = args.jobId;
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return refuse("bad_arguments", "jobId must be letters, digits, '.', '_' or '-' (up to 64)");
    const tool = typeof args.requiredTool === "string" ? args.requiredTool.trim() : "";
    if (tool !== "" && !TOOL.test(tool)) return refuse("bad_arguments", "requiredTool is not a tool name");
    const priority = typeof args.priority === "number" && Number.isFinite(args.priority) ? Math.trunc(args.priority) : 0;
    if (priority < 0 || priority > MAX_PRIORITY) return refuse("bad_arguments", `priority must be 0 to ${MAX_PRIORITY}`);
    if (!(await this.audit("StartJob", caller, jobId, "order"))) return refuse("audit_unavailable", "the call could not be recorded in the audit trail, so it was not made");
    const denied = await this.gate("startJob", caller, jobId);
    if (denied) {
      await this.audit("StartJob", caller, jobId, denied.code);
      return denied;
    }
    let result: MethodResult;
    try {
      const { status } = await this.send(this.config.jobs, "/jobs/submit", { id: jobId, priority, ...(tool ? { requiredTool: tool } : {}), dedupKey: jobId });
      result = status === 200 || status === 201 ? { accepted: true, code: "ok", message: status === 201 ? "the job was submitted to the queue" : "the job is already in the queue; nothing new was scheduled" } : refuse("dispatcher_refused", `the job queue refused the job (HTTP ${status})`);
    } catch (error) {
      result = refuse("dispatcher_unavailable", `the job queue could not be asked: ${(error as Error).message}`);
    }
    await this.audit("StartJob", caller, jobId, result.code);
    return result;
  }

  async abortJob(admin: boolean, caller: string, args: { jobId: unknown }): Promise<MethodResult> {
    if (!admin) return refuse("not_admin", "AbortJob is for the administrator's session only");
    const jobId = args.jobId;
    if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return refuse("bad_arguments", "jobId must be letters, digits, '.', '_' or '-' (up to 64)");
    if (!(await this.audit("AbortJob", caller, jobId, "order"))) return refuse("audit_unavailable", "the call could not be recorded in the audit trail, so it was not made");
    const denied = await this.gate("abortJob", caller, jobId);
    if (denied) {
      await this.audit("AbortJob", caller, jobId, denied.code);
      return denied;
    }
    let result: MethodResult;
    try {
      const { status } = await this.send(this.config.jobs, "/jobs/cancel", { id: jobId });
      if (status === 200) result = { accepted: true, code: "ok", message: "the job was withdrawn from the queue" };
      else if (status === 409) result = refuse("dispatcher_refused", "the job is on a robot or already finished: the queue cannot withdraw it, only the robot's own report ends it");
      else if (status === 404) result = refuse("dispatcher_refused", "the job queue does not know that job");
      else result = refuse("dispatcher_refused", `the job queue refused (HTTP ${status})`);
    } catch (error) {
      result = refuse("dispatcher_unavailable", `the job queue could not be asked: ${(error as Error).message}`);
    }
    await this.audit("AbortJob", caller, jobId, result.code);
    return result;
  }
}
