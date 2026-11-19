// Chopsticks Arena: MQTT 3.1.1 over secure WebSockets.
// These are unaffiliated, shared PUBLIC test brokers with no uptime guarantee.
// Only room codes, generated IDs, nicknames and game moves may be sent.
// All player browsers connect to all supported brokers so they can find an overlapping relay.
const DEFAULT_BROKERS = [
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://test.mosquitto.org:8081/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://demo.tbmq.io/mqtt', username: 'demo' }
];
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function mqttString(value) {
  const data = encoder.encode(value);
  if (data.length > 65535) throw new Error('MQTT string is too long');
  return Uint8Array.of(data.length >> 8, data.length & 255, ...data);
}
function concat(...items) {
  const out = new Uint8Array(items.reduce((total, a) => total + a.length, 0));
  let pos = 0;
  for (const part of items) { out.set(part, pos); pos += part.length; }
  return out;
}
function packet(kind, data) {
  let length = data.length;
  const size = [];
  do { let digit = length % 128; length = Math.floor(length / 128); if (length) digit |= 128; size.push(digit); } while (length);
  return concat(Uint8Array.of(kind, ...size), data);
}
function parse(data, onFrame) {
  let at = 0;
  while (at + 2 <= data.length) {
    const header = data[at];
    let length = 0, multiplier = 1, cursor = at + 1, complete = false;
    for (let n = 0; n < 4 && cursor < data.length; n++) {
      const digit = data[cursor++];
      length += (digit & 127) * multiplier;
      if (!(digit & 128)) { complete = true; break; }
      multiplier *= 128;
    }
    if (!complete) break;
    if (length > 65536) throw new Error('MQTT frame was too large');
    if (cursor + length > data.length) break;
    onFrame(header, data.subarray(cursor, cursor + length));
    at = cursor + length;
  }
  return data.subarray(at);
}
class MqttConnection {
  constructor(config, topic, clientId, WebSocketClass, status, onMessage) {
    this.url = config.url;
    this.username = config.username || null;
    this.topic = topic;
    this.clientId = clientId;
    this.WebSocketClass = WebSocketClass;
    this.status = status;
    this.onMessage = onMessage;
    this.socket = null;
    this.ready = false;
    this.closed = false;
    this.retry = null;
    this.timeout = null;
    this.ping = null;
    this.buffer = new Uint8Array();
    this.start();
  }
  start() {
    if (this.closed) return;
    this.ready = false;
    this.buffer = new Uint8Array();
    let ws;
    try { ws = new this.WebSocketClass(this.url, 'mqtt'); }
    catch { this.scheduleRetry(); return; }
    this.socket = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.closed || this.socket !== ws) return;
      try {
        // MQTT 3.1.1, clean session; username only for TBMQ's demo endpoint.
        const head = Uint8Array.of(0, 4, 77, 81, 84, 84, 4, this.username ? 0x82 : 0x02, 0, 30);
        const data = this.username ? concat(head, mqttString(this.clientId), mqttString(this.username)) : concat(head, mqttString(this.clientId));
        ws.send(packet(0x10, data));
      } catch { try { ws.close(); } catch {} }
    };
    ws.onmessage = event => {
      if (this.closed || this.socket !== ws) return;
      if (!(event.data instanceof ArrayBuffer)) return;
      try { this.buffer = parse(concat(this.buffer, new Uint8Array(event.data)), (type, data) => this.handle(type, data)); }
      catch { try { ws.close(); } catch {} }
    };
    ws.onerror = () => {}; // Many browsers expose no detailed error for WebSockets.
    ws.onclose = () => {
      if (this.closed || this.socket !== ws) return;
      this.socket = null;
      this.stopTimers();
      this.ready = false;
      this.status(false);
      this.scheduleRetry();
    };
    this.timeout = setTimeout(() => {
      if (!this.closed && this.socket === ws && !this.ready) try { ws.close(); } catch {}
    }, 9000);
  }
  stopTimers() {
    clearTimeout(this.timeout);
    clearInterval(this.ping);
    this.timeout = this.ping = null;
  }
  scheduleRetry() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, 3800);
  }
  handle(header, data) {
    const type = header >> 4;
    if (type === 2) { // CONNACK
      if (data.length < 2 || data[1] !== 0) { this.socket?.close(); return; }
      this.socket?.send(packet(0x82, concat(Uint8Array.of(0, 1), mqttString(this.topic), Uint8Array.of(0))));
    } else if (type === 9) { // SUBACK
      if (data.length < 3 || data[2] === 0x80) { this.socket?.close(); return; }
      this.ready = true;
      clearTimeout(this.timeout);
      this.status(true);
      clearInterval(this.ping);
      this.ping = setInterval(() => {
        if (this.ready && this.socket?.readyState === 1) {
          try { this.socket.send(Uint8Array.of(0xc0, 0)); } catch { this.socket?.close(); }
        }
      }, 12000);
    } else if (type === 3) { // PUBLISH
      if (data.length < 2) return;
      const count = (data[0] << 8) | data[1];
      if (2 + count > data.length) return;
      if (decoder.decode(data.subarray(2, 2 + count)) !== this.topic) return;
      let at = 2 + count;
      if (header & 6) { if (at + 2 > data.length) return; at += 2; }
      const payload = data.subarray(at);
      if (payload.length > 4096) return;
      try { this.onMessage(JSON.parse(decoder.decode(payload))); } catch {}
    }
  }
  send(msg) {
    if (!this.ready || this.socket?.readyState !== 1) return false;
    try {
      this.socket.send(packet(0x30, concat(mqttString(this.topic), msg)));
      return true;
    } catch { try { this.socket?.close(); } catch {} return false; }
  }
  close() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.retry);
    this.stopTimers();
    const ws = this.socket;
    this.socket = null;
    if (ws?.readyState === 1) try { ws.send(Uint8Array.of(0xe0, 0)); } catch {}
    try { ws?.close(); } catch {}
  }
}
export class Relay {
  constructor(code, clientId, onMessage, onStatus, options = {}) {
    if (!/^[A-F0-9]{12}$/.test(code)) throw new Error('Invalid room code');
    this.topic = `chopsticks/arena/v5/${code}`;
    this.ready = false;
    this.closed = false;
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.seen = new Map();
    // For tests, an explicit URL still creates one fake broker.
    const brokers = options.brokers || (options.url ? [{ url: options.url, username: options.username ?? 'demo' }] : DEFAULT_BROKERS);
    const WS = options.WebSocket || WebSocket;
    this.onStatus('connecting');
    this.links = brokers.map((config, i) => new MqttConnection(
      config, this.topic, `ca${String(clientId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16)}${i}`,
      WS, () => this.refreshStatus(), message => this.receive(message)
    ));
    this.unavailableTimer = setTimeout(() => {
      if (!this.ready && !this.closed) this.onStatus('unavailable');
    }, 19000);
  }
  refreshStatus() {
    if (this.closed || !this.links) return;
    const next = this.links.some(x => x.ready);
    if (next === this.ready) return;
    this.ready = next;
    if (next) {
      clearTimeout(this.unavailableTimer);
      this.onStatus('ready');
    } else {
      this.onStatus('disconnected');
      this.unavailableTimer = setTimeout(() => {
        if (!this.ready && !this.closed) this.onStatus('unavailable');
      }, 19000);
    }
  }
  receive(message) {
    // Broadcast to multiple public brokers, but deliver only one copy of each packet.
    let key;
    try { key = JSON.stringify(message); } catch { return; }
    if (key.length > 4096) return;
    const now = Date.now();
    if (now - (this.seen.get(key) || 0) < 1200) return;
    this.seen.set(key, now);
    if (this.seen.size > 150) {
      for (const [k, v] of this.seen) if (now - v > 10000) this.seen.delete(k);
      if (this.seen.size > 150) this.seen.clear();
    }
    this.onMessage(message);
  }
  send(message) {
    if (!this.ready) return false;
    const msg = encoder.encode(JSON.stringify(message));
    if (msg.length > 4096) return false;
    let sent = false;
    for (const link of this.links) if (link.send(msg)) sent = true;
    return sent;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    clearTimeout(this.unavailableTimer);
    for (const link of this.links || []) link.close();
    this.links = [];
  }
}
