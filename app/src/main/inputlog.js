/* Protokoll des Audioeingangs: `<userData>/logs/eingang.log`.

   Anlass: Die App meldete während einer Aufnahme immer wieder „Kein Audiosignal – der Eingang wird neu
   verbunden“, obwohl am Pult nichts zu sehen war. Dieses Protokoll hält fest, WANN etwas aussetzte, WIE lange
   und in welchem Zustand Eingang, Oberfläche und Rechner dabei waren, damit sich die Ursache später ablesen lässt.
   Eine Zeile je Ereignis: Zeit (lokal, mit Offset) · Stufe · Ereignis · Daten als JSON. */

'use strict';

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024;   // darüber wird die Datei zu `eingang.log.1` (ein vorhandenes `.1` wird ersetzt)

/** Zeit als ISO-Text in Ortszeit mit Offset, z. B. 2026-10-11T10:59:02.123+02:00 (UTC-Texte sind am Kirchen-PC schwer zu lesen). */
function localStamp(date = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

/**
 * @param {string|null} file Zieldatei; null = nichts schreiben (Tests ohne Datei)
 * @returns {{write: (level: string, event: string, data?: object) => void, file: string|null}}
 */
function createInputLog(file) {
  let ready = false;

  function write(level, event, data) {
    if (!file) return;
    let json = '';
    try { json = data && Object.keys(data).length ? ' ' + JSON.stringify(data) : ''; } catch { json = ' {"fehler":"nicht lesbar"}'; }
    const line = `${localStamp()} [${level}] ${event}${json}\n`;
    try {
      if (!ready) { fs.mkdirSync(path.dirname(file), { recursive: true }); ready = true; }
      try { if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1'); } catch { /* noch keine Datei */ }
      fs.appendFileSync(file, line, 'utf8');
    } catch { /* Das Protokoll ist nur Hilfe und darf die Aufnahme nie stören. */ }
  }

  return { write, file };
}

module.exports = { createInputLog, localStamp };
