'use strict';

/**
 * Mehrere MP3-Exporte gleichzeitig, je einer in einem eigenen Thread (Worker).
 * - Der Hauptprozess bleibt frei (Codieren ist reine Rechenarbeit), mehrere Kerne werden genutzt.
 * - Der Worker wird als Quelltext gestartet (eval) und lädt mp3.js über den absoluten Pfad – wie der
 *   Schreib-Thread in wav.js, damit nichts aus app.asar entpackt werden muss.
 * - Lässt sich kein Worker starten (oder bricht er ab), läuft dieser Export im Hauptprozess.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const mp3 = require('./mp3');

const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const mp3 = require(workerData.module);
mp3.exportSegment({ ...workerData.job, onProgress: (p) => parentPort.postMessage({ type: 'progress', p }) })
  .then((result) => parentPort.postMessage({ type: 'done', result }))
  .catch((err) => parentPort.postMessage({ type: 'failed', error: String((err && err.message) || err) }));
`;

/** Gleichzeitige Exporte: ein Kern bleibt frei, höchstens 4 (mehr bringt die Platte kaum). */
function defaultConcurrency() {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cores - 1));
}

/** Ein Export im Worker. Liefert das Ergebnis; Fehler des Exports als Ablehnung mit `exportFailed`. */
function runInWorker(job, onProgress) {
  return new Promise((resolve, reject) => {
    let worker;
    try {
      worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { module: path.join(__dirname, 'mp3.js'), job } });
    } catch (err) {
      reject(err);
      return;
    }
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress(msg.p);
      else if (msg.type === 'done') finish(resolve, msg.result);
      else if (msg.type === 'failed') finish(reject, Object.assign(new Error(msg.error), { exportFailed: true }));
    });
    worker.on('error', (err) => finish(reject, err));
    worker.on('exit', (code) => finish(reject, new Error(`Export-Thread beendet (${code})`)));
  });
}

/** Ein Export: im Worker, bei Problemen mit dem Worker selbst im Hauptprozess. */
async function runOne(job, onProgress, useWorkers) {
  if (useWorkers) {
    try {
      return await runInWorker(job, onProgress);
    } catch (err) {
      if (err.exportFailed) throw err;
      try { fs.unlinkSync(job.outPath); } catch { /* nichts angelegt */ }
      console.warn('MP3-Export im Thread nicht möglich, weiter im Hauptprozess:', err?.message || err);
    }
  }
  return mp3.exportSegment({ ...job, onProgress });
}

/**
 * Exportiert alle Aufträge (Optionen wie mp3.exportSegment, ohne onProgress).
 * Längere zuerst, damit am Ende nicht ein einzelner langer Export allein läuft.
 * @param {object[]} jobs
 * @param {{concurrency?:number, useWorkers?:boolean,
 *   onProgress?:(info:{progress:number, done:number, total:number})=>void,
 *   onResult?:(index:number, result:object|null, error:Error|null)=>void}} [opts]
 * @returns {Promise<{result?:object, error?:Error}[]>} in der Reihenfolge der Aufträge
 */
async function exportAll(jobs, { concurrency = defaultConcurrency(), useWorkers = true, onProgress, onResult } = {}) {
  const total = jobs.length;
  const weight = jobs.map((j) => Math.max(0.001, j.end - j.start));
  const sum = weight.reduce((a, b) => a + b, 0);
  const part = new Array(total).fill(0);
  let done = 0;
  const report = () => {
    if (!onProgress) return;
    const progress = part.reduce((acc, p, i) => acc + p * weight[i], 0) / sum;
    onProgress({ progress: Math.min(0.999, progress), done, total });
  };

  const queue = jobs.map((_, i) => i).sort((a, b) => weight[b] - weight[a]);
  const results = new Array(total);
  const lane = async () => {
    while (queue.length) {
      const i = queue.shift();
      try {
        results[i] = { result: await runOne(jobs[i], (p) => { part[i] = p; report(); }, useWorkers) };
      } catch (error) {
        results[i] = { error };
      }
      part[i] = 1;
      done += 1;
      if (onResult) onResult(i, results[i].result || null, results[i].error || null);
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, lane));
  return results;
}

module.exports = { exportAll, defaultConcurrency };
