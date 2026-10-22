// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/health.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// An optional, separate HTTP listener (OPCUA_HEALTH_PORT) with GET /health for a container or gateway health check
// and GET /metrics in the Prometheus text format. It is off unless the port is set, and it binds to 127.0.0.1 unless
// OPCUA_HEALTH_HOST says otherwise. It only reads numbers: no secret, no address-space data and no write path.
// =============================================================================

import { createServer, type Server } from "node:http";

export type SourceStatus = "not configured" | "ok" | "unreadable";

export interface HealthSnapshot {
  version: string;
  sessions: number;
  subscriptions: number;
  rejectedSessions: number;
  cumulatedSessions: number;
  failedLogins: number;
  loginLocked: boolean;
  robots: number;
  activeRobots: number;
  swarmOnline: boolean;
  source: SourceStatus;
}

export interface HealthOptions {
  port: number;
  host: string;
  snapshot: () => HealthSnapshot;
}

/** The health listener settings from the environment, or null when it is not configured. */
export function healthPortFromEnv(env: NodeJS.ProcessEnv = process.env): { port: number; host: string } | null {
  const raw = env.OPCUA_HEALTH_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: OPCUA_HEALTH_PORT must be an integer in 1..65535, got ${raw}`);
  }
  return { port, host: env.OPCUA_HEALTH_HOST?.trim() || "127.0.0.1" };
}

const startedAt = Date.now();

export function renderMetrics(s: HealthSnapshot): string {
  const metric = (name: string, help: string, kind: "counter" | "gauge", value: number) =>
    `# HELP ${name} ${help}\n# TYPE ${name} ${kind}\n${name} ${value}\n`;
  return (
    metric("hydra_opcua_sessions", "OPC UA sessions open now.", "gauge", s.sessions) +
    metric("hydra_opcua_subscriptions", "OPC UA subscriptions open now.", "gauge", s.subscriptions) +
    metric("hydra_opcua_sessions_total", "OPC UA sessions opened since the start.", "counter", s.cumulatedSessions) +
    metric("hydra_opcua_sessions_rejected_total", "Session requests the server rejected since the start.", "counter", s.rejectedSessions) +
    metric("hydra_opcua_failed_logins_total", "Failed user name and password logins since the start.", "counter", s.failedLogins) +
    metric("hydra_opcua_login_locked", "1 while every login is refused after too many failures.", "gauge", s.loginLocked ? 1 : 0) +
    metric("hydra_opcua_robots", "Robot objects in the address space.", "gauge", s.robots) +
    metric("hydra_opcua_robots_online", "Robots of the roster reported online.", "gauge", s.activeRobots) +
    metric("hydra_opcua_swarm_online", "1 while SwarmOnline is true.", "gauge", s.swarmOnline ? 1 : 0) +
    metric("hydra_opcua_source_readable", "1 when the robot roster was read at the last poll, 0 when it could not be, 1 when no source is configured.", "gauge", s.source === "unreadable" ? 0 : 1) +
    metric("hydra_opcua_uptime_seconds", "Seconds since the process started.", "gauge", Math.floor((Date.now() - startedAt) / 1000))
  );
}

/** The listener starts at once; the caller owns closing it. */
export function startHealthServer(options: HealthOptions): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed\n");
      return;
    }
    if (path === "/health") {
      const s = options.snapshot();
      // alive and answering is 200; an unreadable roster is reported as "degraded" without failing a container health check
      const body = JSON.stringify({
        status: s.source === "unreadable" ? "degraded" : "ok",
        version: s.version,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        sessions: s.sessions,
        subscriptions: s.subscriptions,
        robots: s.robots,
        source: s.source,
      });
      res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    if (path === "/metrics") {
      const body = renderMetrics(options.snapshot());
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "content-length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found\n");
  });
  server.listen(options.port, options.host);
  return server;
}
