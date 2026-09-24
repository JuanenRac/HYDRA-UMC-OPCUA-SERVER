// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/robotSource.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0 - see LICENSE
// =============================================================================
import { describe, expect, it, vi } from "vitest";
import { extractRobots, pollerConfigFromEnv, startRobotPolling } from "../src/robotSource.js";
import type { RobotSnapshot } from "../src/server.js";

describe("extractRobots", () => {
  it("reads every robot of every controller", () => {
    const robots = extractRobots({
      controllers: [
        { robots: [{ id: 1, name: "Arm", online: true }, { id: "b", name: "Mill", online: false }] },
        { robots: [{ id: 3, online: true }] },
      ],
    });
    expect(robots).toEqual([
      { id: 1, name: "Arm", online: true },
      { id: "b", name: "Mill", online: false },
      { id: 3, name: "3", online: true },
    ]);
  });

  it("skips anything that is not a usable entry and never throws on odd input", () => {
    expect(extractRobots(null)).toEqual([]);
    expect(extractRobots({ controllers: "x" })).toEqual([]);
    expect(extractRobots({ controllers: [null, { robots: "x" }, { robots: [null, {}, { id: {} }, { id: 4, online: "yes" }] }] })).toEqual([
      { id: 4, name: "4", online: false },
    ]);
  });
});

describe("startRobotPolling", () => {
  const settings = { controllers: [{ robots: [{ id: 1, name: "Arm", online: true }] }] };
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("sends the token and hands the roster to setRobots", async () => {
    const seen: RobotSnapshot[][] = [];
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(settings), { status: 200 })) as unknown as typeof fetch;
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen[0]).toEqual([{ id: 1, name: "Arm", online: true }]);
    const [target, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [URL, RequestInit];
    expect(String(target)).toBe("http://host:3000/api/settings");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t");
  });

  it("keeps known robots but shows them offline when the source fails", async () => {
    const seen: RobotSnapshot[][] = [];
    let ok = true;
    const fetchImpl = (async () => {
      if (ok) return new Response(JSON.stringify(settings), { status: 200 });
      return new Response("unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 1000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    ok = false;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    stop();
    expect(seen[0][0].online).toBe(true);
    expect(seen.at(-1)).toEqual([{ id: 1, name: "Arm", online: false }]);
  });

  it("never reports a robot online when the source was never readable", async () => {
    const seen: RobotSnapshot[][] = [];
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchImpl = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 60_000, setRobots: (r) => seen.push(r), fetchImpl });
    await flush();
    stop();
    expect(seen).toEqual([[]]);
  });
});

describe("pollerConfigFromEnv", () => {
  it("is off unless both the URL and the token are set", () => {
    expect(pollerConfigFromEnv({})).toBeNull();
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000" })).toBeNull();
    expect(pollerConfigFromEnv({ HYDRA_SERVER_TOKEN: "t" })).toBeNull();
  });

  it("defaults to five seconds and validates the interval and URL", () => {
    expect(pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h:3000", HYDRA_SERVER_TOKEN: "t" })).toEqual({ url: "http://h:3000", token: "t", intervalMs: 5000 });
    expect(() => pollerConfigFromEnv({ HYDRA_SERVER_URL: "http://h", HYDRA_SERVER_TOKEN: "t", HYDRA_SERVER_POLL_MS: "10" })).toThrow();
    expect(() => pollerConfigFromEnv({ HYDRA_SERVER_URL: "not a url", HYDRA_SERVER_TOKEN: "t" })).toThrow();
  });
});
