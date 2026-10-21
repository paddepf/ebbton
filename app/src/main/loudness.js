'use strict';

/**
 * Lautheit nach ITU-R BS.1770 (integrierte Lautheit in LUFS, mit Gating) und ein einfacher Spitzenbegrenzer
 * für den MP3-Export. Beides arbeitet blockweise, damit auch stundenlange Aufnahmen wenig Speicher brauchen.
 */

const ABS_GATE = -70;           // LUFS
const REL_GATE = -10;           // LU unter der vorläufigen Lautheit
const STEP_SECONDS = 0.1;       // Teilblöcke; 4 davon ergeben einen 400-ms-Messblock (75 % Überlappung)
const PEAK_BLOCK = 64;          // Frames je Spitzenwert des Begrenzers

/** Biquad-Koeffizienten der K-Bewertung für eine beliebige Abtastrate (Verfahren wie libebur128). */
function kFilterCoefficients(rate) {
  // Stufe 1: Höhenanhebung (Kopf-Effekt), etwa +4 dB
  const shelf = (() => {
    const f0 = 1681.974450955533;
    const G = 3.999843853973347;
    const Q = 0.7071752369554196;
    const K = Math.tan((Math.PI * f0) / rate);
    const Vh = 10 ** (G / 20);
    const Vb = Vh ** 0.4996667741545416;
    const a0 = 1 + K / Q + K * K;
    return {
      b0: (Vh + (Vb * K) / Q + K * K) / a0,
      b1: (2 * (K * K - Vh)) / a0,
      b2: (Vh - (Vb * K) / Q + K * K) / a0,
      a1: (2 * (K * K - 1)) / a0,
      a2: (1 - K / Q + K * K) / a0
    };
  })();
  // Stufe 2: Hochpass (RLB-Bewertung)
  const highpass = (() => {
    const f0 = 38.13547087602444;
    const Q = 0.5003270373238773;
    const K = Math.tan((Math.PI * f0) / rate);
    const a0 = 1 + K / Q + K * K;
    return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
  })();
  return [shelf, highpass];
}

/**
 * Misst die integrierte Lautheit. `push` nimmt Int16-Samples (verschachtelt) entgegen.
 */
class LoudnessMeter {
  constructor(rate, channels) {
    this.channels = channels;
    this.stages = kFilterCoefficients(rate);
    // Zustand je Kanal und Stufe: x1, x2, y1, y2
    this.state = Array.from({ length: channels }, () => this.stages.map(() => new Float64Array(4)));
    this.stepFrames = Math.round(rate * STEP_SECONDS);
    this.acc = 0;               // Summe der Quadrate im laufenden Teilblock (alle Kanäle)
    this.fill = 0;
    this.steps = [];            // mittlere Leistung je Teilblock
  }

  push(samples, frames) {
    const ch = this.channels;
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        let x = samples[f * ch + c] / 32768;
        const st = this.state[c];
        for (let s = 0; s < this.stages.length; s++) {
          const k = this.stages[s];
          const z = st[s];
          const y = k.b0 * x + k.b1 * z[0] + k.b2 * z[1] - k.a1 * z[2] - k.a2 * z[3];
          z[1] = z[0]; z[0] = x;
          z[3] = z[2]; z[2] = y;
          x = y;
        }
        this.acc += x * x;
      }
      this.fill += 1;
      if (this.fill === this.stepFrames) {
        this.steps.push(this.acc / this.stepFrames);
        this.acc = 0;
        this.fill = 0;
      }
    }
  }

  /** Integrierte Lautheit in LUFS; -Infinity bei Stille oder zu kurzem Ausschnitt (< 400 ms). */
  integrated() {
    const blocks = [];
    for (let i = 3; i < this.steps.length; i++) {
      blocks.push((this.steps[i] + this.steps[i - 1] + this.steps[i - 2] + this.steps[i - 3]) / 4);
    }
    const lufs = (z) => -0.691 + 10 * Math.log10(z);
    const mean = (list) => list.reduce((s, z) => s + z, 0) / list.length;
    const aboveAbs = blocks.filter((z) => lufs(z) > ABS_GATE);
    if (!aboveAbs.length) return -Infinity;
    const relGate = lufs(mean(aboveAbs)) + REL_GATE;
    const gated = aboveAbs.filter((z) => lufs(z) > relGate);
    return gated.length ? lufs(mean(gated)) : -Infinity;
  }
}

/**
 * Verstärkung an den Grenzen der Spitzenblöcke (je `PEAK_BLOCK` Frames), damit nach der Anhebung um `gain` kein
 * Sample über `ceiling` liegt. Zwischen zwei Grenzen wird linear übergeblendet; da beide Grenzwerte den Block
 * dazwischen begrenzen, bleibt jeder Sample darunter. Absenken geht schnell (vorausschauend, ~6 dB je Block),
 * Wiederanheben langsam (`releaseDbPerSecond`).
 * @param {Float32Array} peaks Betrag der Spitze je Block (0..1)
 * @returns {Float32Array} Länge peaks.length + 1, Werte 0..1 (zusätzlich zu `gain`)
 */
function limiterGains(peaks, gain, ceiling, rate, { releaseDbPerSecond = 20, attackDbPerBlock = 6 } = {}) {
  const n = peaks.length;
  const need = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = peaks[k] * gain;
    need[k] = p > ceiling ? ceiling / p : 1;
  }
  const g = new Float32Array(n + 1);
  for (let k = 0; k <= n; k++) {
    g[k] = Math.min(k > 0 ? need[k - 1] : 1, k < n ? need[k] : 1);
  }
  // Vorausschauend absenken: vor einer Spitze nicht schlagartig, sondern über einige Blöcke.
  const attack = 10 ** (attackDbPerBlock / 20);
  for (let k = n - 1; k >= 0; k--) g[k] = Math.min(g[k], g[k + 1] * attack);
  // Danach langsam zurück.
  const release = 10 ** ((releaseDbPerSecond * PEAK_BLOCK) / rate / 20);
  for (let k = 1; k <= n; k++) g[k] = Math.min(g[k], g[k - 1] * release);
  return g;
}

module.exports = { LoudnessMeter, limiterGains, PEAK_BLOCK };
