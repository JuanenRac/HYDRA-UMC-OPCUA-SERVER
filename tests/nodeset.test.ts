// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/nodeset.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// nodeset/HydraUmc.NodeSet2.xml is the information model as a file. It must be exactly what the code builds, so a change of the model that
// forgets to regenerate it (npm run nodeset) fails here.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAddressSpaceServer } from "../src/server.js";

let built: Awaited<ReturnType<typeof buildAddressSpaceServer>>;
beforeAll(async () => {
  built = await buildAddressSpaceServer(0);
});
afterAll(async () => {
  await built?.server.shutdown();
});

describe("nodeset/HydraUmc.NodeSet2.xml", () => {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "nodeset", "HydraUmc.NodeSet2.xml");

  it("is what the address space builds", () => {
    const built_xml = built.server.engine.addressSpace!.getOwnNamespace().toNodeset2XML().replace(/\r\n/g, "\n");
    expect(readFileSync(file, "utf-8").replace(/\r\n/g, "\n")).toBe(built_xml);
  });

  it("declares the two types and their members", () => {
    const xml = readFileSync(file, "utf-8");
    for (const name of ["HydraCellType", "HydraRobotType"]) expect(xml).toContain(`BrowseName="1:${name}"`);
    for (const member of ["SwarmOnline", "ActiveRobotCount", "SpindleTemp", "MaintenanceMode", "Name", "Online", "Live", "LastUpdate"]) {
      expect(xml).toContain(`BrowseName="1:${member}"`);
    }
  });

  it("holds no writable member of a type", () => {
    const xml = readFileSync(file, "utf-8");
    const members = xml.split("<UAVariable ").filter((chunk) => /NodeId="ns=1;s=Hydra(Cell|Robot)Type\./.test(chunk));
    expect(members.length).toBe(8);
    for (const member of members) expect(member).not.toMatch(/AccessLevel="/); // the default of a NodeSet2 variable is CurrentRead
  });
});
