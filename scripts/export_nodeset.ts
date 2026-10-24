// =============================================================================
// HYDRA-UMC OPCUA SERVER - scripts/export_nodeset.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Writes (or, with --check, compares) nodeset/HydraUmc.NodeSet2.xml: the information model of the namespace as a NodeSet2 file, so a
// client or a tool that wants the types in advance can load them without connecting. `npm run nodeset` writes it, `npm run nodeset -- --check`
// fails when the file in the repository is not what the code builds.
// =============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildAddressSpaceServer } from "../src/server.ts";

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "nodeset", "HydraUmc.NodeSet2.xml");
const built = await buildAddressSpaceServer(0);
const xml = built.server.engine.addressSpace!.getOwnNamespace().toNodeset2XML().replace(/\r\n/g, "\n");
await built.server.shutdown();
if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf-8").replace(/\r\n/g, "\n");
  if (current !== xml) {
    console.error("nodeset/HydraUmc.NodeSet2.xml is not what the address space builds: run `npm run nodeset`");
    process.exit(1);
  }
  console.log("NODESET=PASS");
} else {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, xml, "utf-8");
  console.log(`wrote ${target}`);
}
process.exit(0);
