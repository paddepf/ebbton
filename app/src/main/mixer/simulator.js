'use strict';

/**
 * Nachgebautes M32 für Entwicklung und Tests: beantwortet dieselben OSC-Abfragen wie das Pult
 * (/xinfo, Kanalnamen und -farben, Routing der Kartenausgänge), nimmt Änderungen an und meldet
 * sie wie das Pult an alle per /xremote angemeldeten Gegenstellen.
 */

const dgram = require('dgram');
const osc = require('./osc');
const M32 = require('./m32');

const DEMO_NAMES = [
  'Predigt', 'Moderation', 'Headset 1', 'Headset 2', 'Funk 1', 'Funk 2', 'Gesang 1', 'Gesang 2',
  'Gesang 3', 'Chor L', 'Chor R', 'Flügel L', 'Flügel R', 'E-Piano L', 'E-Piano R', 'Gitarre',
  'Bass', 'Kick', 'Snare', 'Tom', 'OH L', 'OH R', 'Cajon', 'Violine', 'Flöte', 'Kinder',
  'Zuspieler L', 'Zuspieler R', '', '', 'Raum L', 'Raum R'
];
const DEMO_COLORS = [1, 1, 3, 3, 3, 3, 2, 2, 2, 6, 6, 4, 4, 4, 4, 5, 5, 0, 0, 0, 0, 0, 0, 7, 7, 3, 9, 9, 0, 0, 8, 8];
const ROUTING_MULTITRACK = [0, 1, 2, 3];      // AN1-8 … AN25-32: einzelne Kanäle
const ROUTING_STEREO = [20, 1, 2, 3];         // OUT1-8 (Matrix auf 1–2) …

class MixerSimulator {
  constructor({ name = 'Ebbton-Simulator', routing = ROUTING_MULTITRACK } = {}) {
    this.name = name;
    this.values = new Map();
    for (let ch = 1; ch <= M32.CHANNELS; ch++) {
      this.values.set(M32.namePath(ch), [DEMO_NAMES[ch - 1] || '']);
      this.values.set(M32.colorPath(ch), [DEMO_COLORS[ch - 1] || 0]);
    }
    M32.CARD_BLOCKS.forEach((b, i) => this.values.set(M32.routingPath(b), [routing[i]]));
    this.subscribers = new Map();   // "ip:port" → gültig bis
    this.silent = false;            // true: antwortet nicht (Pult aus)
  }

  /** @returns {Promise<number>} Port */
  start(port = 0, host = '127.0.0.1') {
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (buf, rinfo) => this._onMessage(buf, rinfo));
    return new Promise((resolve) => this.socket.bind(port, host, () => {
      this.port = this.socket.address().port;
      this.host = host;
      resolve(this.port);
    }));
  }

  stop() {
    try { this.socket.close(); } catch { /* schon zu */ }
  }

  _reply(rinfo, address, args) {
    this.socket.send(osc.encode(address, args), rinfo.port, rinfo.address);
  }

  _onMessage(buf, rinfo) {
    if (this.silent) return;
    let msg;
    try { msg = osc.decode(buf); } catch { return; }
    const { address, args } = msg;
    if (address === '/xinfo') {
      this._reply(rinfo, '/xinfo', [this.host, this.name, 'M32', '4.06']);
    } else if (address === '/xremote') {
      this.subscribers.set(`${rinfo.address}:${rinfo.port}`, Date.now() + 10000);
    } else if (this.values.has(address)) {
      if (args.length) this.set(address, args);
      else this._reply(rinfo, address, this.values.get(address));
    }
  }

  /** Wert ändern wie am Pult; angemeldete Gegenstellen bekommen die Änderung. */
  set(address, args) {
    this.values.set(address, args);
    const now = Date.now();
    for (const [key, until] of this.subscribers) {
      if (until < now) { this.subscribers.delete(key); continue; }
      const [ip, port] = key.split(':');
      this.socket.send(osc.encode(address, args), Number(port), ip);
    }
  }

  setName(ch, name) { this.set(M32.namePath(ch), [name]); }
  setRouting(blocks) { M32.CARD_BLOCKS.forEach((b, i) => this.set(M32.routingPath(b), [blocks[i]])); }
}

module.exports = { MixerSimulator, ROUTING_MULTITRACK, ROUTING_STEREO };
