// =============================================================================
// HYDRA-UMC-SDK - TypeScript reference client: the robot roster of a settings answer
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
// =============================================================================

/** What a robot of the roster is doing. */
export type RosterPlayback = "idle" | "playing" | "paused" | "finished";

/** One robot of the `RobotRoster` contract. */
export interface RosterRobot {
  controller_id: string;
  robot_id: number;
  online: boolean;
  playback: RosterPlayback;
}

/** The `RobotRoster` contract. */
export interface RobotRoster {
  schema_version: "1.0";
  robots: RosterRobot[];
}

const MAX_ROBOTS = 1000;
const MAX_CONTROLLER_ID_CHARS = 100;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function playbackOf(state: unknown): RosterPlayback {
  const record = asRecord(state);
  if (record === null) return "idle";
  if (record.isFinished === true) return "finished";
  if (record.isPaused === true) return "paused";
  if (record.isPlaying === true) return "playing";
  return "idle";
}

/**
 * The roster of the `controllers` of a settings answer, the same walk for every reader. A robot without a usable id is skipped, a missing `online` is false, a
 * missing or unknown playback state is `idle`, and a settings answer without robots gives an empty roster. It never throws and never invents a robot.
 */
export function rosterFromSettings(settings: unknown): RobotRoster {
  const robots: RosterRobot[] = [];
  const controllers = asRecord(settings)?.controllers;
  const list: unknown[] = Array.isArray(controllers) ? controllers : [];
  for (let number = 0; number < list.length; number += 1) {
    const controller = asRecord(list[number]);
    if (controller === null) continue;
    const rawId = controller.id ?? controller.controllerId;
    const controllerId = typeof rawId === "string" && rawId.length >= 1 && rawId.length <= MAX_CONTROLLER_ID_CHARS ? rawId : `controller-${number + 1}`;
    const members: unknown[] = Array.isArray(controller.robots) ? controller.robots : [];
    for (const item of members) {
      const robot = asRecord(item);
      if (robot === null || typeof robot.id !== "number" || !Number.isInteger(robot.id) || robot.id < 0) continue;
      if (robots.length >= MAX_ROBOTS) return { schema_version: "1.0", robots };
      robots.push({ controller_id: controllerId, robot_id: robot.id, online: robot.online === true, playback: playbackOf(robot.playbackState) });
    }
  }
  return { schema_version: "1.0", robots };
}
