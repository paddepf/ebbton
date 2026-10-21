'use strict';

/**
 * Wiedergabe einer Mehrspuraufnahme über die Ausgänge des Geräts (virtueller Soundcheck, Nachmischen):
 * Spur auf Kanal k geht auf Ausgang k. Liest die 24-Bit-Mono-Spuren blockweise und setzt daraus
 * Ausgabeblöcke (Int32, verschachtelt über alle Ausgänge) zusammen – mit Springen und Schleife.
 * Den Takt gibt das Gerät vor (`engine.js` legt Blöcke nach, sobald es welche verbraucht hat).
 */

const fs = require('fs');
const { readInfo } = require('../wav');

const { BYTES } = require('./writer');   // 24 Bit je Abtastwert, wie geschrieben
const CACHE_SECONDS = 0.5;

/** Liest eine Spur abschnittsweise (Zwischenspeicher von 0,5 s, die Wiedergabe liest fortlaufend). */
class TrackReader {
  constructor(file, channel) {
    const info = readInfo(file);
    if (info.bitsPerSample !== 24 || info.channels !== 1) throw new Error(`„${file}“ ist keine Mehrspur-Datei von Ebbton.`);
    this.file = file;
    this.channel = channel;
    this.sampleRate = info.sampleRate;
    this.frames = info.frames;
    this.dataOffset = info.dataOffset;
    this.fd = fs.openSync(file, 'r');
    this.cacheFrames = Math.round(info.sampleRate * CACHE_SECONDS);
    this.cache = Buffer.alloc(0);
    this.cacheStart = 0;
  }

  /** @returns {Buffer} n Frames ab `pos` (24 Bit); jenseits des Endes Stille. */
  read(pos, n) {
    if (pos < this.cacheStart || pos + n > this.cacheStart + this.cache.length / BYTES) {
      const want = Math.max(this.cacheFrames, n);
      const avail = Math.max(0, Math.min(want, this.frames - pos));
      const buf = Buffer.alloc(want * BYTES);           // Rest bleibt Stille
      if (avail > 0) fs.readSync(this.fd, buf, 0, avail * BYTES, this.dataOffset + pos * BYTES);
      this.cache = buf;
      this.cacheStart = pos;
    }
    const at = (pos - this.cacheStart) * BYTES;
    return this.cache.subarray(at, at + n * BYTES);
  }

  close() {
    try { fs.closeSync(this.fd); } catch { /* schon zu */ }
  }
}

class Player {
  /**
   * @param {object} o
   * @param {{channel:number, file:string}[]} o.tracks
   * @param {number} o.outputs Ausgänge des Geräts
   * @param {number} o.sampleRate Rate des offenen Geräts (muss zur Aufnahme passen)
   * @param {number} o.blockFrames Frames je Ausgabeblock (Puffergröße des Geräts)
   */
  constructor({ tracks, outputs, sampleRate, blockFrames }) {
    this.outputs = outputs;
    this.blockFrames = blockFrames;
    this.readers = [];
    try {
      for (const t of tracks) {
        if (t.channel >= outputs) continue;             // für diesen Kanal hat das Gerät keinen Ausgang
        const r = new TrackReader(t.file, t.channel);
        this.readers.push(r);
        if (r.sampleRate !== sampleRate) {
          throw new Error(`Die Aufnahme hat ${r.sampleRate} Hz, das Gerät läuft mit ${sampleRate} Hz.`);
        }
      }
    } catch (err) {
      this.close();
      throw err;
    }
    if (!this.readers.length) {
      this.close();
      throw new Error('Keine Spur passt zu den Ausgängen des Geräts.');
    }
    this.sampleRate = sampleRate;
    this.length = Math.max(...this.readers.map((r) => r.frames));
    this.pos = 0;            // nächster Frame, der in einen Block kommt
    this.loop = null;        // {start, end} in Frames
    this.ended = false;      // Ende erreicht (ohne Schleife); die letzten Blöcke laufen noch aus
  }

  /** Position in Sekunden setzen (Springen). */
  seek(seconds) {
    this.pos = Math.max(0, Math.min(this.length, Math.round(seconds * this.sampleRate)));
    this.ended = false;
    if (this.loop && (this.pos < this.loop.start || this.pos >= this.loop.end)) this.pos = this.loop.start;
  }

  /** Schleife setzen (Sekunden) oder mit null aufheben. */
  setLoop(loop) {
    if (!loop) {
      this.loop = null;
      return;
    }
    const start = Math.max(0, Math.round(loop.start * this.sampleRate));
    const end = Math.min(this.length, Math.round(loop.end * this.sampleRate));
    if (end - start < this.sampleRate * 0.2) throw new Error('Die Schleife ist zu kurz.');
    this.loop = { start, end };
    if (this.pos < start || this.pos >= end) this.pos = start;
    this.ended = false;
  }

  /**
   * Nächster Ausgabeblock. `startFrame` sagt, welcher Aufnahme-Frame am Blockanfang erklingt (für die Positionsanzeige).
   * @returns {{buf: Buffer, startFrame: number}}
   */
  nextBlock() {
    const n = this.blockFrames;
    const out = this.outputs;
    const buf = Buffer.alloc(n * out * 4);
    const startFrame = this.pos;
    let f = 0;
    while (f < n && !this.ended) {
      const end = this.loop ? this.loop.end : this.length;
      if (this.pos >= end) {
        if (this.loop) { this.pos = this.loop.start; continue; }
        this.ended = true;
        break;
      }
      const k = Math.min(n - f, end - this.pos);
      for (const r of this.readers) {
        const src = r.read(this.pos, k);
        let o = (f * out + r.channel) * 4;
        const step = out * 4;
        for (let i = 0; i < k * BYTES; i += BYTES) {
          // 24 Bit in die oberen drei Bytes des Int32 (little endian)
          buf[o + 1] = src[i];
          buf[o + 2] = src[i + 1];
          buf[o + 3] = src[i + 2];
          o += step;
        }
      }
      this.pos += k;
      f += k;
    }
    return { buf, startFrame };
  }

  close() {
    for (const r of this.readers) r.close();
    this.readers = [];
  }
}

module.exports = { Player };
