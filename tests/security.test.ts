// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/security.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Real protocol-level tests of this pass's vital improvement: a real
// versioned namespace URI, real stable NodeIds, real quality/units/UTC on
// SpindleTemp, and real per-session read/write authorization on
// MaintenanceMode - a real OPCUAClient (anonymous and authenticated)
// against a real OPCUAServer, the review's own "cliente OPC-UA
// local que lee valores, intenta write no autorizado y verifica
// namespace/quality/UTC y respuesta de seguridad".
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, DataType, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType } from "node-opcua";
import type { ClientSession, OPCUAServer, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer, type HydraNodeState } from "../src/server.js";

const ADMIN_USERNAME = "hydra-admin";
const ADMIN_PASSWORD = "real-test-only-credential";

// Must be set before buildAddressSpaceServer() runs below - main()/the
// real deployment reads these same two env vars (see server.ts).
process.env.OPCUA_ADMIN_USERNAME = ADMIN_USERNAME;
process.env.OPCUA_ADMIN_PASSWORD = ADMIN_PASSWORD;

let server: OPCUAServer | undefined;
let state: HydraNodeState;
let endpointUrl: string;

beforeAll(async () => {
  const built = await buildAddressSpaceServer(0);
  server = built.server;
  state = built.state;
  endpointUrl = server.getEndpointUrl();
});

afterAll(async () => {
  await server?.shutdown();
});

async function withSession<T>(userIdentity: UserIdentityInfo, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  // Real, encrypted session - proving the fix (server.ts no longer
  // exposes SecurityPolicy.None at all) actually works end to end, not
  // just that the server starts, and that at least one real test opens a
  // genuine Signed or SignAndEncrypt session rather than only asserting
  // on the encryption gate itself.
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(endpointUrl);
  try {
    const session = await client.createSession(userIdentity);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  } finally {
    await client.disconnect();
  }
}

async function resolveNodeId(session: ClientSession, browseNames: string[]) {
  const browsePath = await session.translateBrowsePath({
    startingNode: "ns=0;i=85", // Objects folder
    relativePath: { elements: browseNames.map((name) => ({ targetName: { namespaceIndex: 1, name } })) },
  });
  return browsePath.targets?.[0]?.targetId;
}

const anonymous: UserIdentityInfo = { type: UserTokenType.Anonymous };
const admin: UserIdentityInfo = { type: UserTokenType.UserName, userName: ADMIN_USERNAME, password: ADMIN_PASSWORD };

describe("real, versioned namespace URI", () => {
  it("registers this project's own explicit namespace URI in the real Server_NamespaceArray", async () => {
    const uris = await withSession(anonymous, async (session) => {
      const dataValue = await session.read({ nodeId: "ns=0;i=2255", attributeId: AttributeIds.Value }); // Server_NamespaceArray
      return dataValue.value.value as string[];
    });
    expect(uris).toContain("urn:hydra-umc:opcua-server:v1");
  });
});

describe("real, stable NodeIds", () => {
  it("SwarmOnline resolves to its own explicit string NodeId, not an auto-assigned numeric one", async () => {
    const nodeIdString = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SwarmOnline"]);
      return nodeId?.toString();
    });
    expect(nodeIdString).toBe("ns=1;s=HydraNode_1.SwarmOnline");
  });

  it("SpindleTemp resolves to its own explicit string NodeId", async () => {
    const nodeIdString = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SpindleTemp"]);
      return nodeId?.toString();
    });
    expect(nodeIdString).toBe("ns=1;s=HydraNode_1.SpindleTemp");
  });
});

describe("real quality/units/UTC timestamp on SpindleTemp", () => {
  it("reads GOOD quality and a real UTC sourceTimestamp reflecting the actual last mutation", async () => {
    state.spindleTempC = 65.5;
    state.spindleTempUpdatedAtMs = Date.UTC(2025, 0, 1, 0, 0, 0);

    const dataValue = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SpindleTemp"]);
      return session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
    });

    expect(dataValue.statusCode.name).toBe("Good");
    expect(dataValue.value.value).toBeCloseTo(65.5, 6);
    // A real, hand-checkable UTC instant - always Z-suffixed regardless of
    // the machine running this test's own local timezone.
    expect(dataValue.sourceTimestamp?.toISOString()).toBe("2025-01-01T00:00:00.000Z");
  });

  it("I42: after the real source disconnects, reads the frozen value with degraded quality, never a fresh Good", async () => {
    // The exact acceptance test I42 itself describes: "cliente real
    // loopback lee un valor congelado tras desconexion - no recibe valor
    // fresco Good". A correct, encrypted, admin-authenticated session
    // (see `withSession`/`admin` in this file) must not change this
    // outcome either - a valid certificate/credential authenticates the
    // CLIENT, it never revalidates a stale operational precondition.
    const frozenAtMs = Date.UTC(2025, 5, 1, 12, 0, 0);
    state.spindleTempC = 47.25;
    state.spindleTempUpdatedAtMs = frozenAtMs;
    state.spindleTempConnected = false;

    const dataValue = await withSession(admin, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SpindleTemp"]);
      return session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
    });

    expect(dataValue.statusCode.name).not.toBe("Good");
    expect(dataValue.statusCode.name).toBe("UncertainLastUsableValue");
    // The last real value is still served, not withheld or zeroed out.
    expect(dataValue.value.value).toBeCloseTo(47.25, 6);
    // sourceTimestamp keeps pointing at the real last-observed instant,
    // not "now" - a client can compute exactly how stale this is.
    expect(dataValue.sourceTimestamp?.toISOString()).toBe(new Date(frozenAtMs).toISOString());

    // Restore real connected state so this test never leaks into any
    // test that runs after it in this same shared server instance.
    state.spindleTempConnected = true;
  });

  it("I42: reconnecting the real source is reflected in a fresh Good read again", async () => {
    state.spindleTempC = 22;
    state.spindleTempUpdatedAtMs = Date.now();
    state.spindleTempConnected = true;

    const dataValue = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SpindleTemp"]);
      return session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
    });

    expect(dataValue.statusCode.name).toBe("Good");
  });

  it("declares a real EngineeringUnits child carrying the real degree-Celsius unit", async () => {
    const displayName = await withSession(anonymous, async (session) => {
      // EngineeringUnits is a standard AnalogItemType property from the
      // base UA namespace (0), not this project's own namespace (1) -
      // unlike SpindleTemp itself.
      const spindleTempNodeId = await resolveNodeId(session, ["HydraNode_1", "SpindleTemp"]);
      const browsePath = await session.translateBrowsePath({
        startingNode: spindleTempNodeId!,
        relativePath: { elements: [{ targetName: { namespaceIndex: 0, name: "EngineeringUnits" } }] },
      });
      const nodeId = browsePath.targets?.[0]?.targetId;
      expect(nodeId).toBeDefined();
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value?.displayName?.text as string;
    });
    expect(displayName).toBe("°C");
  });
});

describe("real read/write authorization on MaintenanceMode", () => {
  it("an anonymous client can read it (default false)", async () => {
    const value = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "MaintenanceMode"]);
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value as boolean;
    });
    expect(value).toBe(false);
  });

  it("an anonymous client's write is denied - a real security response, not a silent no-op", async () => {
    const statusCodeName = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "MaintenanceMode"]);
      const statusCode = await session.write({ nodeId: nodeId!, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, value: true } } });
      return statusCode.name;
    });
    expect(statusCodeName).not.toBe("Good");
    expect(state.maintenanceMode).toBe(false);
  });

  it("an authenticated (correct credentials) client's write succeeds and is reflected in state", async () => {
    const finalValue = await withSession(admin, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "MaintenanceMode"]);
      const statusCode = await session.write({ nodeId: nodeId!, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, value: true } } });
      expect(statusCode.name).toBe("Good");
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value as boolean;
    });
    expect(finalValue).toBe(true);
    expect(state.maintenanceMode).toBe(true);
  });

  it("a client presenting the wrong password is rejected, not silently treated as anonymous", async () => {
    const wrongCredentials: UserIdentityInfo = { type: UserTokenType.UserName, userName: ADMIN_USERNAME, password: "not-the-real-password" };
    await expect(withSession(wrongCredentials, async () => {})).rejects.toThrow();
  });
});

// Real gap closed while auditing the code: SwarmOnline used to accept a
// write from ANY anonymous client - the one real per-session
// isUserWritable check above (MaintenanceMode) never covered it. Same
// three-way coverage as MaintenanceMode's own suite: anonymous denied,
// authenticated accepted, and state genuinely unchanged by the denied
// attempt (not a silent no-op that still reports success).
describe("real read/write authorization on SwarmOnline", () => {
  it("an anonymous client's write is denied and state stays unchanged", async () => {
    const statusCodeName = await withSession(anonymous, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SwarmOnline"]);
      const statusCode = await session.write({ nodeId: nodeId!, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, value: false } } });
      return statusCode.name;
    });
    expect(statusCodeName).not.toBe("Good");
    expect(state.swarmOnline).toBe(true);
  });

  it("an authenticated (correct credentials) client's write succeeds and is reflected in state", async () => {
    const finalValue = await withSession(admin, async (session) => {
      const nodeId = await resolveNodeId(session, ["HydraNode_1", "SwarmOnline"]);
      const statusCode = await session.write({ nodeId: nodeId!, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, value: false } } });
      expect(statusCode.name).toBe("Good");
      const dataValue = await session.read({ nodeId: nodeId!, attributeId: AttributeIds.Value });
      return dataValue.value.value as boolean;
    });
    expect(finalValue).toBe(false);
    expect(state.swarmOnline).toBe(false);
    state.swarmOnline = true; // restore for any test ordering after this one
  });
});
