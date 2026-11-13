// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/faults-and-bridges.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The alarms built from the fault feed (src/faults.ts) and the mobile bridges as nodes (src/bridges.ts), against a real server and a real client.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy, StatusCodes } from "node-opcua";
import type { ClientSession, OPCUAServer } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { faultSourceFromEnv, serverFaultsAsFeed, startFaultPolling, summarizeFaults } from "../src/faults.js";
import { bridgeNamesFromEnv, bridgesEnabled, extractBridges } from "../src/bridges.js";
import { extractRobots, startRobotPolling } from "../src/robotSource.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

describe("the faults that HYDRA-UMC-SERVER keeps (GET /api/faults)", () => {
  const ACTIVE = {
    active: [
      { schema: "fault-event/1", source: "mcu", robotId: "1", code: "ESTOP_ACTIVE", severity: "critical", text: "stop", state: "raised", since: 1000 },
      { schema: "fault-event/1", source: "urtc-head", robotId: "1", code: "TEMP_HIGH", severity: "warning", text: "hot", state: "raised", since: 2000 },
      { schema: "fault-event/1", source: "mcu", robotId: null, code: "NOTE", severity: "info", text: "fyi", state: "raised", since: 3000 },
    ],
  };

  it("maps severity to the two alarm groups and leaves out information", () => {
    const summary = summarizeFaults(serverFaultsAsFeed(ACTIVE));
    expect(summary.mcu).toMatchObject({ active: true, severity: 800, errorCode: "ESTOP_ACTIVE" });
    expect(summary.urtc).toMatchObject({ active: true, severity: 400, errorCode: "TEMP_HIGH" });
    expect(summarizeFaults(serverFaultsAsFeed({ active: [] })).mcu.active).toBe(false);
    expect(() => serverFaultsAsFeed({})).toThrow(/no list of active faults/);
  });

  it("is off unless the switch is 1, needs a credential and refuses to be set with the other feed", () => {
    expect(faultSourceFromEnv({ HYDRA_UMC_SERVER_URL: "http://127.0.0.1:3000", HYDRA_UMC_SERVER_TOKEN: "t" })).toBeNull();
    const on = { HYDRA_UMC_OPCUA_SERVER_FAULTS: "1", HYDRA_UMC_SERVER_URL: "http://127.0.0.1:3000/hydra", HYDRA_UMC_SERVER_TOKEN: "t" };
    expect(faultSourceFromEnv(on)).toMatchObject({ url: "http://127.0.0.1:3000/hydra/api/faults?active=1", token: "t", intervalMs: 5000 });
    expect(() => faultSourceFromEnv({ HYDRA_UMC_OPCUA_SERVER_FAULTS: "1" })).toThrow(/needs HYDRA_UMC_SERVER_URL/);
    expect(() => faultSourceFromEnv({ ...on, HYDRA_UMC_OPCUA_FAULTS_URL: "http://x" })).toThrow(/set only one/);
  });

  it("logs in with the account, reads the route and logs in again when the session ends", async () => {
    const applied: any[] = [];
    let logins = 0;
    let valid = "";
    const doFetch = (async (url: string, init: RequestInit) => {
      if (String(url).endsWith("/api/login")) {
        logins += 1;
        valid = `tok${logins}`;
        return new Response(JSON.stringify({ token: valid }), { status: 200 });
      }
      expect(String(url)).toBe("http://srv.test/api/faults?active=1");
      return new Headers(init.headers).get("Authorization") === `Bearer ${valid}` ? new Response(JSON.stringify(ACTIVE), { status: 200 }) : new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const server = { base: "http://srv.test", username: "u", password: "p" };
    const stop = startFaultPolling({ url: "http://srv.test/api/faults?active=1", intervalMs: 1000, server }, { apply: (s) => applied.push(s) }, doFetch);
    await new Promise((r) => setTimeout(r, 100));
    stop();
    expect(logins).toBe(1);
    expect(applied[0].mcu.errorCode).toBe("ESTOP_ACTIVE");
    // a token the server no longer knows is refused once, then the account logs in again
    const applied2: any[] = [];
    const stop2 = startFaultPolling({ url: "http://srv.test/api/faults?active=1", token: "old", intervalMs: 1000, server }, { apply: (s) => applied2.push(s) }, doFetch);
    await new Promise((r) => setTimeout(r, 100));
    stop2();
    expect(logins).toBe(2);
    expect(applied2[0].mcu.active).toBe(true);
  });
});

describe("the fault feed", () => {
  it("groups the active faults and takes the worst and newest of each group", () => {
    const summary = summarizeFaults({
      faults: [
        { component: "controller-1", error_code: "TIMEOUT", detail: "slow", at_utc: "2026-01-01T00:00:10Z" },
        { component: "controller-2", error_code: "ESTOP_ACTIVE", detail: "button", at_utc: "2026-01-01T00:00:05Z" },
        { component: "urtc-head-1", error_code: "INVALID_STATE", detail: "no reply" },
        { component: "controller-1", error_code: "OUT_OF_RANGE", at_utc: "2026-01-01T00:00:20Z", active: false },
      ],
    });
    expect(summary.mcu).toMatchObject({ active: true, severity: 800, errorCode: "ESTOP_ACTIVE" });
    expect(summary.mcu.message).toBe("controller-2: button (+1 more)");
    expect(summary.urtc).toMatchObject({ active: true, severity: 400, errorCode: "INVALID_STATE" });
    expect(summarizeFaults({ faults: [] }).mcu).toMatchObject({ active: false, severity: 0 });
    expect(() => summarizeFaults({})).toThrow(/no faults list/);
    expect(summarizeFaults({ faults: [{ component: "c", error_code: "TIMEOUT", severity: "fault" }] }).mcu.severity).toBe(800);
  });

  it("is read from the environment only when an address is set, and refuses what is not usable", () => {
    expect(faultSourceFromEnv({})).toBeNull();
    expect(faultSourceFromEnv({ HYDRA_UMC_OPCUA_FAULTS_URL: "http://s:1/faults", HYDRA_UMC_OPCUA_FAULTS_TOKEN: "abc" })).toEqual({ url: "http://s:1/faults", token: "abc", intervalMs: 5000 });
    expect(() => faultSourceFromEnv({ HYDRA_UMC_OPCUA_FAULTS_URL: "ftp://x" })).toThrow(/http\(s\)/);
    expect(() => faultSourceFromEnv({ HYDRA_UMC_OPCUA_FAULTS_URL: "http://x", HYDRA_UMC_OPCUA_FAULTS_POLL_MS: "10" })).toThrow(/at least 1000/);
  });

  it("is polled with the token, and an unreadable feed is applied as null", async () => {
    const applied: unknown[] = [];
    let ok = true;
    const doFetch = (async (_url: string, init: RequestInit) => {
      expect(new Headers(init.headers).get("Authorization")).toBe("Bearer feed-token");
      return ok ? new Response(JSON.stringify({ faults: [] }), { status: 200 }) : new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;
    const stop = startFaultPolling({ url: "http://feed.test", token: "feed-token", intervalMs: 1000 }, { apply: (s) => applied.push(s) }, doFetch);
    await new Promise((r) => setTimeout(r, 100));
    ok = false;
    stop();
    expect(applied[0]).toMatchObject({ mcu: { active: false } });
  });
});

describe("the alarms on a real server", () => {
  let server: OPCUAServer;
  let apply: (summary: ReturnType<typeof summarizeFaults> | null) => void;
  let alarms: Record<string, any>;
  let endpoint: string;

  beforeAll(async () => {
    const built = await buildAddressSpaceServer(0, { methods: null, faultAlarms: true, bridges: false });
    server = built.server;
    apply = built.faultAlarms!.apply;
    alarms = built.faultAlarms!.alarms;
    endpoint = server.getEndpointUrl();
  });
  afterAll(async () => {
    await server?.shutdown();
  });

  const activeText = (alarm: any): string => String(alarm.activeState.readValue().value.value.text);

  it("builds AlarmConditionType objects under HydraNode_1 that follow the feed", () => {
    expect(alarms.mcu.browseName.name).toBe("McuAlarm");
    expect(alarms.urtc.browseName.name).toBe("UrtcAlarm");
    expect(activeText(alarms.mcu)).toBe("Inactive");
    apply(summarizeFaults({ faults: [{ component: "controller-1", error_code: "ESTOP_ACTIVE", detail: "button pressed" }] }));
    expect(activeText(alarms.mcu)).toBe("Active");
    expect(activeText(alarms.urtc)).toBe("Inactive");
    expect(alarms.mcu.currentBranch().getSeverity()).toBe(800);
    expect(String(alarms.mcu.currentBranch().getMessage().text)).toContain("controller-1: button pressed");
    apply(summarizeFaults({ faults: [] }));
    expect(activeText(alarms.mcu)).toBe("Inactive");
  });

  it("keeps the state with an Uncertain quality while the feed cannot be read", () => {
    apply(summarizeFaults({ faults: [{ component: "urtc-head", error_code: "TIMEOUT", detail: "no reply" }] }));
    expect(activeText(alarms.urtc)).toBe("Active");
    apply(null);
    expect(activeText(alarms.urtc)).toBe("Active");
    expect(alarms.urtc.currentBranch().getQuality().value).toBe(StatusCodes.UncertainLastUsableValue.value);
    expect(String(alarms.urtc.currentBranch().getMessage().text)).toContain("cannot be read");
  });

  it("the alarm is browsable by a client under HydraNode_1", async () => {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(endpoint);
    try {
      const session: ClientSession = await client.createSession();
      try {
        const name = await session.read({ nodeId: "ns=2;s=HydraNode_1.McuAlarm", attributeId: AttributeIds.BrowseName });
        expect(String(name.value.value.name)).toBe("McuAlarm");
      } finally {
        await session.close();
      }
    } finally {
      await client.disconnect();
    }
  });
});

describe("the mobile bridges", () => {
  const body = {
    connected: true,
    bridges: [
      { name: "amr", available: true, state: {}, health: { state: "READY" }, updatedAt: "2026-01-01T00:00:00.000Z" },
      { name: "uav", available: false, state: null, health: { state: "FAULT" }, updatedAt: null },
      { name: "droids", available: null, state: null, health: null, updatedAt: null },
      { name: "cnc", available: true, state: null, health: { state: "READY" }, updatedAt: null },
      { name: "Bad Name", available: true },
    ],
  };

  it("are read for the names asked for, and only the usable entries", () => {
    const list = extractBridges(body, ["amr", "uav", "droids"]);
    expect(list?.map((b) => b.name)).toEqual(["amr", "uav", "droids"]);
    expect(list?.[0]).toEqual({ name: "amr", available: true, health: "READY", updatedAtMs: Date.parse("2026-01-01T00:00:00.000Z") });
    expect(list?.[2]).toEqual({ name: "droids", available: null, health: null, updatedAtMs: null });
    expect(extractBridges(body, null)?.map((b) => b.name)).toEqual(["amr", "uav", "droids", "cnc"]);
    expect(extractBridges({}, null)).toBeNull();
    expect(extractBridges({ bridges: [{ name: "amr", health: { state: "whatever" } }] }, null)?.[0].health).toBeNull();
  });

  it("are off unless the switch is 1, and the names have a default and are checked", () => {
    expect(bridgesEnabled({})).toBe(false);
    expect(bridgesEnabled({ HYDRA_UMC_OPCUA_BRIDGES: "1" })).toBe(true);
    expect(bridgeNamesFromEnv({})).toEqual(["amr", "uav", "droids"]);
    expect(bridgeNamesFromEnv({ HYDRA_UMC_OPCUA_BRIDGES_NAMES: "*" })).toBeNull();
    expect(() => bridgeNamesFromEnv({ HYDRA_UMC_OPCUA_BRIDGES_NAMES: "amr,../x" })).toThrow(/not a bridge name/);
  });

  it("are polled with the roster and appear as nodes with their quality", async () => {
    const built = await buildAddressSpaceServer(0, { methods: null, faultAlarms: false, bridges: true });
    try {
      const doFetch = (async (url: string) => {
        const path = new URL(url).pathname;
        if (path === "/api/settings") return new Response(JSON.stringify({ controllers: [{ id: "c", robots: [{ id: 1, name: "r1", online: true }] }] }), { status: 200 });
        return new Response(JSON.stringify(body), { status: 200 });
      }) as unknown as typeof fetch;
      expect(extractRobots({ controllers: [] })).toEqual([]);
      const stop = startRobotPolling({ url: "http://server.test", token: "t", intervalMs: 1000, setRobots: built.setRobots, bridges: { names: ["amr", "uav", "droids"], onBridges: built.setBridges }, fetchImpl: doFetch });
      await new Promise((r) => setTimeout(r, 200));
      stop();
      expect(built.bridgeCount()).toBe(3);
      const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
      await client.connect(built.server.getEndpointUrl());
      try {
        const session = await client.createSession();
        try {
          const read = async (id: string) => session.read({ nodeId: `ns=2;s=${id}`, attributeId: AttributeIds.Value });
          expect((await read("Bridge_amr.Available")).value.value).toBe(true);
          expect((await read("Bridge_amr.Health")).value.value).toBe("READY");
          expect((await read("Bridge_uav.Health")).value.value).toBe("FAULT");
          expect((await read("Bridge_uav.Available")).value.value).toBe(false);
          const unknown = await read("Bridge_droids.Available");
          expect(unknown.statusCode.name).toBe("BadWaitingForInitialData");
          // nothing is writable
          const written = await session.write({ nodeId: "ns=2;s=Bridge_amr.Available", attributeId: AttributeIds.Value, value: { value: { dataType: 1, value: false } } });
          expect(written.isGood()).toBe(false);
        } finally {
          await session.close();
        }
      } finally {
        await client.disconnect();
      }
      // the source goes unreadable: the nodes stay, with an uncertain quality
      built.setBridges(null);
      const client2 = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
      await client2.connect(built.server.getEndpointUrl());
      try {
        const session = await client2.createSession();
        try {
          const value = await session.read({ nodeId: "ns=2;s=Bridge_amr.Health", attributeId: AttributeIds.Value });
          expect(value.statusCode.name).toContain("Uncertain");
        } finally {
          await session.close();
        }
      } finally {
        await client2.disconnect();
      }
    } finally {
      await built.server.shutdown();
    }
  }, 30_000);
});
