'use strict';

/**
 * Schreiben und Lesen von 16-Bit-PCM-WAV-Dateien.
 *
 * - Geschrieben wird in einem eigenen Thread (Worker): Ein langsames Laufwerk (USB-Stick,
 *   Netzlaufwerk) bremst so nie den Hauptprozess und damit nie die Aufnahme selbst.
 * - Der Header wird laufend aktualisiert und die Daten werden regelmäßig auf die Platte
 *   gezwungen (fdatasync): Auch nach Absturz oder Stromausfall bleibt eine abspielbare Datei.
 * - Neue Dateien reservieren Platz für einen "ds64"-Block. Überschreitet die Aufnahme 4 GB
 *   (gut 6 Stunden bei 48 kHz Stereo), wird die Datei im laufenden Betrieb zu RF64 – der
 *   Erweiterung des WAV-Formats für große Dateien. Es bleibt eine einzige Datei.
 * - Nach dem Beenden hängt `writeCues` die Abschnitte als Cue-Marker (`cue `, `LIST`/`adtl`) hinter den
 *   `data`-Block. `readInfo` erkennt das und rechnet die Audiolänge dann aus dem Kopf statt aus der Dateigröße.
 */

const fs = require('fs');
const { EventEmitter } = require('events');
const { Worker } = require('worker_threads');

const HEADER_BYTES = 80;          // neue Aufnahmen: RIFF + JUNK/ds64 + fmt + data
const MAX_UINT32 = 0xFFFFFFFF;
const SLOW_QUEUE_BYTES = 32 * 1024 * 1024;   // so viel ungeschriebenes Audio gilt als "Laufwerk zu langsam"

/**
 * Baut den Dateikopf.
 * layout 'ds64': 80 Byte mit Platz für RF64 (wird ab 4 GB benutzt); 'legacy': klassische 44 Byte.
 * Wird auch im Schreib-Thread verwendet (als Quelltext übergeben) – daher ohne äußere Abhängigkeiten.
 * bitsPerSample: 16 (Stereoaufnahme) oder 24 (Mehrspur).
 */
function buildHeader(layout, sampleRate, channels, dataBytes, bitsPerSample = 16) {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const U32 = 0xFFFFFFFF;

  const writeFmt = (buf, at) => {
    buf.write('fmt ', at, 'ascii');
    buf.writeUInt32LE(16, at + 4);
    buf.writeUInt16LE(1, at + 8);              // PCM
    buf.writeUInt16LE(channels, at + 10);
    buf.writeUInt32LE(sampleRate, at + 12);
    buf.writeUInt32LE(byteRate, at + 16);
    buf.writeUInt16LE(blockAlign, at + 20);
    buf.writeUInt16LE(bitsPerSample, at + 22);
  };

  if (layout === 'legacy') {
    // Alte Dateien haben keinen Platz für RF64: Größen bei 4 GB deckeln (gelesen wird über die Dateigröße).
    const buf = Buffer.alloc(44);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(Math.min(U32, dataBytes + 36), 4);
    buf.write('WAVE', 8, 'ascii');
    writeFmt(buf, 12);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(Math.min(U32, dataBytes), 40);
    return buf;
  }

  const buf = Buffer.alloc(80);
  const riffSize = dataBytes + 72;              // Dateigröße minus 8
  const big = riffSize > U32;
  buf.write(big ? 'RF64' : 'RIFF', 0, 'ascii');
  buf.writeUInt32LE(big ? U32 : riffSize, 4);
  buf.write('WAVE', 8, 'ascii');
  // Bis 4 GB ein JUNK-Block (wird von Playern übersprungen), danach der ds64-Block mit 64-Bit-Größen.
  buf.write(big ? 'ds64' : 'JUNK', 12, 'ascii');
  buf.writeUInt32LE(28, 16);
  if (big) {
    buf.writeBigUInt64LE(BigInt(riffSize), 20);
    buf.writeBigUInt64LE(BigInt(dataBytes), 28);
    buf.writeBigUInt64LE(BigInt(Math.floor(dataBytes / blockAlign)), 36);
    buf.writeUInt32LE(0, 44);                   // keine weiteren Tabelleneinträge
  }
  writeFmt(buf, 48);
  buf.write('data', 72, 'ascii');
  buf.writeUInt32LE(big ? U32 : dataBytes, 76);
  return buf;
}

/* Schreib-Thread. Als Quelltext eingebettet (eval), damit er auch aus dem gepackten
   app.asar heraus ohne entpackte Zusatzdateien startet. */
const WORKER_SOURCE = `
const fs = require('fs');
const { parentPort, workerData } = require('worker_threads');
const buildHeader = ${buildHeader.toString()};
const { fd, layout, sampleRate, channels, dataOffset } = workerData;
let written = workerData.dataBytes;
let sinceHeader = 0;
let failed = false;
const headerEvery = sampleRate * channels * 2;     // etwa jede Sekunde Audio

function header() {
  const buf = buildHeader(layout, sampleRate, channels, written);
  fs.writeSync(fd, buf, 0, buf.length, 0);
}

const syncTimer = setInterval(() => {
  if (failed) return;
  try { fs.fdatasyncSync(fd); } catch (err) { /* nicht jedes Dateisystem kann das */ }
}, 10000);

parentPort.on('message', (msg) => {
  try {
    if (msg.type === 'write') {
      if (failed) return;
      const buf = Buffer.from(msg.data);
      let done = 0;
      while (done < buf.length) {
        done += fs.writeSync(fd, buf, done, buf.length - done, dataOffset + written + done);
      }
      written += buf.length;
      sinceHeader += buf.length;
      if (sinceHeader >= headerEvery) {
        header();
        sinceHeader = 0;
        parentPort.postMessage({ type: 'progress', written });
      }
    } else if (msg.type === 'header') {
      if (!failed) header();
      parentPort.postMessage({ type: 'progress', written });
    } else if (msg.type === 'close') {
      // Die Datei schließt der Hauptprozess (er hat sie geöffnet).
      clearInterval(syncTimer);
      if (!failed) header();
      try { fs.fsyncSync(fd); } catch (e) { /* egal */ }
      parentPort.postMessage({ type: 'closed', written });
    }
  } catch (err) {
    failed = true;
    parentPort.postMessage({ type: 'error', message: err.message, code: err.code || null });
    if (msg.type === 'close') parentPort.postMessage({ type: 'closed', written });
  }
});
`;

/** Latin-1 kennt „ “ ‚ ‘ – … nicht (Bytes würden abgeschnitten, Steuerzeichen): durch ASCII ersetzen, Rest wird „?“. */
function toLatin1(text) {
  return String(text || '')
    .replace(/[„“”‟«»]/g, '"').replace(/[‚‘’‛]/g, "'")
    .replace(/[–—‐‑]/g, '-').replace(/…/g, '...')
    .replace(/[^\u0000-\u00ff]/g, '?');
}

/**
 * Schreibt eine WAV-Datei fortlaufend. Ereignisse: 'error' ({message, code}), 'slow' (true/false).
 */
class WavWriter extends EventEmitter {
  /** @param {{append?:boolean}} [opts] append: bestehende Datei am Ende weiterschreiben */
  constructor(filePath, sampleRate, channels, opts = {}) {
    super();
    this.filePath = filePath;
    this.sampleRate = sampleRate;
    this.channels = channels;
    this.dataBytes = 0;            // übergeben (in der Warteschlange oder geschrieben)
    this.writtenBytes = 0;         // vom Schreib-Thread bestätigt
    this.closed = false;
    this.failed = false;

    // Datei synchron öffnen: Scheitert das (Ordner nicht beschreibbar …), merkt es der Aufrufer sofort.
    if (opts.append) {
      const info = readInfo(filePath);
      if (info.bitsPerSample !== 16) throw new Error('An diese Datei kann nicht angehängt werden (keine 16-Bit-WAV).');
      this.layout = info.dataOffset === HEADER_BYTES && info.layout === 'ds64' ? 'ds64' : 'legacy';
      this.dataOffset = info.dataOffset;
      const blockAlign = channels * 2;
      this.dataBytes = info.dataBytes - (info.dataBytes % blockAlign);   // angefangenes Frame verwerfen
      this.fd = fs.openSync(filePath, 'r+');
      // Cue-Marker hinter den Audiodaten fallen weg: Neue Daten überschreiben sie, beim Beenden kommen sie neu dazu.
      try { fs.ftruncateSync(this.fd, this.dataOffset + this.dataBytes); } catch { /* nicht kritisch */ }
    } else {
      this.layout = 'ds64';
      this.dataOffset = HEADER_BYTES;
      this.fd = fs.openSync(filePath, 'w');
      const head = buildHeader(this.layout, sampleRate, channels, 0);
      fs.writeSync(this.fd, head, 0, head.length, 0);
    }
    this.writtenBytes = this.dataBytes;

    this._closedPromise = new Promise((resolve) => { this._resolveClosed = resolve; });
    this.worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: {
        fd: this.fd,
        layout: this.layout,
        sampleRate,
        channels,
        dataOffset: this.dataOffset,
        dataBytes: this.dataBytes
      }
    });
    this.worker.on('message', (msg) => this._onMessage(msg));
    this.worker.on('error', (err) => this._fail({ message: err.message, code: err.code || null }));
    this.worker.on('exit', (code) => {
      // Stirbt der Thread vorzeitig (z. B. kein Speicher), bliebe die Datei sonst bis zum Programmende offen
      // (unter Windows gesperrt), und niemand erführe davon.
      if (!this.closed) this._fail({ message: `Der Schreib-Thread wurde unerwartet beendet (Code ${code}).`, code: null });
      this._closeFd();
      this._resolveClosed(this.writtenBytes);
    });
    this._slow = false;
  }

  _onMessage(msg) {
    if (msg.type === 'progress' || msg.type === 'closed') this.writtenBytes = msg.written;
    if (msg.type === 'error') this._fail(msg);
    if (msg.type === 'closed') {
      this._closeFd();
      this._resolveClosed(this.writtenBytes);
      this.worker.terminate().catch(() => {});
    }
    this._checkSlow();
  }

  _closeFd() {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch { /* bereits zu */ }
    this.fd = null;
  }

  _fail(err) {
    if (this.failed) return;
    this.failed = true;
    this.emit('error', err);
  }

  _checkSlow() {
    const slow = this.dataBytes - this.writtenBytes > SLOW_QUEUE_BYTES;
    if (slow !== this._slow) {
      this._slow = slow;
      this.emit('slow', slow);
    }
  }

  /** @param {Buffer} buffer Interleaved Int16LE */
  write(buffer) {
    if (this.closed || !buffer || buffer.length === 0) return;
    // Kopie übergeben: Der Aufrufer liest den Puffer danach noch (Pegel, Wellenform).
    const copy = new Uint8Array(buffer.length);
    copy.set(buffer);
    this.worker.postMessage({ type: 'write', data: copy.buffer }, [copy.buffer]);
    this.dataBytes += buffer.length;
    if ((this._writes = (this._writes || 0) + 1) % 50 === 0) this._checkSlow();
  }

  /** Header jetzt aktualisieren (z. B. bei Pause), damit die Datei vollständig lesbar ist. */
  updateHeader() {
    if (!this.closed) this.worker.postMessage({ type: 'header' });
  }

  get frames() {
    return this.dataBytes / (this.channels * 2);
  }

  get durationSeconds() {
    return this.frames / this.sampleRate;
  }

  /** Schließt die Datei; das Versprechen erfüllt sich, wenn alles auf der Platte ist. */
  close() {
    if (!this.closed) {
      this.closed = true;
      this.worker.postMessage({ type: 'close' });
    }
    return this._closedPromise;
  }
}

/**
 * Liest Kopfdaten einer WAV-Datei (16-Bit-PCM, für Mehrspur auch 24 Bit). Versteht klassisches WAV (44-Byte-Kopf),
 * WAV mit JUNK-Block und RF64. Die Datenlänge kommt aus der Dateigröße – so lassen sich auch
 * Dateien lesen, die gerade noch geschrieben werden oder deren Kopf nicht mehr aktuell ist.
 */
function readInfo(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(512);
    const got = fs.readSync(fd, head, 0, head.length, 0);
    const kind = head.toString('ascii', 0, 4);
    if ((kind !== 'RIFF' && kind !== 'RF64') || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('Keine gültige WAV-Datei.');
    }
    let pos = 12;
    let fmt = null;
    let dataOffset = null;
    let layout = 'legacy';
    let headerData = 0;
    while (pos + 8 <= got) {
      const id = head.toString('ascii', pos, pos + 4);
      const size = head.readUInt32LE(pos + 4);
      if (id === 'JUNK' || id === 'ds64') layout = 'ds64';
      if (id === 'fmt ') {
        fmt = {
          channels: head.readUInt16LE(pos + 10),
          sampleRate: head.readUInt32LE(pos + 12),
          bitsPerSample: head.readUInt16LE(pos + 22)
        };
      }
      if (id === 'data') {
        dataOffset = pos + 8;
        headerData = size;
        break;
      }
      pos += 8 + size + (size % 2);
    }
    if (!fmt || dataOffset == null) throw new Error('WAV-Datei ohne gültigen Kopf.');
    if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 24) throw new Error('Nur 16- und 24-Bit-WAV werden unterstützt.');
    const blockAlign = fmt.channels * (fmt.bitsPerSample / 8);
    const fileSize = fs.fstatSync(fd).size;
    let raw = Math.max(0, fileSize - dataOffset);
    // Hängen Cue-Marker hinter den Audiodaten, gilt die Länge aus dem Kopf (sonst zählten sie als Audio).
    if (kind === 'RIFF' && headerData > 0 && headerData < MAX_UINT32 && dataOffset + headerData + 8 <= fileSize) {
      const tail = Buffer.alloc(4);
      fs.readSync(fd, tail, 0, 4, dataOffset + headerData);
      const tailId = tail.toString('ascii');
      if (tailId === 'cue ' || tailId === 'LIST') raw = headerData;
    }
    const dataBytes = raw - (raw % blockAlign);
    return {
      channels: fmt.channels,
      sampleRate: fmt.sampleRate,
      bitsPerSample: fmt.bitsPerSample,
      dataOffset,
      layout,
      dataBytes,
      frames: dataBytes / blockAlign,
      duration: dataBytes / blockAlign / fmt.sampleRate
    };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Schreibt Cue-Marker hinter den data-Block (ersetzt vorhandene). Marker anderer Programme bleiben
 * dabei nicht erhalten – die Datei gehört dieser App. RF64-Dateien (über 4 GB) bekommen keine.
 * @param {{frame:number, label:string, length?:number}[]} points Startpunkt (Frame), Name, optional Länge (Frames)
 * @returns {boolean} false, wenn die Datei keine Marker aufnehmen kann
 */
function writeCues(filePath, points) {
  const info = readInfo(filePath);
  const fd = fs.openSync(filePath, 'r+');
  try {
    const kind = Buffer.alloc(4);
    fs.readSync(fd, kind, 0, 4, 0);
    if (kind.toString('ascii') !== 'RIFF') return false;
    const dataEnd = info.dataOffset + info.dataBytes;

    const chunks = [];
    if (points.length > 0) {
      const cue = Buffer.alloc(12 + points.length * 24);
      cue.write('cue ', 0, 'ascii');
      cue.writeUInt32LE(4 + points.length * 24, 4);
      cue.writeUInt32LE(points.length, 8);
      const adtl = [Buffer.from('adtl', 'ascii')];
      points.forEach((pt, i) => {
        const id = i + 1;
        const frame = Math.max(0, Math.min(Math.round(pt.frame), info.frames));
        const at = 12 + i * 24;
        cue.writeUInt32LE(id, at);              // dwName
        cue.writeUInt32LE(frame, at + 4);       // dwPosition
        cue.write('data', at + 8, 'ascii');     // fccChunk
        cue.writeUInt32LE(0, at + 12);          // dwChunkStart
        cue.writeUInt32LE(0, at + 16);          // dwBlockStart
        cue.writeUInt32LE(frame, at + 20);      // dwSampleOffset
        const text = Buffer.concat([Buffer.from(toLatin1(pt.label), 'latin1'), Buffer.from([0])]);
        const labl = Buffer.alloc(8 + 4 + text.length + (text.length % 2));
        labl.write('labl', 0, 'ascii');
        labl.writeUInt32LE(4 + text.length, 4);
        labl.writeUInt32LE(id, 8);
        text.copy(labl, 12);
        adtl.push(labl);
        if (pt.length > 0) {                    // Bereich (Region), z. B. in Reaper
          const ltxt = Buffer.alloc(8 + 20);
          ltxt.write('ltxt', 0, 'ascii');
          ltxt.writeUInt32LE(20, 4);
          ltxt.writeUInt32LE(id, 8);
          ltxt.writeUInt32LE(Math.min(Math.round(pt.length), info.frames - frame), 12);
          ltxt.write('rgn ', 16, 'ascii');
          adtl.push(ltxt);
        }
      });
      const body = Buffer.concat(adtl);
      const list = Buffer.alloc(8);
      list.write('LIST', 0, 'ascii');
      list.writeUInt32LE(body.length, 4);
      chunks.push(cue, list, body);
    }

    const tail = Buffer.concat(chunks);
    if (dataEnd + tail.length - 8 > MAX_UINT32) return false;
    fs.ftruncateSync(fd, dataEnd);
    if (tail.length > 0) fs.writeSync(fd, tail, 0, tail.length, dataEnd);
    const sizes = Buffer.alloc(4);
    sizes.writeUInt32LE(dataEnd + tail.length - 8, 0);
    fs.writeSync(fd, sizes, 0, 4, 4);                                  // RIFF-Größe
    sizes.writeUInt32LE(Math.min(info.dataBytes, MAX_UINT32 - 1), 0);
    fs.writeSync(fd, sizes, 0, 4, info.dataOffset - 4);                // data-Größe
    try { fs.fdatasyncSync(fd); } catch { /* nicht jedes Dateisystem kann das */ }
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Liest eine Anzahl Frames ab einem Start-Frame (Int16, interleaved).
 * @param {object} [info] Ergebnis von readInfo (spart das erneute Lesen des Headers)
 */
function readFrames(filePath, startFrame, frameCount, info) {
  const meta = info || readInfo(filePath);
  if (meta.bitsPerSample !== 16) throw new Error('Nur 16-Bit-WAV lässt sich hier lesen.');
  const bytesPerFrame = meta.channels * 2;
  const first = Math.max(0, Math.min(startFrame, meta.frames));
  const count = Math.max(0, Math.min(frameCount, meta.frames - first));
  const samples = new Int16Array(count * meta.channels);
  if (count > 0) {
    const fd = fs.openSync(filePath, 'r');
    try {
      // Direkt in den Speicher des Int16Array lesen (WAV ist little endian wie x86/ARM).
      fs.readSync(fd, Buffer.from(samples.buffer), 0, count * bytesPerFrame, meta.dataOffset + first * bytesPerFrame);
    } finally {
      fs.closeSync(fd);
    }
  }
  return { sampleRate: meta.sampleRate, channels: meta.channels, samples };
}

/**
 * Liest einen Zeitausschnitt.
 * @returns {{sampleRate:number, channels:number, samples:Int16Array}}
 */
function readSlice(filePath, startSec, endSec) {
  const info = readInfo(filePath);
  const startFrame = Math.max(0, Math.floor((startSec || 0) * info.sampleRate));
  const endFrame = Math.min(info.frames, Math.ceil((endSec == null ? info.duration : endSec) * info.sampleRate));
  return readFrames(filePath, startFrame, Math.max(0, endFrame - startFrame), info);
}

module.exports = { WavWriter, readInfo, writeCues, readSlice, readFrames, buildHeader, HEADER_BYTES };
