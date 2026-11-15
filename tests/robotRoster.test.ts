// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/robotRoster.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The robot roster is the one of the shared SDK (src/robotRoster.ts is its TypeScript walk, carried here unchanged): these tests check that the copy is
// still the file of the SDK when the SDK is at hand, and what the reader makes of the roster.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { rosterFromSettings } from "../src/robotRoster.js";

function sdkRoster(): string | null {
  const roots = [process.env.HYDRA_UMC_SDK_DIR, path.resolve(process.cwd(), "..", "HYDRA-UMC-SDK")].filter((dir): dir is string => !!dir);
  for (const root of roots) {
    const file = path.join(root, "clients", "typescript", "src", "roster.ts");
    if (fs.existsSync(file)) return file;
  }
  return null;
}

describe("the robot roster of the SDK", () => {
  it("is the same file as the one of the SDK when the SDK is at hand", () => {
    const file = sdkRoster();
    if (file === null) return;
    const theirs = fs.readFileSync(file, "utf-8").replace(/\r\n/g, "\n");
    const ours = fs.readFileSync(fileURLToPath(new URL("../src/robotRoster.ts", import.meta.url)), "utf-8").replace(/\r\n/g, "\n");
    expect(ours).toBe(theirs);
  });

  it("skips a robot without a usable id, takes a missing online as false and a missing playback as idle", () => {
    const roster = rosterFromSettings({
      controllers: [{ id: "c1", robots: [{ id: 1, online: true, playbackState: { isPlaying: true } }, { id: "x" }, { id: -1 }, { id: 2 }] }],
    });
    expect(roster.robots).toEqual([
      { controller_id: "c1", robot_id: 1, online: true, playback: "playing" },
      { controller_id: "c1", robot_id: 2, online: false, playback: "idle" },
    ]);
  });

  it("gives an empty roster for an answer without robots", () => {
    expect(rosterFromSettings(null).robots).toEqual([]);
    expect(rosterFromSettings({ controllers: "none" }).robots).toEqual([]);
  });
});
