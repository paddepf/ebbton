'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInputLog, localStamp } = require('../src/main/inputlog');

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ebbton-inputlog-')), 'logs', 'eingang.log');
}

test('schreibt eine Zeile je Ereignis mit Stufe, Name und Daten', () => {
  const file = tmpFile();
  const log = createInputLog(file);
  log.write('warn', 'luecke-zwischen-bloecken', { abstandMs: 812 });
  log.write('info', 'aufnahme-beendet', {});
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d \[warn\] luecke-zwischen-bloecken \{"abstandMs":812\}$/);
  assert.match(lines[1], / \[info\] aufnahme-beendet$/);
});

test('ohne Datei passiert nichts, und Fehler beim Schreiben werfen nie', () => {
  assert.doesNotThrow(() => createInputLog(null).write('info', 'x', { a: 1 }));
  // Ziel ist ein vorhandener Ordner: Schreiben scheitert, darf aber die Aufnahme nicht stören.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebbton-inputlog-'));
  assert.doesNotThrow(() => createInputLog(dir).write('info', 'x', {}));
});

test('Daten, die sich nicht als JSON schreiben lassen, kippen das Protokoll nicht', () => {
  const file = tmpFile();
  const log = createInputLog(file);
  const zyklisch = {};
  zyklisch.selbst = zyklisch;
  log.write('warn', 'x', zyklisch);
  assert.match(fs.readFileSync(file, 'utf8'), /\[warn\] x \{"fehler":"nicht lesbar"\}/);
});

test('große Datei wird zu .1 und beginnt neu', () => {
  const file = tmpFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'a'.repeat(2 * 1024 * 1024 + 10));
  createInputLog(file).write('info', 'neu', {});
  assert.ok(fs.existsSync(file + '.1'));
  assert.match(fs.readFileSync(file, 'utf8'), /\[info\] neu$/m);
  assert.ok(fs.statSync(file).size < 200);
});

test('Zeitstempel trägt den Offset der Ortszeit', () => {
  const d = new Date(2026, 9, 11, 10, 59, 2, 123);
  const stamp = localStamp(d);
  assert.ok(stamp.startsWith('2026-10-11T10:59:02.123'));
  assert.match(stamp, /[+-]\d\d:\d\d$/);
});
