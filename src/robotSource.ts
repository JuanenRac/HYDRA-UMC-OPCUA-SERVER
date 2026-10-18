// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/robotSource.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Feeds the per-robot address space from HYDRA-UMC-SERVER. The robot roster
// is controllers[].robots in GET /api/settings (id, name, online). Polling is
// off unless HYDRA_SERVER_URL is set together with a credential: a bearer
// token (HYDRA_SERVER_TOKEN) or an account to log in with
// (HYDRA_SERVER_USER and HYDRA_SERVER_PASSWORD, logged in again when the
// session expires). When the source cannot be read, robots already known stay
// in the tree but are shown offline: a robot is never reported online on the
// strength of old data.
// =============================================================================

import type { RobotSnapshot } from "./server.js";

/** Robots listed in a /api/settings body; anything that is not a usable entry is skipped. */
export function extractRobots(settings: unknown): RobotSnapshot[] {
  const robots: RobotSnapshot[] = [];
  const controllers = (settings as { controllers?: unknown } | null)?.controllers;
  if (!Array.isArray(controllers)) return robots;
  for (const controller of controllers) {
    const list = (controller as { robots?: unknown } | null)?.robots;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const robot = entry as { id?: unknown; name?: unknown; online?: unknown } | null;
      if (typeof robot?.id !== "string" && typeof robot?.id !== "number") continue;
      robots.push({
        id: robot.id,
        name: typeof robot.name === "string" ? robot.name : String(robot.id),
        online: robot.online === true,
      });
    }
  }
  return robots;
}

/** Largest response read from HYDRA-UMC-SERVER; a bigger one is refused. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Reads the body as it arrives and stops at the limit, counting bytes, so an endless or huge body is never held in memory. */
export async function readJsonCapped(response: Response, maxBytes: number = MAX_RESPONSE_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
  if (!response.body) return JSON.parse(await response.text());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`response larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
}

/** The URL of an API path under the configured base, keeping any path prefix of the base (http://host/hydra/ + api/settings). */
export function apiUrl(base: string, apiPath: string): URL {
  const withSlash = base.endsWith("/") ? base : `${base}/`;
  return new URL(apiPath.replace(/^\/+/, ""), withSlash);
}

export interface RobotPollerOptions {
  url: string;
  /** A bearer token HYDRA-UMC-SERVER already issued. */
  token?: string;
  /** Or an account to log in with (used when there is no token, and again when the session is refused). */
  username?: string;
  password?: string;
  intervalMs: number;
  setRobots: (robots: RobotSnapshot[]) => void;
  /** Called after every poll with whether the source could be read, so the address space can report the swarm as offline when it cannot. */
  onSourceStatus?: (readable: boolean) => void;
  fetchImpl?: typeof fetch;
}

/** Polls once now and then every intervalMs. Returns a function that stops it. */
export function startRobotPolling(options: RobotPollerOptions): () => void {
  const { url, intervalMs, setRobots, username, password } = options;
  const doFetch = options.fetchImpl ?? fetch;
  const hasAccount = username !== undefined && password !== undefined;
  let sessionToken = options.token;
  let known: RobotSnapshot[] = [];
  let stopped = false;
  let inFlight = false;

  const login = async (): Promise<void> => {
    const response = await doFetch(apiUrl(url, "/api/login"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(Math.max(1000, intervalMs)),
    });
    if (!response.ok) throw new Error(`login refused (HTTP ${response.status})`);
    const body = (await readJsonCapped(response)) as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) throw new Error("the login response carried no token");
    sessionToken = body.token;
  };

  const getSettings = (): Promise<Response> =>
    doFetch(apiUrl(url, "/api/settings"), {
      headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {},
      signal: AbortSignal.timeout(Math.max(1000, intervalMs)),
    });

  const pollOnce = async (): Promise<void> => {
    try {
      if (!sessionToken && hasAccount) await login();
      let response = await getSettings();
      if ((response.status === 401 || response.status === 403) && hasAccount) {
        // the session expired or was revoked: log in again, once, and ask again
        await response.arrayBuffer().catch(() => undefined);
        await login();
        response = await getSettings();
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      known = extractRobots(await readJsonCapped(response));
      setRobots(known);
      options.onSourceStatus?.(true);
    } catch (error) {
      console.warn(`[HYDRA-UMC-OPCUA-SERVER] robot source unavailable: ${error instanceof Error ? error.message : String(error)}`);
      known = known.map((robot) => ({ ...robot, online: false }));
      setRobots(known);
      options.onSourceStatus?.(false);
    }
  };

  // A poll that is still running when the next tick arrives is not started a second time: an old answer arriving late could overwrite a newer one.
  const pollGuarded = async (): Promise<void> => {
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await pollOnce();
    } finally {
      inFlight = false;
    }
  };

  void pollGuarded();
  const timer = setInterval(() => {
    void pollGuarded();
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Polling settings from the environment, or null when polling is not configured. */
export function pollerConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { url: string; token?: string; username?: string; password?: string; intervalMs: number } | null {
  const url = env.HYDRA_SERVER_URL?.trim();
  const token = env.HYDRA_SERVER_TOKEN?.trim();
  const username = env.HYDRA_SERVER_USER?.trim();
  const password = env.HYDRA_SERVER_PASSWORD;
  const hasAccount = Boolean(username) && Boolean(password);
  if (!url || (!token && !hasAccount)) return null;
  const raw = env.HYDRA_SERVER_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : 5000;
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_SERVER_POLL_MS must be an integer of at least 1000, got ${raw}`);
  }
  new URL(url);
  // the token wins when both are set, so the account is only carried as the way to renew it
  return {
    url,
    ...(token ? { token } : {}),
    ...(hasAccount ? { username, password } : {}),
    intervalMs: parsed,
  };
}
