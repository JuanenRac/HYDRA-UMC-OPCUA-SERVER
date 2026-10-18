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

let cachedVersion: string | null = null;

/** package.json next to the working directory, or one level above the entry file (dist/server.cjs), so the version is right whichever directory the process was started from. */
function candidatePaths(): string[] {
  const candidates = [path.join(process.cwd(), "package.json")];
  const entry = process.argv[1];
  if (entry) candidates.push(path.join(path.dirname(path.resolve(entry)), "..", "package.json"));
  return candidates;
}

/** Read once and cached: /health and /status are polled, and the version cannot change while the process runs. */
export function readPackageVersion(): string {
  if (cachedVersion !== null) return cachedVersion;
  for (const candidate of candidatePaths()) {
    try {
      const version = JSON.parse(readFileSync(candidate, "utf-8")).version;
      if (typeof version === "string" && version) {
        cachedVersion = version;
        return version;
      }
    } catch {
      // try the next candidate
    }
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}
