'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => invoke('app:info'),
    diskFree: () => invoke('disk:free'),
    openRecordingsFolder: () => invoke('folder:open'),
    reveal: (filePath) => invoke('file:reveal', { filePath }),
    setCompact: (on) => invoke('window:compact', { on }),
    setCompactOnTop: (onTop) => invoke('window:compact', { onTop }),
    /** Ansicht wählen: 'large' (groß), 'dense' (kompakt) oder 'mini' (Mini-Fenster). */
    setView: (view) => invoke('window:compact', { view })
  },

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
    chooseFolder: (title, defaultPath) => invoke('settings:chooseFolder', { title, defaultPath })
  },

  churchtools: {
    test: () => invoke('ct:test'),
    services: (range) => invoke('ct:services', range),
    calendars: () => invoke('ct:calendars'),
    dump: () => invoke('ct:dump'),
    agenda: (params) => invoke('ct:agenda', params)
  },

  session: {
    state: () => invoke('session:state'),
    setService: (service) => invoke('session:service', service),
    list: () => invoke('session:list'),
    open: (path) => invoke('session:open', { path }),
    recoverable: () => invoke('session:recoverable'),
    prepareNext: () => invoke('session:new', { keepPlan: true })
  },

  record: {
    start: (params) => invoke('rec:start', params),
    continue: () => invoke('rec:continue'),
    pause: () => invoke('rec:pause'),
    resume: () => invoke('rec:resume'),
    stop: () => invoke('rec:stop'),
    /** Ausschnitt der (laufenden) Aufnahme zum Mithören lesen. */
    readAudio: (start, seconds) => invoke('audio:read', { start, seconds }),
    /** Audioblock (Int16 interleaved) an den Hauptprozess übergeben. */
    chunk: (arrayBuffer) => ipcRenderer.send('audio:chunk', arrayBuffer)
  },

  multitrack: {
    /** Geräte für die Mehrspuraufnahme (unter Windows ASIO); simulate: nachgebautes 32-Kanal-Pult. */
    devices: (simulate) => invoke('multitrack:devices', { simulate }),
    /** Abhören vor dem Start: {active, info: {device, inputs, sampleRate …}, error, stalled}. */
    state: () => invoke('multitrack:state'),
    /** Beendete Mehrspuraufnahme zum Pult zurückspielen (Sekunden; loop: {start, end} oder null). */
    play: (start, loop) => invoke('multitrack:play', { start, loop }),
    seek: (seconds) => invoke('multitrack:seek', { seconds }),
    loop: (loop) => invoke('multitrack:loop', { loop }),
    stopPlayback: () => invoke('multitrack:stopPlay')
  },

  mixer: {
    /** Verbindung, Kanalnamen, Routing der Kartenausgänge und dessen Bewertung. */
    state: () => invoke('mixer:state'),
    /** Pulte im Netz suchen. */
    discover: () => invoke('mixer:discover'),
    /** Aktuelles Routing als 'stereo' bzw. 'multitrack' merken. */
    learn: (mode) => invoke('mixer:learn', { mode }),
    forget: () => invoke('mixer:forget'),
    /** Nur Pult-Simulator: Routing umstellen ('stereo' | 'multitrack'). */
    simulateRouting: (kind) => invoke('mixer:simulateRouting', { kind })
  },

  section: {
    /** Abschnitt beginnen bzw. den laufenden beenden. */
    toggle: (params) => invoke('section:toggle', params),
    /** Offenen Ablaufpunkt beginnen (time = null: jetzt). */
    start: (id, time) => invoke('section:start', { id, time }),
    /** Neuen offenen Ablaufpunkt anlegen. */
    add: (params) => invoke('section:add', params),
    /** Offenen Ablaufpunkt vor einen anderen schieben (beforeId = null: ans Ende). */
    reorder: (id, beforeId) => invoke('section:reorder', { id, beforeId }),
    /** Ablaufpunkt auf die Zeitachse legen (Drag & Drop): füllt eine Lücke oder beginnt an der Stelle. */
    place: (id, time) => invoke('section:place', { id, time }),
    /** Laufenden Abschnitt beenden und nächsten Ablaufpunkt beginnen. */
    next: (time) => invoke('section:next', { time }),
    moveEdge: (id, edge, time) => invoke('section:edge', { id, edge, time }),
    update: (id, patch) => invoke('section:update', { id, ...patch }),
    remove: (id) => invoke('section:delete', { id })
  },

  edit: {
    undo: () => invoke('edit:undo'),
    redo: () => invoke('edit:redo')
  },

  cut: {
    add: (start, end) => invoke('cut:add', { start, end }),
    toggle: (time) => invoke('cut:toggle', { time }),
    moveEdge: (id, edge, time) => invoke('cut:move', { id, edge, time }),
    remove: (id) => invoke('cut:remove', { id })
  },

  agenda: {
    applyTemplate: (templateId) => invoke('agenda:applyTemplate', { templateId })
  },

  /** Meldet einen gescheiterten Fernbefehl (Start/Stopp per Companion) an den Hauptprozess. */
  reportRemoteResult: (result) => ipcRenderer.send('remote:result', result),

  /** Meldet dem Hauptprozess, ob der Audioeingang ausgefallen ist. */
  reportInputLost: (lost) => ipcRenderer.send('health:input', { lost }),

  /** Schreibt einen Eintrag in `logs/eingang.log` (Ereignis + Daten, siehe `inputlog.js`). */
  logInput: (level, event, data) => ipcRenderer.send('log:input', { level, event, data }),

  exportBatch: (items) => invoke('export:batch', { items }),
  exportTarget: () => invoke('export:target'),
  exportPreviewName: (pattern) => invoke('export:previewName', { pattern }),

  net: {
    status: () => invoke('net:status')
  },

  update: {
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    openPage: () => invoke('update:openPage')
  },

  on: (channel, handler) => {
    const allowed = ['state', 'levels', 'toast', 'command', 'menu', 'health', 'compact',
      'network-status', 'update-status', 'export-progress', 'mixer', 'multitrack', 'track-levels', 'multitrack-play', 'settings', 'loudness'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  }
});
