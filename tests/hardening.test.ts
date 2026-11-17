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
import { UserNameIdentityToken } from "node-opcua";
import { LoginThrottle, createCertificateManagers, resolveListenPortOf, resolvePort, robotNodeKey, secretsMatch, sessionLabel } from "../src/server.js";
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

  it("locks one user name at its own limit and the whole login at the global limit", () => {
    const throttle = new LoginThrottle(3, 1000, 8);
    for (let at = 0; at < 3; at += 1) throttle.recordFailure(at, "scada");
    expect(throttle.isLocked(10, "scada")).toBe(true);
    // the administrator is not locked out by somebody else's wrong password
    expect(throttle.isLocked(10, "hydra-admin")).toBe(false);
    expect(throttle.isLocked(10)).toBe(false);
    // five more failures under other names reach the global limit of eight: everybody is locked
    for (let at = 10; at < 15; at += 1) throttle.recordFailure(at, `guess-${at}`);
    expect(throttle.isLocked(20, "hydra-admin")).toBe(true);
    expect(throttle.isLocked(20)).toBe(true);
    // both end when the window passes
    expect(throttle.isLocked(1100, "scada")).toBe(false);
    expect(throttle.isLocked(1100, "hydra-admin")).toBe(false);
  });

  it("without a global limit any failures that reach the limit lock every name, as before", () => {
    const throttle = new LoginThrottle(3, 1000);
    throttle.recordFailure(0, "a");
    throttle.recordFailure(1, "b");
    throttle.recordFailure(2, "c");
    expect(throttle.isLocked(3, "hydra-admin")).toBe(true);
    expect(throttle.isLocked(3)).toBe(true);
  });

  it("a global limit below the per-name limit is raised to it", () => {
    const throttle = new LoginThrottle(5, 1000, 2);
    throttle.recordFailure(0, "a");
    throttle.recordFailure(1, "b");
    expect(throttle.isLocked(2, "c")).toBe(false);
  });

  it("keeps the table of names bounded: names beyond it only count in the global total", () => {
    const throttle = new LoginThrottle(2, 60_000, 100_000);
    for (let i = 0; i < LoginThrottle.MAX_NAMES + 50; i += 1) throttle.recordFailure(i, `name-${i}`);
    expect(throttle.totalFailures).toBe(LoginThrottle.MAX_NAMES + 50);
    // a name that did not fit is never locked by itself, however often it fails
    const extra = `name-${LoginThrottle.MAX_NAMES + 10}`;
    throttle.recordFailure(1000, extra);
    throttle.recordFailure(1001, extra);
    expect(throttle.isLocked(1002, extra)).toBe(false);
    // a name that fit still is
    throttle.recordFailure(1003, "name-0");
    expect(throttle.isLocked(1004, "name-0")).toBe(true);
  });
});

describe("who is behind a session", () => {
  const session = (token: unknown) => ({ session: { userIdentityToken: token } }) as never;
  it("names the administrator, another login, a certificate and an anonymous session", () => {
    expect(sessionLabel(session(new UserNameIdentityToken({ userName: "hydra-admin" })), "hydra-admin")).toBe("hydra-admin");
    expect(sessionLabel(session(new UserNameIdentityToken({ userName: "scada" })), "hydra-admin")).toBe("user:scada");
    expect(sessionLabel(session({ certificateData: Buffer.from("x") }), "hydra-admin")).toBe("certificate");
    expect(sessionLabel(session({ policyId: "anonymous" }), "hydra-admin")).toBe("anonymous");
    expect(sessionLabel({} as never, undefined)).toBe("anonymous");
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


describe("the development and build scripts on an npm without install-scripts", () => {
  it("never call `npm install-scripts approve` without asking first whether npm has it", async () => {
    const { readFileSync } = await import("node:fs");
    for (const name of ["dev.sh", "dev.bat", "build.sh", "build.bat"]) {
      const lines = readFileSync(new URL("../" + name, import.meta.url), "utf8").split(/\r?\n/);
      const calls = lines.map((l, i) => [l, i] as const).filter(([l]) => /install-scripts approve/.test(l) && !/^\s*(#|REM\b)/i.test(l));
      expect(calls.length, name).toBeGreaterThan(0);
      for (const [line, i] of calls) {
        const guarded = /install-scripts --help/.test(line) || lines.slice(Math.max(0, i - 2), i).some((l) => /install-scripts --help/.test(l));
        expect(guarded, name + ": " + line).toBe(true);
      }
    }
  });
});
