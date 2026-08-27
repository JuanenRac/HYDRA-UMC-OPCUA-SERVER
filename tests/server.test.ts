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

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OPCUAClient, AttributeIds, DataType, MessageSecurityMode, SecurityPolicy } from "node-opcua";
import { buildAddressSpaceServer, type HydraNodeState } from "../src/server.js";
import type { OPCUAServer } from "node-opcua";

// Use an OS-assigned port. A fixed port made this protocol suite fail when a
// prior interrupted run (or another local OPC-UA tool) happened to own it.
// node-opcua publishes the final endpoint after start(), so tests can use the
// real assigned URL without guessing a high but still collidable port.
let server: OPCUAServer | undefined;
let state: HydraNodeState;
let endpointUrl: string;

beforeAll(async () => {
  const built = await buildAddressSpaceServer(0);
  server = built.server;
  state = built.state;
  endpointUrl = server.getEndpointUrl();
});

beforeEach(() => {
  // The protocol endpoint is intentionally shared to avoid starting the
  // heavyweight OPC-UA server once per assertion.  Each test still begins
  // from the same application state as a freshly started server.
  state.swarmOnline = true;
  state.activeRobotCount = 0;
});

afterAll(async () => {
  await server?.shutdown();
});

async function withClient<T>(fn: (session: import("node-opcua").ClientSession) => Promise<T>): Promise<T> {
  const client = OPCUAClient.create({
    endpointMustExist: false,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
  });
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
