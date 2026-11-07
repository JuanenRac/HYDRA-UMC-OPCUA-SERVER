// =============================================================================
// HYDRA-UMC OPCUA SERVER - A minimal MQTT 3.1.1 subscriber: src/mqttClient.ts
// Copyright (C) 2026 JuanenRac (Electro Hobby 3D) <electrohobby3d@gmail.com>
// GPL-3.0-or-later - see LICENSE
//
// Only what the server needs to follow the topics of the broker: connect (optionally with an account), subscribe at QoS 0, receive PUBLISH packets (QoS 0 and QoS 1,
// the latter acknowledged), keep the connection alive with PINGREQ and come back with a growing pause when it drops. It publishes nothing, so this server can never
// write to the broker. No dependency: the packets are built by hand over node:net. The TLS variant is not here; run it against the broker on this machine or on a
// trusted network, or behind a tunnel.
// =============================================================================
import net from "node:net";

export interface MqttOptions {
  host: string;
  port: number;
  clientId: string;
  username?: string;
  password?: string;
  keepAliveS?: number;
  /** The largest packet accepted, in bytes. */
  maxPacketBytes?: number;
}

export interface MqttSubscriber {
  stop(): void;
  /** True between a CONNACK and the loss of the connection. */
  connected(): boolean;
}

export type MqttHandler = (topic: string, payload: Buffer) => void;

function utf8(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  if (body.length > 65535) throw new Error("MQTT string too long");
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

export function remainingLength(length: number): Buffer {
  const bytes: number[] = [];
  let value = length;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

function packet(firstByte: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([firstByte]), remainingLength(body.length), body]);
}

export function connectPacket(options: MqttOptions): Buffer {
  let flags = 0x02; // clean session
  const keepAlive = options.keepAliveS ?? 30;
  const payload: Buffer[] = [utf8(options.clientId)];
  if (options.username !== undefined) {
    flags |= 0x80;
    payload.push(utf8(options.username));
    if (options.password !== undefined) {
      flags |= 0x40;
      payload.push(utf8(options.password));
    }
  }
  const header = Buffer.from([4, flags, (keepAlive >> 8) & 0xff, keepAlive & 0xff]);
  return packet(0x10, Buffer.concat([utf8("MQTT"), header, ...payload]));
}

export function subscribePacket(id: number, filters: readonly string[]): Buffer {
  const body: Buffer[] = [Buffer.from([(id >> 8) & 0xff, id & 0xff])];
  for (const filter of filters) body.push(utf8(filter), Buffer.from([0]));
  return packet(0x82, Buffer.concat(body));
}

/** Pull the whole packets out of a buffer; returns the packets and what is left. Throws on a length that cannot be valid. */
export function splitPackets(buffer: Buffer, maxBytes: number): { packets: Array<{ type: number; flags: number; body: Buffer }>; rest: Buffer } {
  const packets: Array<{ type: number; flags: number; body: Buffer }> = [];
  let offset = 0;
  while (offset < buffer.length) {
    let multiplier = 1;
    let length = 0;
    let index = offset + 1;
    let complete = false;
    for (let i = 0; i < 4; i += 1) {
      if (index >= buffer.length) break;
      const digit = buffer[index++]!;
      length += (digit & 0x7f) * multiplier;
      multiplier *= 128;
      if ((digit & 0x80) === 0) {
        complete = true;
        break;
      }
      if (i === 3) throw new Error("MQTT remaining length is malformed");
    }
    if (!complete) break;
    if (length > maxBytes) throw new Error("MQTT packet larger than the limit");
    if (index + length > buffer.length) break;
    const first = buffer[offset]!;
    packets.push({ type: first >> 4, flags: first & 0x0f, body: buffer.subarray(index, index + length) });
    offset = index + length;
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** The topic, the payload and the packet id (for QoS 1) of a PUBLISH body. */
export function parsePublish(flags: number, body: Buffer): { topic: string; payload: Buffer; qos: number; id: number } {
  const qos = (flags >> 1) & 0x03;
  if (qos > 1 || body.length < 2) throw new Error("unsupported or short PUBLISH");
  const topicLength = body.readUInt16BE(0);
  if (2 + topicLength > body.length) throw new Error("short PUBLISH topic");
  const topic = body.toString("utf8", 2, 2 + topicLength);
  let offset = 2 + topicLength;
  let id = 0;
  if (qos === 1) {
    if (offset + 2 > body.length) throw new Error("short PUBLISH id");
    id = body.readUInt16BE(offset);
    offset += 2;
  }
  return { topic, payload: body.subarray(offset), qos, id };
}

/** Follow `filters` on the broker; `onMessage` gets every PUBLISH. Reconnects until `stop()`. */
export function subscribe(options: MqttOptions, filters: readonly string[], onMessage: MqttHandler, onState?: (connected: boolean, reason?: string) => void): MqttSubscriber {
  const maxBytes = options.maxPacketBytes ?? 256 * 1024;
  let socket: net.Socket | null = null;
  let stopped = false;
  let isConnected = false;
  let pause = 1000;
  let retry: NodeJS.Timeout | null = null;
  let ping: NodeJS.Timeout | null = null;

  const setConnected = (value: boolean, reason?: string): void => {
    if (isConnected !== value) {
      isConnected = value;
      onState?.(value, reason);
    }
  };

  const open = (): void => {
    if (stopped) return;
    let pending: Buffer = Buffer.alloc(0);
    const current = net.connect({ host: options.host, port: options.port });
    socket = current;
    current.setNoDelay(true);
    current.on("connect", () => current.write(connectPacket(options)));
    current.on("data", (chunk: Buffer) => {
      try {
        const { packets, rest } = splitPackets(Buffer.concat([pending, chunk]), maxBytes);
        pending = Buffer.from(rest);
        for (const item of packets) {
          if (item.type === 2) {
            if (item.body.length < 2 || item.body[1] !== 0) {
              current.destroy(new Error(`the broker refused the connection (code ${item.body[1] ?? "?"})`));
              return;
            }
            current.write(subscribePacket(1, filters));
            setConnected(true);
            pause = 1000;
            const every = Math.max(1, (options.keepAliveS ?? 30) / 2) * 1000;
            if (ping) clearInterval(ping);
            ping = setInterval(() => current.write(Buffer.from([0xc0, 0])), every);
            ping.unref();
          } else if (item.type === 3) {
            const message = parsePublish(item.flags, item.body);
            if (message.qos === 1) current.write(Buffer.from([0x40, 2, (message.id >> 8) & 0xff, message.id & 0xff]));
            onMessage(message.topic, Buffer.from(message.payload));
          }
        }
      } catch (error) {
        current.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    current.on("error", (error) => setConnected(false, error.message));
    current.on("close", () => {
      if (ping) clearInterval(ping);
      ping = null;
      setConnected(false, "closed");
      if (stopped) return;
      retry = setTimeout(open, pause);
      retry.unref();
      pause = Math.min(pause * 2, 30000);
    });
  };

  open();
  return {
    stop(): void {
      stopped = true;
      if (retry) clearTimeout(retry);
      if (ping) clearInterval(ping);
      socket?.destroy();
    },
    connected: () => isConnected,
  };
}
