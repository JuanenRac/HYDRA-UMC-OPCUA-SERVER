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
// real today. The dynamic per-robot tree described in the README (one
// object per active robot/tool, generated from HYDRA-UMC-SERVER's own
// state) gets wired in once that data path is defined - see
// mejoras_futuras.txt.
//
// buildAddressSpaceServer() is exported (not just called from main() below)
// so tests/server.test.ts can start a real OPCUAServer on an ephemeral
// port and connect a real OPCUAClient against it - proving the address
// space is actually browsable/readable over the real protocol, not just
// that addObject()/addVariable() were called without throwing.
// =============================================================================

import { OPCUAServer, Variant, DataType, DataValue, StatusCodes, type ISessionContext } from "node-opcua";
import path from "node:path";
import { readPackageVersion } from "./version.js";

// 4840 is the IANA-registered default OPC-UA TCP port, and node-opcua's
// own default - kept here explicitly (rather than relying on the library
// default) so it's obvious at a glance and overridable via PORT.
const DEFAULT_PORT = Number(process.env.PORT) || 4840;

// A real, explicit, versioned namespace URI for this project's own address
// space, rather than node-opcua's implicit hostname-derived default - the
// promotion audit's own concern: "una actualizacion no debe cambiar
// silenciosamente la ruta que consume un cliente industrial". Bumped only
// on a real breaking change to the address space shape.
const NAMESPACE_URI = "urn:hydra-umc:opcua-server:v1";

export interface HydraNodeState {
  swarmOnline: boolean;
  activeRobotCount: number;
  spindleTempC: number;
  spindleTempUpdatedAtMs: number;
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

  const server = new OPCUAServer({
    port,
    resourcePath: "/HYDRA-UMC-OPCUA-SERVER",
    buildInfo: {
      productName: "HYDRA-UMC-OPCUA-SERVER",
      buildNumber: readPackageVersion(),
      buildDate: new Date(),
    },
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
  // an existing one, the exact risk the promotion audit called out.
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
    maintenanceMode: false,
  };

  // Real gap found in a live bug audit: this was writable by ANY anonymous
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
  // EngineeringUnits (part 8 AnalogItemType) - the promotion audit's own
  // "asociar unidad, calidad y timestamp a cada variable". sourceTimestamp
  // reflects when the value actually last changed, not when it was read -
  // real historian semantics, not a stamp that lies about freshness.
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
          statusCode: StatusCodes.Good,
          sourceTimestamp: new Date(state.spindleTempUpdatedAtMs),
        }),
    },
  });

  // A real, dynamic per-session write authorization - the promotion
  // audit's own "autorizacion de lectura frente a escritura mediante
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

  await server.start();

  return { server, state };
}

async function main() {
  const { server } = await buildAddressSpaceServer(DEFAULT_PORT);
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
