// =============================================================================
// HYDRA-UMC OPCUA SERVER - The mobile bridges as nodes: src/bridges.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// With HYDRA_UMC_OPCUA_BRIDGES=1 (off by default) the server also reads GET /api/bridges of HYDRA-UMC-SERVER (the gateway to the bridges, which the server
// only serves while its own bridge gateway is switched on) and shows the mobile bridges, by default amr, uav and droids, as `Bridge_<name>` objects under a
// `Bridges` folder: whether the bridge is available, the state of its health report (READY, DEGRADED, INHIBITED, FAULT, SAFE_STOP) and when it last said
// something. A SCADA then sees the fleet next to the robots. Nothing is writable. A bridge the server does not list is not in the tree; when the server
// cannot be read, the nodes keep their last value with an Uncertain quality. HYDRA_UMC_OPCUA_BRIDGES_NAMES is a comma list of bridge names ("*" for all).
// =============================================================================

export interface BridgeSnapshot {
  /** The lower-case name of the bridge: amr, uav, droids, ... */
  name: string;
  /** null until the bridge has announced itself. */
  available: boolean | null;
  /** The `state` of its health report, or null when it has none. */
  health: string | null;
  /** When the server last heard from it, in milliseconds since the epoch, or null. */
  updatedAtMs: number | null;
}

const NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const HEALTH_STATES = new Set(["READY", "DEGRADED", "INHIBITED", "FAULT", "SAFE_STOP"]);

export function bridgesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HYDRA_UMC_OPCUA_BRIDGES ?? "").trim() === "1";
}

/** The bridge names to show: the list of the environment (default amr, uav, droids), or null for every bridge. */
export function bridgeNamesFromEnv(env: NodeJS.ProcessEnv = process.env): readonly string[] | null {
  const raw = (env.HYDRA_UMC_OPCUA_BRIDGES_NAMES ?? "amr,uav,droids").trim();
  if (raw === "*") return null;
  const names = raw.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  for (const name of names) if (!NAME.test(name)) throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_BRIDGES_NAMES has a name that is not a bridge name: ${name}`);
  if (names.length === 0) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_BRIDGES_NAMES is empty (use * for every bridge)");
  return names;
}

/** The bridges of a GET /api/bridges body, those of `names` only; anything that is not a usable entry is skipped. Null when the body is not a bridge list. */
export function extractBridges(body: unknown, names: readonly string[] | null): BridgeSnapshot[] | null {
  const list = (body as { bridges?: unknown } | null)?.bridges;
  if (!Array.isArray(list)) return null;
  const out: BridgeSnapshot[] = [];
  for (const entry of list) {
    const bridge = entry as { name?: unknown; available?: unknown; health?: unknown; updatedAt?: unknown } | null;
    if (typeof bridge?.name !== "string" || !NAME.test(bridge.name)) continue;
    if (names !== null && !names.includes(bridge.name)) continue;
    const health = (bridge.health as { state?: unknown } | null)?.state;
    const updated = typeof bridge.updatedAt === "string" ? Date.parse(bridge.updatedAt) : NaN;
    out.push({
      name: bridge.name,
      available: typeof bridge.available === "boolean" ? bridge.available : null,
      health: typeof health === "string" && HEALTH_STATES.has(health) ? health : null,
      updatedAtMs: Number.isFinite(updated) ? updated : null,
    });
  }
  return out;
}
