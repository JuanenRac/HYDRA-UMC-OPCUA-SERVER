// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/server.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real protocol-level tests: starts a real OPCUAServer on an ephemeral
// port and connects a real OPCUAClient against it (node-opcua's own
// client, the same library UAExpert/Ignition would use) - browsing and
// reading the address space over the real OPC-UA binary protocol, not
// just calling internal functions directly.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OPCUAClient, AttributeIds, DataType, MessageSecurityMode, SecurityPolicy } from "node-opcua";
import { buildAddressSpaceServer, type HydraNodeState } from "../src/server.js";
import type { OPCUAServer } from "node-opcua";

// Port 0 would be ideal but node-opcua's OPCUAServer does not support
// binding an ephemeral port and reporting it back cleanly across all its
// endpoint plumbing, so a fixed high, unlikely-to-collide port is used
// instead - matching how every other project in this ecosystem picks a
// non-default test port.
const TEST_PORT = 41840;

let server: OPCUAServer;
let state: HydraNodeState;

beforeEach(async () => {
  const built = await buildAddressSpaceServer(TEST_PORT);
  server = built.server;
  state = built.state;
});

afterEach(async () => {
  await server.shutdown();
});

async function withClient<T>(fn: (session: import("node-opcua").ClientSession) => Promise<T>): Promise<T> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
  });
  const endpointUrl = `opc.tcp://localhost:${TEST_PORT}/HYDRA-UMC-OPCUA-SERVER`;
  await client.connect(endpointUrl);
  const session = await client.createSession();
  try {
    return await fn(session);
  } finally {
    await session.close();
    await client.disconnect();
  }
}

describe("HYDRA-UMC-OPCUA-SERVER address space (real OPC-UA protocol)", () => {
  it("accepts a real OPC-UA client connection and session", async () => {
    await withClient(async (session) => {
      expect(session).toBeDefined();
    });
  });

  it("exposes SwarmOnline as a real, readable Boolean variable defaulting to true", async () => {
    const value = await withClient(async (session) => {
      const browsePath = await session.translateBrowsePath({
        startingNode: "ns=0;i=85", // Objects folder
        relativePath: {
          elements: [
            { targetName: { namespaceIndex: 1, name: "HydraNode_1" } },
            { targetName: { namespaceIndex: 1, name: "SwarmOnline" } },
          ],
        },
      });
      const nodeId = browsePath.targets?.[0]?.targetId;
      expect(nodeId).toBeDefined();
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value as boolean;
    });
    expect(value).toBe(true);
  });

  it("reflects a real mutation of activeRobotCount in a real OPC-UA read", async () => {
    state.activeRobotCount = 3;
    const value = await withClient(async (session) => {
      const browsePath = await session.translateBrowsePath({
        startingNode: "ns=0;i=85",
        relativePath: {
          elements: [
            { targetName: { namespaceIndex: 1, name: "HydraNode_1" } },
            { targetName: { namespaceIndex: 1, name: "ActiveRobotCount" } },
          ],
        },
      });
      const nodeId = browsePath.targets?.[0]?.targetId;
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value as number;
    });
    expect(value).toBe(3);
  });

  it("accepts a real write to SwarmOnline and reflects it back on a subsequent read", async () => {
    const finalValue = await withClient(async (session) => {
      const browsePath = await session.translateBrowsePath({
        startingNode: "ns=0;i=85",
        relativePath: {
          elements: [
            { targetName: { namespaceIndex: 1, name: "HydraNode_1" } },
            { targetName: { namespaceIndex: 1, name: "SwarmOnline" } },
          ],
        },
      });
      const nodeId = browsePath.targets?.[0]?.targetId!;
      const statusCode = await session.write({
        nodeId,
        attributeId: AttributeIds.Value,
        value: { value: { dataType: DataType.Boolean, value: false } },
      });
      expect(statusCode.name).toBe("Good");
      const dataValue = await session.read({ nodeId, attributeId: AttributeIds.Value });
      return dataValue.value.value as boolean;
    });
    expect(finalValue).toBe(false);
    expect(state.swarmOnline).toBe(false);
  });
});
