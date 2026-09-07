// =============================================================================
// HYDRA-UMC OPCUA SERVER - Real package version at runtime: src/version.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
//
// Same pattern HYDRA-UMC-SERVER's own src/server.ts uses: read package.json
// at runtime instead of hardcoding a version string that silently goes
// stale the moment bump-version.mjs runs. Falls back to "0.0.0" rather than
// crashing startup if package.json can't be read for some reason (e.g. a
// bundled dist/ deployment without it alongside).
// =============================================================================

import { readFileSync } from "node:fs";
import path from "node:path";

export function readPackageVersion(): string {
  try {
    const raw = readFileSync(path.join(process.cwd(), "package.json"), "utf-8");
    return JSON.parse(raw).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}
