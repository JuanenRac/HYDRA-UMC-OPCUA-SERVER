// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/robotSource.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Feeds the per-robot address space from HYDRA-UMC-SERVER. The robot roster
// is controllers[].robots in GET /api/settings (id, name, online). Polling is
// off unless HYDRA_SERVER_URL and HYDRA_SERVER_TOKEN are both set. When the
// source cannot be read, robots already known stay in the tree but are shown
// offline: a robot is never reported online on the strength of old data.
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

export interface RobotPollerOptions {
  url: string;
  token: string;
  intervalMs: number;
  setRobots: (robots: RobotSnapshot[]) => void;
  fetchImpl?: typeof fetch;
}

/** Polls once now and then every intervalMs. Returns a function that stops it. */
export function startRobotPolling(options: RobotPollerOptions): () => void {
  const { url, token, intervalMs, setRobots } = options;
  const doFetch = options.fetchImpl ?? fetch;
  let known: RobotSnapshot[] = [];
  let stopped = false;

  const pollOnce = async (): Promise<void> => {
    try {
      const response = await doFetch(new URL("/api/settings", url), {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(Math.max(1000, intervalMs)),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      known = extractRobots(await response.json());
      setRobots(known);
    } catch (error) {
      console.warn(`[HYDRA-UMC-OPCUA-SERVER] robot source unavailable: ${error instanceof Error ? error.message : String(error)}`);
      known = known.map((robot) => ({ ...robot, online: false }));
      setRobots(known);
    }
  };

  void pollOnce();
  const timer = setInterval(() => {
    if (!stopped) void pollOnce();
  }, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Polling settings from the environment, or null when polling is not configured. */
export function pollerConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; token: string; intervalMs: number } | null {
  const url = env.HYDRA_SERVER_URL?.trim();
  const token = env.HYDRA_SERVER_TOKEN?.trim();
  if (!url || !token) return null;
  const raw = env.HYDRA_SERVER_POLL_MS?.trim();
  const parsed = raw ? Number(raw) : 5000;
  if (!Number.isInteger(parsed) || parsed < 1000) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_SERVER_POLL_MS must be an integer of at least 1000, got ${raw}`);
  }
  new URL(url);
  return { url, token, intervalMs: parsed };
}
