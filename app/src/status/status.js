'use strict';

/* Statusseite für Handy und Tablet: liest per WebSocket mit (Rolle „monitor“, Browser dürfen ohnehin nur mitlesen). */
(() => {
  const $ = (id) => document.getElementById(id);
  const KEY = 'ebbton-status-password';
  let ws = null;
  let retry = null;
  let state = null;
  let duration = 0;
  let durationAt = 0;               // Zeitpunkt der letzten Dauer, damit der Timer zwischen den Meldungen weiterläuft
  let authFailed = false;
  let connected = false;            // getrennt: Zustand ist veraltet, der Timer zählt nicht weiter
  let levelsAt = 0;                 // letzte Pegelmeldung (kommen nur während der Aufnahme)

  const store = {
    get() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } },
    set(v) { try { if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch { /* privat */ } }
  };

  function fmt(sec, hours = true) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return hours || h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  function setConn(kind, text) {
    $('conn').dataset.state = kind;
    $('conn').textContent = text;
  }

  function showLogin(message) {
    $('status').hidden = true;
    $('login').hidden = false;
    $('login-error').hidden = !message;
    $('login-error').textContent = message || '';
    $('password').focus();
  }

  function connect() {
    clearTimeout(retry);
    const password = store.get();
    if (!password) return showLogin();
    authFailed = false;
    setConn('wait', 'verbinde …');
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', password, role: 'monitor' }));
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'auth' && msg.ok) {
        connected = true;
        $('status').classList.remove('stale');
        setConn('on', 'verbunden');
        $('login').hidden = true;
        $('status').hidden = false;
      } else if (msg.type === 'error' && /^auth_/.test(msg.code)) {
        authFailed = true;
        if (msg.code === 'auth_failed') store.set('');
        showLogin(msg.message);
      } else if (msg.type === 'state') {
        state = msg.payload;
        setDuration(state?.duration);
        render();
      } else if (msg.type === 'levels') {
        const l = msg.payload || {};
        setDuration(l.duration);
        levelsAt = Date.now();
        meter(l);
      }
    };
    ws.onclose = () => {
      if (connected) duration = liveDuration();   // Stand beim Abbruch festhalten
      connected = false;
      $('status').classList.add('stale');
      meter({});
      setConn('off', 'getrennt – Anzeige veraltet');
      if (!authFailed) retry = setTimeout(connect, 3000);
    };
  }

  function setDuration(d) {
    if (typeof d !== 'number') return;
    duration = d;
    durationAt = Date.now();
  }

  function liveDuration() {
    return connected && state?.status === 'recording' ? duration + (Date.now() - durationAt) / 1000 : duration;
  }

  function meter({ l = 0, r = 0 }) {
    // Pegel in dB (−60 … 0) auf die Breite abbilden
    const w = (v) => Math.max(0, Math.min(1, (20 * Math.log10(Math.max(v, 1e-6)) + 60) / 60));
    $('meter-l').style.clipPath = `inset(0 ${100 - w(l) * 100}% 0 0)`;
    $('meter-r').style.clipPath = `inset(0 ${100 - w(r) * 100}% 0 0)`;
  }

  const STATUS_TEXT = { idle: 'Bereit', recording: 'Aufnahme läuft', paused: 'Pausiert', stopped: 'Aufnahme beendet' };

  function render() {
    if (!state) return;
    const st = state.status || 'idle';
    $('state').dataset.status = st;
    $('state-text').textContent = STATUS_TEXT[st] || st;
    const svc = state.service || {};
    $('service').textContent = [svc.name, svc.date].filter(Boolean).join(' · ');
    document.title = `${st === 'recording' ? '● ' : ''}Ebbton – ${STATUS_TEXT[st] || 'Status'}`;

    const cur = state.currentSegment;
    $('current').textContent = cur ? cur.label : (st === 'recording' || st === 'paused' ? 'Zwischen den Punkten' : '–');
    const next = (state.pending || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0];
    $('next').textContent = next ? next.label : '–';

    const placed = (state.sections || []).filter((x) => x.start != null).sort((a, b) => a.start - b.start);
    const list = $('sections');
    list.innerHTML = '';
    placed.forEach((x) => {
      const li = document.createElement('li');
      if (x.end == null) li.className = 'live';
      const n = document.createElement('span');
      n.className = 'n';
      n.textContent = x.label;
      const t = document.createElement('span');
      t.className = 't';
      t.textContent = `${fmt(x.start, false)}${x.end != null ? ' · ' + fmt(x.end - x.start, false) : ''}`;
      li.append(n, t);
      list.appendChild(li);
    });

    renderAlerts(state.health || {}, st);
    tick();
  }

  function renderAlerts(h, st) {
    const busy = st === 'recording' || st === 'paused';
    const items = [];
    if (busy && h.input === 'lost') items.push(['error', 'Kein Audiosignal vom Eingang!']);
    else if (busy && h.input === 'silent') items.push(['warn', 'Seit über 20 s Stille am Eingang']);
    if (busy && h.deficit) items.push(['warn', `Aufnahme verliert Audio (etwa ${String(h.deficit).replace('.', ',')} s)`]);
    if (h.write === 'error') items.push(['error', 'Audio kann nicht gespeichert werden']);
    else if (h.write === 'slow') items.push(['warn', 'Laufwerk kommt nicht hinterher']);
    if (h.disk?.level === 'low') items.push(['error', 'Speicherplatz fast voll']);
    else if (h.disk?.level === 'warn') items.push(['warn', 'Speicherplatz wird knapp']);
    if (h.routing === 'mismatch') items.push(['warn', 'Routing am Mischpult passt nicht']);
    const box = $('alerts');
    box.innerHTML = '';
    items.forEach(([level, text]) => {
      const el = document.createElement('div');
      el.className = `alert ${level}`;
      el.textContent = `⚠ ${text}`;
      box.appendChild(el);
    });
  }

  function tick() {
    if (levelsAt && Date.now() - levelsAt > 600) {   // Pause, Ende: Pegel fällt auf null wie in der App
      levelsAt = 0;
      meter({});
    }
    if (!state) return;
    const d = liveDuration();
    $('timer').textContent = fmt(d);
    const cur = state.currentSegment;
    $('current-time').textContent = cur ? `seit ${fmt(d - cur.start, false)}` : '';
  }
  setInterval(tick, 250);

  $('login').addEventListener('submit', (e) => {
    e.preventDefault();
    store.set($('password').value);
    $('password').value = '';
    if (ws) { ws.onclose = null; ws.close(); }
    connect();
  });

  connect();
})();
