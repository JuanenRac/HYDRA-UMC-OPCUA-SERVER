// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/fakeDatalake.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A stand-in data lake for the history tests: a small local HTTP server that speaks GET /history over the points it is given.
// =============================================================================
import http from "node:http";

export interface FakePoint {
  timestamp: number;
  value: number;
}

export const LAKE_TOKEN = "lake-token-lake";

/** Serves `GET /history` the way HYDRA-UMC-DATALAKE does, for every series the same points (or the points of the series the test names). */
export function fakeDatalake(seriesPoints: FakePoint[] | Record<string, FakePoint[]>): { server: http.Server; requests: string[]; url: () => string } {
  const requests: string[] = [];
  const pointsOf = (field: string): FakePoint[] => (Array.isArray(seriesPoints) ? seriesPoints : (seriesPoints[field] ?? []));
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/history" || req.headers.authorization !== `Bearer ${LAKE_TOKEN}`) {
      res.writeHead(url.pathname === "/history" ? 401 : 404).end("{}");
      return;
    }
    const q = url.searchParams;
    const all = pointsOf(q.get("field") ?? "");
    const start = q.has("start") ? Number(q.get("start")) : -Infinity;
    const before = q.has("before") ? Number(q.get("before")) : Infinity;
    const desc = q.get("order") === "desc";
    const limit = Number(q.get("limit") ?? 1000);
    let inside = all.filter((p) => p.timestamp >= start && p.timestamp < before);
    if (desc) inside = inside.reverse();
    const offset = q.has("cursor") ? Number(q.get("cursor")) : 0;
    const page = inside.slice(offset, offset + limit);
    const next = offset + limit < inside.length ? String(offset + limit) : null;
    const body: Record<string, unknown> = { order: desc ? "desc" : "asc", points: page, nextCursor: next };
    if (q.get("bounds") === "1") {
      body.bounds = {
        before: [...all].reverse().find((p) => p.timestamp < start) ?? null,
        after: all.find((p) => p.timestamp >= before) ?? null,
      };
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return { server, requests, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}
