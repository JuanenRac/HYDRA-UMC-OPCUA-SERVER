// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/hardening.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The pieces that do not need a running OPC-UA server: node keys, the login
// throttle, the PKI choices, the roster source (URL prefix, size cap, no
// overlapping polls) and the version lookup.
// =============================================================================

import { describe, expect, it, vi } from "vitest";
import { LoginThrottle, createCertificateManagers, resolveListenPortOf, resolvePort, robotNodeKey, secretsMatch } from "../src/server.js";
import { apiUrl, readJsonCapped, startRobotPolling } from "../src/robotSource.js";
import { readPackageVersion } from "../src/version.js";

describe("robotNodeKey", () => {
  it("keeps an id made of safe characters as it is", () => {
    expect(robotNodeKey(7)).toBe("7");
    expect(robotNodeKey("arm-1_b")).toBe("arm-1_b");
  });

  it("gives ids that only differ in unusable characters different nodes", () => {
    const dotted = robotNodeKey("a.b");
    const underscored = robotNodeKey("a_b");
    expect(underscored).toBe("a_b");
    expect(dotted).not.toBe(underscored);
    expect(dotted).toMatch(/^a_b_[0-9a-f]{6}$/);
    expect(robotNodeKey("a.b")).toBe(dotted);
  });

  it("never produces an empty key", () => {
    expect(robotNodeKey("...")).toMatch(/^_{3}_[0-9a-f]{6}$/);
  });
});

describe("login protection", () => {
  it("compares secrets in constant time and by value", () => {
    expect(secretsMatch("hydra", "hydra")).toBe(true);
    expect(secretsMatch("hydra", "hydrA")).toBe(false);
    expect(secretsMatch("", "hydra")).toBe(false);
  });

  it("locks after the allowed number of failures and unlocks when the window passes", () => {
    const throttle = new LoginThrottle(3, 1000);
    expect(throttle.isLocked(0)).toBe(false);
    throttle.recordFailure(0);
    throttle.recordFailure(10);
    expect(throttle.isLocked(20)).toBe(false);
    throttle.recordFailure(20);
    expect(throttle.isLocked(30)).toBe(true);
    expect(throttle.isLocked(999)).toBe(true);
    expect(throttle.isLocked(1025)).toBe(false);
  });
});

describe("certificate stores", () => {
  it("never auto-accepts a user certificate, and accepts application certificates only on request", () => {
    const strict = createCertificateManagers({ OPCUA_PKI_DIR: "" } as NodeJS.ProcessEnv);
    expect(strict.serverCertificateManager.automaticallyAcceptUnknownCertificate).toBe(false);
    expect(strict.userCertificateManager.automaticallyAcceptUnknownCertificate).toBe(false);
    const lab = createCertificateManagers({ OPCUA_AUTO_ACCEPT: "1" } as NodeJS.ProcessEnv);
    expect(lab.serverCertificateManager.automaticallyAcceptUnknownCertificate).toBe(true);
    expect(lab.userCertificateManager.automaticallyAcceptUnknownCertificate).toBe(false);
    const other = createCertificateManagers({ OPCUA_AUTO_ACCEPT: "true" } as NodeJS.ProcessEnv);
    expect(other.serverCertificateManager.automaticallyAcceptUnknownCertificate).toBe(false);
  });
});

describe("resolvePort", () => {
  it("does not run at import time: a bad PORT only fails when it is asked for", () => {
    expect(() => resolvePort("nope")).toThrow(/PORT/);
    expect(resolvePort(undefined)).toBe(4840);
  });

  it("reads the variable of its own before the shared PORT, and only PORT earns a warning", () => {
    expect(resolveListenPortOf({ HYDRA_UMC_OPCUA_PORT: "4850", PORT: "3000" }).port).toBe(4850);
    expect(resolveListenPortOf({ HYDRA_UMC_OPCUA_PORT: "4850", PORT: "3000" }).warning).toBeUndefined();
    const shared = resolveListenPortOf({ PORT: "3000" });
    expect(shared.port).toBe(3000);
    expect(shared.warning).toContain("HYDRA_UMC_OPCUA_PORT");
    expect(resolveListenPortOf({}).port).toBe(4840);
    expect(() => resolveListenPortOf({ HYDRA_UMC_OPCUA_PORT: "abc", PORT: "3000" })).toThrow(/HYDRA_UMC_OPCUA_PORT/);
    expect(() => resolveListenPortOf({ PORT: "70000" })).toThrow(/PORT must be an integer/);
  });
});

describe("the roster source", () => {
  it("keeps a path prefix of the configured URL", () => {
    expect(apiUrl("http://host:3000", "/api/settings").href).toBe("http://host:3000/api/settings");
    expect(apiUrl("http://host/hydra", "/api/settings").href).toBe("http://host/hydra/api/settings");
    expect(apiUrl("http://host/hydra/", "/api/login").href).toBe("http://host/hydra/api/login");
  });

  it("stops reading a body that is over the limit, whatever its declared length", async () => {
    const big = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    }));
    await expect(readJsonCapped(big, 1000)).rejects.toThrow(/larger than 1000/);
    const fine = new Response(JSON.stringify({ controllers: [] }));
    await expect(readJsonCapped(fine, 1000)).resolves.toEqual({ controllers: [] });
  });

  it("does not start a poll while the previous one is still running", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: (() => void) | undefined;
      const slowFetch = (() => {
        calls++;
        return new Promise<Response>((resolve) => {
          release = () => resolve(new Response(JSON.stringify({ controllers: [] })));
        });
      }) as unknown as typeof fetch;
      const stop = startRobotPolling({ url: "http://127.0.0.1:1", token: "t", intervalMs: 1000, setRobots: () => undefined, fetchImpl: slowFetch });
      await vi.advanceTimersByTimeAsync(3500);
      expect(calls).toBe(1);
      release?.();
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      release?.();
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells whether the source could be read", async () => {
    const statuses: boolean[] = [];
    const okFetch = (async () => new Response(JSON.stringify({ controllers: [] }))) as unknown as typeof fetch;
    const stop = startRobotPolling({ url: "http://127.0.0.1:1", token: "t", intervalMs: 60_000, setRobots: () => undefined, onSourceStatus: (ok) => statuses.push(ok), fetchImpl: okFetch });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    const failing = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const stop2 = startRobotPolling({ url: "http://127.0.0.1:1", token: "t", intervalMs: 60_000, setRobots: () => undefined, onSourceStatus: (ok) => statuses.push(ok), fetchImpl: failing });
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop2();
    expect(statuses).toEqual([true, false]);
  });
});

describe("the reported version", () => {
  it("is the package version, read once", () => {
    const first = readPackageVersion();
    expect(first).toMatch(/^\d+\.\d+\.\d+/);
    expect(readPackageVersion()).toBe(first);
  });
});
