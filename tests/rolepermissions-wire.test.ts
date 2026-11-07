// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/rolepermissions-wire.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The RolePermissions (OPC UA Part 18) as a real client reads them off the wire: the attribute of several kinds of node, for each kind of
// session, with anonymous sessions allowed and refused. Nothing here grants a write: no role may write, whoever the session is.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, PermissionType, SecurityPolicy, StatusCodes, UserTokenType, makeRoles } from "node-opcua";
import type { ClientSession, OPCUAServer, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer, readOnlyRolePermissions } from "../src/server.js";

// These tests open secure channels with throw-away client certificates: accept them (a lab setting).
process.env.OPCUA_AUTO_ACCEPT = "1";

const admin: UserIdentityInfo = { type: UserTokenType.UserName, userName: "hydra-admin", password: "admin-test-only-credential" };
const viewer: UserIdentityInfo = { type: UserTokenType.UserName, userName: "scada-viewer", password: "viewer-test-only-credential" };
const anonymous: UserIdentityInfo = { type: UserTokenType.Anonymous };

type Permission = { roleId: { toString(): string }; permissions: number };

const WRITE_BITS =
  PermissionType.WriteAttribute |
  PermissionType.WriteRolePermissions |
  PermissionType.WriteHistorizing |
  PermissionType.Write |
  PermissionType.InsertHistory |
  PermissionType.ModifyHistory |
  PermissionType.DeleteHistory |
  PermissionType.Call |
  PermissionType.AddReference |
  PermissionType.RemoveReference |
  PermissionType.DeleteNode |
  PermissionType.AddNode;

const NODES = ["ns=1;s=HydraNode_1.SwarmOnline", "ns=1;s=HydraNode_1.MaintenanceMode", "ns=1;s=Robots"];

function setEnv(values: Record<string, string | undefined>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

async function withSession<T>(endpoint: string, identity: UserIdentityInfo, fn: (session: ClientSession) => Promise<T>): Promise<T> {
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

async function attribute(session: ClientSession, nodeId: string, attributeId: AttributeIds): Promise<Permission[]> {
  const result = await session.read({ nodeId, attributeId });
  expect(result.statusCode).toBe(StatusCodes.Good);
  return ((result.value.value as Permission[] | null) ?? []).map((entry) => ({ roleId: entry.roleId, permissions: entry.permissions }));
}

const roleName = (name: string) => makeRoles(name)[0].toString();
const asMap = (entries: Permission[]) => new Map(entries.map((entry) => [entry.roleId.toString(), entry.permissions]));

describe("RolePermissions read over the wire, anonymous sessions allowed", () => {
  let server: OPCUAServer;
  let endpoint: string;
  beforeAll(async () => {
    const restore = setEnv({
      OPCUA_ADMIN_USERNAME: "hydra-admin",
      OPCUA_ADMIN_PASSWORD: "admin-test-only-credential",
      OPCUA_VIEWER_USERNAME: "scada-viewer",
      OPCUA_VIEWER_PASSWORD: "viewer-test-only-credential",
      OPCUA_ALLOW_ANONYMOUS: undefined,
    });
    try {
      server = (await buildAddressSpaceServer(0)).server;
      endpoint = server.getEndpointUrl();
    } finally {
      restore();
    }
  });
  afterAll(async () => {
    await server?.shutdown();
  });

  it("every node lists the same four roles and the permissions the server declares", async () => {
    const expected = asMap(readOnlyRolePermissions(true));
    await withSession(endpoint, admin, async (session) => {
      for (const nodeId of NODES) {
        const listed = asMap(await attribute(session, nodeId, AttributeIds.RolePermissions));
        expect(listed.size, nodeId).toBe(4);
        for (const [role, permissions] of expected) expect(listed.get(role), `${nodeId} ${role}`).toBe(permissions);
      }
    });
  });

  it("no role of any node can write, call, add or delete", async () => {
    await withSession(endpoint, viewer, async (session) => {
      for (const nodeId of NODES) {
        for (const entry of await attribute(session, nodeId, AttributeIds.RolePermissions)) {
          expect(entry.permissions & WRITE_BITS, `${nodeId} ${entry.roleId.toString()}`).toBe(0);
          expect(entry.permissions & PermissionType.Browse).not.toBe(0);
          expect(entry.permissions & PermissionType.Read).not.toBe(0);
        }
      }
    });
  });

  it("the roles of a session are a part of the roles of the node, and differ from one kind of session to another", async () => {
    const all = new Set(readOnlyRolePermissions(true).map((entry) => entry.roleId.toString()));
    const seen: Record<string, string[]> = {};
    for (const [label, identity] of [["anonymous", anonymous], ["viewer", viewer], ["admin", admin]] as const) {
      const roles = await withSession(endpoint, identity, async (session) => (await attribute(session, NODES[0], AttributeIds.UserRolePermissions)).map((e) => e.roleId.toString()).sort());
      for (const role of roles) expect(all.has(role), `${label} ${role}`).toBe(true);
      seen[label] = roles;
    }
    expect(seen.anonymous).toEqual([roleName("Anonymous")]);
    expect(seen.viewer.length).toBe(2);
    expect(seen.admin.length).toBe(3);
    expect(seen.admin).toEqual(expect.arrayContaining(seen.viewer));
  });

  it("the permissions a session holds are never more than the ones of the node", async () => {
    for (const identity of [anonymous, viewer, admin]) {
      await withSession(endpoint, identity, async (session) => {
        const node = asMap(await attribute(session, NODES[1], AttributeIds.RolePermissions));
        for (const entry of await attribute(session, NODES[1], AttributeIds.UserRolePermissions)) {
          const declared = node.get(entry.roleId.toString()) ?? 0;
          expect(entry.permissions & ~declared).toBe(0);
        }
      });
    }
  });
});

describe("RolePermissions read over the wire, anonymous sessions refused", () => {
  let server: OPCUAServer;
  let endpoint: string;
  beforeAll(async () => {
    const restore = setEnv({
      OPCUA_ADMIN_USERNAME: "hydra-admin",
      OPCUA_ADMIN_PASSWORD: "admin-test-only-credential",
      OPCUA_VIEWER_USERNAME: "scada-viewer",
      OPCUA_VIEWER_PASSWORD: "viewer-test-only-credential",
      OPCUA_ALLOW_ANONYMOUS: "0",
    });
    try {
      server = (await buildAddressSpaceServer(0)).server;
      endpoint = server.getEndpointUrl();
    } finally {
      restore();
    }
  });
  afterAll(async () => {
    await server?.shutdown();
  });

  it("the Anonymous role disappears from the roles of every node", async () => {
    await withSession(endpoint, viewer, async (session) => {
      for (const nodeId of NODES) {
        const listed = asMap(await attribute(session, nodeId, AttributeIds.RolePermissions));
        expect(listed.size, nodeId).toBe(3);
        expect(listed.has(roleName("Anonymous")), nodeId).toBe(false);
      }
    });
  });

  it("an anonymous session cannot even open", async () => {
    await expect(withSession(endpoint, anonymous, async (session) => attribute(session, NODES[0], AttributeIds.RolePermissions))).rejects.toBeTruthy();
  });
});
