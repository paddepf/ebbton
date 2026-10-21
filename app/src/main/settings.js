'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, safeStorage } = require('electron');

const LEGACY_FILE_PATTERN = '{datum}_{gottesdienst}_{abschnitt}';

const DEFAULTS = {
  // Audio
  inputDeviceId: '',
  inputDeviceLabel: '',
  outputDeviceId: '',           // Wiedergabe/Mithören; leer = Systemstandard
  outputDeviceLabel: '',        // Name dazu (Anzeige, wenn das Gerät nicht angeschlossen ist)
  sampleRate: 48000,

  // Mehrspuraufnahme (siehe multitrack/)
  recordingMode: 'stereo',      // 'stereo' | 'multitrack'
  multitrackDevice: '',         // Name des Geräts; leer = das mit den meisten Eingängen
  multitrackSimulate: false,    // simuliertes 32-Kanal-Pult statt echtem Gerät (Entwicklung, Test)
  multitrackArmed: null,        // aufgenommene Kanäle (0-basiert); null = alle
  multitrackDir: '',            // leer = Unterordner „Mehrspur“ im Aufnahmeordner

  // Mischpult (OSC, nur lesend): Kanalnamen, Routing-Prüfung
  mixerHost: '',                // IP des M32; leer = keine Verbindung (mit simuliertem Mehrspur-Gerät: Pult-Simulator)
  mixerRouting: { stereo: null, multitrack: null },   // angelerntes Routing der Kartenausgänge je Aufnahmeart

  // Ablage
  recordingsDir: '',            // wird beim ersten Start gesetzt
  fileNamePattern: '{interpret}_{abschnitt}_{gottesdienst}_{datum}',
  exportDir: '',                // Oberordner für MP3-Exporte; leer = beim Export nachfragen
  mp3Bitrate: 192,
  loudnessTarget: -16,          // Lautheit der MP3-Dateien in LUFS (−16 = üblich für Podcasts); 0 = unverändert lassen
  // Vorlagen für Programmpunkte; die Standardvorlage wird genutzt, wenn ChurchTools keinen Ablaufplan hat
  agendaTemplates: [{ id: 'tpl_default', name: 'Gottesdienst', items: ['Einleitung', 'Kinderbeitrag', 'Predigt', 'Abschluss'] }],
  defaultTemplateId: 'tpl_default',
  defaultArtist: '',            // Interpret in den ID3-Tags, wenn ein Abschnitt keinen eigenen hat

  // ChurchTools
  churchToolsUrl: '',           // z. B. https://meinegemeinde.church.tools
  churchToolsToken: '',         // verschlüsselt abgelegt (siehe unten)
  churchToolsCalendarIds: [],   // leer = alle
  autoLoadTodaysService: true,
  artistServices: 'Leitung, Predigt, Geschichte',   // Dienste der ChurchTools-Dienstplanung, deren Personen als Interpret vorgeschlagen werden

  // Netzwerk
  networkEnabled: true,
  networkPort: 8765,
  networkPassword: '',          // Vollzugriff (Companion)
  monitorPassword: '',          // optional: nur lesen (Dashboard). Leer = deaktiviert.

  // Updates
  autoUpdateCheck: true,
  lastVersion: '',             // zuletzt gestartete Version; ändert sie sich, meldet die App „aktualisiert“

  // UI
  theme: 'dark',                // 'dark' | 'light' | 'system'
  compactOnTop: true,           // Mini-Fenster bleibt über anderen Programmen
  compactBounds: null,          // zuletzt benutzte Lage des Mini-Fensters ({ x, y, width, height })
  compactLayout: 2,             // Stand des Mini-Fensters; ältere gespeicherte Lagen (größer) werden verworfen
  loudnessMonitor: true,        // Voreinstellung des Schalters „LUFS“ (Lautheitslinie in der Wellenform)
  followLive: true,             // Voreinstellung des Schalters „Folgen“ bei jedem Aufnahmestart
  prelisten: true,              // Stereo: Eingang schon vor dem Start öffnen, damit der Pegel prüfbar ist (es wird nichts gespeichert)
  denseLayout: true,            // kompakte Ansicht (Voreinstellung): alle Bereiche, aber kleiner (kleinere Fenster möglich)
  denseBounds: null,            // zuletzt benutzte Lage des Fensters in der kompakten Ansicht
  largeBounds: null             // Lage des großen Fensters vor dem Umschalten auf kompakt ({ x, y, width, height, maximized })
};

let cache = null;
let filePath = null;

function file() {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json');
  return filePath;
}

function defaultRecordingsDir() {
  const docs = app.getPath('documents') || os.homedir();
  return path.join(docs, 'Gottesdienst-Aufnahmen');
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    stored = {};
  }
  cache = { ...DEFAULTS, ...stored };
  // Wer das alte Standardmuster nie geändert hat, bekommt das neue Standardmuster.
  if (stored.fileNamePattern === LEGACY_FILE_PATTERN) cache.fileNamePattern = DEFAULTS.fileNamePattern;
  // Frühere Einstellung "defaultAgenda" (eine Liste) wird zur ersten Vorlage.
  if (!stored.agendaTemplates && Array.isArray(stored.defaultAgenda)) {
    cache.agendaTemplates = [{ id: 'tpl_default', name: 'Gottesdienst', items: stored.defaultAgenda }];
    cache.defaultTemplateId = 'tpl_default';
  }
  delete cache.defaultAgenda;
  delete cache.keepMasterWavDays;   // frühere, nie umgesetzte Einstellung
  // Das Mini-Fenster ist seit Stand 2 deutlich kleiner: die alte, größere Lage nicht übernehmen.
  if (stored.compactLayout !== DEFAULTS.compactLayout) cache.compactBounds = null;
  if (!Array.isArray(cache.agendaTemplates) || cache.agendaTemplates.length === 0) {
    cache.agendaTemplates = DEFAULTS.agendaTemplates;
  }
  if (!cache.agendaTemplates.some((t) => t.id === cache.defaultTemplateId)) {
    cache.defaultTemplateId = cache.agendaTemplates[0].id;
  }
  if (!cache.recordingsDir) cache.recordingsDir = defaultRecordingsDir();
  try {
    fs.mkdirSync(cache.recordingsDir, { recursive: true });
  } catch { /* Ordner wird beim Aufnahmestart erneut geprüft */ }
  return cache;
}

function save(patch) {
  const current = load();
  Object.assign(current, patch || {});
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    // Erst in eine Hilfsdatei schreiben und dann umbenennen: ein Absturz mittendrin hinterlässt so nie
    // eine halbe Datei (sonst wären Token, Passwörter und Aufnahmeordner beim nächsten Start weg).
    fs.writeFileSync(file() + '.tmp', JSON.stringify(current, null, 2), 'utf8');
    fs.renameSync(file() + '.tmp', file());
  } catch (err) {
    console.error('Einstellungen konnten nicht gespeichert werden:', err);
  }
  return current;
}

/* --- Token-Verschlüsselung -------------------------------------------------
   Der ChurchTools-Token wird, wenn das Betriebssystem es unterstützt, über
   Electrons safeStorage verschlüsselt abgelegt. Fällt das aus, wird er als
   Klartext gespeichert und die UI weist darauf hin.
   Seit Electron 45 über die asynchronen Aufrufe (die synchronen entfallen in 46). Mit den alten Aufrufen
   verschlüsselte Token entschlüsseln sie weiter; meldet safeStorage `shouldReEncrypt` (neuer Schlüssel),
   wird der Token gleich neu verschlüsselt gespeichert.                       */

let encryptionAvailable = false;   // zuletzt bekannter Stand für die UI (`forRenderer` bleibt synchron)

/** Prüft, ob verschlüsselt werden kann (nach `ready` aufrufen); merkt das Ergebnis für die UI. */
async function initEncryption() {
  try { encryptionAvailable = await safeStorage.isAsyncEncryptionAvailable(); } catch { encryptionAvailable = false; }
  return encryptionAvailable;
}

async function encryptSecret(value) {
  if (!value) return '';
  try {
    if (await initEncryption()) {
      return 'enc:' + (await safeStorage.encryptStringAsync(value)).toString('base64');
    }
  } catch { /* Fallback unten */ }
  return 'plain:' + Buffer.from(value, 'utf8').toString('base64');
}

/** @returns {Promise<{value: string, shouldReEncrypt: boolean}>} */
async function decryptSecret(stored) {
  if (!stored) return { value: '', shouldReEncrypt: false };
  try {
    if (stored.startsWith('enc:')) {
      const r = await safeStorage.decryptStringAsync(Buffer.from(stored.slice(4), 'base64'));
      return { value: r.result, shouldReEncrypt: Boolean(r.shouldReEncrypt) };
    }
    if (stored.startsWith('plain:')) {
      return { value: Buffer.from(stored.slice(6), 'base64').toString('utf8'), shouldReEncrypt: false };
    }
  } catch (err) {
    console.error('Token konnte nicht entschlüsselt werden:', err);
    return { value: '', shouldReEncrypt: false };
  }
  return { value: stored, shouldReEncrypt: false }; // Alt-Format
}

/** Entschlüsselter ChurchTools-Token (leer, wenn keiner hinterlegt ist oder er nicht lesbar ist). */
async function churchToolsToken() {
  const stored = load().churchToolsToken;
  const { value, shouldReEncrypt } = await decryptSecret(stored);
  if (value && shouldReEncrypt) {
    const again = await encryptSecret(value);
    // Nur speichern, wenn sich der Token inzwischen nicht geändert hat und wieder verschlüsselt werden konnte.
    if (again.startsWith('enc:') && load().churchToolsToken === stored) save({ churchToolsToken: again });
  }
  return value;
}

/** Einstellungen für die UI – Geheimnisse werden nur als "gesetzt/nicht gesetzt" gemeldet. */
function forRenderer() {
  const s = load();
  return {
    ...s,
    churchToolsToken: undefined,
    churchToolsTokenSet: Boolean(s.churchToolsToken),
    encryptionAvailable
  };
}

module.exports = {
  DEFAULTS,
  load,
  save,
  forRenderer,
  encryptSecret,
  decryptSecret,
  get: (key) => load()[key],
  churchToolsToken,
  initEncryption
};
