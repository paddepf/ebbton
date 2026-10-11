/* Fehlbetrag der Stereo-Aufnahme gegen die Uhr.

   Anlass: Unter Windows gingen im Hintergrund leise 1–2 % der Aufnahme verloren (Timer-Regel, siehe timerres.js),
   ohne dass der Wächter etwas merkte – es fehlten viele kleine Stücke, keins erreichte seine 2,5 s. Gemessen wird
   deshalb fortlaufend: vergangene Zeit seit Messbeginn minus aufgenommene Dauer. Pausen zählen nicht.

   - Messbeginn erst beim ersten neuen Block nach Start/Fortsetzen, sonst stünde die Übertragungszeit des ersten
     Blocks (~0,1 s) dauerhaft als Fehlbetrag da.
   - Gemeldet wird das Minimum der letzten Werte (`window`, je eine Messung pro Sekunde): Hängt nur die Zustellung
     (Blöcke kommen gesammelt nach), steigt der Wert kurz und fällt wieder – das ist kein Verlust.
   - Mit Stille gefüllte Aussetzer (`Session.fillGap`) zählen als aufgenommen: Die Zeitachse stimmt dann wieder.
   Uhrendrift zwischen Audiogerät und Rechner (typisch < 100 ppm, 0,36 s je Stunde) liegt unter den Schwellen. */

'use strict';

class DeficitMeter {
  /** @param {{window?: number}} [opts] Anzahl der Messungen, über die das Minimum gebildet wird */
  constructor({ window = 10 } = {}) {
    this.windowSize = window;
    this.reset();
  }

  /** Neue Aufnahme: alles auf null. */
  reset() {
    this.carry = 0;           // Fehlbetrag aus früheren Abschnitten (vor einer Pause)
    this.elapsedCarry = 0;    // gemessene Aufnahmezeit vor einer Pause (s)
    this.base = null;         // {now, duration} des Messbeginns im laufenden Abschnitt
    this.pendingFrom = null;  // Dauer beim Start/Fortsetzen; Messbeginn, sobald sie wächst
    this.recent = [];
    this.last = 0;
    this.lastElapsed = 0;
  }

  /** Aufnahme beginnt oder läuft nach einer Pause weiter. */
  resume(duration) {
    this.base = null;
    this.pendingFrom = duration;
    this.recent = [];
  }

  /** Pause: bisherigen Stand festhalten, bis `resume`. */
  pause() {
    this.carry = this.last;
    this.elapsedCarry = this.lastElapsed;
    this.base = null;
    this.pendingFrom = null;
    this.recent = [];
  }

  /**
   * Eine Messung (etwa jede Sekunde, nur während der Aufnahme).
   * @param {number} now Uhrzeit in ms
   * @param {number} duration aufgenommene Dauer in s
   * @returns {{deficit: number, elapsed: number}} Fehlbetrag (s, nie negativ) und gemessene Aufnahmezeit (s)
   */
  sample(now, duration) {
    if (!this.base) {
      if (this.pendingFrom == null || !(duration > this.pendingFrom)) return { deficit: this.last, elapsed: this.lastElapsed };
      this.base = { now, duration };
      this.pendingFrom = null;
    }
    const elapsed = (now - this.base.now) / 1000;
    const raw = this.carry + elapsed - (duration - this.base.duration);
    this.recent.push(raw);
    if (this.recent.length > this.windowSize) this.recent.shift();
    this.last = Math.max(0, Math.min(...this.recent));
    this.lastElapsed = this.elapsedCarry + elapsed;
    return { deficit: this.last, elapsed: this.lastElapsed };
  }
}

module.exports = { DeficitMeter };
