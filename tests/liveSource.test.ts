// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/liveSource.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The live source: the WebSocket to HYDRA-UMC-SERVER, against a stand-in socket that the test drives.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startRobotStream, wsUrl, WS_TOKEN_SUBPROTOCOL, type WebSocketLike } from "../src/liveSource.js";
import { sourceModeFromEnv } from "../src/robotSource.js";
import type { RobotSnapshot, RosterMeta } from "../src/server.js";

class FakeSocket implements WebSocketLike {
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closedWith: number | undefined;
  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}
  close(code?: number): void {
    this.closedWith = code;
  }
  receive(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code });
  }
}

describe("wsUrl", () => {
  it("turns the address of the server into its WebSocket address, keeping a path prefix", () => {
    expect(wsUrl("http://10.0.0.5:3000")).toBe("ws://10.0.0.5:3000/ws?remoteApiVersion=2");
    expect(wsUrl("https://hydra.example/hydra/")).toBe("wss://hydra.example/hydra/ws?remoteApiVersion=2");
  });
});

describe("sourceModeFromEnv", () => {
  it("is poll unless stream is asked for, and refuses anything else", () => {
    expect(sourceModeFromEnv({})).toBe("poll");
    expect(sourceModeFromEnv({ HYDRA_UMC_OPCUA_SOURCE: " Stream " })).toBe("stream");
    expect(() => sourceModeFromEnv({ HYDRA_UMC_OPCUA_SOURCE: "push" })).toThrow(/poll or stream/);
  });
});

describe("startRobotStream", () => {
  let sockets: FakeSocket[];
  let rosters: Array<{ robots: RobotSnapshot[]; meta?: RosterMeta }>;
  let seen: Array<[string | number, number]>;
  let status: boolean[];
  let clock: number;

  const settings = (robots: unknown[]) => ({ type: "settings", payload: { controllers: [{ robots }] } });
  const start = (extra: Partial<Parameters<typeof startRobotStream>[0]> = {}) =>
    startRobotStream({
      url: "http://server:3000",
      token: "tok",
      setRobots: (robots, meta) => rosters.push({ robots, meta }),
      onRobotSeen: (id, at) => seen.push([id, at]),
      onSourceStatus: (ok) => status.push(ok),
      webSocketImpl: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      now: () => clock,
      ...extra,
    });

  beforeEach(() => {
    sockets = [];
    rosters = [];
    seen = [];
    status = [];
    clock = 1_000_000;
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("connects with the token as a subprotocol, never in the address", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe("ws://server:3000/ws?remoteApiVersion=2");
    expect(sockets[0].url).not.toContain("tok");
    expect(sockets[0].protocols).toEqual([WS_TOKEN_SUBPROTOCOL, "tok"]);
    stop();
  });

  it("takes the roster from the settings the server sends when the connection opens", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].receive(settings([{ id: 1, name: "Arm", online: true }, { id: "b", name: "Belt", online: false }]));
    expect(rosters).toHaveLength(1);
    expect(rosters[0].robots.map((r) => [r.id, r.online])).toEqual([[1, true], ["b", false]]);
    expect(rosters[0].meta).toEqual({ stale: false, observedAtMs: clock });
    expect(status).toEqual([true]);
    stop();
  });

  it("records the time a robot was seen from each patch, and applies an online patch", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].receive(settings([{ id: 1, name: "Arm", online: true }]));
    clock += 500;
    sockets[0].receive({ type: "delta", schema: 2, controllerId: "c1", robotId: 1, patch: { playbackState: "playing" } });
    expect(seen).toEqual([[1, clock]]);
    expect(rosters).toHaveLength(1);
    clock += 500;
    sockets[0].receive({ type: "delta", schema: 2, controllerId: "c1", robotId: 1, patch: { online: false } });
    expect(seen).toHaveLength(2);
    expect(rosters).toHaveLength(2);
    expect(rosters[1].robots[0].online).toBe(false);
    stop();
  });

  it("ignores what it cannot read", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].receive("not json");
    sockets[0].receive({ error: "Access denied: Invalid token" });
    sockets[0].receive({ type: "delta", schema: 2, patch: {} });
    sockets[0].receive(new Uint8Array(3));
    expect(rosters).toHaveLength(0);
    expect(seen).toHaveLength(0);
    stop();
  });

  it("shows the robots offline and stale when the connection drops, and connects again with a growing pause", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0].receive(settings([{ id: 1, name: "Arm", online: true }]));
    sockets[0].drop();
    const last = rosters[rosters.length - 1];
    expect(last.meta).toEqual({ stale: true });
    expect(last.robots[0].online).toBe(false);
    expect(status).toEqual([true, false]);
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(2);
    sockets[1].drop();
    await vi.advanceTimersByTimeAsync(1999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2);
    expect(sockets).toHaveLength(3);
    stop();
  });

  it("logs in with the account when there is no token, and again after the server refuses the session", async () => {
    const logins: string[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      logins.push(String(init?.body));
      return new Response(JSON.stringify({ token: `session-${logins.length}` }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const stop = start({ token: undefined, username: "u", password: "p", fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(logins).toHaveLength(1);
    expect(sockets[0].protocols).toEqual([WS_TOKEN_SUBPROTOCOL, "session-1"]);
    sockets[0].drop(1008);
    await vi.advanceTimersByTimeAsync(1001);
    expect(logins).toHaveLength(2);
    expect(sockets[1].protocols).toEqual([WS_TOKEN_SUBPROTOCOL, "session-2"]);
    sockets[1].drop(1006);
    await vi.advanceTimersByTimeAsync(2001);
    expect(logins).toHaveLength(2); // a plain drop does not log in again
    expect(sockets[2].protocols).toEqual([WS_TOKEN_SUBPROTOCOL, "session-2"]);
    stop();
  });

  it("a refused login is reported as unreadable and retried", async () => {
    const fetchImpl = (async () => new Response("no", { status: 401 })) as unknown as typeof fetch;
    const stop = start({ token: undefined, username: "u", password: "p", fetchImpl });
    await vi.advanceTimersByTimeAsync(0);
    expect(sockets).toHaveLength(0);
    expect(status).toEqual([false]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(status).toEqual([false, false]);
    stop();
  });

  it("stop closes the socket for good", async () => {
    const stop = start();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    expect(sockets[0].closedWith).toBe(1000);
    sockets[0].drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(1);
  });
});
