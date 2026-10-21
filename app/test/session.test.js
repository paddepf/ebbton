'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { setSettings, tmpDir, silence, src } = require('./helpers');

setSettings({ recordingsDir: tmpDir() });
const { Session } = require(src('main/session'));

/** Neue Session mit eigenem Ordner; nach jedem Test wird eine laufende Aufnahme beendet. */
async function withSession(fn) {
  setSettings({ recordingsDir: tmpDir() });
  const s = new Session();
  try {
    await fn(s);
  } finally {
    if (s.status === 'recording' || s.status === 'paused') s.stop();
    await s.whenWritten();
    s._stopAutosave();
    if (s._saveTimer) clearTimeout(s._saveTimer);
  }
}

const labels = (s) => s.placedSections().map((x) => `${x.label}:${x.start}-${x.end}`).join(' | ');

test('Abschnitte starten, beenden, N und Rückgängig', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.setAgenda([{ id: null, title: 'A' }, { id: null, title: 'B' }], 'plan');   // erst nach dem Start: kein Punkt beginnt von selbst
  s.pushAudio(silence(5));
  s.toggleSection({});
  s.pushAudio(silence(5));
  s.toggleSection({});
  assert.equal(labels(s), 'Abschnitt 1:5-10');
  s.undo();
  assert.equal(labels(s), 'Abschnitt 1:5-null');
  s.redo();
  s.startNextPending();
  assert.match(labels(s), /A:10-null/);
}));

test('Ablegen in eine Lücke füllt sie genau', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.setAgenda([{ id: null, title: 'Lied' }], 'plan');
  s.pushAudio(silence(60));
  s.startSection({ time: 10, label: 'A' }); s.endSection(20);
  s.startSection({ time: 40, label: 'B' }); s.endSection(50);
  const id = s.pendingSections()[0].id;
  assert.equal(s.placePending(id, 30).ok, true);
  assert.equal(labels(s), 'A:10-20 | Lied:20-40 | B:40-50');
}));

test('Beim Start beginnt der erste Ablaufpunkt, ohne Punkte passiert nichts', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'Einleitung' }, { id: null, title: 'Predigt' }], 'plan');
  assert.equal(s.start({ sampleRate: 8000, channels: 2 }).ok, true);
  assert.equal(s.currentSegment().label, 'Einleitung');
  assert.equal(s.currentSegment().start, 0);
  assert.deepEqual(s.pendingSections().map((x) => x.label), ['Predigt']);
  s.stop();
  await s.whenWritten();
  // Neue Aufnahme nach der beendeten: wieder mit dem ersten Punkt
  assert.equal(s.start({ sampleRate: 8000, channels: 2 }).ok, true);
  assert.equal(s.currentSegment().label, 'Einleitung');
  s.stop();
  await s.whenWritten();
}));

test('Punkt abschließen lässt eine Lücke bis zum nächsten Ablaufpunkt', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'Einleitung' }, { id: null, title: 'Predigt' }], 'plan');
  s.start({ sampleRate: 48000, channels: 2 });         // Einleitung beginnt bei 0
  s.pushAudio(silence(10));
  s.toggleSection({});                                  // M: Einleitung endet bei 10
  assert.equal(s.currentSegment(), null);
  s.pushAudio(silence(20));                             // 20 s Pause ohne aktiven Punkt
  s.startNextPending();                                 // N: Predigt beginnt bei 30
  assert.equal(labels(s), 'Einleitung:0-10 | Predigt:30-null');
}));

test('Ohne Ablaufpunkte läuft zu Beginn kein Abschnitt', () => withSession(async (s) => {
  assert.equal(s.start({ sampleRate: 8000, channels: 2 }).ok, true);
  assert.equal(s.currentSegment(), null);
}));

test('Schnitte: umschalten, verschmelzen, beim Stop schließen', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(20));
  s.toggleCut(12); s.toggleCut(14);
  s.addCut(13, 16);
  assert.deepEqual(s.cuts.map((c) => [c.start, c.end]), [[12, 16]]);
  assert.equal(s.addCut(NaN, 3).ok, false);
  s.toggleCut(18);
  s.stop();
  assert.deepEqual(s.cuts.map((c) => [c.start, c.end]), [[12, 16], [18, 20]]);
}));

test('Datei wird sofort angelegt, Änderungen nach dem Stop werden gespeichert', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  assert.ok(fs.existsSync(s.sessionFilePath()));
  s.pushAudio(silence(10));
  s.stop();
  await s.whenWritten();
  s.startSection({ time: 2, label: 'Nachher' });
  s.endSection(5);
  await new Promise((r) => setTimeout(r, 1000));
  const saved = JSON.parse(fs.readFileSync(s.sessionFilePath(), 'utf8'));
  assert.deepEqual(saved.sections.map((x) => x.label), ['Nachher']);
}));

test('Vorlage zweimal laden erzeugt keine Doppelten', () => withSession(async (s) => {
  const items = [{ id: null, title: 'Predigt' }, { id: null, title: 'Segen' }];
  s.setAgenda(items, 'plan');
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(2));
  s.startNextPending();
  s.setAgenda(items, 'plan');
  assert.deepEqual(s.sections.map((x) => x.label).sort(), ['Predigt', 'Segen']);
}));

test('Interpreten aus der Dienstplanung werden zugeordnet', () => withSession(async (s) => {
  s.setService({ id: 1, name: 'Test', suggestions: [{ role: 'Predigt 2', name: 'Ben' }] });
  const n = s.setAgenda([{ id: null, title: 'Predigt' }, { id: null, title: 'Einleitung' }], 'plan');
  assert.equal(n, 2);   // Einleitung: ohne Leitung macht der Prediger sie
  assert.deepEqual(s.pendingSections().map((x) => x.artist), ['Ben', 'Ben']);
}));

test('Infotext des Termins landet im Predigt-Abschnitt, nur einmal', () => withSession(async (s) => {
  s.setService({ id: 1, name: 'Bibelstunde', date: '2026-10-07', info: 'Kolosser 2,6-7 Verwurzelt in Christus' });
  const items = [{ id: null, title: 'Einleitung' }, { id: null, title: 'Predigt' }];
  s.setAgenda(items, 'plan');
  assert.deepEqual(s.sections.map((x) => x.label), ['Einleitung', 'Predigt: Kolosser 2,6-7 Verwurzelt in Christus']);
  // Erneutes Laden: kein Doppelter, kein zweites Anhängen
  s.setAgenda(items, 'plan');
  assert.equal(s.sections.filter((x) => x.label.startsWith('Predigt')).length, 1);
  assert.equal(s.sections.find((x) => x.label.startsWith('Predigt')).label, 'Predigt: Kolosser 2,6-7 Verwurzelt in Christus');
  // Ohne Infotext bleibt alles wie es ist
  const t = new (require(src('main/session')).Session)();
  t.setService({ name: 'X' });
  t.setAgenda([{ id: null, title: 'Predigt' }], 'plan');
  assert.equal(t.sections[0].label, 'Predigt');
  t._stopAutosave();
}));

test('alte Sessions mit Einzelmarkern werden übernommen', () => withSession(async (s) => {
  const dir = tmpDir();
  const file = path.join(dir, 'alt.session.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, duration: 10,
    markers: [{ id: 'a', label: 'A', time: 1, placed: true, source: 'manual' }, { id: 'b', label: 'B', time: 3, placed: true, source: 'manual' }]
  }));
  s.loadFromFile(file);
  assert.deepEqual(s.sections.map((x) => [x.label, x.start, x.end]), [['A', 1, 3], ['B', 3, 10]]);
}));

test('Fortsetzen hängt an dieselbe Datei an', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(3));
  s.stop();
  await s.whenWritten();
  assert.equal(s.continueRecording().ok, true);
  s.pushAudio(silence(2));
  s.stop();
  await s.whenWritten();
  const { readInfo } = require(src('main/wav'));
  assert.equal(readInfo(s.wavPath).duration, 5);
}));

test('Aussetzer des Eingangs: Lücke wird mit Stille gefüllt, Dauer und Datei stimmen, Vermerk in der Session', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(3));
  assert.equal(s.fillGap(4.3), 4.3);
  s.pushAudio(silence(2));
  assert.equal(s.duration, 9.3);
  assert.deepEqual(s.gaps, [{ at: 3, seconds: 4.3 }]);
  assert.equal(s.peaks.length, Math.round(9.3 * 1000 / 50));   // Wellenform wächst um die Lücke mit
  s.stop();
  await s.whenWritten();
  const { readInfo } = require(src('main/wav'));
  assert.equal(readInfo(s.wavPath).duration, 9.3);
  const saved = JSON.parse(fs.readFileSync(s.sessionFilePath(), 'utf8'));
  assert.deepEqual(saved.gaps, [{ at: 3, seconds: 4.3 }]);
  // Beim Laden bleibt der Vermerk erhalten.
  s.loadFromFile(s.sessionFilePath());
  assert.deepEqual(s.gaps, [{ at: 3, seconds: 4.3 }]);
}));

test('Lücken füllen: nur während der Aufnahme, nie ohne Dauer, höchstens fünf Minuten je Aussetzer', () => withSession(async (s) => {
  assert.equal(s.fillGap(2), 0);                       // vor dem Start
  s.start({ sampleRate: 8000, channels: 2 });
  assert.equal(s.fillGap(0), 0);
  assert.equal(s.fillGap(-1), 0);
  assert.equal(s.fillGap(100000), 300);                // gedeckelt
  assert.equal(s.duration, 300);
  s.stop();
  await s.whenWritten();
  assert.equal(s.fillGap(2), 0);                       // nach dem Beenden
}));

test('Punkt vor dem Start hineingezogen läuft ab 0:00 offen mit', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'A' }, { id: null, title: 'B' }], 'plan');
  const a = s.sections.find((x) => x.label === 'A');
  assert.equal(s.placePending(a.id, 7).ok, true);
  assert.equal(a.start, 0);
  assert.equal(a.end, null);
  assert.equal(s.placePending(s.sections.find((x) => x.label === 'B').id, 0).ok, false);
  s.start({ sampleRate: 48000, channels: 2 });
  assert.equal(s.openSection(), a);
  s.pushAudio(silence(3));
  s.startNextPending(s.duration);
  assert.equal(labels(s), 'A:0-3 | B:3-null');
}));

test('Neue Aufnahme vorbereiten: zurück vor den Start, Ablauf wieder offen, nichts läuft', () => withSession(async (s) => {
  s.setService({ name: 'Gottesdienst', date: '2026-10-11' });
  s.setAgenda([{ id: null, title: 'Einleitung' }, { id: null, title: 'Predigt' }], 'plan');
  s.start({ sampleRate: 8000, channels: 2 });
  s.pushAudio(silence(3));
  s.startNextPending();
  s.pushAudio(silence(2));
  s.toggleSection({});
  s.toggleSection({ label: 'Eigener' });
  s.pushAudio(silence(1));
  s.stop();
  await s.whenWritten();
  const wav = s.wavPath;
  s.prepareNext();
  assert.equal(s.status, 'idle');
  assert.equal(s.wavPath, null);
  assert.equal(s.duration, 0);
  assert.equal(s.service.name, 'Gottesdienst');
  assert.deepEqual(s.pendingSections().map((x) => x.label), ['Einleitung', 'Predigt']);   // eigener Abschnitt (M) entfällt
  assert.equal(s.placedSections().length, 0);
  assert.ok(fs.existsSync(wav));                                                           // die beendete Aufnahme bleibt
}));

test('Offener Schnitt überlappt beim Stop einen gezogenen: beide werden verschmolzen', () => withSession(async (s) => {
  s.start({ sampleRate: 48000, channels: 2 });
  s.pushAudio(silence(10));
  s.toggleCut();                       // offen ab 10 s
  s.pushAudio(silence(8));
  s.addCut(8, 13);
  s.stop();
  assert.deepEqual(s.cuts.map((c) => [c.start, c.end]), [[8, 18]]);
}));

test('Lücke füllen speichert den Vermerk zeitnah', () => withSession(async (s) => {
  s.start({ sampleRate: 8000, channels: 2 });
  s.pushAudio(silence(2));
  s._dirty = false;
  s.fillGap(1);
  assert.equal(s._dirty, true);
}));

test('Cue-Marker auch, wenn vor Ende des Schreibens schon die nächste Aufnahme vorbereitet wird', () => withSession(async (s) => {
  s.setAgenda([{ id: null, title: 'Einleitung' }], 'plan');
  s.start({ sampleRate: 8000, channels: 2 });
  s.pushAudio(silence(3));
  const wav = s.wavPath;
  s.stop();
  s.prepareNext();                     // wartet nicht auf whenWritten
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(fs.readFileSync(wav).includes(Buffer.from('cue ')));
}));
