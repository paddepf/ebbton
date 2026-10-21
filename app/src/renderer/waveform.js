/* Wellenform-Ansicht: zeichnet die laufende Aufnahme und die Abschnitte
   (je eine Anfangs- und Endmarke), erlaubt Verschieben der Marken und
   Ablegen offener Ablaufplan-Punkte. */

(function () {
  'use strict';

  const BUCKET_SEC = 0.05;   // Auflösung der Peak-Daten (muss zu session.js passen)
  const RULER_H = 22;
  const PAN_THRESHOLD = 4;   // ab so vielen Pixeln Bewegung ist ein Klick ein Ziehen (Ansicht verschieben)
  const FLAG_H = 26;
  const STRIPE_H = 4;        // Farbstreifen des Abschnitts unter den Fähnchen
  const FLASH_MS = 350;      // so lange blendet eine neu gesetzte Marke ein
  // Feste Palette der Abschnitte (CSS-Variablen --sec-0 … --sec-7, je Farbschema abgestimmt), Index = section.color.
  const SECTION_COLORS = 8;
  const HUES = [212, 28, 150, 300, 48, 182, 346, 262];        // nur Rückfall, falls die Palette fehlt
  const paletteIndex = (section) => ((section && section.color) || 0) % SECTION_COLORS;
  /** CSS-Wert der Abschnittsfarbe, z. B. für style.setProperty('--sec', …); folgt dem Farbschema von selbst. */
  const sectionColorVar = (section) => `var(--sec-${paletteIndex(section)})`;

  // Bereich der Lautheitsanzeige (LUFS)
  const LOUD_MIN = -50;
  const LOUD_MAX = -5;

  /** LUFS-Wert für die Anzeige: „−19,4“ (Stille „–“); digits = Nachkommastellen. */
  function lufsText(v, digits = 1) {
    if (!Number.isFinite(v) || v <= -70) return '–';
    return v.toFixed(digits).replace('.', ',').replace('-', '−');
  }

  function fmt(t) {
    if (!isFinite(t) || t < 0) t = 0;
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = Math.floor(t % 60);
    const p = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }

  class Waveform {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.peaks = [];
      this.duration = 0;
      this.sections = [];
      this.cuts = [];             // Schnitte: {id,start,end|null}, beim MP3-Export ausgelassen
      this.pendingCut = null;     // Schnitt, der gerade mit Umschalt+Ziehen aufgezogen wird
      this.draggingCut = null;
      this._hit = [];             // Trefferflächen der Griffe, beim Zeichnen gefüllt
      this.hoverHandle = null;    // Start-Fähnchen unter dem Zeiger
      this.pxPerSec = opts.pxPerSec || 12;
      this.scrollT = 0;
      this.playhead = 0;          // Hörposition (null = keine)
      this.follow = true;
      this.recording = false;
      this.selectedSegment = null;
      this.hoverTime = null;
      this.dragging = null;
      this.colors = opts.colors || {};
      this._seen = null;          // bekannte Abschnitte (neu gesetzte blenden während der Aufnahme kurz ein)
      this._flash = new Map();    // id → Zeitpunkt des Setzens
      this.overview = opts.overviewCanvas ? new Overview(opts.overviewCanvas, this) : null;
      // Lautheit (LUFS): Kurve (window.LoudnessCurve.Curve), an/aus, Ziel (Export) und ob die Aufnahme läuft/pausiert
      this.loudness = null;
      this.loudnessOn = false;
      this.loudnessTarget = null;
      this.loudnessLive = false;
      this._loudCache = null;

      this.onEdgeMove = opts.onEdgeMove || (() => {});
      this.onEdgeMoveEnd = opts.onEdgeMoveEnd || (() => {});
      this.onSeek = opts.onSeek || (() => {});
      this.onSelectSection = opts.onSelectSection || (() => {});
      this.onDropPending = opts.onDropPending || (() => {});
      this.onRenameSection = opts.onRenameSection || (() => {});
      this.onFollowChange = opts.onFollowChange || (() => {});
      this.onCutAdd = opts.onCutAdd || (() => {});
      this.onCutMoveEnd = opts.onCutMoveEnd || (() => {});
      this.onCutRemove = opts.onCutRemove || (() => {});
      this.onLoudness = opts.onLoudness || (() => {});   // Messwerte für die Anzeige außerhalb der Wellenform

      this._bind();
      this.resize();
    }

    /* ------------------------------------------------------------ Geometrie */

    get width() { return this.canvas.clientWidth; }
    get height() { return this.canvas.clientHeight; }
    get viewSeconds() { return this.width / this.pxPerSec; }

    timeToX(t) { return (t - this.scrollT) * this.pxPerSec; }
    xToTime(x) { return this.scrollT + x / this.pxPerSec; }

    clampScroll() {
      if (!Number.isFinite(this.scrollT)) this.scrollT = 0;
      const max = Math.max(0, this.duration - this.viewSeconds * 0.98);
      this.scrollT = Math.min(Math.max(0, this.scrollT), Math.max(0, max));
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
      this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.draw();
    }

    setZoom(pxPerSec, anchorTime) {
      if (!this.width) {
        // Ohne Breite gibt es keinen sichtbaren Ausschnitt (Division durch 0 → scrollT NaN)
        this.pxPerSec = Math.min(300, Math.max(0.05, pxPerSec));
        return;
      }
      const anchor = anchorTime == null ? this.scrollT + this.viewSeconds / 2 : anchorTime;
      const rel = (anchor - this.scrollT) / this.viewSeconds;
      this.pxPerSec = Math.min(300, Math.max(0.05, pxPerSec));
      this.scrollT = anchor - rel * this.viewSeconds;
      this.clampScroll();
      this.draw();
    }

    scrollTo(t, center = true) {
      this.scrollT = center ? t - this.viewSeconds / 2 : t;
      this.follow = false;
      this.onFollowChange(false);
      this.clampScroll();
      this.draw();
    }

    update({ peaks, duration, sections, cuts, playhead, recording, selectedSegment }) {
      if (peaks) this.peaks = peaks;
      if (duration != null) this.duration = duration;
      if (sections) this.sections = sections;
      if (cuts) this.cuts = cuts;
      if (playhead !== undefined) this.playhead = playhead;
      if (recording != null) this.recording = recording;
      if (selectedSegment !== undefined) this.selectedSegment = selectedSegment;
      if (sections) this._noteNewSections();

      if (this.recording && this.follow) {
        this.scrollT = Math.max(0, this.duration - this.viewSeconds * 0.85);
      }
      this.draw();
    }

    /** Farbe eines Abschnitts aus der Palette des Farbschemas. */
    secColor(section) {
      const list = this.colors.sections;
      const c = list && list[paletteIndex(section)];
      return c || `hsl(${HUES[paletteIndex(section)]}, 55%, 62%)`;
    }

    /** Während der Aufnahme neu gesetzte Abschnitte merken, damit ihre Marke kurz einblendet. */
    _noteNewSections() {
      const placed = this.sections.filter((x) => x.start != null);
      const ids = new Set(placed.map((x) => x.id));
      if (this._seen && this.recording) {
        const now = performance.now();
        placed.forEach((x) => { if (!this._seen.has(x.id)) this._flash.set(x.id, now); });
        if (this._flash.size) this._animateFlash();
      }
      this._seen = ids;
    }

    _animateFlash() {
      if (this._flashRaf) return;
      const step = () => {
        const now = performance.now();
        for (const [id, t0] of this._flash) if (now - t0 > FLASH_MS) this._flash.delete(id);
        this.draw();
        this._flashRaf = this._flash.size ? requestAnimationFrame(step) : null;
      };
      this._flashRaf = requestAnimationFrame(step);
    }

    /** 0 … 1: wie weit die Marke eines eben gesetzten Abschnitts eingeblendet ist (1 = fertig). */
    _flashLevel(id) {
      const t0 = this._flash.get(id);
      if (t0 == null) return 1;
      return Math.min(1, (performance.now() - t0) / FLASH_MS);
    }

    /* ------------------------------------------------------------ Zeichnen */

    draw() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      if (!w || !h) return;
      const c = this.colors;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = c.bg || '#131A21';
      ctx.fillRect(0, 0, w, h);

      const laneTop = RULER_H + FLAG_H;
      const laneH = h - laneTop;
      const mid = laneTop + laneH / 2;

      this._hit = [];
      this._drawSegmentBands(laneTop, laneH);
      this._drawRuler();

      // Wellenform
      this._drawWave(mid, laneH);

      // Mittellinie
      ctx.strokeStyle = c.line || '#2A3542';
      ctx.beginPath();
      ctx.moveTo(0, mid + 0.5);
      ctx.lineTo(w, mid + 0.5);
      ctx.stroke();

      this._drawCuts(laneTop, h);
      if (this.loudnessOn && this.loudness) this._drawLoudness(laneTop, laneH);
      this._emitLoudness();
      this._drawHandles(laneTop, h);
      this._drawPlayhead(h);
      this._drawHover(h);
      if (this.overview) this.overview.draw();
    }

    /* Wellenform in Gerätepixeln. Herausgezoomt fasst jede Spalte feste Buckets zusammen, gerechnet ab
       Aufnahmebeginn (nicht ab dem linken Rand) und um ganze Pixel verschoben: Sonst verteilten sich die Buckets
       bei jeder Bewegung der Ansicht (Folgen, Ziehen) neu auf die Spalten und die Spitzen sprangen hin und her.
       Außen der Spitzenwert (hell), innen der Mittelwert der Spalte (kräftig), damit Sprache und Musik
       auch weit herausgezoomt Kontur haben statt eines gleichmäßigen Blocks. */
    _drawWave(mid, laneH) {
      const ctx = this.ctx;
      const peaks = this.peaks;
      if (!peaks.length) return;
      const dpr = this.canvas.width / (this.width || 1) || 1;
      const W = this.canvas.width;
      const midD = Math.round(mid * dpr);
      const amp = Math.max(1, (laneH / 2 - 6) * dpr);
      const bucketPx = BUCKET_SEC * this.pxPerSec * dpr;   // Breite eines Buckets in Gerätepixeln
      const offset = Math.round(this.scrollT * this.pxPerSec * dpr);   // linker Rand als ganze Spalte
      const height = (v) => Math.max(1, Math.round((v / 255) * amp));

      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this.colors.wave || '#4E6C8A';

      if (bucketPx >= 3) {
        // Hineingezoomt: ein Balken je Bucket, mit einem Pixel Abstand
        const first = Math.max(0, Math.floor(offset / bucketPx));
        const last = Math.min(peaks.length, Math.ceil((offset + W) / bucketPx) + 1);
        for (let i = first; i < last; i++) {
          const x1 = Math.round(i * bucketPx) - offset;
          const x2 = Math.round((i + 1) * bucketPx) - offset;
          const bh = height(peaks[i] || 0);
          ctx.fillRect(x1, midD - bh, Math.max(1, x2 - x1 - Math.max(1, Math.round(dpr))), bh * 2);
        }
        ctx.restore();
        return;
      }

      // Herausgezoomt: je Spalte Spitze und Mittelwert der enthaltenen Buckets
      const maxH = new Float32Array(W);
      const avgH = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        const col = offset + x;
        if (col < 0) continue;
        const from = Math.floor(col / bucketPx);
        if (from >= peaks.length) break;
        const to = Math.min(peaks.length, Math.max(from + 1, Math.floor((col + 1) / bucketPx)));
        let peak = 0, sum = 0;
        for (let i = from; i < to; i++) {
          const v = peaks[i] || 0;
          if (v > peak) peak = v;
          sum += v;
        }
        maxH[x] = peak;
        avgH[x] = sum / (to - from);
      }
      // Mittelwert leicht glätten (über etwa einen Bildschirmpixel zu jeder Seite), sonst wirkt er streifig
      const r = Math.max(1, Math.round(dpr));
      const smooth = new Float32Array(W);
      for (let x = 0; x < W; x++) {
        if (!avgH[x]) continue;
        let sum = 0, n = 0;
        for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) { sum += avgH[k]; n++; }
        smooth[x] = Math.min(maxH[x], sum / n);
      }
      ctx.globalAlpha = 0.45;
      for (let x = 0; x < W; x++) {
        if (!maxH[x]) continue;
        const bh = height(maxH[x]);
        ctx.fillRect(x, midD - bh, 1, bh * 2);
      }
      ctx.globalAlpha = 1;
      for (let x = 0; x < W; x++) {
        if (!smooth[x]) continue;
        const bh = height(smooth[x]);
        ctx.fillRect(x, midD - bh, 1, bh * 2);
      }
      ctx.restore();
    }

    /* ------------------------------------------------------------ Lautheit */

    /** y-Lage eines LUFS-Werts in der Wellenform-Fläche (−50 unten … −5 oben). */
    _loudY(v, laneTop, laneH) {
      const top = laneTop + 6;
      const bottom = laneTop + laneH - 4;
      const f = (LOUD_MAX - Math.max(LOUD_MIN, Math.min(LOUD_MAX, v))) / (LOUD_MAX - LOUD_MIN);
      return top + f * (bottom - top);
    }

    /** Zahl der Skala rechts mit Hintergrund, damit sie auf der Wellenform lesbar bleibt. */
    _scaleLabel(text, y, color) {
      const ctx = this.ctx;
      const w = ctx.measureText(text).width;
      const x = this.width - 4 - w;
      ctx.fillStyle = this.colors.loudBox || 'rgba(16,20,25,0.8)';
      ctx.beginPath();
      ctx.roundRect(x - 3, y - 7, w + 6, 14, 3);
      ctx.fill();
      ctx.fillStyle = color;
      ctx.fillText(text, x, y);
    }

    /**
     * Short-term-Lautheit (3 s) als Linie über der Wellenform, Skala und Ziellinie (Export-Lautheit) rechts. Die
     * Messwerte stehen nicht in der Zeichenfläche (dort verdeckten sie zu viel), sondern gehen über `onLoudness`
     * an die Werkzeugleiste. Herausgezoomt wird über mehrere Pixel gemittelt, damit die Linie ruhig bleibt.
     */
    _drawLoudness(laneTop, laneH) {
      const ctx = this.ctx;
      const c = this.colors;
      const curve = this.loudness;
      const L = window.LoudnessCurve;
      const w = this.width;
      const color = c.loud || '#4FC3E8';
      const target = this.loudnessTarget;
      const gutter = 34;          // rechts: Platz für die Zahlen der Skala

      // Hilfslinien: je nach Höhe alle 10 LU, alle 20 LU oder gar keine (nur das Ziel)
      const gridStep = laneH >= 110 ? 10 : (laneH >= 60 ? 20 : 0);
      const grid = [];
      if (gridStep) for (let v = gridStep === 20 ? -20 : -10; v >= -40; v -= gridStep) grid.push(v);
      ctx.font = '10px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      const targetY = target != null ? Math.round(this._loudY(target, laneTop, laneH)) + 0.5 : null;
      grid.forEach((v) => {
        const y = Math.round(this._loudY(v, laneTop, laneH)) + 0.5;
        ctx.strokeStyle = c.loudGrid || 'rgba(79,195,232,0.13)';
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w - gutter, y);
        ctx.stroke();
      });
      if (targetY != null) {
        ctx.strokeStyle = color;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(0, targetY);
        ctx.lineTo(w - gutter, targetY);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Kurve
      const stepsPerPx = L.STEPS_PER_SECOND / this.pxPerSec;
      // Hineingezoomt die echte Short-term-Kurve (3 s); herausgezoomt über etwa 6 Pixel gemittelt, sonst zappelt
      // die Linie bei Sprache zwischen Sätzen und Pausen hin und her.
      const span = Math.max(L.SHORT_TERM_STEPS, Math.round(stepsPerPx * 6));
      const lastX = Math.min(w, this.timeToX(curve.length / L.STEPS_PER_SECOND));
      ctx.strokeStyle = color;
      ctx.lineWidth = laneH >= 80 ? 1.75 : 1.5;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let pen = false;
      const stride = this.pxPerSec * 0.1 >= 2 ? 1 : 2;     // weit hineingezoomt: jeden Pixel, sonst jeden zweiten
      // Stützstellen an festen Zeitpunkten (Raster ab Aufnahmebeginn), nicht am linken Rand: Sonst wandern sie beim
      // Folgen/Ziehen mit und die Linie zittert.
      const origin = this.scrollT * this.pxPerSec;
      const firstCol = Math.max(0, Math.floor(origin / stride) * stride);
      for (let col = firstCol; col - origin <= lastX; col += stride) {
        const px = col - origin;
        const end = Math.min(curve.length, Math.floor((col / this.pxPerSec) * L.STEPS_PER_SECOND) + 1);
        const v = curve.window(end, span);
        if (!(v > LOUD_MIN)) { pen = false; continue; }      // Stille: Linie unterbrechen
        const y = this._loudY(v, laneTop, laneH);
        if (pen) ctx.lineTo(px, y); else ctx.moveTo(px, y);
        pen = true;
      }
      ctx.stroke();
      ctx.lineWidth = 1;

      // Zahlen der Skala zuletzt (über der Linie); eine Hilfslinie zu nah am Ziel bekommt keine Zahl
      grid.forEach((v) => {
        const y = Math.round(this._loudY(v, laneTop, laneH)) + 0.5;
        if (targetY != null && Math.abs(y - targetY) < 14) return;
        this._scaleLabel(lufsText(v, 0), y, c.muted || '#7D8CA0');
      });
      if (targetY != null) this._scaleLabel(lufsText(target, 0), targetY, color);
    }

    /**
     * Messwerte für die Anzeige außerhalb der Zeichenfläche: live Momentary/Short-term/integriert und laufender
     * Abschnitt, sonst Short-term an der Mausposition, integriert gesamt und gewählter Abschnitt. Meldet nur Änderungen.
     */
    _emitLoudness() {
      let data = null;
      if (this.loudnessOn && this.loudness && this.loudness.length) {
        const curve = this.loudness;
        const L = window.LoudnessCurve;
        const sel = this.selectedSegment;
        const open = this.sections.find((x) => x.start != null && x.end == null);
        // Beendet: der zuletzt gewählte Abschnitt (Abschnittsliste, Fähnchen, Export-Liste)
        const chosen = this.selectedSectionId || (sel && sel.markerId) || null;
        const ref = this.loudnessLive ? open : (chosen ? this.sections.find((x) => x.id === chosen && x.start != null) : null);
        // Integrierte Werte nur neu rechnen, wenn sich Kurve (live: je Sekunde) oder Abschnitt ändern.
        const liveTick = this.loudnessLive ? Math.floor(curve.length / L.STEPS_PER_SECOND) : curve.length;
        const key = `${liveTick}|${ref ? `${ref.id}:${ref.start}:${ref.end}` : ''}`;
        if (!this._loudCache || this._loudCache.key !== key) {
          const range = ref ? [ref.start * L.STEPS_PER_SECOND, (ref.end != null ? ref.end : this.duration) * L.STEPS_PER_SECOND] : null;
          this._loudCache = { key, all: curve.integrated(), section: range ? curve.integrated(range[0], range[1]) : null };
        }
        const hover = !this.loudnessLive && this.hoverTime != null && this.hoverTime >= 0 && this.hoverTime <= this.duration
          ? this.hoverTime : null;
        data = {
          live: this.loudnessLive,
          momentary: this.loudnessLive ? lufsText(curve.momentary()) : null,
          shortTerm: this.loudnessLive ? lufsText(curve.shortTerm()) : (hover != null ? lufsText(curve.shortTerm(L.Curve.stepAt(hover))) : null),
          at: hover != null ? fmt(hover) : null,
          integrated: lufsText(this._loudCache.all),
          section: ref ? { label: ref.label || 'Abschnitt', value: lufsText(this._loudCache.section) } : null
        };
      }
      const json = JSON.stringify(data);
      if (json === this._loudEmitted) return;
      this._loudEmitted = json;
      this.onLoudness(data);
    }

    /**
     * Abschnitte als Farbstreifen am oberen Rand der Wellenform (die Fläche bleibt neutral, damit die Wellenform gut
     * lesbar ist); nur der gewählte Abschnitt ist leicht hinterlegt.
     */
    _drawSegmentBands(laneTop, laneH) {
      const ctx = this.ctx;
      const selectedId = (this.selectedSegment && this.selectedSegment.markerId) || this.selectedSectionId || null;
      this.sections.filter((x) => x.start != null).forEach((x) => {
        const end = x.end != null ? x.end : this.duration;
        const x1 = this.timeToX(x.start);
        const x2 = this.timeToX(end);
        if (x2 < 0 || x1 > this.width) return;
        ctx.fillStyle = this.secColor(x);
        if (x.id === selectedId) {
          ctx.globalAlpha = 0.14;
          ctx.fillRect(x1, laneTop, x2 - x1, laneH);
        }
        ctx.globalAlpha = 0.9 * this._flashLevel(x.id);
        ctx.fillRect(x1, laneTop, x2 - x1, STRIPE_H);
        ctx.globalAlpha = 1;
      });
    }

    _drawRuler() {
      const ctx = this.ctx;
      const c = this.colors;
      ctx.fillStyle = c.ruler || '#101720';
      ctx.fillRect(0, 0, this.width, RULER_H);
      ctx.strokeStyle = c.line || '#2A3542';
      ctx.beginPath();
      ctx.moveTo(0, RULER_H + 0.5);
      ctx.lineTo(this.width, RULER_H + 0.5);
      ctx.stroke();

      const candidates = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800];
      const step = candidates.find((s) => s * this.pxPerSec >= 70) || 3600;
      const first = Math.floor(this.scrollT / step) * step;

      ctx.font = '11px system-ui, "Segoe UI", Roboto, sans-serif';
      ctx.textBaseline = 'middle';
      for (let t = first; t <= this.scrollT + this.viewSeconds; t += step) {
        const x = this.timeToX(t);
        if (x < -40 || x > this.width + 40) continue;
        ctx.strokeStyle = c.line || '#2A3542';
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H - 6);
        ctx.lineTo(Math.round(x) + 0.5, RULER_H);
        ctx.stroke();
        ctx.fillStyle = c.muted || '#7D8CA0';
        ctx.fillText(fmt(t), x + 4, RULER_H / 2);
      }
    }

    /** Schnitte: schraffierte rote Flächen mit Rand; offene reichen bis zum Live-Ende. */
    _drawCuts(laneTop, h) {
      const ctx = this.ctx;
      const rgb = this.colors.cut || '255,59,48';
      if (!this._cutPattern || this._cutPatternRgb !== rgb) {
        this._cutPatternRgb = rgb;
        const tile = document.createElement('canvas');
        tile.width = 8;
        tile.height = 8;
        const t = tile.getContext('2d');
        t.strokeStyle = `rgba(${rgb},0.55)`;
        t.lineWidth = 1.5;
        t.beginPath();
        t.moveTo(-2, 10);
        t.lineTo(10, -2);
        t.stroke();
        this._cutPattern = ctx.createPattern(tile, 'repeat');
      }
      const all = [...this.cuts];
      if (this.pendingCut) all.push({ id: null, start: this.pendingCut.start, end: this.pendingCut.end });
      all.forEach((cut) => {
        const end = cut.end != null ? cut.end : this.duration;
        const x1 = this.timeToX(cut.start);
        const x2 = this.timeToX(end);
        if (x2 < 0 || x1 > this.width) return;
        const w = Math.max(2, x2 - x1);
        ctx.fillStyle = `rgba(${rgb},0.14)`;
        ctx.fillRect(x1, laneTop, w, h - laneTop);
        ctx.fillStyle = this._cutPattern;
        ctx.fillRect(x1, laneTop, w, h - laneTop);
        ctx.strokeStyle = `rgba(${rgb},0.9)`;
        ctx.beginPath();
        ctx.moveTo(Math.round(x1) + 0.5, laneTop);
        ctx.lineTo(Math.round(x1) + 0.5, h);
        if (cut.end != null) {
          ctx.moveTo(Math.round(x2) + 0.5, laneTop);
          ctx.lineTo(Math.round(x2) + 0.5, h);
        }
        ctx.stroke();
        if (w > 44) {
          ctx.font = '12px system-ui, "Segoe UI", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = this.colors.cutText || '#FF8A80';
          ctx.fillText('✂ Schnitt', x1 + 6, laneTop + 12);
        }
      });
    }

    /** Findet den Rand eines Schnitts unter dem Zeiger (nur in der Wellenform-Fläche). */
    _cutEdgeAt(x, y) {
      if (y <= RULER_H + FLAG_H) return null;
      for (const cut of this.cuts) {
        if (Math.abs(this.timeToX(cut.start) - x) <= 6) return { id: cut.id, edge: 'start' };
        if (cut.end != null && Math.abs(this.timeToX(cut.end) - x) <= 6) return { id: cut.id, edge: 'end' };
      }
      return null;
    }

    _cutAt(x, y) {
      if (y <= RULER_H + FLAG_H) return null;
      const t = this.xToTime(x);
      return this.cuts.find((c) => t >= c.start && t <= (c.end != null ? c.end : this.duration)) || null;
    }

    /** Kürzt einen Text mit "…" auf die verfügbare Breite. */
    _fitText(text, maxW) {
      const ctx = this.ctx;
      if (maxW <= 0 || !text) return '';
      if (ctx.measureText(text).width <= maxW) return text;
      const ell = '…';
      const ellW = ctx.measureText(ell).width;
      if (maxW < ellW) return '';
      let lo = 0;
      let hi = text.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (ctx.measureText(text.slice(0, mid)).width + ellW <= maxW) lo = mid; else hi = mid - 1;
      }
      return lo > 0 ? text.slice(0, lo).trimEnd() + ell : ell;
    }

    /** Zeichnet je Abschnitt eine Anfangs- und eine Endmarke in dessen Farbe. */
    _drawHandles(laneTop, h) {
      const ctx = this.ctx;
      const c = this.colors;
      const placed = this.sections.filter((x) => x.start != null).sort((a, b) => a.start - b.start);

      ctx.font = '12px system-ui, "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      const PAD = 8;            // Innenabstand im Fähnchen
      const TAB = 10;           // Breite eines Fähnchens ohne Text
      const MAX_START = 360;
      const endLabel = 'Ende';
      const endFull = ctx.measureText(endLabel).width + PAD * 2;
      const hintText = '  ·  + Interpret';

      /** Linie und Fähnchen; parts = [{ text, alpha }] sind bereits auf die Breite gekürzt. */
      const drawFlag = (section, edge, x, w, rightSide, parts) => {
        const color = this.secColor(section);
        const active = this.dragging && this.dragging.id === section.id && this.dragging.edge === edge;
        const fade = this._flashLevel(section.id);

        ctx.save();
        ctx.globalAlpha = 0.2 + 0.8 * fade;
        ctx.strokeStyle = color;
        ctx.lineWidth = active || fade < 1 ? 2 : 1;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        ctx.lineWidth = 1;

        // Fähnchen: Anfang steht rechts der Linie, Ende links davon.
        const fx = rightSide ? x : x - w;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(fx, RULER_H + 3, w, FLAG_H - 6, 3);
        ctx.fill();

        ctx.save();
        ctx.beginPath();
        ctx.rect(fx, RULER_H + 3, w, FLAG_H - 6);
        ctx.clip();
        ctx.fillStyle = c.flagText || '#0E1318';
        let tx = fx + PAD;
        parts.forEach((part) => {
          if (!part.text) return;
          ctx.globalAlpha = part.alpha * (0.2 + 0.8 * fade);
          ctx.fillText(part.text, tx, RULER_H + FLAG_H / 2);
          tx += ctx.measureText(part.text).width;
        });
        ctx.restore();
        ctx.restore();
        return fx;
      };

      placed.forEach((sec) => {
        const sx = this.timeToX(sec.start);
        const ex = sec.end != null ? this.timeToX(sec.end) : null;
        if ((ex ?? sx) < -400 || sx > this.width + 400) return;

        const hovered = this.hoverHandle && this.hoverHandle.id === sec.id && this.hoverHandle.edge === 'start';
        const name = sec.label || 'Abschnitt';
        const extra = sec.artist ? '  ·  ' + sec.artist : (hovered ? hintText : '');
        const nameW = ctx.measureText(name).width;
        const wantStart = Math.min(MAX_START, nameW + (extra ? ctx.measureText(extra).width : 0) + PAD * 2);

        // Breiten verteilen: Passen beide Fähnchen nicht in den Abschnitt, wird zuerst das
        // Anfangs-Fähnchen gekürzt, dann das Ende-Fähnchen auf eine Lasche ohne Text.
        let startW = wantStart;
        let endW = endFull;
        if (ex != null) {
          const room = Math.max(0, ex - sx - 2);
          if (wantStart + endW > room) {
            startW = room - endW;
            if (startW < 40) {
              endW = Math.min(TAB, room);
              startW = Math.max(0, room - endW);
            }
          }
        }
        const startMax = startW;

        // Anfangs-Fähnchen: Name, dahinter (heller) der Interpret
        const inner = startW - PAD * 2;
        const nameFit = startW >= 24 ? this._fitText(name, inner) : '';
        const nameFitW = nameFit ? ctx.measureText(nameFit).width : 0;
        // Der Interpret erscheint nur, wenn genug Platz bleibt (sonst stünde dort nur "Ge…").
        const extraRoom = inner - nameFitW;
        const extraFit = nameFit && extra && extraRoom >= 60 ? this._fitText(extra, extraRoom) : '';
        const startDrawW = Math.max(TAB, Math.min(startW, nameFitW + (extraFit ? ctx.measureText(extraFit).width : 0) + PAD * 2));
        const fx = drawFlag(sec, 'start', sx, startW >= TAB ? startDrawW : TAB, true, [
          { text: nameFit, alpha: 1 },
          { text: extraFit, alpha: sec.artist ? 0.72 : 0.5 }
        ]);

        // Trefferfläche: ohne Interpret bleibt Platz für den Hinweis, damit er beim Darüberfahren
        // nicht flackert und der Doppelklick darauf das Interpret-Feld öffnet.
        const hintW = sec.artist ? 0 : ctx.measureText(hintText).width;
        const hitW = Math.min(Math.max(startDrawW, nameFitW + hintW + PAD * 2), Math.max(startMax, TAB));
        this._hit.push({ id: sec.id, edge: 'start', flag: [fx, fx + hitW], x: sx, artistX: fx + PAD + nameFitW });

        // Ende-Fähnchen
        if (ex != null) {
          const label = endW >= endFull ? endLabel : '';
          const efx = drawFlag(sec, 'end', ex, endW, false, [{ text: label, alpha: 1 }]);
          this._hit.push({ id: sec.id, edge: 'end', flag: [efx, efx + endW], x: ex, artistX: null });
        }
      });
    }

    _drawPlayhead(h) {
      const ctx = this.ctx;
      const line = (t, color) => {
        const x = this.timeToX(t);
        if (x < 0 || x > this.width) return;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, RULER_H);
        ctx.lineTo(Math.round(x) + 0.5, h);
        ctx.stroke();
        ctx.lineWidth = 1;
      };
      // Während der Aufnahme markiert die rote Linie das Live-Ende,
      // die helle Linie ist der Hörcursor.
      if (this.recording) line(this.duration, this.colors.tally || '#FF3B30');
      if (this.playhead != null) line(this.playhead, this.colors.text || '#E6EBF0');
    }

    _drawHover(h) {
      if (this.hoverTime == null) return;
      const ctx = this.ctx;
      const x = this.timeToX(this.hoverTime);
      ctx.strokeStyle = this.colors.hover || 'rgba(255,255,255,0.18)';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, RULER_H);
      ctx.lineTo(Math.round(x) + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    /* ---------------------------------------------------------- Interaktion */

    /** Findet den Griff (Anfang/Ende eines Abschnitts) unter dem Zeiger. */
    _handleAt(x, y) {
      if (y < RULER_H) return null;
      // Fähnchen zuerst (größere Trefferfläche), von hinten, damit das oberste gewinnt.
      if (y <= RULER_H + FLAG_H) {
        for (let i = this._hit.length - 1; i >= 0; i--) {
          const hit = this._hit[i];
          if (x >= hit.flag[0] - 2 && x <= hit.flag[1] + 2) return hit;
        }
      }
      for (let i = this._hit.length - 1; i >= 0; i--) {
        if (Math.abs(this._hit[i].x - x) <= 6) return this._hit[i];
      }
      return null;
    }

    _pos(event) {
      const rect = this.canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    _bind() {
      const cv = this.canvas;

      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;   // Rechts-/Mittelklick setzt keine Marke und zieht nichts
        const { x, y } = this._pos(e);
        const handle = this._handleAt(x, y);
        const cutEdge = !(handle && y <= RULER_H + FLAG_H) ? this._cutEdgeAt(x, y) : null;
        if (cutEdge) {
          this.draggingCut = cutEdge;
          cv.setPointerCapture(e.pointerId);
        } else if (e.shiftKey && !handle && y > RULER_H) {
          // Umschalt + Ziehen: Schnitt aufziehen
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
          this.pendingCut = { start: t, end: t, anchor: t };
          cv.setPointerCapture(e.pointerId);
        } else if (handle) {
          this.dragging = { id: handle.id, edge: handle.edge, offset: x - handle.x };
          cv.setPointerCapture(e.pointerId);
          this.onSelectSection(handle.id);
          this.draw();
        } else {
          // Ziehen verschiebt die Ansicht (Zeitleiste und Wellenform); ein Klick ohne Bewegung in der Wellenform setzt
          // die Marke – das entscheidet erst das Loslassen.
          this._panning = { startX: x, startScroll: this.scrollT, moved: false, seek: y > RULER_H };
          cv.setPointerCapture(e.pointerId);
        }
      });

      cv.addEventListener('pointermove', (e) => {
        const { x, y } = this._pos(e);
        if (this.draggingCut) {
          const cut = this.cuts.find((c) => c.id === this.draggingCut.id);
          if (cut) {
            const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
            if (this.draggingCut.edge === 'start') cut.start = Math.min(t, (cut.end != null ? cut.end : this.duration) - 0.2);
            else cut.end = Math.max(t, cut.start + 0.2);
          }
          this.draw();
          return;
        }
        if (this.pendingCut) {
          const t = Math.max(0, Math.min(this.duration, this.xToTime(x)));
          this.pendingCut.start = Math.min(this.pendingCut.anchor, t);
          this.pendingCut.end = Math.max(this.pendingCut.anchor, t);
          this.draw();
          return;
        }
        if (this.dragging) {
          const { id, edge } = this.dragging;
          const sec = this.sections.find((ss) => ss.id === id);
          if (sec) {
            // Gleiche Regel wie im Hauptprozess: Nachbarn weichen aus, nichts überlappt.
            const raw = Math.max(0, Math.min(this.duration, this.xToTime(x - this.dragging.offset)));
            const r = window.SectionLogic.moveEdge(this.sections, id, edge, raw, this.duration);
            if (r) this.onEdgeMove(id, edge, r.time);
          }
          this.draw();
          return;
        }
        if (this._panning) {
          if (!this._panning.moved && Math.abs(x - this._panning.startX) < PAN_THRESHOLD) return;
          if (!this._panning.moved) {
            this._panning.moved = true;
            cv.style.cursor = 'grabbing';
          }
          this.scrollT = this._panning.startScroll - (x - this._panning.startX) / this.pxPerSec;
          this.follow = false;
          this.onFollowChange(false);
          this.clampScroll();
          this.draw();
          return;
        }
        this.hoverTime = this.xToTime(x);
        const over = this._handleAt(x, y);
        const hover = over && over.edge === 'start' ? { id: over.id, edge: 'start' } : null;
        if ((hover && hover.id) !== (this.hoverHandle && this.hoverHandle.id)) this.hoverHandle = hover;
        // Wellenform: Klick setzt die Marke, Ziehen verschiebt – herausgezoomt (alles sichtbar) gibt es nichts zu verschieben.
        const pannable = this.duration > this.viewSeconds * 0.98 || this.scrollT > 0;
        cv.style.cursor = this._handleAt(x, y) || this._cutEdgeAt(x, y) ? 'ew-resize'
          : (e.shiftKey && y > RULER_H ? 'crosshair' : (y < RULER_H || pannable ? 'grab' : 'pointer'));
        this.draw();
      });

      const endDrag = (e) => {
        if (this.draggingCut) {
          const cut = this.cuts.find((c) => c.id === this.draggingCut.id);
          if (cut) this.onCutMoveEnd(cut.id, this.draggingCut.edge, cut[this.draggingCut.edge]);
          this.draggingCut = null;
          this.draw();
        }
        if (this.pendingCut) {
          const { start, end } = this.pendingCut;
          this.pendingCut = null;
          if (end - start >= 0.2) this.onCutAdd(start, end);
          this.draw();
        }
        if (this.dragging) {
          const { id, edge } = this.dragging;
          const sec = this.sections.find((ss) => ss.id === id);
          if (sec) this.onEdgeMoveEnd(id, edge, sec[edge]);
          this.dragging = null;
          this.draw();
        }
        if (this._panning) {
          const { moved, seek, startX } = this._panning;
          this._panning = null;
          if (!moved && seek && e.type === 'pointerup') {
            this.onSeek(Math.max(0, Math.min(this.duration, this.xToTime(startX))));
          }
          cv.style.cursor = '';
        }
        try { cv.releasePointerCapture(e.pointerId); } catch { /* schon freigegeben */ }
      };
      cv.addEventListener('pointerup', endDrag);
      cv.addEventListener('pointercancel', endDrag);

      cv.addEventListener('dblclick', (e) => {
        const { x, y } = this._pos(e);
        const handle = this._handleAt(x, y);
        if (!handle && !this._cutEdgeAt(x, y)) {
          const cut = this._cutAt(x, y);
          if (cut) { this.onCutRemove(cut.id); return; }
        }
        // Doppelklick auf den Interpreten (oder den Hinweis) springt direkt in dieses Feld.
        if (handle) {
          const focus = handle.artistX != null && x >= handle.artistX ? 'artist' : 'name';
          // Rechteck des Fähnchens (Zeichenfläche), damit der Editor genau darüber erscheint.
          this.onRenameSection(handle.id, focus, {
            x: handle.flag[0], y: RULER_H + 3, w: Math.max(10, handle.flag[1] - handle.flag[0]), h: FLAG_H - 6
          });
        }
      });

      cv.addEventListener('pointerleave', () => {
        this.hoverTime = null;
        this.hoverHandle = null;
        this.draw();
      });

      cv.addEventListener('wheel', (e) => {
        e.preventDefault();
        const { x } = this._pos(e);
        if (e.ctrlKey || e.shiftKey) {
          // Umschalt+Mausrad liefert auf dem Mac deltaX statt deltaY
          const delta = e.deltaY || e.deltaX;
          const factor = delta < 0 ? 1.2 : 1 / 1.2;
          this.setZoom(this.pxPerSec * factor, this.xToTime(x));
        } else {
          this.scrollT += (e.deltaY + e.deltaX) / this.pxPerSec;
          this.follow = false;
          this.onFollowChange(false);
          this.clampScroll();
          this.draw();
        }
      }, { passive: false });

      cv.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        this.hoverTime = this.xToTime(this._pos(e).x);
        this.draw();
      });

      // Beim Ziehen eines Ablaufpunkts kommt kein pointerleave: die Hilfslinie sonst stehen lassen.
      cv.addEventListener('dragleave', () => {
        this.hoverTime = null;
        this.draw();
      });

      cv.addEventListener('drop', (e) => {
        e.preventDefault();
        this.hoverTime = null;
        this.draw();
        const id = e.dataTransfer.getData('text/marker-id');
        if (!id) return;
        const t = Math.max(0, Math.min(this.duration, this.xToTime(this._pos(e).x)));
        this.onDropPending(id, t);
      });

      window.addEventListener('resize', () => this.resize());
      // Auch jede andere Größenänderung der Zeichenfläche (z. B. Umschalten Mini-Fenster ↔ großes Fenster, bei dem das
      // Fenster-Ereignis vor der Umstellung der Ansicht kommt) baut die Zeichenfläche neu auf – sonst wirkt alles gestreckt.
      if (typeof ResizeObserver === 'function') {
        let last = '';
        new ResizeObserver(() => {
          const size = `${cv.clientWidth}x${cv.clientHeight}`;
          if (size !== last) { last = size; this.resize(); }
        }).observe(cv);
      }
      // Wird das Fenster auf einen Monitor mit anderer Pixeldichte gezogen, neu aufbauen (sonst unscharf).
      const watchDpr = () => {
        const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
        mq.addEventListener('change', () => { this.resize(); watchDpr(); }, { once: true });
      };
      watchDpr();
    }
  }

  /**
   * Übersichtsleiste über der Wellenform: die ganze Aufnahme auf einen Blick (Umriss, Abschnitte, Schnitte, Live-Stelle,
   * Hörmarke) und der sichtbare Ausschnitt als Rahmen. Klick springt hin, Ziehen verschiebt den Ausschnitt.
   */
  class Overview {
    constructor(canvas, wave) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.wave = wave;
      this._cols = null;          // zwischengespeicherter Umriss je Spalte
      this._drag = null;
      this._bind();
    }

    get total() { return Math.max(this.wave.duration, 0.001); }

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const w = Math.floor(this.canvas.clientWidth * dpr);
      const h = Math.floor(this.canvas.clientHeight * dpr);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
        this._cols = null;
      }
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Umriss: je Bildschirmspalte der Spitzenwert der enthaltenen Buckets (nur neu, wenn neue Daten da sind). */
    _outline(w) {
      const peaks = this.wave.peaks || [];
      const key = `${peaks.length}|${w}`;
      if (this._cols && this._cols.key === key) return this._cols.data;
      const data = new Float32Array(w);
      const per = peaks.length / w;
      for (let x = 0; x < w; x++) {
        const from = Math.floor(x * per);
        const to = Math.max(from + 1, Math.floor((x + 1) * per));
        let m = 0;
        for (let i = from; i < to && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
        data[x] = m / 255;
      }
      this._cols = { key, data };
      return data;
    }

    draw() {
      const cv = this.canvas;
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (!w || !h) return;
      this._resize();
      const ctx = this.ctx;
      const wave = this.wave;
      const c = wave.colors;
      const total = this.total;
      const tx = (t) => (t / total) * w;

      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = c.ruler || '#101720';
      ctx.fillRect(0, 0, w, h);
      if (!(wave.duration > 0)) return;

      // Abschnitte als Flächen, darüber der Umriss
      wave.sections.filter((x) => x.start != null).forEach((x) => {
        const x1 = tx(x.start);
        const x2 = tx(x.end != null ? x.end : wave.duration);
        ctx.fillStyle = wave.secColor(x);
        ctx.globalAlpha = 0.42;
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
        ctx.globalAlpha = 1;
        ctx.fillRect(x1, h - 3, Math.max(1, x2 - x1), 3);
      });
      const cols = this._outline(Math.floor(w));
      ctx.fillStyle = c.wave || '#4E6C8A';
      const mid = (h - 3) / 2;
      for (let x = 0; x < cols.length; x++) {
        const bh = Math.max(0.5, cols[x] * (mid - 1));
        ctx.fillRect(x, mid - bh, 1, bh * 2);
      }
      // Schnitte
      const rgb = c.cut || '255,59,48';
      wave.cuts.forEach((cut) => {
        const x1 = tx(cut.start);
        const x2 = tx(cut.end != null ? cut.end : wave.duration);
        ctx.fillStyle = `rgba(${rgb},0.45)`;
        ctx.fillRect(x1, 0, Math.max(1, x2 - x1), h);
      });
      // Ausschnitt der Wellenform als Rahmen
      const v1 = tx(wave.scrollT);
      const v2 = tx(Math.min(total, wave.scrollT + wave.viewSeconds));
      if (v2 - v1 < w - 1) {
        ctx.fillStyle = c.hover || 'rgba(255,255,255,0.18)';
        ctx.globalAlpha = 0.5;
        ctx.fillRect(v1, 0, Math.max(3, v2 - v1), h);
        ctx.globalAlpha = 1;
        ctx.strokeStyle = c.text || '#E6EBF0';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(Math.round(v1) + 0.75, 0.75, Math.max(3, Math.round(v2 - v1) - 1.5), h - 1.5);
        ctx.lineWidth = 1;
      }
      const line = (t, color) => {
        const x = Math.round(Math.min(w - 1, tx(t)));
        ctx.fillStyle = color;
        ctx.fillRect(x, 0, 2, h);
      };
      if (wave.playhead != null && !wave.recording) line(wave.playhead, c.text || '#E6EBF0');
      if (wave.recording) line(wave.duration, c.tally || '#FF3B30');
    }

    _bind() {
      const cv = this.canvas;
      const timeAt = (e) => {
        const r = cv.getBoundingClientRect();
        return Math.max(0, Math.min(this.total, ((e.clientX - r.left) / Math.max(1, r.width)) * this.total));
      };
      const scrollTo = (start) => {
        const wave = this.wave;
        wave.scrollT = start;
        wave.follow = false;
        wave.onFollowChange(false);
        wave.clampScroll();
        wave.draw();
      };
      cv.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || !(this.wave.duration > 0)) return;
        const t = timeAt(e);
        const wave = this.wave;
        const inside = t >= wave.scrollT && t <= wave.scrollT + wave.viewSeconds;
        this._drag = { offset: inside ? t - wave.scrollT : wave.viewSeconds / 2 };
        cv.setPointerCapture(e.pointerId);
        cv.style.cursor = 'grabbing';
        if (!inside) scrollTo(t - this._drag.offset);
      });
      cv.addEventListener('pointermove', (e) => {
        if (!this._drag) return;
        scrollTo(timeAt(e) - this._drag.offset);
      });
      const end = (e) => {
        this._drag = null;
        cv.style.cursor = '';
        try { cv.releasePointerCapture(e.pointerId); } catch { /* schon freigegeben */ }
      };
      cv.addEventListener('pointerup', end);
      cv.addEventListener('pointercancel', end);
      if (typeof ResizeObserver === 'function') new ResizeObserver(() => this.draw()).observe(cv);
    }
  }

  window.Waveform = Waveform;
  window.sectionColorVar = sectionColorVar;
  window.formatTime = fmt;
})();
