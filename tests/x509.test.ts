// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/x509.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// A client that presents a certificate as its USER identity must never be
// able to write: only the administrator's user name and password can. The
// certificate is the client's own self-signed application certificate, which
// is exactly what an attacker on the network would use.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AttributeIds, DataType, MessageSecurityMode, OPCUAClient, SecurityPolicy, UserTokenType } from "node-opcua";
import type { OPCUAServer, UserIdentityInfo } from "node-opcua";
import { buildAddressSpaceServer, type HydraNodeState } from "../src/server.js";

let pkiDir: string;
let server: OPCUAServer;
let state: HydraNodeState;
let endpointUrl: string;

beforeAll(async () => {
  pkiDir = mkdtempSync(path.join(tmpdir(), "hydra-opcua-pki-"));
  // The secure channel is opened for any client here (a lab setting); the USER certificate store never auto-accepts.
  process.env.OPCUA_AUTO_ACCEPT = "1";
  process.env.OPCUA_PKI_DIR = pkiDir;
  // No administrator is configured at all: "with them unset, nobody can write".
  delete process.env.OPCUA_ADMIN_USERNAME;
  delete process.env.OPCUA_ADMIN_PASSWORD;
  const built = await buildAddressSpaceServer(0);
  server = built.server;
  state = built.state;
  endpointUrl = server.getEndpointUrl();
}, 60_000);

afterAll(async () => {
  await server?.shutdown();
  rmSync(pkiDir, { recursive: true, force: true });
});

async function writeMaintenanceMode(identityFor: (client: OPCUAClient) => Promise<UserIdentityInfo> | UserIdentityInfo): Promise<string> {
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(endpointUrl);
  try {
    const session = await client.createSession(await identityFor(client));
    try {
      const status = await session.write({
        nodeId: "ns=1;s=HydraNode_1.MaintenanceMode",
        attributeId: AttributeIds.Value,
        value: { value: { dataType: DataType.Boolean, value: true } },
      });
      return status.name;
    } finally {
      await session.close();
    }
  } finally {
    await client.disconnect();
  }
}

function certificateIdentity(client: OPCUAClient): UserIdentityInfo {
  const certificate = new X509Certificate(readFileSync(client.certificateFile));
  return {
    type: UserTokenType.Certificate,
    certificateData: certificate.raw,
    privateKey: readFileSync(client.privateKeyFile, "utf-8"),
  };
}

describe("nothing is invented", () => {
  it("serves SpindleTemp with a Bad status until a real source reports a value", async () => {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(endpointUrl);
    try {
      const session = await client.createSession({ type: UserTokenType.Anonymous });
      const dataValue = await session.read({ nodeId: "ns=1;s=HydraNode_1.SpindleTemp", attributeId: AttributeIds.Value });
      await session.close();
      expect(dataValue.statusCode.name).toBe("BadWaitingForInitialData");
      expect(dataValue.value.value).toBeNull();
    } finally {
      await client.disconnect();
    }
  });
});

describe("a user identity made of a certificate", () => {
  it("is refused while the server does not trust that user certificate", async () => {
    await expect(writeMaintenanceMode(certificateIdentity)).rejects.toThrow();
    expect(state.maintenanceMode).toBe(false);
  });

  it("cannot write even when the certificate is trusted: only the administrator's login can", async () => {
    const outcome = await writeMaintenanceMode(async (client) => {
      const identity = certificateIdentity(client);
      if (identity.type === UserTokenType.Certificate) await server.userCertificateManager.trustCertificate(identity.certificateData);
      return identity;
    }).catch((error: Error) => `rejected: ${error.message}`);
    expect(outcome).not.toBe("Good");
    expect(state.maintenanceMode).toBe(false);
  });

  it("an anonymous session cannot write either, with no administrator configured", async () => {
    const outcome = await writeMaintenanceMode(() => ({ type: UserTokenType.Anonymous }));
    expect(outcome).not.toBe("Good");
    expect(state.maintenanceMode).toBe(false);
  });
});
