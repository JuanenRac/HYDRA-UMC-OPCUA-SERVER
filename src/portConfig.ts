// =============================================================================
// HYDRA-UMC OPCUA SERVER - src/portConfig.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The listen port of this service. Several services of the same machine read
// the one variable PORT, so a shared EnvironmentFile (or an `export PORT=3000`)
// could silently move this one onto another service's port. The service has a
// variable of its own, which wins; PORT is only a last resort and says so on
// the console. A value that is set but is not a valid port stops the start.
// =============================================================================

export interface ResolvedPort {
  port: number;
  source: "specific" | "PORT" | "default";
  warning?: string;
}

function strictPort(service: string, name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${service}: ${name} must be an integer in 1..65535, got ${raw}`);
  }
  return value;
}

export function resolveListenPort(
  env: Record<string, string | undefined>,
  service: string,
  specificName: string,
  fallback: number,
): ResolvedPort {
  const specific = env[specificName];
  if (specific !== undefined && specific.trim() !== "") {
    return { port: strictPort(service, specificName, specific), source: "specific" };
  }
  const shared = env.PORT;
  if (shared !== undefined && shared.trim() !== "") {
    const port = strictPort(service, "PORT", shared);
    return {
      port,
      source: "PORT",
      warning: `${specificName} is not set: using the shared PORT=${port}. Set ${specificName} so another service of this machine cannot move this one.`,
    };
  }
  return { port: fallback, source: "default" };
}
