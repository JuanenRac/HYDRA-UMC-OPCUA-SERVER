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

export interface FakeRollup {
  sourceId: string;
  bucketMs: number;
  bucketStart: number;
  count: number;
  min: number;
  max: number;
  sum: number;
  avg: number;
}

/** What the stand-in offers beyond GET /history. A number is the HTTP status the route answers with; `true` serves it; absent: 404 (not offered). */
export interface FakeOptions {
  windows?: boolean | number;
  /** The windows route ignores order=desc, like a data lake from before it existed. */
  ignoreOrder?: boolean;
  rollups?: FakeRollup[] | number;
}

export const LAKE_TOKEN = "lake-token-lake";

/** Serves `GET /history` the way HYDRA-UMC-DATALAKE does, for every series the same points (or the points of the series the test names). */
export function fakeDatalake(seriesPoints: FakePoint[] | Record<string, FakePoint[]>, options: FakeOptions = {}): { server: http.Server; requests: string[]; url: () => string } {
  const requests: string[] = [];
  const pointsOf = (field: string): FakePoint[] => (Array.isArray(seriesPoints) ? seriesPoints : (seriesPoints[field] ?? []));
  const server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/windows" && req.headers.authorization === `Bearer ${LAKE_TOKEN}` && options.windows !== undefined) {
      if (typeof options.windows === "number") return void res.writeHead(options.windows).end("{}");
      const q = url.searchParams;
      const width = Number(q.get("bucketMs"));
      const start = Number(q.get("start"));
      const before = q.has("before") ? Number(q.get("before")) : Number(q.get("end")) + 1;
      if (q.get("order") === "desc" && !options.ignoreOrder) {
        // backwards: (start, end], windows counted from end, as GET /windows?order=desc of the data lake
        const end = Number(q.get("end"));
        const back = new Map<number, { count: number; min: number; max: number; sum: number }>();
        for (const p of pointsOf(q.get("field") ?? "")) {
          if (p.timestamp <= start || p.timestamp > end) continue;
          const key = end - Math.floor((end - p.timestamp) / width) * width;
          const b = back.get(key) ?? { count: 0, min: Infinity, max: -Infinity, sum: 0 };
          b.count += 1;
          b.min = Math.min(b.min, p.value);
          b.max = Math.max(b.max, p.value);
          b.sum += p.value;
          back.set(key, b);
        }
        const backRows = [...back.entries()].sort((a, b) => a[0] - b[0]).map(([bucketEnd, b]) => ({ bucketStart: bucketEnd - width, bucketEnd, ...b }));
        return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stats: (q.get("stats") ?? "").split(","), order: "desc", buckets: backRows }));
      }
      const buckets = new Map<number, { count: number; min: number; max: number; sum: number }>();
      for (const p of pointsOf(q.get("field") ?? "")) {
        if (p.timestamp < start || p.timestamp >= before) continue;
        const key = start + Math.floor((p.timestamp - start) / width) * width;
        const b = buckets.get(key) ?? { count: 0, min: Infinity, max: -Infinity, sum: 0 };
        b.count += 1;
        b.min = Math.min(b.min, p.value);
        b.max = Math.max(b.max, p.value);
        b.sum += p.value;
        buckets.set(key, b);
      }
      const rows = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([bucketStart, b]) => ({ bucketStart, ...b }));
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ stats: (q.get("stats") ?? "").split(","), buckets: rows }));
    }
    if (url.pathname === "/rollups" && req.headers.authorization === `Bearer ${LAKE_TOKEN}` && options.rollups !== undefined) {
      if (typeof options.rollups === "number") return void res.writeHead(options.rollups).end("{}");
      const sp = url.searchParams;
      const before = sp.has("before") ? Number(sp.get("before")) : Infinity;
      const end = sp.has("end") ? Number(sp.get("end")) : Infinity;
      const from = sp.has("start") ? Number(sp.get("start")) : -Infinity;
      let rows = options.rollups.filter((r) => r.bucketStart < before && r.bucketStart <= end && r.bucketStart >= from);
      if (sp.get("order") === "desc") rows = [...rows].reverse();
      if (sp.has("limit")) rows = rows.slice(0, Number(sp.get("limit")));
      return void res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(rows));
    }
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
