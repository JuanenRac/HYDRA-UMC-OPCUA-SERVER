// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/robotSource.integration.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// End to end: a real HTTP server plays HYDRA-UMC-SERVER (bearer-protected
// GET /api/settings), the poller reads it with the real fetch, and a real
// OPC-UA client reads the resulting robot objects over the protocol.
// =============================================================================
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { startRobotPolling } from "../src/robotSource.js";

const TOKEN = "integration-token";
let roster: unknown = { controllers: [{ robots: [{ id: 7, name: "Arm", online: true }] }] };
let upstream: http.Server;
let upstreamUrl: string;
let built: Awaited<ReturnType<typeof buildAddressSpaceServer>>;
let stop: () => void;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(roster));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  built = await buildAddressSpaceServer(0);
  stop = startRobotPolling({ url: upstreamUrl, token: TOKEN, intervalMs: 1000, setRobots: built.setRobots });
});

afterAll(async () => {
  stop?.();
  await built?.server.shutdown();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function readValue(nodeId: string): Promise<{ good: boolean; value: unknown }> {
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(built.server.getEndpointUrl());
  const session = await client.createSession();
  try {
    const result = await session.read({ nodeId, attributeId: AttributeIds.Value });
    return { good: result.statusCode.isGood(), value: result.value.value };
  } finally {
    await session.close();
    await client.disconnect();
  }
}

const until = async (check: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

describe("robot roster from a real HTTP source to a real OPC-UA client", () => {
  it("shows the robot the source lists, and drops it when the source stops listing it", async () => {
    expect(await until(async () => (await readValue("ns=1;s=Robot_7.Online")).good)).toBe(true);
    expect((await readValue("ns=1;s=Robot_7.Name")).value).toBe("Arm");
    expect(built.state.activeRobotCount).toBe(1);

    roster = { controllers: [{ robots: [{ id: 8, name: "Mill", online: false }] }] };
    expect(await until(async () => !(await readValue("ns=1;s=Robot_7.Online")).good)).toBe(true);
    expect((await readValue("ns=1;s=Robot_8.Online")).value).toBe(false);
    expect(built.state.activeRobotCount).toBe(0);
  }, 30000);
});
