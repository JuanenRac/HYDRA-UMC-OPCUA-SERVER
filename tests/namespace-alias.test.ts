// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/namespace-alias.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The nodes live in the namespace of their own (index 2); a request for the old ns=1 identifier is answered with the node of the same name
// while the alias is on, and the alias can be switched off or given an end by the configuration.
// =============================================================================
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { AttributeIds, MessageSecurityMode, NodeId, NodeIdType, OPCUAClient, SecurityPolicy, UserTokenType } from "node-opcua";
import type { ClientSession } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { installLegacyNamespaceAlias, legacyAliasFromEnv, rewriteLegacyNodeIds } from "../src/legacyAlias.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

describe("the configuration of the alias", () => {
  it("is on by default, off with 0, and takes an optional end date", () => {
    expect(legacyAliasFromEnv({})).toEqual({ enabled: true });
    expect(legacyAliasFromEnv({ OPCUA_LEGACY_NS_ALIAS: "0" })).toEqual({ enabled: false });
    expect(legacyAliasFromEnv({ OPCUA_LEGACY_NS_ALIAS: "1", OPCUA_LEGACY_NS_ALIAS_UNTIL: "" })).toEqual({ enabled: true });
    const dated = legacyAliasFromEnv({ OPCUA_LEGACY_NS_ALIAS_UNTIL: "2030-01-31" });
    expect(dated.untilMs).toBe(Date.parse("2030-02-01T00:00:00Z"));
  });

  it("refuses an end date that is not a date", () => {
    expect(() => legacyAliasFromEnv({ OPCUA_LEGACY_NS_ALIAS_UNTIL: "next week" })).toThrow(/YYYY-MM-DD/);
    expect(() => legacyAliasFromEnv({ OPCUA_LEGACY_NS_ALIAS_UNTIL: "2030-13-45" })).toThrow(/real date/);
  });
});

describe("the rewriting of a request", () => {
  const request = () => ({
    nodesToRead: [{ nodeId: new NodeId(NodeIdType.STRING, "Robots", 1), attributeId: 13 }, { nodeId: new NodeId(NodeIdType.STRING, "Robots", 2), attributeId: 13 }],
    nodeToBrowse: { nodeId: new NodeId(NodeIdType.NUMERIC, 85, 1) },
    startingNode: new NodeId(NodeIdType.STRING, "Other", 3),
    bytes: new Uint8Array(4),
  });

  it("turns ns=1 string identifiers into the namespace of the server and leaves every other identifier alone", () => {
    const r = request();
    expect(rewriteLegacyNodeIds(r, 2)).toBe(1);
    expect(r.nodesToRead[0].nodeId.toString()).toBe("ns=2;s=Robots");
    expect(r.nodesToRead[1].nodeId.toString()).toBe("ns=2;s=Robots");
    expect(r.nodeToBrowse.nodeId.toString()).toBe("ns=1;i=85");
    expect(r.startingNode.toString()).toBe("ns=3;s=Other");
  });

  it("reaches the request through the event of the server only while the alias is on", () => {
    const on = new EventEmitter();
    installLegacyNamespaceAlias(on, 2, { enabled: true });
    const a = request();
    on.emit("request", a);
    expect(a.nodesToRead[0].nodeId.toString()).toBe("ns=2;s=Robots");
    const off = new EventEmitter();
    installLegacyNamespaceAlias(off, 2, { enabled: false });
    const b = request();
    off.emit("request", b);
    expect(b.nodesToRead[0].nodeId.toString()).toBe("ns=1;s=Robots");
  });

  it("stops at the end date and can be taken off", () => {
    const emitter = new EventEmitter();
    let now = Date.parse("2030-01-01T00:00:00Z");
    const remove = installLegacyNamespaceAlias(emitter, 2, { enabled: true, untilMs: Date.parse("2030-02-01T00:00:00Z") }, () => now);
    const first = request();
    emitter.emit("request", first);
    expect(first.nodesToRead[0].nodeId.toString()).toBe("ns=2;s=Robots");
    now = Date.parse("2030-02-01T00:00:00Z");
    const late = request();
    emitter.emit("request", late);
    expect(late.nodesToRead[0].nodeId.toString()).toBe("ns=1;s=Robots");
    now = Date.parse("2030-01-02T00:00:00Z");
    remove();
    const removed = request();
    emitter.emit("request", removed);
    expect(removed.nodesToRead[0].nodeId.toString()).toBe("ns=1;s=Robots");
  });
});

async function withSession<T>(endpoint: string, fn: (session: ClientSession) => Promise<T>): Promise<T> {
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(endpoint);
  try {
    const session = await client.createSession({ type: UserTokenType.Anonymous });
    try {
      return await fn(session);
    } finally {
      await session.close();
    }
  } finally {
    await client.disconnect();
  }
}

describe("a real server", () => {
  let withAlias: Awaited<ReturnType<typeof buildAddressSpaceServer>>;
  let withoutAlias: Awaited<ReturnType<typeof buildAddressSpaceServer>>;

  beforeAll(async () => {
    withAlias = await buildAddressSpaceServer(0, { legacyNamespaceAlias: { enabled: true } });
    withoutAlias = await buildAddressSpaceServer(0, { legacyNamespaceAlias: { enabled: false } });
  });
  afterAll(async () => {
    await withAlias?.server.shutdown();
    await withoutAlias?.server.shutdown();
  });

  it("puts its nodes in namespace 2 and keeps index 1 for the local namespace", async () => {
    await withSession(withAlias.server.getEndpointUrl(), async (session) => {
      const array = await session.read({ nodeId: "i=2255", attributeId: AttributeIds.Value });
      const uris = array.value.value as string[];
      expect(uris[2]).toBe("urn:hydra-umc:opcua-server:v1");
      expect(uris[1]).not.toBe("urn:hydra-umc:opcua-server:v1");
      const node = await session.read({ nodeId: "ns=2;s=HydraNode_1.MaintenanceMode", attributeId: AttributeIds.Value });
      expect(node.statusCode.name).toBe("Good");
    });
  });

  it("answers the old ns=1 identifier with the node of the same name while the alias is on", async () => {
    await withSession(withAlias.server.getEndpointUrl(), async (session) => {
      const old = await session.read({ nodeId: "ns=1;s=HydraNode_1.MaintenanceMode", attributeId: AttributeIds.Value });
      expect(old.statusCode.name).toBe("Good");
      const browsed = await session.browse({ nodeId: "ns=1;s=Robots", resultMask: 63 });
      expect(browsed.statusCode.name).toBe("Good");
    });
  });

  it("refuses the old identifier when the alias is off, and still serves ns=2", async () => {
    await withSession(withoutAlias.server.getEndpointUrl(), async (session) => {
      const old = await session.read({ nodeId: "ns=1;s=HydraNode_1.MaintenanceMode", attributeId: AttributeIds.Value });
      expect(old.statusCode.name).toBe("BadNodeIdUnknown");
      const current = await session.read({ nodeId: "ns=2;s=HydraNode_1.MaintenanceMode", attributeId: AttributeIds.Value });
      expect(current.statusCode.name).toBe("Good");
    });
  });
});
