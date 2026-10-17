// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/robotSource.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import { extractRobots, pollerConfigFromEnv, startRobotPolling } from "../src/robotSource.js";
import type { RobotSnapshot } from "../src/server.js";

describe("extractRobots", () => {
  it("reads every robot of every controller", () => {
    const robots = extractRobots({
      controllers: [
        { robots: [{ id: 1, name: "Arm", online: true }, { id: "b", name: "Mill", online: false }] },
        { robots: [{ id: 3, online: true }] },
      ],
    });
    expect(robots).toEqual([
      { id: 1, name: "Arm", online: true },
      { id: "b", name: "Mill", online: false },
      { id: 3, name: "3", online: true },
    ]);
  });

  it("skips anything that is not a usable entry and never throws on odd input", () => {
    expect(extractRobots(null)).toEqual([]);
    expect(extractRobots({ controllers: "x" })).toEqual([]);
    expect(extractRobots({ controllers: [null, { robots: "x" }, { robots: [null, {}, { id: {} }, { id: 4, online: "yes" }] }] })).toEqual([
      { id: 4, name: "4", online: false },
    ]);
  });
});

describe("startRobotPolling", () => {
  const settings = { controllers: [{ robots: [{ id: 1, name: "Arm", online: true }] }] };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("sends the token and hands the roster to setRobots", async () => {
    const seen: RobotSnapshot[][] = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(settings), { status: 200 })) as unknown as typeof fetch;
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen[0]).toEqual([{ id: 1, name: "Arm", online: true }]);
    const [target, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(String(target)).toBe("http://host:3000/api/settings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("keeps known robots but shows them offline when the source fails", async () => {
    const seen: RobotSnapshot[][] = [];
    let ok = true;
    const fetchImpl = (async () => {
      if (ok) return new Response(JSON.stringify(settings), { status: 200 });
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 1000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    ok = false;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    stop();
    expect(seen[0][0].online).toBe(true);
    expect(seen.at(-1)).toEqual([{ id: 1, name: "Arm", online: false }]);
  });

  it("never reports a robot online when the source was never readable", async () => {
    const seen: RobotSnapshot[][] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen).toEqual([[]]);
  });
});

describe("pollerConfigFromEnv", () => {
  it("is off unless both the URL and the token are set", () => {
    expect(pollerConfigFromEnv({})).toBeNull();
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000" })).toBeNull();
    expect(pollerConfigFromEnv({ HYDRA_SERVER_TOKEN: "t" })).toBeNull();
  });

  it("defaults to five seconds and validates the interval and URL", () => {
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000", HYDRA_SERVER_TOKEN: "t" })).toEqual({ url: "http://h:3000", token: "t", intervalMs: 5000 });
    expect(() => pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h", HYDRA_SERVER_TOKEN: "t", HYDRA_SERVER_POLL_MS: "10" })).toThrow();
    expect(() => pollerConfigFromEnv({ HYDRA_SERVER_URL: "not a url", HYDRA_SERVER_TOKEN: "t" })).toThrow();
  });
});

describe("startRobotPolling - logging in with an account", () => {
  const settings = { controllers: [{ robots: [{ id: 1, name: "Arm", online: true }] }] };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 30));

  // a fake HYDRA-UMC-SERVER: /api/login hands out a numbered token, /api/settings accepts only the tokens it issued
  function fakeServer() {
    const state = { logins: 0, valid: new Set<string>(), calls: [] as string[] };
    const fetchImpl = (async (target: URL, init?: RequestInit) => {
      const path = target.pathname;
      state.calls.push(path);
      if (path === "/api/login") {
        const { username, password } = JSON.parse(String(init?.body));
        if (username !== "operator" || password !== "right") return new Response("no", { status: 401 });
        state.logins += 1;
        const token = `session-${state.logins}`;
        state.valid.add(token);
        return new Response(JSON.stringify({ token }), { status: 200 });
      }
      const header = (init?.headers as Record<string, string> | undefined)?.Authorization ?? "";
      if (!header) return new Response("{}", { status: 401 });
      if (!state.valid.has(header.replace("Bearer ", ""))) return new Response("{}", { status: 403 });
      return new Response(JSON.stringify(settings), { status: 200 });
    }) as unknown as typeof fetch;
    return { state, fetchImpl };
  }

  it("logs in first, then reads the roster with the token it was given", async () => {
    const { state, fetchImpl } = fakeServer();
    const seen: RobotSnapshot[][] = [];
    const stop = startRobotPolling({ url: "http://h:3000", username: "operator", password: "right", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen[0]).toEqual([{ id: 1, name: "Arm", online: true }]);
    expect(state.calls).toEqual(["/api/login", "/api/settings"]);
  });

  it("logs in again, once, when the session is refused", async () => {
    const { state, fetchImpl } = fakeServer();
    const seen: RobotSnapshot[][] = [];
    // the operator pasted a token that has already expired, and gave the account as well
    const stop = startRobotPolling({ url: "http://h:3000", token: "expired", username: "operator", password: "right", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen[0]).toEqual([{ id: 1, name: "Arm", online: true }]);
    expect(state.logins).toBe(1);
  });

  it("shows the robots offline when the login is refused, and does not loop", async () => {
    const { state, fetchImpl } = fakeServer();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const seen: RobotSnapshot[][] = [];
    const stop = startRobotPolling({ url: "http://h:3000", username: "operator", password: "wrong", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen).toEqual([[]]);
    expect(state.calls).toEqual(["/api/login"]);
  });

  it("refuses a response larger than the cap", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = (async () => new Response(JSON.stringify({ padding: "x".repeat(5 * 1024 * 1024) }), { status: 200 })) as unknown as typeof fetch;
    const seen: RobotSnapshot[][] = [];
    const stop = startRobotPolling({ url: "http://h:3000", token: "t", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();
    expect(seen).toEqual([[]]);
  });
});

describe("pollerConfigFromEnv - an account instead of a token", () => {
  it("is on with a URL and an account, and carries both when a token is set too", () => {
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000", HYDRA_SERVER_USER: "operator", HYDRA_SERVER_PASSWORD: "pw" })).toEqual({
      url: "http://h:3000",
      username: "operator",
      password: "pw",
      intervalMs: 5000,
    });
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000", HYDRA_SERVER_TOKEN: "t", HYDRA_SERVER_USER: "operator", HYDRA_SERVER_PASSWORD: "pw" })).toEqual({
      url: "http://h:3000",
      token: "t",
      username: "operator",
      password: "pw",
      intervalMs: 5000,
    });
  });

  it("is off with a user but no password", () => {
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000", HYDRA_SERVER_USER: "operator" })).toBeNull();
  });
});
