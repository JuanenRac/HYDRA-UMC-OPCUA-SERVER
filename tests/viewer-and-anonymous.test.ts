// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/viewer-and-anonymous.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The optional read-only account (OPCUA_VIEWER_*) and OPCUA_ALLOW_ANONYMOUS=0, against a real
// server and real clients: who can log in, who can read, who can write.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, DataType, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType } from "node-opcua";
import type { ClientSession, OPCUAServer, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";

// These tests open secure channels with throw-away client certificates: accept them (a lab setting).
process.env.OPCUA_AUTO_ACCEPT = "1";

const admin: UserIdentityInfo = { type: UserTokenType.UserName, userName: "hydra-admin", password: "admin-test-only-credential" };
const viewer: UserIdentityInfo = { type: UserTokenType.UserName, userName: "scada-viewer", password: "viewer-test-only-credential" };
const anonymous: UserIdentityInfo = { type: UserTokenType.Anonymous };

const MAINTENANCE = "ns=1;s=HydraNode_1.MaintenanceMode";

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

const write = (session: ClientSession) =>
  session.write({ nodeId: MAINTENANCE, attributeId: AttributeIds.Value, value: { value: { dataType: DataType.Boolean, value: true } } });
const read = (session: ClientSession) => session.read({ nodeId: MAINTENANCE, attributeId: AttributeIds.Value });

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

describe("a viewer account next to the administrator, anonymous still allowed", () => {
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

  it("the viewer logs in and reads", async () => {
    const value = await withSession(endpoint, viewer, async (session) => (await read(session)).value.value);
    expect(value).toBe(false);
  });

  it("the viewer's write is denied, and so is the administrator's: the variable is read-only", async () => {
    const viewerStatus = await withSession(endpoint, viewer, write);
    expect(viewerStatus.isGood()).toBe(false);
    const adminStatus = await withSession(endpoint, admin, write);
    expect(adminStatus.isGood()).toBe(false);
  });

  it("a wrong viewer password is refused", async () => {
    await expect(withSession(endpoint, { ...viewer, password: "not-the-password" } as UserIdentityInfo, read)).rejects.toBeTruthy();
  });

  it("anonymous can still read, as before", async () => {
    const value = await withSession(endpoint, anonymous, async (session) => (await read(session)).value.value);
    expect(typeof value).toBe("boolean");
  });
});

describe("OPCUA_ALLOW_ANONYMOUS=0", () => {
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

  it("refuses an anonymous session", async () => {
    await expect(withSession(endpoint, anonymous, read)).rejects.toBeTruthy();
  });

  it("lets the viewer and the administrator read, and neither write", async () => {
    expect(await withSession(endpoint, viewer, async (session) => (await read(session)).statusCode.isGood())).toBe(true);
    expect((await withSession(endpoint, admin, write)).isGood()).toBe(false);
  });
});

describe("the viewer name", () => {
  it("must differ from the administrator's: a session is the administrator's by name", async () => {
    const restore = setEnv({ OPCUA_ADMIN_USERNAME: "same", OPCUA_ADMIN_PASSWORD: "a", OPCUA_VIEWER_USERNAME: "same", OPCUA_VIEWER_PASSWORD: "b" });
    try {
      await expect(buildAddressSpaceServer(0)).rejects.toThrow(/must differ/);
    } finally {
      restore();
    }
  });
});
