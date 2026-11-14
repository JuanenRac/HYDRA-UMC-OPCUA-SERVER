// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/container-identity.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// What a container needs so that a recreated container is the same server for the clients that trust it: the certificate stores sit on a volume
// (OPCUA_PKI_DIR), the process owns them without being root, and a second start on the same directory presents the same certificate. The container
// itself is simulated: a start is a build of the server on the same directory, a recreation is a second build after the first one was shut down.
// =============================================================================

import { afterAll, describe, expect, it } from "vitest";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAddressSpaceServer } from "../src/server.js";

const directories: string[] = [];

function freshPkiDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "hydra-opcua-identity-"));
  directories.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of directories) rmSync(dir, { recursive: true, force: true });
});

/** Every file under `root` whose path says it is a certificate of the server itself. */
function ownCertificates(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/[\\/]own[\\/]certs[\\/][^\\/]+\.(pem|der)$/.test(full)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

function certificateOf(file: string): X509Certificate {
  return new X509Certificate(readFileSync(file));
}

async function startAndStop(pkiDir: string, alternateHostname?: string): Promise<void> {
  process.env.OPCUA_AUTO_ACCEPT = "1";
  process.env.OPCUA_PKI_DIR = pkiDir;
  delete process.env.OPCUA_ADMIN_USERNAME;
  delete process.env.OPCUA_ADMIN_PASSWORD;
  if (alternateHostname) process.env.OPCUA_ALTERNATE_HOSTNAME = alternateHostname;
  else delete process.env.OPCUA_ALTERNATE_HOSTNAME;
  const built = await buildAddressSpaceServer(0);
  try {
    expect(built.server.getEndpointUrl()).toMatch(/^opc\.tcp:\/\//);
  } finally {
    await built.server.shutdown();
    delete process.env.OPCUA_ALTERNATE_HOSTNAME;
  }
}

describe("the image", () => {
  const dockerfile = readFileSync(path.join(__dirname, "..", "Dockerfile"), "utf8");

  it("keeps the certificate stores on a directory that exists, belongs to the unprivileged user and is the one the server reads", () => {
    expect(dockerfile).toMatch(/^ENV OPCUA_PKI_DIR=\/data\/pki$/m);
    expect(dockerfile).toMatch(/mkdir -p \/data\/pki/);
    expect(dockerfile).toMatch(/chown -R node:node \/data/);
  });

  it("runs as the unprivileged user after the directory is prepared", () => {
    const prepare = dockerfile.indexOf("chown -R node:node /data");
    const user = dockerfile.search(/^USER node$/m);
    expect(user).toBeGreaterThan(prepare);
    expect(dockerfile).not.toMatch(/^USER root$/m);
  });
});

describe("a recreated container", () => {
  it("presents the same server certificate when it starts again on the same directory", async () => {
    const dir = freshPkiDir();
    await startAndStop(dir);
    const first = ownCertificates(dir);
    expect(first.length).toBeGreaterThan(0);
    const before = first.map((file) => readFileSync(file).toString("base64"));
    await startAndStop(dir);
    const after = ownCertificates(dir).map((file) => readFileSync(file).toString("base64"));
    expect(after).toEqual(before);
    expect(certificateOf(first[0]).subjectAltName).toMatch(/URI:/);
  }, 120_000);

  it("is a different server on an empty directory, as a container without the volume would be", async () => {
    const one = freshPkiDir();
    const two = freshPkiDir();
    await startAndStop(one);
    await startAndStop(two);
    const a = readFileSync(ownCertificates(one)[0]).toString("base64");
    const b = readFileSync(ownCertificates(two)[0]).toString("base64");
    expect(a).not.toEqual(b);
  }, 120_000);
});

describe("the name the clients resolve", () => {
  it("is in the certificate when OPCUA_ALTERNATE_HOSTNAME is set", async () => {
    const dir = freshPkiDir();
    await startAndStop(dir, "opcua.plant.example");
    const certificate = certificateOf(ownCertificates(dir)[0]);
    expect(certificate.subjectAltName).toContain("opcua.plant.example");
  }, 120_000);
});
