// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/observability.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A real subscription with a data-change notification, the quality of the robot Online variables
// while the roster cannot be read, the ecosystem-wide names of the roster settings and the optional
// health and metrics listener.
// =============================================================================
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AttributeIds,
  ClientSubscription,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  StatusCodes,
  TimestampsToReturn,
  type ClientSession,
} from "node-opcua";
import { buildAddressSpaceServer, LoginThrottle } from "../src/server.js";
import { pollerConfigFromEnv, startRobotPolling } from "../src/robotSource.js";
import { healthPortFromEnv, renderMetrics, startHealthServer, type HealthSnapshot } from "../src/health.js";

// These tests open secure channels with throw-away client certificates: accept them (a lab setting).
process.env.OPCUA_AUTO_ACCEPT = "1";

let built: Awaited<ReturnType<typeof buildAddressSpaceServer>>;
let client: OPCUAClient;
let session: ClientSession;

beforeAll(async () => {
  built = await buildAddressSpaceServer(0);
  client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(built.server.getEndpointUrl());
  session = await client.createSession();
});

afterAll(async () => {
  await session?.close();
  await client?.disconnect();
  await built?.server.shutdown();
});

const until = async (check: () => boolean | Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
};

describe("a real subscription", () => {
  it("delivers a data-change notification when a monitored value changes", async () => {
    const subscription = ClientSubscription.create(session, {
      requestedPublishingInterval: 200,
      requestedLifetimeCount: 60,
      requestedMaxKeepAliveCount: 10,
      maxNotificationsPerPublish: 10,
      publishingEnabled: true,
      priority: 1,
    });
    try {
      const monitored = await subscription.monitor(
        { nodeId: "ns=1;s=HydraNode_1.ActiveRobotCount", attributeId: AttributeIds.Value },
        { samplingInterval: 100, discardOldest: true, queueSize: 10 },
        TimestampsToReturn.Both,
      );
      const seen: number[] = [];
      monitored.on("changed", (dataValue) => seen.push(Number(dataValue.value.value)));
      // the first notification carries the current value
      expect(await until(() => seen.length >= 1)).toBe(true);
      built.state.activeRobotCount = 5;
      expect(await until(() => seen.includes(5), 10000)).toBe(true);
    } finally {
      await subscription.terminate();
      built.state.activeRobotCount = 0;
    }
  });
});

describe("the Online variable while the roster cannot be read", () => {
  const nodeId = "ns=1;s=Robot_arm1.Online";

  it("is Good with the read time when the roster was read, Uncertain (and false) when it could not be", async () => {
    const before = Date.now();
    built.setRobots([{ id: "arm1", name: "Arm", online: true }], { stale: false, observedAtMs: before });
    let result = await session.read({ nodeId, attributeId: AttributeIds.Value });
    expect(result.statusCode).toBe(StatusCodes.Good);
    expect(result.value.value).toBe(true);
    expect(result.sourceTimestamp?.getTime()).toBe(before);

    // what the poller does when HYDRA-UMC-SERVER cannot be read: never online on old data, and say so
    built.setRobots([{ id: "arm1", name: "Arm", online: false }], { stale: true });
    result = await session.read({ nodeId, attributeId: AttributeIds.Value });
    expect(result.statusCode).toBe(StatusCodes.UncertainNoCommunicationLastUsableValue);
    expect(result.value.value).toBe(false);
    expect(result.sourceTimestamp?.getTime()).toBe(before); // still the last time the roster was really read

    built.setRobots([{ id: "arm1", name: "Arm", online: true }], { stale: false, observedAtMs: before + 10 });
    result = await session.read({ nodeId, attributeId: AttributeIds.Value });
    expect(result.statusCode).toBe(StatusCodes.Good);
  });

  it("a caller that gives no freshness (as before) gets Good", async () => {
    built.setRobots([{ id: "arm1", name: "Arm", online: true }]);
    const result = await session.read({ nodeId, attributeId: AttributeIds.Value });
    expect(result.statusCode).toBe(StatusCodes.Good);
  });

  it("the poller marks the roster stale when the source fails and fresh when it answers", async () => {
    let healthy = true;
    const upstream = http.createServer((_req, res) => {
      if (!healthy) {
        res.writeHead(500).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ controllers: [{ robots: [{ id: "arm1", name: "Arm", online: true }] }] }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const metas: Array<{ stale: boolean; observedAtMs?: number } | undefined> = [];
    const stop = startRobotPolling({
      url: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      token: "t",
      intervalMs: 1000,
      setRobots: (robots, meta) => {
        metas.push(meta);
        built.setRobots(robots, meta);
      },
    });
    try {
      expect(await until(() => metas.some((m) => m?.stale === false && m.observedAtMs !== undefined))).toBe(true);
      healthy = false;
      expect(await until(() => metas.some((m) => m?.stale === true), 10000)).toBe(true);
      const result = await session.read({ nodeId, attributeId: AttributeIds.Value });
      expect(result.statusCode).toBe(StatusCodes.UncertainNoCommunicationLastUsableValue);
    } finally {
      stop();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    }
  });
});

describe("the names of the roster settings", () => {
  const base = { HYDRA_SERVER_URL: "http://old:3000", HYDRA_SERVER_TOKEN: "old-token" };

  it("keeps reading the original HYDRA_SERVER_* names", () => {
    expect(pollerConfigFromEnv(base)).toMatchObject({ url: "http://old:3000", token: "old-token", intervalMs: 5000 });
  });

  it("reads the ecosystem-wide HYDRA_UMC_SERVER_* names, which win over the original ones", () => {
    expect(pollerConfigFromEnv({ HYDRA_UMC_SERVER_URL: "http://wide:3000", HYDRA_UMC_SERVER_TOKEN: "wide-token", HYDRA_UMC_SERVER_POLL_MS: "2000" })).toMatchObject({
      url: "http://wide:3000",
      token: "wide-token",
      intervalMs: 2000,
    });
    expect(pollerConfigFromEnv({ ...base, HYDRA_UMC_SERVER_URL: "http://wide:3000" })).toMatchObject({ url: "http://wide:3000", token: "old-token" });
  });

  it("logs in with an account given under the new names", () => {
    expect(pollerConfigFromEnv({ HYDRA_UMC_SERVER_URL: "http://wide:3000", HYDRA_UMC_SERVER_USER: "op", HYDRA_UMC_SERVER_PASSWORD: "pw" })).toMatchObject({ username: "op", password: "pw" });
  });

  it("is still off without a URL and a credential, and still refuses a poll interval under a second", () => {
    expect(pollerConfigFromEnv({ HYDRA_UMC_SERVER_URL: "http://wide:3000" })).toBeNull();
    expect(() => pollerConfigFromEnv({ ...base, HYDRA_UMC_SERVER_POLL_MS: "10" })).toThrow(/at least 1000/);
  });
});

describe("health and metrics", () => {
  const snapshot = (over: Partial<HealthSnapshot> = {}): HealthSnapshot => ({
    version: "9.9.9",
    sessions: 2,
    subscriptions: 3,
    rejectedSessions: 1,
    cumulatedSessions: 7,
    failedLogins: 4,
    loginLocked: false,
    robots: 5,
    activeRobots: 4,
    swarmOnline: true,
    source: "ok",
    ...over,
  });

  it("is off unless a valid port is set, and binds to loopback by default", () => {
    expect(healthPortFromEnv({})).toBeNull();
    expect(healthPortFromEnv({ OPCUA_HEALTH_PORT: "9090" })).toEqual({ port: 9090, host: "127.0.0.1" });
    expect(healthPortFromEnv({ OPCUA_HEALTH_PORT: "9090", OPCUA_HEALTH_HOST: "0.0.0.0" })).toEqual({ port: 9090, host: "0.0.0.0" });
    for (const bad of ["0", "70000", "abc", "1.5"]) expect(() => healthPortFromEnv({ OPCUA_HEALTH_PORT: bad })).toThrow(/OPCUA_HEALTH_PORT/);
  });

  it("serves /health and /metrics and nothing else", async () => {
    let current = snapshot();
    const listener = startHealthServer({ port: 0, host: "127.0.0.1", snapshot: () => current });
    await new Promise<void>((resolve) => listener.once("listening", () => resolve()));
    const base = `http://127.0.0.1:${(listener.address() as { port: number }).port}`;
    try {
      const health = await fetch(`${base}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toMatchObject({ status: "ok", version: "9.9.9", sessions: 2, subscriptions: 3, robots: 5, source: "ok" });

      current = snapshot({ source: "unreadable" });
      const degraded = await fetch(`${base}/health`);
      expect(degraded.status).toBe(200); // a container health check must not fail because the roster is down
      expect(await degraded.json()).toMatchObject({ status: "degraded", source: "unreadable" });

      const metrics = await (await fetch(`${base}/metrics`)).text();
      expect(metrics).toContain("hydra_opcua_sessions 2");
      expect(metrics).toContain("hydra_opcua_failed_logins_total 4");
      expect(metrics).toContain("hydra_opcua_source_readable 0");
      expect(metrics).toContain("# TYPE hydra_opcua_sessions_total counter");

      expect((await fetch(`${base}/nothing`)).status).toBe(404);
      expect((await fetch(`${base}/health`, { method: "POST" })).status).toBe(405);
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  });

  it("renders a locked login and an unconfigured source", () => {
    const text = renderMetrics(snapshot({ loginLocked: true, source: "not configured", swarmOnline: false }));
    expect(text).toContain("hydra_opcua_login_locked 1");
    expect(text).toContain("hydra_opcua_source_readable 1");
    expect(text).toContain("hydra_opcua_swarm_online 0");
  });

  it("counts failed logins for the metrics", () => {
    const throttle = new LoginThrottle(3, 1000);
    throttle.recordFailure(1);
    throttle.recordFailure(2);
    throttle.recordFailure(5000); // the first two left the window; the counter keeps them
    expect(throttle.totalFailures).toBe(3);
  });

  it("the running server reports its sessions and subscriptions through the diagnostics it exposes", () => {
    expect(built.server.currentSessionCount).toBeGreaterThanOrEqual(1);
    expect(built.server.engine.currentSubscriptionCount).toBeGreaterThanOrEqual(0);
    expect(Number(built.server.engine.serverDiagnosticsSummary.cumulatedSessionCount)).toBeGreaterThanOrEqual(1);
    expect(built.robotCount()).toBeGreaterThanOrEqual(0);
  });
});
