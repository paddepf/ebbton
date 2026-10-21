'use strict';

/**
 * Mehrspur-Engine: öffnet das Gerät (unter Windows per ASIO), nimmt die gewählten Kanäle auf,
 * meldet Pegel und erkennt Aussetzer. Läuft im eigenen Prozess (siehe `host.js`), damit weder
 * der Hauptprozess noch die Oberfläche die Aufnahme ausbremsen.
 *
 * Gerät: `audify` (RtAudio). Unter Windows ASIO (nur dort kommen alle 32 Kanäle der DN32-USB an),
 * sonst die Standard-Schnittstelle des Systems. `simulate` nimmt stattdessen das nachgebaute Pult.
 * Der Strom wird mit Ausgängen geöffnet, wenn das Gerät welche hat: ASIO lässt meist nur einen
 * Strom je Gerät zu, das spätere Zurückspielen muss also über denselben Strom laufen.
 *
 * Aussetzer: audify meldet Überläufe des Treibers nicht. Deshalb zwei eigene Prüfungen:
 * - Kommt 1 s lang kein Block, gilt der Eingang als hängend ('stall'); nach 3 s wird das Gerät
 *   neu geöffnet (wiederholt, bis es klappt), geschrieben wird in dieselben Dateien weiter.
 *   Kommt wieder Audio, folgt 'gap' mit Stelle und Länge.
 * - Fehlen gegenüber der Uhr dauerhaft mehr als 0,25 s Audio (über ein 5-s-Fenster, damit
 *   Uhrendrift und verspätete Blöcke nicht zählen), folgt ebenfalls 'gap'.
 *
 * Ereignisse: 'levels' ({peaks, clips, buckets, seconds}), 'stall' ({at, recording}), 'gap' ({at, seconds, recording}), 'reopen' ({ok, error}),
 * 'device-error' / 'device-warning' ({type, message}), 'write-error', 'slow', 'playback' (playInfo()).
 */

const { EventEmitter } = require('events');
const { MultiWavWriter } = require('./writer');
const { SimulatedAudio, SIM_DEVICE_ID } = require('./simulator');
const { Player } = require('./player');

const FORMAT_SINT32 = 0x8;
const LEVEL_EVERY_MS = 50;
const WATCH_EVERY_MS = 250;
const STALL_MS = 1000;
const REOPEN_AFTER_MS = 3000;
const GAP_MIN_SECONDS = 0.25;
const DRIFT_WINDOW_MS = 5000;
const CLIP = 2147483647 * 0.999;   // etwa -0,01 dBFS
const DEFAULT_FRAME_SIZE = 512;
const PLAY_AHEAD_SECONDS = 0.15;  // so viel Audio liegt beim Abspielen in der Ausgabe bereit
const BUCKET_MS = 50;              // Wellenform: ein Spitzenwert je 50 ms (wie PEAK_BUCKET_MS der Session)
const ERROR_DEBUG_WARNING = 1;     // RtAudioErrorType: 0 WARNING, 1 DEBUG_WARNING, ab 2 Fehler

let audify = null;
function loadAudify() {
  if (!audify) audify = require('audify');
  return audify;
}

/** Erzeugt die Geräte-Schnittstelle. Windows: ASIO, sonst Systemstandard. */
function defaultBackend(simulate) {
  if (simulate) return new SimulatedAudio();
  const { RtAudio, RtAudioApi } = loadAudify();
  return new RtAudio(process.platform === 'win32' ? RtAudioApi.WINDOWS_ASIO : RtAudioApi.UNSPECIFIED);
}

class MultitrackEngine extends EventEmitter {
  /** @param {{createBackend?: (simulate:boolean)=>object, now?: ()=>number}} [o] */
  constructor({ createBackend = defaultBackend, now = () => performance.now() } = {}) {
    super();
    this.createBackend = createBackend;
    this.now = now;
    this.backend = null;
    this.writer = null;
    this.opened = false;           // Gerät offen (Pegel laufen)
    this.running = false;          // Aufnahme läuft (auch pausiert)
    this.monitorWanted = false;    // Gerät auch ohne Aufnahme offen halten (Pegel vor dem Start)
  }

  /** Geräte der Schnittstelle (bzw. das simulierte Pult). Bei offenem Gerät über dieselbe Verbindung. */
  devices({ simulate = false } = {}) {
    const b = this.opened && !!this.opts.simulate === simulate ? this.backend : this.createBackend(simulate);
    return {
      api: b.getApi(),
      devices: b.getDevices().map((d) => ({
        id: d.id,
        name: d.name,
        inputs: d.inputChannels,
        outputs: d.outputChannels,
        sampleRates: d.sampleRates,
        preferredSampleRate: d.preferredSampleRate,
        isDefault: Boolean(d.isDefaultInput)
      }))
    };
  }

  /**
   * Öffnet das Gerät (Pegel laufen, geschrieben wird nichts). Ist es mit denselben Werten schon offen,
   * bleibt es offen – ASIO erlaubt nur einen Strom, Abhören und Aufnahme teilen ihn sich.
   * @param {object} o
   * @param {number} o.deviceId
   * @param {boolean} [o.simulate]
   * @param {number} [o.sampleRate] Standard: bevorzugte Rate des Geräts
   * @param {number} [o.frameSize] 0 = Puffergröße des Treibers (bei ASIO so gewollt)
   */
  open(o) {
    const same = this.opened && this.opts.deviceId === o.deviceId && !!this.opts.simulate === !!o.simulate
      // Ohne Angabe gilt die bevorzugte Rate – sonst bliebe die Rate eines vorher abgespielten oder
      // angehängten Mitschnitts für die nächste neue Aufnahme hängen.
      && (o.sampleRate || this.device.preferredSampleRate || 48000) === this.opts.sampleRate;
    if (same) return this.info();
    if (this.running) throw new Error('Während der Aufnahme kann das Gerät nicht gewechselt werden.');
    this._shutdown();

    const backend = this.createBackend(!!o.simulate);
    const device = backend.getDevices().find((d) => d.id === o.deviceId);
    if (!device) throw new Error('Das Audiogerät wurde nicht gefunden.');
    if (!device.inputChannels) throw new Error(`„${device.name}“ hat keine Eingänge.`);
    const sampleRate = o.sampleRate || device.preferredSampleRate || 48000;

    this.opts = { deviceId: o.deviceId, simulate: !!o.simulate, sampleRate, frameSize: o.frameSize };
    this.device = device;
    this.inputs = device.inputChannels;
    this.outputs = device.outputChannels;
    this.backend = backend;
    this.frameSize = this._open();

    this.opened = true;
    this.paused = false;
    this.framesIn = 0;
    this.peaks = new Float64Array(this.inputs);
    this.clips = new Uint8Array(this.inputs);
    this.armed = new Int32Array(0);
    this.bucketSize = Math.round((sampleRate * BUCKET_MS) / 1000);
    this.bucketAcc = 0;
    this.bucketFill = 0;
    this.buckets = [];
    this.stalledAt = null;
    this.lastReopen = null;
    this.lastChunkAt = this.now();
    this._resetClock(this.lastChunkAt);
    this.history = [];
    this._levelTimer = setInterval(() => this._emitLevels(), LEVEL_EVERY_MS);
    this._watchTimer = setInterval(() => this._watch(), WATCH_EVERY_MS);
    return this.info();
  }

  info() {
    if (!this.opened) return null;
    return {
      device: this.device.name, api: this.backend.getApi(), sampleRate: this.opts.sampleRate, frameSize: this.frameSize,
      inputs: this.inputs, outputs: this.outputs, simulate: this.opts.simulate,
      recording: this.running, seconds: this.seconds
    };
  }

  /** Abhören: Gerät offen halten, auch ohne Aufnahme (Pegel vor dem Start). */
  monitor(o) {
    this.monitorWanted = true;
    return this.open(o);
  }

  /** Abhören beenden; eine laufende Aufnahme bleibt davon unberührt (das Gerät schließt danach). */
  unmonitor() {
    this.monitorWanted = false;
    if (!this.running) this._shutdown();
    return true;
  }

  /**
   * Startet die Aufnahme (öffnet das Gerät, falls es nicht schon zum Abhören offen ist).
   * @param {object} o wie `open`, dazu:
   * @param {{channel:number, file:string}[]} o.tracks
   * @param {boolean} [o.append] an die vorhandenen Spurdateien anhängen
   */
  start(o) {
    if (this.running) throw new Error('Mehrspuraufnahme läuft bereits.');
    this.stopPlayback();                  // Aufnehmen hat Vorrang vor dem Zurückspielen
    const wasOpen = this.opened;
    this.open(o);
    try {
      // Erst die Dateien: Scheitert das, bleibt alles wie vorher.
      this.writer = new MultiWavWriter({ sampleRate: this.opts.sampleRate, deviceChannels: this.inputs, tracks: o.tracks, append: !!o.append });
    } catch (err) {
      this.writer = null;
      if (!wasOpen && !this.monitorWanted) this._shutdown();
      throw err;
    }
    this.writer.on('error', (e) => this.emit('write-error', e));
    this.writer.on('slow', (s) => this.emit('slow', s));

    this.running = true;
    this.paused = false;
    this.gaps = [];
    this.armed = Int32Array.from(o.tracks.map((t) => t.channel));
    this.bucketAcc = 0;
    this.bucketFill = 0;
    this.buckets = [];
    this.history = [];
    this._resetClock(this.now());
    return this.info();
  }

  _open() {
    const b = this.backend;
    const input = { deviceId: this.device.id, nChannels: this.inputs, firstChannel: 0 };
    const output = this.outputs ? { deviceId: this.device.id, nChannels: this.outputs, firstChannel: 0 } : null;
    // ASIO: 0 = Puffergröße aus dem Treiber-Panel. Andere Schnittstellen nähmen sonst winzige Puffer (CoreAudio: 15 Frames).
    const frameSize = this.opts.frameSize || (process.platform === 'win32' ? 0 : DEFAULT_FRAME_SIZE);
    const actual = b.openStream(output, input, FORMAT_SINT32, this.opts.sampleRate, frameSize, 'Ebbton',
      (buf) => this._onInput(buf), output ? () => this._onFrameOut() : null, 0,
      (type, message) => {
        // RtAudio meldet beim Aufräumen nicht mehr benötigter Verbindungen „no open stream to close“ – harmlos
        // (audify reicht Meldungen aller Verbindungen an den zuletzt gesetzten Empfänger weiter).
        if (/no open stream to close/i.test(message)) return;
        this.emit(type > ERROR_DEBUG_WARNING ? 'device-error' : 'device-warning', { type, message });
      });
    try {
      b.start();
    } catch (err) {
      this._close(b);
      throw err;
    }
    return actual;
  }

  _onInput(buf) {
    if (!this.opened) return;
    const t = this.now();
    this.lastChunkAt = t;
    if (this.stalledAt != null) {
      const seconds = (t - this.stalledAt.time) / 1000;
      if (this.running) this.gaps.push({ at: this.stalledAt.at, seconds, kind: 'stall' });
      this.emit('gap', { at: this.stalledAt.at, seconds, recording: this.running });
      this.stalledAt = null;
      this.lastReopen = null;
      this.history = [];
      this._resetClock(t);
    }
    // In der Pause und beim Abhören läuft das Gerät (Pegel, Wächter), geschrieben wird nicht.
    if (this.running && !this.paused) this.writer.write(buf);
    this.framesIn += buf.length / (this.inputs * 4);
    this._measure(buf);
  }

  /**
   * Spitzenpegel je Kanal seit der letzten Meldung; außerhalb der Pause zusätzlich die Wellenform
   * (Spitzenwert über alle aufgenommenen Spuren je 50 ms, 0..255 wie bei der Stereoaufnahme).
   */
  _measure(buf) {
    const ch = this.inputs;
    const view = buf.byteOffset % 4 === 0
      ? new Int32Array(buf.buffer, buf.byteOffset, buf.length >> 2)
      : new Int32Array(Uint8Array.from(buf).buffer);
    const frames = Math.floor(view.length / ch);
    const { peaks, clips, armed } = this;
    const wave = this.running && !this.paused;
    for (let f = 0; f < frames; f++) {
      const base = f * ch;
      for (let c = 0; c < ch; c++) {
        let v = view[base + c];
        if (v < 0) v = -v;
        if (v > peaks[c]) peaks[c] = v;
        if (v >= CLIP) clips[c] = 1;
      }
      if (!wave) continue;
      for (let a = 0; a < armed.length; a++) {
        let v = view[base + armed[a]];
        if (v < 0) v = -v;
        if (v > this.bucketAcc) this.bucketAcc = v;
      }
      if (++this.bucketFill >= this.bucketSize) {
        this.buckets.push(Math.min(255, Math.round((this.bucketAcc / 2147483648) * 255)));
        this.bucketAcc = 0;
        this.bucketFill = 0;
      }
    }
  }

  _emitLevels() {
    this.emit('levels', {
      peaks: Array.from(this.peaks, (p) => Math.round((p / 2147483648) * 10000) / 10000),
      clips: Array.from(this.clips, Boolean),
      buckets: this.buckets,
      seconds: this.seconds,
      play: this.playInfo()
    });
    this.peaks.fill(0);
    this.clips.fill(0);
    this.buckets = [];
  }

  /** Pause: Gerät bleibt offen, es wird nur nicht geschrieben. */
  pause() {
    if (!this.running) return false;
    this.paused = true;
    this.bucketAcc = 0;
    this.bucketFill = 0;
    return true;
  }

  resume() {
    if (!this.running) return false;
    this.paused = false;
    return true;
  }

  /** Aufgenommene Sekunden (je Spur). */
  get seconds() {
    return this.writer ? this.writer.durationSeconds : 0;
  }

  _resetClock(t) {
    this.startedAt = t;
    this.framesAtStart = this.framesIn;
  }

  _watch() {
    const t = this.now();
    if (t - this.lastChunkAt > STALL_MS) {
      if (this.stalledAt == null) {
        this.stalledAt = { time: this.lastChunkAt, at: this.seconds };
        this.emit('stall', { at: this.seconds, recording: this.running });
      }
      if (t - (this.lastReopen || this.stalledAt.time) > REOPEN_AFTER_MS) this._reopen(t);
      return;
    }
    // Fehlbetrag gegenüber der Uhr, über ein Fenster beobachtet (nur während der Aufnahme von Belang).
    if (!this.running) {
      this.history = [];
      this._resetClock(t);
      return;
    }
    const expected = ((t - this.startedAt) / 1000) * this.opts.sampleRate;
    const deficit = expected - (this.framesIn - (this.framesAtStart || 0));
    this.history.push({ t, deficit });
    while (this.history.length && t - this.history[0].t > DRIFT_WINDOW_MS + 1000) this.history.shift();
    if (t - this.history[0].t < DRIFT_WINDOW_MS) return;
    // Kleinster Fehlbetrag der letzten Sekunde gegen den kleinsten am Fensteranfang: verspätete Blöcke zählen so nicht.
    const recent = Math.min(...this.history.filter((h) => t - h.t <= 1000).map((h) => h.deficit));
    const old = Math.min(...this.history.filter((h) => h.t - this.history[0].t <= 1000).map((h) => h.deficit));
    const missing = (recent - old) / this.opts.sampleRate;
    if (missing > GAP_MIN_SECONDS) {
      this.gaps.push({ at: this.seconds, seconds: missing, kind: 'drop' });
      this.emit('gap', { at: this.seconds, seconds: missing, recording: true });
      this.history = [];
      this._resetClock(t);
    }
  }

  _reopen(t) {
    this.lastReopen = t;
    this._close(this.backend);
    try {
      // Bei ASIO kann ein neues Objekt nötig sein, wenn der Treiber weg war (Pult aus und wieder an).
      this.backend = this.createBackend(!!this.opts.simulate);
      const device = this.backend.getDevices().find((d) => d.name === this.device.name);
      if (!device) throw new Error(`„${this.device.name}“ ist nicht verfügbar.`);
      if (device.inputChannels !== this.inputs) throw new Error(`„${device.name}“ meldet jetzt ${device.inputChannels} statt ${this.inputs} Eingänge.`);
      this.device = device;
      this.frameSize = this._open();
      if (this.player) {
        // Die Ausgabe-Warteschlange des alten Stroms ist weg; nachgelegt wird sonst nur nach verbrauchten Blöcken.
        this.playQueue = [];
        this._fillOutput();
      }
      this.emit('reopen', { ok: true });
    } catch (err) {
      this.emit('reopen', { ok: false, error: err.message });
    }
  }

  _close(b) {
    try { if (b.isStreamRunning()) b.stop(); } catch { /* egal */ }
    try { if (b.isStreamOpen()) b.closeStream(); } catch { /* egal */ }
  }

  /* ---------------------------------------------------------------- Zurückspielen */

  /**
   * Spielt Spuren über die Ausgänge (Spur auf Kanal k → Ausgang k). Nicht während einer Aufnahme.
   * @param {{tracks:{channel:number, file:string}[], start?:number, loop?:{start:number, end:number}|null}} o Sekunden
   */
  play({ tracks, start = 0, loop = null }) {
    if (!this.opened) throw new Error('Das Gerät ist nicht offen.');
    if (this.running) throw new Error('Während der Aufnahme wird nicht abgespielt.');
    if (!this.outputs) throw new Error(`„${this.device.name}“ hat keine Ausgänge.`);
    this.stopPlayback({ quiet: true });
    const player = new Player({ tracks, outputs: this.outputs, sampleRate: this.opts.sampleRate, blockFrames: this.frameSize });
    try {
      if (loop) player.setLoop(loop);
      player.seek(start);
    } catch (err) {
      player.close();
      throw err;
    }
    this.player = player;
    this.playQueue = [];                 // Anfangs-Frames der Blöcke, die in der Ausgabe liegen
    this.playHeard = player.pos;         // Frame, der gerade erklingt (ungefähr: Anfang des laufenden Blocks)
    this._fillOutput();
    this.emit('playback', this.playInfo());
    return this.playInfo();
  }

  /** Springen (Sekunden): die bereitliegenden Blöcke werden verworfen. */
  seek(seconds) {
    if (!this.player) return null;
    this.backend.clearOutputQueue();
    this.playQueue = [];
    this.player.seek(seconds);
    this.playHeard = this.player.pos;
    this._fillOutput();
    return this.playInfo();
  }

  setLoop(loop) {
    if (!this.player) return null;
    this.player.setLoop(loop);
    return this.playInfo();
  }

  stopPlayback({ quiet = false } = {}) {
    if (!this.player) return null;
    try { this.backend.clearOutputQueue(); } catch { /* Gerät schon zu */ }
    this.player.close();
    this.player = null;
    this.playQueue = [];
    if (!quiet) this.emit('playback', this.playInfo());
    return this.playInfo();
  }

  playInfo() {
    if (!this.player) return { playing: false };
    const rate = this.player.sampleRate;
    const loop = this.player.loop;
    return {
      playing: true,
      pos: this.playHeard / rate,
      length: this.player.length / rate,
      loop: loop ? { start: loop.start / rate, end: loop.end / rate } : null
    };
  }

  /** Blöcke nachlegen, bis etwa 150 ms bereitliegen. */
  _fillOutput() {
    const p = this.player;
    if (!p) return;
    const target = Math.max(2, Math.ceil((this.opts.sampleRate * PLAY_AHEAD_SECONDS) / this.frameSize));
    while (this.playQueue.length < target && !p.ended) {
      const { buf, startFrame } = p.nextBlock();
      try {
        this.backend.write(buf);
      } catch (err) {
        this.emit('device-error', { type: 'play', message: `Abspielen: ${err.message}` });
        this.stopPlayback();
        return;
      }
      this.playQueue.push(startFrame);
    }
  }

  /** Das Gerät hat einen Ausgabeblock verbraucht. */
  _onFrameOut() {
    if (!this.player) return;
    const start = this.playQueue.shift();
    if (start != null) this.playHeard = start;
    if (this.player.ended && this.playQueue.length === 0) {
      this.playHeard = this.player.length;
      this.stopPlayback();                 // zu Ende gespielt
      return;
    }
    this._fillOutput();
  }

  /** Gerät schließen, Zeitgeber anhalten. */
  _shutdown() {
    this.stopPlayback();
    clearInterval(this._levelTimer);
    clearInterval(this._watchTimer);
    if (this.backend) this._close(this.backend);
    this.opened = false;
  }

  /**
   * Beendet die Aufnahme; das Versprechen erfüllt sich, wenn alles auf der Platte ist.
   * Beim Abhören bleibt das Gerät offen, sonst wird es geschlossen.
   */
  async stop() {
    if (!this.running) return null;
    this.running = false;
    const writer = this.writer;
    this.writer = null;
    const sampleRate = this.opts.sampleRate;
    if (!this.monitorWanted) this._shutdown();
    const result = await writer.close();
    return { ...result, seconds: result.frames / sampleRate, files: writer.files, gaps: this.gaps };
  }
}

module.exports = { MultitrackEngine, SIM_DEVICE_ID };
