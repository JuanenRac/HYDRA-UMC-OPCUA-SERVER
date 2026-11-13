// =============================================================================
// HYDRA-UMC OPCUA SERVER - src/legacyAlias.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The nodes of this server live in a namespace of their own (urn:hydra-umc:opcua-server:v1, index 2). Before, they were put in the
// local namespace of the server (index 1) after renaming it, which clients that expect index 1 to be the application URI took as an
// error. A client that still asks for `ns=1;s=...` is answered with the node of the same name in the namespace of this server for a
// period that the operator configures, so no client breaks on the day the server is updated and each can move to `ns=2;s=...` on its
// own time. The alias only resolves a node that has the same string identifier; it adds no node and gives no write access.
//
//   OPCUA_LEGACY_NS_ALIAS         1 (the default) answers ns=1 string identifiers with the node of the same name; 0 turns the alias off.
//   OPCUA_LEGACY_NS_ALIAS_UNTIL   optional date (YYYY-MM-DD, end of that day in UTC) after which the alias stops; empty: no end.
// =============================================================================

import { NodeId, NodeIdType, resolveNodeId } from "node-opcua";

export interface LegacyAliasConfig {
  enabled: boolean;
  /** Milliseconds since the epoch after which the alias answers nothing; undefined: no end. */
  untilMs?: number;
}

/** The alias settings from the environment; a date that is set but is not YYYY-MM-DD stops the start. */
export function legacyAliasFromEnv(env: Record<string, string | undefined> = process.env): LegacyAliasConfig {
  const enabled = (env.OPCUA_LEGACY_NS_ALIAS ?? "").trim() !== "0";
  const raw = (env.OPCUA_LEGACY_NS_ALIAS_UNTIL ?? "").trim();
  if (raw === "") return { enabled };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: OPCUA_LEGACY_NS_ALIAS_UNTIL must be a date as YYYY-MM-DD, got ${raw}`);
  }
  const start = Date.parse(`${raw}T00:00:00Z`);
  if (!Number.isFinite(start)) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: OPCUA_LEGACY_NS_ALIAS_UNTIL is not a real date: ${raw}`);
  }
  return { enabled, untilMs: start + 24 * 60 * 60 * 1000 };
}

/** The minimum an address space has to offer for the alias. */
interface Resolvable {
  findNode(nodeId: unknown): unknown;
}

/**
 * Makes `findNode` answer `ns=1;s=NAME` with the node `ns=<namespaceIndex>;s=NAME` when no node has the first one. Returns a function that
 * takes the alias off. Does nothing when the alias is disabled or `namespaceIndex` is 1 (nothing to alias).
 */
export function installLegacyNamespaceAlias(addressSpace: Resolvable, namespaceIndex: number, config: LegacyAliasConfig, now: () => number = Date.now): () => void {
  if (!config.enabled || namespaceIndex === 1) return () => undefined;
  const original = addressSpace.findNode.bind(addressSpace);
  addressSpace.findNode = (nodeId: unknown) => {
    const found = original(nodeId);
    if (found) return found;
    if (config.untilMs !== undefined && now() >= config.untilMs) return found;
    let id: NodeId;
    try {
      id = resolveNodeId(nodeId as string);
    } catch {
      return found;
    }
    if (id.namespace !== 1 || id.identifierType !== NodeIdType.STRING) return found;
    return original(new NodeId(NodeIdType.STRING, id.value as string, namespaceIndex));
  };
  return () => {
    addressSpace.findNode = original;
  };
}
