// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/fleet.test.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// The fleet as nodes: the message the bridges publish on the MQTT broker (src/fleet.ts), the small MQTT client that follows it (src/mqttClient.ts) against a broker made
// for the tests, and the nodes under `Fleet/` of a real server read by a real client. evidence=simulator: no vehicle and no real broker are involved.
// =============================================================================
import { afterEach, describe, expect, it } from "vitest";
import { AttributeIds, MessageSecurityMode, OPCUAClient, SecurityPolicy } from "node-opcua";
import { buildAddressSpaceServer } from "../src/server.js";
import { fleetConfigFromEnv, fleetEnabled, parseFleetMessage, startFleetSubscription } from "../src/fleet.js";
import { connectPacket, parsePublish, remainingLength, splitPackets, subscribe, subscribePacket } from "../src/mqttClient.js";
import { startFakeBroker, type FakeBroker } from "./fakeBroker.js";

process.env.OPCUA_AUTO_ACCEPT = "1";

const GOOD = {
  observed_at: 1_700_000_000_000,
  vehicle: "agv1",
  nodes: [
    { path: "Fleet/agv1/battery/charge", type: "Double", value: 80.5 },
    { path: "Fleet/agv1/battery/charging", type: "Boolean", value: false },
    { path: "Fleet/agv1/errors/count", type: "Int64", value: 3 },
    { path: "Fleet/agv1/machine_state", type: "String", value: "driving" },
  ],
};

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("the message of a bridge", () => {
  it("is accepted when every check holds", () => {
    const update = parseFleetMessage(JSON.stringify(GOOD));
    expect(update?.vehicle).toBe("agv1");
    expect(update?.nodes.length).toBe(4);
    expect(update?.observedAtMs).toBe(GOOD.observed_at);
  });

  it.each([
    ["not JSON", "{"],
    ["no vehicle", JSON.stringify({ ...GOOD, vehicle: undefined })],
    ["a vehicle that is not a name", JSON.stringify({ ...GOOD, vehicle: "../x" })],
    ["no time", JSON.stringify({ ...GOOD, observed_at: "now" })],
    ["no nodes", JSON.stringify({ ...GOOD, nodes: [] })],
    ["a path of another vehicle", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv2/x", type: "Double", value: 1 }] })],
    ["a path with a segment that is not a name", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/a b", type: "Double", value: 1 }] })],
    ["a path with a dot-dot", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/../x", type: "Double", value: 1 }] })],
    ["an unknown type", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/x", type: "Float", value: 1 }] })],
    ["a value of the wrong type", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/x", type: "Boolean", value: "yes" }] })],
    ["a number that is not finite", '{"observed_at":1,"vehicle":"agv1","nodes":[{"path":"Fleet/agv1/x","type":"Double","value":1e999}]}'],
    ["an integer that is not whole", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/x", type: "Int64", value: 1.5 }] })],
    ["the same path twice", JSON.stringify({ ...GOOD, nodes: [GOOD.nodes[0], GOOD.nodes[0]] })],
    ["a value that is also a folder", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/a", type: "Double", value: 1 }, { path: "Fleet/agv1/a/b", type: "Double", value: 2 }] })],
    ["too many nodes", JSON.stringify({ ...GOOD, nodes: Array.from({ length: 201 }, (_, i) => ({ path: `Fleet/agv1/n${i}`, type: "Double", value: i })) })],
    ["a string that is too long", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/x", type: "String", value: "a".repeat(300) }] })],
  ])("is dropped whole for %s", (_name, text) => {
    expect(parseFleetMessage(text)).toBeNull();
  });
});

describe("the settings", () => {
  it("are off unless the switch is 1", () => {
    expect(fleetEnabled({})).toBe(false);
    expect(fleetConfigFromEnv({})).toBeNull();
  });

  it("read the broker, the topics, the account and the password file", () => {
    const config = fleetConfigFromEnv(
      { HYDRA_UMC_OPCUA_MQTT: "1", HYDRA_UMC_OPCUA_MQTT_URL: "mqtt://broker.local:1884", HYDRA_UMC_OPCUA_MQTT_USER: "opcua", HYDRA_UMC_OPCUA_MQTT_PASSWORD_FILE: "/run/secret" },
      () => "s3cret\n",
    );
    expect(config).toMatchObject({ host: "broker.local", port: 1884, topics: ["hydra/bridges/+/opcua"], username: "opcua", password: "s3cret", staleMs: 60000 });
  });

  it("refuse a URL that is not mqtt://, a bad port and a topic that is not a plain filter", () => {
    expect(() => fleetConfigFromEnv({ HYDRA_UMC_OPCUA_MQTT: "1", HYDRA_UMC_OPCUA_MQTT_URL: "mqtts://x" })).toThrow(/must start with mqtt/);
    expect(() => fleetConfigFromEnv({ HYDRA_UMC_OPCUA_MQTT: "1", HYDRA_UMC_OPCUA_MQTT_URL: "mqtt://x:99999" })).toThrow();
    expect(() => fleetConfigFromEnv({ HYDRA_UMC_OPCUA_MQTT: "1", HYDRA_UMC_OPCUA_MQTT_TOPICS: "a b" })).toThrow(/plain filter/);
  });
});

describe("the MQTT packets", () => {
  it("write the remaining length the way the standard says", () => {
    expect([...remainingLength(0)]).toEqual([0]);
    expect([...remainingLength(127)]).toEqual([127]);
    expect([...remainingLength(128)]).toEqual([0x80, 0x01]);
    expect([...remainingLength(16383)]).toEqual([0xff, 0x7f]);
    expect([...remainingLength(16384)]).toEqual([0x80, 0x80, 0x01]);
  });

  it("build a CONNECT with and without an account and a SUBSCRIBE", () => {
    const plain = connectPacket({ host: "h", port: 1, clientId: "c1" });
    expect(plain[0]).toBe(0x10);
    expect(plain.includes(Buffer.from("MQTT"))).toBe(true);
    const account = connectPacket({ host: "h", port: 1, clientId: "c1", username: "u", password: "p" });
    expect(account.length).toBeGreaterThan(plain.length);
    const sub = subscribePacket(7, ["a/+", "b/#"]);
    expect(sub[0]).toBe(0x82);
    expect(sub.readUInt16BE(2)).toBe(7);
  });

  it("split a stream that arrives in pieces and refuse a packet that is too large", () => {
    const frame = Buffer.concat([Buffer.from([0x30, 5]), Buffer.from([0, 1, 0x61, 0x62, 0x63])]);
    const first = splitPackets(frame.subarray(0, 4), 1000);
    expect(first.packets.length).toBe(0);
    const whole = splitPackets(Buffer.concat([frame, frame]), 1000);
    expect(whole.packets.length).toBe(2);
    expect(parsePublish(whole.packets[0]!.flags, whole.packets[0]!.body)).toMatchObject({ topic: "a", qos: 0 });
    expect(() => splitPackets(Buffer.from([0x30, 0xff, 0xff, 0xff, 0x7f]), 1000)).toThrow();
    expect(() => splitPackets(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80, 0x01]), 1000)).toThrow();
  });
});

describe("the subscriber against a broker", () => {
  let broker: FakeBroker | null = null;
  afterEach(async () => {
    await broker?.close();
    broker = null;
  });

  it("connects with the account, subscribes and receives what is published", async () => {
    broker = await startFakeBroker();
    const got: Array<{ topic: string; text: string }> = [];
    const sub = subscribe({ host: "127.0.0.1", port: broker.port, clientId: "test", username: "u", password: "p" }, ["hydra/bridges/+/opcua"], (topic, payload) => got.push({ topic, text: payload.toString("utf8") }));
    try {
      await until(() => sub.connected());
      await until(() => broker!.filters.length === 1);
      expect(broker.filters).toEqual(["hydra/bridges/+/opcua"]);
      expect(broker.connects[0]).toMatchObject({ clientId: "test", username: "u", password: "p" });
      broker.publish("hydra/bridges/amr/opcua", "one");
      broker.publish("hydra/bridges/amr/opcua", "two", 1);
      await until(() => got.length === 2);
      expect(got.map((m) => m.text)).toEqual(["one", "two"]);
    } finally {
      sub.stop();
    }
  });

  it("comes back after the broker drops the connection", async () => {
    broker = await startFakeBroker();
    const states: boolean[] = [];
    const sub = subscribe({ host: "127.0.0.1", port: broker.port, clientId: "again" }, ["x"], () => undefined, (connected) => states.push(connected));
    try {
      await until(() => sub.connected());
      broker.dropClients();
      await until(() => !sub.connected());
      await until(() => sub.connected(), 6000);
      expect(states.filter(Boolean).length).toBe(2);
    } finally {
      sub.stop();
    }
  }, 15_000);

  it("stays disconnected when the broker refuses it", async () => {
    broker = await startFakeBroker({ refuse: true });
    const sub = subscribe({ host: "127.0.0.1", port: broker.port, clientId: "refused" }, ["x"], () => undefined);
    try {
      await until(() => broker!.connects.length >= 1);
      await new Promise((r) => setTimeout(r, 200));
      expect(sub.connected()).toBe(false);
    } finally {
      sub.stop();
    }
  });
});

describe("the nodes under Fleet", () => {
  let broker: FakeBroker | null = null;
  afterEach(async () => {
    await broker?.close();
    broker = null;
  });

  async function readNodes(url: string, ids: string[]) {
    const client = OPCUAClient.create({ endpointMustExist: false, securityMode: MessageSecurityMode.SignAndEncrypt, securityPolicy: SecurityPolicy.Basic256Sha256 });
    await client.connect(url);
    try {
      const session = await client.createSession();
      try {
        const out = [];
        for (const id of ids) out.push(await session.read({ nodeId: `ns=1;s=${id}`, attributeId: AttributeIds.Value }));
        const written = await session.write({ nodeId: "ns=1;s=Fleet.agv1.battery.charge", attributeId: AttributeIds.Value, value: { value: { dataType: 11, value: 1 } } });
        return { values: out, writable: written.isGood() };
      } finally {
        await session.close();
      }
    } finally {
      await client.disconnect();
    }
  }

  it("follow the broker, keep their types and refuse a write", async () => {
    broker = await startFakeBroker();
    const built = await buildAddressSpaceServer(0, { methods: null, faultAlarms: false, bridges: false, fleet: true });
    const sub = startFleetSubscription({ host: "127.0.0.1", port: broker.port, topics: ["hydra/bridges/+/opcua"], staleMs: 60000 }, built.setFleet);
    try {
      await until(() => broker!.filters.length === 1);
      broker.publish("hydra/bridges/amr/opcua", JSON.stringify(GOOD));
      await until(() => built.fleetCount() === 4);
      const { values, writable } = await readNodes(built.server.getEndpointUrl(), ["Fleet.agv1.battery.charge", "Fleet.agv1.battery.charging", "Fleet.agv1.errors.count", "Fleet.agv1.machine_state"]);
      expect(values[0]!.value.value).toBe(80.5);
      expect(values[0]!.statusCode.name).toBe("Good");
      expect(values[1]!.value.value).toBe(false);
      expect(values[2]!.value.value).toEqual([0, 3]);
      expect(values[3]!.value.value).toBe("driving");
      expect(writable).toBe(false);
      // a new value of the same node replaces the old one; a message that is not acceptable changes nothing
      broker.publish("hydra/bridges/amr/opcua", JSON.stringify({ ...GOOD, nodes: [{ path: "Fleet/agv1/battery/charge", type: "Double", value: 79 }] }));
      broker.publish("hydra/bridges/amr/opcua", "garbage");
      await new Promise((r) => setTimeout(r, 300));
      const again = await readNodes(built.server.getEndpointUrl(), ["Fleet.agv1.battery.charge"]);
      expect(again.values[0]!.value.value).toBe(79);
      expect(built.fleetCount()).toBe(4);
    } finally {
      sub.stop();
      await built.server.shutdown();
    }
  }, 30_000);

  it("keep their last value with an uncertain quality when the vehicle goes silent", async () => {
    const previous = process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS;
    process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS = "1000";
    const built = await buildAddressSpaceServer(0, { methods: null, faultAlarms: false, bridges: false, fleet: true });
    try {
      const update = parseFleetMessage(JSON.stringify(GOOD))!;
      built.setFleet(update);
      await new Promise((r) => setTimeout(r, 1300));
      const { values } = await readNodes(built.server.getEndpointUrl(), ["Fleet.agv1.battery.charge"]);
      expect(values[0]!.value.value).toBe(80.5);
      expect(values[0]!.statusCode.name).toContain("Uncertain");
    } finally {
      if (previous === undefined) delete process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS;
      else process.env.HYDRA_UMC_OPCUA_MQTT_STALE_MS = previous;
      await built.server.shutdown();
    }
  }, 30_000);
});
