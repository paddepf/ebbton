/* Ebbton – Oberflächenlogik */

(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const fmt = window.formatTime;

  const state = {
    loud: new window.LoudnessCurve.Curve([]),   // Lautheit je 100 ms (vom Hauptprozess gemessen)
    settings: null,
    session: null,
    peaks: [],
    duration: 0,
    selectedSectionId: null,
    selectedSegmentId: null,
    exportChecked: new Set(),   // zum Export angehakte Segment-IDs
    exportSeen: new Set(),      // schon einmal angezeigte Segment-IDs (für die Vorauswahl)
    playing: false,
    starting: false,
    bucketAcc: 0,
    bucketFrames: 0,
    sampleRate: 48000,
    cursorT: null,           // Hörcursor während der Aufnahme
    lastChunkAt: 0,          // Zeitpunkt des letzten Audioblocks vom Eingang
    chunkSeq: 0,
    recovering: false
  };

  const capture = new window.Capture();
  let wave = null;
  const monitor = new window.Monitor({
    read: (start, seconds) => window.api.record.readAudio(start, seconds),
    isLive: () => state.session?.status === 'recording',
    onPosition: (t) => {
      state.cursorT = t;
      wave.update({ playhead: t });
    },
    onStateChange: () => updatePlayButton()
  });

  /* ------------------------------------------------------------- Hilfsmittel */

  /**
   * Meldung. Fehler und Warnungen erscheinen groß und farbig oben in der Mitte und bleiben länger stehen
   * (Klick schließt); Hinweise bleiben klein unten rechts. Dieselbe Meldung nie doppelt, höchstens drei je Ort.
   */
  function toast(level, message, timeout = 6000, action = null) {
    const alert = level === 'error' || level === 'warn';
    const el = document.createElement('div');
    el.className = alert ? 'alert' : 'toast';
    el.dataset.level = level;
    const text = document.createElement('span');
    text.className = 'msg';
    text.textContent = message;
    el.appendChild(text);
    // Hinweis mit Knopf, z. B. „Rückgängig“ nach dem Entfernen eines Abschnitts
    if (action && !alert) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', () => { el.remove(); action.run(); });
      el.appendChild(btn);
    }
    if (alert) {
      el.title = 'Klicken zum Schließen';
      el.addEventListener('click', () => el.remove());
      timeout = Math.max(timeout, level === 'error' ? 30000 : 15000);
    }
    const box = $(alert ? 'alerts' : 'toasts');
    [...box.children].filter((c) => c.textContent === message).forEach((c) => c.remove());
    while (box.children.length >= 3) box.firstElementChild.remove();
    box.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  function fileUrl(p) {
    // Windows liefert "C:\Ordner\datei.wav", macOS und Linux "/Ordner/datei.wav".
    // Beide müssen zu genau drei Schrägstrichen nach "file:" führen.
    const normalized = String(p).replace(/\\/g, '/').replace(/^\/+/, '');
    return encodeURI('file:///' + normalized).replace(/#/g, '%23');
  }

  function longTime(t) {
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(h)}:${p(m)}:${p(s)}`;
  }

  /* ------------------------------------------------------------------ Start */

  async function init() {
    const info = await window.api.app.info();
    const cfg = await window.api.settings.get();
    state.dense = Boolean(info.dense);
    applyCompact(info.compact, info.compactOnTop);
    state.settings = cfg.settings;
    state.sampleRate = state.settings.sampleRate || 48000;
    applyTheme(state.settings.theme);

    wave = new window.Waveform($('wave'), {
      colors: readColors(),
      overviewCanvas: $('overview'),
      onEdgeMove: () => {},       // Listen erst nach dem Loslassen aktualisieren
      onEdgeMoveEnd: async (id, edge, time) => {
        await window.api.section.moveEdge(id, edge, time);
      },
      onSeek: (t) => setPlayhead(t, true),
      onFollowChange: (on) => { $('chk-follow').checked = on; },
      onCutAdd: async (start, end) => {
        const res = await window.api.cut.add(start, end);
        if (!res.ok) toast('warn', res.error);
      },
      onCutMoveEnd: async (id, edge, time) => { await window.api.cut.moveEdge(id, edge, time); },
      onLoudness: (data) => renderLoudnessReadout(data),
      onCutRemove: async (id) => {
        await window.api.cut.remove(id);
      },
      onRenameSection: (id, focus, r) => {
        const cv = $('wave').getBoundingClientRect();
        editSection(id, focus, { left: cv.left + r.x, top: cv.top + r.y, width: r.w, height: r.h });
      },
      onSelectSection: (id) => {
        state.selectedSectionId = id;
        renderLists();
      },
      onDropPending: async (id, time) => {
        const res = await window.api.section.place(id, time);
        if (!res.ok) toast('error', res.error);
      }
    });

    setDefaultZoom();
    setFollow(followDefault());
    bindUi();
    bindEvents();
    renderShortcuts(info.platform);
    applyPlatformTitles(info.platform);
    refreshDisk();
    setInterval(refreshDisk, 30000);
    await refreshDevices();
    applySettingsToForm();
    window.api.mixer.state().then((r) => { if (r.ok) renderMixer(r.mixer); });
    window.api.multitrack.state().then((r) => { if (r.ok) { mt.monitor = r.monitor; renderChannels(); } });
    await updateBadges(info);
    $('version-info').textContent = `Version ${info.version}`;
    if (info.update) {
      applyUpdateStatus({ ...info.update, currentVersion: info.update.currentVersion || info.version });
      // Nach dem Neustart durch ein Update bestätigen, dass es geklappt hat (sonst sieht man es nirgends).
      const ju = info.update.justUpdated;
      if (ju) toast('success', `Ebbton wurde aktualisiert: Version ${ju.from} → ${ju.to}.`, 10000);
    }

    const st = await window.api.session.state();
    if (st.ok) {
      setLoudness(st.loudness);
      applyState(st.state, st.peaks);
      if (st.state.status === 'stopped') fitZoom();
    }

    // Die Oberfläche wurde mitten in einer Aufnahme neu geladen (Absturz o. Ä.): Die Aufnahme läuft im
    // Hauptprozess weiter, nur die Erfassung fehlt – sofort wieder mit dem Eingang verbinden.
    if (isLive()) {
      // Mehrspur: Erfasst wird im Mehrspur-Prozess, die Oberfläche muss nichts wieder verbinden.
      if (isMultitrack()) return;
      state.lastChunkAt = 0;
      toast('warn', 'Die Oberfläche wurde neu geladen – der Audioeingang wird wieder verbunden.', 8000);
      recoverCapture({ quiet: true });
      return;
    }

    await checkRecovery();

    if (state.settings.autoLoadTodaysService && state.settings.churchToolsUrl && state.settings.churchToolsTokenSet) {
      loadServicesForDate(localIsoDate(), true);
    }
  }

  /** Zeigt, wie lange der aktuelle Abschnitt schon läuft (m:ss, ab einer Stunde h:mm:ss). */
  function updateSectionElapsed() {
    const el = $('current-elapsed');
    const start = state.sectionStart;
    el.hidden = start == null;
    if (start == null) { $('now-elapsed').textContent = ''; return; }
    el.textContent = fmtLength((state.duration || 0) - start);
    $('now-elapsed').textContent = el.textContent;
    // Der laufende Abschnitt in der Liste zählt mit
    const live = document.querySelector('#flow-list .dur[data-live]');
    if (live) live.textContent = fmtLength((state.duration || 0) - Number(live.dataset.start));
  }

  /** Länge als m:ss, ab einer Stunde h:mm:ss. */
  function fmtLength(seconds) {
    const t = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = String(t % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  async function updateBadges(info) {
    const net = await window.api.net.status();
    if (net.ok) renderNetInfo(net);
  }

  /** Netzwerkstatus in den Einstellungen, dazu die Adresse der Statusseite für Handy/Tablet. */
  function renderNetInfo(net) {
    const info = $('net-info');
    info.textContent = net.running
      ? `● Läuft auf Port ${net.port} · ${net.clients} ${net.clients === 1 ? 'Verbindung' : 'Verbindungen'}`
      : (net.passwordSet ? '● Aus' : '● Aus – es fehlt das Passwort für die Steuerung');
    info.dataset.level = net.running ? 'ok' : (net.passwordSet ? '' : 'warn');
    const urls = net.running ? net.statusUrls || [] : [];
    $('net-status-page').hidden = urls.length === 0;
    $('net-status-urls').textContent = urls.join('  ·  ');
  }

  /** Standardansicht der Wellenform: 5 Minuten sichtbar. */
  const DEFAULT_VISIBLE_SECONDS = 300;

  function setDefaultZoom() {
    wave.scrollT = 0;
    wave.setZoom(wave.width / DEFAULT_VISIBLE_SECONDS, 0);
  }

  /** Zeigt die gesamte Aufnahme auf einen Blick. */
  function fitZoom() {
    const d = state.session?.duration || 0;
    if (d <= 0) return;
    wave.scrollT = 0;
    wave.setZoom(($('wave').clientWidth - 8) / d, 0);
  }

  function readColors() {
    const s = getComputedStyle(document.documentElement);
    const v = (n) => s.getPropertyValue(n).trim();
    return {
      bg: v('--wave-bg'),
      ruler: v('--ruler-bg'),
      flagText: v('--wave-flag-text'),
      stripe: v('--wave-stripe'),
      hover: v('--wave-hover'),
      line: v('--line'),
      wave: v('--wave'),
      muted: v('--muted'),
      text: v('--text'),
      plan: v('--plan'),
      manual: v('--manual'),
      tally: v('--tally'),
      selection: v('--wave-selection'),
      cut: v('--cut'),
      cutText: v('--cut-text'),
      loud: v('--loud'),
      loudGrid: v('--loud-grid'),
      loudBox: v('--loud-box'),
      sections: Array.from({ length: 8 }, (_, i) => v(`--sec-${i}`))
    };
  }

  const themeQuery = window.matchMedia('(prefers-color-scheme: light)');

  /** Setzt das Farbschema ('dark' | 'light' | 'system') und färbt die Wellenform neu ein. */
  function applyTheme(mode) {
    const light = mode === 'light' || (mode === 'system' && themeQuery.matches);
    document.documentElement.dataset.theme = light ? 'light' : 'dark';
    const btn = document.getElementById('btn-theme');
    if (btn) btn.title = light ? 'Zu dunkel wechseln' : 'Zu hell wechseln';
    if (wave) {
      wave.colors = readColors();
      wave.draw();
    }
  }
  themeQuery.addEventListener('change', () => applyTheme(state.settings?.theme));

  /** Kopfleiste: direkt zwischen hell und dunkel wechseln (auch aus „wie das System“ heraus) und speichern. */
  async function toggleTheme() {
    const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    const res = await window.api.settings.set({ theme: next });
    if (!res.ok) return toast('error', res.error);
    state.settings = res.settings;
    $('set-theme').value = next;
  }

  /* ------------------------------------------------------------- Zustandsbild */

  /**
   * Phase der Oberfläche: prep (vor dem Start), rec (Aufnahme oder Pause), save (beendet, mit Audio). Je Phase gibt es
   * genau eine Hauptaktion; was nicht passt, blendet CSS über body[data-phase] aus.
   */
  function phaseOf(session) {
    const st = session?.status;
    if (st === 'recording' || st === 'paused') return 'rec';
    if (st === 'stopped' && hasAudio(session)) return 'save';
    return 'prep';
  }

  /** Datum des Gottesdienstes für Menschen: „So., 11. Okt. 2026“ (in Dateinamen bleibt es ISO). */
  function serviceDateText(service) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(service?.date || '');
    if (!m) return service?.date || '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** Kurzes Einblenden des Bereichs „Jetzt“, wenn die Phase wechselt (Start, Beenden, Neue Aufnahme). */
  function fadeNowPanel() {
    const p = $('panel-now');
    p.classList.remove('fade');
    void p.offsetWidth;
    p.classList.add('fade');
  }

  function applyState(session, peaks) {
    const wasRecording = state.session?.status === 'recording';
    const prevPhase = document.body.dataset.phase;
    state.session = session;
    if (wasRecording && session.status === 'paused' && !peaks) resyncPeaks();
    if (peaks) {
      state.peaks = peaks;
      wave.peaks = state.peaks;
    }
    state.duration = session.duration || 0;

    const phase = phaseOf(session);
    document.body.dataset.status = session.status;
    document.body.dataset.phase = phase;
    // Nach dem Beenden zeigt das Mini-Fenster statt der Aufnahmeknöpfe den MP3-Export (bei Mehrspur die Zusammenfassung).
    document.body.classList.toggle('review', phase === 'save');
    // Art der angezeigten Aufnahme (kann von der eingestellten abweichen): Mehrspur hat keinen MP3-Export.
    document.body.classList.toggle('mt-session', session.mode === 'multitrack');
    document.querySelectorAll('#phase-steps li').forEach((li) => li.classList.toggle('on', li.dataset.step === phase));
    if (prevPhase && prevPhase !== phase) fadeNowPanel();
    applyMode();
    $('service-name').textContent = session.service?.name || 'Gottesdienst wählen …';
    $('btn-service').classList.toggle('unset', !session.service?.name);
    $('service-date').textContent = serviceDateText(session.service);
    {
      // Herkunft des Ablaufplans (agendaOrigin; bei alten Sessions aus den Quellen der Punkte abgeleitet) und
      // was sonst noch aus ChurchTools stammt (Termin, Dienstplanung, Infotext).
      const plan = (session.sections || []).filter((x) => x.source !== 'manual');
      const el = $('plan-source');
      el.hidden = plan.length === 0;
      if (plan.length) {
        const origin = session.agendaOrigin;
        const ct = origin ? origin.source === 'churchtools' : plan.some((x) => x.source === 'churchtools');
        const tplName = origin?.template;
        const head = ct ? 'Ablaufplan aus ChurchTools' : `Vorlage${tplName ? ` „${tplName}“` : ''}`;
        const svc = session.service || {};
        let line = head;
        let detail = head;
        if (svc.id != null) {
          const names = [...new Set((svc.suggestions || []).map((x) => x.name))];
          line += ` · Dienste: ${names.length}${svc.info ? ' · Infotext ✓' : ''}`;
          detail += `\nDienstplanung: ${names.join(', ') || 'keine'}\nInfotext: ${svc.info || 'keiner'}`;
        }
        const lines = [line];
        el.replaceChildren(...lines.map((t) => { const d = document.createElement('div'); d.textContent = t; return d; }));
        el.title = detail;
      }
    }

    const rec = session.status === 'recording';
    const paused = session.status === 'paused';
    const stopped = session.status === 'stopped';
    const live = rec || paused;
    const multi = session.mode === 'multitrack';

    // Vorbereiten: „Aufnahme starten“ (rot). Sichern: „Neue Aufnahme“ leise neben dem Sichern-Knopf.
    $('record-label').textContent = phase === 'save' ? (multi ? 'Neue Aufnahme starten' : 'Neue Aufnahme') : 'Aufnahme starten';
    $('btn-record').classList.toggle('go', phase === 'prep');
    $('btn-record').disabled = live || state.starting;
    $('btn-continue').disabled = state.starting;
    $('now-continue').disabled = state.starting;
    // Pause als Symbol; pausiert wird daraus „Fortsetzen“ (gelb)
    const pauseBtn = $('btn-pause');
    pauseBtn.disabled = !live;
    pauseBtn.dataset.state = paused ? 'paused' : 'running';
    $('pause-label').textContent = paused ? 'Fortsetzen' : 'Pause';
    pauseBtn.setAttribute('aria-label', paused ? 'Fortsetzen' : 'Pause');
    pauseBtn.title = paused ? 'Aufnahme fortsetzen' : 'Pausieren (die Pause fehlt später in der Datei)';
    $('btn-stop').disabled = !live;
    $('btn-marker').disabled = !live;
    // Läuft ein Abschnitt, beendet M ihn: die Aufnahme läuft ohne aktiven Punkt weiter (Pause zwischen den Punkten),
    // bis N den nächsten beginnt.
    $('marker-label').textContent = session.currentSegment ? 'beenden' : 'starten';
    $('btn-marker').title = session.currentSegment
      ? 'Laufenden Abschnitt beenden (M): Die Aufnahme läuft weiter, die Pause gehört zu keinem Abschnitt – N beginnt den nächsten Punkt.'
      : 'Eigenen Abschnitt an der aktuellen Stelle beginnen (M). Den nächsten Punkt aus dem Ablauf beginnt N.';
    // N zeigt, was er gleich beginnt (der erste offene Punkt nach der Reihenfolge des Ablaufs). Ist keiner mehr offen,
    // täte N dasselbe wie M: dann verschwindet der Knopf und M wird zum Hauptknopf (body[data-next="none"]); die Taste N
    // beendet weiterhin den laufenden Abschnitt.
    const nextPoint = nextPending(session);
    document.body.dataset.next = live && nextPoint ? 'yes' : 'none';
    $('btn-next-item').disabled = !live || !nextPoint;
    $('next-name').textContent = nextPoint ? nextPoint.label : '';
    $('btn-next-item').title = nextPoint
      ? `Nächster Punkt (N): laufenden Abschnitt beenden und „${fullTitle(nextPoint)}“ beginnen`
      : 'Kein offener Punkt mehr';
    const openCut = (session.cuts || []).some((c) => c.end == null);
    $('btn-cut').dataset.on = String(openCut);
    $('cut-label').textContent = openCut ? 'Schnitt beenden' : 'Schnitt';
    applyPlayControls();

    if (stopped && session.wavPath) {
      const url = fileUrl(session.wavPath);
      if ($('player').getAttribute('src') !== url) $('player').setAttribute('src', url);
    }

    // Laufender Abschnitt mit Interpret (Mini-Fenster); ein Klick darauf bearbeitet beides.
    const cur = live ? session.currentSegment : null;
    const curSection = cur ? (session.sections || []).find((y) => y.id === cur.markerId) : null;
    $('current-name').textContent = live
      ? (cur?.label || ((session.pending || []).length ? 'Zwischen den Punkten' : 'Kein Abschnitt'))
      : (stopped ? 'Aufnahme beendet' : 'Bereit');
    const artistEl = $('current-artist');
    artistEl.hidden = !curSection;
    artistEl.textContent = curSection ? (curSection.artist || 'Interpret ergänzen') : '';
    artistEl.classList.toggle('unset', Boolean(curSection) && !curSection.artist);
    $('current-item').disabled = !curSection;
    // Laufzeit des aktuellen Abschnitts (tickt mit den Pegelmeldungen weiter)
    state.sectionStart = curSection && cur.open !== false ? cur.start : null;
    if (curSection) $('current-item').style.setProperty('--sec', window.sectionColorVar(curSection));
    else $('current-item').style.removeProperty('--sec');
    $('current-item').dataset.live = curSection ? 'true' : 'false';

    if (!rec) $('timecode').textContent = longTime(session.duration || 0);

    wave.loudnessLive = session.status === 'recording' || session.status === 'paused';
    wave.update({
      duration: session.duration || 0,
      sections: (session.sections || []).map((x) => ({ ...x })),
      cuts: (session.cuts || []).map((c) => ({ ...c })),
      recording: rec,
      selectedSegment: session.segments?.find((s) => s.id === state.selectedSegmentId) || null
    });

    renderLists();
    renderNow();
    updateSectionElapsed();
    updatePrelisten();
  }

  /**
   * N: laufenden Abschnitt beenden und den nächsten offenen Punkt beginnen. Ohne offenen Punkt beendet N nur den laufenden
   * Abschnitt (der Knopf ist dann ausgeblendet, M übernimmt das sichtbar).
   */
  async function nextItem() {
    const s = state.session;
    if (!isLive() || (!nextPending(s) && !s.currentSegment)) return;
    const res = await window.api.section.next();
    if (!res.ok) return toast('warn', res.error);
    const btn = nextPending(s) ? $('btn-next-item') : $('btn-marker');
    flashButton(btn, res.section?.id);
  }

  /** Erster offener Ablaufpunkt (nach der Reihenfolge des Ablaufs) – den beginnt N bzw. der Start. */
  function nextPending(session = state.session) {
    return (session?.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0))[0] || null;
  }

  /** Zustand unter dem Timer: Bereit · Aufnahme läuft · Pausiert · Beendet (mit Sicherungsstand). */
  function renderStatusLine() {
    const s = state.session;
    const el = $('status-line');
    const phase = document.body.dataset.phase;
    let text = 'Bereit';
    let warn = false;
    if (s?.status === 'recording') text = 'Aufnahme läuft';
    else if (s?.status === 'paused') text = 'Pausiert';
    else if (phase === 'save') {
      if (s.mode === 'multitrack') {
        const n = (s.tracks || []).length;
        text = `Beendet · ${n} ${n === 1 ? 'Spur' : 'Spuren'}`;
      } else {
        const real = (s.segments || []).filter((g) => g.markerId && !g.open);
        const unsaved = unsavedSegments().length;
        text = real.length === 0 ? 'Beendet' : (unsaved ? `Beendet · ${unsaved} ungesichert` : 'Beendet · alles gesichert');
        warn = unsaved > 0;
      }
    } else if (prelisten.on) {
      text = 'Bereit · Pegel live';
    }
    // Mehrspur: rechts steht „Kanäle“ statt „Jetzt“, deshalb hier der laufende Abschnitt
    if (s?.mode === 'multitrack' && isLive() && s.currentSegment?.label) text += ` · ${s.currentSegment.label}`;
    $('status-text').textContent = text;
    el.dataset.warn = String(warn);
    el.title = text;
  }

  /** Gleicht die lokal mitgerechnete Wellenform mit der tatsächlich geschriebenen Datei ab. */
  async function resyncPeaks() {
    const full = await window.api.session.state();
    if (!full.ok || state.session?.status === 'recording') return;
    state.peaks = full.peaks || [];
    wave.peaks = state.peaks;
    setLoudness(full.loudness);
    state.bucketAcc = 0;
    state.bucketFrames = 0;
    wave.draw();
  }

  /* ------------------------------------------------------------- Lautheit */

  /** Ersetzt die Lautheitskurve (Laden, Fortsetzen, Neuabgleich); [] bei neuer Aufnahme. */
  function setLoudness(list) {
    state.loud.reset(Array.isArray(list) ? list : []);
    wave.loudness = state.loud;
    wave._loudCache = null;
    wave.draw();
  }

  /** Voreinstellungen der Schalter „LUFS“ und „Folgen“ (Einstellungen → Programm → Wellenform). */
  const loudnessDefault = () => state.settings?.loudnessMonitor !== false;
  const followDefault = () => state.settings?.followLive !== false;

  function setFollow(on) {
    wave.follow = on;
    $('chk-follow').checked = on;
  }

  /**
   * Messwerte der Lautheit in der Werkzeugleiste (nicht in der Wellenform, dort verdeckten sie zu viel). Reihenfolge
   * nach Wichtigkeit: Wird es eng, kürzt CSS von hinten.
   */
  function renderLoudnessReadout(data) {
    const box = $('loud-readout');
    // Die Elemente bleiben stehen, nur die Werte wechseln (live mehrmals je Sekunde). Würden sie jedes Mal neu
    // angelegt, läge die Maus ständig über neuen Elementen und der Tooltip erschiene nie.
    if (!box.firstChild) {
      const make = (key, cls, label) => {
        const el = document.createElement('span');
        el.className = `lr ${cls}`;
        el.dataset.key = key;
        if (label != null) {
          const b = document.createElement('b');
          b.textContent = label;
          el.append(b, ' ');
        }
        el.append(document.createElement('span'), document.createElement('small'));
        box.appendChild(el);
      };
      make('unit', 'unit', null);
      make('s', 'main', 'S');
      make('m', '', 'M');
      make('i', '', 'I');
      make('sec', 'sec', '');
      box.querySelector('[data-key="unit"] span').textContent = 'LUFS';
    }
    // Die Anzeige selbst bleibt (sie ist der Platzhalter vor dem Abspielknopf), nur ihr Inhalt verschwindet.
    box.querySelectorAll('.lr').forEach((el) => { el.hidden = !data; });
    if (!data) return;
    const set = (key, value, { label, extra = '', main } = {}) => {
      const el = box.querySelector(`[data-key="${key}"]`);
      el.hidden = value == null;
      if (value == null) return;
      if (label != null) el.querySelector('b').textContent = label;
      el.querySelector('span').textContent = value;
      el.querySelector('small').textContent = extra ? ` ${extra}` : '';
      if (main != null) el.classList.toggle('main', main);
    };
    set('s', data.shortTerm, { extra: data.at ? `bei ${data.at}` : '' });
    set('m', data.momentary);
    set('i', data.integrated, { main: data.shortTerm == null });
    set('sec', data.section ? data.section.value : null, { label: data.section ? `${data.section.label}:` : '' });
    box.querySelector('[data-key="sec"]').title = data.section ? `${data.section.label}: ${data.section.value} LUFS` : '';
  }

  /** Schalter „LUFS“ (`state.loudOn`) und Ziellinie; bei Mehrspur gibt es keine Lautheit. */
  function applyLoudnessView() {
    if (state.loudOn == null) state.loudOn = loudnessDefault();
    const on = state.loudOn;
    $('chk-loudness').checked = on;
    wave.loudnessOn = on && !multitrackView();
    const target = Number(state.settings?.loudnessTarget);
    wave.loudnessTarget = Number.isFinite(target) && target < 0 ? target : null;
    wave.draw();
  }

  /* ------------------------------------------------------------------ Pegel */

  // Skala −48 … 0 dBFS; Zonen Grün bis −9, Gelb bis −3, darüber Rot (Farben im CSS). Der Strich hält die Spitze 2 s,
  // die Zahl zeigt diese Spitze. „Übersteuert“ bleibt stehen, bis man es anklickt.
  const METER_FLOOR_DB = -48;
  const METER_HOLD_MS = 2000;
  const meter = { l: { hold: 0, at: 0 }, r: { hold: 0, at: 0 }, lastAt: 0, shown: false };
  const meterPos = (p) => (p > 0 ? Math.max(0, Math.min(1, (20 * Math.log10(p) - METER_FLOOR_DB) / -METER_FLOOR_DB)) : 0);

  function dbText(p) {
    if (!(p > 0)) return '–';
    const db = 20 * Math.log10(p);
    if (db < -60) return '–';
    return db > -0.5 ? '0' : String(Math.round(db)).replace('-', '−');
  }

  function setMeters(l, r, clip) {
    const now = Date.now();
    meter.lastAt = now;
    let any = false;
    [['l', l || 0], ['r', r || 0]].forEach(([k, p]) => {
      const m = meter[k];
      if (p >= m.hold || now - m.at > METER_HOLD_MS) { m.hold = p; m.at = now; }
      const pos = meterPos(p);
      const hold = meterPos(m.hold);
      $(`meter-${k}`).style.clipPath = `inset(0 ${(100 - pos * 100).toFixed(1)}% 0 0)`;
      const u = $(`hold-${k}`);
      u.style.left = `${(hold * 100).toFixed(1)}%`;
      u.style.opacity = hold > 0.01 ? '0.85' : '0';
      $(`db-${k}`).textContent = dbText(m.hold);
      if (hold > 0) any = true;
    });
    meter.shown = any;
    if (clip) state.clipLatched = true;
    $('clip').dataset.on = String(Boolean(state.clipLatched));
  }

  // Kommen keine Pegel mehr (Aufnahme beendet, Eingang zu), fällt die Anzeige auf null statt stehen zu bleiben.
  setInterval(() => {
    if (meter.shown && Date.now() - meter.lastAt > 600) setMeters(0, 0, false);
  }, 300);

  /* ---------------------------------------------------- Pegel vor dem Start */

  // Stereo: Vor dem Start wird der Eingang über eine eigene, von der Aufnahme getrennte Erfassung geöffnet, damit
  // man den Pegel prüfen kann. Es wird nichts an den Hauptprozess geschickt und nichts gespeichert; vor dem Start der
  // Aufnahme wird sie geschlossen (Einstellung `prelisten`).
  const pre = new window.Capture();
  const prelisten = { on: false, busy: null, again: false, device: null, error: null, fallback: false, loudAt: 0, signal: null };
  const PRELISTEN_SIGNAL = 0.003;        // etwa −50 dBFS: darunter gilt der Eingang als still

  pre.onChunk = (buffer) => {
    const v = new Int16Array(buffer);
    let l = 0;
    let r = 0;
    for (let i = 0; i < v.length; i += 2) {
      const a = Math.abs(v[i]);
      const b = Math.abs(v[i + 1]);
      if (a > l) l = a;
      if (b > r) r = b;
    }
    l /= 32768;
    r /= 32768;
    setMeters(l, r, l >= 0.999 || r >= 0.999);
    const now = Date.now();
    if (Math.max(l, r) > PRELISTEN_SIGNAL) prelisten.loudAt = now;
    const signal = now - prelisten.loudAt < 4000;
    if (signal !== prelisten.signal) {
      prelisten.signal = signal;
      renderNow();
    }
  };
  pre.onError = (message) => {
    prelisten.error = message;
    renderNow();
  };

  function wantPrelisten() {
    return Boolean(state.settings) && state.settings.prelisten !== false && settingMode() === 'stereo'
      && document.body.dataset.phase === 'prep' && !state.starting && !isLive();
  }

  /** Öffnet bzw. schließt den Eingang für die Pegelanzeige vor dem Start (auch bei geändertem Gerät). */
  async function updatePrelisten() {
    if (prelisten.busy) { prelisten.again = true; return; }
    const want = wantPrelisten();
    const device = state.settings?.inputDeviceId || '';
    const restart = prelisten.on && want && prelisten.device !== device;
    if (want === prelisten.on && !restart) return;
    if (want && !prelisten.on && prelisten.error && prelisten.device === device) return;   // nicht dauernd neu versuchen
    prelisten.busy = (async () => {
      try {
        if (prelisten.on) {
          await pre.stop();
          prelisten.on = false;
        }
        if (want) {
          prelisten.device = device;
          const res = await pre.start(device, state.settings.sampleRate);
          prelisten.on = true;
          prelisten.error = null;
          prelisten.fallback = Boolean(res?.deviceFallback);
          prelisten.label = res?.deviceLabel || '';
          prelisten.loudAt = Date.now();
          prelisten.signal = null;
        }
      } catch (err) {
        prelisten.on = false;
        prelisten.error = err.message;
        await pre.stop();
      }
    })();
    await prelisten.busy;
    prelisten.busy = null;
    renderNow();
    renderStatusLine();
    if (prelisten.again) {
      prelisten.again = false;
      updatePrelisten();
    }
  }

  /** Vor dem Start einer Aufnahme: Pegel-Erfassung sicher schließen (auch wenn sie gerade erst öffnet). */
  async function stopPrelisten() {
    if (prelisten.busy) await prelisten.busy;
    if (prelisten.on) {
      await pre.stop();
      prelisten.on = false;
    }
  }

  /* -------------------------------------------------------------- Bereich „Jetzt“ */

  /** Prüfliste vor dem Start, laufender und nächster Punkt während der Aufnahme, Sichern danach. */
  function renderNow() {
    const s = state.session;
    if (!s) return;
    const phase = document.body.dataset.phase;
    $('now-title').textContent = { prep: 'Bereit für den Start?', rec: 'Jetzt', save: 'Sichern' }[phase] || '';
    if (phase === 'prep') renderPrepChecks(s);
    else if (phase === 'rec') renderRecNow(s);
    else renderSaveNow(s);
  }

  /** Eine Zeile der Prüfliste: Symbol (ok ✓ / warn ! / bad ✕), Text, Wert oder Knopf. */
  function checkRow({ level, text, value = '', title = '', action = null }) {
    const li = document.createElement('li');
    li.dataset.level = level;
    const ic = span('ic', { ok: '✓', warn: '!', bad: '✕' }[level] || '·');
    ic.setAttribute('aria-hidden', 'true');
    const txt = span('txt', text);
    txt.title = title || text;
    let val;
    if (action) {
      val = document.createElement('button');
      val.type = 'button';
      val.className = 'val';
      val.textContent = action.label;
      val.addEventListener('click', action.run);
    } else {
      val = span('val', value);
    }
    li.append(ic, txt, val);
    return li;
  }

  /** Füllt eine Prüfliste nur, wenn sich etwas geändert hat (sonst verschwänden Tooltips und Hover). */
  function fillChecks(id, rows) {
    const key = JSON.stringify(rows.map((r) => [r.level, r.text, r.value, r.title, r.action?.label]));
    const el = $(id);
    if (el.dataset.key === key) return;
    el.dataset.key = key;
    el.replaceChildren(...rows.map(checkRow));
  }

  function diskRow() {
    const h = state.diskHoursLeft;
    if (h == null) return { level: 'warn', text: 'Speicherplatz unbekannt' };
    return {
      level: h < DISK_LOW_HOURS ? 'bad' : (h < DISK_WARN_HOURS ? 'warn' : 'ok'),
      text: 'Speicherplatz',
      value: `ca. ${formatHours(h)}`
    };
  }

  function renderPrepChecks(s) {
    const rows = [];
    const deviceName = state.settings?.inputDeviceLabel || 'Systemstandard';
    if (prelisten.error) {
      rows.push({ level: 'bad', text: `Eingang: ${deviceName}`, value: 'nicht verfügbar', title: prelisten.error });
    } else if (state.inputMissing || prelisten.fallback) {
      rows.push({ level: 'warn', text: 'Gewählter Eingang fehlt', value: 'Systemstandard', title: `„${deviceName}“ ist nicht angeschlossen – aufgenommen würde über den Standardeingang.` });
    } else if (prelisten.on && prelisten.signal === false) {
      rows.push({ level: 'warn', text: `Eingang: ${deviceName}`, value: 'kein Signal', title: 'Seit ein paar Sekunden kein Pegel – Mischpult, Kabel oder Eingang prüfen.' });
    } else {
      rows.push({ level: 'ok', text: `Eingang: ${deviceName}`, value: prelisten.on ? 'Signal da' : '' });
    }
    const svc = s.service || {};
    if (svc.name) rows.push({ level: 'ok', text: svc.name, value: serviceDateText(svc), title: 'Gottesdienst' });
    else rows.push({ level: 'warn', text: 'Kein Gottesdienst gewählt', action: { label: 'Wählen …', run: openServicePicker } });
    const pending = (s.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length) {
      rows.push({ level: 'ok', text: `Ablauf: ${pending.length} ${pending.length === 1 ? 'Punkt' : 'Punkte'}`, value: s.agendaOrigin?.source === 'churchtools' ? 'ChurchTools' : 'Vorlage' });
      const missing = pending.filter((x) => !x.artist);
      const fallbackArtist = state.settings?.defaultArtist;
      if (missing.length && !fallbackArtist) {
        rows.push({
          level: 'warn',
          text: `${missing.length} ${missing.length === 1 ? 'Punkt' : 'Punkte'} ohne Interpret`,
          title: missing.map((x) => x.label).join(', '),
          action: { label: 'Eintragen', run: () => editSection(missing[0].id, 'artist') }
        });
      } else if (missing.length) {
        rows.push({ level: 'ok', text: `Interpret: „${fallbackArtist}“ für ${missing.length} ${missing.length === 1 ? 'Punkt' : 'Punkte'}`, title: 'Standard-Interpret aus den Einstellungen' });
      } else {
        rows.push({ level: 'ok', text: 'Interpreten eingetragen' });
      }
    } else {
      rows.push({ level: 'warn', text: 'Kein Ablauf geladen', title: 'Ohne Ablauf werden Abschnitte während der Aufnahme mit M gesetzt.', action: { label: 'ChurchTools …', run: openServicePicker } });
    }
    rows.push(diskRow());
    if (state.health?.routing === 'mismatch') rows.push({ level: 'bad', text: 'Mischpult-Routing passt nicht', title: 'Die USB-Ausgänge des Pults passen nicht zur Aufnahmeart.' });
    fillChecks('prep-checks', rows);

    const first = pending[0];
    const hint = $('prep-first');
    hint.replaceChildren();
    if (first) {
      hint.append('Beim Start beginnt automatisch');
      const b = document.createElement('b');
      b.textContent = fullTitle(first);
      hint.appendChild(b);
    } else {
      hint.textContent = 'Ohne Ablauf: Abschnitte während der Aufnahme mit M setzen.';
    }
  }

  function renderRecNow(s) {
    const paused = s.status === 'paused';
    const cur = s.currentSegment;
    const curSection = cur ? (s.sections || []).find((y) => y.id === cur.markerId) : null;
    const card = $('now-card');
    card.dataset.state = curSection ? (paused ? 'paused' : 'live') : 'idle';
    card.disabled = !curSection;
    card.style.setProperty('--sec', curSection ? window.sectionColorVar(curSection) : 'var(--line)');
    $('now-label').textContent = paused ? '❚❚ Pausiert' : (curSection ? '● Läuft' : '● Aufnahme läuft');
    const pending = s.pending || [];
    $('now-name').textContent = curSection ? (cur.label || curSection.label) : (pending.length ? 'Zwischen den Punkten' : 'Kein Abschnitt');
    const artist = $('now-artist');
    artist.textContent = curSection ? (curSection.artist || 'Interpret ergänzen') : (pending.length ? 'N beginnt den nächsten Punkt' : 'M setzt einen Abschnitt');
    artist.classList.toggle('unset', Boolean(curSection) && !curSection.artist);
    const next = nextPending(s);
    $('now-next').hidden = !next;
    $('now-next-name').textContent = next ? fullTitle(next) : '';
    $('now-next-name').title = next ? fullTitle(next) : '';
    // Keine Prüfliste während der Aufnahme: Probleme melden Warnbalken und Meldungen ohnehin, eine Liste mit lauter ✓
    // brachte nichts.
  }

  function renderSaveNow(s) {
    const box = $('save-summary');
    box.replaceChildren();
    const small = document.createElement('small');
    small.textContent = `Aufnahme: ${fmtLength(s.duration)}`;
    if (s.mode === 'multitrack') {
      const n = (s.tracks || []).length;
      small.textContent += ' · Mehrspur wird nicht als MP3 exportiert, die Spuren liegen im Aufnahmeordner.';
      box.append(`${n} ${n === 1 ? 'Spur' : 'Spuren'} als WAV gespeichert ✓`, small);
      return;
    }
    const real = (s.segments || []).filter((g) => g.markerId && !g.open);
    const unsaved = unsavedSegments().length;
    let text;
    if (real.length === 0) text = 'Keine Abschnitte – die ganze Aufnahme lässt sich sichern.';
    else if (unsaved === 0) text = `${real.length} ${real.length === 1 ? 'Abschnitt' : 'Abschnitte'} – alles gesichert ✓`;
    else text = `${real.length} ${real.length === 1 ? 'Abschnitt' : 'Abschnitte'} · ${unsaved} noch nicht gesichert`;
    box.append(text, small);
  }

  /* ------------------------------------------------------- Bediengefühl */

  /** M/N: kurzes Aufleuchten in der Farbe des eben gesetzten Abschnitts (auch per Taste ausgelöst). */
  function flashButton(btn, sectionId) {
    const x = (state.session?.sections || []).find((y) => y.id === sectionId);
    btn.style.setProperty('--flash', x ? window.sectionColorVar(x) : 'var(--plan)');
    btn.classList.remove('flash');
    void btn.offsetWidth;
    btn.classList.add('flash');
    // Danach wieder entfernen: sonst leuchtet der Knopf erneut, sobald er nach dem Ausblenden wieder erscheint.
    btn.addEventListener('animationend', () => btn.classList.remove('flash'), { once: true });
  }

  /**
   * Knopf, der erst nach kurzem Halten auslöst (Beenden der Aufnahme): Maus/Touch gedrückt halten oder Enter/Leertaste
   * halten; der Balken unten läuft dabei voll. Zu kurz → Hinweis statt Aktion.
   */
  const HOLD_MS = 600;
  function bindHold(btn, action) {
    let timer = null;
    let since = 0;
    btn.style.setProperty('--hold-ms', `${HOLD_MS}ms`);
    const fire = () => {
      clearTimeout(timer);
      timer = null;
      btn.classList.remove('holding');
      action();
    };
    const start = () => {
      if (btn.disabled || timer) return;
      since = performance.now();
      btn.classList.add('holding');
      timer = setTimeout(fire, HOLD_MS);
    };
    // Beim Loslassen zählt die tatsächlich gehaltene Zeit (Timer können verspätet kommen, z. B. im Hintergrund).
    const release = (hint) => {
      if (!timer) return;
      if (hint && performance.now() - since >= HOLD_MS) return fire();
      clearTimeout(timer);
      timer = null;
      btn.classList.remove('holding');
      if (hint) toast('info', 'Zum Beenden den Knopf kurz gedrückt halten.', 3000);
    };
    const cancel = release;
    btn.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      try { btn.setPointerCapture(e.pointerId); } catch { /* ohne Capture geht es auch */ }
      start();
    });
    btn.addEventListener('pointerup', () => cancel(true));
    btn.addEventListener('pointercancel', () => cancel(false));
    btn.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      e.stopPropagation();          // sonst wirkt die Leertaste zusätzlich als Abspielen
      if (!e.repeat) start();
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      cancel(true);
    });
    btn.addEventListener('blur', () => cancel(false));
  }

  /* --------------------------------------------------------------- Aufnahme */

  /** @param {{remote?: boolean}} [opts] remote: per Fernsteuerung (Companion) – ohne Rückfrage am PC */
  async function startRecording(opts = {}) {
    if (state.starting) return;
    if (state.session && (state.session.status === 'recording' || state.session.status === 'paused')) return;
    state.starting = true;

    try {
      // Eine angezeigte, beendete Aufnahme würde sonst aus der Ansicht verschwinden. Per Fernsteuerung
      // nicht nachfragen (niemand am PC); die Datei bleibt ohnehin gespeichert.
      if (!opts.remote && state.session?.status === 'stopped' && hasAudio(state.session)) {
        const go = await confirmDialog(
          'Neue Aufnahme starten?',
          'Die bisherige Aufnahme bleibt unter „Aufnahmen“ gespeichert. Abschnitte werden zurückgesetzt.',
          'Neue Aufnahme starten'
        );
        if (!go) return;
      }

      $('btn-record').disabled = true;
      await stopPrelisten();
      state.clipLatched = false;
      refreshDisk().then((hours) => {
        if (hours != null && hours < DISK_WARN_HOURS) {
          toast('warn', `Wenig Speicherplatz: nur noch für ca. ${formatHours(hours)} Aufnahme.`, 12000);
        }
      });
      // Eine noch laufende Erfassung stammt nie von einer aktiven Aufnahme (deren Status wurde oben geprüft):
      // schließen, damit capture.start() wirklich neu öffnet und eine Abtastrate liefert.
      if (capture.running) await capture.stop();
      // Mehrspur: Gerät und Dateien öffnet der Mehrspur-Prozess, die Oberfläche erfasst nichts.
      const multi = state.settings.recordingMode === 'multitrack';
      // Läuft noch das Zurückspielen einer Mehrspuraufnahme: anhalten (und bei Stereo das Gerät freigeben), bevor
      // die Erfassung startet.
      if (mt.play?.playing) await window.api.multitrack.stopPlayback();
      let rec;
      if (multi) {
        rec = await window.api.record.start({});
        if (rec.ok) state.sampleRate = rec.sampleRate;
      } else {
        const result = await capture.start(state.settings.inputDeviceId, state.settings.sampleRate);
        state.sampleRate = result.sampleRate;
        state.lastChunkAt = Date.now();
        warnDeviceFallback(result);
        rec = await window.api.record.start({ sampleRate: result.sampleRate, channels: 2 });
      }
      if (!rec.ok) {
        await capture.stop();
        toast('error', rec.error || 'Die Aufnahme konnte nicht gestartet werden.');
        if (opts.remote) window.api.reportRemoteResult({ kind: 'start', ok: false, error: rec.error });
        return;
      }
      // Status sofort lokal setzen: Die Statusmeldung aus dem Hauptprozess kommt leicht verzögert, ein
      // zweiter Startbefehl (Doppeldruck, Companion) würde sonst die laufende Erfassung beenden.
      if (state.session) state.session.status = 'recording';
      state.exportSeen.clear();
      state.exportChecked.clear();
      $('player').pause();

      state.peaks = [];
      setLoudness([]);
      state.bucketAcc = 0;
      state.bucketFrames = 0;
      wave.peaks = state.peaks;
      setDefaultZoom();
      setFollow(followDefault());
      monitor.pause();
      state.cursorT = null;
      wave.update({ playhead: null });
      setExportResult('');
    } catch (err) {
      toast('error', err.message);
      if (opts.remote) window.api.reportRemoteResult({ kind: 'start', ok: false, error: err.message });
    } finally {
      state.starting = false;
      // Knopf nur sperren, solange tatsächlich aufgenommen wird (auch nach Abbruch oder Fehler wieder frei).
      const st = state.session?.status;
      $('btn-record').disabled = st === 'recording' || st === 'paused';
      updatePrelisten();              // Start abgebrochen oder gescheitert: Pegel wieder anzeigen
    }
  }

  /**
   * „Neue Aufnahme“ nach dem Beenden: nicht gleich aufnehmen, sondern zurück in „Vorbereiten“. Gottesdienst und Ablauf
   * bleiben (Punkte wieder offen), so lässt sich noch eine andere Vorlage oder ein anderer Termin wählen; gestartet
   * wird danach ausdrücklich mit „Aufnahme starten“. Companion (`record.start`) startet weiterhin direkt.
   */
  async function prepareNewRecording() {
    const s = state.session;
    if (!s || isLive() || state.starting) return;
    if (s.status === 'stopped' && hasAudio(s)) {
      const unsaved = s.mode === 'multitrack' ? 0 : unsavedSegments().length;
      const go = await confirmDialog(
        'Neue Aufnahme vorbereiten?',
        unsaved
          ? `${unsaved} ${unsaved === 1 ? 'Abschnitt ist' : 'Abschnitte sind'} noch nicht als MP3 gesichert.`
          : 'Die bisherige Aufnahme bleibt gespeichert.',
        'Neue Aufnahme vorbereiten'
      );
      if (!go) return;
    }
    $('player').pause();
    $('player').removeAttribute('src');
    monitor.pause();
    const res = await window.api.session.prepareNext();
    if (!res.ok) return toast('error', res.error);
    state.exportSeen.clear();
    state.exportChecked.clear();
    state.selectedSectionId = null;
    state.selectedSegmentId = null;
    state.cursorT = null;
    state.playheadT = null;
    state.clipLatched = false;
    state.peaks = [];
    wave.peaks = state.peaks;
    setLoudness([]);
    wave.update({ playhead: null, selectedSegment: null });
    setDefaultZoom();
    setExportResult('');
    applyState(res.state, []);
  }

  /* ------------------------------------------------- Wächter für den Eingang */

  const WATCHDOG_MS = 2500;      // so lange darf der Eingang schweigen, bevor neu verbunden wird
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Eintrag ins Eingangsprotokoll (`logs/eingang.log`); fehlerhaft oder ohne Hauptprozess schadet es nie. */
  function logInput(level, event, data) {
    try { window.api.logInput(level, event, data || {}); } catch { /* nur Hilfe */ }
  }

  /** Zustand zum Zeitpunkt eines Aussetzers: Eingang, Fenster, Rechner – damit sich die Ursache eingrenzen lässt. */
  function inputSnapshot() {
    return {
      ...capture.diagnostics(),
      sichtbar: document.visibilityState,
      fokus: document.hasFocus(),
      online: navigator.onLine,
      speicherMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
      sitzung: state.session?.status || null
    };
  }

  capture.onEvent = (event, data) => logInput(event === 'eingang-geoeffnet' ? 'info' : 'warn', event, data);

  // Gerät eingesteckt/entfernt oder Standardgerät gewechselt (der Eingang steht auf „Systemstandard“).
  if (navigator.mediaDevices) {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      let eingaenge = null;
      try { eingaenge = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label || d.deviceId.slice(0, 8)); } catch { /* nur Hilfe */ }
      logInput('warn', 'geraete-geaendert', { eingaenge, ...inputSnapshot() });
    });
  }

  function showAudioWarning(on, text, kind = 'lost') {
    const el = $('audio-warning');
    el.hidden = !on;
    el.dataset.kind = kind;
    if (on && text) el.textContent = text;
  }

  /** Warnbalken für leise/stumme Eingänge, solange keine Wiederverbindung läuft. */
  function applyHealth(h) {
    state.health = h;
    renderNow();
    if (state.recovering) return;
    if (h && h.write === 'error' && isLive()) {
      showAudioWarning(true, `Audio kann nicht gespeichert werden – Laufwerk prüfen! (${h.writeMessage || 'Schreibfehler'})`, 'lost');
    } else if (h && h.write === 'slow' && isLive()) {
      showAudioWarning(true, 'Das Laufwerk ist zu langsam – die Aufnahme wird im Speicher gepuffert.', 'silent');
    } else if (h && h.routing === 'mismatch') {
      // Auch vor dem Start: genau dann soll es auffallen.
      const multi = state.mixer?.mode === 'multitrack';
      showAudioWarning(true, multi
        ? 'Mischpult-Routing passt nicht: Die USB-Ausgänge liefern die Stereo-Matrix, Ebbton nimmt aber Mehrspur auf.'
        : 'Mischpult-Routing passt nicht: Die USB-Ausgänge liefern einzelne Kanäle, Ebbton nimmt aber Stereo auf.', 'silent');
    } else if (h && h.deficit && isLive()) {
      showAudioWarning(true, `Der Aufnahme fehlen gegenüber der Uhr schon ${String(h.deficit).replace('.', ',')} s – Audio geht leise verloren. Ebbton sichtbar lassen (Mini-Fenster „immer oben“).`, 'silent');
    } else if (h && h.input === 'silent' && state.session?.status === 'recording') {
      showAudioWarning(true, 'Seit über 20 Sekunden kaum Pegel – Mischpult oder Kabel prüfen?', 'silent');
    } else {
      showAudioWarning(false);
    }
  }

  /**
   * Der Audioeingang liefert nichts mehr (z. B. nach Ruhezustand oder wenn das Gerät
   * kurz weg war): Eingang neu öffnen und in dieselbe Datei weiterschreiben.
   */
  /** @param {{quiet?: boolean}} [opts] quiet: ohne eigene Meldung (der Aufrufer hat schon gemeldet) */
  async function recoverCapture(opts = {}) {
    if (state.recovering) return;
    state.recovering = true;
    window.api.reportInputLost(true);
    const lostSince = state.lastChunkAt;
    // Wichtigster Eintrag: wie lange schon nichts kam und in welchem Zustand Eingang und Fenster sind.
    logInput('error', 'wiederverbinden-start', { keineBloeckeSeitMs: lostSince ? Date.now() - lostSince : null, ...inputSnapshot() });
    showAudioWarning(true, 'Kein Audiosignal – der Eingang wird neu verbunden …', 'lost');
    if (!opts.quiet) toast('error', 'Der Audioeingang liefert keine Daten mehr – er wird neu verbunden.', 8000);
    try {
      // Auch in der Pause weiter versuchen: Sonst bliebe der Eingang nach "Fortsetzen" stumm.
      while (isLive()) {
        await Promise.race([capture.stop(), sleep(2000)]);
        try {
          const rate = state.session.sampleRate;
          const before = state.chunkSeq;
          const result = await capture.start(state.settings.inputDeviceId, rate);
          if (result.sampleRate !== rate) {
            await capture.stop();
            throw new Error(`Eingang läuft mit ${result.sampleRate} Hz statt ${rate} Hz.`);
          }
          warnDeviceFallback(result);
          await sleep(1500);
          if (!isLive()) { await capture.stop(); return; }
          if (state.chunkSeq > before) {
            const lost = Math.round((Date.now() - lostSince) / 1000);
            logInput('warn', 'wiederverbunden', { fehlenSekunden: lost, ...inputSnapshot() });
            // Der Hauptprozess hat die Lücke mit Stille gefüllt: Wellenform und Lautheit von dort holen, sonst
            // wäre die lokal mitgerechnete Wellenform um die Lücke zu kurz.
            try {
              const full = await window.api.session.state();
              if (full.ok) {
                state.peaks = full.peaks || [];
                wave.peaks = state.peaks;
                setLoudness(full.loudness);
                state.bucketAcc = 0;
                state.bucketFrames = 0;
              }
            } catch (err) { console.warn('Wellenform nach der Lücke nicht abgeglichen:', err); }
            toast('success', `Audioeingang wieder verbunden. Etwa ${lost} s fehlen – an der Stelle ist Stille.`, 10000);
            return;
          }
        } catch (err) {
          console.warn('Eingang neu verbinden fehlgeschlagen:', err);
          logInput('error', 'wiederverbinden-fehlgeschlagen', { fehler: String(err && err.message || err) });
        }
        await sleep(2000);
      }
    } finally {
      state.recovering = false;
      state.lastChunkAt = Date.now();
      window.api.reportInputLost(false);
      applyHealth(state.health);
    }
  }

  let lastWatchTick = performance.now();
  let watchdogWaited = false;   // in der vorigen Runde wegen eines Hängers ausgesetzt (höchstens einmal am Stück)
  setInterval(() => {
    // Bleibt der Takt der Oberfläche aus (Fenster gedrosselt, Hauptthread blockiert), liefert auch die Erfassung
    // verspätet: dann ist nicht das Gerät schuld, sondern die Oberfläche bzw. der Rechner.
    const nowPerf = performance.now();
    const lag = nowPerf - lastWatchTick - 1000;
    lastWatchTick = nowPerf;
    const hung = lag > 1000;
    const recordingNow = state.session?.status === 'recording';
    // Nach einem Hänger einmal aussetzen: Die Erfassung lief in ihrem eigenen Thread weiter, ihre Blöcke warten
    // noch in der Warteschlange. Neu verbinden (`capture.stop`) würde sie verwerfen – aus einem harmlosen Hänger
    // würden so mehrere Sekunden echter Verlust. Ist der Eingang wirklich weg, greift der Wächter eine Runde später.
    const wait = hung && !watchdogWaited && capture.running;
    if (hung && recordingNow) logInput('warn', 'oberflaeche-haengt', { verzugMs: Math.round(lag), waechterWartet: wait, ...inputSnapshot() });
    watchdogWaited = wait;
    if (wait) return;

    if (!recordingNow || state.starting || state.recovering || isMultitrack()) return;
    // Erfassung läuft nicht (z. B. nach Neuladen der Oberfläche) oder liefert keine Daten mehr.
    if (!capture.running || Date.now() - state.lastChunkAt > WATCHDOG_MS) recoverCapture();
  }, 1000);

  function isLive() {
    const st = state.session?.status;
    return st === 'recording' || st === 'paused';
  }

  /** Die angezeigte Aufnahme hat Audio (Stereo-WAV oder Mehrspur-Spuren). */
  function hasAudio(session) {
    return Boolean(session?.wavPath) || (session?.mode === 'multitrack' && (session.tracks || []).length > 0);
  }

  /** Die angezeigte Aufnahme ist eine Mehrspuraufnahme (erfasst im Mehrspur-Prozess, nicht hier). */
  function isMultitrack() {
    return state.session?.mode === 'multitrack';
  }

  /** Ist das gewählte Gerät nicht verfügbar, nimmt der Browser still den Standardeingang – das deutlich melden. */
  function warnDeviceFallback(result) {
    if (result && result.deviceFallback) {
      toast('error', `Das gewählte Eingangsgerät ist nicht verfügbar – aufgenommen wird über „${result.deviceLabel || 'Standardeingang'}“. Bitte prüfen!`, 15000);
    }
  }

  /** Hängt eine neue Aufnahme an die beendete an (gleiche Datei, gleiche Abschnitte). */
  async function continueRecording() {
    if (state.starting || state.session?.status !== 'stopped') return;
    state.starting = true;
    $('btn-continue').disabled = true;
    try {
      await stopPrelisten();
      state.clipLatched = false;
      const rate = state.session.sampleRate;
      if (!isMultitrack()) {
        const result = await capture.start(state.settings.inputDeviceId, rate);
        if (result.sampleRate !== rate) {
          await capture.stop();
          return toast('error', `Der Eingang läuft mit ${result.sampleRate} Hz, die Aufnahme hat ${rate} Hz – Fortsetzen nicht möglich.`);
        }
        state.sampleRate = result.sampleRate;
        state.lastChunkAt = Date.now();
      }
      const res = await window.api.record.continue();
      if (!res.ok) {
        await capture.stop();
        return toast('error', res.error);
      }
      // Wellenform und Peak-Rest stammen aus der gespeicherten Aufnahme.
      const full = await window.api.session.state();
      if (full.ok) {
        state.peaks = full.peaks || [];
        wave.peaks = state.peaks;
        setLoudness(full.loudness);
      }
      state.bucketAcc = 0;
      state.bucketFrames = 0;
      setDefaultZoom();
      setFollow(followDefault());
      monitor.pause();
      state.cursorT = null;
      wave.update({ playhead: null });
      $('player').pause();
      setExportResult('');
    } catch (err) {
      toast('error', err.message);
    } finally {
      state.starting = false;
      $('btn-continue').disabled = false;
    }
  }

  /** @param {{remote?: boolean}} [opts] remote: per Fernsteuerung – Ergebnis an den Hauptprozess melden */
  async function stopRecording(opts = {}) {
    // Erst den angefangenen Audioblock abgeben, dann beenden: so fehlen am Ende keine Sekundenbruchteile.
    await capture.flush();
    const res = await window.api.record.stop();
    await capture.stop();
    monitor.pause();
    if (!res.ok) {
      if (opts.remote) window.api.reportRemoteResult({ kind: 'stop', ok: false, error: res.error });
      return toast('error', res.error);
    }
    state.cursorT = null;
    wave.update({ playhead: res.duration || 0 });
    wave.follow = false;
    $('chk-follow').checked = false;
  }

  let prevChunkPerf = 0;
  capture.onChunk = (arrayBuffer) => {
    // Auch Aussetzer unter der Wächter-Schwelle festhalten (ein Block = 100 ms; Abstand > 500 ms ist eine Lücke).
    const nowPerf = performance.now();
    if (prevChunkPerf && state.session?.status === 'recording' && nowPerf - prevChunkPerf > 500) {
      logInput('warn', 'luecke-in-oberflaeche', { abstandMs: Math.round(nowPerf - prevChunkPerf), waehrendWiederverbindung: state.recovering, ...inputSnapshot() });
    }
    prevChunkPerf = nowPerf;
    state.lastChunkAt = Date.now();
    state.chunkSeq += 1;
    // Immer an den Hauptprozess geben: Er entscheidet selbst, ob aufgenommen wird. (Der lokale Status hinkt
    // nach "Fortsetzen" etwas hinterher – sonst gingen dort Sekundenbruchteile verloren.)
    window.api.record.chunk(arrayBuffer);
    // In der Pause wächst die Wellenform nicht.
    if (state.session?.status === 'paused') return;
    // Peaks lokal mitrechnen, damit die Wellenform ohne Zusatzverkehr wächst.
    const view = new Int16Array(arrayBuffer);
    const bucketFrames = Math.round(state.sampleRate * 0.05);
    for (let i = 0; i < view.length; i += 2) {
      const m = Math.max(Math.abs(view[i]), Math.abs(view[i + 1])) / 32768;
      if (m > state.bucketAcc) state.bucketAcc = m;
      if (++state.bucketFrames >= bucketFrames) {
        state.peaks.push(Math.round(state.bucketAcc * 255));
        state.bucketAcc = 0;
        state.bucketFrames = 0;
      }
    }
  };

  capture.onError = (message) => toast('error', message);

  /* ----------------------------------------------------------------- Listen */

  /*
   * Eine Liste „Ablauf“ statt Ablaufplan, Abschnitte und Export: zuerst die gesetzten Abschnitte nach Zeit (fertig bzw.
   * läuft), dahinter die offenen Punkte nach Reihenfolge. Nach dem Beenden tragen die Zeilen Häkchen und
   * Sicherungsstand, am Ende steht „Gesamte Aufnahme“.
   */
  function renderUndoButtons() {
    const u = $('btn-undo'), r = $('btn-redo');
    if (u) u.disabled = !state.session?.canUndo;
    if (r) r.disabled = !state.session?.canRedo;
  }

  function renderLists() {
    renderUndoButtons();
    // Gewählter Abschnitt auch für die Lautheitsanzeige (I des Abschnitts) und die Hinterlegung in der Wellenform
    if (wave.selectedSectionId !== state.selectedSectionId) {
      wave.selectedSectionId = state.selectedSectionId;
      wave.draw();
    }
    // Tastaturfokus über das Neuaufbauen der Liste hinweg erhalten
    const focusedRow = document.activeElement?.closest?.('#flow-list .item');
    const focusId = focusedRow?.dataset.id;
    prepareExportSelection();
    renderFlow();
    if (focusId) document.querySelector(`#flow-list .item[data-id="${focusId}"]`)?.focus();
    updateExportButton();
    renderStatusLine();
    refreshExportTarget();
  }

  /** Vorauswahl zum Sichern: neue, noch nicht gesicherte Abschnitte; beim Beenden einer Aufnahme alle. */
  function prepareExportSelection() {
    const session = state.session;
    const segments = session?.segments || [];
    const exports = session?.exports || {};
    const status = session?.status;
    const justStopped = status === 'stopped' && (state.exportPrevStatus === 'recording' || state.exportPrevStatus === 'paused');
    state.exportPrevStatus = status;
    if (justStopped) {
      const real = segments.filter((seg) => seg.markerId && !seg.open);
      segments.forEach((seg) => {
        state.exportSeen.add(seg.id);
        if (seg.markerId && !seg.open) state.exportChecked.add(seg.id);
        // Ohne Abschnitte ist die ganze Aufnahme das, was gesichert werden soll.
        if (!seg.markerId && real.length === 0) state.exportChecked.add(seg.id);
      });
    }
    segments.forEach((seg) => {
      if (state.exportSeen.has(seg.id)) return;
      state.exportSeen.add(seg.id);
      if (seg.markerId && !seg.open && !exports[seg.id]) state.exportChecked.add(seg.id);
    });
  }

  function renderFlow() {
    const el = $('flow-list');
    el.innerHTML = '';
    const session = state.session;
    if (!session) return;
    const phase = document.body.dataset.phase;
    const live = phase === 'rec';
    const exportable = phase === 'save' && session.mode !== 'multitrack';
    const segments = session.segments || [];
    const segOf = new Map(segments.filter((g) => g.markerId).map((g) => [g.markerId, g]));
    const exports = session.exports || {};
    const placed = (session.sections || []).filter((x) => x.start != null).sort((a, b) => a.start - b.start);
    const pending = (session.pending || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));

    if (!placed.length && !pending.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = live
        ? 'Noch kein Abschnitt – M setzt einen an der Live-Stelle.'
        : 'Noch kein Ablauf. ChurchTools oder eine Vorlage laden oder unten Punkte hinzufügen – während der Aufnahme setzt M Abschnitte.';
      el.appendChild(li);
    }
    placed.forEach((x) => el.appendChild(flowRow(x, x.end == null && live ? 'now' : 'done', { live, exportable, seg: segOf.get(x.id), exports })));
    pending.forEach((x, i) => el.appendChild(flowRow(x, 'open', { live, next: live && i === 0 })));
    if (exportable) {
      const full = segments.find((g) => !g.markerId);
      if (full) el.appendChild(fullRow(full, exports));
    }
    // Die laufende Zeile im Blick behalten
    const nowRow = el.querySelector('.item[data-state="now"]');
    if (nowRow && state.lastNowId !== nowRow.dataset.id) nowRow.scrollIntoView({ block: 'nearest' });
    state.lastNowId = nowRow ? nowRow.dataset.id : null;
  }

  /** Sicherungsstand eines Segments für die Zeile: gesichert, geändert seit Export oder noch nicht gesichert. */
  function exportStatus(seg, exports) {
    const done = exports[seg.id];
    if (!done) return { cls: '', text: 'ungesichert', title: 'Noch nicht als MP3 gesichert' };
    const changed = exportChanged(done, seg);
    return changed
      ? { cls: 'warn', text: '⚠ geändert', title: `Geändert seit dem Export: ${done.file}` }
      : { cls: 'ok', text: '✓ gesichert', title: `Gesichert: ${done.file}` };
  }

  function span(cls, text = '') {
    const el = document.createElement('span');
    el.className = cls;
    el.textContent = text;
    return el;
  }

  /** Häkchen zum Sichern eines Segments (nur nach dem Beenden). */
  function exportBox(seg, label) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = state.exportChecked.has(seg.id);
    box.disabled = Boolean(state.exporting);
    box.setAttribute('aria-label', `${label} als MP3 sichern`);
    box.title = 'Zum Sichern auswählen';
    box.addEventListener('click', (e) => e.stopPropagation());
    box.addEventListener('change', () => {
      if (box.checked) state.exportChecked.add(seg.id); else state.exportChecked.delete(seg.id);
      updateExportButton();
    });
    return box;
  }

  /**
   * Zeile eines Programmpunkts. kind: 'done' (gesetzt, beendet), 'now' (läuft), 'open' (noch offen).
   * Offene Punkte lassen sich in der Liste umsortieren und auf die Wellenform ziehen; während der Aufnahme beginnt
   * ein Klick sie sofort. Gesetzte Abschnitte: Klick wählt und zeigt sie in der Wellenform.
   */
  function flowRow(x, kind, { live, exportable, seg, exports, next } = {}) {
    const li = document.createElement('li');
    li.className = 'item' + (state.selectedSectionId === x.id && kind !== 'open' ? ' selected' : '') + (next ? ' next' : '');
    li.dataset.id = x.id;
    li.dataset.state = kind;
    li.tabIndex = 0;
    li.style.setProperty('--sec', window.sectionColorVar(x));

    // Spalte 1: Häkchen (Sichern) bzw. Griff (offene Punkte)
    let lead;
    if (exportable && seg && !seg.open) lead = exportBox(seg, x.label);
    else if (kind === 'open') { lead = span('grip', '⋮⋮'); lead.setAttribute('aria-hidden', 'true'); }
    else lead = span('lead');

    let range = '';
    if (kind === 'done') range = `${fmt(x.start)} – ${fmt(x.end)}`;
    if (kind === 'now') range = `${fmt(x.start)} – läuft`;
    const time = span('time', range);

    const label = span('label', x.label);
    label.appendChild(artistTag(x, () => li.getBoundingClientRect()));

    const dur = span('dur');
    if (kind === 'done') {
      const len = exportable && seg ? Math.max(0, seg.end - seg.start - (seg.cutSeconds || 0)) : x.end - x.start;
      dur.textContent = fmtLength(len);
      if (exportable && seg?.cutSeconds > 0.05) dur.title = `Ohne Schnitte (✂ −${fmt(seg.cutSeconds)})`;
    } else if (kind === 'now') {
      // läuft noch: zählt mit den Pegelmeldungen weiter (updateSectionElapsed)
      dur.dataset.live = 'true';
      dur.dataset.start = String(x.start);
      dur.textContent = fmtLength((state.duration || 0) - x.start);
    }

    const st = span('st');
    if (kind === 'now') {
      st.textContent = state.session?.status === 'paused' ? '❚❚ Pause' : '● läuft';
      st.classList.add('live');
    } else if (next) {
      st.textContent = 'als Nächstes';
      st.classList.add('next');
    } else if (exportable && seg && !seg.open) {
      const info = exportStatus(seg, exports);
      st.textContent = info.text;
      st.title = info.title;
      if (info.cls) st.classList.add(info.cls);
    }

    const acts = span('acts');
    acts.innerHTML = `<button class="mini" data-rename title="Name und Interpret bearbeiten (F2)" aria-label="Name und Interpret bearbeiten">✎</button>
      <button class="mini" data-remove aria-label="Entfernen">×</button>`;
    const removeBtn = acts.querySelector('[data-remove]');
    const backToPlan = kind !== 'open' && x.source !== 'manual';
    removeBtn.title = kind === 'open' ? 'Punkt aus dem Ablauf entfernen'
      : (backToPlan ? 'Abschnitt entfernen – der Punkt wird wieder offen' : 'Abschnitt entfernen');
    acts.querySelector('[data-rename]').addEventListener('click', (e) => {
      e.stopPropagation();
      editSection(x.id, 'name', li.getBoundingClientRect());
    });
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await window.api.section.remove(x.id);
      if (res && res.ok === false) return toast('error', res.error);
      // Ohne Rückfrage, dafür mit „Rückgängig“
      toast('info', backToPlan ? `„${x.label}“ ist wieder offen.` : `„${x.label}“ entfernt.`, 7000,
        { label: 'Rückgängig', run: undoEdit });
    });

    li.append(lead, span('sw'), time, label, dur, st, acts);

    if (kind === 'open') {
      li.classList.toggle('clickable', Boolean(live));
      const hint = live
        ? 'Klicken: jetzt beginnen · Ziehen: in der Liste umsortieren oder auf die Wellenform legen'
        : 'Ziehen: in der Liste umsortieren oder auf die Wellenform legen · Doppelklick: bearbeiten';
      label.title = `${fullTitle(x)}\n\n${hint}`;
      bindPendingDrag(li, x);
      li.addEventListener('click', async () => {
        if (!live) return;
        const res = await window.api.section.start(x.id, null);
        if (!res.ok) toast('error', res.error);
      });
    } else {
      li.classList.add('clickable');
      label.title = `${fullTitle(x)}\n${range}`;
      li.title = range;              // sichtbar, wenn die Zeitspalte im schmalen Fenster entfällt
      li.addEventListener('click', () => selectSection(x, seg));
    }
    label.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      editSection(x.id, 'name', li.getBoundingClientRect());
    });
    return li;
  }

  /** Zeile „Gesamte Aufnahme“ (nur nach dem Beenden, zum Sichern). */
  function fullRow(seg, exports) {
    const li = document.createElement('li');
    li.className = 'item clickable' + (state.selectedSegmentId === seg.id ? ' selected' : '');
    li.dataset.id = seg.id;
    li.dataset.state = 'full';
    li.tabIndex = 0;
    const len = Math.max(0, seg.end - seg.start - (seg.cutSeconds || 0));
    const info = exportStatus(seg, exports);
    const st = span('st' + (info.cls ? ` ${info.cls}` : ''), info.text);
    st.title = info.title;
    const label = span('label', 'Gesamte Aufnahme');
    label.title = 'Die ganze Aufnahme als eine MP3-Datei (Schnitte fehlen darin)';
    li.append(exportBox(seg, 'Gesamte Aufnahme'), span('sw'), span('time', `${fmt(seg.start)} – ${fmt(seg.end)}`), label,
      span('dur', fmtLength(len)), st, span('acts'));
    li.addEventListener('click', () => {
      state.selectedSegmentId = state.selectedSegmentId === seg.id ? null : seg.id;
      state.selectedSectionId = null;
      wave.update({ selectedSegment: state.selectedSegmentId ? seg : null });
      renderLists();
    });
    return li;
  }

  /** Gesetzten Abschnitt wählen: in der Wellenform zeigen (Lautheit I des Abschnitts, Hinterlegung). */
  function selectSection(x, seg) {
    state.selectedSectionId = x.id;
    state.selectedSegmentId = seg ? seg.id : null;
    wave.update({ selectedSegment: seg || null });
    wave.scrollTo(x.start);
    renderLists();
    // Mehrspur: an den Abschnittsanfang springen; mit Schleife wird dieser Abschnitt wiederholt.
    if (isMultitrack() && state.session.status === 'stopped') {
      setPlayhead(x.start, true);
      if (mt.play?.playing) window.api.multitrack.loop(playbackLoop());
    }
  }

  /** Offene Punkte: auf die Wellenform ziehen (ablegen) oder auf einen anderen offenen Punkt (umsortieren). */
  function bindPendingDrag(li, x) {
    li.draggable = true;
    li.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/marker-id', x.id);
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('text/marker-id')) return;
      e.preventDefault();
      const before = e.clientY - li.getBoundingClientRect().top < li.offsetHeight / 2;
      li.classList.toggle('drop-before', before);
      li.classList.toggle('drop-after', !before);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', async (e) => {
      const dragged = e.dataTransfer.getData('text/marker-id');
      const before = e.clientY - li.getBoundingClientRect().top < li.offsetHeight / 2;
      li.classList.remove('drop-before', 'drop-after');
      if (!dragged || dragged === x.id) return;
      e.preventDefault();
      let nextEl = li.nextElementSibling;
      if (nextEl && nextEl.dataset.id === dragged) nextEl = nextEl.nextElementSibling;   // der gezogene Punkt selbst
      const nextId = nextEl && nextEl.dataset.state === 'open' ? nextEl.dataset.id : null;
      await window.api.section.reorder(dragged, before ? x.id : nextId);
    });
  }

  /** Ganzer Titel samt Interpret für den Tooltip (in den Listen wird er bei Platzmangel gekürzt). */
  function fullTitle(section) {
    return section.artist ? `${section.label} · ${section.artist}` : section.label;
  }

  /** Interpret hinter dem Namen; ohne Eintrag erscheint beim Darüberfahren "+ Interpret". Klick = direkt bearbeiten. */
  function artistTag(section, getAnchor) {
    const el = document.createElement('span');
    el.className = 'artist' + (section.artist ? '' : ' empty');
    el.textContent = section.artist ? ' · ' + section.artist : ' + Interpret';
    el.title = 'Interpret direkt bearbeiten';
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      editSection(section.id, 'artist', getAnchor());
    });
    return el;
  }

  /**
   * Bearbeitet Name und Interpret direkt an Ort und Stelle: ein Feld legt sich über das Element
   * (Fähnchen in der Wellenform oder Listenzeile). Enter speichert, Esc bricht ab, ein Klick
   * daneben speichert ebenfalls. Tab wechselt zwischen Name und Interpret.
   * @param {{left:number, top:number, width:number, height:number}} anchor Lage in Bildschirmkoordinaten
   */
  function editSection(id, focus = 'name', anchor) {
    const x = (state.session?.sections || []).find((y) => y.id === id);
    if (!x || state.inlineEdit) return;
    // Die Liste kann sich inzwischen neu aufgebaut haben (Klick vor dem Doppelklick): dann ist das alte
    // Element weg und hat keine Größe – die aktuelle Zeile suchen.
    if (!anchor || !anchor.width) {
      const row = document.querySelector(`#flow-list .item[data-id="${id}"]`);
      if (!row) return;
      anchor = row.getBoundingClientRect();
    }

    const box = document.createElement('div');
    box.className = 'inline-edit';
    box.style.setProperty('--sec', window.sectionColorVar(x));
    box.innerHTML = '<input class="ie-name" type="text" aria-label="Name" /><input class="ie-artist" type="text" placeholder="Interpret" aria-label="Interpret" />';
    const name = box.querySelector('.ie-name');
    const artist = box.querySelector('.ie-artist');
    name.value = x.label || '';
    artist.value = x.artist || '';

    // Vorschläge aus der Dienstplanung zum Anklicken (passender Dienst zuerst, z. B. "Predigt" beim Punkt Predigt)
    const byName = new Map();
    (state.session?.service?.suggestions || []).forEach((sug) => {
      if (!byName.has(sug.name)) byName.set(sug.name, []);
      byName.get(sug.name).push(sug.role);
    });
    const matches = (roles) => roles.some((r) => window.RoleLogic.roleMatchesLabel(r, x.label));
    const suggestions = [...byName.entries()]
      .map(([nm, roles]) => ({ name: nm, roles }))
      .sort((a, b) => Number(matches(b.roles)) - Number(matches(a.roles)));
    if (suggestions.length) {
      const row = document.createElement('div');
      row.className = 'ie-suggest';
      suggestions.forEach((sug) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip' + (matches(sug.roles) ? ' match' : '');
        chip.textContent = `${sug.name} · ${sug.roles.join(', ')}`;
        chip.title = 'Als Interpret übernehmen';
        chip.addEventListener('click', () => { artist.value = sug.name; finish(true); });
        row.appendChild(chip);
      });
      box.appendChild(row);
    }

    const width = Math.max(anchor.width, 300);
    box.style.left = Math.max(4, Math.min(anchor.left, window.innerWidth - width - 4)) + 'px';
    box.style.top = anchor.top + 'px';
    box.style.width = width + 'px';
    box.style.minHeight = Math.max(anchor.height, 26) + 'px';
    document.body.appendChild(box);
    state.inlineEdit = id;
    // Mit den Vorschlägen wird das Feld höher: nicht über den unteren Rand hinausragen lassen.
    const bottom = box.getBoundingClientRect().bottom;
    if (bottom > window.innerHeight - 8) box.style.top = Math.max(4, anchor.top - (bottom - window.innerHeight + 8)) + 'px';

    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      box.remove();
      state.inlineEdit = null;
      if (!save) return;
      const patch = {};
      const label = name.value.trim();
      if (label && label !== x.label) patch.label = label;
      if (artist.value.trim() !== (x.artist || '')) patch.artist = artist.value.trim();
      if (Object.keys(patch).length) await window.api.section.update(id, patch);
    };
    box.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    // Klick außerhalb (Fokus verlässt beide Felder) speichert.
    box.addEventListener('focusout', () => setTimeout(() => { if (!box.contains(document.activeElement)) finish(true); }, 0));
    const first = focus === 'artist' ? artist : name;
    first.focus();
    first.select();
  }

  /** Sichern-Knopf im Transport: nennt, was gespeichert wird; ist alles gesichert, sagt er das. */
  function updateExportButton() {
    const s = state.session;
    const canExport = s?.status === 'stopped' && s.mode !== 'multitrack' && !state.exporting;
    const segments = (s?.segments || []).filter((g) => !g.open);
    const picked = segments.filter((g) => state.exportChecked.has(g.id));
    const n = picked.length;
    const btn = $('btn-export');
    btn.disabled = !canExport || n === 0;
    const full = segments.find((g) => !g.markerId);
    const real = segments.filter((g) => g.markerId);
    const anyUnsaved = unsavedSegments().length > 0 || (real.length === 0 && full && !(s.exports || {})[full.id]);
    let label;
    if (state.exporting) label = 'Wird gesichert …';
    else if (n === 0) label = anyUnsaved ? 'Nichts ausgewählt' : 'Alles gesichert ✓';
    else if (picked.some((g) => !g.markerId)) label = n === 1 ? 'Gesamte Aufnahme als MP3 sichern' : `${n} MP3-Dateien sichern`;
    else label = `${n} ${n === 1 ? 'Abschnitt' : 'Abschnitte'} als MP3 sichern`;
    btn.textContent = label;
    btn.title = n ? `Als MP3 sichern: ${picked.map((g) => g.label).join(', ')}` : 'In der Liste „Ablauf“ Häkchen setzen, was gesichert werden soll';
    updateCompactExport();
  }

  function baseName(p) {
    return String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');
  }

  /** Zielordner (nur der Name, der ganze Pfad im Tooltip) und Format des Exports im Bereich „Sichern“. */
  async function refreshExportTarget() {
    if (document.body.dataset.phase !== 'save' || isMultitrack()) return;
    const target = await window.api.exportTarget();
    const folder = target.ok && target.folder ? target.folder : null;
    $('export-folder').textContent = folder ? baseName(folder) : 'wird beim Sichern abgefragt';
    $('export-folder').title = folder || 'Kein Exportordner eingestellt (Einstellungen → Ablage & Export)';
    const t = Number(state.settings?.loudnessTarget);
    const lufs = Number.isFinite(t) && t < 0 ? `Lautheit ${String(t).replace('-', '−')} LUFS` : 'Lautheit unverändert';
    $('export-target').textContent = `MP3 · ${state.settings?.mp3Bitrate || 192} kbit/s · ${lufs}`;
  }

  /* -------------------------------------------------------------- Playhead */

  function setPlayhead(t, seekPlayer) {
    const status = state.session?.status;
    if (status === 'recording' || status === 'paused') {
      // Hörcursor in der laufenden Aufnahme: Ansicht bleibt an der Stelle stehen.
      state.cursorT = t;
      wave.update({ playhead: t });
      wave.follow = false;
      $('chk-follow').checked = false;
      if (monitor.playing) monitor.seek(t);
      return;
    }
    wave.update({ playhead: t });
    state.playheadT = t;
    if (isMultitrack()) {
      if (seekPlayer && mt.play?.playing) window.api.multitrack.seek(t);
      return;
    }
    if (seekPlayer && $('player').src && state.session?.status === 'stopped') {
      $('player').currentTime = t;
    }
  }

  /** Leertaste / Abspielen-Knopf: Wiedergabe der fertigen Datei oder Mithören der laufenden Aufnahme. */
  function togglePlayback() {
    if (isMultitrack()) return multitrackView() ? toggleMultitrackPlayback() : undefined;
    const status = state.session?.status;
    if (status === 'recording' || status === 'paused') {
      if (monitor.playing) return monitor.pause();
      if (state.cursorT == null) {
        return toast('info', 'Zum Mithören erst in die Wellenform klicken, um den Cursor zu setzen.', 4000);
      }
      if (state.cursorT >= state.duration - 0.5) {
        return toast('info', 'Der Cursor steht am Live-Ende – bitte weiter vorne setzen.', 4000);
      }
      monitor.play(state.cursorT);
      return;
    }
    const player = $('player');
    if (player.paused) player.play(); else player.pause();
  }

  /**
   * Abspielen/Mithören und Schleife. Mehrspuraufnahmen spielen nur in der Mehrspur-Ansicht zum Pult (beendet, nicht
   * während der Aufnahme); in der Stereo-Ansicht bleibt der Knopf mit Hinweis gesperrt, die Schleife ausgeblendet.
   */
  function applyPlayControls() {
    const s = state.session;
    if (!s) return;
    const stopped = s.status === 'stopped';
    const live = isLive();
    const multi = s.mode === 'multitrack';
    $('btn-play').disabled = multi ? !(stopped && multitrackView()) : !((stopped && s.wavPath) || live);
    $('loop-wrap').hidden = !(multi && stopped && multitrackView());
    updatePlayButton();
  }

  /**
   * Abspielknopf als Symbol: ▶/❚❚ (Abspielen/Pause), Kopfhörer (Mithören während der Aufnahme), bei Mehrspur ▶ „Zum Pult“
   * bzw. ■ „Stopp“. Die Bedeutung steht in Tooltip und `aria-label`.
   */
  function setPlayButton(icon, label, title, text = '') {
    const btn = $('btn-play');
    btn.dataset.icon = icon;
    btn.setAttribute('aria-label', label);
    btn.title = title;
    $('play-label').textContent = text;
    $('play-label').hidden = !text;
    btn.classList.toggle('with-label', Boolean(text));
  }

  function updatePlayButton() {
    const status = state.session?.status;
    const live = status === 'recording' || status === 'paused';
    if (state.session?.mode === 'multitrack') {
      if (!multitrackView()) {
        setPlayButton('play', 'Abspielen', 'Mehrspuraufnahme: zum Zurückspielen zum Pult die Aufnahmeart (Einstellungen → Audio) auf Mehrspur stellen');
        return;
      }
      if (mt.play?.playing) setPlayButton('stop', 'Stopp', 'Zurückspielen zum Pult beenden (Leertaste)', 'Stopp');
      else setPlayButton('play', 'Zum Pult abspielen', 'Spuren über die USB-Ausgänge zum Mischpult spielen, ab der Marke in der Wellenform (Leertaste)', 'Zum Pult');
      return;
    }
    const playing = live ? monitor.playing : state.playing;
    if (playing) setPlayButton('pause', 'Pause', 'Anhalten (Leertaste)');
    else if (live) setPlayButton('listen', 'Mithören', 'Mithören: ab dem Cursor in die laufende Aufnahme hineinhören – Klick in die Wellenform setzt den Cursor (Leertaste)');
    else setPlayButton('play', 'Abspielen', 'Abspielen ab der Marke in der Wellenform (Leertaste)');
  }

  /* ------------------------------------------------------------ UI-Bindungen */

  function bindUi() {
    $('btn-record').addEventListener('click', () => {
      if (state.session?.status === 'paused') return window.api.record.resume();
      // Nach dem Beenden: erst zurück in „Vorbereiten“, gestartet wird danach ausdrücklich
      if (document.body.dataset.phase === 'save') return prepareNewRecording();
      startRecording();
    });
    $('btn-pause').addEventListener('click', async () => {
      const s = state.session?.status;
      const res = s === 'paused' ? await window.api.record.resume() : await window.api.record.pause();
      if (!res.ok) toast('error', res.error);
    });
    // Beenden nur durch kurzes Halten (ein versehentlicher Klick beendet keinen Gottesdienst)
    bindHold($('btn-stop'), () => stopRecording());
    $('btn-continue').addEventListener('click', continueRecording);
    $('now-continue').addEventListener('click', continueRecording);
    $('btn-cut').addEventListener('click', (e) => { e.currentTarget.blur(); toggleCut(); });
    $('clip').addEventListener('click', () => { state.clipLatched = false; $('clip').dataset.on = 'false'; });
    $('now-card').addEventListener('click', () => {
      const cur = state.session?.currentSegment;
      if (!cur) return;
      editSection(cur.markerId, 'name', $('now-card').getBoundingClientRect());
    });

    // Beginnt sofort einen Abschnitt bzw. beendet den laufenden; umbenannt wird bei Bedarf danach.
    $('btn-marker').addEventListener('click', async () => {
      const res = await window.api.section.toggle({});
      if (!res.ok) return toast('error', res.error);
      flashButton($('btn-marker'), res.section?.id);
      state.selectedSectionId = res.section.id;
      renderLists();
    });

    $('btn-next-item').addEventListener('click', () => nextItem());

    $('btn-zoom-in').addEventListener('click', () => wave.setZoom(wave.pxPerSec * 1.5));
    $('btn-zoom-out').addEventListener('click', () => wave.setZoom(wave.pxPerSec / 1.5));
    $('chk-follow').addEventListener('change', (e) => {
      wave.follow = e.target.checked;
      e.target.blur();          // Fokus zurückgeben, damit die Tastenkürzel weiter greifen
    });

    const player = $('player');
    $('btn-play').addEventListener('click', togglePlayback);
    player.addEventListener('play', () => { state.playing = true; updatePlayButton(); });
    player.addEventListener('pause', () => { state.playing = false; updatePlayButton(); });
    player.addEventListener('timeupdate', () => {
      if (state.playing) setPlayhead(player.currentTime, false);
    });

    const addPlanPoint = async () => {
      const input = $('plan-new');
      const label = input.value.trim();
      if (!label) return;
      const res = await window.api.section.add({ label });
      if (!res.ok) return toast('error', res.error);
      input.value = '';
      input.focus();
    };
    $('btn-plan-add').addEventListener('click', addPlanPoint);
    // Liste per Tastatur: Pfeiltasten wandern, Enter = Klick, F2 = Name/Interpret bearbeiten
    $('flow-list').addEventListener('keydown', (e) => {
      const row = e.target.closest('.item');
      if (!row || e.target !== row) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
        if (next && next.classList.contains('item')) next.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        row.click();
      } else if (e.key === 'F2' && row.dataset.state !== 'full') {
        e.preventDefault();
        e.stopPropagation();
        editSection(row.dataset.id, 'name', row.getBoundingClientRect());
      }
    });
    $('plan-template').addEventListener('change', (e) => { e.target.blur(); applyPlanTemplate(e.target.value); });
    $('plan-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addPlanPoint(); } });
    // Auf den freien Platz unter der Liste ziehen: ans Ende sortieren.
    $('flow-list').addEventListener('dragover', (e) => {
      if (e.target === $('flow-list') && e.dataTransfer.types.includes('text/marker-id')) e.preventDefault();
    });
    $('flow-list').addEventListener('drop', async (e) => {
      if (e.target !== $('flow-list')) return;
      const dragged = e.dataTransfer.getData('text/marker-id');
      if (dragged) await window.api.section.reorder(dragged, null);
    });
    $('btn-all-keys').addEventListener('click', () => openModal('modal-keys'));
    $('btn-export').addEventListener('click', exportSelected);
    $('ce-export').addEventListener('click', exportFromCompact);
    $('ce-new').addEventListener('click', () => $('btn-record').click());
    $('export-all').addEventListener('click', () => setExportChecks(true));
    $('export-none').addEventListener('click', () => setExportChecks(false));

    $('btn-settings').addEventListener('click', () => openModal('modal-settings'));
    document.querySelectorAll('#modal-settings .settings-nav button').forEach((b) => {
      b.addEventListener('click', () => showSettingsTab(b.dataset.tab));
    });
    $('btn-library').addEventListener('click', openLibrary);
    $('library-search').addEventListener('input', renderLibrary);
    $('library-filter').addEventListener('change', renderLibrary);
    $('btn-service').addEventListener('click', openServicePicker);
    $('btn-plan-service').addEventListener('click', openServicePicker);
    $('btn-view-large').addEventListener('click', () => setView('large'));
    $('btn-dense').addEventListener('click', () => setView('dense'));
    // Mini-Symbol: hinein bzw. (im Mini-Fenster) zurück in die vorige Ansicht
    $('btn-compact').addEventListener('click', () => setView(state.compact ? (state.dense ? 'dense' : 'large') : 'mini'));
    $('btn-theme').addEventListener('click', toggleTheme);
    $('current-item').addEventListener('click', (e) => {
      const cur = state.session?.currentSegment;
      if (!cur) return;
      const r = $('current-item').getBoundingClientRect();
      editSection(cur.markerId, e.target.closest('#current-artist') ? 'artist' : 'name',
        { left: r.left, top: r.top, width: r.width, height: r.height });
    });
    $('chk-ontop').addEventListener('change', () => window.api.app.setCompactOnTop($('chk-ontop').checked));
    $('btn-open-folder').addEventListener('click', () => window.api.app.openRecordingsFolder());

    document.querySelectorAll('[data-close]').forEach((b) =>
      b.addEventListener('click', () => b.closest('.modal').hidden = true));
    document.querySelectorAll('.modal').forEach((m) =>
      m.addEventListener('click', (e) => {
        if (e.target !== m) return;
        if (m.id === 'modal-settings') requestCloseSettings(); else m.hidden = true;
      }));

    bindSettingsForm();
    bindUpdateUi();
    bindShortcuts();
  }

  function openModal(id) {
    // Dialoge passen nicht ins Mini-Fenster: vorher auf das große Fenster umschalten.
    if (state.compact) toggleCompact(false);
    $(id).hidden = false;
    // Fokus in den Dialog setzen (Tastaturbedienung, Bildschirmleser); in den Einstellungen auf den Dialog selbst,
    // sonst trüge der erste Reiter einen Fokusrahmen wie eine Auswahl
    setTimeout(() => {
      const card = $(id).querySelector('.modal-card');
      if (id === 'modal-settings') { card.tabIndex = -1; card.focus(); return; }
      $(id).querySelector('input:not([type=hidden]), select, button:not(.close)')?.focus();
    }, 0);
    // Geräte können seit dem Start ein- oder ausgesteckt worden sein.
    if (id === 'modal-settings') {
      // Ohne Speichern geschlossene Änderungen verwerfen: immer die gespeicherten Werte zeigen.
      applySettingsToForm();
      state.calendarsLoaded = false;
      refreshDevices().then(() => takeSettingsSnapshot());
      showSettingsTab(settingsTab);
      takeSettingsSnapshot();
    }
  }

  /** Bereiche des Einstellungsdialogs: nur die Gruppen des gewählten Reiters sind sichtbar. */
  let settingsTab = 'audio';
  function showSettingsTab(tab) {
    settingsTab = tab;
    document.querySelectorAll('#modal-settings fieldset[data-tab]').forEach((f) => { f.hidden = f.dataset.tab !== tab; });
    // Letzte sichtbare Gruppe ohne Trennlinie darunter
    const shown = [...document.querySelectorAll('#modal-settings fieldset[data-tab]')].filter((f) => !f.hidden);
    document.querySelectorAll('#modal-settings fieldset.last-visible').forEach((f) => f.classList.remove('last-visible'));
    shown[shown.length - 1]?.classList.add('last-visible');
    document.querySelectorAll('#modal-settings .settings-nav button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.tab === tab));
    });
    const body = document.querySelector('#modal-settings .modal-body');
    if (body) body.scrollTop = 0;
    // Kalender beim ersten Öffnen des Reiters selbst laden (vorher musste man „Kalender laden“ drücken)
    if (tab === 'churchtools' && !state.calendarsLoaded && ctConfigured()) {
      state.calendarsLoaded = true;
      loadCalendars();
    }
  }

  /* ---- Einstellungen: Änderungen erkennen, nachfragen beim Schließen ---- */

  /** Werte aller Felder je Reiter (Kontrollkästchen als true/false). */
  function settingsValues() {
    const out = {};
    document.querySelectorAll('#modal-settings fieldset[data-tab]').forEach((f) => {
      const vals = [...f.querySelectorAll('input, select, textarea')]
        .filter((el) => el.id || el.closest('.agenda-row'))
        .map((el) => (el.type === 'checkbox' ? el.checked : el.value));
      out[f.dataset.tab] = (out[f.dataset.tab] || []).concat(vals);
    });
    // Kalender: die Auswahl zählt, nicht ob die Liste schon geladen ist
    out.churchtools = (out.churchtools || []).concat([readCalendarSelection().map(String).sort().join(',')]);
    // Vorlagen: alle Vorlagen samt Standard (nicht nur die gerade angezeigte)
    if (state.tpl) {
      const cur = state.tpl.templates.find((x) => x.id === state.tpl.selectedId);
      const draft = state.tpl.templates.map((t) => (t === cur ? { ...t, name: $('tpl-name').value, items: readDefaultAgenda() } : t));
      out.vorlagen = (out.vorlagen || []).concat([JSON.stringify([draft, state.tpl.defaultId])]);
    }
    Object.keys(out).forEach((k) => { out[k] = JSON.stringify(out[k]); });
    return out;
  }

  function takeSettingsSnapshot() {
    state.settingsSnap = settingsValues();
    updateSettingsDirty();
  }

  /** Geänderte Reiter bekommen einen Punkt, der Speichern-Knopf nennt die Zahl. */
  function dirtyTabs() {
    if (!state.settingsSnap) return [];
    const now = settingsValues();
    return Object.keys(now).filter((k) => now[k] !== state.settingsSnap[k]);
  }

  function updateSettingsDirty() {
    const dirty = dirtyTabs();
    document.querySelectorAll('#modal-settings .settings-nav button').forEach((b) => {
      b.classList.toggle('dirty', dirty.includes(b.dataset.tab));
    });
    const btn = $('btn-save-settings');
    btn.disabled = dirty.length === 0;
    btn.textContent = dirty.length ? 'Änderungen speichern' : 'Speichern';
    $('settings-dirty').textContent = dirty.length
      ? `Ungespeichert: ${dirty.map((t) => document.querySelector(`#modal-settings .settings-nav [data-tab="${t}"]`).textContent).join(', ')}`
      : '';
  }

  /** Schließen (×, Esc, Hintergrund, „Schließen“): mit ungespeicherten Änderungen erst nachfragen. */
  async function requestCloseSettings() {
    const modal = $('modal-settings');
    if (dirtyTabs().length) {
      const drop = await confirmDialog('Änderungen verwerfen?',
        'Einige Einstellungen sind noch nicht gespeichert. Ohne Speichern gehen sie verloren.', 'Verwerfen');
      if (!drop) return;
    }
    modal.hidden = true;
  }

  /** Umschalter „Stereo | Mehrspur“ schreibt in das versteckte Feld #set-rec-mode. */
  function syncRecModeSeg() {
    const v = $('set-rec-mode').value;
    document.querySelectorAll('#rec-mode-seg button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.value === v)));
  }

  /** Ordner als Name (groß) und Pfad (klein) statt als graues Eingabefeld. */
  function renderPathViews() {
    ['set-dir', 'set-export-dir', 'set-mt-dir'].forEach((id) => {
      const value = $(id).value;
      const view = $(`${id}-view`);
      view.querySelector('b').textContent = value ? baseName(value) : view.dataset.empty;
      view.querySelector('small').textContent = value || '';
      view.classList.toggle('is-empty', !value);
      view.title = value || '';
    });
    $('btn-clear-export-dir').hidden = !$('set-export-dir').value;
    $('btn-clear-mt-dir').hidden = !$('set-mt-dir').value;
  }

  /** Vorschau des Dateinamens mit dem eingegebenen Muster (rechnet der Hauptprozess wie beim Export). */
  let previewTimer = null;
  function updatePatternPreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const res = await window.api.exportPreviewName($('set-pattern').value.trim());
      $('pattern-preview').textContent = res.ok ? res.name : '–';
    }, 150);
  }

  /* ----------------------------------------------------------- Mini-Fenster */

  /** Mini-Fenster (nur Timer, Pegel, Aufnahme- und Abschnittsknöpfe) oder große Ansicht. */
  function applyCompact(on, onTop) {
    state.compact = Boolean(on);
    document.body.classList.toggle('compact', state.compact);
    applyDense();
    if (wave) wave.resize();           // Zeichenfläche passt sich an die neue Ansicht an (sonst gestreckt)
    if (typeof onTop === 'boolean') $('chk-ontop').checked = onTop;
    // Im Mini-Fenster aufgeschobene Update-Frage jetzt zeigen
    if (!state.compact && state.updatePrompt && !state.update?.busy) setTimeout(openUpdateDialog, 300);
  }

  /** Kompakte Ansicht: dieselben Bereiche, nur dichter. Im Mini-Fenster ohne Wirkung (eigene Regeln). */
  function applyDense() {
    document.body.classList.toggle('dense', Boolean(state.dense) && !state.compact);
    if (wave) wave.resize();
    // Größe „A A“ und Mini-Symbol
    $('btn-view-large').setAttribute('aria-pressed', String(!state.compact && !state.dense));
    $('btn-dense').setAttribute('aria-pressed', String(!state.compact && Boolean(state.dense)));
    $('btn-compact').setAttribute('aria-pressed', String(state.compact));
    $('btn-compact').title = state.compact
      ? 'Zurück zur normalen Ansicht (Strg+Umschalt+M)'
      : 'Mini-Fenster mit den nötigsten Knöpfen (Strg+Umschalt+M)';
  }

  /**
   * Ansicht wählen ('large', 'dense', 'mini'). Die Fenstergröße ändert der Hauptprozess; das Mini-Fenster meldet er
   * über das Ereignis 'compact', groß/kompakt wird hier sofort gezeigt.
   */
  function setView(view) {
    if (view !== 'mini') {
      state.dense = view === 'dense';
      applyDense();
    }
    window.api.app.setView(view);
  }

  /** Die Fenstergröße ändert der Hauptprozess; die Ansicht folgt über das Ereignis 'compact'. */
  function toggleCompact(on = !state.compact) {
    window.api.app.setCompact(on);
  }

  /** Ja/Nein-Abfrage; Abbrechen ist vorausgewählt. */
  function confirmDialog(title, text, okLabel = 'OK') {
    const modal = $('modal-confirm');
    $('confirm-title').textContent = title;
    $('confirm-text').textContent = text;
    $('confirm-ok').textContent = okLabel;
    if (state.compact) toggleCompact(false);
    modal.hidden = false;
    $('confirm-cancel').focus();

    return new Promise((resolve) => {
      const finish = (value) => {
        modal.hidden = true;
        modal.removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey, true);
        $('confirm-close').removeEventListener('click', onCancel);
        $('confirm-cancel').removeEventListener('click', onCancel);
        $('confirm-ok').removeEventListener('click', onOk);
        resolve(value);
      };
      const onOk = () => finish(true);
      const onCancel = () => finish(false);
      const onBackdrop = (e) => { if (e.target === modal) onCancel(); };
      const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onCancel(); } };
      modal.addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey, true);
      $('confirm-close').addEventListener('click', onCancel);
      $('confirm-cancel').addEventListener('click', onCancel);
      $('confirm-ok').addEventListener('click', onOk);
    });
  }

  $('btn-undo')?.addEventListener('click', () => undoEdit());
  $('btn-redo')?.addEventListener('click', () => redoEdit());

  async function undoEdit() {
    const res = await window.api.edit.undo();
    if (!res.ok) toast('warn', res.error, 3000);
  }

  async function redoEdit() {
    const res = await window.api.edit.redo();
    if (!res.ok) toast('warn', res.error, 3000);
  }

  /** Taste X: während der Aufnahme einen Schnitt beginnen bzw. beenden (die Stelle fehlt dann im MP3). */
  async function toggleCut() {
    const status = state.session?.status;
    if (status !== 'recording' && status !== 'paused') {
      toast('info', 'Schnitte: während der Aufnahme mit X, sonst mit Umschalt + Ziehen in der Wellenform.', 5000);
      return;
    }
    const res = await window.api.cut.toggle(null);
    if (!res.ok) return toast('warn', res.error);
    if (res.change === 'discarded') toast('info', 'Schnitt zu kurz – verworfen.', 3000);
  }

  /* ---------------------------------------------------------------- Updates */

  // Ablauf: gefunden → Rückfrage „herunterladen?“ → Fortschritt → Rückfrage „installieren?“ → Installation → Neustart.
  // Der Dialog öffnet sich von selbst, wenn eine neue Version gefunden wurde oder der Download fertig ist –
  // aber nie während einer Aufnahme und nicht im Mini-Fenster (dann bleibt der Knopf in der Kopfzeile).

  function fmtMB(bytes) {
    return (bytes / 1048576).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' MB';
  }

  function updateProgressText(p) {
    if (!p) return '';
    const parts = [`${p.percent} %`];
    if (p.total) parts.push(`${fmtMB(p.transferred)} von ${fmtMB(p.total)}`);
    if (p.bytesPerSecond && p.total && p.percent < 100) {
      parts.push(`${fmtMB(p.bytesPerSecond)}/s`);
      const rest = Math.max(0, Math.round((p.total - p.transferred) / p.bytesPerSecond));
      parts.push(rest >= 60 ? `noch etwa ${Math.ceil(rest / 60)} min` : `noch etwa ${Math.max(1, rest)} s`);
    }
    return parts.join(' · ');
  }

  function applyUpdateStatus(s) {
    const prev = state.update || {};
    s = { ...prev, ...s };
    state.update = s;
    const busy = Boolean(s.busy);

    // Knopf in der Kopfzeile
    const btn = $('btn-update');
    const labels = {
      available: `Update ${s.version} verfügbar`,
      downloading: `Update lädt … ${s.progress?.percent ?? 0} %`,
      ready: `Update ${s.version} installieren`,
      installing: 'Update wird installiert …'
    };
    let label = labels[s.state];
    if (s.state === 'error' && s.errorDuring !== 'check' && s.version) label = `Update ${s.version}: Fehler`;
    if (s.state === 'manual' && s.version) label = `Update ${s.version} verfügbar`;
    btn.hidden = !label;
    if (label) btn.textContent = label;
    btn.dataset.state = busy && ['available', 'ready'].includes(s.state) ? 'blocked' : s.state;
    btn.title = busy && ['available', 'ready'].includes(s.state)
      ? 'Wird nach der Aufnahme heruntergeladen bzw. installiert'
      : 'Update anzeigen';

    // Zeile in den Einstellungen
    const vi = $('version-info');
    const cur = `Version ${s.currentVersion || ''}`.trim();
    const infoText = {
      checking: `${cur} – Suche nach Updates …`,
      current: `${cur} – aktuell`,
      available: `${cur} – Version ${s.version} verfügbar`,
      downloading: `${cur} – Version ${s.version} wird heruntergeladen (${s.progress?.percent ?? 0} %)`,
      ready: `${cur} – Version ${s.version} bereit zur Installation`,
      installing: `${cur} – Update wird installiert …`,
      error: `${cur} – ${s.errorDuring === 'download' ? 'Download' : s.errorDuring === 'install' ? 'Installation' : 'Suche'} fehlgeschlagen: ${s.error}`,
      manual: `${cur} – ${s.error || ''}`
    }[s.state];
    if (infoText) vi.textContent = infoText;
    else if (s.state === 'idle' && s.error) vi.textContent = `${cur} – letzte Suche ohne Verbindung`;
    vi.dataset.level = s.state === 'error' ? 'error' : '';
    vi.title = s.error || (s.lastCheck ? `Zuletzt gesucht: ${new Date(s.lastCheck).toLocaleString('de-DE')}` : '');

    // Dialog: von selbst öffnen bei neuer Version / fertigem Download / Fehler beim Download
    const modal = $('modal-update');
    const changed = prev.state !== s.state;
    const dismissed = state.updateDismissed === `${s.state}:${s.version}`;
    let autoOpen = false;
    if (changed && s.state === 'available') autoOpen = !dismissed || s.manual;
    if (changed && s.state === 'ready') autoOpen = !dismissed;
    if (changed && s.state === 'manual' && s.version) autoOpen = !dismissed || s.manual;
    if (changed && s.state === 'error' && (s.errorDuring !== 'check' || s.manual)) autoOpen = true;
    if (autoOpen && !busy) {
      if (state.compact) state.updatePrompt = true;   // nach dem Verlassen des Mini-Fensters zeigen
      else openUpdateDialog();
    }
    if (!modal.hidden) renderUpdateDialog();
  }

  function openUpdateDialog() {
    state.updatePrompt = false;
    renderUpdateDialog();
    openModal('modal-update');
    $('update-action').focus();
  }

  function renderUpdateDialog() {
    const s = state.update || {};
    const busy = Boolean(s.busy);
    const set = (id, text) => { $(id).textContent = text; };
    const note = (text, level) => {
      $('update-note').hidden = !text;
      $('update-note').textContent = text || '';
      $('update-note').dataset.level = level || '';
    };
    const action = $('update-action');
    const later = $('update-later');
    action.hidden = false;
    action.disabled = false;
    later.hidden = false;
    later.textContent = 'Später';
    $('update-page').hidden = true;
    $('update-progress-box').hidden = true;
    note('');
    $('update-notes-box').hidden = !s.notes || !['available', 'downloading', 'ready', 'manual'].includes(s.state);
    $('update-notes').textContent = s.notes || '';
    const recNote = 'Während einer Aufnahme wird nichts heruntergeladen oder installiert. Erst die Aufnahme beenden.';

    switch (s.state) {
      case 'available':
        set('update-title', `Neue Version ${s.version}`);
        set('update-text', `Für Ebbton gibt es die Version ${s.version} (installiert ist ${s.currentVersion}). `
          + 'Soll sie jetzt heruntergeladen werden? Installiert wird erst nach einer weiteren Rückfrage.');
        action.textContent = 'Herunterladen';
        if (busy) { action.disabled = true; note(recNote); }
        break;
      case 'downloading':
        set('update-title', `Version ${s.version} wird heruntergeladen`);
        set('update-text', 'Der Download läuft. Ebbton kann währenddessen normal benutzt werden.');
        $('update-progress-box').hidden = false;
        $('update-bar').style.width = `${s.progress?.percent ?? 0}%`;
        set('update-progress-text', updateProgressText(s.progress) || 'Verbindung wird aufgebaut …');
        action.hidden = true;
        later.textContent = 'Im Hintergrund weiter';
        break;
      case 'ready':
        set('update-title', `Version ${s.version} ist bereit`);
        set('update-text', `Das Update ist heruntergeladen. Zum Installieren wird Ebbton beendet, Version ${s.version} `
          + 'ohne weitere Fragen eingespielt und danach von selbst wieder gestartet. Das dauert etwa eine halbe Minute. '
          + 'Jetzt installieren?');
        $('update-progress-box').hidden = false;
        $('update-bar').style.width = '100%';
        set('update-progress-text', s.progress?.total ? `Heruntergeladen: ${fmtMB(s.progress.total)}` : 'Heruntergeladen');
        action.textContent = 'Jetzt installieren und neu starten';
        later.textContent = 'Später installieren';
        if (busy) { action.disabled = true; note(recNote); }
        break;
      case 'installing':
        set('update-title', `Version ${s.version} wird installiert`);
        set('update-text', 'Ebbton wird gleich beendet. Das Update wird im Hintergrund installiert, danach startet '
          + 'Ebbton von selbst neu. Bitte den Rechner bis dahin nicht ausschalten.');
        action.hidden = true;
        later.hidden = true;
        break;
      case 'manual':
        set('update-title', s.version ? `Neue Version ${s.version}` : 'Update');
        set('update-text', s.error || 'Die neue Version bitte von der Download-Seite laden.');
        $('update-page').hidden = false;
        action.hidden = true;
        later.textContent = 'Schließen';
        break;
      case 'error':
        set('update-title', s.errorDuring === 'install' ? 'Installation fehlgeschlagen'
          : s.errorDuring === 'download' ? 'Download fehlgeschlagen' : 'Suche fehlgeschlagen');
        set('update-text', s.errorDuring === 'check'
          ? 'Es konnte nicht nach Updates gesucht werden. Besteht eine Internetverbindung?'
          : 'Das Update konnte nicht eingespielt werden. Die bisherige Version läuft unverändert weiter.');
        note(s.error, 'error');
        $('update-page').hidden = false;
        action.textContent = s.errorDuring === 'install' && s.downloaded ? 'Erneut installieren'
          : s.errorDuring === 'download' && s.version ? 'Erneut herunterladen' : 'Erneut suchen';
        if (busy && s.errorDuring !== 'check') { action.disabled = true; note(`${s.error}\n${recNote}`, 'error'); }
        later.textContent = 'Schließen';
        break;
      case 'checking':
        set('update-title', 'Update');
        set('update-text', 'Es wird nach einer neuen Version gesucht …');
        action.hidden = true;
        later.textContent = 'Schließen';
        break;
      default:
        set('update-title', 'Update');
        set('update-text', s.state === 'current'
          ? `Ebbton ist auf dem neuesten Stand (Version ${s.currentVersion}).`
          : 'Zurzeit liegt kein Update vor.');
        action.textContent = 'Erneut suchen';
        later.textContent = 'Schließen';
    }
  }

  async function updateAction() {
    const s = state.update || {};
    let res;
    if (s.state === 'available') res = await window.api.update.download();
    else if (s.state === 'ready' || (s.state === 'error' && s.errorDuring === 'install' && s.downloaded)) res = await window.api.update.install();
    else if (s.state === 'error' && s.errorDuring === 'download' && s.version) res = await window.api.update.download();
    else res = await window.api.update.check();
    if (res && !res.ok) toast('warn', res.error);
  }

  function bindUpdateUi() {
    $('btn-update').addEventListener('click', () => openUpdateDialog());
    $('update-action').addEventListener('click', () => updateAction());
    $('update-page').addEventListener('click', () => window.api.update.openPage());
    const close = () => {
      const s = state.update || {};
      // „Später“ merkt sich die Frage, damit sie bei der nächsten automatischen Suche nicht sofort wiederkommt.
      if (['available', 'ready', 'manual'].includes(s.state)) state.updateDismissed = `${s.state}:${s.version}`;
      $('modal-update').hidden = true;
    };
    $('update-later').addEventListener('click', close);
    $('update-close').addEventListener('click', close);
  }

  function bindShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Nur echte Texteingaben ausnehmen; Checkboxen dürfen die Kürzel nicht blockieren.
      const t = e.target;
      const textTypes = ['text', 'password', 'number', 'date', 'search', 'email', 'url'];
      const typing = t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && textTypes.includes(t.type));
      if (typing) return;
      // Esc schließt den obersten offenen Dialog, "?" schließt die Kürzelliste wieder.
      const openModalEl = [...document.querySelectorAll('.modal:not([hidden])')].pop();
      if (openModalEl) {
        if (e.key === 'Escape' || (e.key === '?' && openModalEl.id === 'modal-keys')) {
          e.preventDefault();
          if (openModalEl.id === 'modal-settings') requestCloseSettings(); else openModalEl.hidden = true;
        }
        return;
      }
      // Gehaltene Tasten nicht wiederholen: sonst starten und beenden sich Abschnitte im Wechsel.
      if (e.repeat) return;

      // Mini-Fenster: Strg+Umschalt+M (auf dem Mac Cmd+Umschalt+M über das Menü)
      if (e.ctrlKey && !e.metaKey && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleCompact();
        return;
      }
      if (e.ctrlKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        if (isLive()) stopRecording();
        else if (document.body.dataset.phase === 'save') prepareNewRecording();
        else startRecording();
        return;
      }
      if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) {
        if (!$('btn-marker').disabled) { e.preventDefault(); $('btn-marker').click(); }
        return;
      }
      if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) {
        if (isLive()) { e.preventDefault(); nextItem(); }
        return;
      }
      // Rückgängig/Wiederholen (Windows/Linux: Strg+Z, Strg+Y bzw. Strg+Umschalt+Z; auf dem Mac über das Menü)
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redoEdit(); else undoEdit();
        return;
      }
      if (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redoEdit();
        return;
      }
      if (e.key.toLowerCase() === 'x' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggleCut();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        if (state.compact) toggleCompact(false);
        $('modal-keys').hidden = !$('modal-keys').hidden;
        return;
      }
      if (e.key === 'F2' && state.selectedSectionId) {
        e.preventDefault();
        editSection(state.selectedSectionId, 'name');
        return;
      }
      if (e.code === 'Space') {
        // Fokus von Knöpfen nehmen, sonst löst die Leertaste zusätzlich deren Klick aus.
        if (e.target.tagName === 'BUTTON') e.target.blur();
        e.preventDefault();
        if (!$('btn-play').disabled) togglePlayback();
      }
    });
  }

  /* ------------------------------------------------------------- Ereignisse */

  function bindEvents() {
    window.api.on('state', (s) => applyState(s));

    window.api.on('levels', (levels) => {
      setMeters(levels.l, levels.r, levels.clip);
      // Mehrspur: Die Wellenform kommt fertig aus dem Mehrspur-Prozess (Stereo rechnet sie hier aus den Blöcken).
      if (levels.buckets) for (const b of levels.buckets) state.peaks.push(b);
      if (levels.loudness?.steps?.length) state.loud.push(levels.loudness.steps);
      state.duration = levels.duration;
      $('timecode').textContent = longTime(levels.duration);
      updateSectionElapsed();
      wave.update({ duration: levels.duration, peaks: state.peaks });
    });

    window.api.on('health', (h) => applyHealth(h));
    window.api.on('mixer', (m) => renderMixer(m));
    window.api.on('multitrack', (m) => { mt.monitor = m; renderChannels(); });
    window.api.on('track-levels', (l) => applyTrackLevels(l));
    window.api.on('multitrack-play', (p) => applyPlayback(p));
    // Aufnahmeart von außen umgestellt (Companion): nur Umschalter und Ansicht nachziehen, ein offener
    // Einstellungsdialog behält seine ungespeicherten Eingaben.
    window.api.on('loudness', ({ loudness }) => setLoudness(loudness));
    // Nur bis zum nächsten Programmstart; die Voreinstellung steht in den Einstellungen.
    $('chk-loudness').addEventListener('change', (e) => {
      state.loudOn = e.target.checked;
      applyLoudnessView();
    });
    window.api.on('settings', (st) => {
      state.settings = st;
      $('set-rec-mode').value = settingMode();
      syncRecModeSeg();
      applyMode();
      refreshDisk();
      renderNow();
      updatePrelisten();
    });
    $('chk-loop').addEventListener('change', () => {
      if (mt.play?.playing) window.api.multitrack.loop(playbackLoop()).then((r) => { if (!r.ok) toast('error', r.error); });
    });

    window.api.on('toast', ({ level, message }) => toast(level, message));

    window.api.on('command', ({ action, remote }) => {
      if (action === 'record.start') startRecording({ remote });
      if (action === 'record.stop') stopRecording({ remote });
    });

    // Einträge aus dem macOS-Menü
    window.api.on('menu', ({ action }) => {
      if (action === 'settings') openModal('modal-settings');
      if (action === 'toggle-record') {
        if (isLive()) stopRecording();
        else if (document.body.dataset.phase === 'save') prepareNewRecording();
        else startRecording();
      }
      if (action === 'undo' || action === 'redo') {
        // In einem Textfeld wirkt Rückgängig dort, sonst auf Abschnitte und Schnitte.
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') document.execCommand(action);
        else if (action === 'undo') undoEdit(); else redoEdit();
      }
      if (action === 'marker' && !$('btn-marker').disabled) $('btn-marker').click();
      if (action === 'next-item' && isLive()) nextItem();
    });

    window.api.on('compact', ({ on, onTop }) => applyCompact(on, onTop));

    window.api.on('network-status', (info) => renderNetInfo(info));

    window.api.on('update-status', (s) => applyUpdateStatus(s));

    window.api.on('export-progress', ({ progress, done, total }) => {
      const bars = [$('export-progress'), $('ce-progress')];
      bars.forEach((bar) => { bar.hidden = false; bar.querySelector('i').style.width = Math.round(progress * 100) + '%'; });
      if (total && progress < 1) {
        setExportResult(total === 1 ? 'MP3 wird erstellt …' : `MP3-Dateien werden erstellt … ${done || 0} von ${total} fertig`);
      }
      if (progress >= 1) setTimeout(() => { bars.forEach((bar) => { bar.hidden = true; }); }, 800);
    });
  }

  /* ----------------------------------------------------------------- Export */

  function setExportChecks(on) {
    (state.session?.segments || []).filter((g) => !g.open).forEach((g) => {
      if (on) state.exportChecked.add(g.id); else state.exportChecked.delete(g.id);
    });
    renderLists();
  }

  /** Wurde der Abschnitt seit dem Export verändert (Zeitraum oder Schnitte)? */
  function exportChanged(done, seg) {
    const sig = (list) => (list || []).map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)}`).join(',');
    return Math.abs(done.start - seg.start) > 0.05 || Math.abs(done.end - seg.end) > 0.05
      || sig(done.cuts) !== sig(seg.cuts);
  }

  /** Abschnitte, die noch nicht (oder nicht mehr in dieser Form) als MP3 gesichert sind. */
  function unsavedSegments() {
    const exports = state.session?.exports || {};
    return (state.session?.segments || [])
      .filter((s) => s.markerId && !s.open && (!exports[s.id] || exportChanged(exports[s.id], s)));
  }

  /** Ergebniszeile des Exports (große Ansicht und Mini-Fenster); mit `revealFile` samt Link „Im Ordner zeigen“. */
  function setExportResult(text, revealFile) {
    ['export-result', 'ce-result'].forEach((id) => {
      const el = $(id);
      el.textContent = text;
      if (!revealFile) return;
      el.appendChild(document.createTextNode(' '));
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'mini-link';
      link.textContent = 'Im Ordner zeigen';
      link.addEventListener('click', () => window.api.app.reveal(revealFile));
      el.appendChild(link);
    });
  }

  /** Mini-Fenster nach dem Beenden: Zusammenfassung und ein Knopf für den Export. */
  function updateCompactExport() {
    const session = state.session;
    if (session?.mode === 'multitrack') {
      // Mehrspur: kein MP3-Export, nur die Zusammenfassung.
      const n = (session.tracks || []).length;
      $('ce-summary').textContent = `Mehrspur: ${n} ${n === 1 ? 'Spur' : 'Spuren'} gespeichert ✓`;
      $('ce-export').hidden = true;
      return;
    }
    const segments = session?.segments || [];
    const real = segments.filter((s) => s.markerId && !s.open);
    const unsaved = unsavedSegments();
    const checked = real.filter((s) => state.exportChecked.has(s.id)).length;
    const full = segments.find((s) => !s.markerId);
    const word = (n) => `${n} ${n === 1 ? 'Abschnitt' : 'Abschnitte'}`;
    let summary;
    let label;
    if (real.length === 0) {
      summary = 'Keine Abschnitte gesetzt.';
      label = 'Gesamte Aufnahme als MP3 sichern';
    } else if (unsaved.length === 0) {
      summary = `${word(real.length)} – alles gesichert ✓`;
      label = null;                          // nichts mehr zu tun: kein Knopf
    } else {
      summary = `${word(real.length)} – ${unsaved.length} noch nicht gesichert`;
      label = `${word(checked || unsaved.length)} als MP3 sichern`;
    }
    $('ce-summary').textContent = summary;
    $('ce-export').hidden = label == null;
    if (label != null) $('ce-export').textContent = label;
    $('ce-export').disabled = state.exporting || (real.length === 0 && !full);
  }

  /** Knopf im Mini-Fenster: angehakte Abschnitte, sonst die noch nicht gesicherten (ohne Abschnitte: die ganze Aufnahme). */
  function exportFromCompact() {
    const session = state.session;
    const segments = session?.segments || [];
    const real = segments.filter((s) => s.markerId && !s.open);
    const unsaved = unsavedSegments();
    const checked = real.filter((s) => state.exportChecked.has(s.id));
    let pick;
    if (real.length === 0) pick = segments.filter((s) => !s.markerId);
    else pick = checked.length ? checked : unsaved;
    if (pick.length === 0) return;
    state.exportChecked = new Set(pick.map((s) => s.id));
    exportSelected();
  }

  /** Speichert alle angehakten Abschnitte nacheinander als MP3. */
  async function exportSelected() {
    const items = (state.session?.segments || [])
      .filter((seg) => state.exportChecked.has(seg.id) && !seg.open)
      .map((seg) => ({ id: seg.id, start: seg.start, end: seg.end, label: seg.label }));
    if (items.length === 0) return;

    state.exporting = true;            // verhindert einen zweiten, parallelen Export
    updateExportButton();
    setExportResult(`MP3 1 von ${items.length} wird erstellt …`);
    try {
      const res = await window.api.exportBatch(items);
      if (res.canceled) {
        setExportResult('');
      } else if (!res.ok) {
        setExportResult('');
        toast('error', res.error);
      } else {
        // Gesicherte Abschnitte sind danach nicht mehr vorausgewählt.
        items.forEach((item) => {
          if (!res.failed.some((f) => f.id === item.id)) state.exportChecked.delete(item.id);
        });
        const n = res.files.length;
        if (n > 0) {
          setExportResult(`${n} von ${items.length} MP3-Dateien gespeichert.`, res.files[0]);
        } else {
          setExportResult('Keine MP3-Datei gespeichert.');
        }
        if (res.failed.length) {
          toast('error', `Nicht exportiert: ${res.failed.map((f) => `${f.label} (${f.error})`).join('; ')}`, 12000);
        }
      }
    } finally {
      state.exporting = false;
      renderLists();
      renderNow();
    }
  }

  /* ------------------------------------------------------- Kürzel und Speicher */

  /** Alle Tastenkürzel; "main" erscheint in der kleinen Karte, alles im Dialog. */
  function shortcutList(platform) {
    const mod = platform === 'darwin' ? 'Cmd' : 'Strg';
    return [
      { keys: [mod, 'R'], text: 'Aufnahme starten / beenden', main: true },
      { keys: ['M'], text: 'Abschnitt starten / beenden', main: true },
      { keys: ['N'], text: 'Nächster Punkt', main: true },
      { keys: ['X'], text: 'Schnitt starten / beenden', main: true },
      { keys: [mod, 'Z'], text: 'Rückgängig', main: true },
      { keys: ['Leertaste'], text: 'Mithören / Abspielen', main: true },
      { keys: ['?'], text: 'Alle Kürzel anzeigen' },
      { keys: [mod, 'Umschalt', 'Z'], text: 'Wiederholen' },
      { keys: [mod, 'Umschalt', 'M'], text: 'Mini-Fenster ein/aus' },
      { keys: ['F2'], text: 'Gewählten Abschnitt bearbeiten' },
      { keys: ['Klick'], text: 'In die Wellenform: Hörcursor setzen' },
      { keys: ['Doppelklick'], text: 'Auf eine Marke: Name/Interpret direkt bearbeiten' },
      { keys: ['Ziehen'], text: 'An einer Marke: Marke verschieben, Nachbarn weichen aus' },
      { keys: ['Ziehen'], text: 'In der Wellenform: Ansicht hin und her verschieben (hineingezoomt)' },
      { keys: ['Umschalt', 'Ziehen'], text: 'In der Wellenform: Schnitt aufziehen (fehlt im MP3)' },
      { keys: ['Doppelklick'], text: 'Auf einen Schnitt: Schnitt entfernen' },
      { keys: ['Mausrad'], text: 'Wellenform scrollen' },
      { keys: ['Strg', 'Mausrad'], text: 'Wellenform zoomen (auch Zwei-Finger-Zoom auf dem Trackpad)' },
      { keys: ['F12'], text: 'Entwicklerwerkzeuge (nur Dev-Modus)' }
    ];
  }

  /** Tooltips mit der passenden Taste (Cmd auf dem Mac, sonst Strg). */
  function applyPlatformTitles(platform) {
    const mod = platform === 'darwin' ? 'Cmd' : 'Strg';
    $('btn-record').title = `Aufnahme starten (${mod}+R)`;
    $('record-key').textContent = `${mod} R`;
    $('btn-stop').title = `Aufnahme beenden: kurz gedrückt halten (${mod}+R beendet sofort)`;
    $('btn-compact').title = `Mini-Fenster mit den nötigsten Knöpfen, z. B. wenn nebenher am PC gearbeitet wird (${mod}+Umschalt+M)`;
  }

  function renderShortcuts(platform) {
    const fill = (el, items) => {
      el.innerHTML = '';
      items.forEach((it) => {
        const li = document.createElement('li');
        const keys = document.createElement('span');
        keys.className = 'keys';
        it.keys.forEach((k) => {
          const kbd = document.createElement('kbd');
          kbd.textContent = k;
          keys.appendChild(kbd);
        });
        const text = document.createElement('span');
        text.className = 'text';
        text.textContent = it.text;
        li.append(keys, text);
        el.appendChild(li);
      });
    };
    const all = shortcutList(platform);
    fill($('keys-list'), all.filter((x) => x.main));
    fill($('keys-all'), all);
  }

  const DISK_WARN_HOURS = 3;     // darunter wird der Speicherplatz orange
  const DISK_LOW_HOURS = 0.5;    // darunter rot, auch während der Aufnahme als Meldung
  let diskLowToastShown = false;

  function formatBytes(b) {
    const gb = b / 1073741824;
    return gb >= 100 ? `${Math.round(gb)} GB` : `${gb.toFixed(1).replace('.', ',')} GB`;
  }

  function formatHours(h) {
    if (h >= 10) return `${Math.round(h)} Std.`;
    if (h >= 1) return `${h.toFixed(1).replace('.', ',')} Std.`;
    return `${Math.max(0, Math.round(h * 60))} Min.`;
  }

  /** Aktualisiert die Speicheranzeige (Einstellungen; die Kopfleiste zeigt sie nur bei knappem Platz); gibt die Stunden zurück, die noch Platz haben. */
  async function refreshDisk() {
    const res = await window.api.app.diskFree();
    const badge = $('disk-badge');
    if (!res.ok) {
      badge.textContent = 'Speicher unbekannt';
      badge.dataset.level = 'ok';
      $('disk-info').textContent = 'Freier Speicherplatz unbekannt.';
      return null;
    }
    badge.textContent = `${formatBytes(res.freeBytes)} frei · ca. ${formatHours(res.hoursLeft)}`;
    badge.title = `Freier Speicherplatz auf ${res.dir}: reicht für ca. ${formatHours(res.hoursLeft)} Aufnahme`;
    $('disk-info').textContent = `Frei: ${formatBytes(res.freeBytes)} (ca. ${formatHours(res.hoursLeft)} Aufnahme)`;
    badge.dataset.level = res.hoursLeft < DISK_LOW_HOURS ? 'low' : (res.hoursLeft < DISK_WARN_HOURS ? 'warn' : 'ok');
    const changed = state.diskHoursLeft == null || Math.abs(state.diskHoursLeft - res.hoursLeft) > 0.05;
    state.diskHoursLeft = res.hoursLeft;
    if (changed) renderNow();
    if (multitrackView()) renderChannelStatus();

    if (res.hoursLeft < DISK_LOW_HOURS && state.session?.status === 'recording' && !diskLowToastShown) {
      diskLowToastShown = true;
      toast('error', `Speicherplatz wird knapp: nur noch für ca. ${formatHours(res.hoursLeft)} Aufnahme.`, 15000);
    }
    if (res.hoursLeft >= DISK_LOW_HOURS) diskLowToastShown = false;
    return res.hoursLeft;
  }

  /* ---------------------------------------------------------- ChurchTools-UI */

  const OVERVIEW_COUNT = 5;      // so viele vergangene und kommende Termine werden angeboten
  const OVERVIEW_PAST_DAYS = 90;
  const OVERVIEW_FUTURE_DAYS = 120;

  /** Lokales Datum als YYYY-MM-DD (toISOString würde nach UTC umrechnen). */
  function localIsoDate(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function shiftDays(iso, days) {
    const d = new Date(iso + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return localIsoDate(d);
  }

  function germanDate(iso) {
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  }

  async function openServicePicker() {
    $('service-date-input').value = '';
    openModal('modal-service');
    loadServiceOverview();
  }

  // Ein gewähltes Datum zeigt nur diesen Tag; leeren zeigt wieder die Übersicht.
  $('service-date-input')?.addEventListener('change', (e) => {
    if (e.target.value) loadServicesForDate(e.target.value, false);
    else loadServiceOverview();
  });

  /** Ergänzt Beginn als Date sowie lokales Datum und Uhrzeit (ChurchTools liefert UTC). */
  function withLocalTime(list) {
    return list.map((s) => {
      const when = s.start ? new Date(s.start) : null;
      const valid = when && !isNaN(when);
      return {
        ...s,
        when: valid ? when : null,
        date: valid ? localIsoDate(when) : s.date,
        time: valid ? when.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''
      };
    });
  }

  /** Der Termin, der gerade läuft oder als Nächster ansteht; sonst der zuletzt begonnene. */
  function pickCurrentOrNext(list) {
    const now = Date.now();
    const SERVICE_FALLBACK_MS = 2 * 3600 * 1000;      // Dauer, falls ChurchTools kein Ende liefert
    const sorted = list.filter((s) => s.when).sort((a, b) => a.when - b.when);
    const endOf = (s) => {
      const e = s.end ? new Date(s.end).getTime() : NaN;
      return isNaN(e) ? s.when.getTime() + SERVICE_FALLBACK_MS : e;
    };
    return sorted.find((s) => endOf(s) > now) || sorted[sorted.length - 1] || list[0] || null;
  }

  function ctConfigured() {
    return Boolean(state.settings.churchToolsUrl && state.settings.churchToolsTokenSet);
  }

  function serviceItem(s) {
    const el = document.createElement('div');
    const current = state.session?.service?.id != null && String(state.session.service.id) === String(s.id);
    el.className = 'list-item' + (current ? ' current' : '');
    el.innerHTML = '<span class="name"></span><span class="meta"></span>';
    el.querySelector('.name').textContent = s.name + (current ? ' ✓' : '');
    el.querySelector('.meta').textContent = [germanDate(s.date), s.time].filter(Boolean).join(' · ');
    el.addEventListener('click', () => chooseService(s, false));
    return el;
  }

  /** Zeigt die zuletzt vergangenen und die nächsten Termine zur Auswahl. */
  async function loadServiceOverview() {
    const list = $('service-list');
    if (!ctConfigured()) {
      list.innerHTML = '<div class="empty">ChurchTools ist noch nicht eingerichtet.</div>';
      return;
    }
    list.innerHTML = '<div class="empty">Wird geladen …</div>';
    const today = localIsoDate();
    const res = await window.api.churchtools.services({
      from: shiftDays(today, -OVERVIEW_PAST_DAYS),
      to: shiftDays(today, OVERVIEW_FUTURE_DAYS)
    });
    if ($('service-date-input').value) return;      // inzwischen ein Datum gewählt
    if (!res.ok) {
      list.innerHTML = '';
      toast('warn', res.error);
      return;
    }
    const services = withLocalTime(res.services);
    const upcoming = services.filter((s) => s.date >= today).slice(0, OVERVIEW_COUNT);
    const past = services.filter((s) => s.date < today).slice(-OVERVIEW_COUNT).reverse();

    list.innerHTML = '';
    const group = (title, items, emptyText) => {
      const head = document.createElement('div');
      head.className = 'list-head';
      head.textContent = title;
      list.appendChild(head);
      if (items.length === 0) {
        list.insertAdjacentHTML('beforeend', `<div class="empty">${emptyText}</div>`);
        return;
      }
      items.forEach((s) => list.appendChild(serviceItem(s)));
    };
    group('Heute und kommende', upcoming, 'Keine kommenden Termine gefunden.');
    group('Zuletzt', past, 'Keine vergangenen Termine gefunden.');
  }

  async function loadServicesForDate(date, silent) {
    const list = $('service-list');
    if (!ctConfigured()) {
      if (!silent) list.innerHTML = '<div class="empty">ChurchTools ist noch nicht eingerichtet.</div>';
      return;
    }
    if (!silent) list.innerHTML = '<div class="empty">Wird geladen …</div>';
    const res = await window.api.churchtools.services({ from: date, to: date });
    if (!res.ok) {
      if (!silent) list.innerHTML = '';
      toast('warn', res.error);
      return;
    }
    const services = withLocalTime(res.services);
    if (silent) {
      if (services.length === 1) {
        chooseService(services[0], true);
      } else if (services.length > 1) {
        const next = pickCurrentOrNext(services);
        toast('info', `${services.length} Termine heute – gewählt: ${next.name} (${next.time}).`, 6000);
        chooseService(next, true);
      }
      return;
    }
    list.innerHTML = '';
    if (res.services.length === 0) {
      list.innerHTML = '<div class="empty">Keine Termine an diesem Tag.</div>';
      return;
    }
    services.forEach((s) => list.appendChild(serviceItem(s)));
  }

  async function chooseService(service, silent) {
    $('modal-service').hidden = true;
    const res = await window.api.churchtools.agenda({
      eventId: service.id,
      name: service.name,
      date: service.date
    });
    if (!res.ok) return toast('warn', 'Ablaufplan nicht geladen: ' + res.error);
    // Nur Ungewöhnliches melden; die übernommenen Punkte, der Infotext und die Interpreten stehen in den Listen.
    if (res.usedDefaults) toast('info', `Kein Ablaufplan in ChurchTools – Vorlage „${res.templateName || 'Standard'}“ geladen.`, 5000);
    if (res.suggestionError) toast('warn', `Dienstplanung nicht gelesen: ${res.suggestionError}`, 8000);
  }

  $('btn-manual-service')?.addEventListener('click', async () => {
    const name = $('manual-service-name').value.trim();
    if (!name) return;
    await window.api.session.setService({ name, date: localIsoDate() });
    $('modal-service').hidden = true;
  });

  /* -------------------------------------------------------------- Bibliothek */

  /* Archiv: alle Aufnahmen nach Monat, mit Suche, Filter und Sicherungsstand. */
  const library = { sessions: [] };
  const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

  /** Datum der Aufnahme: Termin aus ChurchTools, sonst Beginn der Aufnahme (lokal). */
  function sessionDate(s) {
    const started = s.startedAt ? new Date(s.startedAt) : null;
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s.date || '');
    const day = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : started;
    return { day: day && !Number.isNaN(day.getTime()) ? day : null, started };
  }

  /** Sicherungsstand als Schild: alles gesichert, teilweise, geändert seit Export, nichts. */
  function exportTag(e) {
    if (!e) return null;
    if (e.changed) return { cls: 'warn', text: `⚠ ${e.changed} geändert seit Export` };
    if (e.sections && e.saved === e.sections) return { cls: 'ok', text: '✓ gesichert' };
    if (!e.sections && e.full) return { cls: 'ok', text: '✓ gesichert' };
    if (e.saved) return { cls: 'warn', text: `${e.saved} von ${e.sections} gesichert` };
    return { cls: '', text: 'nicht gesichert' };
  }

  function libraryMatches(s, query, filter) {
    if (filter === 'stereo' && s.mode !== 'stereo') return false;
    if (filter === 'multitrack' && s.mode !== 'multitrack') return false;
    if (filter === 'unfinished' && s.finalized) return false;
    if (filter === 'unsaved') {
      const tag = exportTag(s.exported);
      if (!tag || tag.cls === 'ok') return false;
    }
    if (!query) return true;
    const { day } = sessionDate(s);
    const hay = [s.name, s.date, day ? day.toLocaleDateString('de-DE') : '', ...(s.artists || []), ...(s.labels || [])]
      .join(' ').toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  function renderLibrary() {
    const list = $('library-list');
    const query = $('library-search').value.trim();
    const filter = $('library-filter').value;
    const shown = library.sessions.filter((s) => libraryMatches(s, query, filter));
    list.innerHTML = '';
    $('library-count').textContent = library.sessions.length
      ? `${shown.length} von ${library.sessions.length} Aufnahmen`
      : '';
    if (!library.sessions.length) {
      list.innerHTML = '<div class="empty">Noch keine Aufnahmen vorhanden.</div>';
      return;
    }
    if (!shown.length) {
      list.innerHTML = '<div class="empty">Keine Aufnahme passt zur Suche.</div>';
      return;
    }
    let month = null;
    shown.forEach((s) => {
      const { day, started } = sessionDate(s);
      const key = day ? `${MONTHS[day.getMonth()]} ${day.getFullYear()}` : 'Ohne Datum';
      if (key !== month) {
        month = key;
        const head = document.createElement('div');
        head.className = 'library-month';
        head.textContent = key;
        list.appendChild(head);
      }
      const el = document.createElement('div');
      el.className = 'library-item' + (s.finalized ? '' : ' unfinished');
      el.tabIndex = 0;
      el.title = 'Öffnen';
      el.innerHTML = '<div class="when"><b></b><small></small></div><div class="what"><div class="title"></div><div class="meta"></div></div><div class="tags"></div><button class="reveal" title="Im Ordner zeigen">📂</button>';
      el.querySelector('.when b').textContent = day ? `${WEEKDAYS[day.getDay()]} ${day.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}` : '–';
      el.querySelector('.when small').textContent = started ? `${started.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr` : '';
      el.querySelector('.title').textContent = s.name;
      const meta = [fmtLength(s.duration), `${s.sectionCount} Abschnitte`];
      if (s.artists?.length) meta.push(s.artists.join(', '));
      el.querySelector('.meta').textContent = meta.join(' · ');
      el.querySelector('.what').title = [s.name, ...(s.labels || [])].join('\n');
      const tags = el.querySelector('.tags');
      const addTag = (cls, text, title) => {
        const t = document.createElement('span');
        t.className = `tag ${cls}`;
        t.textContent = text;
        if (title) t.title = title;
        tags.appendChild(t);
      };
      if (!s.finalized) addTag('warn', 'unterbrochen', 'Die Aufnahme wurde nicht regulär beendet (Absturz o. Ä.). Öffnen stellt sie wieder her.');
      if (!s.wavExists) addTag('warn', 'Audio fehlt', 'Die Audiodatei wurde nicht gefunden (verschoben oder gelöscht).');
      if (s.mode === 'multitrack') addTag('mt', `Mehrspur · ${s.tracks}`, `${s.tracks} Spuren`);
      const tag = exportTag(s.exported);
      if (tag) addTag(tag.cls, tag.text, s.exported.full ? 'Gesamte Aufnahme ist ebenfalls gesichert.' : '');
      el.addEventListener('click', () => openSession(s.path));
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter') openSession(s.path); });
      el.querySelector('.reveal').addEventListener('click', async (e) => {
        e.stopPropagation();
        const res = await window.api.app.reveal(s.path);
        if (!res.ok) toast('warn', res.error);
      });
      list.appendChild(el);
    });
  }

  async function openLibrary() {
    openModal('modal-library');
    const list = $('library-list');
    list.innerHTML = '<div class="empty">Wird geladen …</div>';
    $('library-count').textContent = '';
    const res = await window.api.session.list();
    library.sessions = res.ok ? res.sessions : [];
    renderLibrary();
    $('library-search').focus();
  }

  async function openSession(path) {
    const res = await window.api.session.open(path);
    if (!res.ok) return toast('error', res.error);
    $('modal-library').hidden = true;
    const full = await window.api.session.state();
    if (full.ok) {
      state.peaks = full.peaks || [];
      wave.peaks = state.peaks;
      setLoudness(full.loudness);
      applyState(full.state, full.peaks);
      fitZoom();
    }
  }

  async function checkRecovery() {
    const res = await window.api.session.recoverable();
    if (!res.ok || res.sessions.length === 0) return;
    const s = res.sessions[0];
    toast('warn', `Eine unterbrochene Aufnahme wurde gefunden (${s.date}, ${fmt(s.duration)}). Über „Aufnahmen“ wiederherstellbar.`, 12000);
  }

  /* --------------------------------------------------------- Einstellungen */

  async function fillDeviceSelect(sel, kind, savedId, emptyText) {
    sel.innerHTML = '';
    const std = document.createElement('option');
    std.value = '';
    std.textContent = 'Systemstandard';
    sel.appendChild(std);
    try {
      const devices = await window.Capture.listDevices(kind);
      devices.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label;
        sel.appendChild(opt);
      });
      if (devices.length === 0) std.textContent = emptyText;
      // Gespeichertes Gerät nicht mehr angeschlossen: bei Systemstandard bleiben.
      const present = devices.some((d) => d.id === savedId);
      sel.value = present ? savedId : '';
      if (kind === 'audioinput') state.inputMissing = Boolean(savedId) && !present;
    } catch (err) {
      std.textContent = 'Zugriff auf Audiogeräte fehlgeschlagen';
    }
  }

  async function refreshDevices() {
    await fillDeviceSelect($('set-device'), 'audioinput', state.settings.inputDeviceId, 'Systemstandard (kein Eingang gefunden)');
    await fillDeviceSelect($('set-output'), 'audiooutput', state.settings.outputDeviceId, 'Systemstandard');
    applyOutputDevice();
    renderNow();
  }

  /** Pultfarben (Wert 0–15, ab 8 invertiert) als Name für CSS. */
  const MIXER_COLORS = ['off', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

  /** Einstellungen → Mischpult: Verbindung, Routing samt Bewertung, Kanalnamen. */
  function renderMixer(m) {
    state.mixer = m;
    if (!m) return;
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const st = $('mixer-status');
    if (!m.configured) {
      st.textContent = '● Kein Pult eingerichtet';
      st.dataset.level = '';
    } else if (m.status === 'connected') {
      const i = m.info || {};
      st.innerHTML = `● Verbunden: ${esc(i.model || 'Pult')} „${esc(i.name || '')}“ · Firmware ${esc(i.version || '?')} · ${esc(i.ip || m.host)}${m.simulated ? ' (simuliert)' : ''}`;
      st.dataset.level = 'ok';
    } else if (m.status === 'lost') {
      st.textContent = `● ${m.host} antwortet nicht mehr`;
      st.dataset.level = 'warn';
    } else {
      st.textContent = `● Verbinde mit ${m.host} …`;
      st.dataset.level = 'warn';
    }

    const kinds = { stereo: 'Stereo', multitrack: 'Mehrspur', unknown: 'unbekannt' };
    const r = $('mixer-routing');
    const c = m.check || {};
    const learned = m.learned || {};
    const learnedText = `Gemerkt: Stereo ${learned.stereo ? '✓' : '–'}, Mehrspur ${learned.multitrack ? '✓' : '–'}`;
    if (!m.configured || m.status !== 'connected' || !c.labels) {
      r.innerHTML = `Routing unbekannt (nicht verbunden).<br>${learnedText}`;
    } else {
      const verdict = c.status === 'ok'
        ? `<span class="ok">passt zur Aufnahmeart ${kinds[m.mode]}</span>`
        : c.status === 'mismatch'
          ? `<span class="bad">passt NICHT zur Aufnahmeart ${kinds[m.mode]}</span>`
          : '<span class="bad">nicht eindeutig – bitte anlernen</span>';
      r.innerHTML = `USB-Ausgänge ${c.labels.map(esc).join(' · ')}<br>`
        + `Erkannt: <b>${kinds[c.kind]}</b> (${c.learned ? 'gemerkt' : 'Faustregel'}) – ${verdict}<br>${learnedText}`;
    }
    // Merken geht nur mit verbundenem Pult: sonst ausblenden statt ausgrauen
    $('btn-mixer-learn-stereo').hidden = !c.labels;
    $('btn-mixer-learn-multi').hidden = !c.labels;
    $('btn-mixer-forget').hidden = !(learned.stereo || learned.multitrack);
    $('btn-mixer-learn-multi').disabled = !c.labels;
    $('mixer-sim-row').hidden = !m.simulated;
    // Warnbalken sofort richtig, auch wenn noch keine Gesundheitsmeldung kam (z. B. direkt nach dem Start).
    state.health = { ...(state.health || {}), routing: c.status && c.status !== 'off' ? c.status : null };

    const list = $('mixer-channels');
    list.innerHTML = '';
    const channels = m.status === 'connected' ? (m.channels || []) : [];
    if (!channels.length) {
      const empty = document.createElement('div');
      empty.className = 'mixer-empty';                 // über alle Spalten, sonst bricht der Text in der ersten um
      empty.textContent = 'Nicht verbunden – Spuren heißen „Kanal 1“, „Kanal 2“ …';
      list.appendChild(empty);
    }
    channels.forEach((ch, i) => {
      const el = document.createElement('div');
      el.className = 'mixer-ch';
      if (Number.isInteger(ch.color)) el.dataset.color = MIXER_COLORS[ch.color % 8];
      el.innerHTML = `<b>${i + 1}</b><span>${esc(ch.name || '–')}</span>`;
      el.title = ch.name || `Kanal ${i + 1} (ohne Namen)`;
      list.appendChild(el);
    });
    applyHealth(state.health);
    renderChannels();
  }

  /* ------------------------------------------------------------- Mehrspur */

  const CH_SILENT_LEVEL = 0.001;     // etwa -60 dBFS
  const CH_SILENT_AFTER_MS = 20000;  // so lange still → Kanal gilt als stumm (nur während der Aufnahme)
  const mt = { monitor: null, rows: [], key: '', hold: [], holdAt: [], clipUntil: [], loudAt: [], silentText: '', play: null, playText: '' };

  /** Eingestellte Aufnahmeart (für die nächste Aufnahme). */
  function settingMode() {
    return state.settings?.recordingMode === 'multitrack' ? 'multitrack' : 'stereo';
  }

  /**
   * Mehrspur-Ansicht (Kanäle statt Export): folgt dem Umschalter; während einer Aufnahme gilt deren Art
   * (der Umschalter ist dann gesperrt).
   */
  function multitrackView() {
    if (isLive()) return state.session.mode === 'multitrack';
    return settingMode() === 'multitrack';
  }

  /** Schild „Mehrspur“ in der Kopfzeile und Ansicht passend zur Aufnahmeart (Stereo ist der Normalfall: kein Schild). */
  function applyMode() {
    const live = isLive();
    const mode = live ? (state.session.mode || 'stereo') : settingMode();
    const badge = $('btn-mode-badge');
    badge.hidden = mode !== 'multitrack';
    badge.title = live
      ? 'Es läuft eine Mehrspuraufnahme'
      : 'Mehrspuraufnahme ist eingestellt – Klick: Aufnahmeart in den Einstellungen ändern';
    document.body.classList.toggle('mt', multitrackView());
    renderChannels();
    applyPlayControls();
    applyLoudnessView();
  }

  /** Schild „Mehrspur“: Einstellungen beim Reiter Audio öffnen, die Aufnahmeart im Blick. */
  function openRecordingModeSetting() {
    settingsTab = 'audio';
    openModal('modal-settings');
    setTimeout(() => {
      const seg = $('rec-mode-seg');
      seg.scrollIntoView({ block: 'center' });
      seg.querySelector('[aria-checked="true"]')?.focus();
    }, 50);
  }

  /**
   * Kanäle für die Anzeige. Während einer Mehrspuraufnahme: deren Spuren (fest). Sonst: Anzahl vom Gerät, Namen
   * und Farben vom Pult, Auswahl aus den Einstellungen (gilt für die nächste Aufnahme).
   */
  function channelModel() {
    const s = state.session;
    const live = isLive() && s.mode === 'multitrack';
    const tracks = s?.mode === 'multitrack' ? (s.tracks || []) : [];
    const pult = state.mixer?.status === 'connected' ? (state.mixer.channels || []) : [];
    const byChannel = new Map(tracks.map((t) => [t.channel, t]));
    const inputs = mt.monitor?.info?.inputs || Math.max(32, ...tracks.map((t) => t.channel + 1));
    const armedSetting = state.settings?.multitrackArmed;
    return Array.from({ length: inputs }, (_, c) => {
      const t = byChannel.get(c);
      const p = pult[c] || {};
      // Aufgenommene Spuren behalten ihren Namen vom Start; die übrigen zeigen den aktuellen Namen am Pult.
      const name = live && t ? t.name : (p.name || t?.name);
      return {
        c,
        name: name || `Kanal ${c + 1}`,
        named: Boolean(p.name),
        color: live ? t?.color : (Number.isInteger(p.color) ? p.color : t?.color),
        armed: live ? byChannel.has(c) : (!Array.isArray(armedSetting) || armedSetting.includes(c))
      };
    });
  }

  /** Pegelstellung 0..1 auf einer dB-Skala (−60 … 0 dBFS). */
  function levelPos(p) {
    if (!(p > 0)) return 0;
    return Math.max(0, Math.min(1, (20 * Math.log10(p) + 60) / 60));
  }

  function renderChannels() {
    if (!multitrackView()) return;
    const model = channelModel();
    const live = isLive();
    const key = JSON.stringify([model, live]);
    if (key !== mt.key) {
      mt.key = key;
      const list = $('ch-list');
      list.replaceChildren();
      mt.rows = model.map((m) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = 'ch';
        el.dataset.armed = String(m.armed);
        if (Number.isInteger(m.color)) el.dataset.color = MIXER_COLORS[m.color % 8];
        el.disabled = live;
        el.title = `${m.c + 1}: ${m.name}${m.armed ? '' : ' – wird nicht aufgenommen'}${live ? '' : ' (Klick: an- bzw. abwählen)'}`;
        el.innerHTML = '<b></b><span class="ch-name"></span><span class="ch-meter"><i></i><u></u></span>';
        el.querySelector('b').textContent = String(m.c + 1);
        el.querySelector('.ch-name').textContent = m.name;
        el.addEventListener('click', () => toggleArmed(m.c));
        list.appendChild(el);
        return { el, fill: el.querySelector('i'), hold: el.querySelector('u'), armed: m.armed, name: m.name };
      });
    }
    $('ch-all').disabled = live;
    $('ch-named').disabled = live;
    renderChannelStatus(model);
  }

  function renderChannelStatus(model = channelModel()) {
    const el = $('ch-status');
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const armed = model.filter((m) => m.armed).length;
    const parts = [];
    const s = state.session;
    if (isLive() && s.mode === 'multitrack') {
      parts.push(`Aufnahme: ${armed} ${armed === 1 ? 'Spur' : 'Spuren'}`);
    } else {
      const m = mt.monitor;
      if (m?.active && m.info) {
        parts.push(`${esc(m.info.device)} · ${(m.info.sampleRate / 1000).toLocaleString('de-DE')} kHz · ${armed} von ${model.length} Kanälen ausgewählt`);
      } else if (m?.error) {
        parts.push(`<span class="bad">Gerät nicht verfügbar</span>: ${esc(m.error)} – neuer Versuch alle 10 s`);
      } else if (settingMode() === 'multitrack') {
        parts.push('Gerät wird geöffnet …');
      }
      if (s?.status === 'stopped' && s.mode !== 'multitrack' && s.wavPath) {
        parts.push('Angezeigt wird eine Stereo-Aufnahme – gesichert wird wie gewohnt über den Knopf oben links.');
      }
    }
    if (mt.playText) parts.push(mt.playText);
    if (mt.monitor?.stalled) parts.push('<span class="bad">Das Gerät liefert keine Daten (Mischpult aus?)</span>');
    if (state.mixer?.configured && state.mixer.status !== 'connected') parts.push('<span class="bad">Mischpult nicht verbunden – Namen fehlen</span>');
    if (state.diskHoursLeft != null && settingMode() === 'multitrack' && !isLive()) parts.push(`Platz für ca. ${formatHours(state.diskHoursLeft)}`);
    if (mt.silentText) parts.push(`<span class="bad">${esc(mt.silentText)}</span>`);
    el.innerHTML = parts.join('<br>');
  }

  async function saveArmed(list) {
    const res = await window.api.settings.set({ multitrackArmed: list });
    if (!res.ok) return toast('error', res.error);
    state.settings = res.settings;
    renderChannels();
    refreshDisk();
  }

  /** Kanal für die nächste Aufnahme an- bzw. abwählen (alle gewählt = null: neue Gerätekanäle kommen automatisch dazu). */
  function toggleArmed(c) {
    if (isLive()) return;
    const model = channelModel();
    const armed = new Set(model.filter((m) => m.armed).map((m) => m.c));
    if (armed.has(c)) armed.delete(c); else armed.add(c);
    if (armed.size === 0) return toast('info', 'Mindestens ein Kanal muss aufgenommen werden.');
    saveArmed(armed.size === model.length ? null : [...armed].sort((a, b) => a - b));
  }

  /* Zurückspielen zum Pult (beendete Mehrspuraufnahme) */

  /** Schleife: gewählter Abschnitt, sonst die ganze Aufnahme; ohne Häkchen keine. */
  function playbackLoop() {
    if (!$('chk-loop').checked) return null;
    const x = (state.session?.sections || []).find((y) => y.id === state.selectedSectionId && y.start != null && y.end != null);
    return x ? { start: x.start, end: x.end } : { start: 0, end: state.session?.duration || 0 };
  }

  async function toggleMultitrackPlayback() {
    const s = state.session;
    if (!s || s.status !== 'stopped') return;
    if (mt.play?.playing) {
      const res = await window.api.multitrack.stopPlayback();
      if (!res.ok) toast('error', res.error);
      return;
    }
    if (!mt.playHintShown) {
      mt.playHintShown = true;
      toast('info', 'Die Spuren laufen über die USB-Ausgänge zum Mischpult. Zu hören sind sie nur, wenn dort die Kanäle die USB-Karte als Quelle haben.', 12000);
    }
    const start = state.playheadT != null && state.playheadT < (s.duration || 0) - 0.5 ? state.playheadT : 0;
    const res = await window.api.multitrack.play(start, playbackLoop());
    if (!res.ok) return toast('error', res.error);
    applyPlayback(res.play);
  }

  /** Abspielstand: Knopf, Marke in der Wellenform, Zeile im Kanal-Bereich. */
  function applyPlayback(play) {
    const was = mt.play?.playing;
    mt.play = play;
    if (play?.playing) {
      wave.update({ playhead: play.pos });
      state.playheadT = play.pos;
    }
    const loopName = play?.loop
      ? ((state.session?.sections || []).find((x) => x.id === state.selectedSectionId && Math.abs(x.start - play.loop.start) < 0.05)?.label || 'ganze Aufnahme')
      : null;
    const text = play?.playing
      ? `▶ Spielt zum Pult: ${fmt(play.pos)} / ${fmt(play.length)}${loopName ? ` · Schleife: ${loopName}` : ''}`
      : '';
    if (text !== mt.playText) {
      mt.playText = text;
      if (multitrackView()) renderChannelStatus();
    }
    if (was !== play?.playing) updatePlayButton();
  }

  /** Kanalpegel (auch vor dem Start): Balken, Spitzenwert, Übersteuerung, stumme Kanäle während der Aufnahme. */
  function applyTrackLevels({ peaks = [], clips = [], play }) {
    if (play && (play.playing || mt.play?.playing)) applyPlayback(play);
    if (!multitrackView() || !mt.rows.length) return;
    const now = Date.now();
    const recording = state.session?.status === 'recording' && state.session.mode === 'multitrack';
    const silent = [];
    let max = 0;
    let anyClip = false;
    mt.rows.forEach((row, c) => {
      const p = peaks[c] || 0;
      const pos = levelPos(p);
      if (pos >= (mt.hold[c] || 0) || now - (mt.holdAt[c] || 0) > 1500) {
        mt.hold[c] = pos;
        mt.holdAt[c] = now;
      }
      if (clips[c]) mt.clipUntil[c] = now + 2000;
      if (p > CH_SILENT_LEVEL || !recording || !row.armed) mt.loudAt[c] = now;
      const clipping = now < (mt.clipUntil[c] || 0);
      row.fill.style.width = `${pos * 100}%`;
      row.fill.dataset.level = clipping ? 'clip' : (p > 0.5 ? 'hot' : 'ok');
      row.hold.style.left = `calc(${mt.hold[c] * 100}% - 2px)`;
      row.el.dataset.clip = String(clipping);
      const isSilent = now - mt.loudAt[c] > CH_SILENT_AFTER_MS;
      row.el.dataset.silent = String(isSilent);
      if (isSilent) silent.push(row.name);
      if (row.armed) {
        max = Math.max(max, p);
        anyClip = anyClip || clipping;
      }
    });
    const text = silent.length ? `Seit über 20 s still: ${silent.join(', ')}` : '';
    if (text !== mt.silentText) {
      mt.silentText = text;
      renderChannelStatus();
    }
    // Vor dem Start zeigt der große Pegel den lautesten gewählten Kanal (während der Aufnahme kommt er aus der Session).
    if (!isLive()) setMeters(max, max, anyClip);
  }

  /**
   * Auswahl des Mehrspur-Geräts. Gespeichert wird der Name; ein gewähltes, gerade nicht angeschlossenes
   * Gerät (Mischpult aus) bleibt als Eintrag stehen. `devices` = null: nur die gespeicherte Wahl zeigen.
   */
  function fillMultitrackSelect(devices) {
    const select = $('set-mt-device');
    const wanted = select.value || state.settings.multitrackDevice || '';
    select.innerHTML = '';
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = text;
      select.appendChild(o);
    };
    add('', 'Automatisch (Gerät mit den meisten Eingängen)');
    for (const d of devices || []) add(d.name, `${d.name} (${d.inputs} Eingänge)`);
    if (wanted && ![...select.options].some((o) => o.value === wanted)) add(wanted, devices ? `${wanted} (nicht verbunden)` : wanted);
    select.value = wanted;
  }

  /**
   * Sucht Geräte für die Mehrspuraufnahme (im Mehrspur-Prozess, unter Windows ASIO). Nur auf Knopfdruck und
   * nie während einer Aufnahme: Zum Suchen werden die ASIO-Treiber kurz geladen.
   */
  async function refreshMultitrackDevices() {
    const info = $('mt-device-info');
    if (isLive()) {
      info.textContent = 'Nicht während einer Aufnahme.';
      return;
    }
    info.textContent = 'Geräte werden gesucht …';
    const res = await window.api.multitrack.devices(false);
    if (!res.ok) {
      info.textContent = `Geräte konnten nicht gelesen werden: ${res.error}`;
      return;
    }
    const devices = res.devices.filter((d) => d.inputs > 0);
    fillMultitrackSelect(devices);
    info.textContent = devices.length
      ? `Schnittstelle: ${res.api} · ${devices.length} Gerät(e) mit Eingängen`
      : `Schnittstelle: ${res.api} · kein Gerät gefunden${navigator.platform.startsWith('Win') ? ' (ASIO-Treiber installiert, Mischpult an?)' : ''}`;
  }

  /** Wendet das gewählte Ausgabegerät auf Mithören und Abspielen an. */
  function applyOutputDevice() {
    const id = state.settings.outputDeviceId || '';
    monitor.setOutput(id).catch(() => {});
    const player = $('player');
    if (player.setSinkId) {
      player.setSinkId(id).catch(() => player.setSinkId('').catch(() => {}));
    }
  }

  function applySettingsToForm() {
    const s = state.settings;
    $('set-samplerate').value = String(s.sampleRate);
    $('set-rec-mode').value = s.recordingMode === 'multitrack' ? 'multitrack' : 'stereo';
    syncRecModeSeg();
    $('set-mt-simulate').checked = Boolean(s.multitrackSimulate);
    $('set-mt-device').value = s.multitrackDevice || '';
    if (!$('set-mt-device').options.length || $('set-mt-device').value !== (s.multitrackDevice || '')) fillMultitrackSelect(null);
    $('set-mt-dir').value = s.multitrackDir || '';
    $('set-mixer-host').value = s.mixerHost || '';
    $('set-dir').value = s.recordingsDir;
    loadTemplatesDraft();
    renderTemplateEditor();
    fillPlanTemplates();
    $('set-default-artist').value = s.defaultArtist || '';
    $('set-export-dir').value = s.exportDir || '';
    $('set-pattern').value = s.fileNamePattern;
    $('set-bitrate').value = String(s.mp3Bitrate);
    $('set-loudness').value = String(s.loudnessTarget ?? 0);
    if (!$('set-loudness').value) $('set-loudness').value = '0';
    $('set-ct-url').value = s.churchToolsUrl;
    $('set-ct-auto').checked = Boolean(s.autoLoadTodaysService);
    state.calendarIds = (s.churchToolsCalendarIds || []).map(String);
    $('ct-calendars').innerHTML = '';
    $('ct-calendars-info').textContent = state.calendarIds.length
      ? `· ${state.calendarIds.length} ausgewählt`
      : '· alle';
    $('set-ct-services').value = s.artistServices || '';
    $('ct-token-state').textContent = s.churchToolsTokenSet
      ? (s.encryptionAvailable ? 'Token hinterlegt (verschlüsselt).' : 'Token hinterlegt – unverschlüsselt (auf diesem System nicht möglich).')
      : 'Kein Token hinterlegt.';
    $('set-net-on').checked = Boolean(s.networkEnabled);
    $('set-net-port').value = s.networkPort;
    $('set-net-pass').value = s.networkPassword;
    $('set-monitor-pass').value = s.monitorPassword;
    $('set-autoupdate').checked = Boolean(s.autoUpdateCheck);
    $('set-theme').value = s.theme || 'dark';
    $('set-loudness-monitor').checked = s.loudnessMonitor !== false;
    $('set-follow-live').checked = s.followLive !== false;
    $('set-prelisten').checked = s.prelisten !== false;
    renderPathViews();
    updatePatternPreview();
    $('test-tools').open = Boolean(s.multitrackSimulate);
  }

  /** Editor für die Standard-Programmpunkte (Name, nach oben/unten, entfernen). */
  function renderDefaultAgenda(list) {
    const box = $('default-agenda-list');
    box.innerHTML = '';
    (list || []).forEach((text) => addDefaultAgendaRow(text));
  }

  /**
   * Eine Zeile im Vorlagen-Editor: am Griff ziehen (wie in der Liste „Ablauf“) oder Alt + ↑/↓ im Feld; × entfernt.
   */
  function addDefaultAgendaRow(text = '') {
    const box = $('default-agenda-list');
    const row = document.createElement('div');
    row.className = 'agenda-row';
    row.innerHTML = `<span class="grip" title="Ziehen zum Verschieben" aria-hidden="true">⋮⋮</span><input type="text" aria-label="Programmpunkt" />
      <button class="ghost" type="button" data-del title="Entfernen" aria-label="Punkt entfernen">×</button>`;
    const input = row.querySelector('input');
    input.value = text;
    const moved = () => updateSettingsDirty();
    row.querySelector('[data-del]').addEventListener('click', () => { row.remove(); moved(); });
    input.addEventListener('keydown', (e) => {
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      e.preventDefault();
      if (e.key === 'ArrowUp' && row.previousElementSibling) box.insertBefore(row, row.previousElementSibling);
      if (e.key === 'ArrowDown' && row.nextElementSibling) box.insertBefore(row.nextElementSibling, row);
      input.focus();
      moved();
    });
    // Ziehen nur am Griff, damit man im Feld weiter Text markieren kann
    const grip = row.querySelector('.grip');
    grip.addEventListener('pointerdown', () => { row.draggable = true; });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/agenda-row', '1');
      e.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.draggable = false;
      row.classList.remove('dragging');
      box.querySelectorAll('.agenda-row').forEach((r) => r.classList.remove('drop-before', 'drop-after'));
      moved();
    });
    row.addEventListener('dragover', (e) => {
      const dragging = box.querySelector('.agenda-row.dragging');
      if (!dragging || dragging === row) return;
      e.preventDefault();
      const before = e.clientY - row.getBoundingClientRect().top < row.offsetHeight / 2;
      box.insertBefore(dragging, before ? row : row.nextElementSibling);
    });
    box.appendChild(row);
    return row;
  }

  /* ----------------------------------------------- Vorlagen für Programmpunkte */

  /** Arbeitskopie der Vorlagen für den Einstellungsdialog. */
  function loadTemplatesDraft() {
    const list = JSON.parse(JSON.stringify(state.settings.agendaTemplates || []));
    state.tpl = {
      templates: list,
      defaultId: state.settings.defaultTemplateId || (list[0] && list[0].id),
      selectedId: state.settings.defaultTemplateId || (list[0] && list[0].id)
    };
  }

  /** Übernimmt Name und Punkte aus den Eingabefeldern in die Arbeitskopie. */
  function commitTemplateDraft() {
    const t = state.tpl;
    const cur = t && t.templates.find((x) => x.id === t.selectedId);
    if (!cur) return;
    cur.name = $('tpl-name').value.trim() || 'Ohne Namen';
    cur.items = readDefaultAgenda();
  }

  function renderTemplateEditor() {
    const t = state.tpl;
    if (!t) return;
    const sel = $('tpl-select');
    sel.innerHTML = '';
    t.templates.forEach((tpl) => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name + (tpl.id === t.defaultId ? ' (Standard)' : '');
      sel.appendChild(opt);
    });
    sel.value = t.selectedId;
    const cur = t.templates.find((x) => x.id === t.selectedId);
    $('tpl-name').value = cur ? cur.name : '';
    // Es gibt immer genau eine Standardvorlage: Schild bei ihr, sonst der Knopf zum Festlegen
    const isDefault = t.defaultId === t.selectedId;
    $('tpl-default-badge').hidden = !isDefault;
    $('tpl-make-default').hidden = isDefault;
    renderDefaultAgenda(cur ? cur.items : []);
  }

  function readTemplatesForSave() {
    commitTemplateDraft();
    return { agendaTemplates: state.tpl.templates, defaultTemplateId: state.tpl.defaultId };
  }

  /** Auswahlfeld in der Kachel "Ablaufplan": Vorlage laden. */
  function fillPlanTemplates() {
    const sel = $('plan-template');
    sel.innerHTML = '<option value="">Vorlage laden …</option>';
    (state.settings.agendaTemplates || []).forEach((tpl) => {
      const opt = document.createElement('option');
      opt.value = tpl.id;
      opt.textContent = tpl.name;
      sel.appendChild(opt);
    });
  }

  async function applyPlanTemplate(id) {
    const tpl = (state.settings.agendaTemplates || []).find((x) => x.id === id);
    $('plan-template').value = '';
    if (!tpl) return;
    if ((state.session?.pending || []).length > 0) {
      const go = await confirmDialog(
        `Vorlage „${tpl.name}“ laden?`,
        'Die offenen Punkte im Ablaufplan werden durch die Punkte der Vorlage ersetzt. Bereits gesetzte Abschnitte bleiben erhalten.',
        'Vorlage laden'
      );
      if (!go) return;
    }
    const res = await window.api.agenda.applyTemplate(id);
    if (!res.ok) toast('error', res.error, 4000);
  }

  function readDefaultAgenda() {
    return [...$('default-agenda-list').querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
  }

  /** Ausgewählte Kalender: aus den Häkchen, falls geladen, sonst die gespeicherte Auswahl. */
  function readCalendarSelection() {
    const boxes = $('ct-calendars').querySelectorAll('input[type=checkbox]');
    if (!boxes.length) return (state.calendarIds || []).map((id) => (Number.isFinite(Number(id)) ? Number(id) : id));
    return [...boxes].filter((b) => b.checked).map((b) => Number(b.value));
  }

  async function loadCalendars() {
    $('ct-calendars-info').textContent = 'Wird geladen …';
    const res = await window.api.churchtools.calendars();
    if (!res.ok) {
      $('ct-calendars-info').textContent = res.error;
      return;
    }
    const box = $('ct-calendars');
    box.innerHTML = '';
    res.calendars.forEach((c) => {
      const label = document.createElement('label');
      label.innerHTML = '<input type="checkbox" />';
      const input = label.querySelector('input');
      input.value = c.id;
      input.checked = (state.calendarIds || []).includes(String(c.id));
      label.append(c.name);
      box.appendChild(label);
    });
    $('ct-calendars-info').textContent = '· ohne Häkchen gelten alle';
  }

  function bindSettingsForm() {
    $('btn-ct-calendars').addEventListener('click', loadCalendars);
    $('btn-default-agenda-add').addEventListener('click', () => addDefaultAgendaRow('').querySelector('input').focus());
    $('tpl-select').addEventListener('change', (e) => { commitTemplateDraft(); state.tpl.selectedId = e.target.value; renderTemplateEditor(); });
    $('btn-tpl-add').addEventListener('click', () => {
      commitTemplateDraft();
      const tpl = { id: 'tpl_' + Date.now().toString(36), name: 'Neue Vorlage', items: [] };
      state.tpl.templates.push(tpl);
      state.tpl.selectedId = tpl.id;
      renderTemplateEditor();
      $('tpl-name').focus();
      $('tpl-name').select();
    });
    $('btn-tpl-del').addEventListener('click', () => {
      const t = state.tpl;
      if (t.templates.length <= 1) return toast('warn', 'Mindestens eine Vorlage muss bleiben.', 4000);
      t.templates = t.templates.filter((x) => x.id !== t.selectedId);
      if (t.defaultId === t.selectedId) t.defaultId = t.templates[0].id;
      t.selectedId = t.defaultId;
      renderTemplateEditor();
    });
    $('tpl-make-default').addEventListener('click', () => {
      commitTemplateDraft();      // Änderungen an Name und Punkten nicht verlieren
      state.tpl.defaultId = state.tpl.selectedId;
      renderTemplateEditor();
      updateSettingsDirty();
    });
    $('tpl-name').addEventListener('input', () => {
      // Name sofort im Auswahlfeld zeigen
      const opt = $('tpl-select').selectedOptions[0];
      if (opt) opt.textContent = $('tpl-name').value || 'Ohne Namen';
    });
    $('btn-choose-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder('Ordner für Aufnahmen wählen', $('set-dir').value);
      if (res.ok && res.path) $('set-dir').value = res.path;
      renderPathViews();
      updateSettingsDirty();
    });
    $('btn-choose-export-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder('Oberordner für MP3-Exporte wählen', $('set-export-dir').value);
      if (res.ok && res.path) $('set-export-dir').value = res.path;
      renderPathViews();
      updateSettingsDirty();
    });
    $('btn-clear-export-dir').addEventListener('click', () => { $('set-export-dir').value = ''; renderPathViews(); updateSettingsDirty(); });
    $('btn-choose-mt-dir').addEventListener('click', async () => {
      const res = await window.api.settings.chooseFolder('Ordner für Mehrspuraufnahmen wählen', $('set-mt-dir').value || $('set-dir').value);
      if (res.ok && res.path) $('set-mt-dir').value = res.path;
      renderPathViews();
      updateSettingsDirty();
    });
    $('btn-clear-mt-dir').addEventListener('click', () => { $('set-mt-dir').value = ''; renderPathViews(); updateSettingsDirty(); });
    $('btn-mt-refresh').addEventListener('click', () => refreshMultitrackDevices());
    $('btn-mode-badge').addEventListener('click', openRecordingModeSetting);
    $('ch-all').addEventListener('click', () => saveArmed(null));
    $('ch-named').addEventListener('click', () => {
      if (state.mixer?.status !== 'connected') return toast('info', 'Das Mischpult ist nicht verbunden – die Namen sind nicht bekannt.');
      const named = channelModel().filter((m) => m.named).map((m) => m.c);
      if (!named.length) return toast('info', 'Am Mischpult hat kein Kanal einen Namen.');
      saveArmed(named);
    });
    $('btn-mixer-discover').addEventListener('click', async () => {
      const out = $('mixer-found');
      out.textContent = 'Suche im Netz …';
      const res = await window.api.mixer.discover();
      if (!res.ok) { out.textContent = `Suche fehlgeschlagen: ${res.error}`; return; }
      if (!res.found.length) { out.textContent = 'Kein Pult gefunden – IP von Hand eintragen (am Pult: Setup → Network).'; return; }
      out.textContent = 'Gefunden: ' + res.found.map((f) => `${f.model} „${f.name}“ (${f.ip})`).join(', ') + ' – bitte speichern.';
      $('set-mixer-host').value = res.found[0].ip;
    });
    const learn = async (mode) => {
      const res = await window.api.mixer.learn(mode);
      if (!res.ok) toast('error', res.error);
      else renderMixer(res.mixer);
    };
    $('btn-mixer-learn-stereo').addEventListener('click', () => learn('stereo'));
    $('btn-mixer-learn-multi').addEventListener('click', () => learn('multitrack'));
    $('btn-mixer-forget').addEventListener('click', async () => {
      const res = await window.api.mixer.forget();
      if (res.ok) renderMixer(res.mixer);
    });
    $('btn-mixer-sim-stereo').addEventListener('click', () => window.api.mixer.simulateRouting('stereo'));
    $('btn-mixer-sim-multi').addEventListener('click', () => window.api.mixer.simulateRouting('multitrack'));
    $('btn-ct-test').addEventListener('click', async () => {
      $('ct-test-result').textContent = 'Wird geprüft …';
      await saveSettings(true);
      const res = await window.api.churchtools.test();
      $('ct-test-result').textContent = res.ok
        ? `Verbunden als ${res.name}.`
        : res.error;
    });

    $('btn-check-update').addEventListener('click', async () => {
      const res = await window.api.update.check();
      if (!res.ok) {
        $('version-info').dataset.level = 'error';
        $('version-info').textContent = `Version ${state.update?.currentVersion || ''} – ${res.error}`;
      }
    });

    $('btn-save-settings').addEventListener('click', () => saveSettings(false));
    $('settings-close').addEventListener('click', requestCloseSettings);
    $('settings-cancel').addEventListener('click', requestCloseSettings);
    // Jede Eingabe: geänderte Reiter markieren
    const modal = $('modal-settings');
    modal.addEventListener('input', () => updateSettingsDirty());
    modal.addEventListener('change', () => updateSettingsDirty());
    modal.addEventListener('click', (e) => { if (e.target.closest('#btn-tpl-add, #btn-tpl-del, #btn-default-agenda-add')) setTimeout(updateSettingsDirty, 0); });
    // Aufnahmeart als Umschalter
    document.querySelectorAll('#rec-mode-seg button').forEach((b) => b.addEventListener('click', () => {
      $('set-rec-mode').value = b.dataset.value;
      syncRecModeSeg();
      updateSettingsDirty();
    }));
    // Platzhalter per Klick an der Schreibmarke einfügen; Vorschau aktualisieren
    document.querySelectorAll('#pattern-chips [data-insert]').forEach((chip) => chip.addEventListener('click', () => {
      const input = $('set-pattern');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? input.value.length;
      const ins = chip.dataset.insert;
      const before = input.value.slice(0, start);
      const sep = before && !/[_\-\s]$/.test(before) ? '_' : '';
      input.value = before + sep + ins + input.value.slice(end);
      input.focus();
      const pos = (before + sep + ins).length;
      input.setSelectionRange(pos, pos);
      updatePatternPreview();
      updateSettingsDirty();
    }));
    $('set-pattern').addEventListener('input', updatePatternPreview);
    $('set-default-artist').addEventListener('input', updatePatternPreview);
    // Passwörter bleiben verdeckt; das Auge zeigt sie nur, solange es gedrückt ist bzw. bis zum nächsten Klick
    document.querySelectorAll('#modal-settings .reveal-btn').forEach((b) => b.addEventListener('click', () => {
      const input = $(b.dataset.reveal);
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      b.setAttribute('aria-pressed', String(show));
      b.title = show ? 'Verbergen' : 'Anzeigen';
    }));
  }

  async function saveSettings(keepOpen) {
    const patch = {
      inputDeviceId: $('set-device').value,
      inputDeviceLabel: $('set-device').selectedOptions[0]?.textContent || '',
      outputDeviceId: $('set-output').value,
      outputDeviceLabel: $('set-output').selectedOptions[0]?.textContent || '',
      sampleRate: Number($('set-samplerate').value),
      recordingMode: $('set-rec-mode').value,
      multitrackDevice: $('set-mt-device').value,
      multitrackSimulate: $('set-mt-simulate').checked,
      multitrackDir: $('set-mt-dir').value,
      mixerHost: $('set-mixer-host').value.trim(),
      recordingsDir: $('set-dir').value,
      exportDir: $('set-export-dir').value,
      ...readTemplatesForSave(),
      defaultArtist: $('set-default-artist').value.trim(),
      fileNamePattern: $('set-pattern').value.trim() || '{interpret}_{abschnitt}_{gottesdienst}_{datum}',
      mp3Bitrate: Number($('set-bitrate').value),
      loudnessTarget: Number($('set-loudness').value) || 0,
      churchToolsUrl: $('set-ct-url').value.trim(),
      autoLoadTodaysService: $('set-ct-auto').checked,
      churchToolsCalendarIds: readCalendarSelection(),
      artistServices: $('set-ct-services').value.trim(),
      networkEnabled: $('set-net-on').checked,
      networkPort: Number($('set-net-port').value) || 8765,
      networkPassword: $('set-net-pass').value,
      monitorPassword: $('set-monitor-pass').value,
      autoUpdateCheck: $('set-autoupdate').checked,
      theme: $('set-theme').value,
      loudnessMonitor: $('set-loudness-monitor').checked,
      followLive: $('set-follow-live').checked,
      prelisten: $('set-prelisten').checked
    };
    const token = $('set-ct-token').value;
    if (token) patch.churchToolsToken = token;

    const res = await window.api.settings.set(patch);
    if (!res.ok) return toast('error', res.error);
    // Geänderte Voreinstellung der Wellenform-Schalter gleich übernehmen („Folgen“ nur während einer Aufnahme).
    const loudChanged = res.settings.loudnessMonitor !== state.settings.loudnessMonitor;
    const followChanged = res.settings.followLive !== state.settings.followLive;
    state.settings = res.settings;
    if (loudChanged) state.loudOn = loudnessDefault();
    if (followChanged && isLive()) setFollow(followDefault());
    applyTheme(state.settings.theme);
    applyOutputDevice();
    applyMode();
    refreshDisk();
    renderNow();
    updatePrelisten();
    $('set-ct-token').value = '';
    applySettingsToForm();
    takeSettingsSnapshot();
    if (!keepOpen) {
      $('modal-settings').hidden = true;
    }
  }

  window.addEventListener('DOMContentLoaded', init);
})();
