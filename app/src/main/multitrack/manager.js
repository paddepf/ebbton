'use strict';

/**
 * Hauptprozess-Seite der Mehrspuraufnahme: startet den Mehrspur-Prozess (`host.js` als Electron
 * `utilityProcess`) und spricht über Nachrichten mit ihm. Stürzt der Hauptprozess oder die
 * Oberfläche, nimmt der Mehrspur-Prozess weiter auf; stürzt er selbst, meldet 'exit' das.
 *
 * Ereignisse: alle der Engine (siehe `engine.js`) sowie 'exit' ({code, wasRecording}).
 */

const path = require('path');
const { EventEmitter } = require('events');

const TIMEOUT_MS = 15000;
// Starten (ASIO-Treiber öffnen) und Beenden (32 Spuren zu Ende schreiben, fdatasync) dürfen länger dauern: Ein
// zu früh abgebrochenes `start` hinterließe eine verwaiste Aufnahme im Prozess, ein abgebrochenes `stop` ein
// „läuft noch“ im Hauptprozess.
const START_TIMEOUT_MS = 60000;
const STOP_TIMEOUT_MS = 300000;

class MultitrackManager extends EventEmitter {
  /** @param {{fork?: Function}} [o] fork: Ersatz für `utilityProcess.fork` (Tests) */
  constructor({ fork } = {}) {
    super();
    this.fork = fork || ((...a) => require('electron').utilityProcess.fork(...a));
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.recording = false;
  }

  _ensure() {
    if (this.child) return this.child;
    const child = this.fork(path.join(__dirname, 'host.js'), [], { serviceName: 'Ebbton Mehrspur', stdio: 'inherit' });
    child.on('message', (msg) => this._onMessage(msg));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      const wasRecording = this.recording;
      this.recording = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error('Der Mehrspur-Prozess wurde beendet.'));
      }
      this.pending.clear();
      this.emit('exit', { code, wasRecording });
    });
    this.child = child;
    return child;
  }

  _onMessage(msg) {
    if (!msg) return;
    if (msg.event) {
      this.emit(msg.event, msg.data);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  }

  _call(cmd, args, timeoutMs = TIMEOUT_MS) {
    const child = this._ensure();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(`Mehrspur-Prozess antwortet nicht (${cmd}).`);
        err.timeout = true;
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.postMessage({ id, cmd, args });
    });
  }

  devices(opts) {
    return this._call('devices', opts);
  }

  async start(opts) {
    let result;
    try {
      result = await this._call('start', opts, START_TIMEOUT_MS);
    } catch (err) {
      // Kommt die Antwort doch noch, liefe die Aufnahme im Prozess ohne Session weiter: hinterher beenden.
      if (err.timeout) this._call('stop', undefined, STOP_TIMEOUT_MS).catch(() => {});
      throw err;
    }
    this.recording = true;
    return result;
  }

  /** Gerät zum Abhören öffnen (Pegel ohne Aufnahme); eine spätere Aufnahme übernimmt den Strom. */
  monitor(opts) {
    return this._call('monitor', opts);
  }

  /** Abhören beenden (nur wenn der Prozess läuft; eine laufende Aufnahme bleibt unberührt). */
  unmonitor() {
    return this.child ? this._call('unmonitor') : Promise.resolve(true);
  }

  /** Zurückspielen über die Ausgänge (siehe engine.play). */
  play(opts) {
    return this._call('play', opts);
  }

  seek(seconds) {
    return this._call('seek', { seconds });
  }

  setLoop(loop) {
    return this._call('loop', { loop });
  }

  stopPlayback() {
    return this.child ? this._call('stopPlayback') : Promise.resolve({ playing: false });
  }

  pause() {
    return this._call('pause');
  }

  resume() {
    return this._call('resume');
  }

  async stop() {
    if (!this.child) return null;
    const result = await this._call('stop', undefined, STOP_TIMEOUT_MS);
    this.recording = false;
    return result;
  }

  /** Stellvertreter für den Schreiber der Session (nach erfolgreichem `start`). */
  writer(info) {
    return new TrackWriterProxy(this, info);
  }

  /** Beendet den Prozess (nur ohne laufende Aufnahme). */
  dispose() {
    if (this.child && !this.recording) {
      this.child.kill();
      this.child = null;
    }
  }
}

/**
 * Steht in der Session an der Stelle des WAV-Schreibers (dieselben Teile der Schnittstelle, die die Session
 * nutzt): Dauer, Pause, Schließen, Ereignisse 'error' und 'slow'. Das Audio selbst schreibt der Mehrspur-Prozess.
 */
class TrackWriterProxy extends EventEmitter {
  constructor(manager, info = {}) {
    super();
    this.manager = manager;
    this.sampleRate = info.sampleRate;
    this.durationSeconds = info.seconds || 0;
    this.closed = false;
    this._listeners = {
      levels: (l) => { if (!this.closed && l && typeof l.seconds === 'number') this.durationSeconds = l.seconds; },
      'write-error': (e) => this.emit('error', e),
      slow: (slow) => this.emit('slow', slow)
    };
    for (const [ev, fn] of Object.entries(this._listeners)) manager.on(ev, fn);
  }

  write() { /* Audio kommt nicht über den Hauptprozess */ }
  updateHeader() { /* schreibt der Mehrspur-Prozess selbst alle 2 s */ }

  pause() {
    return this.manager.pause().catch((err) => this.emit('error', { message: err.message }));
  }

  resume() {
    return this.manager.resume().catch((err) => this.emit('error', { message: err.message }));
  }

  _detach() {
    for (const [ev, fn] of Object.entries(this._listeners)) this.manager.off(ev, fn);
  }

  /**
   * Der Mehrspur-Prozess ist abgestürzt: Dieser Stellvertreter gilt nicht mehr (Dauer bleibt stehen, `close` hat
   * nichts mehr zu beenden). Ein neu gestarteter Prozess bekommt einen eigenen (`Session.replaceWriter`).
   */
  abandon() {
    if (this._closing) return;
    this.closed = true;
    this._detach();
    this._closing = Promise.resolve(null);
  }

  /** Beendet die Aufnahme im Mehrspur-Prozess; erfüllt sich, wenn alles auf der Platte ist. */
  close() {
    if (this._closing) return this._closing;
    this.closed = true;
    const detach = () => this._detach();
    this._closing = this.manager.stop().then((res) => {
      if (res) this.durationSeconds = res.seconds;
      detach();
      return res;
    }, (err) => {
      detach();
      this.emit('error', { message: err.message });
      return null;
    });
    return this._closing;
  }
}

module.exports = { MultitrackManager, TrackWriterProxy };
