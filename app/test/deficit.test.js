'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { DeficitMeter } = require('../src/main/deficit');

/** Simuliert `seconds` Sekunden Aufnahme: je Sekunde kommen `rate` Sekunden Audio an, eine Messung pro Sekunde. */
function run(m, clock, seconds, rate = 1) {
  let r;
  for (let i = 0; i < seconds; i++) {
    clock.now += 1000;
    clock.duration += rate;
    r = m.sample(clock.now, clock.duration);
  }
  return r;
}

test('Fehlbetrag: vollständige Aufnahme hat keinen, auch nicht durch die Verzögerung des ersten Blocks', () => {
  const m = new DeficitMeter();
  const clock = { now: 0, duration: 0 };
  m.resume(0);
  assert.strictEqual(m.sample(clock.now + 300, 0).deficit, 0);   // noch kein Block: Messung beginnt nicht
  clock.now += 400; clock.duration = 0.1;                          // erster Block kommt verspätet
  m.sample(clock.now, clock.duration);
  const r = run(m, clock, 600);
  assert.ok(r.deficit < 0.01, `Fehlbetrag ${r.deficit}`);
  assert.ok(Math.abs(r.elapsed - 600) < 0.01);
});

test('Fehlbetrag: leiser Verlust von 1,5 % wird gemessen', () => {
  const m = new DeficitMeter();
  const clock = { now: 0, duration: 0 };
  m.resume(0);
  clock.now += 100; clock.duration = 0.1; m.sample(clock.now, clock.duration);
  const r = run(m, clock, 420, 0.985);
  assert.ok(Math.abs(r.deficit - 6.17) < 0.2, `Fehlbetrag ${r.deficit}`);   // 1,5 % von ~411 s im Fenster-Minimum
});

test('Fehlbetrag: Blöcke, die nach einem Hänger gesammelt nachkommen, zählen nicht', () => {
  const m = new DeficitMeter();
  const clock = { now: 0, duration: 0 };
  m.resume(0);
  clock.now += 100; clock.duration = 0.1; m.sample(clock.now, clock.duration);
  run(m, clock, 30);
  run(m, clock, 4, 0);          // 4 s kommt nichts an …
  clock.now += 1000; clock.duration += 5;   // … dann alles auf einmal
  let r = m.sample(clock.now, clock.duration);
  r = run(m, clock, 15);
  assert.ok(r.deficit < 0.01, `Fehlbetrag ${r.deficit}`);
});

test('Fehlbetrag: Pause zählt nicht, der Stand davor bleibt', () => {
  const m = new DeficitMeter();
  const clock = { now: 0, duration: 0 };
  m.resume(0);
  clock.now += 100; clock.duration = 0.1; m.sample(clock.now, clock.duration);
  const before = run(m, clock, 100, 0.98);
  m.pause();
  clock.now += 300000;          // 5 min Pause
  m.resume(clock.duration);
  clock.now += 100; clock.duration += 0.1; m.sample(clock.now, clock.duration);
  const after = run(m, clock, 60);
  assert.ok(Math.abs(after.deficit - before.deficit) < 0.05, `${before.deficit} → ${after.deficit}`);
  assert.ok(Math.abs(after.elapsed - 160) < 0.5, `gemessen ${after.elapsed}`);
});

test('Fehlbetrag: neue Aufnahme beginnt bei null', () => {
  const m = new DeficitMeter();
  const clock = { now: 0, duration: 0 };
  m.resume(0);
  clock.now += 100; clock.duration = 0.1; m.sample(clock.now, clock.duration);
  run(m, clock, 100, 0.9);
  m.reset();
  m.resume(clock.duration);
  assert.strictEqual(m.sample(clock.now, clock.duration).deficit, 0);
});
