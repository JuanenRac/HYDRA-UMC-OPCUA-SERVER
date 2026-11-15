// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/simulation-bench-fleet.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Simulation bench, part two: the real server read by a real OPC UA client while its two live sources fail. The fleet comes from a broker made for the tests and a
// vehicle that publishes good values, garbage, a value of the wrong type for a node that exists, goes silent and loses the broker; the roster comes from a host twin of
// HYDRA-UMC-SERVER that is off, answers 500 or 503, sends a page that is not JSON or a JSON cut in the middle, and forgets the robots. On a fixed seed. No vehicle, no
// robot, no SCADA, no broker of the ecosystem. What the bench proves is that a node shows the last good value the source said, that garbage changes nothing, that
// silence turns the quality to uncertain and a new message turns it back to good, and that a robot is never online on the strength of old data.
// =============================================================================
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import type { RobotSnapshot, RosterMeta } from "../src/server.js";
import { startFleetSubscription } from "../src/fleet.js";
import { startRobotPolling } from "../src/robotSource.js";
import { startFakeBroker, type FakeBroker } from "./fakeBroker.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

const SEED = 20260103;

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 4000, what = "the condition"): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const TOPIC = "hydra/bridges/amr/opcua";
const CHARGE = "Fleet/agv1/battery/charge";

const update = (nodes: unknown[]) => JSON.stringify({ observed_at: Date.now(), vehicle: "agv1", nodes });
const charge = (value: number) => ({ path: CHARGE, type: "Double", value });
const FIRST = update([charge(50), { path: "Fleet/agv1/battery/charging", type: "Boolean", value: false }, { path: "Fleet/agv1/errors/count", type: "Int64", value: 0 }, { path: "Fleet/agv1/machine_state", type: "String", value: "idle" }]);

async function openSession(url: string) {
  const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
  await client.connect(url);
  const session = await client.createSession();
  return {
    read: (id: string) => session.read({ nodeId: `ns=2;s=${id.replace(/\//g, ".")}`, attributeId: AttributeIds.Value }),
    close: async () => {
      await session.close();
      await client.disconnect();
    },
  };
}

describe("the Fleet nodes while the vehicle and the broker misbehave", () => {
  let broker: FakeBroker | null = null;
  afterEach(async () => {
    await broker?.close();
    broker = null;
    delete process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS;
  });

  async function rig() {
    broker = await startFakeBroker();
    const built = await buildAddressSpaceServer(0, { methods: null, faultAlarms: false, bridges: false, fleet: true });
    const subscription = startFleetSubscription({ host: "127.0.0.1", port: broker.port, topics: ["hydra/bridges/+/opcua"], staleMs: 60000 }, built.setFleet);
    await until(() => broker!.filters.length === 1, 4000, "the subscription");
    const session = await openSession(built.server.getEndpointUrl());
    return {
      built,
      session,
      subscription,
      stop: async () => {
        await session.close();
        subscription.stop();
        await built.server.shutdown();
      },
    };
  }

  it("on a fixed seed, shows the last good value of the vehicle, ignores garbage and survives the broker dropping its clients", async () => {
    const { session, subscription, built, stop } = await rig();
    try {
      broker!.publish(TOPIC, FIRST);
      await until(() => built.fleetCount() === 4, 4000, "the four nodes");
      const random = seeded(SEED);
      let expected = 50;
      const garbage = [
        "not json",
        update([{ path: CHARGE, type: "Double", value: "111" }]),
        update([{ path: "Fleet/agv2/battery/charge", type: "Double", value: 111 }]),
        update([{ path: "Fleet/agv1/../battery/charge", type: "Double", value: 111 }]),
        '{"observed_at":1,"vehicle":"agv1","nodes":[{"path":"Fleet/agv1/battery/charge","type":"Double","value":1e999}]}',
        update([charge(111), charge(112)]),
      ];
      for (let round = 0; round < 12; round += 1) {
        const action = random();
        if (action < 0.3) {
          for (const bad of garbage.slice(0, 1 + Math.floor(random() * garbage.length))) broker!.publish(TOPIC, bad);
          await sleep(120);
          expect((await session.read(CHARGE)).value.value).toBe(expected);
          continue;
        }
        if (action < 0.5) {
          const before = broker!.filters.length;
          broker!.dropClients();
          await until(() => !subscription.connected(), 4000, "the drop");
          await until(() => subscription.connected() && broker!.filters.length > before, 8000, "the reconnection");
        }
        let next = Math.round(random() * 1000) / 10;
        if (next === expected || next === 111 || next === 112) next += 0.1;
        broker!.publish(TOPIC, update([charge(next)]));
        expected = next;
        await until(async () => (await session.read(CHARGE)).value.value === expected, 4000, `the value ${String(expected)}`);
      }
      const last = await session.read(CHARGE);
      expect(last.value.value).toBe(expected);
      expect(last.statusCode.name).toBe("Good");
      expect(built.fleetCount()).toBe(4);
    } finally {
      await stop();
    }
  }, 90_000);

  it("keeps the type of a node that exists when the vehicle sends the same path with another type", async () => {
    const { session, built, stop } = await rig();
    try {
      broker!.publish(TOPIC, FIRST);
      await until(() => built.fleetCount() === 4, 4000, "the four nodes");
      broker!.publish(TOPIC, update([{ path: "Fleet/agv1/battery/charging", type: "String", value: "yes" }, charge(61)]));
      await until(async () => (await session.read(CHARGE)).value.value === 61, 4000, "the second message");
      const charging = await session.read("Fleet/agv1/battery/charging");
      expect(charging.value.value).toBe(false);
      expect(built.fleetCount()).toBe(4);
    } finally {
      await stop();
    }
  }, 30_000);

  it("turns the quality to uncertain when the vehicle goes silent and back to good with its next message", async () => {
    process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS = "1000";
    const { session, stop } = await rig();
    try {
      broker!.publish(TOPIC, update([charge(70)]));
      await until(async () => (await session.read(CHARGE)).value.value === 70, 4000, "the first message");
      expect((await session.read(CHARGE)).statusCode.name).toBe("Good");
      await sleep(1300);
      const silent = await session.read(CHARGE);
      expect(silent.value.value).toBe(70);
      expect(silent.statusCode.name).toContain("Uncertain");
      broker!.publish(TOPIC, update([charge(71)]));
      await until(async () => (await session.read(CHARGE)).value.value === 71, 4000, "the message after the silence");
      expect((await session.read(CHARGE)).statusCode.name).toBe("Good");
    } finally {
      await stop();
    }
  }, 30_000);

  it("keeps the last value, with an uncertain quality, for as long as the broker is away", async () => {
    process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS = "1000";
    const { session, stop } = await rig();
    try {
      broker!.publish(TOPIC, update([charge(42)]));
      await until(async () => (await session.read(CHARGE)).value.value === 42, 4000, "the first message");
      await broker!.close();
      broker = null;
      await sleep(1300);
      const away = await session.read(CHARGE);
      expect(away.value.value).toBe(42);
      expect(away.statusCode.name).toContain("Uncertain");
    } finally {
      await stop();
    }
  }, 30_000);
});

describe("the roster while the server of the robots fails", () => {
  type Fault = "down" | "http500" | "http503" | "http401" | "junk" | "liar";
  const FAULTS: Fault[] = ["down", "http500", "http503", "http401", "junk", "liar"];

  function run(seed: number) {
    return (async () => {
      const random = seeded(seed);
      const script: Array<{ fault: Fault | null; online: [boolean, boolean] }> = [];
      for (let call = 0; call < 70; call += 1) {
        script.push({ fault: random() < 0.4 ? FAULTS[Math.floor(random() * FAULTS.length)]! : null, online: [random() < 0.7, random() < 0.7] });
      }
      let calls = 0;
      const fetchImpl = (async () => {
        const step = script[Math.min(calls, script.length - 1)]!;
        calls += 1;
        if (step.fault === "down") throw new TypeError("fetch failed");
        if (step.fault === "http500") return new Response("{}", { status: 500 });
        if (step.fault === "http503") return new Response("starting", { status: 503 });
        if (step.fault === "http401") return new Response("{}", { status: 401 });
        if (step.fault === "junk") return new Response("<html>starting</html>", { status: 200 });
        if (step.fault === "liar") return new Response('{"controllers":[{"robots":[{"id":1,"na', { status: 200 });
        const robots = [
          { id: 1, name: "Arm", online: step.online[0] },
          { id: 2, name: "Belt", online: step.online[1] },
        ];
        return new Response(JSON.stringify({ controllers: [{ robots }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const seen: Array<{ robots: RobotSnapshot[]; meta: RosterMeta }> = [];
      const stop = startRobotPolling({ url: "http://host:3000", token: "t", intervalMs: 15, setRobots: (robots, meta) => seen.push({ robots, meta: meta ?? { stale: false } }), fetchImpl });
      await until(() => seen.length >= script.length, 20_000, "the polls");
      stop();
      return { script, seen: seen.slice(0, script.length) };
    })();
  }

  it("on a fixed seed, shows what the server said when it answered and never an online robot when it did not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const first = await run(SEED);
    let known: RobotSnapshot[] = [];
    first.script.forEach((step, index) => {
      const got = first.seen[index]!;
      if (step.fault === null) {
        known = [
          { id: 1, name: "Arm", online: step.online[0] },
          { id: 2, name: "Belt", online: step.online[1] },
        ];
        expect(got.robots).toEqual(known);
        expect(got.meta.stale).toBe(false);
      } else {
        known = known.map((robot) => ({ ...robot, online: false }));
        expect(got.robots).toEqual(known);
        expect(got.meta.stale).toBe(true);
        expect(got.robots.every((robot) => !robot.online)).toBe(true);
      }
    });
    expect(first.script.filter((step) => step.fault !== null).length).toBeGreaterThan(15);
    const second = await run(SEED);
    expect(second.seen.map((entry) => entry.robots)).toEqual(first.seen.map((entry) => entry.robots));
    vi.restoreAllMocks();
  }, 60_000);
});
