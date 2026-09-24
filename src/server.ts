// =============================================================================
// HYDRA-UMC OPCUA SERVER - OPC-UA Address Space Server: src/server.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Core industrial modeling module for the Gateway (see this project's own
// README.md for the full rationale). node-opcua does the actual protocol
// work (address space browsing, subscriptions, security policies); this
// file builds a minimal but real address space - one HydraNode object
// with a couple of variables - so any OPC-UA client (UAExpert, Ignition,
// Siemens TIA Portal, ...) can already connect, browse and read something
// real today. The per-robot tree (one Robot_<id> object per robot) is built
// by the setRobots() function buildAddressSpaceServer() returns, from
// whatever list the caller hands it.
//
// buildAddressSpaceServer() is exported (not just called from main() below)
// so tests/server.test.ts can start a real OPCUAServer on an ephemeral
// port and connect a real OPCUAClient against it - proving the address
// space is actually browsable/readable over the real protocol, not just
// that addObject()/addVariable() were called without throwing.
// =============================================================================

import { OPCUAServer, Variant, DataType, DataValue, StatusCodes, MessageSecurityMode, SecurityPolicy, type ISessionContext } from "node-opcua";
import path from "node:path";
import { readPackageVersion } from "./version.js";
import { pollerConfigFromEnv, startRobotPolling } from "./robotSource.js";

// 4840 is the IANA-registered default OPC-UA TCP port, and node-opcua's
// own default - kept here explicitly (rather than relying on the library
// default) so it's obvious at a glance and overridable via PORT.
export function resolvePort(raw: string | undefined = process.env.PORT): number {
  if (raw === undefined || raw.trim() === "") return 4840;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`HYDRA-UMC-OPCUA-SERVER: PORT must be an integer in 1..65535, got ${raw}`);
  }
  return port;
}

const DEFAULT_PORT = resolvePort();

// A real, explicit, versioned namespace URI for this project's own address
// space, rather than node-opcua's implicit hostname-derived default - the
// review's own concern: "una actualizacion no debe cambiar
// silenciosamente la ruta que consume un cliente industrial". Bumped only
// on a real breaking change to the address space shape.
const NAMESPACE_URI = "urn:hydra-umc:opcua-server:v1";

export interface HydraNodeState {
  swarmOnline: boolean;
  activeRobotCount: number;
  spindleTempC: number;
  spindleTempUpdatedAtMs: number;
  // real disconnection tracking, not simulated. true means whatever
  // real source feeds spindleTempC is still actively updating it; a real
  // caller sets this to false the moment it detects the source has
  // stopped (a timeout, a closed connection, ...) - see SpindleTemp's
  // own timestamped_get below for exactly what that changes on the wire.
  // Defaults true: a source that has never been wired to mutate this
  // value at all behaves exactly as it always did (Good quality) rather
  // than starting in a fabricated "disconnected" state nobody reported.
  spindleTempConnected: boolean;
  maintenanceMode: boolean;
}

/** Builds and starts a real OPCUAServer with one HydraNode_1 object exposing
 * SwarmOnline (read/write Boolean) and ActiveRobotCount (read-only UInt32).
 * `state` is returned so a caller (main() below, or a test) can mutate
 * activeRobotCount and observe the change reflected in a real OPC-UA read -
 * the get() closures below always read from this same object, never a
 * value captured at construction time. */
export async function buildAddressSpaceServer(port: number = DEFAULT_PORT) {
  // Real username/password credentials for the one authenticated role this
  // v0 defines (see MaintenanceMode below) - sourced from real env vars,
  // never hardcoded. Unset means isValidUser rejects every credential, so
  // an undeployed instance never ships a silent default login.
  const adminUsername = process.env.OPCUA_ADMIN_USERNAME;
  const adminPassword = process.env.OPCUA_ADMIN_PASSWORD;

  // Real gap found while auditing the code:
  // leaving securityModes/securityPolicies unset let node-opcua fall back
  // to ITS OWN defaults (see server_end_point.js's defaultSecurityModes),
  // which - despite this project's own "Encryption: Basic256Sha256" README
  // claim - still include MessageSecurityMode.None, and node-opcua adds a
  // REAL SecurityPolicy.None/MessageSecurityMode.None endpoint alongside
  // the encrypted ones whenever None is present in securityModes at all.
  // Any client (or attacker) could simply choose that endpoint and skip
  // encryption/signing entirely - the Basic256Sha256 default was real but
  // optional, not enforced. Explicit here, with None excluded: every real
  // session now requires Sign or SignAndEncrypt with a real, modern
  // security policy. OPCUA_ALLOW_INSECURE is a real, explicit, off-by-
  // default escape hatch for local development against a client that
  // cannot yet manage a certificate exchange (e.g. a quick UAExpert
  // smoke test) - never silently enabled, and loud about it when it is.
  const allowInsecure = process.env.OPCUA_ALLOW_INSECURE === "1";
  if (allowInsecure) {
    console.warn("[HYDRA-UMC-OPCUA-SERVER] OPCUA_ALLOW_INSECURE=1: exposing an UNENCRYPTED SecurityPolicy.None endpoint. Never set this in a real deployment.");
  }
  const securityModes = allowInsecure
    ? [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt]
    : [MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt];
  const securityPolicies = [SecurityPolicy.Basic256Sha256, SecurityPolicy.Aes128_Sha256_RsaOaep, SecurityPolicy.Aes256_Sha256_RsaPss];

  const server = new OPCUAServer({
    port,
    resourcePath: "/HYDRA-UMC-OPCUA-SERVER",
    buildInfo: {
      productName: "HYDRA-UMC-OPCUA-SERVER",
      buildNumber: readPackageVersion(),
      buildDate: new Date(),
    },
    securityModes,
    securityPolicies,
    userManager: {
      isValidUser: (username: string, password: string): boolean => {
        if (!adminUsername || !adminPassword) return false;
        return username === adminUsername && password === adminPassword;
      },
    },
  });

  await server.initialize();

  // engine.addressSpace only exists after initialize() resolves - node-opcua
  // builds the base OPC-UA information model (the standard node set) at
  // that point, which is what getOwnNamespace()/rootFolder below build on
  // top of.
  const addressSpace = server.engine.addressSpace;
  if (!addressSpace) {
    throw new Error("HYDRA-UMC-OPCUA-SERVER: address space failed to initialize");
  }
  const namespace = addressSpace.getOwnNamespace();
  // A real, explicit URI instead of node-opcua's implicit hostname-derived
  // default - see NAMESPACE_URI's own doc comment above. Same namespace
  // index (1) as before, so existing browse-by-name lookups are unaffected.
  namespace.namespaceUri = NAMESPACE_URI;

  // Placeholder address space: one HydraNode object exposing a few
  // variables. Real deployments generate one such object per active
  // robot/tool from HYDRA-UMC-SERVER's own state (see the "Dynamic
  // Information Modeling" feature in README.md) - this proves the tree
  // shape and variable typing are already correct end to end. Explicit
  // string NodeIds (rather than node-opcua's auto-assigned numeric ones)
  // give this project's own address-space paths real stability - adding a
  // future DataItem before these in the file can never silently renumber
  // an existing one, the exact risk the review called out.
  const hydraNode = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "HydraNode_1",
    nodeId: "s=HydraNode_1",
  });

  const state: HydraNodeState = {
    swarmOnline: true,
    activeRobotCount: 0,
    spindleTempC: 22,
    spindleTempUpdatedAtMs: Date.now(),
    spindleTempConnected: true,
    maintenanceMode: false,
  };

  // Real gap found while auditing the code: this was writable by ANY anonymous
  // OPC-UA client, unlike MaintenanceMode below (which already has a real
  // per-session isUserWritable check). SwarmOnline is exactly the kind of
  // meaningful system state MaintenanceMode's own comment already worries
  // about - closed the same way, not a new mechanism. See
  // isUserWritable below (has to be set after addVariable returns the
  // node - same as maintenanceMode's own).
  const swarmOnline = namespace.addVariable({
    componentOf: hydraNode,
    browseName: "SwarmOnline",
    nodeId: "s=HydraNode_1.SwarmOnline",
    dataType: "Boolean",
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: state.swarmOnline }),
      set: (variant: Variant) => {
        state.swarmOnline = Boolean(variant.value);
        return StatusCodes.Good;
      },
    },
  });
  swarmOnline.isUserWritable = (context: ISessionContext): boolean => context.getUserName() !== "anonymous";

  namespace.addVariable({
    componentOf: hydraNode,
    browseName: "ActiveRobotCount",
    nodeId: "s=HydraNode_1.ActiveRobotCount",
    dataType: "UInt32",
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.UInt32, value: state.activeRobotCount }),
    },
  });

  // A real DataItem carrying its own real quality and UTC sourceTimestamp
  // (via `timestamped_get`, node-opcua's own documented mechanism for full
  // control over the DataValue, distinct from the simple `get()` above
  // which auto-stamps "now" on every read) plus a real, standard OPC-UA
  // EngineeringUnits (part 8 AnalogItemType) - the review's own
  // "asociar unidad, calidad y timestamp a cada variable". sourceTimestamp
  // reflects when the value actually last changed, not when it was read -
  // real historian semantics, not a stamp that lies about freshness.
  //
  // ("calidad y tiempo de origen coherentes con la fuente"): quality
  // is likewise mapped from the real observation, not from the fact that
  // a read happened to succeed. A `Good` statusCode paired with a stale
  // sourceTimestamp would let a client compute staleness by hand but
  // still see "Good" at a glance - real historian software, and this
  // project's own README, both treat quality as the primary signal.
  // `UncertainLastUsableValue` is node-opcua's own real, standard OPC-UA
  // status code for exactly this situation ("Whatever was updating this
  // value has stopped doing so.") - the LAST real value is kept and
  // still readable (never fabricated, never withheld), only its quality
  // degrades, with sourceTimestamp still honestly pointing at when it
  // was last genuinely observed. A correct certificate and write
  // permission on the session never overrides this - they authenticate
  // the CLIENT, not the freshness of the DATA.
  namespace.addAnalogDataItem({
    componentOf: hydraNode,
    browseName: "SpindleTemp",
    nodeId: "s=HydraNode_1.SpindleTemp",
    dataType: "Double",
    minimumSamplingInterval: 1000,
    engineeringUnits: { displayName: "°C", description: "degree Celsius", namespaceUri: "http://www.opcfoundation.org/UA/units/un/cefact", unitId: 4408652 },
    engineeringUnitsRange: { low: -20, high: 150 },
    value: {
      timestamped_get: () =>
        new DataValue({
          value: new Variant({ dataType: DataType.Double, value: state.spindleTempC }),
          statusCode: state.spindleTempConnected ? StatusCodes.Good : StatusCodes.UncertainLastUsableValue,
          sourceTimestamp: new Date(state.spindleTempUpdatedAtMs),
        }),
    },
  });

  // A real, dynamic per-session write authorization - the review's
  // own "autorizacion de lectura frente a escritura mediante
  // cliente de prueba". Overriding isUserWritable is node-opcua's own
  // documented mechanism for a check that varies per session (the static
  // userAccessLevel option on addVariable cannot); an anonymous session
  // (the default for every client) gets read-only, an authenticated one
  // (see the userManager.isValidUser check above) gets real write access -
  // same gate SwarmOnline's own isUserWritable above now uses too.
  const maintenanceMode = namespace.addVariable({
    componentOf: hydraNode,
    browseName: "MaintenanceMode",
    nodeId: "s=HydraNode_1.MaintenanceMode",
    dataType: "Boolean",
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.Boolean, value: state.maintenanceMode }),
      set: (variant: Variant) => {
        state.maintenanceMode = Boolean(variant.value);
        return StatusCodes.Good;
      },
    },
  });
  maintenanceMode.isUserWritable = (context: ISessionContext): boolean => context.getUserName() !== "anonymous";

  // One object per robot, built from whatever list the caller hands to
  // setRobots(). Node ids are derived from the robot id ("s=Robot_<id>"),
  // so a robot keeps the same path for as long as it exists. A robot that
  // is no longer in the list has its object and variables removed, and
  // ActiveRobotCount follows the number of robots reported online.
  const robotObjects = new Map<string, { object: any; state: RobotSnapshot }>();

  const setRobots = (robots: RobotSnapshot[]): void => {
    const wanted = new Map<string, RobotSnapshot>();
    for (const robot of robots) {
      const key = String(robot.id).replace(/[^A-Za-z0-9_-]/g, "_");
      if (key !== "") wanted.set(key, robot);
    }
    for (const [key, entry] of [...robotObjects]) {
      if (wanted.has(key)) continue;
      for (const child of entry.object.getComponents()) addressSpace.deleteNode(child);
      addressSpace.deleteNode(entry.object);
      robotObjects.delete(key);
    }
    for (const [key, robot] of wanted) {
      const known = robotObjects.get(key);
      if (known) {
        known.state = { ...robot };
        continue;
      }
      const entry = {
        object: namespace.addObject({
          organizedBy: addressSpace.rootFolder.objects,
          browseName: `Robot_${key}`,
          nodeId: `s=Robot_${key}`,
        }),
        state: { ...robot },
      };
      namespace.addVariable({
        componentOf: entry.object,
        browseName: "Name",
        nodeId: `s=Robot_${key}.Name`,
        dataType: "String",
        value: { get: () => new Variant({ dataType: DataType.String, value: entry.state.name }) },
      });
      namespace.addVariable({
        componentOf: entry.object,
        browseName: "Online",
        nodeId: `s=Robot_${key}.Online`,
        dataType: "Boolean",
        minimumSamplingInterval: 1000,
        value: { get: () => new Variant({ dataType: DataType.Boolean, value: entry.state.online }) },
      });
      robotObjects.set(key, entry);
    }
    state.activeRobotCount = [...robotObjects.values()].filter((e) => e.state.online).length;
  };

  await server.start();

  return { server, state, setRobots };
}

/** What the address space knows about one robot; fed from the caller's own source. */
export interface RobotSnapshot {
  id: string | number;
  name: string;
  online: boolean;
}

async function main() {
  const { server, setRobots } = await buildAddressSpaceServer(DEFAULT_PORT);
  const source = pollerConfigFromEnv();
  if (source) {
    startRobotPolling({ ...source, setRobots });
    console.log(`[HYDRA-UMC-OPCUA-SERVER] reading the robot roster from ${source.url} every ${source.intervalMs} ms`);
  }
  const endpointUrl = server.getEndpointUrl();
  console.log("=================================================");
  console.log(` HYDRA-UMC-OPCUA-SERVER v${readPackageVersion()}`);
  console.log(" ROLE: Full mapping of HydraState objects to OPC-UA address spaces");
  console.log(` STATUS: Running on port ${DEFAULT_PORT} - endpoint ${endpointUrl}`);
  console.log("=================================================");
}

// Only auto-start when run directly (node/tsx src/server.ts, or the
// bundled dist/server.cjs), not when imported by tests/server.test.ts -
// comparing basenames rather than full URLs sidesteps file:// vs Windows
// backslash-path mismatches entirely.
const entryFile = process.argv[1] ? path.basename(process.argv[1]) : "";
if (entryFile === "server.ts" || entryFile === "server.cjs" || entryFile === "server.js") {
  main().catch((err) => {
    console.error("[HYDRA-UMC-OPCUA-SERVER] fatal startup error:", err);
    process.exit(1);
  });
}
