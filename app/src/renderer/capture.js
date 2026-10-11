/* Audio-Erfassung: nimmt den gewählten Eingang ab und liefert
   Int16-Blöcke (interleaved, stereo) an den Hauptprozess. */

(function () {
  'use strict';

  const WORKLET_SOURCE = `
class RecProcessor extends AudioWorkletProcessor {
  constructor () {
    super();
    this.chunks = [];
    this.frames = 0;
    this.target = Math.round(sampleRate * 0.1); // 100 ms
    // Beim Beenden den angefangenen Block noch abgeben, sonst fehlen bis zu 0,1 s am Ende.
    this.port.onmessage = (event) => {
      if (event.data === 'flush') {
        this.flush();
        this.port.postMessage('flushed');
      }
    };
  }
  process (inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      const l = input[0];
      const r = input[1] || input[0];
      this.chunks.push([new Float32Array(l), new Float32Array(r)]);
      this.frames += l.length;
      if (this.frames >= this.target) this.flush();
    }
    return true;
  }
  flush () {
    if (this.frames === 0) return;
    const out = new Int16Array(this.frames * 2);
    let i = 0;
    for (const [l, r] of this.chunks) {
      for (let f = 0; f < l.length; f++) {
        let a = l[f]; if (a > 1) a = 1; else if (a < -1) a = -1;
        let b = r[f]; if (b > 1) b = 1; else if (b < -1) b = -1;
        out[i++] = a < 0 ? a * 32768 : a * 32767;
        out[i++] = b < 0 ? b * 32768 : b * 32767;
      }
    }
    this.chunks = [];
    this.frames = 0;
    this.port.postMessage(out.buffer, [out.buffer]);
  }
}
registerProcessor('rec-processor', RecProcessor);
`;

  class Capture {
    constructor() {
      this.context = null;
      this.stream = null;
      this.node = null;
      this.source = null;
      this.onChunk = null;
      this.onError = null;
      this.onEvent = null;      // (event, data) – Zustandswechsel des Eingangs fürs Protokoll
      this.running = false;
    }

    /** Zustand von Eingang und Audiouhr für das Protokoll (nur lesen, ändert nichts). */
    diagnostics() {
      const track = this.stream && this.stream.getAudioTracks()[0];
      const ctx = this.context;
      return {
        laeuft: this.running,
        kontext: ctx ? ctx.state : null,
        audiouhrS: ctx ? Math.round(ctx.currentTime * 100) / 100 : null,
        spur: track ? { zustand: track.readyState, stumm: track.muted, aktiv: track.enabled, name: track.label } : null
      };
    }

    _emit(event, data) {
      if (this.onEvent) { try { this.onEvent(event, data); } catch { /* nur Hilfe */ } }
    }

    /** @param {'audioinput'|'audiooutput'} kind */
    static async listDevices(kind = 'audioinput') {
      let devices = await navigator.mediaDevices.enumerateDevices();
      // Ohne einmalige Freigabe liefert der Browser keine Gerätenamen. Die Abfrage
      // erfolgt nur, wenn Namen fehlen, damit eine laufende Aufnahme unberührt bleibt.
      if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
        try {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
          probe.getTracks().forEach((t) => t.stop());
        } catch { /* Namen bleiben ggf. leer */ }
        devices = await navigator.mediaDevices.enumerateDevices();
      }
      return devices
        .filter((d) => d.kind === kind && d.deviceId !== 'default' && d.deviceId !== 'communications')
        .map((d) => ({ id: d.deviceId, label: d.label || (kind === 'audioinput' ? 'Audioeingang' : 'Audioausgang') }));
    }

    async start(deviceId, sampleRate) {
      if (this.running) return { ok: true };

      const audio = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2
      };
      if (deviceId) audio.deviceId = { exact: deviceId };

      let fallback = false;
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio });
      } catch (err) {
        if (deviceId) {
          // Gerät nicht mehr vorhanden – auf Standardeingang ausweichen (wird dem Aufrufer gemeldet).
          delete audio.deviceId;
          this.stream = await navigator.mediaDevices.getUserMedia({ audio });
          fallback = true;
        } else {
          throw new Error('Auf den Audioeingang kann nicht zugegriffen werden: ' + err.message);
        }
      }

      try {
        this.context = new AudioContext({ sampleRate: sampleRate || 48000, latencyHint: 'playback' });
        if (this.context.state === 'suspended') await this.context.resume();
        this.source = this.context.createMediaStreamSource(this.stream);
      } catch (err) {
        // Eingang nicht offen lassen, wenn der Start auf halbem Weg scheitert.
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
        if (this.context) this.context.close().catch(() => {});
        this.context = null;
        throw err;
      }

      let usedWorklet = false;
      try {
        const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        await this.context.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        this.node = new AudioWorkletNode(this.context, 'rec-processor', {
          numberOfInputs: 1,
          numberOfOutputs: 0,
          channelCount: 2,
          channelCountMode: 'explicit'
        });
        this.node.port.onmessage = (event) => {
          if (event.data === 'flushed') {
            if (this._onFlushed) this._onFlushed();
            return;
          }
          if (this.onChunk) this.onChunk(event.data);
        };
        this.source.connect(this.node);
        usedWorklet = true;
      } catch (err) {
        console.warn('AudioWorklet nicht verfügbar, nutze Fallback:', err);
        this._startFallback();
      }

      this.running = true;
      const track = this.stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          this._emit('eingang-spur-beendet', this.diagnostics());
          if (this.onError) this.onError('Das Aufnahmegerät wurde getrennt.');
        };
        // Stummschaltung durch Chromium/Windows (Gerät weg, Energiesparen, Datenschutz) – meist die Vorstufe eines Aussetzers.
        track.onmute = () => this._emit('eingang-spur-stumm', this.diagnostics());
        track.onunmute = () => this._emit('eingang-spur-wieder-da', this.diagnostics());
      }
      this.context.onstatechange = () => this._emit('audiokontext-' + (this.context ? this.context.state : 'weg'), this.diagnostics());
      this._emit('eingang-geoeffnet', { ...this.diagnostics(), abtastrate: this.context.sampleRate, modus: usedWorklet ? 'worklet' : 'fallback', ersatzgeraet: fallback });

      return {
        ok: true,
        sampleRate: this.context.sampleRate,
        channels: 2,
        mode: usedWorklet ? 'worklet' : 'fallback',
        deviceFallback: fallback,
        deviceLabel: track ? track.label : ''
      };
    }

    _startFallback() {
      const size = 4096;
      const proc = this.context.createScriptProcessor(size, 2, 2);
      proc.onaudioprocess = (event) => {
        const l = event.inputBuffer.getChannelData(0);
        const r = event.inputBuffer.numberOfChannels > 1 ? event.inputBuffer.getChannelData(1) : l;
        const out = new Int16Array(l.length * 2);
        let i = 0;
        for (let f = 0; f < l.length; f++) {
          let a = Math.max(-1, Math.min(1, l[f]));
          let b = Math.max(-1, Math.min(1, r[f]));
          out[i++] = a < 0 ? a * 32768 : a * 32767;
          out[i++] = b < 0 ? b * 32768 : b * 32767;
        }
        if (this.onChunk) this.onChunk(out.buffer);
      };
      // Stiller Ausgang, damit der Knoten verarbeitet wird.
      const silent = this.context.createGain();
      silent.gain.value = 0;
      this.source.connect(proc);
      proc.connect(silent);
      silent.connect(this.context.destination);
      this.node = proc;
    }

    /** Gibt den angefangenen Block sofort ab (vor dem Beenden der Aufnahme). Höchstens 300 ms warten. */
    flush() {
      if (!this.running || !this.node || !this.node.port) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(done, 300);
        function done() { clearTimeout(timer); resolve(); }
        this._onFlushed = () => { this._onFlushed = null; done(); };
        this.node.port.postMessage('flush');
      });
    }

    async stop() {
      this.running = false;
      try {
        if (this.node && this.node.port) this.node.port.onmessage = null;
        if (this.node && this.node.disconnect) this.node.disconnect();
        if (this.source) this.source.disconnect();
        if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
        // Gewolltes Schließen ist kein Ereignis fürs Eingangsprotokoll (sonst bei jedem Beenden „audiokontext-weg“).
        if (this.context) { this.context.onstatechange = null; await this.context.close(); }
      } catch (err) {
        console.warn('Fehler beim Schließen der Audioerfassung:', err);
      }
      this.node = null;
      this.source = null;
      this.stream = null;
      this.context = null;
    }
  }

  window.Capture = Capture;
})();
