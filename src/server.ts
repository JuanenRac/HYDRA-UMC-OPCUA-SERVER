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

import { OPCUAServer, Variant, DataType, StatusCodes } from "node-opcua";
import path from "node:path";
import { readPackageVersion } from "./version.js";

// 4840 is the IANA-registered default OPC-UA TCP port, and node-opcua's
// own default - kept here explicitly (rather than relying on the library
// default) so it's obvious at a glance and overridable via PORT.
const DEFAULT_PORT = Number(process.env.PORT) || 4840;

export interface HydraNodeState {
  swarmOnline: boolean;
  activeRobotCount: number;
}

/** Builds and starts a real OPCUAServer with one HydraNode_1 object exposing
 * SwarmOnline (read/write Boolean) and ActiveRobotCount (read-only UInt32).
 * `state` is returned so a caller (main() below, or a test) can mutate
 * activeRobotCount and observe the change reflected in a real OPC-UA read -
 * the get() closures below always read from this same object, never a
 * value captured at construction time. */
export async function buildAddressSpaceServer(port: number = DEFAULT_PORT) {
  const server = new OPCUAServer({
    port,
    resourcePath: "/HYDRA-UMC-OPCUA-SERVER",
    buildInfo: {
      productName: "HYDRA-UMC-OPCUA-SERVER",
      buildNumber: readPackageVersion(),
      buildDate: new Date(),
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

  // Placeholder address space: one HydraNode object exposing two
  // read-only/read-write variables. Real deployments generate one such
  // object per active robot/tool from HYDRA-UMC-SERVER's own state (see
  // the "Dynamic Information Modeling" feature in README.md) - this
  // proves the tree shape and variable typing are already correct end to
  // end.
  const hydraNode = namespace.addObject({
    organizedBy: addressSpace.rootFolder.objects,
    browseName: "HydraNode_1",
  });

  const state: HydraNodeState = { swarmOnline: true, activeRobotCount: 0 };

  namespace.addVariable({
    componentOf: hydraNode,
    browseName: "SwarmOnline",
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

  namespace.addVariable({
    componentOf: hydraNode,
    browseName: "ActiveRobotCount",
    dataType: "UInt32",
    minimumSamplingInterval: 1000,
    value: {
      get: () => new Variant({ dataType: DataType.UInt32, value: state.activeRobotCount }),
    },
  });

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
