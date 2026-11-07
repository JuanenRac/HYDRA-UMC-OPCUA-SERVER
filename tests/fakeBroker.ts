// =============================================================================
// HYDRA-UMC OPCUA SERVER - tests/fakeBroker.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// A broker for the tests: it accepts a connection, answers CONNECT with CONNACK and SUBSCRIBE with SUBACK, and sends whatever PUBLISH packets the test asks for to the
// clients that subscribed. It keeps the filters and the account it was given, so a test can look at them. It is not a broker: no retained messages, no wildcards match,
// every subscriber gets every message.
// =============================================================================
import net from "node:net";
import type { AddressInfo } from "node:net";
import { remainingLength, splitPackets } from "../src/mqttClient.js";

export interface FakeBroker {
  port: number;
  filters: string[];
  connects: Array<{ clientId: string; username: string | null; password: string | null }>;
  /** Send a PUBLISH (QoS 0, or QoS 1 with an id) to every subscribed client. */
  publish(topic: string, payload: string | Buffer, qos?: 0 | 1): void;
  /** Close every connection (the clients are expected to come back). */
  dropClients(): void;
  close(): Promise<void>;
}

function readString(body: Buffer, offset: number): { text: string; next: number } {
  const length = body.readUInt16BE(offset);
  return { text: body.toString("utf8", offset + 2, offset + 2 + length), next: offset + 2 + length };
}

export async function startFakeBroker(options: { refuse?: boolean } = {}): Promise<FakeBroker> {
  const sockets = new Set<net.Socket>();
  const subscribed = new Set<net.Socket>();
  const filters: string[] = [];
  const connects: FakeBroker["connects"] = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("close", () => {
      sockets.delete(socket);
      subscribed.delete(socket);
    });
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      const { packets, rest } = splitPackets(Buffer.concat([pending, chunk]), 1 << 20);
      pending = Buffer.from(rest);
      for (const item of packets) {
        if (item.type === 1) {
          const name = readString(item.body, 0);
          const flags = item.body[name.next + 1]!;
          let offset = name.next + 4;
          const id = readString(item.body, offset);
          offset = id.next;
          let username: string | null = null;
          let password: string | null = null;
          if (flags & 0x80) {
            const user = readString(item.body, offset);
            username = user.text;
            offset = user.next;
          }
          if (flags & 0x40) password = readString(item.body, offset).text;
          connects.push({ clientId: id.text, username, password });
          socket.write(Buffer.from([0x20, 2, 0, options.refuse ? 5 : 0]));
        } else if (item.type === 8) {
          const packetId = item.body.readUInt16BE(0);
          let offset = 2;
          let count = 0;
          while (offset < item.body.length) {
            const filter = readString(item.body, offset);
            filters.push(filter.text);
            offset = filter.next + 1;
            count += 1;
          }
          subscribed.add(socket);
          socket.write(Buffer.concat([Buffer.from([0x90, 2 + count, (packetId >> 8) & 0xff, packetId & 0xff]), Buffer.alloc(count, 0)]));
        } else if (item.type === 12) {
          socket.write(Buffer.from([0xd0, 0]));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  let nextId = 1;
  return {
    port,
    filters,
    connects,
    publish(topic, payload, qos = 0) {
      const topicBytes = Buffer.from(topic, "utf8");
      const body = Buffer.from(typeof payload === "string" ? payload : payload);
      const header = Buffer.alloc(2 + topicBytes.length + (qos === 1 ? 2 : 0));
      header.writeUInt16BE(topicBytes.length, 0);
      topicBytes.copy(header, 2);
      if (qos === 1) header.writeUInt16BE(nextId++, 2 + topicBytes.length);
      const content = Buffer.concat([header, body]);
      const frame = Buffer.concat([Buffer.from([0x30 | (qos << 1)]), remainingLength(content.length), content]);
      for (const socket of subscribed) socket.write(frame);
    },
    dropClients() {
      for (const socket of sockets) socket.destroy();
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
