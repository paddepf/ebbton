'use strict';

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');
const settings = require('./settings');

const STATUS_DIR = path.join(__dirname, '..', 'status');
const STATUS_FILES = {
  '/': { name: 'index.html', type: 'text/html; charset=utf-8' },
  '/status.js': { name: 'status.js', type: 'text/javascript; charset=utf-8' },
  '/status.css': { name: 'status.css', type: 'text/css; charset=utf-8' }
};

const PROTOCOL_VERSION = 1;
const LEVEL_INTERVAL_MS = 200;
const MAX_FAILURES = 5;        // Fehlversuche pro Adresse …
const LOCK_MS = 60000;         // … danach so lange keine Anmeldung
const FAILURE_MEMORY_MS = 10 * 60000;   // Fehlversuche verfallen nach 10 min ohne weiteren
const MAX_MESSAGE_BYTES = 64 * 1024;

/** IPv4-Adressen dieses Rechners im lokalen Netz (für die Adresse der Statusseite). */
function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Stellt den Aufnahmestatus im Netzwerk bereit und nimmt Steuerbefehle
 * entgegen. Es gibt zwei Rollen:
 *   - "control": Vollzugriff (Bitfocus Companion) – Passwort aus networkPassword
 *   - "monitor": nur lesen (Dashboard)          – Passwort aus monitorPassword
 * Ohne Monitor-Passwort gibt es die Monitor-Rolle nur für Verbindungen mit dem Vollzugriffs-Passwort, die sich
 * selbst beschränken (role: monitor) oder aus einem Browser kommen (Statusseite).
 */
class NetServer extends EventEmitter {
  constructor() {
    super();
    this.wss = null;
    this.http = null;
    this.port = null;
    this.clients = new Map();       // ws -> {role, authed, ip, fromBrowser}
    this.failures = new Map();      // ip -> {count, until}: Bremse gegen Durchprobieren
    this.lastState = null;
    this.lastLevelSent = 0;
  }

  get running() {
    return Boolean(this.wss);
  }

  get clientCount() {
    return [...this.clients.values()].filter((c) => c.authed).length;
  }

  start() {
    const cfg = settings.load();
    if (!cfg.networkEnabled) return { ok: false, error: 'Die Netzwerkschnittstelle ist deaktiviert.' };
    if (!cfg.networkPassword) {
      return { ok: false, error: 'Es ist kein Netzwerk-Passwort gesetzt. Bitte in den Einstellungen vergeben.' };
    }
    this.stop();

    this.http = http.createServer((req, res) => {
      // Kleiner Health-Endpunkt, damit ein Dashboard die App auch ohne
      // WebSocket erreichen/erkennen kann.
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          app: 'ebbton',
          protocol: PROTOCOL_VERSION,
          status: this.lastState?.status || 'idle'
        }));
        return;
      }
      if (this._serveStatusPage(req, res)) return;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Ebbton: bitte über WebSocket verbinden.');
    });

    // Steuerbefehle sind klein. Ohne Grenze (Vorgabe von ws: 100 MiB) könnte jedes Gerät im Netz schon vor der
    // Anmeldung riesige Nachrichten schicken, die der Hauptprozess puffern und parsen müsste – mitten in der Aufnahme.
    this.wss = new WebSocketServer({ server: this.http, maxPayload: MAX_MESSAGE_BYTES });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    // ws reicht Fehler des HTTP-Servers (z. B. Port belegt) als 'error' weiter. Ohne Listener würde das als
    // unbehandelte Ausnahme den Hauptprozess treffen – die eigentliche Meldung macht der Handler unten.
    this.wss.on('error', () => {});

    try {
      this.http.listen(cfg.networkPort);
      this.port = cfg.networkPort;
    } catch (err) {
      this.stop();
      return { ok: false, error: 'Port konnte nicht geöffnet werden: ' + err.message };
    }

    const server = this.http;
    server.on('error', (err) => {
      if (this.http !== server) return;   // verspäteter Fehler eines inzwischen ersetzten Servers
      this.emit('error-notice', `Netzwerkschnittstelle: ${err.code === 'EADDRINUSE'
        ? `Port ${cfg.networkPort} ist belegt.`
        : err.message}`);
      this.stop();
      this.emit('status', this.statusInfo());
    });

    this._ping = setInterval(() => {
      this.wss?.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        try { ws.ping(); } catch { /* Verbindung wird ohnehin verworfen */ }
      });
    }, 20000);

    this.emit('status', this.statusInfo());
    return { ok: true, port: this.port };
  }

  /**
   * Statusseite für Handy/Tablet (`/`, Dateien aus `src/status`). Sie meldet sich selbst per WebSocket an; als
   * Webseite bekommt sie immer nur die Rolle „monitor“. Nur feste Dateien, keine Pfade aus der Anfrage.
   */
  _serveStatusPage(req, res) {
    if (req.method !== 'GET') return false;
    const pathname = (req.url || '/').split('?')[0];
    const file = STATUS_FILES[pathname];
    if (!file) return false;
    let body;
    try {
      body = fs.readFileSync(path.join(STATUS_DIR, file.name));
    } catch {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': file.type,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'"
    });
    res.end(body);
    return true;
  }

  stop() {
    if (this._ping) clearInterval(this._ping);
    this._ping = null;
    if (this.wss) {
      this.wss.clients.forEach((ws) => { try { ws.close(); } catch { /* egal */ } });
      this.wss.close();
      this.wss = null;
    }
    if (this.http) {
      try { this.http.close(); } catch { /* egal */ }
      this.http = null;
    }
    this.clients.clear();
    this.port = null;
  }

  restart() {
    this.stop();
    const result = this.start();
    if (!result.ok) this.emit('status', this.statusInfo());   // start() meldet nur bei Erfolg
    return result;
  }

  statusInfo() {
    return {
      running: this.running,
      port: this.port,
      clients: this.clientCount,
      passwordSet: Boolean(settings.get('networkPassword')),
      monitorRoleEnabled: Boolean(settings.get('monitorPassword')),
      statusUrls: this.running ? lanAddresses().map((ip) => `http://${ip}:${this.port}/`) : []
    };
  }

  _onConnection(ws, req) {
    const ip = req.socket.remoteAddress;
    // Browser schicken einen Origin-Header, Companion und eigene Programme nicht. Webseiten dürfen
    // höchstens mitlesen: Eine fremde Seite im Browser des Technikrechners soll nicht steuern können.
    const fromBrowser = Boolean(req.headers.origin);
    this.clients.set(ws, { authed: false, role: null, ip, fromBrowser });
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const authTimer = setTimeout(() => {
      const info = this.clients.get(ws);
      if (info && !info.authed) {
        this._send(ws, { type: 'error', code: 'auth_timeout', message: 'Keine Anmeldung erhalten.' });
        ws.close();
      }
    }, 10000);

    this._send(ws, { type: 'hello', app: 'ebbton', protocol: PROTOCOL_VERSION });

    // Anmeldung auch per Query-Parameter erlauben: ws://host:port/?password=...&role=monitor
    try {
      const url = new URL(req.url, 'http://localhost');
      const qp = url.searchParams.get('password');
      if (qp) this._authenticate(ws, qp, url.searchParams.get('role'));
    } catch { /* normale Anmeldung per Nachricht */ }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return this._send(ws, { type: 'error', code: 'bad_json', message: 'Nachricht ist kein gültiges JSON.' });
      }
      this._handle(ws, msg);
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      this.clients.delete(ws);
      this.emit('status', this.statusInfo());
    });
    ws.on('error', () => { /* Verbindungsfehler führen zum close-Event */ });
  }

  _authenticate(ws, password, requestedRole) {
    const info = this.clients.get(ws);
    if (!info || info.authed) return;
    const cfg = settings.load();

    // Bremse gegen Durchprobieren: nach 5 Fehlversuchen einer Adresse 60 s keine Anmeldung.
    const lock = this.failures.get(info.ip);
    if (lock && lock.until > Date.now()) {
      this._send(ws, { type: 'error', code: 'auth_locked', message: 'Zu viele Fehlversuche – bitte eine Minute warten.' });
      setTimeout(() => ws.close(), 200);
      return;
    }

    let role = null;
    if (cfg.networkPassword && safeEqual(password, cfg.networkPassword)) role = 'control';
    else if (cfg.monitorPassword && safeEqual(password, cfg.monitorPassword)) role = 'monitor';

    if (!role) {
      const now = Date.now();
      const entry = this.failures.get(info.ip) || { count: 0, until: 0, last: 0 };
      if (now - entry.last > FAILURE_MEMORY_MS) entry.count = 0;   // alte Fehlversuche (Tippfehler letzte Woche) vergessen
      entry.last = now;
      entry.count += 1;
      if (entry.count >= MAX_FAILURES) {
        entry.until = Date.now() + LOCK_MS;
        entry.count = 0;
      }
      this.failures.set(info.ip, entry);
      this._send(ws, { type: 'error', code: 'auth_failed', message: 'Passwort ist falsch.' });
      setTimeout(() => ws.close(), 200);
      return;
    }
    this.failures.delete(info.ip);
    // Wer das Vollzugriffs-Passwort nutzt, kann sich freiwillig beschränken; Browser dürfen nur mitlesen.
    if (requestedRole === 'monitor' || info.fromBrowser) role = 'monitor';

    info.authed = true;
    info.role = role;
    this._send(ws, { type: 'auth', ok: true, role });
    if (this.lastState) this._send(ws, { type: 'state', payload: this._forRole(this.lastState, role) });
    this.emit('status', this.statusInfo());
  }

  _handle(ws, msg) {
    const info = this.clients.get(ws);
    if (!info) return;
    // Gültiges JSON muss noch kein Objekt sein ("null", "42" …).
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      return this._send(ws, { type: 'error', code: 'bad_json', message: 'Nachricht muss ein JSON-Objekt sein.' });
    }

    if (msg.type === 'auth') return this._authenticate(ws, msg.password, msg.role);
    if (!info.authed) {
      return this._send(ws, { type: 'error', code: 'unauthorized', message: 'Bitte zuerst anmelden.' });
    }
    if (msg.type === 'ping') return this._send(ws, { type: 'pong', id: msg.id ?? null });
    if (msg.type === 'get_state') {
      return this._send(ws, { type: 'state', payload: this._forRole(this.lastState, info.role), id: msg.id ?? null });
    }
    if (msg.type !== 'command') {
      return this._send(ws, { type: 'error', code: 'unknown_type', message: 'Unbekannter Nachrichtentyp.' });
    }
    if (info.role !== 'control') {
      return this._send(ws, { type: 'error', code: 'read_only', message: 'Diese Verbindung darf nur mitlesen.' });
    }

    const allowed = ['record.start', 'record.stop', 'record.pause', 'record.resume', 'record.toggle',
      'marker.add', 'marker.next', 'cut.toggle', 'undo', 'redo', 'template.apply', 'mode.set'];
    if (!allowed.includes(msg.action)) {
      return this._send(ws, { type: 'error', code: 'unknown_action', message: `Unbekannter Befehl: ${msg.action}` });
    }

    this.emit('command', {
      action: msg.action,
      params: msg.params || {},
      reply: (result) => this._send(ws, { type: 'result', id: msg.id ?? null, action: msg.action, ...result })
    });
  }

  _send(ws, obj) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch { /* Verbindung bricht ab */ }
  }

  broadcast(obj) {
    this.clients.forEach((info, ws) => {
      if (!info.authed) return;
      this._send(ws, obj);
    });
  }

  /** Vollständiger Zustand – wird bei jeder Änderung gesendet (Mitlesende ohne Pfade und Namen). */
  publishState(state) {
    this.lastState = state;
    const forMonitor = this._forRole(state, 'monitor');
    this.clients.forEach((info, ws) => {
      if (!info.authed) return;
      this._send(ws, { type: 'state', payload: info.role === 'monitor' ? forMonitor : state });
    });
  }

  /**
   * Die Mitlese-Rolle (Dashboards, ggf. öffentlich sichtbar) bekommt keine Dateipfade und keine
   * Personennamen (Interpreten, Dienstplanung).
   */
  _forRole(state, role) {
    if (!state || role !== 'monitor') return state;
    const strip = (x) => ({ ...x, artist: undefined });
    return {
      ...state,
      wavPath: undefined,
      health: state.health ? { ...state.health, writeMessage: undefined } : state.health,   // Systemmeldung, ggf. mit Pfad
      service: state.service ? { ...state.service, suggestions: undefined } : state.service,
      sections: (state.sections || []).map(strip),
      pending: (state.pending || []).map(strip),
      exports: Object.fromEntries(Object.entries(state.exports || {}).map(([k, v]) => [k, { at: v.at }]))
    };
  }

  /** Pegel – gedrosselt, damit das Netz nicht geflutet wird. */
  publishLevels(levels) {
    const now = Date.now();
    if (now - this.lastLevelSent < LEVEL_INTERVAL_MS) return;
    this.lastLevelSent = now;
    this.broadcast({ type: 'levels', payload: levels });
  }

  /** Ereignisse – Mitlesende bekommen sie wie den Zustand ohne Dateipfade. */
  publishEvent(name, payload) {
    const forMonitor = payload ? { ...payload, wavPath: undefined, file: undefined } : payload;
    this.clients.forEach((info, ws) => {
      if (!info.authed) return;
      this._send(ws, { type: 'event', event: name, payload: info.role === 'monitor' ? forMonitor : payload });
    });
  }
}

module.exports = { NetServer };
