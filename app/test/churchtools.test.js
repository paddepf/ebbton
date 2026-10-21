'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSettings, src } = require('./helpers');

setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [] });
const ct = require(src('main/churchtools'));

let routes = {};
global.fetch = async (url) => {
  const u = new URL(url);
  const key = u.pathname + (u.searchParams.get('page') ? `?page=${u.searchParams.get('page')}` : '');
  const body = routes[key] ?? routes[u.pathname];
  if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

test('Termine über mehrere Seiten, Kalender-Filter', async () => {
  routes = {
    '/api/events?page=1': { data: [{ id: 1, name: 'A', startDate: '2026-10-04T08:00:00Z', calendar: { id: 2 } }], meta: { pagination: { lastPage: 2 } } },
    '/api/events?page=2': { data: [{ id: 2, name: 'B', startDate: '2026-10-05T08:00:00Z', calendar: { id: 5 } }], meta: { pagination: { lastPage: 2 } } }
  };
  setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [] });
  assert.deepEqual((await ct.listServices('2026-10-04', '2026-10-05')).map((x) => x.name), ['A', 'B']);
  setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [5] });
  assert.deepEqual((await ct.listServices('2026-10-04', '2026-10-05')).map((x) => x.name), ['B']);
});

test('Ein Tag (from = to): ChurchTools-`to` ist exklusiv, Termine anderer Tage bleiben draußen', async () => {
  routes = {
    '/api/events?page=1': { data: [
      { id: 1, name: 'Heute', startDate: new Date(2026, 9, 7, 19, 0).toISOString() },
      { id: 2, name: 'Morgen', startDate: new Date(2026, 9, 8, 19, 0).toISOString() }
    ], meta: { pagination: { lastPage: 1 } } }
  };
  setSettings({ churchToolsUrl: 'https://x.church.tools', churchToolsCalendarIds: [] });
  assert.deepEqual((await ct.listServices('2026-10-07', '2026-10-07')).map((x) => x.name), ['Heute']);
});

test('Ablaufplan: flache Überschriften werden zur Kategorie, Person zum Interpreten', async () => {
  routes = {
    '/api/events/9/agenda': {
      data: {
        items: [
          { type: 'header', title: 'Eingang' },
          { id: 1, title: 'Begrüßung', responsible: { text: 'Anna', persons: [{ person: { domainAttributes: { firstName: 'Anna', lastName: 'Beispiel' } } }] } },
          { type: 'header', title: 'Verkündigung' },
          { id: 2, title: 'Predigt', responsible: 'Ben Muster' }
        ]
      }
    }
  };
  const plan = await ct.agenda(9);
  assert.deepEqual(plan.items.map((x) => [x.title, x.category, x.responsible]),
    [['Begrüßung', 'Eingang', 'Anna Beispiel'], ['Predigt', 'Verkündigung', 'Ben Muster']]);
});

test('Dienstplanung: Personen der gewünschten Dienste', async () => {
  ct.resetCache();
  routes = {
    '/api/services': { data: [{ id: 1, name: 'Leitung' }, { id: 2, name: 'Predigt' }, { id: 3, name: 'Technik' }] },
    '/api/events/10': { data: { eventServices: [{ serviceId: 1, name: 'Anna' }, { serviceId: 2, person: { domainAttributes: { firstName: 'Ben', lastName: 'M' } } }, { serviceId: 3, name: 'Cara' }] } }
  };
  const res = await ct.eventServices(10, ['Leitung', 'Predigt']);
  assert.deepEqual(res.suggestions, [{ role: 'Leitung', name: 'Anna' }, { role: 'Predigt', name: 'Ben M' }]);
});

test('Infotext des Termins: erste Zeile, ohne HTML und doppelte Leerzeichen', async () => {
  assert.equal(ct.eventInfoText({ description: '<p>Kolosser 2,6-7  Verwurzelt in Christus</p><p>Bitte Bibel mitbringen</p>' }), 'Kolosser 2,6-7 Verwurzelt in Christus');
  assert.equal(ct.eventInfoText({ description: '', note: 'Kolosser 2,6-7\nweiter' }), 'Kolosser 2,6-7');
  assert.equal(ct.eventInfoText({ name: 'x' }), null);
  assert.equal(ct.eventInfoText(null), null);
  ct.resetCache();
  routes = { '/api/events/12': { data: { description: 'Römer 8', eventServices: [] } } };
  assert.equal((await ct.eventServices(12, [])).info, 'Römer 8');
});

test('Gerade Anführungszeichen werden typografisch', () => {
  assert.equal(ct.typoQuotes('Predigt: Kolosser 2,6-7 "Verwurzelt in Christus"'), 'Predigt: Kolosser 2,6-7 „Verwurzelt in Christus“');
  assert.equal(ct.typoQuotes('"Gott ist treu" (Ps 33)'), '„Gott ist treu“ (Ps 33)');
  assert.equal(ct.typoQuotes("Gottes Wort und Jesu' Ruf, 'kurz'"), 'Gottes Wort und Jesu’ Ruf, ‚kurz‘');
  assert.equal(ct.typoQuotes("'Gott's Wort'."), '‚Gott’s Wort‘.');
  assert.equal(ct.typoQuotes('ohne'), 'ohne');
  assert.equal(ct.eventInfoText({ description: 'Römer 8 "Nichts kann uns trennen"' }), 'Römer 8 „Nichts kann uns trennen“');
  // HTML-Entities in einem Durchgang: &amp;quot; bleibt &quot;, numerische werden zu Zeichen
  assert.equal(ct.eventInfoText({ description: '<p>A &amp;quot; &lt;B&gt; &#8222;C&#x201C;</p>' }), 'A &quot; <B> „C“');
});

test('404 trägt den Status, kaputte Antwort eine klare Meldung', async () => {
  routes = {};
  await assert.rejects(ct.agenda(77), (err) => err.status === 404);
  global.fetch = async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } });
  await assert.rejects(ct.listCalendars(), /keine gültige Antwort/);
});

test('rawDump: stellt dieselben Anfragen, Fehler brechen nicht ab, Personen nur mit Id', async () => {
  setSettings({ churchToolsUrl: 'https://beispiel.church.tools/' });
  const asked = [];
  const dump = await ct.rawDump(42, {
    requester: async (pfad, params) => {
      asked.push(pfad);
      if (pfad.endsWith('/agenda')) { const e = new Error('ChurchTools meldet Fehler 404.'); e.status = 404; throw e; }
      if (pfad === '/api/events/42') return { data: { id: 42, eventServices: [{ personId: 7 }, { personId: 7 }, { person: { firstName: 'A' }, personId: 8 }] } };
      return { data: [] };
    }
  });
  assert.deepEqual(asked, ['/api/events/42', '/api/events/42/agenda', '/api/services', '/api/persons/7']);
  assert.equal(dump.adresse, 'https://beispiel.church.tools');
  assert.deepEqual(dump.anfragen[0].params, { include: 'eventServices' });
  assert.equal(dump.anfragen[1].status, 404);
  assert.match(dump.anfragen[1].fehler, /404/);
});

test('503 (Störung beim Anbieter): verständliche Meldung mit Hinweis auf die Vorlage', async () => {
  global.fetch = async () => ({ ok: false, status: 503, json: async () => { throw new SyntaxError('html'); } });
  await assert.rejects(ct.listCalendars(), (err) => err.status === 503 && /vorübergehend nicht erreichbar/.test(err.message) && /Vorlage/.test(err.message));
});
