// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/model-and-roles.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The information model (HydraCellType, HydraRobotType, the Robots folder, Live and LastUpdate) and the roles of OPC UA Part 18, against a
// real server and real clients: what a client sees of the types, which roles each kind of session has and what they may do.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, PermissionType, SecurityPolicy, StatusCodes, UserTokenType, makeRoles } from "node-opcua";
import type { ClientSession, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer, liveWindowFromEnv, readOnlyRolePermissions } from "../src/server.js";

// These tests open secure channels with throw-away client certificates: accept them (a lab setting).
process.env.OPCUA_AUTO_ACCEPT = "1";

const admin: UserIdentityInfo = { type: UserTokenType.UserName, userName: "hydra-admin", password: "admin-test-only-credential" };
const viewer: UserIdentityInfo = { type: UserTokenType.UserName, userName: "scada-viewer", password: "viewer-test-only-credential" };
const anonymous: UserIdentityInfo = { type: UserTokenType.Anonymous };

let built: Awaited<ReturnType<typeof buildAddressSpaceServer>>;
let endpoint: string;
let restore: () => void;

beforeAll(async () => {
  const keys = ["OPCUA_ADMIN_USERNAME", "OPCUA_ADMIN_PASSWORD", "OPCUA_VIEWER_USERNAME", "OPCUA_VIEWER_PASSWORD"] as const;
  const previous = keys.map((k) => process.env[k]);
  process.env.OPCUA_ADMIN_USERNAME = "hydra-admin";
  process.env.OPCUA_ADMIN_PASSWORD = "admin-test-only-credential";
  process.env.OPCUA_VIEWER_USERNAME = "scada-viewer";
  process.env.OPCUA_VIEWER_PASSWORD = "viewer-test-only-credential";
  restore = () => keys.forEach((k, i) => (previous[i] === undefined ? delete process.env[k] : (process.env[k] = previous[i])));
  built = await buildAddressSpaceServer(0);
  endpoint = built.server.getEndpointUrl();
  built.setRobots([{ id: 7, name: "Arm", online: true }], { stale: false, observedAtMs: Date.now() });
});

afterAll(async () => {
  restore?.();
  await built?.server.shutdown();
});

async function withSession<T>(identity: UserIdentityInfo, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(endpoint);
  try {
    const session = await client.createSession(identity);
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  } finally {
    await client.disconnect();
  }
}

const browseNames = async (session: ClientSession, nodeId: string): Promise<string[]> => {
  const result = await session.browse({ nodeId, resultMask: 63 });
  return (result.references ?? []).map((r) => r.browseName.name ?? "").sort();
};

describe("the information model", () => {
  it("has a type for the cell and a type for a robot, with their members", async () => {
    await withSession(anonymous, async (session) => {
      expect(await browseNames(session, "ns=1;s=HydraCellType")).toEqual(["ActiveRobotCount", "MaintenanceMode", "SpindleTemp", "SwarmOnline"]);
      expect(await browseNames(session, "ns=1;s=HydraRobotType")).toEqual(["LastUpdate", "Live", "Name", "Online"]);
    });
  });

  it("hangs the robots from a Robots folder and gives each the robot type", async () => {
    await withSession(anonymous, async (session) => {
      expect(await browseNames(session, "ns=1;s=Robots")).toContain("Robot_7");
      const root = await browseNames(session, "ns=0;i=85");
      expect(root).toContain("Robots");
      expect(root).not.toContain("Robot_7");
      const definition = await session.browse({ nodeId: "ns=1;s=Robot_7", referenceTypeId: "HasTypeDefinition", resultMask: 63 });
      expect(definition.references?.[0].browseName.name).toBe("HydraRobotType");
      const cell = await session.browse({ nodeId: "ns=1;s=HydraNode_1", referenceTypeId: "HasTypeDefinition", resultMask: 63 });
      expect(cell.references?.[0].browseName.name).toBe("HydraCellType");
    });
  });

  it("keeps the NodeIds of the variables that were there before", async () => {
    await withSession(anonymous, async (session) => {
      for (const id of ["ns=1;s=HydraNode_1.SwarmOnline", "ns=1;s=HydraNode_1.ActiveRobotCount", "ns=1;s=Robot_7.Name", "ns=1;s=Robot_7.Online"]) {
        const value = await session.read({ nodeId: id, attributeId: AttributeIds.Value });
        expect(value.statusCode).not.toBe(StatusCodes.BadNodeIdUnknown);
      }
    });
  });
});

describe("Live and LastUpdate", () => {
  it("are waiting for a first signal until a robot is seen, then say when and whether it is alive", async () => {
    await withSession(anonymous, async (session) => {
      const live = await session.read({ nodeId: "ns=1;s=Robot_7.Live", attributeId: AttributeIds.Value });
      expect(live.statusCode).toBe(StatusCodes.BadWaitingForInitialData);
      const last = await session.read({ nodeId: "ns=1;s=Robot_7.LastUpdate", attributeId: AttributeIds.Value });
      expect(last.statusCode).toBe(StatusCodes.BadWaitingForInitialData);
    });
    const seen = Date.now() - 1000;
    built.markRobotSeen(7, seen);
    await withSession(anonymous, async (session) => {
      const live = await session.read({ nodeId: "ns=1;s=Robot_7.Live", attributeId: AttributeIds.Value });
      expect(live.statusCode.isGood()).toBe(true);
      expect(live.value.value).toBe(true);
      const last = await session.read({ nodeId: "ns=1;s=Robot_7.LastUpdate", attributeId: AttributeIds.Value });
      expect((last.value.value as Date).getTime()).toBe(seen);
    });
    expect(built.liveRobotCount()).toBe(1);
  });

  it("a robot not heard from within the window is not Live, and a stale roster says so in the quality", async () => {
    built.setRobots(
      [
        { id: 7, name: "Arm", online: true },
        { id: 8, name: "Quiet", online: true },
      ],
      { stale: false, observedAtMs: Date.now() },
    );
    built.markRobotSeen(8, Date.now() - 10 * 60_000);
    await withSession(anonymous, async (session) => {
      const live = await session.read({ nodeId: "ns=1;s=Robot_8.Live", attributeId: AttributeIds.Value });
      expect(live.statusCode.isGood()).toBe(true);
      expect(live.value.value).toBe(false);
    });
    built.markRobotSeen(7, Date.now());
    built.setRobots(
      [
        { id: 7, name: "Arm", online: false },
        { id: 8, name: "Quiet", online: false },
      ],
      { stale: true },
    );
    await withSession(anonymous, async (session) => {
      const live = await session.read({ nodeId: "ns=1;s=Robot_7.Live", attributeId: AttributeIds.Value });
      expect(live.statusCode).toBe(StatusCodes.UncertainNoCommunicationLastUsableValue);
      expect(live.value.value).toBe(false);
    });
    built.setRobots([{ id: 7, name: "Arm", online: true }], { stale: false, observedAtMs: Date.now() });
  });

  it("a robot seen before it is in the tree keeps its time", async () => {
    built.markRobotSeen(99, Date.now());
    built.setRobots(
      [
        { id: 7, name: "Arm", online: true },
        { id: 99, name: "Late", online: true },
      ],
      { stale: false, observedAtMs: Date.now() },
    );
    await withSession(anonymous, async (session) => {
      const live = await session.read({ nodeId: "ns=1;s=Robot_99.Live", attributeId: AttributeIds.Value });
      expect(live.value.value).toBe(true);
    });
    built.setRobots([{ id: 7, name: "Arm", online: true }], { stale: false, observedAtMs: Date.now() });
  });

  it("the live window comes from the environment and is bounded", () => {
    expect(liveWindowFromEnv({})).toBe(30_000);
    expect(liveWindowFromEnv({ HYDRA_UMC_OPCUA_LIVE_WINDOW_MS: "5000" })).toBe(5000);
    expect(() => liveWindowFromEnv({ HYDRA_UMC_OPCUA_LIVE_WINDOW_MS: "10" })).toThrow(/at least 1000/);
    expect(() => liveWindowFromEnv({ HYDRA_UMC_OPCUA_LIVE_WINDOW_MS: "abc" })).toThrow(/at least 1000/);
  });
});

describe("roles (OPC UA Part 18)", () => {
  const rolesOf = async (identity: UserIdentityInfo): Promise<string[]> =>
    withSession(identity, async (session) => {
      // the roles the session holds are the ones the role permissions of a node grant it: read what the server says this session may do
      const result = await session.read({ nodeId: "ns=1;s=HydraNode_1.SwarmOnline", attributeId: AttributeIds.UserRolePermissions });
      const granted = (result.value.value as Array<{ roleId: { toString(): string }; permissions: number }> | null) ?? [];
      return granted.map((r) => r.roleId.toString()).sort();
    });

  const id = (name: string) => makeRoles(name)[0].toString();

  it("an anonymous session holds only the Anonymous role", async () => {
    expect(await rolesOf(anonymous)).toEqual([id("Anonymous")]);
  });

  it("the viewer is an authenticated user and an observer", async () => {
    expect(await rolesOf(viewer)).toEqual([id("AuthenticatedUser"), id("Observer")].sort());
  });

  it("the administrator is also the configuration administrator", async () => {
    expect(await rolesOf(admin)).toEqual([id("AuthenticatedUser"), id("Observer"), id("ConfigureAdmin")].sort());
  });

  it("no role has the permission to write, and every role can browse and read", () => {
    for (const allowAnonymous of [true, false]) {
      const permissions = readOnlyRolePermissions(allowAnonymous);
      for (const entry of permissions) {
        expect(entry.permissions & PermissionType.Write).toBe(0);
        expect(entry.permissions & PermissionType.WriteAttribute).toBe(0);
        expect(entry.permissions & PermissionType.Browse).not.toBe(0);
        expect(entry.permissions & PermissionType.Read).not.toBe(0);
      }
      expect(permissions.some((p) => p.roleId.toString() === id("Anonymous"))).toBe(allowAnonymous);
    }
  });
});
