// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/methods.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// StartJob and AbortJob (src/methods.ts): the order of the steps with stand-ins for the gate, the queue and the audit trail, and then the
// methods called by a real OPC UA client against a real server.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, DataType, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType, Variant } from "node-opcua";
import type { ClientSession, OPCUAServer, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { JobMethods, methodsConfigFromEnv, methodsEnabled, type MethodsConfig } from "../src/methods.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

const CONFIG: MethodsConfig = {
  gate: { url: "http://gate.test", token: "gate-token-0123456789" },
  jobs: { url: "http://jobs.test", token: "jobs-token" },
  audit: { url: "http://lake.test" },
  timeoutMs: 1000,
};

interface Call {
  url: string;
  auth: string | null;
  body: any;
}

/** A fetch whose answer for each service the test sets; it remembers every call in order. */
function stand(answers: { gate?: () => Response | Promise<Response>; jobs?: (url: string) => Response | Promise<Response>; audit?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });
  const doFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("Authorization"), body: JSON.parse(String(init.body)) });
    if (url.startsWith("http://gate.test")) return answers.gate ? answers.gate() : json(200, { allowed: true, reason: "ok" });
    if (url.startsWith("http://jobs.test")) return answers.jobs ? answers.jobs(url) : json(201, { ID: "j" });
    return answers.audit ? answers.audit() : json(202, { written: 2 });
  }) as unknown as typeof fetch;
  return { calls, methods: new JobMethods(CONFIG, doFetch, () => 1000) };
}

describe("the settings", () => {
  it("are off unless the switch is 1, and then everything the methods need must be there", () => {
    expect(methodsEnabled({})).toBe(false);
    expect(methodsConfigFromEnv({ HYDRA_UMC_OPCUA_GATE_URL: "http://g:1" })).toBeUndefined();
    const full = { HYDRA_UMC_OPCUA_METHODS: "1", HYDRA_UMC_OPCUA_GATE_URL: "http://g:1", HYDRA_UMC_OPCUA_GATE_TOKEN: "t".repeat(20), HYDRA_UMC_OPCUA_JOBS_URL: "http://j:2", HYDRA_UMC_OPCUA_AUDIT_URL: "http://a:3" };
    expect(methodsConfigFromEnv(full)).toMatchObject({ gate: { url: "http://g:1" }, jobs: { url: "http://j:2" }, audit: { url: "http://a:3" }, timeoutMs: 3000 });
    for (const missing of ["HYDRA_UMC_OPCUA_GATE_URL", "HYDRA_UMC_OPCUA_GATE_TOKEN", "HYDRA_UMC_OPCUA_JOBS_URL", "HYDRA_UMC_OPCUA_AUDIT_URL"]) {
      const env: Record<string, string> = { ...full };
      delete env[missing];
      expect(() => methodsConfigFromEnv(env), missing).toThrow(/HYDRA_UMC_OPCUA_/);
    }
    expect(() => methodsConfigFromEnv({ ...full, HYDRA_UMC_OPCUA_JOBS_URL: "file:///x" })).toThrow(/http\(s\)/);
    expect(methodsConfigFromEnv({ ...full, HYDRA_UMC_OPCUA_GATE_TOKEN: "", HYDRA_UMC_OPCUA_GATE_TOKEN_FILE: "gate.token" }, () => "from-a-file-0123456789\n")?.gate.token).toBe("from-a-file-0123456789");
    expect(methodsConfigFromEnv({ ...full, HYDRA_UMC_OPCUA_METHOD_TIMEOUT_MS: "5000" })?.timeoutMs).toBe(5000);
  });
});

describe("StartJob", () => {
  it("records the order, asks the gate, then submits the job with its id as the dedup key, and records the outcome", async () => {
    const { calls, methods } = stand();
    const result = await methods.startJob(true, "hydra-admin", { jobId: "weld-42", requiredTool: "Laser", priority: 5 });
    expect(result).toMatchObject({ accepted: true, code: "ok" });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/ingest", "/gate/evaluate", "/jobs/submit", "/ingest"]);
    expect(calls[0].body).toMatchObject({ sourceId: "opcua:hydra-admin", kind: "method.StartJob", fields: { "job:weld-42": 1, "phase.order": 1 } });
    expect(calls[1]).toMatchObject({ auth: "Bearer gate-token-0123456789", body: { adapterId: "hydra-umc-opcua-server", capability: "startJob", jobId: "weld-42", allowUnobserved: true } });
    expect(calls[2]).toMatchObject({ auth: "Bearer jobs-token", body: { id: "weld-42", priority: 5, requiredTool: "Laser", dedupKey: "weld-42" } });
    expect(calls[3].body.fields).toMatchObject({ "phase.ok": 1 });
    expect(calls[3].body.timestamp).toBeGreaterThan(calls[0].body.timestamp);
  });

  it("is the same job when called twice (the queue says duplicate)", async () => {
    const { methods } = stand({ jobs: () => new Response("{}", { status: 200 }) });
    expect((await methods.startJob(true, "a", { jobId: "j1" })).message).toContain("already in the queue");
  });

  it("is refused for a session that is not the administrator's, before anything is asked", async () => {
    const { calls, methods } = stand();
    expect(await methods.startJob(false, "viewer", { jobId: "j1" })).toMatchObject({ accepted: false, code: "not_admin" });
    expect(calls).toHaveLength(0);
  });

  it("is refused for arguments that are not what they say, before anything is asked", async () => {
    const { calls, methods } = stand();
    for (const jobId of ["", "../x", "a b", "x".repeat(65), 5, undefined]) {
      expect((await methods.startJob(true, "a", { jobId })).code, String(jobId)).toBe("bad_arguments");
    }
    expect((await methods.startJob(true, "a", { jobId: "j", requiredTool: "Laser; drop" })).code).toBe("bad_arguments");
    expect((await methods.startJob(true, "a", { jobId: "j", priority: 5000 })).code).toBe("bad_arguments");
    expect((await methods.startJob(true, "a", { jobId: "j", priority: -1 })).code).toBe("bad_arguments");
    expect(calls).toHaveLength(0);
  });

  it("is not made when the order cannot be recorded", async () => {
    for (const audit of [() => new Response("{}", { status: 503 }), () => Promise.reject(new Error("down"))]) {
      const { calls, methods } = stand({ audit });
      expect(await methods.startJob(true, "a", { jobId: "j" })).toMatchObject({ accepted: false, code: "audit_unavailable" });
      expect(calls.every((c) => c.url.startsWith("http://lake.test"))).toBe(true);
    }
  });

  it("is refused when the gate denies, cannot be reached or answers something unreadable, and the queue is never asked", async () => {
    const cases: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response(JSON.stringify({ allowed: false, reason: "the cell is INHIBITED" }), { status: 200 }), "gate_denied"],
      [() => new Response("{}", { status: 503 }), "gate_unavailable"],
      [() => new Response("<html>", { status: 200 }), "gate_unavailable"],
      [() => new Response(JSON.stringify({ allowed: "yes" }), { status: 200 }), "gate_unavailable"],
      [() => Promise.reject(new Error("timeout")), "gate_unavailable"],
    ];
    for (const [gate, code] of cases) {
      const { calls, methods } = stand({ gate });
      const result = await methods.startJob(true, "a", { jobId: "j" });
      expect(result, code).toMatchObject({ accepted: false, code });
      expect(calls.some((c) => c.url.startsWith("http://jobs.test"))).toBe(false);
      expect(calls[calls.length - 1].body.fields).toMatchObject({ [`phase.${code}`]: 1 });
    }
    const denied = stand({ gate: () => new Response(JSON.stringify({ allowed: false, reason: "the cell is INHIBITED" }), { status: 200 }) });
    expect((await denied.methods.startJob(true, "a", { jobId: "j" })).message).toContain("INHIBITED");
  });

  it("reports a queue that refuses or is down as such", async () => {
    expect(await stand({ jobs: () => new Response("{}", { status: 409 }) }).methods.startJob(true, "a", { jobId: "j" })).toMatchObject({ accepted: false, code: "dispatcher_refused" });
    expect(await stand({ jobs: () => Promise.reject(new Error("refused")) }).methods.startJob(true, "a", { jobId: "j" })).toMatchObject({ accepted: false, code: "dispatcher_unavailable" });
  });
});

describe("AbortJob", () => {
  it("withdraws a job that waits in the queue, after the same steps", async () => {
    const { calls, methods } = stand({ jobs: () => new Response("{}", { status: 200 }) });
    expect(await methods.abortJob(true, "a", { jobId: "j9" })).toMatchObject({ accepted: true });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/ingest", "/gate/evaluate", "/jobs/cancel", "/ingest"]);
    expect(calls[1].body.capability).toBe("abortJob");
    expect(calls[2].body).toEqual({ id: "j9" });
  });

  it("does not claim to stop a job that is on a robot", async () => {
    const result = await stand({ jobs: () => new Response("{}", { status: 409 }) }).methods.abortJob(true, "a", { jobId: "j9" });
    expect(result).toMatchObject({ accepted: false, code: "dispatcher_refused" });
    expect(result.message).toContain("only the robot's own report ends it");
    expect((await stand({ jobs: () => new Response("{}", { status: 404 }) }).methods.abortJob(true, "a", { jobId: "j9" })).message).toContain("does not know");
  });

  it("is for the administrator and for a valid id, and is not made when the gate denies", async () => {
    const { calls, methods } = stand({ gate: () => new Response(JSON.stringify({ allowed: false, reason: "no" }), { status: 200 }) });
    expect((await methods.abortJob(false, "a", { jobId: "j" })).code).toBe("not_admin");
    expect((await methods.abortJob(true, "a", { jobId: "j k" })).code).toBe("bad_arguments");
    expect((await methods.abortJob(true, "a", { jobId: "j" })).code).toBe("gate_denied");
    expect(calls.some((c) => c.url.includes("/jobs/cancel"))).toBe(false);
  });
});

describe("the methods over OPC UA", () => {
  const admin: UserIdentityInfo = { type: UserTokenType.UserName, userName: "hydra-admin", password: "admin-test-only-credential" };
  const viewer: UserIdentityInfo = { type: UserTokenType.UserName, userName: "scada-viewer", password: "viewer-test-only-credential" };
  let server: OPCUAServer;
  let endpoint: string;
  const seen: string[] = [];
  let withMethods: OPCUAServer;
  let withoutMethods: OPCUAServer;

  beforeAll(async () => {
    process.env.OPCUA_ADMIN_USERNAME = "hydra-admin";
    process.env.OPCUA_ADMIN_PASSWORD = "admin-test-only-credential";
    process.env.OPCUA_VIEWER_USERNAME = "scada-viewer";
    process.env.OPCUA_VIEWER_PASSWORD = "viewer-test-only-credential";
    const { calls, methods } = stand();
    const original = calls.push.bind(calls);
    calls.push = (...items: Call[]) => {
      seen.push(...items.map((c) => new URL(c.url).pathname));
      return original(...items);
    };
    withMethods = (await buildAddressSpaceServer(0, { methods, faultAlarms: false, bridges: false })).server;
    withoutMethods = (await buildAddressSpaceServer(0, { methods: null, faultAlarms: false, bridges: false })).server;
    server = withMethods;
    endpoint = server.getEndpointUrl();
  });
  afterAll(async () => {
    await withMethods?.shutdown();
    await withoutMethods?.shutdown();
    for (const key of ["OPCUA_ADMIN_USERNAME", "OPCUA_ADMIN_PASSWORD", "OPCUA_VIEWER_USERNAME", "OPCUA_VIEWER_PASSWORD"]) delete process.env[key];
  });

  async function call(url: string, identity: UserIdentityInfo, method: string, args: Variant[]) {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(url);
    try {
      const session: ClientSession = await client.createSession(identity);
      try {
        return await session.call({ objectId: "ns=1;s=HydraNode_1", methodId: `ns=1;s=HydraNode_1.${method}`, inputArguments: args });
      } finally {
        await session.close();
      }
    } finally {
      await client.disconnect();
    }
  }
  const startArgs = [new Variant({ dataType: DataType.String, value: "weld-1" }), new Variant({ dataType: DataType.String, value: "" }), new Variant({ dataType: DataType.UInt32, value: 3 })];

  it("StartJob called by the administrator goes through the steps and answers Accepted and a message", async () => {
    const result = await call(endpoint, admin, "StartJob", startArgs);
    expect(result.statusCode.isGood()).toBe(true);
    expect(result.outputArguments?.[0].value).toBe(true);
    expect(String(result.outputArguments?.[1].value)).toContain("submitted");
    expect(seen).toEqual(["/ingest", "/gate/evaluate", "/jobs/submit", "/ingest"]);
  });

  it("is refused for the viewer account, and the steps are not reached", async () => {
    seen.length = 0;
    const result = await call(endpoint, viewer, "StartJob", startArgs);
    expect(result.statusCode.isGood()).toBe(false);
    expect(result.outputArguments?.[0].value).toBe(false);
    expect(seen).toEqual([]);
  });

  it("AbortJob answers through the same path", async () => {
    seen.length = 0;
    const result = await call(endpoint, admin, "AbortJob", [new Variant({ dataType: DataType.String, value: "weld-1" })]);
    expect(seen).toEqual(["/ingest", "/gate/evaluate", "/jobs/cancel", "/ingest"]);
    expect(result.outputArguments?.[0].value).toBeDefined();
  });

  it("the methods do not exist while they are off", async () => {
    const result = await call(withoutMethods.getEndpointUrl(), admin, "StartJob", startArgs);
    expect(result.statusCode.isGood()).toBe(false);
    expect(result.statusCode.name).toMatch(/BadMethodInvalid|BadNodeIdUnknown/);
  });
});
