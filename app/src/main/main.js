'use strict';

// Technik-Test der Mehrspuraufnahme statt der App (siehe multitrack/probe.js).
if (process.env.EBBTON_MT_PROBE) {
  require('./multitrack/probe').run();
  return;
}

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, systemPreferences, powerSaveBlocker, nativeImage } = require('electron');

const settings = require('./settings');
const { Session, slug, dateStamp } = require('./session');
const { NetServer } = require('./netserver');
const { Updater } = require('./updater');
const { createInputLog } = require('./inputlog');
const { exemptFromTimerThrottling } = require('./timerres');
const { DeficitMeter } = require('./deficit');
const churchtools = require('./churchtools');
const mp3pool = require('./mp3pool');
const RoleLogic = require('../shared/roles');
const { MultitrackManager } = require('./multitrack/manager');
const { MixerLink } = require('./mixer/link');
const mixerDiscover = require('./mixer/client').discover;

let win = null;
let timerExemptPid = 0;   // Renderer-PID, die schon von der Timer-Regel ausgenommen ist (Windows, siehe timerres.js)
const session = new Session();
const multitrack = new MultitrackManager();
const mixer = new MixerLink();
const net = new NetServer();
const updater = new Updater(() => session.status === 'recording' || session.status === 'paused');

const isDev = process.argv.includes('--dev');

// Die Audioerfassung läuft in der Oberfläche. Chromium drosselt Fenster im Hintergrund (minimiert, verdeckt, nach
// 5 min noch stärker) und stellt dann auch die Audioblöcke nur noch stoßweise zu – der Wächter hielt das für einen
// ausgefallenen Eingang und verwarf beim Neuverbinden die wartenden Blöcke (Aussetzer am Kirchen-PC, nachgestellt
// am Mac). Deshalb ohne Drosselung; zusätzlich `backgroundThrottling: false` am Fenster.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Unbehandelte Fehler nur protokollieren und melden: Electrons Standard ist ein Fehlerdialog, der den
// Hauptprozess blockiert – und damit das Schreiben der Aufnahme.
process.on('uncaughtException', (err) => {
  console.error('Unbehandelter Fehler im Hauptprozess:', err);
  try { toast('error', `Interner Fehler: ${err.message}`); } catch { /* Fenster noch nicht da */ }
});
process.on('unhandledRejection', (err) => {
  console.error('Unbehandelte Ablehnung im Hauptprozess:', err);
});

/* -------------------------------------------------------------- Hilfsfunktionen */

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function toast(level, message) {
  send('toast', { level, message });
}

/* ------------------------------------------------------ Zustand für Netzwerk-Clients */

const health = { inputLost: false, silent: false, disk: null };
let silentSince = null;
const SILENT_LEVEL = 0.001;        // etwa -60 dBFS
const SILENT_AFTER_MS = 20000;

/** Freier Platz auf dem Laufwerk der Aufnahmen (Stunden bezogen auf die aktuelle Abtastrate). */
function diskInfo() {
  // Der Ordner kann noch nicht existieren: vom nächsten vorhandenen Elternordner messen.
  const multi = settings.get('recordingMode') === 'multitrack';
  let dir = multi ? multitrackDir() : settings.get('recordingsDir');
  while (dir && !fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  const st = fs.statfsSync(dir);
  const freeBytes = Number(st.bavail) * Number(st.bsize);
  const totalBytes = Number(st.blocks) * Number(st.bsize);
  // Stereo: 16 Bit, 2 Kanäle. Mehrspur: 24 Bit je aufgenommenem Kanal (Rate der letzten Mehrspuraufnahme, sonst 48 kHz).
  const bytesPerHour = multi
    ? (lastMultitrackRate || 48000) * 3 * multitrackTrackCount() * 3600
    : (settings.get('sampleRate') || 48000) * 2 * 2 * 3600;
  return { freeBytes, totalBytes, hoursLeft: freeBytes / bytesPerHour, dir, mode: multi ? 'multitrack' : 'stereo' };
}

/* ------------------------------------------------------------- Mehrspuraufnahme */

let lastMultitrackRate = null;

/** Ordner der Mehrspuraufnahmen: eigene Einstellung, sonst Unterordner „Mehrspur“ der Aufnahmen. */
function multitrackDir() {
  return settings.get('multitrackDir') || path.join(settings.get('recordingsDir'), 'Mehrspur');
}

/** Gewählte Kanäle (0-basiert); `null` in den Einstellungen = alle des Geräts. */
function multitrackChannels(inputs) {
  const armed = settings.get('multitrackArmed');
  if (!Array.isArray(armed)) return Array.from({ length: inputs }, (_, c) => c);
  return armed.filter((c) => Number.isInteger(c) && c >= 0 && c < inputs).sort((a, b) => a - b);
}

function multitrackTrackCount() {
  const armed = settings.get('multitrackArmed');
  return Array.isArray(armed) ? Math.max(1, armed.length) : (monitorState.info?.inputs || 32);
}

/** Meiste Eingänge zuerst, bei Gleichstand das Standard-Eingabegerät des Systems (nicht zufällig das erste der Liste). */
function byInputsThenDefault(a, b) {
  return b.inputs - a.inputs || Number(Boolean(b.isDefault)) - Number(Boolean(a.isDefault));
}

/** Gerät für die Mehrspuraufnahme: das gewählte (per Name) oder das mit den meisten Eingängen. */
async function multitrackDevice() {
  const simulate = Boolean(settings.get('multitrackSimulate'));
  const { devices } = await multitrack.devices({ simulate });
  const wanted = settings.get('multitrackDevice');
  const withInputs = devices.filter((d) => d.inputs > 0);
  const device = wanted && !simulate
    ? withInputs.find((d) => d.name === wanted)
    : withInputs.sort(byInputsThenDefault)[0];
  if (!device) {
    throw new Error(wanted ? `Das Mehrspur-Gerät „${wanted}“ ist nicht verfügbar – Mischpult eingeschaltet und per USB verbunden?` : 'Kein Audiogerät mit Eingängen gefunden.');
  }
  return { device, simulate };
}

/** Dateiname einer Spur: Kanalnummer und Name, z. B. „03_Predigtmikro.wav“. */
function trackFileName(t) {
  return `${String(t.channel + 1).padStart(2, '0')}_${slug(t.name, 'Kanal')}.wav`;
}

async function startMultitrack() {
  if (session.status === 'recording') return fail('Es läuft bereits eine Aufnahme.');
  if (session.status === 'paused') return session.resume();
  const { device, simulate } = await multitrackDevice();
  const channels = multitrackChannels(device.inputs);
  if (!channels.length) return fail('Für die Mehrspuraufnahme ist kein Kanal ausgewählt.');
  // Namen und Farben vom Pult; ist es nicht erreichbar, heißen die Spuren „Kanal n“.
  if (mixer.state().configured && !mixer.connected) {
    toast('info', 'Mischpult nicht erreichbar – die Spuren heißen „Kanal 1“, „Kanal 2“ … statt wie am Pult.');
  }
  const check = routingCheck('multitrack');
  if (check.status === 'mismatch') toast('warn', routingWarning(check, 'multitrack'));
  const { folder, base } = session.multitrackTarget(multitrackDir());
  const tracks = channels.map((c) => {
    const ch = mixer.channel(c);
    const t = { channel: c, name: ch.name || `Kanal ${c + 1}`, color: ch.color };
    return { ...t, file: path.join(folder, trackFileName(t)) };
  });
  let info;
  try {
    info = await multitrack.start({ simulate, deviceId: device.id, tracks });
  } catch (err) {
    try { fs.rmdirSync(folder); } catch { /* nicht leer oder schon weg */ }
    return fail(`Die Mehrspuraufnahme konnte nicht gestartet werden: ${err.message}`);
  }
  lastMultitrackRate = info.sampleRate;
  const res = session.start({ multitrack: { writer: multitrack.writer(info), tracks, base, folder } });
  if (!res.ok) {
    await multitrack.stop().catch(() => {});
    return res;
  }
  return { ...res, device: info.device, api: info.api, sampleRate: info.sampleRate, tracks: tracks.length };
}

/** Hängt an die angezeigte, beendete Mehrspuraufnahme an (dieselben Spurdateien). */
async function continueMultitrack() {
  const files = session.trackFiles();
  const missing = files.filter((t) => !fs.existsSync(t.file));
  if (!files.length || missing.length) {
    return fail(`Spurdateien fehlen (${missing.length || 'alle'}) – Anhängen nicht möglich.`);
  }
  const { device, simulate } = await multitrackDevice();
  if (files.some((t) => t.channel >= device.inputs)) {
    return fail(`„${device.name}“ hat nur ${device.inputs} Eingänge – Anhängen nicht möglich.`);
  }
  let info;
  try {
    info = await multitrack.start({ simulate, deviceId: device.id, tracks: files, sampleRate: session.sampleRate, append: true });
  } catch (err) {
    return fail(`An die Mehrspuraufnahme kann nicht angehängt werden: ${err.message}`);
  }
  return session.continueRecording({ writer: multitrack.writer(info) });
}

multitrack.on('levels', (l) => {
  session.pushTrackLevels(l);
  send('track-levels', { peaks: l.peaks, clips: l.clips, play: l.play });   // Kanalpegel (auch vor dem Start), Abspielposition
});

/* Abhören: Im Mehrspur-Modus ist das Gerät auch ohne Aufnahme offen, damit die Kanalpegel schon vor dem Start
   laufen. Die Aufnahme übernimmt den offenen Strom (ASIO erlaubt nur einen). Fehlt das Gerät (Pult aus),
   wird es alle 10 s erneut versucht. */
let monitorState = { active: false, info: null, error: null, stalled: false };
let monitorTimer = null;
let monitorQueue = Promise.resolve();
let multitrackExits = [];                      // Zeitpunkte der letzten Abstürze des Mehrspur-Prozesses
let reopenFailLogged = false;                  // „neu öffnen fehlgeschlagen“ schon protokolliert
const MONITOR_RETRY_MS = 10000;

function sendMultitrack() {
  send('multitrack', monitorState);
}

function updateMonitor() {
  monitorQueue = monitorQueue.then(doUpdateMonitor, doUpdateMonitor);
  return monitorQueue;
}

async function doUpdateMonitor() {
  clearTimeout(monitorTimer);
  monitorTimer = null;
  if (isBusy()) return;                       // die laufende Aufnahme hat das Gerät
  if (settings.get('recordingMode') !== 'multitrack') {
    if (monitorState.active || monitorState.error) {
      await multitrack.unmonitor().catch(() => {});
      monitorState = { active: false, info: null, error: null, stalled: false };
      sendMultitrack();
    }
    return;
  }
  try {
    const { device, simulate } = await multitrackDevice();
    const info = await multitrack.monitor({ simulate, deviceId: device.id });
    monitorState = { active: true, info, error: null, stalled: false };
  } catch (err) {
    monitorState = { active: false, info: null, error: err.message, stalled: false };
    monitorTimer = setTimeout(updateMonitor, MONITOR_RETRY_MS);
  }
  sendMultitrack();
}

/* ---------------------------------------------------------------------- Mischpult */

/** Gerade gültige Aufnahmeart: die der laufenden Aufnahme, sonst die eingestellte. */
function activeMode() {
  if (session.status === 'recording' || session.status === 'paused') return session.mode;
  return settings.get('recordingMode') === 'multitrack' ? 'multitrack' : 'stereo';
}

function routingCheck(mode = activeMode()) {
  return mixer.evaluate(mode, settings.get('mixerRouting'));
}

function routingWarning(check, mode = activeMode()) {
  return mode === 'multitrack'
    ? 'Routing am Mischpult passt nicht: Ebbton nimmt Mehrspur auf, die USB-Ausgänge liefern aber die Stereo-Matrix. Am Pult die Kartenausgänge auf die Kanäle legen.'
    : 'Routing am Mischpult passt nicht: Ebbton nimmt Stereo auf, die USB-Ausgänge liefern aber einzelne Kanäle. Am Pult die Matrix auf USB 1–2 legen oder in Ebbton auf Mehrspur umstellen.';
}

function mixerState() {
  return { ...mixer.state(), check: routingCheck(), mode: activeMode(), learned: settings.get('mixerRouting') };
}

/** Pult-Zustand an die Oberfläche; Routing als Gesundheitswert (auch für Companion), Warnung beim Wechsel. */
let lastRoutingStatus = null;
function onMixerChange() {
  send('mixer', mixerState());
  const check = routingCheck();
  if (check.status === 'mismatch' && lastRoutingStatus !== 'mismatch') toast('warn', routingWarning(check));
  lastRoutingStatus = check.status;
  health.routing = check.status === 'off' ? null : check.status;
  publishHealth();
}
mixer.on('change', onMixerChange);

/** Zustand für Netzwerk-Clients: Session, Gesundheit und die gerade gültige Aufnahmeart (Companion zeigt sie an). */
function netState(s = session.snapshot()) {
  return { ...s, health: currentHealth(), recordingMode: activeMode() };
}

/**
 * Aufnahmeart umstellen (Netzwerkbefehl `mode.set`; die Oberfläche speichert über `settings:set`).
 * Während einer Aufnahme abgelehnt, wie der Umschalter in der Kopfzeile.
 */
function setRecordingMode(mode) {
  if (isBusy()) return { ok: false, error: 'Während einer Aufnahme kann die Aufnahmeart nicht umgeschaltet werden.' };
  const current = settings.get('recordingMode') === 'multitrack' ? 'multitrack' : 'stereo';
  const next = mode === 'toggle' ? (current === 'multitrack' ? 'stereo' : 'multitrack') : mode;
  if (next !== 'stereo' && next !== 'multitrack') return { ok: false, error: 'Unbekannte Aufnahmeart (stereo, multitrack oder toggle).' };
  if (next !== current) {
    settings.save({ recordingMode: next });
    send('settings', settings.forRenderer());   // Oberfläche: Umschalter und Kanal-Bereich nachziehen
    configureMixer();
    updateMonitor();
    refreshDisk();
  }
  return { ok: true, mode: next };
}

/** Verbindung passend zu den Einstellungen; den Pult-Simulator gibt es nur zum simulierten Mehrspur-Gerät. */
function configureMixer() {
  const simulate = settings.get('recordingMode') === 'multitrack' && Boolean(settings.get('multitrackSimulate'));
  return mixer.configure({ host: settings.get('mixerHost'), simulate }).then(onMixerChange, (err) => console.warn('Mischpult:', err.message));
}
multitrack.on('stall', ({ recording }) => {
  monitorState = { ...monitorState, stalled: true };
  sendMultitrack();
  if (!recording) return;                     // beim Abhören nur anzeigen, keine Meldung
  health.inputLost = true;
  publishHealth();
  toast('error', 'Mehrspur: Das Mischpult liefert keine Daten mehr – das Gerät wird neu geöffnet.');
});
multitrack.on('gap', ({ at, seconds, recording }) => {
  monitorState = { ...monitorState, stalled: false };
  sendMultitrack();
  if (!recording) return;
  health.inputLost = false;
  publishHealth();
  toast('warn', `Mehrspur: Eingang wieder da. Bei ${fmtClock(at)} fehlen etwa ${seconds.toFixed(1)} s in der Aufnahme.`);
});
multitrack.on('reopen', ({ ok: reopened, error }) => {
  // Nur den ersten Fehlschlag protokollieren (sonst alle 3 s dieselbe Zeile, solange das Gerät fehlt).
  if (reopened) reopenFailLogged = false;
  else if (!reopenFailLogged) {
    reopenFailLogged = true;
    console.warn('Mehrspur: Gerät neu öffnen fehlgeschlagen (weitere Versuche ohne Protokoll):', error);
  }
});
multitrack.on('device-error', ({ message }) => toast('error', `Mehrspur: ${message}`));
multitrack.on('playback', (p) => {
  send('multitrack-play', p);
  // Zu Ende gespielt: im Stereo-Modus braucht niemand mehr das Gerät.
  if (!p.playing && settings.get('recordingMode') !== 'multitrack') updateMonitor();
});
multitrack.on('device-warning', ({ message }) => console.warn('Mehrspur:', message));
multitrack.on('exit', ({ code, wasRecording }) => {
  console.error('Mehrspur-Prozess beendet, Code', code);
  // Abhören wieder aufnehmen (startet den Prozess neu) – aber nicht endlos, falls er beim Öffnen immer wieder abstürzt.
  const now = Date.now();
  multitrackExits = multitrackExits.filter((t) => now - t < 60000).concat(now);
  const giveUp = multitrackExits.length > 3;
  monitorState = {
    active: false, info: null, stalled: false,
    error: giveUp ? 'Der Mehrspur-Prozess stürzt wiederholt ab (Treiber?). Ebbton neu starten.' : 'Mehrspur-Prozess beendet'
  };
  sendMultitrack();
  if (giveUp) toast('error', 'Der Mehrspur-Prozess stürzt wiederholt ab – Mehrspur ist bis zum Neustart von Ebbton aus.');
  else setTimeout(updateMonitor, 2000);
  if (wasRecording && session.mode === 'multitrack' && isBusy()) recoverMultitrack();
});

/* Absturz während der Aufnahme: Der Mehrspur-Prozess wird neu gestartet und hängt an dieselben Spuren an; die
   Aufnahme (Abschnitte, Pause, Session-Datei) läuft in Ebbton einfach weiter. Es fehlt nur die Zeit dazwischen. */
const MT_RECOVER_DELAYS = [1000, 2000, 3000, 3000, 5000, 5000, 5000, 5000, 10000, 10000];   // etwa 50 s
let mtRecovering = false;

function crashLooping() {
  const now = Date.now();
  return multitrackExits.filter((t) => now - t < 60000).length > 3;
}

async function recoverMultitrack() {
  if (session.writer?.abandon) session.writer.abandon();   // der alte Stellvertreter hat keinen Prozess mehr
  if (mtRecovering) return;                                // ein laufender Versuch macht weiter
  mtRecovering = true;
  const lostAt = session.duration;
  const lostSince = Date.now();
  health.inputLost = true;
  publishHealth();
  try {
    if (!crashLooping()) {
      toast('error', 'Der Mehrspur-Prozess ist abgestürzt – er wird neu gestartet, die Aufnahme geht in denselben Spuren weiter.');
    }
    for (const delay of MT_RECOVER_DELAYS) {
      if (crashLooping()) break;
      await new Promise((r) => setTimeout(r, delay));
      if (session.mode !== 'multitrack' || !isBusy()) return;   // inzwischen beendet
      let info;
      try {
        const { device, simulate } = await multitrackDevice();
        info = await multitrack.start({ simulate, deviceId: device.id, tracks: session.trackFiles(), sampleRate: session.sampleRate, append: true });
      } catch (err) {
        console.warn('Mehrspur: Neustart nach Absturz fehlgeschlagen:', err.message);
        continue;
      }
      if (!isBusy()) {                                         // während des Starts beendet
        await multitrack.stop().catch(() => {});
        return;
      }
      lastMultitrackRate = info.sampleRate;
      session.replaceWriter(multitrack.writer(info));
      monitorState = { active: true, info, error: null, stalled: false };
      sendMultitrack();
      health.inputLost = false;
      publishHealth();
      const seconds = (Date.now() - lostSince) / 1000;
      toast('warn', `Mehrspur läuft wieder. Bei ${fmtClock(lostAt)} fehlen etwa ${Math.round(seconds)} s in der Aufnahme.`);
      return;
    }
    toast('error', 'Der Mehrspur-Prozess ließ sich nicht wieder starten. Die Aufnahme wurde beendet; die Spuren bis zum Absturz sind gespeichert.');
    if (session.mode === 'multitrack' && isBusy()) session.stop();
  } finally {
    mtRecovering = false;
  }
}

/** Sekunden als m:ss. */
function fmtClock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

function currentHealth() {
  const input = health.inputLost || health.chunksStale ? 'lost' : (health.silent ? 'silent' : 'ok');
  const routing = health.routing || null;
  const write = health.writeError ? 'error' : (health.writeSlow ? 'slow' : 'ok');
  const d = health.disk;
  const diskLevel = !d ? 'ok' : (d.hoursLeft < 0.5 ? 'low' : (d.hoursLeft < 3 ? 'warn' : 'ok'));
  return {
    input,
    write,
    writeMessage: health.writeError || null,
    routing,
    deficit: health.deficit || null,
    disk: d ? { freeBytes: d.freeBytes, hoursLeft: d.hoursLeft, level: diskLevel } : null
  };
}

/** Meldet geänderte Gesundheitswerte an Oberfläche und Netzwerk. */
let lastHealthJson = '';
function publishHealth() {
  const h = currentHealth();
  const json = JSON.stringify(h);
  if (json === lastHealthJson) return;
  lastHealthJson = json;
  send('health', h);
  net.publishState(netState());
  updateTaskbar();
}

/* Wächter im Hauptprozess: kommen während der Aufnahme keine Audioblöcke mehr an (Oberfläche hängt,
   wurde neu geladen, Erfassung steht), wird das als ausgefallener Eingang gemeldet – auch an Companion. */
let lastChunkAt = 0;
const CHUNK_TIMEOUT_MS = 5000;

/* Protokoll des Eingangs (`logs/eingang.log`, siehe inputlog.js). Pfad erst beim ersten Schreiben ermittelt. */
let inputLogFile = null;
try { inputLogFile = path.join(app.getPath('userData'), 'logs', 'eingang.log'); } catch { /* ohne Protokoll weiter */ }
const inputLog = createInputLog(inputLogFile);
const LOG_LEVELS = new Set(['info', 'warn', 'error']);
/** Ein Audioblock ist 100 ms lang; ab so viel Abstand zum vorigen (im Hauptprozess gemessen) gilt es als Lücke. */
const CHUNK_GAP_LOG_MS = 500;
let prevRecChunkAt = 0;   // letzter Block während `recording`; 0 = keiner (Start, Pause, Ende)
/** Ab so viel fehlender Zeit (ms) füllt der Hauptprozess nach einer Wiederverbindung mit Stille auf. */
const GAP_FILL_MIN_MS = 300;
let fillGapPending = false;   // gesetzt, solange der Wächter den Eingang neu verbindet (`health:input`)

/* Fehlbetrag der Stereo-Aufnahme gegen die Uhr (siehe deficit.js): leiser Verlust, den der Wächter nicht sieht.
   Protokoll je angefangene halbe Sekunde, ab DEFICIT_WARN_S Warnbalken (`health.deficit`). */
const DEFICIT_WARN_S = 2;
const deficit = new DeficitMeter();
let deficitStatus = null;     // Status bei der letzten Messung (erkennt Pause/Fortsetzen)
let deficitLogged = 0;        // zuletzt protokollierte Stufe (s)

setInterval(() => {
  const status = session.mode === 'multitrack' ? null : session.status;   // Mehrspur misst selbst ('gap')
  if (status === 'recording' && deficitStatus !== 'recording') deficit.resume(session.duration);
  if (status !== 'recording' && deficitStatus === 'recording') deficit.pause();
  deficitStatus = status;
  if (status !== 'recording') return;
  const { deficit: missing, elapsed } = deficit.sample(Date.now(), session.duration);
  const step = Math.floor(missing * 2) / 2;
  if (step >= 0.5 && step > deficitLogged) {
    deficitLogged = step;
    inputLog.write('warn', 'fehlbetrag', { sekunden: Math.round(missing * 10) / 10, seitMinuten: Math.round(elapsed / 6) / 10,
      prozent: elapsed > 0 ? Math.round((missing / elapsed) * 1000) / 10 : null });
  }
  // Als bleibender Warnbalken (über `health`), nicht als Meldung: Die verschwände nach 15 s, und gerade wenn Ebbton im
  // Hintergrund ist, sähe sie niemand. In halben Sekunden, damit sich `health` nicht jede Sekunde ändert.
  if (missing >= DEFICIT_WARN_S) {
    const shown = Math.floor(missing * 2) / 2;
    if (health.deficit !== shown) { health.deficit = shown; publishHealth(); }
  }
}, 1000);

setInterval(() => {
  // Mehrspur: Die Blöcke kommen nicht über die Oberfläche, der Mehrspur-Prozess wacht selbst ('stall').
  const stale = session.status === 'recording' && session.mode !== 'multitrack' && Date.now() - lastChunkAt > CHUNK_TIMEOUT_MS;
  if (stale !== Boolean(health.chunksStale)) {
    health.chunksStale = stale;
    inputLog.write(stale ? 'warn' : 'info', stale ? 'hauptprozess-keine-bloecke' : 'hauptprozess-bloecke-wieder-da',
      { seitSekunden: lastChunkAt ? Math.round((Date.now() - lastChunkAt) / 100) / 10 : null });
    publishHealth();
  }
}, 1000);

// Zeitgeber des Hauptprozesses: bleibt der Takt aus, hing der Hauptprozess selbst (nicht Gerät oder Oberfläche).
let lastMainTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const lag = now - lastMainTick - 1000;
  lastMainTick = now;
  if (lag > 1000 && session.status === 'recording') inputLog.write('warn', 'hauptprozess-haengt', { verzugMs: lag });
}, 1000);

// Ruhezustand, Sperrbildschirm: erklären Aussetzer, die sonst rätselhaft bleiben.
function logPowerEvents() {
  try {
    const { powerMonitor } = require('electron');
    for (const name of ['suspend', 'resume', 'lock-screen', 'unlock-screen', 'on-battery', 'on-ac']) {
      powerMonitor.on(name, () => inputLog.write('info', `energie-${name}`, { status: session.status }));
    }
  } catch { /* nur Hilfe */ }
}

// Während der Aufnahme regelmäßig den vollständigen Zustand senden (Dauer, offene Abschnitte, Export-Liste),
// auch wenn gerade niemand etwas ändert.
setInterval(() => {
  if (session.status === 'recording') pushState(session.snapshot());
}, 5000);

function refreshDisk() {
  try { health.disk = diskInfo(); } catch { health.disk = null; }
  publishHealth();
}

function stateThrottle() {
  let pending = null;
  let timer = null;
  return (state) => {
    pending = state;
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const s = pending;
      pending = null;
      send('state', s);
      net.publishState(netState(s));
    }, 100);
  };
}
const pushState = stateThrottle();

function buildFileName(segmentLabel, artist, pattern = settings.get('fileNamePattern')) {
  pattern = pattern || '{interpret}_{abschnitt}_{gottesdienst}_{datum}';
  const name = pattern
    .replace(/\{datum\}/g, session.service.date || dateStamp())
    .replace(/\{gottesdienst\}/g, slug(session.service.name, 'Gottesdienst'))
    .replace(/\{abschnitt\}/g, slug(segmentLabel, 'Abschnitt'))
    .replace(/\{interpret\}/g, artist ? slug(artist, '') : '')
    .replace(/\{zeit\}/g, recordingTime());
  // Ein leerer Platzhalter (z. B. ohne Interpret) soll keine doppelten oder führenden Trennzeichen hinterlassen.
  // Zu lange Namen kürzen: Viele Dateisysteme erlauben höchstens 255 Zeichen.
  const base = slug(name).replace(/-+/g, '-').replace(/_+/g, '_').replace(/^[_-]+|[_-]+$/g, '');
  return base.slice(0, 150).replace(/[_-]+$/g, '') + '.mp3';
}

/** Uhrzeit des Aufnahmebeginns als HHMM (für den Platzhalter {zeit}). */
function recordingTime() {
  const d = session.startedAt ? new Date(session.startedAt) : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Fragt nach, wenn beim Schließen oder Beenden noch aufgenommen wird.
 * @returns {boolean} true, wenn fortgefahren werden darf
 */
let allowClose = false;      // nach bestätigtem Beenden nicht erneut fragen
let closePending = false;

function isBusy() {
  return session.status === 'recording' || session.status === 'paused';
}

/**
 * Fragt – ohne den Hauptprozess zu blockieren –, ob eine laufende Aufnahme beendet werden soll,
 * beendet sie dann und wartet, bis der Schreib-Thread alles auf der Platte hat.
 * @returns {Promise<boolean>} true, wenn geschlossen werden darf
 */
async function confirmAndFinishRecording() {
  if (isBusy()) {
    const parent = win && !win.isDestroyed() ? win : undefined;
    const { response } = await dialog.showMessageBox(parent, {
      type: 'warning',
      buttons: ['Weiter aufnehmen', 'Aufnahme beenden und schließen'],
      defaultId: 0,
      cancelId: 0,
      title: 'Aufnahme läuft',
      message: 'Es läuft noch eine Aufnahme.',
      detail: 'Beim Schließen wird die Aufnahme gestoppt und gespeichert.'
    });
    if (response === 0) return false;
    if (isBusy()) session.stop();
  }
  await session.whenWritten();
  session.flushSave();
  return true;
}

/** Gemeinsamer Ablauf für Fenster schließen und App beenden. */
function guardClose(e, finish) {
  if (allowClose) return false;
  if (!isBusy() && !session.writing) return false;
  e.preventDefault();
  if (closePending) return true;
  closePending = true;
  confirmAndFinishRecording().then((go) => {
    closePending = false;
    if (go) {
      allowClose = true;
      finish();
    }
  });
  return true;
}

/**
 * Unter Windows und Linux stört die Menüleiste nur. Unter macOS liegt sie
 * oben am Bildschirm und trägt die Standardkürzel (Cmd+Q, Cmd+C, …), die
 * ohne Menü nicht funktionieren würden.
 */
function setupApplicationMenu() {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null);
    return;
  }

  const template = [
    {
      label: app.getName(),
      submenu: [
        { role: 'about', label: `Über ${app.getName()}` },
        { type: 'separator' },
        {
          label: 'Einstellungen …',
          accelerator: 'Cmd+,',
          click: () => send('menu', { action: 'settings' })
        },
        { type: 'separator' },
        { role: 'hide', label: 'Ausblenden' },
        { role: 'hideOthers', label: 'Andere ausblenden' },
        { role: 'unhide', label: 'Alle einblenden' },
        { type: 'separator' },
        { role: 'quit', label: 'Beenden' }
      ]
    },
    {
      label: 'Aufnahme',
      submenu: [
        {
          label: 'Aufnahme starten / beenden',
          accelerator: 'Cmd+R',
          click: () => send('menu', { action: 'toggle-record' })
        },
        {
          label: 'Abschnitt starten / beenden',
          accelerator: 'Cmd+M',
          click: () => send('menu', { action: 'marker' })
        },
        {
          label: 'Nächster Ablaufpunkt',
          accelerator: 'Cmd+Alt+N',
          click: () => send('menu', { action: 'next-item' })
        },
        { type: 'separator' },
        {
          label: 'Ordner mit Aufnahmen öffnen',
          click: () => shell.openPath(settings.get('recordingsDir'))
        }
      ]
    },
    {
      label: 'Bearbeiten',
      submenu: [
        // Eigene Einträge: in Textfeldern wirkt das Rückgängig dort, sonst auf Abschnitte und Schnitte.
        { label: 'Widerrufen', accelerator: 'Cmd+Z', click: () => send('menu', { action: 'undo' }) },
        { label: 'Wiederholen', accelerator: 'Shift+Cmd+Z', click: () => send('menu', { action: 'redo' }) },
        { type: 'separator' },
        { role: 'cut', label: 'Ausschneiden' },
        { role: 'copy', label: 'Kopieren' },
        { role: 'paste', label: 'Einsetzen' },
        { role: 'selectAll', label: 'Alles auswählen' }
      ]
    },
    {
      label: 'Fenster',
      submenu: [
        // Ohne Tastenkürzel: Cmd+M gehört "Abschnitt starten / beenden".
        { label: 'Minimieren', click: () => win?.minimize() },
        { label: 'Mini-Fenster ein/aus', accelerator: 'Cmd+Shift+M', click: () => setCompact(!compact) },
        { role: 'zoom', label: 'Zoomen' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild' }
        // Kein "Neu laden": Das beendete die Audioerfassung einer laufenden Aufnahme (und lag auf Cmd+R).
      ]
    }
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------- Kennzeichen in Taskleiste/Dock */

// Auch bei verdecktem Fenster soll man sehen, ob aufgenommen wird: Windows bekommt einen farbigen Punkt über dem
// Symbol in der Taskleiste, macOS ein Abzeichen am Dock-Symbol, beide einen Fenstertitel mit Zustand.
const TASKBAR_COLORS = { recording: [0xe5, 0x39, 0x35], paused: [0xff, 0xa7, 0x26], problem: [0xff, 0xd6, 0x00] };
const overlayIcons = {};

/** Runder Punkt (16 × 16, BGRA) mit dünnem dunklem Rand, ohne Bilddatei. */
function dotIcon(kind) {
  if (overlayIcons[kind]) return overlayIcons[kind];
  const size = 16;
  const [r, g, b] = TASKBAR_COLORS[kind];
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
      const alpha = Math.max(0, Math.min(1, size / 2 - d));            // weiche Kante
      const edge = d > size / 2 - 2;                                    // Rand für hellen und dunklen Hintergrund
      const i = (y * size + x) * 4;
      buf[i] = edge ? 0x20 : b;
      buf[i + 1] = edge ? 0x20 : g;
      buf[i + 2] = edge ? 0x20 : r;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  overlayIcons[kind] = nativeImage.createFromBitmap(buf, { width: size, height: size });
  return overlayIcons[kind];
}

let taskbarKey = null;
/** Zustand der Aufnahme an Taskleiste bzw. Dock und Fenstertitel (nur bei Änderung). */
function updateTaskbar() {
  if (!win || win.isDestroyed()) return;
  const h = currentHealth();
  const problem = isBusy() && (h.input === 'lost' || h.write === 'error');
  const kind = problem ? 'problem' : (session.status === 'recording' ? 'recording' : (session.status === 'paused' ? 'paused' : null));
  if (kind === taskbarKey) return;
  taskbarKey = kind;
  const label = { recording: 'Aufnahme läuft', paused: 'Aufnahme pausiert', problem: 'Aufnahme: Problem' }[kind];
  win.setTitle(label ? `● ${label} – Ebbton` : 'Ebbton');
  if (process.platform === 'win32') {
    win.setOverlayIcon(kind ? dotIcon(kind) : null, label || '');
  } else if (process.platform === 'darwin' && app.dock) {
    app.dock.setBadge({ recording: '●', paused: '❚❚', problem: '!' }[kind] || '');
  }
}

/* ------------------------------------------------------------------- Fenster */

// Nur im Dev-Modus: Renderer-Änderungen laden das Fenster neu, Änderungen an
// Main/Preload starten die App neu (nicht während einer laufenden Aufnahme).
function setupLiveReload() {
  const srcDir = path.join(__dirname, '..');
  let timer = null;
  fs.watch(srcDir, { recursive: true }, (_evt, filename) => {
    if (!filename) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      const inRenderer = filename.split(path.sep)[0] === 'renderer';
      const busy = session.status === 'recording' || session.status === 'paused';
      if (inRenderer && busy) {
        // Die Audioerfassung läuft in der Oberfläche: nie während einer Aufnahme neu laden.
        toast('warn', 'Oberfläche geändert – Neuladen nach der Aufnahme nötig.');
      } else if (inRenderer) {
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache();
      } else if (busy) {
        toast('warn', 'Main-Prozess geändert – Neustart nach der Aufnahme nötig.');
      } else {
        app.relaunch({ args: process.argv.slice(1) });
        app.exit(0);
      }
    }, 200);
  });
}

/* ------------------------------------------------------------- Mini-Fenster */

// Kleines Fenster mit den nötigsten Knöpfen, damit nebenher am PC gearbeitet werden kann. Es ist dasselbe
// Fenster, nur verkleinert (die Oberfläche blendet den Rest per CSS aus): Die Audioerfassung läuft in der
// Oberfläche und darf dafür nicht neu geladen werden.
const NORMAL_MIN = { width: 1024, height: 680 };
// Kompakte Ansicht (Einstellung denseLayout): alle Bereiche bleiben, nur kleiner – das große Fenster darf schmaler werden.
const DENSE_MIN = { width: 760, height: 520 };
const dense = () => settings.get('denseLayout') === true;
const normalMin = () => (dense() ? DENSE_MIN : NORMAL_MIN);
// Fenstergrößen (Inhaltsgröße) beim Umschalten, wenn noch keine Lage gespeichert ist
const LARGE_DEFAULT = { width: 1360, height: 880 };
const DENSE_DEFAULT = { width: 960, height: 640 };
// Größen des Mini-Fensters als Inhaltsgröße (ohne Titelleiste und Rahmen, die je System verschieden sind).
// 164 px Höhe genügen für alle Zeilen (gemessen: höchstens 158); erscheint der rote Warnbalken, scrollt der Inhalt.
const COMPACT_MIN = { width: 320, height: 164 };
const COMPACT_DEFAULT = { width: 360, height: 168 };
let compact = null;            // Lage des großen Fensters ({ bounds, maximized }), solange das Mini-Fenster aktiv ist

/** Platz für Titelleiste und Rahmen (Fenstergröße minus Inhaltsgröße). */
function frameSize() {
  const [w, h] = win.getSize();
  const [cw, ch] = win.getContentSize();
  return { width: w - cw, height: h - ch };
}

/** Liegt eine gespeicherte Fensterlage noch (sichtbar genug) auf einem der Bildschirme? */
function onScreen(b) {
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width - 60 && b.x + b.width > a.x + 60
    && b.y >= a.y - 10 && b.y < a.y + a.height - 60);
}

/** Fenster der Größe width×height um die Mitte des jetzigen Fensters, ganz im Arbeitsbereich dieses Bildschirms. */
function centeredBounds(width, height) {
  const cur = win.getBounds();
  const a = screen.getDisplayMatching(cur).workArea;
  const w = Math.min(width, a.width);
  const h = Math.min(height, a.height);
  const x = Math.round(cur.x + cur.width / 2 - w / 2);
  const y = Math.round(cur.y + cur.height / 2 - h / 2);
  return {
    x: Math.min(Math.max(x, a.x), a.x + a.width - w),
    y: Math.min(Math.max(y, a.y), a.y + a.height - h),
    width: w,
    height: h
  };
}

/** Zuletzt benutzte Lage des Mini-Fensters, wenn sie noch auf einem Bildschirm liegt; sonst unten rechts. */
function compactBounds() {
  const frame = frameSize();
  const minW = COMPACT_MIN.width + frame.width;
  const minH = COMPACT_MIN.height + frame.height;
  const defW = COMPACT_DEFAULT.width + frame.width;
  const defH = COMPACT_DEFAULT.height + frame.height;
  const saved = settings.get('compactBounds');
  if (onScreen(saved)) {
    return {
      x: saved.x,
      y: saved.y,
      width: Math.max(saved.width, minW),
      height: Math.max(saved.height, minH)
    };
  }
  const a = screen.getDisplayMatching(win.getBounds()).workArea;
  return {
    x: a.x + a.width - defW - 16,
    y: a.y + a.height - defH - 16,
    width: defW,
    height: defH
  };
}

const compactOnTop = () => settings.get('compactOnTop') !== false;

/** Umschalter „Groß | Kompakt | Mini“: Aus dem Mini-Fenster erst zurück (alte Größe), dann ggf. die Ansicht wechseln. */
function setView(view) {
  if (view === 'mini') {
    setCompact(true);
    return;
  }
  if (compact) setCompact(false);
  setDense(view === 'dense');
}

/**
 * Kompakte Ansicht ein/aus. Das Fenster wird dabei passend verkleinert (zuletzt benutzte Lage der kompakten
 * Ansicht, sonst DENSE_DEFAULT um die bisherige Mitte) und beim Ausschalten wieder auf die vorherige Größe gebracht.
 * Die Lagen stehen in den Einstellungen (denseBounds, largeBounds), damit das auch nach einem Neustart klappt.
 * Im Mini-Fenster wird nur die Einstellung gemerkt; dessen Rückweg stellt das große Fenster selbst wieder her.
 */
function setDense(on) {
  if (!win || win.isDestroyed()) return;
  if (on === dense()) return;
  if (compact) {
    settings.save({ denseLayout: on });
    return;
  }
  if (win.isFullScreen()) {
    // Im Vollbild lässt sich die Größe nicht ändern: erst verlassen, dann umschalten.
    win.once('leave-full-screen', () => setDense(on));
    win.setFullScreen(false);
    return;
  }
  const frame = frameSize();
  if (on) {
    settings.save({ denseLayout: true, largeBounds: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
    if (win.isMaximized()) win.unmaximize();
    win.setMinimumSize(DENSE_MIN.width, DENSE_MIN.height);
    const saved = settings.get('denseBounds');
    win.setBounds(onScreen(saved)
      ? { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      : centeredBounds(DENSE_DEFAULT.width + frame.width, DENSE_DEFAULT.height + frame.height));
  } else {
    const maximized = win.isMaximized();
    settings.save({ denseLayout: false, ...(maximized ? {} : { denseBounds: win.getBounds() }) });
    if (maximized) win.unmaximize();
    win.setMinimumSize(NORMAL_MIN.width, NORMAL_MIN.height);
    const prev = settings.get('largeBounds');
    if (onScreen(prev)) {
      win.setBounds({ x: prev.x, y: prev.y, width: prev.width, height: prev.height });
      if (prev.maximized) win.maximize();
    } else {
      win.setBounds(centeredBounds(LARGE_DEFAULT.width + frame.width, LARGE_DEFAULT.height + frame.height));
    }
  }
}

/** Das Mini-Fenster bleibt (abschaltbar) über anderen Programmen, das große nie. */
function applyOnTop() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(Boolean(compact) && compactOnTop(), 'floating');
}

/** Schaltet zwischen großem Fenster und Mini-Fenster um; die Oberfläche erfährt es über 'compact'. */
function setCompact(on) {
  if (!win || win.isDestroyed()) return false;
  if (on && !compact) {
    if (win.isFullScreen()) {
      // Im Vollbild lässt sich die Größe nicht ändern: erst verlassen, dann verkleinern.
      win.once('leave-full-screen', () => setCompact(true));
      win.setFullScreen(false);
      return false;
    }
    compact = { bounds: win.getNormalBounds(), maximized: win.isMaximized() };
    if (compact.maximized) win.unmaximize();
    const frame = frameSize();
    win.setMinimumSize(COMPACT_MIN.width + frame.width, COMPACT_MIN.height + frame.height);
    win.setBounds(compactBounds());
  } else if (!on && compact) {
    settings.save({ compactBounds: win.getBounds() });
    const prev = compact;
    compact = null;
    const min = normalMin();
    win.setMinimumSize(min.width, min.height);
    win.setBounds(prev.bounds);
    if (prev.maximized) win.maximize();
  }
  applyOnTop();
  send('compact', { on: Boolean(compact), onTop: compactOnTop() });
  return Boolean(compact);
}

function createWindow() {
  // Kompakte Ansicht: in deren zuletzt benutzter Größe starten (sonst DENSE_DEFAULT)
  const denseStart = dense() ? settings.get('denseBounds') : null;
  win = new BrowserWindow({
    ...(onScreen(denseStart) ? denseStart : {}),
    width: onScreen(denseStart) ? denseStart.width : (dense() ? DENSE_DEFAULT.width : LARGE_DEFAULT.width),
    height: onScreen(denseStart) ? denseStart.height : (dense() ? DENSE_DEFAULT.height : LARGE_DEFAULT.height),
    minWidth: normalMin().width,
    minHeight: normalMin().height,
    backgroundColor: '#101419',
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    title: 'Ebbton',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false   // Audioerfassung läuft hier, siehe Schalter oben
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  // Den Titel setzt der Hauptprozess (Aufnahmezustand, siehe updateTaskbar), nicht das <title> der Oberfläche.
  win.on('page-title-updated', (e) => e.preventDefault());
  taskbarKey = undefined;
  updateTaskbar();
  if (isDev) {
    // Die DevTools stören bei jedem Neustart (sie holen sich den Fokus). Daher nur
    // auf Wunsch: per F12 / Strg+Umschalt+I, oder dauerhaft mit "npm run dev:tools".
    if (process.argv.includes('--devtools')) win.webContents.openDevTools({ mode: 'detach', activate: false });
    win.webContents.on('before-input-event', (event, input) => {
      const toggle = input.type === 'keyDown' && (input.key === 'F12'
        || (input.key.toLowerCase() === 'i' && input.shift && (input.control || input.meta)));
      if (toggle) {
        event.preventDefault();
        win.webContents.toggleDevTools();
      }
    });
    setupLiveReload();
  }

  // Mikrofon-/Eingangszugriff im Renderer erlauben.
  win.webContents.session.setPermissionRequestHandler((wc, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });

  win.on('close', (e) => {
    if (guardClose(e, () => { if (win && !win.isDestroyed()) win.close(); })) return;
    if (compact) settings.save({ compactBounds: win.getBounds() });
    else if (dense() && !win.isMaximized() && !win.isFullScreen()) settings.save({ denseBounds: win.getBounds() });
    session.flushSave();
    net.stop();
  });

  // Stürzt die Oberfläche ab, fehlt die Audioerfassung: neu laden – sie verbindet sich bei laufender
  // Aufnahme selbst wieder mit dem Eingang und schreibt in dieselbe Datei weiter.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('Oberfläche beendet:', details.reason);
    inputLog.write('error', 'oberflaeche-beendet', { grund: details.reason, exitCode: details.exitCode, status: session.status });
    if (details.reason === 'clean-exit') return;
    setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.reload(); }, 500);
  });

  // Windows: Oberfläche (Audioerfassung) von der Timer-Regel für Hintergrundfenster ausnehmen, siehe timerres.js.
  // Nach jedem Laden prüfen, ob der Renderer-Prozess neu ist (Absturz, Neuladen) – die Ausnahme gilt je Prozess.
  win.webContents.on('did-finish-load', () => {
    if (process.platform !== 'win32' || !win || win.isDestroyed()) return;
    const pid = win.webContents.getOSProcessId();
    if (!pid || pid === timerExemptPid) return;
    timerExemptPid = pid;
    exemptFromTimerThrottling(pid, { cacheDir: path.join(app.getPath('userData'), 'cache') }).then((r) => {
      inputLog.write(r.ok ? 'info' : 'error', r.ok ? 'timer-regel-ausgenommen' : 'timer-regel-fehlgeschlagen', { pid, ergebnis: r.detail, dauerMs: r.ms });
      if (!r.ok) {
        timerExemptPid = 0;   // beim nächsten Laden erneut versuchen
        toast('warn', 'Ebbton konnte sich nicht vor der Windows-Drosselung schützen: Während der Aufnahme das Fenster sichtbar lassen (z. B. Mini-Fenster „immer oben“).');
      }
    });
  });

  win.on('closed', () => { win = null; });
}

/* ------------------------------------------------------------- Verdrahtungen */

session.on('state', (s) => {
  pushState(s);
  updateTaskbar();
});

session.on('levels', (levels) => {
  send('levels', levels);
  // Netzwerk: nur der Gesamtpegel (die Pegel aller Mehrspur-Kanäle und die Wellenform braucht dort niemand).
  // Lautheit: nur die Anzeigewerte, nicht die einzelnen 100-ms-Messwerte der Kurve.
  const { tracks, buckets, loudness, ...overall } = levels;
  if (loudness) {
    const { steps, ...values } = loudness;
    overall.loudness = values;
  }
  net.publishLevels(overall);

  // Stille: lange fast kein Pegel, obwohl aufgenommen wird (z. B. Mischpult stumm).
  const quiet = Math.max(levels.l, levels.r) < SILENT_LEVEL;
  if (!quiet) silentSince = null;
  else if (silentSince == null) silentSince = Date.now();
  const silent = quiet && silentSince != null && Date.now() - silentSince > SILENT_AFTER_MS;
  if (silent !== health.silent) {
    health.silent = silent;
    publishHealth();
  }
});

// Während der Aufnahme darf der Rechner nicht in den Ruhezustand: Beim Aufwachen
// liefert der Audioeingang sonst keine Daten mehr.
let sleepBlockerId = null;
function preventSleep(on) {
  if (on && sleepBlockerId == null) {
    sleepBlockerId = powerSaveBlocker.start('prevent-app-suspension');
  } else if (!on && sleepBlockerId != null) {
    powerSaveBlocker.stop(sleepBlockerId);
    sleepBlockerId = null;
  }
}

session.on('recording-started', () => {
  onMixerChange();                            // Aufnahmeart der laufenden Aufnahme gilt jetzt
  inputLog.write('info', 'aufnahme-gestartet', { version: app.getVersion(), modus: session.mode, abtastrate: session.sampleRate });
  lastChunkAt = Date.now();                   // sonst gilt der Eingang ab dem Start kurz als „keine Blöcke“
  deficit.reset();
  deficit.resume(session.duration);           // auch beim Anhängen: gemessen wird ab hier
  deficitStatus = 'recording';
  deficitLogged = 0;
  health.deficit = null;
  preventSleep(true);
  silentSince = null;
  health.silent = false;
  health.writeError = null;
  health.writeSlow = false;
  refreshDisk();
  net.publishEvent('recording.started', { wavPath: session.wavPath });
  send('update-status', updater.status());   // Download/Installation sperren
});

session.on('recording-stopped', (info) => {
  onMixerChange();
  // Gesamter Fehlbetrag gegen die Uhr (Stereo) – auch ohne Warnung aufschlussreich (Uhrendrift, kleine Verluste).
  inputLog.write('info', 'aufnahme-beendet', session.mode === 'multitrack' ? {} : {
    fehlbetragSekunden: Math.round(deficit.last * 100) / 100,
    gemessenMinuten: Math.round(deficit.lastElapsed / 6) / 10
  });
  // Der Balken verschwindet mit dem Ende der Aufnahme; damit es nicht untergeht, einmal als Warnung nennen.
  if (health.deficit) {
    toast('warn', `Dieser Aufnahme fehlen gegenüber der Uhr etwa ${String(Math.round(deficit.last * 10) / 10).replace('.', ',')} s (leise verlorenes Audio). Details in logs/eingang.log.`);
    health.deficit = null;
  }
  session.whenWritten().then(updateMonitor);  // Aufnahmeart könnte inzwischen umgestellt sein
  preventSleep(false);
  silentSince = null;
  health.silent = false;
  health.inputLost = false;
  refreshDisk();
  net.publishEvent('recording.stopped', info);
  send('update-status', updater.status());   // Download/Installation wieder möglich
});

session.on('error-notice', (message) => toast('error', message));
session.on('loudness', (data) => send('loudness', data));   // nachgemessene Lautheit einer geladenen Aufnahme

// Schreib-Thread: Platte voll, Laufwerk entfernt, zu langsam … – sofort sichtbar machen, auch für Companion.
session.on('write-error', (err) => {
  health.writeError = `${err.code ? err.code + ': ' : ''}${err.message}`;
  toast('error', `Audio kann nicht gespeichert werden (${err.code || err.message}). Bitte Laufwerk prüfen!`);
  publishHealth();
});
session.on('write-slow', (slow) => {
  health.writeSlow = slow;
  if (slow) toast('warn', 'Das Laufwerk kommt mit dem Schreiben nicht hinterher – die Aufnahme wird im Speicher gepuffert.');
  publishHealth();
});

net.on('status', (info) => send('network-status', info));
net.on('error-notice', (message) => toast('error', message));

/* Rückmeldung für Fernbefehle: Start und Stopp laufen über die Oberfläche (dort ist die Audioerfassung).
   Die Antwort kommt erst, wenn die Aufnahme wirklich läuft bzw. beendet ist – oder mit Fehler. */
const remoteWaiters = new Map();
function waitForRemote(kind, eventName, ms = 8000) {
  return new Promise((resolve) => {
    const finish = (result) => {
      clearTimeout(timer);
      session.off(eventName, onEvent);
      remoteWaiters.delete(kind);
      resolve(result);
    };
    const onEvent = () => finish({ ok: true });
    const timer = setTimeout(() => finish({ ok: false, error: 'Keine Rückmeldung von der Aufnahme – bitte am Aufnahmerechner prüfen.' }), ms);
    session.once(eventName, onEvent);
    remoteWaiters.set(kind, finish);
  });
}
ipcMain.on('remote:result', (_e, { kind, ok: success, error } = {}) => {
  const finish = remoteWaiters.get(kind);
  if (finish && !success) finish({ ok: false, error: error || 'Die Aufnahme konnte nicht gestartet werden.' });
});

net.on('command', ({ action, params, reply }) => {
  const done = (result) => {
    reply(result);
    net.publishState(netState());
  };
  switch (action) {
    case 'record.start':
      // Die Audioaufnahme selbst läuft im Renderer. Per Fernsteuerung ohne Rückfrage am PC starten:
      // eine angezeigte, beendete Aufnahme ist ohnehin als Datei gespeichert.
      if (session.status === 'recording') return done({ ok: false, error: 'Es läuft bereits eine Aufnahme.' });
      if (session.status === 'paused') return done(session.resume());
      waitForRemote('start', 'recording-started').then(done);
      send('command', { action: 'record.start', remote: true });
      return;
    case 'record.stop':
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      waitForRemote('stop', 'recording-stopped').then(done);
      send('command', { action: 'record.stop', remote: true });
      return;
    case 'record.pause':
      return done(session.pause());
    case 'record.resume':
      return done(session.resume());
    case 'record.toggle':
      // Auch eine pausierte Aufnahme wird beendet ("starten bzw. beenden").
      if (session.status === 'recording' || session.status === 'paused') {
        waitForRemote('stop', 'recording-stopped').then(done);
        send('command', { action: 'record.stop', remote: true });
        return;
      }
      waitForRemote('start', 'recording-started').then(done);
      send('command', { action: 'record.start', remote: true });
      return;
    case 'marker.add': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      // Abschnitt beginnen bzw. – wenn einer läuft – beenden.
      return done(session.toggleSection({ label: params.label, category: params.category }));
    }
    case 'marker.next': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      return done(session.startNextPending());
    }
    case 'cut.toggle': {
      if (session.status !== 'recording' && session.status !== 'paused') {
        return done({ ok: false, error: 'Es läuft keine Aufnahme.' });
      }
      return done(session.toggleCut());
    }
    case 'undo':
      return done(session.undo());
    case 'redo':
      return done(session.redo());
    case 'mode.set':
      return done(setRecordingMode(params.mode));
    case 'template.apply': {
      const tpl = findTemplate(params.name || params.id);
      if (!tpl) return done({ ok: false, error: 'Vorlage nicht gefunden.' });
      session.setAgenda(templateItems(tpl), 'plan', tpl.name);
      return done({ ok: true, template: tpl.name });
    }
    default:
      return done({ ok: false, error: 'Unbekannter Befehl.' });
  }
});

updater.on('status', (s) => send('update-status', s));

/* ------------------------------------------------------------------- IPC-API */

function ok(data) { return { ok: true, ...(data || {}) }; }
function fail(error) { return { ok: false, error: String(error?.message || error) }; }

ipcMain.handle('app:info', () => ok({
  version: app.getVersion(),
  name: app.getName(),
  platform: process.platform,
  recordingsDir: settings.get('recordingsDir'),
  update: updater.status(),
  network: net.statusInfo(),
  compact: Boolean(compact),
  compactOnTop: compactOnTop(),
  dense: dense()
}));

ipcMain.handle('window:compact', (_e, { on, onTop, view } = {}) => {
  if (['large', 'dense', 'mini'].includes(view)) setView(view);
  if (typeof onTop === 'boolean') {
    settings.save({ compactOnTop: onTop });
    applyOnTop();
  }
  if (typeof on === 'boolean') setCompact(on);
  return ok({ on: Boolean(compact), onTop: compactOnTop(), dense: dense() });
});

/** Freier Platz auf dem Laufwerk der Aufnahmen und was das in Aufnahmestunden bedeutet. */
ipcMain.handle('disk:free', () => {
  try { return ok(diskInfo()); } catch (err) { return fail(err); }
});

ipcMain.handle('settings:get', () => ok({ settings: settings.forRenderer() }));

ipcMain.handle('settings:set', (_e, patch) => {
  try {
    const clean = { ...patch };
    if (Object.prototype.hasOwnProperty.call(clean, 'churchToolsToken')) {
      clean.churchToolsToken = clean.churchToolsToken
        ? settings.encryptSecret(clean.churchToolsToken)
        : '';
    }
    // Nur bei tatsächlich geänderten Werten neu starten – sonst fliegen Companion und Dashboards bei
    // jedem Speichern kurz raus, auch mitten in der Aufnahme.
    const networkKeys = ['networkEnabled', 'networkPort', 'networkPassword', 'monitorPassword'];
    const networkChanged = networkKeys.some((k) => k in clean && clean[k] !== settings.get(k));
    if (('churchToolsUrl' in clean && clean.churchToolsUrl !== settings.get('churchToolsUrl')) || 'churchToolsToken' in clean) {
      churchtools.resetCache();
    }
    settings.save(clean);
    if (clean.recordingsDir) fs.mkdirSync(clean.recordingsDir, { recursive: true });
    if (['mixerHost', 'recordingMode', 'multitrackSimulate'].some((k) => k in clean)) configureMixer();
    if ('recordingMode' in clean) net.publishState(netState());
    if (['recordingMode', 'multitrackDevice', 'multitrackSimulate', 'multitrackArmed'].some((k) => k in clean)) {
      updateMonitor();
      refreshDisk();
    }
    if (networkChanged) {
      const result = settings.get('networkEnabled') ? net.restart() : (net.stop(), { ok: true });
      if (!result.ok) toast('warn', result.error);
      send('network-status', net.statusInfo());
    }
    return ok({ settings: settings.forRenderer() });
  } catch (err) {
    return fail(err);
  }
});

ipcMain.handle('settings:chooseFolder', async (_e, { title, defaultPath } = {}) => {
  // Nur auswählen – gespeichert wird erst mit "Einstellungen speichern" (der Dialog dient für mehrere Ordner).
  // Startordner immer setzen: Ohne defaultPath öffnet Electron (ab 43) den Downloads-Ordner.
  const res = await dialog.showOpenDialog(win, {
    title: title || 'Ordner wählen',
    defaultPath: defaultPath && fs.existsSync(defaultPath) ? defaultPath : app.getPath('documents'),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
  return ok({ path: res.filePaths[0] });
});

ipcMain.handle('settings:chooseFile', async (_e, { title, filters }) => {
  const res = await dialog.showOpenDialog(win, { title, filters, properties: ['openFile'] });
  if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
  return ok({ path: res.filePaths[0] });
});

/* --- ChurchTools --- */

ipcMain.handle('ct:test', async () => {
  try { return ok(await churchtools.test()); } catch (err) { return fail(err); }
});

// Fehlersuche: Rohantworten zum Termin der angezeigten Aufnahme nach userData/logs schreiben und im Ordner zeigen.
ipcMain.handle('ct:dump', async () => {
  const eventId = session.service?.id;
  if (!eventId) return fail('Erst einen Gottesdienst aus ChurchTools wählen.');
  try {
    const dump = await churchtools.rawDump(eventId);
    const now = new Date();
    const stamp = `${churchtools.isoDate(now)}_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    const file = path.join(app.getPath('userData'), 'logs', `churchtools-${eventId}-${stamp}.json`);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, JSON.stringify(dump, null, 2), 'utf8');
    shell.showItemInFolder(file);
    return ok({ path: file, failed: dump.anfragen.filter((a) => a.fehler).length });
  } catch (err) { return fail(err); }
});

ipcMain.handle('ct:calendars', async () => {
  try { return ok({ calendars: await churchtools.listCalendars() }); } catch (err) { return fail(err); }
});

ipcMain.handle('ct:services', async (_e, { from, to } = {}) => {
  try {
    const today = churchtools.isoDate(new Date());
    return ok({ services: await churchtools.listServices(from || today, to || from || today) });
  } catch (err) { return fail(err); }
});

/* --- Vorlagen für Programmpunkte --- */

function templates() {
  const list = settings.get('agendaTemplates');
  return Array.isArray(list) ? list : [];
}

/** Vorlage nach Id oder Name; ohne Angabe die Standardvorlage. */
function findTemplate(key) {
  const list = templates();
  if (key) {
    const k = String(key).trim().toLowerCase();
    return list.find((t) => t.id === key) || list.find((t) => String(t.name).trim().toLowerCase() === k) || null;
  }
  return list.find((t) => t.id === settings.get('defaultTemplateId')) || list[0] || null;
}

/** Vorlage zum Titel eines Gottesdienstes (siehe `RoleLogic.templateForTitle`), sonst die Standardvorlage. */
function templateForTitle(title) {
  return RoleLogic.templateForTitle(templates(), title) || findTemplate();
}

/** Programmpunkte einer Vorlage (leere Einträge entfallen). */
function templateItems(tpl) {
  return (tpl && Array.isArray(tpl.items) ? tpl.items : [])
    .map((t) => String(t || '').trim())
    .filter(Boolean)
    .map((title) => ({ id: null, title }));
}

ipcMain.handle('agenda:applyTemplate', (_e, { templateId } = {}) => {
  const tpl = findTemplate(templateId);
  if (!tpl) return fail('Vorlage nicht gefunden.');
  const items = templateItems(tpl);
  session.setAgenda(items, 'plan', tpl.name);
  return ok({ count: items.length, name: tpl.name });
});

ipcMain.handle('ct:agenda', async (_e, { eventId, name, date } = {}) => {
  try {
    let plan;
    try {
      plan = await churchtools.agenda(eventId);
    } catch (err) {
      // Für den Termin ist kein Ablaufplan gepflegt (404): mit den Standardpunkten weiterarbeiten.
      if (err.status !== 404) throw err;
      plan = { name: null, items: [] };
    }

    // Personen aus der Dienstplanung (Leitung, Predigt …) als Interpret-Vorschläge; Fehler stören nicht.
    const wanted = String(settings.get('artistServices') || '').split(',').map((x) => x.trim()).filter(Boolean);
    // Dienste mit fester Zuordnung (z. B. „Geschichte“ → Kinderbeitrag, „Leitung“ → Einleitung/Abschluss) werden immer mitgelesen.
    Object.keys(RoleLogic.ALIASES).forEach((w) => {
      if (!wanted.some((x) => RoleLogic.words(x).includes(w))) wanted.push(w);
    });
    let suggestions = [];
    let info = null;
    let suggestionError = null;
    try {
      const es = await churchtools.eventServices(eventId, wanted);
      suggestions = es.suggestions;
      info = es.info;
    } catch (err) {
      suggestionError = String(err?.message || err);
    }
    session.setService({ id: eventId, name: name || plan.name || 'Gottesdienst', date, suggestions, info });
    const usedDefaults = plan.items.length === 0;
    // Ohne Ablaufplan: die Vorlage, die zum Titel passt (sonst die Standardvorlage).
    const tpl = usedDefaults ? templateForTitle(session.service.name) : null;
    const items = usedDefaults ? templateItems(tpl) : plan.items;
    const autoFilled = session.setAgenda(items, usedDefaults ? 'plan' : 'churchtools', tpl ? tpl.name : null);
    return ok({ items, count: items.length, usedDefaults, templateName: tpl ? tpl.name : null, info, suggestions, suggestionError, wanted, autoFilled });
  } catch (err) { return fail(err); }
});

/* --- Session / Aufnahme --- */

ipcMain.handle('session:service', (_e, service) => {
  session.setService(service);
  // Ohne ChurchTools gibt es keinen Ablaufplan: Standardpunkte anbieten, solange noch nichts da ist.
  if (session.sections.length === 0) {
    const tpl = templateForTitle(session.service.name);
    session.setAgenda(templateItems(tpl), 'plan', tpl.name);
  }
  return ok({ state: session.snapshot() });
});

ipcMain.handle('rec:start', async (_e, { sampleRate, channels } = {}) => {
  try {
    if (settings.get('recordingMode') === 'multitrack') return await startMultitrack();
    return session.start({ sampleRate, channels });
  } catch (err) { return fail(err); }
});
ipcMain.handle('rec:continue', async () => {
  try {
    await session.whenWritten();      // die Datei der eben beendeten Aufnahme erst fertig schreiben lassen
    if (session.mode === 'multitrack') return await continueMultitrack();
    return session.continueRecording();
  } catch (err) { return fail(err); }
});
ipcMain.handle('mixer:state', () => ok({ mixer: mixerState() }));
ipcMain.handle('mixer:discover', async () => {
  try { return ok({ found: await mixerDiscover() }); } catch (err) { return fail(err); }
});
/** Aktuelles Routing der Kartenausgänge als Stereo- bzw. Mehrspur-Routing merken. */
ipcMain.handle('mixer:learn', (_e, { mode } = {}) => {
  if (mode !== 'stereo' && mode !== 'multitrack') return fail('Unbekannte Aufnahmeart.');
  const st = mixer.state();
  if (st.status !== 'connected' || !st.routing) return fail('Das Routing des Mischpults ist nicht bekannt (nicht verbunden?).');
  const learned = { stereo: null, multitrack: null, ...(settings.get('mixerRouting') || {}), [mode]: st.routing };
  const other = mode === 'stereo' ? 'multitrack' : 'stereo';
  if (learned[other] && learned[other].every((v, i) => v === st.routing[i])) learned[other] = null;   // eindeutig halten
  settings.save({ mixerRouting: learned });
  onMixerChange();
  return ok({ mixer: mixerState() });
});
ipcMain.handle('mixer:forget', () => {
  settings.save({ mixerRouting: { stereo: null, multitrack: null } });
  onMixerChange();
  return ok({ mixer: mixerState() });
});
ipcMain.handle('mixer:simulateRouting', (_e, { kind } = {}) => (mixer.simulateRouting(kind) ? ok() : fail('Kein simuliertes Pult.')));
ipcMain.handle('multitrack:state', () => ok({ monitor: monitorState }));

/* Zurückspielen einer beendeten Mehrspuraufnahme über die Ausgänge (virtueller Soundcheck, Nachmischen). */
ipcMain.handle('multitrack:play', async (_e, { start = 0, loop = null } = {}) => {
  try {
    if (session.mode !== 'multitrack' || session.status !== 'stopped') return fail('Abspielen gibt es nur für eine beendete Mehrspuraufnahme.');
    await session.whenWritten();
    const files = session.trackFiles();
    const missing = files.filter((t) => !fs.existsSync(t.file));
    if (missing.length) return fail(`Spurdateien fehlen (${missing.length}).`);
    // Gerät mit der Abtastrate der Aufnahme öffnen (bleibt offen; im Stereo-Modus schließt es nach dem Abspielen wieder).
    const { device, simulate } = await multitrackDevice();
    const info = await multitrack.monitor({ simulate, deviceId: device.id, sampleRate: session.sampleRate });
    monitorState = { active: true, info, error: null, stalled: false };
    sendMultitrack();
    return ok({ play: await multitrack.play({ tracks: files, start, loop }) });
  } catch (err) { return fail(err); }
});
ipcMain.handle('multitrack:seek', async (_e, { seconds } = {}) => {
  try { return ok({ play: await multitrack.seek(seconds) }); } catch (err) { return fail(err); }
});
ipcMain.handle('multitrack:loop', async (_e, { loop } = {}) => {
  try { return ok({ play: await multitrack.setLoop(loop || null) }); } catch (err) { return fail(err); }
});
ipcMain.handle('multitrack:stopPlay', async () => {
  try {
    const play = await multitrack.stopPlayback();
    await updateMonitor();                    // im Stereo-Modus das Gerät wieder freigeben
    return ok({ play });
  } catch (err) { return fail(err); }
});
ipcMain.handle('multitrack:devices', async (_e, { simulate } = {}) => {
  try { return ok(await multitrack.devices({ simulate: Boolean(simulate) })); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:pause', () => {
  try { return session.pause(); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:resume', () => {
  try { return session.resume(); } catch (err) { return fail(err); }
});
ipcMain.handle('rec:stop', () => {
  try { return session.stop(); } catch (err) { return fail(err); }
});

ipcMain.handle('audio:read', (_e, { start, seconds } = {}) => {
  try {
    const slice = session.readAudio(start, seconds);
    if (!slice) return fail('Keine Aufnahme zum Anhören vorhanden.');
    return ok({
      sampleRate: slice.sampleRate,
      channels: slice.channels,
      buffer: slice.samples.buffer
    });
  } catch (err) { return fail(err); }
});

let lastWriteErrorToast = 0;
ipcMain.on('audio:chunk', (_e, arrayBuffer) => {
  const now = Date.now();
  // Nach einem Aussetzer (Wächter verbindet den Eingang neu): Die Lücke mit Stille füllen, sonst springt die Aufnahme
  // und alles dahinter liegt zu früh. Fehlend = Ankunft des Blocks − seine eigene Länge − Ende des vorigen Blocks.
  // Das Merkmal bleibt gesetzt, bis die Wiederverbindung zu Ende ist (`health:input` lost=false): Kommt vorher noch
  // ein verspäteter Block ohne echte Lücke, soll er es nicht verbrauchen.
  if (fillGapPending && session.status === 'recording' && lastChunkAt) {
    const chunkMs = (arrayBuffer.byteLength / (2 * session.channels) / session.sampleRate) * 1000;
    const missingMs = now - chunkMs - lastChunkAt;
    if (missingMs > GAP_FILL_MIN_MS) {
      fillGapPending = false;
      try {
        const filled = session.fillGap(missingMs / 1000);
        inputLog.write('warn', 'luecke-mit-stille-gefuellt', { sekunden: filled, bei: session.gaps.length ? session.gaps[session.gaps.length - 1].at : null });
      } catch (err) {
        inputLog.write('error', 'luecke-fuellen-fehlgeschlagen', { fehler: String(err && err.message || err) });
      }
    }
  }
  // Auch Aussetzer unter der Wächter-Schwelle (2,5 s) festhalten: nur im Zustand `recording`, nicht nach Pause/Start.
  if (session.status === 'recording') {
    if (prevRecChunkAt && now - prevRecChunkAt > CHUNK_GAP_LOG_MS) {
      inputLog.write('warn', 'luecke-zwischen-bloecken', { abstandMs: now - prevRecChunkAt });
    }
    prevRecChunkAt = now;
  } else {
    prevRecChunkAt = 0;
  }
  lastChunkAt = now;
  try {
    session.pushAudio(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Audioblock konnte nicht geschrieben werden:', err);
    // Nicht alle 100 ms eine Meldung: höchstens alle 10 Sekunden.
    if (Date.now() - lastWriteErrorToast > 10000) {
      lastWriteErrorToast = Date.now();
      toast('error', `Audio konnte nicht auf die Festplatte geschrieben werden: ${err.code || err.message}`);
    }
  }
});

/* --- Rückgängig, Schnitte, Eingangsstatus --- */

ipcMain.handle('edit:undo', () => session.undo());
ipcMain.handle('edit:redo', () => session.redo());
ipcMain.handle('cut:add', (_e, { start, end }) => session.addCut(start, end));
ipcMain.handle('cut:toggle', (_e, { time } = {}) => session.toggleCut(time));
ipcMain.handle('cut:move', (_e, { id, edge, time }) => session.moveCutEdge(id, edge, time));
ipcMain.handle('cut:remove', (_e, { id }) => session.removeCut(id));

// Die Oberfläche meldet, wenn der Audioeingang ausfällt bzw. wieder da ist.
ipcMain.on('health:input', (_e, { lost }) => {
  health.inputLost = Boolean(lost);
  fillGapPending = Boolean(lost) && session.status === 'recording' && session.mode !== 'multitrack';
  publishHealth();
});

// Einträge der Oberfläche (Wächter, Gerätewechsel, Zustand von Eingang und Fenster) ins Eingangsprotokoll.
ipcMain.on('log:input', (_e, { level, event, data } = {}) => {
  if (typeof event !== 'string' || event.length > 60) return;
  inputLog.write(LOG_LEVELS.has(level) ? level : 'info', event,
    data && typeof data === 'object' && !Array.isArray(data) ? data : {});
});

/* --- Abschnitte (je zwei Marker: Anfang und Ende) --- */

ipcMain.handle('section:toggle', (_e, params) => session.toggleSection(params || {}));
ipcMain.handle('section:start', (_e, { id, time } = {}) => session.startPending(id, time));
ipcMain.handle('section:add', (_e, params) => session.addPending(params || {}));
ipcMain.handle('section:reorder', (_e, { id, beforeId } = {}) => session.reorderPending(id, beforeId));
ipcMain.handle('section:place', (_e, { id, time } = {}) => session.placePending(id, time));
ipcMain.handle('section:next', (_e, { time } = {}) => session.startNextPending(time));
const found = (section) => (section ? ok({ section }) : fail('Abschnitt nicht gefunden.'));
ipcMain.handle('section:edge', (_e, { id, edge, time } = {}) => found(session.moveEdge(id, edge, time)));
ipcMain.handle('section:update', (_e, { id, ...patch } = {}) => found(session.updateSection(id, patch)));
ipcMain.handle('section:delete', (_e, { id } = {}) => (session.removeSection(id) ? ok({ removed: true }) : fail('Abschnitt nicht gefunden.')));

/* --- Export --- */

/** Unterordner je Gottesdienst im Export-Oberordner: "Datum_Gottesdienstname". */
function exportSubfolderName() {
  return `${session.service.date || dateStamp()}_${slug(session.service.name, 'Gottesdienst')}`;
}

/** Hängt " (2)", " (3)" … an, damit ein früherer Export nie überschrieben wird. */
function freeFilePath(filePath, taken = new Set()) {
  const free = (p) => !fs.existsSync(p) && !taken.has(p);
  if (free(filePath)) return filePath;
  const { dir, name, ext } = path.parse(filePath);
  for (let n = 2; ; n++) {
    const candidate = path.join(dir, `${name} (${n})${ext}`);
    if (free(candidate)) return candidate;
  }
}

/** Ziel-Lautheit der MP3-Dateien in LUFS (−30 … −10), 0/leer = nicht angleichen. */
function loudnessTarget() {
  const t = Number(settings.get('loudnessTarget'));
  return Number.isFinite(t) && t <= -10 && t >= -30 ? t : 0;
}

/** Zielordner für Exporte bei gesetztem Oberordner, sonst null (dann wird gefragt). */
function exportTargetFolder() {
  const base = settings.get('exportDir');
  return base ? path.join(base, exportSubfolderName()) : null;
}

ipcMain.handle('export:target', () => ok({ folder: exportTargetFolder() }));
/* Vorschau des Dateinamens für die Einstellungen: mit dem eingegebenen (noch nicht gespeicherten) Muster und einem
   Abschnitt der angezeigten Aufnahme (am liebsten einem mit Interpret), sonst Beispielwerten. */
ipcMain.handle('export:previewName', (_e, { pattern } = {}) => {
  const list = (session.sections || []).filter((x) => x.label);
  const pick = list.find((x) => x.artist) || list[0];
  const label = pick ? pick.label : 'Predigt';
  const artist = pick ? (pick.artist || settings.get('defaultArtist') || '') : 'Thomas Beck';
  return ok({ name: buildFileName(label, artist, pattern) });
});

/** Ausgewählte Abschnitte nacheinander als MP3 speichern und als gesichert vermerken. */
ipcMain.handle('export:batch', async (_e, { items } = {}) => {
  try {
    if (session.mode === 'multitrack') return fail('Mehrspuraufnahmen werden nicht als MP3 exportiert.');
    if (!session.wavPath || !fs.existsSync(session.wavPath)) {
      return fail('Es ist keine Masteraufnahme vorhanden.');
    }
    if (!Array.isArray(items) || items.length === 0) return fail('Es ist kein Abschnitt ausgewählt.');
    await session.whenWritten();         // die gerade beendete Aufnahme muss vollständig auf der Platte sein

    let folder = exportTargetFolder();
    if (!folder) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Zielordner für die MP3-Dateien wählen',
        defaultPath: settings.get('recordingsDir'),
        properties: ['openDirectory', 'createDirectory']
      });
      if (res.canceled || !res.filePaths[0]) return ok({ canceled: true });
      folder = res.filePaths[0];
    }
    fs.mkdirSync(folder, { recursive: true });

    // Zielnamen vorab vergeben: Die Exporte laufen gleichzeitig, zwei gleich benannte bekämen sonst dieselbe Datei.
    const reserved = new Set();
    const jobs = items.map(({ id, start, end, label }) => {
      const cuts = session.cutsWithin(start, end);
      const section = session.sections.find((x) => `seg_${x.id}` === id);
      const tags = {
        title: label,
        artist: section?.artist || settings.get('defaultArtist') || '',
        album: session.service.date || '',
        year: String(session.service.date || '').slice(0, 4)
      };
      const outPath = freeFilePath(path.join(folder, buildFileName(label, tags.artist)), reserved);
      reserved.add(outPath);
      return {
        wavPath: session.wavPath,
        start,
        end,
        outPath,
        bitrate: settings.get('mp3Bitrate') || 192,
        tags,
        skip: cuts,
        loudness: loudnessTarget() ? { target: loudnessTarget(), ceilingDb: -1 } : null
      };
    });

    let lastProgress = 0;
    const results = await mp3pool.exportAll(jobs, {
      onProgress: ({ progress, done, total }) => {
        const now = Date.now();
        if (now - lastProgress < 100) return;   // mehrere Threads melden gleichzeitig: höchstens 10-mal je Sekunde
        lastProgress = now;
        send('export-progress', { progress, done, total, index: Math.min(total, done + 1) });
      },
      onResult: (i, result) => {
        if (!result) return;
        const { id, start, end, label } = items[i];
        revealable.add(path.resolve(result.outPath));
        if (id) session.recordExport(id, { file: result.outPath, start, end, cuts: jobs[i].skip });
        net.publishEvent('export.finished', { file: result.outPath, label });
      }
    });
    const files = [];
    const failed = [];
    results.forEach(({ result, error }, i) => {
      if (result) files.push(result.outPath);
      else failed.push({ id: items[i].id, label: items[i].label, error: String(error?.message || error) });
    });
    send('export-progress', { progress: 1, done: items.length, index: items.length, total: items.length });
    return ok({ folder, files, failed });
  } catch (err) {
    return fail(err);
  }
});

/* "Im Ordner zeigen" nur für Dateien in Aufnahme- oder Exportordner bzw. eben exportierte Dateien. */
const revealable = new Set();
function isInside(file, dir) {
  if (!dir) return false;
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}
ipcMain.handle('file:reveal', (_e, { filePath } = {}) => {
  if (!filePath || !fs.existsSync(filePath)) return fail('Datei nicht gefunden.');
  const allowed = revealable.has(path.resolve(filePath))
    || isInside(filePath, settings.get('recordingsDir'))
    || isInside(filePath, multitrackDir())
    || isInside(filePath, settings.get('exportDir'));
  if (!allowed) return fail('Dieser Ort wird nicht angezeigt.');
  shell.showItemInFolder(filePath);
  return ok();
});

ipcMain.handle('folder:open', () => {
  shell.openPath(settings.get('recordingsDir'));
  return ok();
});

/* --- Aufnahmenliste / Wiederherstellung --- */

/** Session-Dateien: Stereo direkt im Aufnahmeordner, Mehrspur je in einem Unterordner des Mehrspur-Ordners. */
function sessionFiles() {
  const list = (dir) => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.session.json')).map((f) => path.join(dir, f)); } catch { return []; }
  };
  const files = list(settings.get('recordingsDir'));
  const mdir = multitrackDir();
  try {
    for (const entry of fs.readdirSync(mdir, { withFileTypes: true })) {
      if (entry.isDirectory()) files.push(...list(path.join(mdir, entry.name)));
    }
  } catch { /* noch keine Mehrspuraufnahmen */ }
  return files;
}

/**
 * Sicherungsstand einer Aufnahme fürs Archiv: beendete Abschnitte, davon als MP3 gesichert bzw. seit dem Export
 * geändert (Anfang/Ende verschoben), und ob die gesamte Aufnahme gesichert ist.
 */
function exportSummary(data) {
  const sections = Array.isArray(data.sections) ? data.sections.filter((x) => x.start != null && x.end != null) : [];
  const exp = data.exports && typeof data.exports === 'object' ? data.exports : {};
  let saved = 0;
  let changed = 0;
  for (const x of sections) {
    const e = exp[`seg_${x.id}`];
    if (!e) continue;
    if (Math.abs((e.start ?? x.start) - x.start) > 0.05 || Math.abs((e.end ?? x.end) - x.end) > 0.05) changed += 1;
    else saved += 1;
  }
  return { sections: sections.length, saved, changed, full: Boolean(exp.seg_full) };
}

function listSessions() {
  return sessionFiles().map((full) => {
    try {
      const data = JSON.parse(fs.readFileSync(full, 'utf8'));
      const placed = Array.isArray(data.sections) ? data.sections.filter((x) => x.start != null) : [];
      return {
        path: full,
        labels: placed.map((x) => String(x.label || '')),
        artists: [...new Set(placed.map((x) => String(x.artist || '').trim()).filter(Boolean))],
        exported: data.mode === 'multitrack' ? null : exportSummary(data),
        name: data.service?.name || 'Ohne Gottesdienst',
        date: data.service?.date || '',
        startedAt: data.startedAt || null,
        duration: data.duration || 0,
        finalized: data.finalized !== false,
        sectionCount: Array.isArray(data.sections)
          ? data.sections.filter((x) => x.start != null).length
          : (data.markers || []).filter((m) => m.placed).length,
        mode: data.mode === 'multitrack' ? 'multitrack' : 'stereo',
        tracks: Array.isArray(data.tracks) ? data.tracks.length : 0,
        // Wie beim Öffnen: verschobene Aufnahmen über den Namen neben der Session-Datei finden.
        wavExists: data.mode === 'multitrack'
          ? Array.isArray(data.tracks) && data.tracks.some((t) => fs.existsSync(path.join(path.dirname(full), t.file)))
          : (data.wavPath && fs.existsSync(data.wavPath)) || fs.existsSync(full.replace(/\.session\.json$/, '.wav'))
      };
    } catch {
      return null;
    }
  }).filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

ipcMain.handle('session:list', () => ok({ sessions: listSessions() }));

ipcMain.handle('session:open', (_e, { path: p }) => {
  try {
    if (session.status === 'recording' || session.status === 'paused') {
      return fail('Während einer laufenden Aufnahme kann keine andere Session geöffnet werden.');
    }
    multitrack.stopPlayback().catch(() => {});
    return ok({ state: session.loadFromFile(p) });
  } catch (err) { return fail(err); }
});

ipcMain.handle('session:recoverable', () => {
  const unfinished = listSessions().filter((s) => !s.finalized && s.wavExists);
  return ok({ sessions: unfinished });
});

/* Neue, leere Session; mit `keepPlan` (Knopf „Neue Aufnahme“ nach dem Beenden) bleiben Gottesdienst und Ablauf. */
ipcMain.handle('session:new', (_e, { keepPlan } = {}) => {
  if (session.status === 'recording' || session.status === 'paused') {
    return fail('Es läuft noch eine Aufnahme.');
  }
  multitrack.stopPlayback().catch(() => {});
  if (keepPlan) session.prepareNext(); else session.reset();
  session.emit('state', session.snapshot());
  return ok({ state: session.snapshot() });
});

ipcMain.handle('session:state', () => ok({ state: session.snapshot(), peaks: session.peaks, loudness: session.loudness }));

/* --- Netzwerk & Updates --- */

ipcMain.handle('net:status', () => ok(net.statusInfo()));
ipcMain.handle('net:restart', () => {
  const result = settings.get('networkEnabled') ? net.restart() : (net.stop(), { ok: true });
  return result.ok ? ok(net.statusInfo()) : fail(result.error);
});

ipcMain.handle('update:check', () => updater.check({ manual: true }));
ipcMain.handle('update:download', () => {
  const result = updater.download();
  return result.ok ? ok() : fail(result.error);
});
ipcMain.handle('update:install', () => {
  const result = updater.install();
  return result.ok ? ok() : fail(result.error);
});
ipcMain.handle('update:openPage', () => { shell.openExternal(updater.status().releasesUrl); return ok(); });
ipcMain.handle('update:status', () => ok(updater.status()));

/* --------------------------------------------------------------- App-Start */

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    settings.load();
    setupApplicationMenu();
    createWindow();
    logPowerEvents();
    updater.init();
    refreshDisk();
    setInterval(refreshDisk, 30000);   // Speicherplatz regelmäßig prüfen und an Netzwerk-Clients melden
    configureMixer();
    updateMonitor();

    // macOS verlangt zusätzlich zur Chromium-Freigabe eine Systemfreigabe.
    if (process.platform === 'darwin') {
      try {
        const granted = await systemPreferences.askForMediaAccess('microphone');
        if (!granted) {
          toast('warn', 'macOS verweigert den Zugriff auf den Audioeingang. Freigabe unter „Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon“.');
        }
      } catch (err) {
        console.warn('Mikrofonfreigabe konnte nicht abgefragt werden:', err);
      }
    }

    if (settings.get('networkEnabled') && settings.get('networkPassword')) {
      const result = net.start();
      if (!result.ok) console.warn('Netzwerkschnittstelle:', result.error);
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length > 0) return;
      createWindow();
      // Beim Schließen des Fensters wurde die Netzwerkschnittstelle gestoppt (macOS: App läuft weiter).
      if (settings.get('networkEnabled') && settings.get('networkPassword') && !net.statusInfo().running) {
        const result = net.start();
        if (!result.ok) console.warn('Netzwerkschnittstelle:', result.error);
      }
    });
  });

  app.on('window-all-closed', () => {
    net.stop();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', (e) => {
    // Greift vor allem unter macOS, wo Cmd+Q das Fenster umgeht.
    if (guardClose(e, () => app.quit())) return;
    session.flushSave();
    net.stop();
  });
}
