// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/liveSource.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The live alternative to polling GET /api/settings: one WebSocket to HYDRA-UMC-SERVER (/ws, declaring schema 2). The server sends the whole
// settings tree when the connection opens and a small patch per robot after every command, so the roster follows the server without a
// poll and each robot gets a "last seen" time: a robot that sent a patch recently is Live, one that has been quiet is not. That is the
// signal the Online flag of the operator interface cannot give (it only says what the operator switched on).
//
// The token travels as the hydra.bearer subprotocol, never in the address. When the source cannot be read the robots already known stay in
// the tree but are shown offline and stale, as with polling: a robot is never reported on the strength of old data.
// =============================================================================

import { apiUrl, extractRobots, readJsonCapped } from "./robotSource.js";
import type { RobotSnapshot, RosterMeta } from "./server.js";

/** The subprotocol the server answers with and reads the token from. */
export const WS_TOKEN_SUBPROTOCOL = "hydra.bearer";

/** The part of a WebSocket this module uses; the global WebSocket of Node fits it, and a test supplies its own. */
export interface WebSocketLike {
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  close(code?: number): void;
}
export type WebSocketFactory = (url: string, protocols: string[]) => WebSocketLike;

/** ws://host/path/ws?remoteApiVersion=2 for http://host/path (wss for https). */
export function wsUrl(base: string): string {
  const url = apiUrl(base, "/ws");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("remoteApiVersion", "2");
  return url.toString();
}

export interface LiveSourceOptions {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  setRobots: (robots: RobotSnapshot[], meta?: RosterMeta) => void;
  /** A robot sent a patch: the time it was seen, in unix milliseconds. */
  onRobotSeen?: (id: string | number, atMs: number) => void;
  onSourceStatus?: (readable: boolean) => void;
  fetchImpl?: typeof fetch;
  webSocketImpl?: WebSocketFactory;
  now?: () => number;
  /** The longest pause between two attempts to reconnect (default 30 s). */
  maxBackoffMs?: number;
}

/** Opens the stream and keeps it open. Returns a function that closes it for good. */
export function startRobotStream(options: LiveSourceOptions): () => void {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;
  const makeSocket: WebSocketFactory =
    options.webSocketImpl ??
    ((url, protocols) => {
      const Ctor = (globalThis as unknown as { WebSocket?: new (u: string, p: string[]) => WebSocketLike }).WebSocket;
      if (!Ctor) throw new Error("this Node has no global WebSocket (Node 22 or newer is needed for the live source)");
      return new Ctor(url, protocols);
    });
  const hasAccount = options.username !== undefined && options.password !== undefined;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  let sessionToken = options.token;
  let known: RobotSnapshot[] = [];
  let socket: WebSocketLike | undefined;
  let stopped = false;
  let backoff = 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let needLogin = !options.token && hasAccount;

  const login = async (): Promise<void> => {
    const response = await doFetch(apiUrl(options.url, "/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: options.username, password: options.password }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`login refused (HTTP ${response.status})`);
    const body = (await readJsonCapped(response)) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new Error("the login response carried no token");
    sessionToken = body.token;
    needLogin = false;
  };

  const markUnreadable = (reason: string): void => {
    console.warn(`[HYDRA-UMC-OPCUA-SERVER] live source unavailable: ${reason}`);
    known = known.map((robot) => ({ ...robot, online: false }));
    options.setRobots(known, { stale: true });
    options.onSourceStatus?.(false);
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, maxBackoff);
    timer = setTimeout(() => void connect(), wait);
    (timer as { unref?: () => void }).unref?.();
  };

  const onMessage = (data: unknown): void => {
    if (typeof data !== "string") return;
    let message: { type?: unknown; schema?: unknown; payload?: unknown; robotId?: unknown; patch?: unknown; error?: unknown };
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof message.error === "string") return; // an access-denied notice: the close that follows is handled by onclose
    if (message.type === "settings" || (message.type === "delta" && message.schema !== 2)) {
      // the whole tree: this is the roster, and the connection is readable
      known = extractRobots(message.payload);
      options.setRobots(known, { stale: false, observedAtMs: now() });
      options.onSourceStatus?.(true);
      backoff = 1000;
      return;
    }
    if (message.type === "delta" && message.schema === 2 && (typeof message.robotId === "number" || typeof message.robotId === "string")) {
      const at = now();
      options.onRobotSeen?.(message.robotId, at);
      const patch = message.patch as { online?: unknown } | undefined;
      if (patch && typeof patch.online === "boolean") {
        known = known.map((robot) => (String(robot.id) === String(message.robotId) ? { ...robot, online: patch.online as boolean } : robot));
        options.setRobots(known, { stale: false, observedAtMs: at });
      }
    }
  };

  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      if (needLogin) await login();
      const protocols = sessionToken ? [WS_TOKEN_SUBPROTOCOL, sessionToken] : [WS_TOKEN_SUBPROTOCOL];
      const ws = makeSocket(wsUrl(options.url), protocols);
      socket = ws;
      ws.onmessage = (event) => onMessage(event.data);
      ws.onerror = () => undefined; // the close that follows says what happened
      ws.onclose = (event) => {
        if (socket !== ws) return;
        socket = undefined;
        if (event.code === 1008 && hasAccount) needLogin = true; // the session was refused or revoked: log in again
        if (stopped) return;
        markUnreadable(`the connection closed${event.code ? ` (${event.code})` : ""}`);
        scheduleReconnect();
      };
    } catch (error) {
      if (stopped) return;
      markUnreadable(error instanceof Error ? error.message : String(error));
      scheduleReconnect();
    }
  };

  void connect();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    const ws = socket;
    socket = undefined;
    try {
      ws?.close(1000);
    } catch {
      // closing a socket that is already gone is not a problem
    }
  };
}
