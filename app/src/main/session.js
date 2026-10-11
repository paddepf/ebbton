'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { WavWriter, readInfo, readSlice, writeCues } = require('./wav');
const settings = require('./settings');
const SectionLogic = require('../shared/sections');
const RoleLogic = require('../shared/roles');
const Loudness = require('../shared/loudness-curve');
const { LoudnessMeter } = require('./loudness');
const { readFrames } = require('./wav');

const PEAK_BUCKET_MS = 50;   // Auflösung der Wellenform
const AUTOSAVE_MS = 3000;
const MIN_SECTION = SectionLogic.MIN_SECTION;
const MIN_CUT = 0.2;       // kürzester Schnitt in Sekunden
const MAX_GAP_FILL_SECONDS = 300;   // so viel Stille füllt `fillGap` höchstens je Aussetzer ein (Speicher/Schreib-Thread)
const UNDO_LIMIT = 60;     // so viele Schritte lassen sich zurücknehmen

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter}`;
}

function slug(text, fallback) {
  const s = String(text || '')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return s || fallback || 'Aufnahme';
}

function dateStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Liest die Abschnitte einer gespeicherten Session. Ältere Sessions kennen nur
 * einzelne Marker; sie werden zu Abschnitten bis zum jeweils nächsten Marker.
 */
function migrateSections(data, duration) {
  let list;
  if (Array.isArray(data.sections)) {
    list = data.sections.map((x) => ({ ...x }));
  } else {
    const old = data.markers || [];
    const placed = old.filter((m) => m.placed && m.time != null).sort((a, b) => a.time - b.time);
    list = old.map((m) => {
      const idx = placed.indexOf(m);
      const next = idx >= 0 ? placed[idx + 1] : null;
      return {
        id: m.id, ctId: m.ctId ?? null, label: m.label, category: m.category || null,
        plannedDuration: m.plannedDuration || null, order: m.order || 0, source: m.source || 'manual',
        start: idx >= 0 ? m.time : null,
        end: idx >= 0 ? (next ? next.time : duration) : null
      };
    });
  }
  let color = 0;
  list.forEach((x) => {
    if (x.color == null) { x.color = color; }
    color = Math.max(color, x.color) + 1;
    // Unterbrochene Aufnahme: ein offener Abschnitt reicht bis zum Ende der Datei.
    if (x.start != null && x.end == null) x.end = Math.max(duration, x.start + MIN_SECTION);
  });
  return list;
}

/**
 * Eine Session ist eine Aufnahme: eine durchgehende WAV-Masterdatei plus
 * Abschnitte und Metadaten. Abschnitte sind reine Metadaten – die
 * Audiodatei wird davon nie verändert.
 */
class Session extends EventEmitter {
  constructor() {
    super();
    this.reset();
  }

  reset() {
    this.flushSave();                   // Änderungen der bisherigen Session nicht verlieren
    this.status = 'idle';               // idle | recording | paused | stopped
    this.service = { id: null, name: '', date: dateStamp() };
    this.agendaOrigin = null;           // {source: 'churchtools'|'plan', template} – woher der Ablaufplan stammt
    this.sections = [];                 // {id,label,category,color,start|null,end|null,source}
    this.exports = {};                  // Segment-ID -> {file,start,end,cuts,at}: bereits als MP3 gesichert
    this.cuts = [];                     // {id,start,end|null}: beim MP3-Export ausgelassene Stellen
    this._undo = [];                    // frühere Bearbeitungsstände (Abschnitte + Schnitte) als JSON
    this._redo = [];
    this._lastEdit = this._editJson();
    this._colorSeq = 0;
    this.peaks = [];                    // 0..255 je 50 ms
    this.loudness = [];                 // Stereo: Lautheit je 100 ms (LUFS, null = Stille), siehe shared/loudness-curve.js
    this._loudCurve = new Loudness.Curve(this.loudness);
    this._loudMeter = null;             // misst während der Aufnahme
    this._loudJob = (this._loudJob || 0) + 1;   // laufende Nachberechnung einer geladenen Aufnahme ungültig machen
    this.mode = 'stereo';               // stereo | multitrack (Mehrspuraufnahme, siehe multitrack/)
    this.tracks = [];                   // Mehrspur: {channel (0-basiert), name, color (Pultfarbe 0–15), file (Dateiname im Spurordner)}
    this.trackDir = null;               // Mehrspur: Ordner mit Spuren und Session-Datei
    this.writer = null;
    this.basePath = null;               // ohne Endung
    this.wavPath = null;
    this.sampleRate = settings.get('sampleRate') || 48000;
    this.channels = 2;
    this.levels = { l: 0, r: 0, clip: false };
    this.startedAt = null;
    this.finalized = false;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this._clipUntil = 0;
    this._restoredDuration = 0;
    this.gaps = [];                     // mit Stille gefüllte Aussetzer des Eingangs: {at (s), seconds}
    this._dirty = false;
  }

  /**
   * „Neue Aufnahme“ nach dem Beenden: zurück in den Zustand vor dem Start, ohne gleich aufzunehmen. Die beendete
   * Aufnahme bleibt als Datei erhalten (vorher gespeichert); Gottesdienst und Ablauf bleiben, die Punkte des Ablaufs
   * sind wieder offen, eigene Abschnitte (M) entfallen – wie beim Start einer neuen Aufnahme. So lässt sich vor dem
   * nächsten Start noch eine andere Vorlage oder ein anderer Gottesdienst wählen.
   */
  prepareNext() {
    const keep = {
      service: this.service,
      agendaOrigin: this.agendaOrigin,
      sections: this.sections
        .filter((x) => x.source !== 'manual')
        .map((x) => ({ ...x, start: null, end: null })),
      colorSeq: this._colorSeq
    };
    this.reset();
    this.service = keep.service;
    this.agendaOrigin = keep.agendaOrigin;
    this.sections = keep.sections;
    this._colorSeq = keep.colorSeq;
    this._lastEdit = this._editJson();
  }

  /* ------------------------------------------------------------------ Zustand */

  get duration() {
    return this.writer ? this.writer.durationSeconds : (this._restoredDuration || 0);
  }

  /** Abschnitte mit gesetztem Anfang, chronologisch sortiert. */
  placedSections() {
    return this.sections.filter((x) => x.start != null).sort((a, b) => a.start - b.start);
  }

  /** Offene Ablaufplan-Punkte, deren Anfang noch nicht gesetzt ist. */
  pendingSections() {
    // In der Reihenfolge des Ablaufplans (Umsortieren ändert nur "order", nicht die Lage im Array).
    return this.sections.filter((x) => x.start == null).sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /** Der Abschnitt, der gerade läuft (Anfang gesetzt, Ende noch offen). */
  openSection() {
    return this.sections.find((x) => x.start != null && x.end == null) || null;
  }

  _segmentOf(x) {
    const end = x.end != null ? x.end : this.duration;
    const cuts = this.cutsWithin(x.start, end);
    return {
      id: 'seg_' + x.id,
      label: x.label,
      category: x.category || null,
      start: x.start,
      end,
      cuts,
      cutSeconds: cuts.reduce((sum, c) => sum + (c.end - c.start), 0),
      markerId: x.id,
      open: x.end == null
    };
  }

  /**
   * Exportierbare Abschnitte: jeder Abschnitt aus Anfang und Ende, dazu immer
   * die gesamte Aufnahme.
   */
  segments() {
    const out = this.placedSections().map((x) => this._segmentOf(x));
    if (this.duration > 0) {
      const cuts = this.cutsWithin(0, this.duration);
      out.push({
        id: 'seg_full', label: 'Gesamte Aufnahme', category: null, start: 0, end: this.duration,
        cuts, cutSeconds: cuts.reduce((sum, c) => sum + (c.end - c.start), 0), markerId: null
      });
    }
    return out;
  }

  /** Der Abschnitt, in dem die Aufnahme gerade läuft. */
  currentSegment() {
    const open = this.openSection();
    return open ? this._segmentOf(open) : null;
  }

  snapshot() {
    return {
      status: this.status,
      service: this.service,
      agendaOrigin: this.agendaOrigin,
      duration: this.duration,
      startedAt: this.startedAt,
      sampleRate: this.sampleRate,
      channels: this.channels,
      levels: this.levels,
      mode: this.mode,
      tracks: this.tracks.map(({ channel, name, color }) => ({ channel, name, color: color ?? null })),
      sections: this.sections,
      exports: this.exports,
      cuts: this.cuts,
      canUndo: this._undo.length > 0,
      canRedo: this._redo.length > 0,
      pending: this.pendingSections(),
      segments: this.segments(),
      currentSegment: this.currentSegment(),
      wavPath: this.wavPath
    };
  }

  /**
   * Meldet eine Änderung. Hat sich dabei die Bearbeitung (Abschnitte oder Schnitte) geändert,
   * wird der vorherige Stand für "Rückgängig" gemerkt.
   */
  _changed({ undoable = true } = {}) {
    const now = this._editJson();
    if (undoable && now !== this._lastEdit) {
      this._undo.push(this._lastEdit);
      if (this._undo.length > UNDO_LIMIT) this._undo.shift();
      this._redo = [];
    }
    this._lastEdit = now;
    this._dirty = true;
    // Außerhalb der Aufnahme läuft kein Autosave: Änderungen (Abschnitte, Schnitte …) kurz gebündelt speichern.
    if (!this._autosave && this.basePath) this._scheduleSave();
    this.emit('state', this.snapshot());
  }

  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._dirty) this.save();
    }, 800);
  }

  /** Noch ausstehende Änderungen sofort speichern (vor dem Laden einer anderen Session, beim Beenden). */
  flushSave() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty && this.basePath) this.save();
  }

  _editJson() {
    return JSON.stringify({ sections: this.sections, cuts: this.cuts });
  }

  _resetUndo() {
    this._undo = [];
    this._redo = [];
    this._lastEdit = this._editJson();
  }

  _restoreEdit(json) {
    const data = JSON.parse(json);
    this.sections = data.sections;
    this.cuts = data.cuts || [];
    this._changed({ undoable: false });
  }

  /** Macht die letzte Änderung an Abschnitten oder Schnitten rückgängig. */
  undo() {
    if (this._undo.length === 0) return { ok: false, error: 'Nichts zum Rückgängigmachen.' };
    this._redo.push(this._editJson());
    this._restoreEdit(this._undo.pop());
    return { ok: true };
  }

  redo() {
    if (this._redo.length === 0) return { ok: false, error: 'Nichts zum Wiederholen.' };
    this._undo.push(this._editJson());
    this._restoreEdit(this._redo.pop());
    return { ok: true };
  }

  /* ----------------------------------------------------------------- Schnitte */

  /** Schnittbereiche innerhalb von [start, end], auf diesen Zeitraum begrenzt. */
  cutsWithin(start, end) {
    return this.cuts
      .map((c) => ({ start: Math.max(c.start, start), end: Math.min(c.end != null ? c.end : this.duration, end) }))
      .filter((c) => c.end - c.start > 0.001)
      .sort((a, b) => a.start - b.start);
  }

  /** Verschmilzt überlappende (beendete) Schnitte. */
  _mergeCuts() {
    const closed = this.cuts.filter((c) => c.end != null).sort((a, b) => a.start - b.start);
    const open = this.cuts.filter((c) => c.end == null);
    const merged = [];
    closed.forEach((c) => {
      const last = merged[merged.length - 1];
      if (last && c.start <= last.end) last.end = Math.max(last.end, c.end);
      else merged.push({ ...c });
    });
    this.cuts = [...merged, ...open];
  }

  /** Legt einen Schnitt an: diese Stelle fehlt in den MP3-Exporten. */
  addCut(start, end) {
    if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false, error: 'Ungültige Zeitangabe.' };
    const max = Math.max(this.duration, 0);
    const a = Math.max(0, Math.min(start, end));
    const b = Math.min(max, Math.max(start, end));
    if (b - a < MIN_CUT) return { ok: false, error: 'Der Schnitt ist zu kurz.' };
    const cut = { id: newId('cut'), start: a, end: b };
    this.cuts.push(cut);
    this._mergeCuts();
    this._changed();
    return { ok: true, cut };
  }

  /** Taste X: beginnt einen Schnitt an der aktuellen Stelle bzw. beendet den offenen. */
  toggleCut(time) {
    const t = Math.max(0, time == null ? this.duration : time);
    const open = this.cuts.find((c) => c.end == null);
    if (!open) {
      this.cuts.push({ id: newId('cut'), start: t, end: null });
      this._changed();
      return { ok: true, change: 'started' };
    }
    if (t - open.start < MIN_CUT) {
      this.cuts = this.cuts.filter((c) => c !== open);
      this._changed();
      return { ok: true, change: 'discarded' };
    }
    open.end = t;
    this._mergeCuts();
    this._changed();
    return { ok: true, change: 'ended' };
  }

  moveCutEdge(id, edge, time) {
    const cut = this.cuts.find((c) => c.id === id);
    if (!cut) return { ok: false, error: 'Schnitt nicht gefunden.' };
    if (!Number.isFinite(time)) return { ok: false, error: 'Ungültige Zeitangabe.' };
    const max = Math.max(this.duration, 0);
    const t = Math.max(0, Math.min(time, max));
    if (edge === 'start') cut.start = Math.min(t, (cut.end != null ? cut.end : max) - MIN_CUT);
    else if (cut.end != null) cut.end = Math.max(t, cut.start + MIN_CUT);
    this._mergeCuts();
    this._changed();
    return { ok: true };
  }

  removeCut(id) {
    const before = this.cuts.length;
    this.cuts = this.cuts.filter((c) => c.id !== id);
    if (this.cuts.length === before) return { ok: false, error: 'Schnitt nicht gefunden.' };
    this._changed();
    return { ok: true };
  }

  /** Offene Schnitte am Ende der Aufnahme schließen (zu kurze entfallen). */
  _closeOpenCuts(time) {
    this.cuts = this.cuts
      .map((c) => (c.end == null ? { ...c, end: time } : c))
      .filter((c) => c.end - c.start >= MIN_CUT);
  }


  /* ------------------------------------------------------- Ablaufplan / Marker */

  setService(service) {
    this.service = {
      id: service?.id ?? null,
      name: service?.name || 'Gottesdienst',
      date: service?.date || dateStamp(),
      // Personen aus der ChurchTools-Dienstplanung (z. B. Leitung, Predigt) als Interpret-Vorschläge
      suggestions: Array.isArray(service?.suggestions) ? service.suggestions : [],
      // Infotext des Termins aus ChurchTools (bei der Bibelstunde z. B. der Predigttitel)
      info: service?.info ? String(service.info) : null
    };
    this._changed();
  }

  _nextColor() {
    const c = this._colorSeq;
    this._colorSeq += 1;
    return c;
  }

  /** Übernimmt Ablaufplan-Punkte als noch nicht gesetzte Abschnitte. */
  setAgenda(items, source = 'churchtools', templateName = null) {
    this.agendaOrigin = { source, template: templateName || null };
    const manual = this.sections.filter((x) => x.source === 'manual');
    const placedFromPlan = this.sections.filter((x) => x.source !== 'manual' && x.start != null);
    const keepIds = new Set(placedFromPlan.map((x) => x.ctId).filter((id) => id != null));
    // Punkte aus Vorlagen haben keine ChurchTools-Id: bereits gesetzte am Namen erkennen, sonst entstehen Doppelte.
    const keepLabels = new Set(placedFromPlan.filter((x) => x.ctId == null).map((x) => String(x.baseLabel || x.label).trim().toLowerCase()));
    const fresh = (items || [])
      .filter((it) => !(it.id != null && keepIds.has(it.id)))
      .filter((it) => !(it.id == null && keepLabels.has(String(it.title || '').trim().toLowerCase())))
      .map((it, i) => ({
        id: newId('sec'),
        ctId: it.id ?? null,
        label: it.title || `Punkt ${i + 1}`,
        category: it.category || null,
        plannedDuration: it.duration || null,
        artist: it.responsible || null,       // zuständige Person aus dem Ablaufplan
        order: i,
        color: this._nextColor(),
        start: null,
        end: null,
        source
      }));
    this.sections = [...placedFromPlan, ...fresh, ...manual];
    const autoFilled = this._applySuggestions();
    this._applyInfo();
    this._changed();             // lässt sich rückgängig machen (z. B. versehentlich geladene Vorlage)
    return autoFilled;
  }

  /**
   * Trägt für Punkte ohne Interpret die Personen aus der Dienstplanung ein, deren Dienst zum Namen
   * passt (z. B. Dienst "Predigt 2" beim Punkt "Predigt"). Gibt zurück, bei wie vielen Punkten das geschah.
   */
  _applySuggestions() {
    const suggestions = this.service.suggestions || [];
    if (suggestions.length === 0) return 0;
    let count = 0;
    this.sections.forEach((x) => {
      if (x.artist) return;
      const names = RoleLogic.namesForLabel(x.label, suggestions);
      if (names.length) {
        x.artist = names.join(', ');
        count += 1;
      }
    });
    return count;
  }

  /**
   * Hängt den Infotext des Termins an den Predigt-Abschnitt („Predigt: Kolosser 2,6-7 Verwurzelt in Christus“).
   * Nur der erste passende Abschnitt, nur einmal (`baseLabel` merkt den ursprünglichen Namen) und nur, wenn
   * der Text nicht schon im Namen steht.
   */
  _applyInfo() {
    const info = this.service.info;
    if (!info) return false;
    const target = this.sections.find((x) => RoleLogic.takesEventInfo(x.label) || (x.baseLabel && RoleLogic.takesEventInfo(x.baseLabel)));
    if (!target || target.baseLabel) return false;
    if (String(target.label).toLowerCase().includes(info.toLowerCase())) return false;
    target.baseLabel = target.label;
    target.label = `${target.label}: ${info}`;
    return true;
  }

  _closeOpen(time) {
    const open = this.openSection();
    if (!open) return null;
    open.end = Math.max(open.start + MIN_SECTION, time);
    return open;
  }

  /** Beginnt einen neuen, selbst benannten Abschnitt. */
  startSection({ label, category, artist, time, source = 'manual' } = {}) {
    if (this.openSection()) return { ok: false, error: 'Es läuft bereits ein Abschnitt – zuerst beenden.' };
    const t = time == null ? this.duration : Math.max(0, time);
    const section = {
      id: newId('sec'),
      ctId: null,
      label: label || `Abschnitt ${this.placedSections().length + 1}`,
      category: category || null,
      plannedDuration: null,
      artist: artist || null,
      order: this.sections.length,
      color: this._nextColor(),
      start: t,
      end: null,
      source
    };
    this.sections.push(section);
    this._changed();
    return { ok: true, section };
  }

  /** Beendet den laufenden Abschnitt. */
  endSection(time) {
    const open = this._closeOpen(time == null ? this.duration : time);
    if (!open) return { ok: false, error: 'Es läuft kein Abschnitt.' };
    this._changed();
    return { ok: true, section: open };
  }

  /** "Marker setzen": beendet den laufenden Abschnitt, sonst beginnt ein neuer. */
  toggleSection(params = {}) {
    return this.openSection() ? { ...this.endSection(params.time), change: 'ended' }
      : { ...this.startSection(params), change: 'started' };
  }

  /**
   * Beginnt einen Ablaufplan-Punkt. Ein gerade laufender Abschnitt endet dabei
   * an derselben Stelle. Außerhalb der Aufnahme (Nachbearbeiten) wird der
   * Abschnitt sofort mit Ende gesetzt.
   */
  startPending(id, time) {
    const x = this.sections.find((y) => y.id === id && y.start == null);
    if (!x) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const live = this.status === 'recording' || this.status === 'paused';
    // Vor der ersten Aufnahme gibt es noch keine Zeitachse: Der Punkt beginnt bei 0 und läuft offen mit,
    // sobald die Aufnahme startet (sonst stünde er als 0:00–0:00 da und der Start übersähe ihn).
    const waiting = this.status === 'idle';
    const t = waiting ? 0 : Math.max(0, time == null ? this.duration : time);
    if (waiting && this.placedSections().some((o) => o !== x)) {
      return { ok: false, error: 'Vor dem Start der Aufnahme lässt sich nur ein Punkt vorab beginnen.' };
    }
    const open = this.openSection();
    const placed = this.placedSections().filter((o) => o !== x);

    // Prüfen, bevor etwas verändert wird: ein umschließender Abschnitt wird an dieser
    // Stelle beendet, darf dadurch aber nicht verschwinden.
    const cut = placed.filter((o) => o.end != null && o.start < t && o.end > t);
    if (cut.some((o) => t - o.start < MIN_SECTION)) {
      return { ok: false, error: 'Zu nah am Anfang eines bestehenden Abschnitts.' };
    }
    const next = placed.filter((o) => o.start >= t).sort((a, b) => a.start - b.start)[0];
    if (next && next.start - t < MIN_SECTION) {
      return { ok: false, error: 'Dort beginnt bereits ein anderer Abschnitt.' };
    }

    if (open && t > open.start) open.end = t;   // liegt die Stelle davor, bleibt der laufende unberührt
    cut.forEach((o) => { o.end = t; });
    x.start = t;
    if (next) {
      // Bis zum nächsten Abschnitt, höchstens die geplante Dauer.
      x.end = x.plannedDuration ? Math.min(t + x.plannedDuration, next.start) : next.start;
      x.end = Math.max(x.end, t + MIN_SECTION);
    } else if (!live && !waiting) {
      const planned = x.plannedDuration ? t + x.plannedDuration : this.duration;
      x.end = Math.min(Math.max(planned, t + MIN_SECTION), Math.max(this.duration, t + MIN_SECTION));
    }
    this._changed();
    return { ok: true, section: x };
  }

  /**
   * Legt einen Ablaufpunkt per Drag & Drop an einer beliebigen Stelle ab.
   * - In einer Lücke zwischen zwei Abschnitten (oder vor dem ersten) füllt er genau diese Lücke.
   * - Hinter dem letzten Abschnitt beginnt er an der Ablagestelle.
   * - Mitten in einem bestehenden Abschnitt beginnt er dort und kürzt diesen.
   */
  placePending(id, time) {
    const x = this.sections.find((y) => y.id === id && y.start == null);
    if (!x) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const t = Math.max(0, time == null ? this.duration : time);
    const placed = this.placedSections();
    const endOf = (o) => SectionLogic.endOf(o, this.duration);

    const inside = placed.some((o) => o.start <= t && endOf(o) > t);
    const next = placed.find((o) => o.start > t);
    if (inside || !next) return this.startPending(id, t);

    const prevEnds = placed.filter((o) => endOf(o) <= t).map(endOf);
    const gapStart = prevEnds.length ? Math.max(...prevEnds) : 0;
    if (next.start - gapStart < MIN_SECTION) return { ok: false, error: 'Die Lücke ist zu klein.' };
    x.start = gapStart;
    x.end = next.start;
    this._changed();
    return { ok: true, section: x };
  }

  /** Neuen offenen Ablaufpunkt am Ende des Ablaufplans anlegen. */
  addPending({ label, artist } = {}) {
    const name = String(label || '').trim();
    if (!name) return { ok: false, error: 'Bitte einen Namen eingeben.' };
    const maxOrder = this.pendingSections().reduce((m, x) => Math.max(m, x.order || 0), -1);
    const section = {
      id: newId('sec'),
      ctId: null,
      label: name,
      category: null,
      plannedDuration: null,
      artist: artist ? String(artist).trim() || null : null,
      order: maxOrder + 1,
      color: this._nextColor(),
      start: null,
      end: null,
      source: 'plan'
    };
    this.sections.push(section);
    this._changed();
    return { ok: true, section };
  }

  /** Verschiebt einen offenen Ablaufpunkt vor einen anderen (beforeId = null: ans Ende). */
  reorderPending(id, beforeId) {
    const list = this.pendingSections().sort((a, b) => (a.order || 0) - (b.order || 0));
    const moving = list.find((x) => x.id === id);
    if (!moving) return { ok: false, error: 'Ablaufpunkt nicht gefunden.' };
    const rest = list.filter((x) => x !== moving);
    const at = beforeId ? rest.findIndex((x) => x.id === beforeId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, moving);
    rest.forEach((x, i) => { x.order = i; });
    this._changed();
    return { ok: true };
  }

  /** Beendet einen laufenden Abschnitt und beginnt den nächsten offenen Ablaufpunkt. */
  startNextPending(time) {
    const pending = this.pendingSections().sort((a, b) => (a.order || 0) - (b.order || 0));
    if (pending.length === 0) {
      const closed = this.openSection() ? this.endSection(time) : null;
      return closed || { ok: false, error: 'Keine offenen Ablaufplan-Punkte mehr.' };
    }
    return this.startPending(pending[0].id, time);
  }

  /** Verschiebt Anfang oder Ende eines Abschnitts; Nachbarn weichen aus, nichts überlappt. */
  moveEdge(id, edge, time) {
    const result = SectionLogic.moveEdge(this.sections, id, edge, time, this.duration);
    if (!result) return null;
    this._changed();
    return result.section;
  }

  /** Merkt, dass ein Abschnitt als MP3 gesichert wurde (mit Zeitraum, um spätere Änderungen zu erkennen). */
  recordExport(segmentId, { file, start, end, cuts }) {
    this.exports[segmentId] = { file, start, end, cuts: cuts || [], at: new Date().toISOString() };
    this._changed();
    this.save();
  }

  updateSection(id, patch) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return null;
    if (patch.label != null) x.label = patch.label;
    if (patch.category !== undefined) x.category = patch.category;
    if (patch.artist !== undefined) x.artist = patch.artist ? String(patch.artist).trim() || null : null;
    this._changed();
    return x;
  }

  removeSection(id) {
    const x = this.sections.find((y) => y.id === id);
    if (!x) return false;
    // Ablaufplan-Punkte (egal ob aus ChurchTools oder selbst angelegt) werden von der Zeitachse
    // genommen und bleiben offen; offene Punkte und selbst gesetzte Abschnitte werden gelöscht.
    if (x.source !== 'manual' && x.start != null) {
      x.start = null;
      x.end = null;
    } else {
      this.sections = this.sections.filter((y) => y.id !== id);
    }
    this._changed();
    return true;
  }

  /* ----------------------------------------------------------------- Aufnahme */

  /**
   * @param {object} [o]
   * @param {{writer:object, tracks:object[], base:string, folder:string}} [o.multitrack] Mehrspuraufnahme: Die
   *   Dateien hat der Mehrspur-Prozess schon angelegt (`multitrackTarget`), `writer` ist sein Stellvertreter.
   */
  start({ sampleRate, channels, multitrack } = {}) {
    if (this.status === 'recording') return { ok: false, error: 'Es läuft bereits eine Aufnahme.' };
    if (this.status === 'paused') return this.resume();

    const rate = multitrack ? multitrack.writer.sampleRate : (sampleRate || this.sampleRate);
    const ch = multitrack ? multitrack.tracks.length : (channels || 2);

    let writer;
    let base;
    if (multitrack) {
      ({ writer, base } = multitrack);
    } else {
      const dir = settings.get('recordingsDir');
      fs.mkdirSync(dir, { recursive: true });

      // Erst die Datei anlegen: Scheitert das (Ordner nicht beschreibbar …), bleibt die bisher
      // angezeigte Aufnahme samt Abschnitten unverändert.
      base = this._freeBasePath(path.join(dir, this._recordingName()));
      try {
        writer = new WavWriter(`${base}.wav`, rate, ch);
      } catch (err) {
        return { ok: false, error: 'Die Aufnahmedatei konnte nicht angelegt werden: ' + err.message };
      }
    }
    this.flushSave();

    // Eine frühere Aufnahme bleibt als Datei erhalten; die Abschnitte gehören aber
    // zu ihr und werden für die neue Aufnahme zurückgesetzt.
    if (this.status === 'stopped') this._resetSectionsForNewRecording();
    this.cuts = [];

    this.sampleRate = rate;
    this.channels = ch;
    this.basePath = base;
    this.mode = multitrack ? 'multitrack' : 'stereo';
    this.tracks = multitrack
      ? multitrack.tracks.map(({ channel, name, color, file }) => ({ channel, name, color: color ?? null, file: path.basename(file) }))
      : [];
    this.trackDir = multitrack ? multitrack.folder : null;
    this.wavPath = multitrack ? null : `${base}.wav`;
    this.writer = writer;
    this._attachWriter(writer);
    this.startedAt = new Date().toISOString();
    this.status = 'recording';
    this.finalized = false;
    this._cueKey = null;
    this.peaks = [];
    this.gaps = [];
    this._startLoudness(rate, ch, 0);
    this._restoredDuration = 0;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this.levels = { l: 0, r: 0, clip: false };

    // Der erste offene Ablaufpunkt beginnt gleich mit der Aufnahme (ohne Punkte passiert nichts).
    if (!this.openSection()) this.startNextPending(0);

    this._startAutosave();
    this._changed({ undoable: false });
    this._resetUndo();
    this.save();                 // Session-Datei sofort anlegen, damit auch ein früher Absturz wiederherstellbar ist
    this.emit('recording-started', { wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels, mode: this.mode });
    return { ok: true, wavPath: this.wavPath, mode: this.mode, trackDir: this.trackDir };
  }

  /** Name einer neuen Aufnahme: Datum, Uhrzeit, Gottesdienst. */
  _recordingName() {
    const stamp = `${dateStamp()}_${new Date().toTimeString().slice(0, 5).replace(':', '')}`;
    return `${stamp}_${slug(this.service.name, 'Gottesdienst')}`;
  }

  /**
   * Ordner für eine neue Mehrspuraufnahme (wird angelegt, nie ein vorhandener) und Pfad der Session-Datei
   * darin (ohne Endung). Die Spuren legt danach der Mehrspur-Prozess in diesem Ordner an.
   */
  multitrackTarget(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const name = this._recordingName();
    let folder = path.join(dir, name);
    for (let n = 2; fs.existsSync(folder); n++) folder = path.join(dir, `${name}_${n}`);
    fs.mkdirSync(folder);
    return { folder, base: path.join(folder, path.basename(folder)) };
  }

  /** Mehrspur: Spuren mit vollem Pfad. */
  trackFiles() {
    return this.tracks.map((t) => ({ ...t, file: path.join(this.trackDir, t.file) }));
  }

  /** Hängt bei Namensgleichheit (gleiche Minute) eine Nummer an, damit nie eine Aufnahme überschrieben wird. */
  _freeBasePath(base) {
    let candidate = base;
    for (let n = 2; fs.existsSync(`${candidate}.wav`) || fs.existsSync(`${candidate}.session.json`); n++) {
      candidate = `${base}_${n}`;
    }
    return candidate;
  }

  /** Ablaufplan-Punkte werden wieder offen, selbst angelegte Abschnitte entfallen. */
  _resetSectionsForNewRecording() {
    this.exports = {};
    this.sections = this.sections
      .filter((x) => x.source !== 'manual')
      .map((x) => ({ ...x, start: null, end: null }));
  }

  /**
   * Trägt die Abschnitte als Cue-Marker in die WAV ein (nur bei beendeter, vollständig geschriebener Aufnahme;
   * läuft wieder, wenn sich die Abschnitte ändern). Fehler stören nicht: Die Session-Datei bleibt maßgeblich.
   */
  _syncCues() {
    if (this.status !== 'stopped' || this.writing || !this.wavPath) return;
    const rate = this.sampleRate;
    const points = this.sections
      .filter((x) => x.start != null)
      .slice()
      .sort((a, b) => a.start - b.start)
      .map((x) => ({
        frame: x.start * rate,
        length: x.end != null ? (x.end - x.start) * rate : 0,
        label: x.artist ? `${x.label} (${x.artist})` : x.label
      }));
    const key = JSON.stringify(points);
    if (key === this._cueKey) return;
    try {
      if (!fs.existsSync(this.wavPath)) return;
      writeCues(this.wavPath, points);
      this._cueKey = key;
    } catch (err) {
      console.error('Cue-Marker konnten nicht in die WAV geschrieben werden:', err.message);
    }
  }

  /**
   * Setzt die beendete Aufnahme fort: neue Audiodaten werden an die WAV-Datei angehängt.
   * @param {{writer?: object}} [o] Mehrspur: Stellvertreter des Mehrspur-Prozesses, der bereits anhängt
   */
  continueRecording({ writer } = {}) {
    if (this.status !== 'stopped') return { ok: false, error: 'Es gibt keine beendete Aufnahme zum Fortsetzen.' };
    if (this.mode === 'multitrack') {
      if (!writer) return { ok: false, error: 'Die Mehrspuraufnahme kann so nicht fortgesetzt werden.' };
      this.writer = writer;
    } else {
      if (!this.wavPath || !fs.existsSync(this.wavPath)) {
        return { ok: false, error: 'Die Audiodatei dieser Aufnahme wurde nicht gefunden.' };
      }
      const info = readInfo(this.wavPath);
      this.sampleRate = info.sampleRate;
      this.channels = info.channels;
      this.writer = new WavWriter(this.wavPath, this.sampleRate, this.channels, { append: true });
    }
    this._cueKey = null;
    this._attachWriter(this.writer);
    this.status = 'recording';
    this.finalized = false;
    this._bucketAcc = 0;
    this._bucketFrames = 0;
    this.levels = { l: 0, r: 0, clip: false };
    // Wellenform bis zum Dateiende auffüllen, falls die Peak-Daten kürzer sind.
    const wanted = Math.floor((this.writer.durationSeconds * 1000) / PEAK_BUCKET_MS);
    while (this.peaks.length < wanted) this.peaks.push(0);
    this.peaks.length = Math.min(this.peaks.length, wanted);
    this._startLoudness(this.sampleRate, this.channels, this.writer.durationSeconds);

    this._startAutosave();
    this._changed();
    this.emit('recording-started', { wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels, mode: this.mode });
    return { ok: true, wavPath: this.wavPath, sampleRate: this.sampleRate, channels: this.channels, mode: this.mode };
  }

  /**
   * Mehrspur: Nach einem Absturz des Mehrspur-Prozesses schreibt ein neu gestarteter weiter in dieselben Spuren
   * (angehängt). Die Aufnahme läuft dabei ohne Unterbrechung weiter; Abschnitte und Pause bleiben, wie sie sind.
   */
  replaceWriter(writer) {
    if (this.status !== 'recording' && this.status !== 'paused') return false;
    this.writer = writer;
    this._attachWriter(writer);
    if (this.status === 'paused' && writer.pause) writer.pause();
    // Wellenform an die Länge der Spuren angleichen (die letzten Pegelmeldungen vor dem Absturz fehlen ggf.).
    const wanted = Math.floor((writer.durationSeconds * 1000) / PEAK_BUCKET_MS);
    while (this.peaks.length < wanted) this.peaks.push(0);
    this.peaks.length = Math.min(this.peaks.length, wanted);
    this._changed({ undoable: false });
    this.save();
    return true;
  }

  /* -------------------------------------------------------------- Lautheit */

  /**
   * Lautheitsmessung für eine (fortgesetzte) Stereo-Aufnahme: Die Kurve wird auf die Länge der Aufnahme gebracht
   * (beim Anhängen mit Lücke = Stille aufgefüllt), danach wächst sie mit jedem Audioblock. Mehrspur misst nicht
   * (es gibt keinen Stereo-Mix).
   */
  _startLoudness(rate, channels, seconds) {
    this._loudJob += 1;
    if (this.mode === 'multitrack') {
      this._loudMeter = null;
      this.loudness = [];
    } else {
      this._loudMeter = new LoudnessMeter(rate, channels);
      const wanted = Math.floor(seconds * Loudness.STEPS_PER_SECOND);
      const list = seconds > 0 ? this.loudness.slice(0, wanted) : [];
      while (list.length < wanted) list.push(null);
      this.loudness = list;
    }
    this._loudCurve = new Loudness.Curve(this.loudness);
    this._loudInfo = null;
  }

  /** Neue Messwerte aus dem Audioblock; liefert die neuen 100-ms-Werte und die aktuelle Anzeige. */
  _measureLoudness(buffer, frames) {
    if (!this._loudMeter) return null;
    const samples = buffer.byteOffset % 2 === 0
      ? new Int16Array(buffer.buffer, buffer.byteOffset, frames * this.channels)
      : new Int16Array(Buffer.from(buffer).buffer, 0, frames * this.channels);
    this._loudMeter.push(samples, frames);
    const steps = this._loudMeter.steps.map(Loudness.stepValue);
    this._loudMeter.steps.length = 0;
    if (steps.length) this._loudCurve.push(steps);
    return { steps, ...this.loudnessInfo() };
  }

  /**
   * Anzeige: Momentary (0,4 s), Short-term (3 s), integriert über die ganze Aufnahme und über den laufenden
   * Abschnitt (LUFS, null = Stille). Die integrierten Werte höchstens einmal je Sekunde neu rechnen.
   */
  loudnessInfo() {
    const c = this._loudCurve;
    const num = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
    const now = Date.now();
    if (!this._loudInfo || now - this._loudInfo.at > 1000) {
      const open = this.openSection();
      this._loudInfo = {
        at: now,
        integrated: num(c.integrated()),
        section: open ? num(c.integrated(open.start * Loudness.STEPS_PER_SECOND)) : null
      };
    }
    return { momentary: num(c.momentary()), shortTerm: num(c.shortTerm()), integrated: this._loudInfo.integrated, section: this._loudInfo.section };
  }

  /**
   * Geladene Stereo-Aufnahme ohne gespeicherte Lautheit (älter als diese Funktion): im Hintergrund aus der WAV
   * messen, in Stücken von 5 s Audio, damit der Hauptprozess bedienbar bleibt. Meldet 'loudness' mit der Kurve.
   */
  async _computeLoudness() {
    const job = ++this._loudJob;
    const file = this.wavPath;
    try {
      const info = readInfo(file);
      const meter = new LoudnessMeter(info.sampleRate, info.channels);
      const chunk = info.sampleRate * 5;
      for (let f = 0; f < info.frames; f += chunk) {
        const { samples } = readFrames(file, f, chunk, info);
        meter.push(samples, samples.length / info.channels);
        await new Promise((r) => setImmediate(r));
        if (job !== this._loudJob) return;          // inzwischen andere Aufnahme geladen oder neu begonnen
      }
      this.loudness = meter.steps.map(Loudness.stepValue);
      this._loudCurve = new Loudness.Curve(this.loudness);
      this._loudInfo = null;
      this.emit('loudness', { loudness: this.loudness });
      this.save();
    } catch (err) {
      console.warn('Lautheit konnte nicht nachberechnet werden:', err.message);
    }
  }

  /** Fehler und Engpässe des Schreib-Threads weitergeben (Platte voll, Laufwerk zu langsam …). */
  _attachWriter(writer) {
    writer.on('error', (err) => this.emit('write-error', err));
    writer.on('slow', (slow) => this.emit('write-slow', slow));
  }

  /** Erfüllt sich, sobald die zuletzt beendete Aufnahme vollständig auf der Platte ist. */
  whenWritten() {
    return this._closing || Promise.resolve();
  }

  pause() {
    if (this.status !== 'recording') return { ok: false, error: 'Es läuft keine Aufnahme.' };
    this.status = 'paused';
    if (this.writer) {
      this.writer.updateHeader();
      if (this.writer.pause) this.writer.pause();      // Mehrspur: der Mehrspur-Prozess verwirft dann das Audio
    }
    this.save();
    this._changed();
    return { ok: true };
  }

  resume() {
    if (this.status !== 'paused') return { ok: false, error: 'Die Aufnahme ist nicht pausiert.' };
    this.status = 'recording';
    if (this.writer && this.writer.resume) this.writer.resume();
    this._changed();
    return { ok: true };
  }

  stop() {
    if (this.status !== 'recording' && this.status !== 'paused') {
      return { ok: false, error: 'Es läuft keine Aufnahme.' };
    }
    this._restoredDuration = this.duration;
    this._closeOpen(this._restoredDuration);
    this._closeOpenCuts(this._restoredDuration);
    // Der Schreib-Thread leert seine Warteschlange und schließt die Datei; whenWritten() wartet darauf.
    this._closing = this.writer ? this.writer.close() : null;
    if (this._closing) {
      this.writing = true;
      this._closing.finally(() => { this.writing = false; this._syncCues(); });
    }
    this.status = 'stopped';
    this.finalized = true;
    this._stopAutosave();
    this.save();
    this._changed({ undoable: false });
    this._resetUndo();
    this.emit('recording-stopped', { wavPath: this.wavPath, duration: this._restoredDuration });
    return { ok: true, wavPath: this.wavPath, duration: this._restoredDuration };
  }

  /**
   * Nimmt einen Audioblock aus dem Renderer entgegen (Int16LE, interleaved).
   * Berechnet nebenbei Pegel und Wellenform-Spitzenwerte.
   */
  pushAudio(buffer) {
    if (this.status !== 'recording' || !this.writer) return;
    this.writer.write(buffer);

    const ch = this.channels;
    const frames = buffer.length / (2 * ch);
    let peakL = 0;
    let peakR = 0;
    const bucketFrames = Math.round((this.sampleRate * PEAK_BUCKET_MS) / 1000);

    for (let f = 0; f < frames; f++) {
      const l = Math.abs(buffer.readInt16LE(f * ch * 2)) / 32768;
      const r = ch > 1 ? Math.abs(buffer.readInt16LE(f * ch * 2 + 2)) / 32768 : l;
      if (l > peakL) peakL = l;
      if (r > peakR) peakR = r;
      const m = Math.max(l, r);
      if (m > this._bucketAcc) this._bucketAcc = m;
      this._bucketFrames += 1;
      if (this._bucketFrames >= bucketFrames) {
        this.peaks.push(Math.round(this._bucketAcc * 255));
        this._bucketAcc = 0;
        this._bucketFrames = 0;
      }
    }

    const now = Date.now();
    if (peakL >= 0.999 || peakR >= 0.999) this._clipUntil = now + 2000;
    this.levels = { l: peakL, r: peakR, clip: now < this._clipUntil };

    this.emit('levels', { ...this.levels, duration: this.duration, loudness: this._measureLoudness(buffer, frames) });
  }

  /**
   * Füllt einen Aussetzer des Eingangs mit Stille, damit die Zeitachse zur Uhr passt: Sonst fehlen die Sekunden
   * einfach, Abschnitte hinter der Lücke liegen zu früh und beim Abhören springt die Aufnahme. Läuft über
   * `pushAudio` (Wellenform, Lautheit und Dauer wachsen mit) in Blöcken zu 0,5 s.
   * @returns {number} eingefügte Sekunden (0, wenn nicht aufgenommen wird oder Mehrspur)
   */
  fillGap(seconds) {
    if (this.status !== 'recording' || !this.writer || this.mode === 'multitrack') return 0;
    const total = Math.min(Math.round(seconds * this.sampleRate), Math.round(MAX_GAP_FILL_SECONDS * this.sampleRate));
    if (!(total > 0)) return 0;
    const at = this.duration;
    const block = Math.round(this.sampleRate / 2);
    for (let done = 0; done < total; done += block) {
      this.pushAudio(Buffer.alloc(Math.min(block, total - done) * this.channels * 2));
    }
    const filled = Math.round((total / this.sampleRate) * 10) / 10;
    this.gaps.push({ at: Math.round(at * 10) / 10, seconds: filled });
    this._scheduleSave();
    return filled;
  }

  /**
   * Mehrspur: Pegel aus dem Mehrspur-Prozess (statt `pushAudio`). Der Pegel der Session ist der lauteste
   * aufgenommene Kanal; die Wellenform wächst um die mitgelieferten Spitzenwerte (`buckets`, je 50 ms).
   */
  pushTrackLevels({ peaks = [], clips = [], buckets = [] } = {}) {
    if (this.mode !== 'multitrack' || (this.status !== 'recording' && this.status !== 'paused')) return;
    const grow = this.status === 'recording' ? buckets : [];
    for (const b of grow) this.peaks.push(b);
    let max = 0;
    let clip = false;
    for (const t of this.tracks) {
      max = Math.max(max, peaks[t.channel] || 0);
      if (clips[t.channel]) clip = true;
    }
    const now = Date.now();
    if (clip) this._clipUntil = now + 2000;
    this.levels = { l: max, r: max, clip: now < this._clipUntil };
    this.emit('levels', { ...this.levels, duration: this.duration, tracks: { peaks, clips }, buckets: grow });
  }

  /**
   * Liest einen Ausschnitt der Aufnahme zum Mithören – auch während sie läuft.
   * Beim Schreiben wird jeder Block sofort in die Datei übergeben, daher
   * genügt ein separater Lesezugriff.
   */
  readAudio(startSec, seconds) {
    if (!this.wavPath || !fs.existsSync(this.wavPath)) return null;
    const start = Math.max(0, startSec || 0);
    const end = Math.min(start + Math.min(Math.max(seconds || 1, 0.1), 10), this.duration);
    if (end <= start) return { sampleRate: this.sampleRate, channels: this.channels, samples: new Int16Array(0) };
    return readSlice(this.wavPath, start, end);
  }

  /* -------------------------------------------------------- Speichern / Laden */

  _startAutosave() {
    this._stopAutosave();
    this._autosave = setInterval(() => {
      // Wellenform und Dauer ändern sich laufend, ohne dass etwas "dirty" wird: spätestens alle 30 s sichern,
      // damit eine unterbrochene Aufnahme mit (fast) vollständiger Wellenform wiederhergestellt wird.
      const stale = this.status === 'recording' && Date.now() - (this._lastSave || 0) > 30000;
      if (this._dirty || stale) this.save();
    }, AUTOSAVE_MS);
  }

  _stopAutosave() {
    if (this._autosave) clearInterval(this._autosave);
    this._autosave = null;
  }

  sessionFilePath() {
    return this.basePath ? `${this.basePath}.session.json` : null;
  }

  save() {
    const target = this.sessionFilePath();
    if (!target) return;
    const data = {
      version: 2,
      app: 'ebbton',
      service: this.service,
      agendaOrigin: this.agendaOrigin,
      status: this.status,
      finalized: this.finalized,
      startedAt: this.startedAt,
      sampleRate: this.sampleRate,
      channels: this.channels,
      duration: this.duration,
      wavPath: this.wavPath,
      mode: this.mode,
      tracks: this.tracks,
      sections: this.sections,
      exports: this.exports,
      cuts: this.cuts,
      gaps: this.gaps,
      peaks: this.peaks,
      loudness: this.mode === 'multitrack' ? undefined : this.loudness
    };
    try {
      fs.writeFileSync(target + '.tmp', JSON.stringify(data), 'utf8');
      fs.renameSync(target + '.tmp', target);
      this._dirty = false;
      this._lastSave = Date.now();
      this._syncCues();
    } catch (err) {
      console.error('Session konnte nicht gespeichert werden:', err);
      this.emit('error-notice', 'Die Session-Datei konnte nicht gespeichert werden.');
    }
  }

  /** Lädt eine gespeicherte Session zum Nachbearbeiten/Exportieren. */
  loadFromFile(sessionPath) {
    const data = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    this.reset();
    this.basePath = sessionPath.replace(/\.session\.json$/, '');
    this.mode = data.mode === 'multitrack' ? 'multitrack' : 'stereo';
    if (this.mode === 'multitrack') {
      // Spuren liegen neben der Session-Datei: So bleibt die Aufnahme auch nach dem Verschieben des Ordners gültig.
      this.tracks = Array.isArray(data.tracks) ? data.tracks : [];
      this.trackDir = path.dirname(sessionPath);
      this.wavPath = null;
    } else {
      this.wavPath = data.wavPath && fs.existsSync(data.wavPath) ? data.wavPath : `${this.basePath}.wav`;
    }
    this.service = data.service || this.service;
    this.agendaOrigin = data.agendaOrigin || null;
    this.peaks = data.peaks || [];
    this.gaps = Array.isArray(data.gaps) ? data.gaps : [];
    this.loudness = Array.isArray(data.loudness) ? data.loudness : [];
    this._loudCurve = new Loudness.Curve(this.loudness);
    this.sampleRate = data.sampleRate || this.sampleRate;
    this.channels = data.channels || 2;
    this.startedAt = data.startedAt || null;
    this.status = 'stopped';
    this.finalized = true;
    this.writer = null;

    let duration = data.duration || 0;
    try {
      const audio = this.mode === 'multitrack' ? this.trackFiles().map((t) => t.file).find((f) => fs.existsSync(f)) : this.wavPath;
      if (audio && fs.existsSync(audio)) duration = readInfo(audio).duration;
    } catch { /* Dauer aus der Session-Datei verwenden */ }
    this._restoredDuration = duration;
    this.sections = migrateSections(data, duration);
    this.exports = data.exports || {};
    this.cuts = (data.cuts || []).map((c) => ({ ...c, end: c.end != null ? c.end : duration })).filter((c) => c.end - c.start >= MIN_CUT);
    this._colorSeq = this.sections.reduce((m, x) => Math.max(m, (x.color ?? -1) + 1), 0);

    this._changed({ undoable: false });
    this._resetUndo();
    // Eine unterbrochene Aufnahme gilt nach dem Öffnen als wiederhergestellt: so in der Datei vermerken,
    // sonst wird sie bei jedem Start erneut als "unterbrochen" gemeldet.
    if (data.finalized === false || data.status === 'recording' || data.status === 'paused') this.save();
    // Ältere oder unterbrochene Aufnahmen ohne (vollständige) Lautheit: im Hintergrund nachmessen.
    const steps = Math.floor(duration * Loudness.STEPS_PER_SECOND);
    if (this.mode === 'stereo' && this.wavPath && fs.existsSync(this.wavPath) && this.loudness.length < steps - Loudness.STEPS_PER_SECOND) {
      this._computeLoudness();
    }
    return this.snapshot();
  }
}

module.exports = { Session, slug, dateStamp, PEAK_BUCKET_MS };
