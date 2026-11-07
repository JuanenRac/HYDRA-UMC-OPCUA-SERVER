// =============================================================================
// HYDRA-UMC OPCUA SERVER - The fleet as nodes, read from the MQTT broker: src/fleet.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// With HYDRA_UMC_OPCUA_MQTT=1 (off by default) the server subscribes to the topics `hydra/bridges/+/opcua` of the broker and shows what the bridges publish there as a
// read-only tree under `Fleet/<vehicle>/...`, with the type each node declares. The message is
//   {"observed_at": <ms>, "vehicle": "<name>", "nodes": [{"path": "Fleet/<vehicle>/battery/charge", "type": "Double", "value": 80.5}, ...]}
// Everything in it is checked before a node is made: the vehicle and every segment of a path are plain names, the path starts with `Fleet/<vehicle>/`, the type is one
// of Double, Boolean, String and Int64, the value has that type and is finite, and the size of the message and the number of nodes are bounded. A message that fails
// any check is dropped whole. A vehicle that stays silent longer than the stale window keeps its last values with an Uncertain quality. Nothing is writable and nothing is
// ever published to the broker.
// =============================================================================
import fs from "node:fs";
import { subscribe, type MqttSubscriber } from "./mqttClient.js";

export type FleetType = "Double" | "Boolean" | "String" | "Int64";

export interface FleetNode {
  /** The path below the root, `Fleet/<vehicle>/a/b`. */
  path: string;
  type: FleetType;
  value: number | boolean | string;
}

export interface FleetUpdate {
  vehicle: string;
  observedAtMs: number;
  nodes: FleetNode[];
}

export interface FleetConfig {
  host: string;
  port: number;
  topics: string[];
  username?: string;
  password?: string;
  staleMs: number;
}

const SEGMENT = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_NODES = 200;
const MAX_DEPTH = 6;
const MAX_STRING = 256;
const TYPES = new Set<string>(["Double", "Boolean", "String", "Int64"]);

export function fleetEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.HYDRA_UMC_OPCUA_MQTT ?? "").trim() === "1";
}

/** The settings from the environment. HYDRA_UMC_OPCUA_MQTT_URL is `mqtt://host[:port]` (default 127.0.0.1:1883); the password is read from the file named by HYDRA_UMC_OPCUA_MQTT_PASSWORD_FILE. */
export function fleetConfigFromEnv(env: NodeJS.ProcessEnv = process.env, readFile: (path: string) => string = (p) => fs.readFileSync(p, "utf8")): FleetConfig | null {
  if (!fleetEnabled(env)) return null;
  const raw = (env.HYDRA_UMC_OPCUA_MQTT_URL ?? "mqtt://127.0.0.1:1883").trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_MQTT_URL is not a URL (use mqtt://host:1883)");
  }
  if (url.protocol !== "mqtt:") throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_MQTT_URL must start with mqtt:// (TLS is not supported here: use a broker on this machine or a trusted network)");
  const port = url.port === "" ? 1883 : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_MQTT_URL has a port outside 1-65535");
  const topics = (env.HYDRA_UMC_OPCUA_MQTT_TOPICS ?? "hydra/bridges/+/opcua").split(",").map((t) => t.trim()).filter(Boolean);
  if (topics.length === 0) throw new Error("HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_MQTT_TOPICS is empty");
  for (const topic of topics) if (!/^[A-Za-z0-9_\-+#/]{1,200}$/.test(topic)) throw new Error(`HYDRA-UMC-OPCUA-SERVER: HYDRA_UMC_OPCUA_MQTT_TOPICS has a topic that is not a plain filter: ${topic}`);
  const config: FleetConfig = { host: url.hostname, port, topics, staleMs: Math.max(1000, Number(env.HYDRA_UMC_OPCUA_MQTT_STALE_MS ?? 60000) || 60000) };
  const user = (env.HYDRA_UMC_OPCUA_MQTT_USER ?? "").trim();
  if (user) {
    config.username = user;
    const file = (env.HYDRA_UMC_OPCUA_MQTT_PASSWORD_FILE ?? "").trim();
    if (file) config.password = readFile(file).replace(/[\r\n]+$/, "");
  }
  return config;
}

/** The update in a message, or null when anything about it is not acceptable. */
export function parseFleetMessage(payload: Buffer | string): FleetUpdate | null {
  const text = typeof payload === "string" ? payload : payload.toString("utf8");
  if (text.length > 64 * 1024) return null;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const message = body as { observed_at?: unknown; vehicle?: unknown; nodes?: unknown } | null;
  if (typeof message !== "object" || message === null) return null;
  if (typeof message.vehicle !== "string" || !SEGMENT.test(message.vehicle)) return null;
  if (typeof message.observed_at !== "number" || !Number.isFinite(message.observed_at) || message.observed_at < 0) return null;
  if (!Array.isArray(message.nodes) || message.nodes.length === 0 || message.nodes.length > MAX_NODES) return null;
  const prefix = `Fleet/${message.vehicle}/`;
  const seen = new Set<string>();
  const nodes: FleetNode[] = [];
  for (const entry of message.nodes) {
    const node = entry as { path?: unknown; type?: unknown; value?: unknown } | null;
    if (typeof node?.path !== "string" || !node.path.startsWith(prefix)) return null;
    const segments = node.path.split("/");
    if (segments.length > MAX_DEPTH + 2 || segments.length < 3 || !segments.every((s) => SEGMENT.test(s))) return null;
    if (seen.has(node.path)) return null;
    seen.add(node.path);
    if (typeof node.type !== "string" || !TYPES.has(node.type)) return null;
    const value = node.value;
    if (node.type === "Boolean" && typeof value !== "boolean") return null;
    if (node.type === "String" && (typeof value !== "string" || value.length > MAX_STRING)) return null;
    if (node.type === "Double" && (typeof value !== "number" || !Number.isFinite(value))) return null;
    if (node.type === "Int64" && (typeof value !== "number" || !Number.isSafeInteger(value))) return null;
    nodes.push({ path: node.path, type: node.type as FleetType, value: value as FleetNode["value"] });
  }
  // a path cannot be both a value and a folder of another value
  for (const a of seen) for (const b of seen) if (a !== b && b.startsWith(`${a}/`)) return null;
  return { vehicle: message.vehicle, observedAtMs: message.observed_at, nodes };
}

export interface FleetSubscription {
  stop(): void;
  connected(): boolean;
}

/** Subscribe and hand every acceptable message to `apply`. A message that is not acceptable is counted and dropped. */
export function startFleetSubscription(config: FleetConfig, apply: (update: FleetUpdate) => void, hooks: { onDropped?: () => void; onState?: (connected: boolean, reason?: string) => void } = {}): FleetSubscription {
  const options = { host: config.host, port: config.port, clientId: `hydra-opcua-${process.pid}-${Math.floor(Math.random() * 1e6)}`, ...(config.username !== undefined ? { username: config.username } : {}), ...(config.password !== undefined ? { password: config.password } : {}) };
  const subscription: MqttSubscriber = subscribe(
    options,
    config.topics,
    (_topic, payload) => {
      const update = parseFleetMessage(payload);
      if (update === null) hooks.onDropped?.();
      else apply(update);
    },
    hooks.onState,
  );
  return subscription;
}
