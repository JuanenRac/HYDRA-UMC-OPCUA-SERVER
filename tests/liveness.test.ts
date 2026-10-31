// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/liveness.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================
// Online follows the liveness report of the server (GET /api/robots/liveness) instead of the `online` switch of the settings, behind a switch that is
// off by default. The server is a small HTTP server of its own that answers like HYDRA-UMC-SERVER does.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extractLiveness, extractRobots, livenessFromEnv, startRobotPolling } from "../src/robotSource.js";
import type { RobotSnapshot, RosterMeta } from "../src/server.js";

const SETTINGS = {
  controllers: [
    { id: "c1", robots: [{ id: 1, name: "Arm", online: true }, { id: 2, name: "Mill", online: true }, { id: 3, name: "Lathe", online: false }] },
    { id: "c2", robots: [{ id: 1, name: "Printer", online: true }] },
  ],
};

const LIVENESS = {
  schema_version: "1.0",
  stale_after_s: 30,
  robots: [
    { controller_id: "c1", robot_id: 1, state: "live", last_update_utc: "2026-01-01T00:00:00.000Z", age_s: 2, source: "state" },
    { controller_id: "c1", robot_id: 2, state: "stale", last_update_utc: "2026-01-01T00:00:00.000Z", age_s: 90, source: "state" },
    { controller_id: "c1", robot_id: 3, state: "live", last_update_utc: "2026-01-01T00:00:00.000Z", age_s: 1, source: "heartbeat" },
    { controller_id: "c2", robot_id: 1, state: "unknown" },
  ],
};

describe("extractLiveness", () => {
  it("keys the report by controller and robot", () => {
    const map = extractLiveness(LIVENESS);
    expect(map?.get("c1/1")).toBe("live");
    expect(map?.get("c1/2")).toBe("stale");
    expect(map?.get("c2/1")).toBe("unknown");
  });

  it("is null for anything that is not a report and skips unusable entries", () => {
    expect(extractLiveness(null)).toBeNull();
    expect(extractLiveness({ robots: "x" })).toBeNull();
    expect(extractLiveness({ robots: [null, {}, { robot_id: 1 }, { state: "live" }, { robot_id: {}, state: "live" }] })?.size).toBe(0);
  });
});

describe("extractRobots with a liveness report", () => {
  it("is online only for `live`, by controller and robot", () => {
    const robots = extractRobots(SETTINGS, extractLiveness(LIVENESS) ?? undefined);
    expect(robots.map((r) => [r.id, r.online])).toEqual([
      [1, true], // c1/1 live
      [2, false], // c1/2 stale although the switch says online
      [3, true], // c1/3 live although the switch says offline
      [1, false], // c2/1 unknown
    ]);
  });

  it("does not count a robot the report does not list", () => {
    const robots = extractRobots(SETTINGS, new Map());
    expect(robots.every((r) => !r.online)).toBe(true);
  });

  it("keeps the switch of the settings when there is no report", () => {
    expect(extractRobots(SETTINGS).map((r) => r.online)).toEqual([true, true, false, true]);
  });
});

describe("livenessFromEnv", () => {
  it("is off unless it is switched on", () => {
    expect(livenessFromEnv({})).toBe(false);
    expect(livenessFromEnv({ HYDRA_UMC_OPCUA_LIVENESS: "0" })).toBe(false);
    expect(livenessFromEnv({ HYDRA_UMC_OPCUA_LIVENESS: "" })).toBe(false);
    expect(livenessFromEnv({ HYDRA_UMC_OPCUA_LIVENESS: "maybe" })).toBe(false);
    expect(livenessFromEnv({ HYDRA_UMC_OPCUA_LIVENESS: "1" })).toBe(true);
    expect(livenessFromEnv({ HYDRA_UMC_OPCUA_LIVENESS: " On " })).toBe(true);
  });
});

describe("startRobotPolling against a simulated server", () => {
  let server: http.Server;
  let base: string;
  let livenessStatus = 200;
  let livenessBody: unknown = LIVENESS;
  let sessions = 0;
  const requests: string[] = [];

  beforeEach(async () => {
    livenessStatus = 200;
    livenessBody = LIVENESS;
    sessions = 0;
    requests.length = 0;
    server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && req.url === "/api/login") {
        sessions += 1;
        return send(200, { token: `t${sessions}` });
      }
      if (req.headers.authorization !== `Bearer t${sessions}`) return send(401, { error: "login" });
      if (req.url === "/api/settings") return send(200, SETTINGS);
      if (req.url === "/api/robots/liveness") return send(livenessStatus, livenessBody);
      return send(404, {});
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const waitFor = async (condition: () => boolean): Promise<void> => {
    for (let i = 0; i < 100 && !condition(); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(condition()).toBe(true);
  };

  const run = async (useLiveness: boolean | undefined) => {
    const rosters: Array<{ robots: RobotSnapshot[]; meta?: RosterMeta }> = [];
    const statuses: boolean[] = [];
    const stop = startRobotPolling({
      url: base,
      username: "bridge",
      password: "secret",
      intervalMs: 1000,
      useLiveness,
      setRobots: (robots, meta) => rosters.push({ robots, meta }),
      onSourceStatus: (readable) => statuses.push(readable),
    });
    await waitFor(() => rosters.length > 0);
    stop();
    return { first: rosters[0], statuses, requests: [...requests] };
  };

  it("by default never asks for the liveness report and keeps the switch of the settings", async () => {
    const { first, requests: asked } = await run(undefined);
    expect(first.robots.map((r) => r.online)).toEqual([true, true, false, true]);
    expect(asked).not.toContain("GET /api/robots/liveness");
  });

  it("with the switch on, Online is what the server says", async () => {
    const { first, statuses, requests: asked } = await run(true);
    expect(first.robots.map((r) => r.online)).toEqual([true, false, true, false]);
    expect(first.meta?.stale).toBe(false);
    expect(statuses[0]).toBe(true);
    expect(asked).toContain("GET /api/robots/liveness");
  });

  it("a robot that went stale is no longer online on the next poll", async () => {
    const first = await run(true);
    expect(first.first.robots[0].online).toBe(true);
    livenessBody = { ...LIVENESS, robots: [{ controller_id: "c1", robot_id: 1, state: "stale", age_s: 99 }] };
    const second = await run(true);
    expect(second.first.robots.every((r) => !r.online)).toBe(true);
  });

  it("an unreadable report leaves every robot not online and the source unreadable", async () => {
    livenessStatus = 503;
    const { first, statuses } = await run(true);
    expect(first.robots.every((r) => !r.online)).toBe(true);
    expect(first.meta?.stale).toBe(true);
    expect(statuses[0]).toBe(false);
  });

  it("a body that is not a report is refused the same way", async () => {
    livenessBody = { not: "a report" };
    const { first, statuses } = await run(true);
    expect(first.robots.every((r) => !r.online)).toBe(true);
    expect(statuses[0]).toBe(false);
  });

  it("an old server without the route (404) is not read as live", async () => {
    livenessStatus = 404;
    const { first } = await run(true);
    expect(first.robots.every((r) => !r.online)).toBe(true);
  });
});
