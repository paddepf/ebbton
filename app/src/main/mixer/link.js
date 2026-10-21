'use strict';

/**
 * Hält die Verbindung zum Mischpult passend zu den Einstellungen: echtes Pult unter `host`, oder –
 * ohne Adresse, aber mit simuliertem Mehrspur-Gerät – den eingebauten Pult-Simulator.
 * Bewertet außerdem das Routing der Kartenausgänge gegenüber der Aufnahmeart.
 *
 * Ereignis: 'change' (state()).
 */

const { EventEmitter } = require('events');
const { MixerClient } = require('./client');
const { MixerSimulator, ROUTING_MULTITRACK, ROUTING_STEREO } = require('./simulator');
const M32 = require('./m32');

class MixerLink extends EventEmitter {
  constructor() {
    super();
    this.key = '';
    this.client = null;
    this.sim = null;
  }

  /** @param {{host?:string, simulate?:boolean}} o */
  async configure({ host = '', simulate = false } = {}) {
    const h = String(host || '').trim();
    const key = h || (simulate ? 'sim' : '');
    if (key === this.key) return;
    this._teardown();
    this.key = key;
    if (key === 'sim') {
      this.sim = new MixerSimulator();
      const port = await this.sim.start();
      if (this.key !== 'sim') { this.sim.stop(); return; }      // inzwischen umgestellt
      this.client = new MixerClient({ host: '127.0.0.1', port });
    } else if (key) {
      this.client = new MixerClient({ host: key });
    }
    if (this.client) {
      this.client.on('change', () => this.emit('change', this.state()));
      this.client.on('error', (err) => console.warn('Mischpult:', err.message));
      this.client.start();
    }
    this.emit('change', this.state());
  }

  _teardown() {
    if (this.client) this.client.stop();
    if (this.sim) this.sim.stop();
    this.client = null;
    this.sim = null;
  }

  stop() {
    this._teardown();
    this.key = '';
  }

  get connected() {
    return Boolean(this.client && this.client.status === 'connected');
  }

  state() {
    if (!this.client) return { configured: false, simulated: false, status: 'off', channels: [], routing: null, info: null };
    return { configured: true, simulated: Boolean(this.sim), ...this.client.snapshot() };
  }

  /** Kanalname am Pult (Kanal 0-basiert); leer, wenn unbekannt oder nicht verbunden. */
  channel(c) {
    if (!this.connected) return { name: '', color: null };
    return this.client.channels[c] || { name: '', color: null };
  }

  /**
   * Passt das Routing der Kartenausgänge zur Aufnahmeart?
   * @param {'stereo'|'multitrack'} mode
   * @param {{stereo?:number[], multitrack?:number[]}} [learned] angelernte Routings
   * @returns {{status:'ok'|'mismatch'|'unknown'|'off', kind:string, learned:boolean, labels:string[]|null}}
   */
  evaluate(mode, learned) {
    const st = this.state();
    if (!st.configured) return { status: 'off', kind: 'unknown', learned: false, labels: null };
    if (st.status !== 'connected' || !st.routing) return { status: 'unknown', kind: 'unknown', learned: false, labels: null };
    const { kind, learned: fromLearned } = M32.routingKind(st.routing, learned);
    const labels = st.routing.map((v, i) => `${M32.CARD_BLOCKS[i]}: ${M32.routingLabel(v)}`);
    const status = kind === 'unknown' ? 'unknown' : (kind === mode ? 'ok' : 'mismatch');
    return { status, kind, learned: fromLearned, labels };
  }

  /** Nur Simulator: Routing umstellen wie am Pult (zum Ausprobieren der Warnung). */
  simulateRouting(kind) {
    if (!this.sim) return false;
    this.sim.setRouting(kind === 'stereo' ? ROUTING_STEREO : ROUTING_MULTITRACK);
    return true;
  }
}

module.exports = { MixerLink };
