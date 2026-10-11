# Ebbton – Hinweise für Claude

Aufnahmesoftware für Gottesdienste (Electron). Entwickelt wird abwechselnd auf
einem MacBook und auf dem Windows-PC in der Kirche. Der Code muss auf beiden
Systemen laufen.

## Aufbau
- `app/` – Electron-App (Hauptprozess `src/main`, Oberfläche `src/renderer`)
- `companion-module/` – Bitfocus-Companion-Modul
- `.github/workflows/release.yml` – baut bei Tag `v*` Windows- und Mac-Release
- `docs/video-kapitel.md` – Auftrag für einen Dienst auf dem Server, der die Abschnitte als Kapitel in die
  OBS-Videos auf der NAS schreibt (liest die `.session.json`; bei Formatänderungen dort mitpflegen)

Befehle (im Ordner `app/`): `npm install`, `npm run dev` (Live-Reload),
`npm start`. Architektur und Einrichtung stehen in `app/README.md`.

## Regeln
- Sprache: Oberfläche, Kommentare, Commit-Messages und Doku auf Deutsch.
- Nach jedem angeforderten Commit direkt pushen.
- Bei jedem Commit die Dokumentation mitpflegen: `CLAUDE.md` (Abschnitt
  „Entwurfsentscheidungen“, wenn sich Verhalten oder Entscheidungen ändern),
  `app/README.md` (Bedienung, Dateiübersicht), bei Schnittstellenänderungen auch
  `app/docs/websocket-api.md` und `companion-module/README.md`. Die Doku-Änderung
  gehört in denselben Commit wie die Code-Änderung.
- Muss die App nach einer Änderung neu gestartet werden (Hauptprozess, Preload,
  `src/shared`), führt Claude den Neustart selbst im Terminal aus (Befehl siehe
  „Entwicklung“) und meldet es. **Nie**, wenn gerade eine Aufnahme läuft oder
  pausiert ist: vorher prüfen (jüngste `.session.json` im Aufnahmeordner hat
  `status` `recording`/`paused` bzw. die WAV wächst) und dann nachfragen.
- Plattformneutral bleiben: Pfade mit `path`, keine festen Laufwerks- oder
  `/Users`-Pfade, Plattformunterschiede nur über `process.platform`.
- Während einer Aufnahme darf nie etwas die Audioaufnahme blockieren oder
  die App neu starten (siehe Updater).
- Auch der Windows-PC arbeitet direkt auf `main` (aktuell nur Testphase). Sobald
  die Software produktiv genutzt wird, auf Branches umstellen, weil der
  Kirchen-PC dann zugleich Produktivrechner ist.
- Vor dem Arbeiten `git pull`, damit beide Rechner synchron bleiben.

## Entwurfsentscheidungen (nicht aus dem Code ablesbar)

Stand der Funktionen und das Warum dahinter. Beim Weiterarbeiten beachten.

### Abschnitte statt Einzelmarker
- Ein Abschnitt hat Anfang **und** Ende (`sections` in `session.js`, je
  `start`/`end`; `start == null` = offener Ablaufpunkt, `end == null` = läuft
  gerade). Es läuft höchstens einer. Jeder Abschnitt hat eine feste `color`
  (Index, wird beim Anlegen vergeben; feste Palette `--sec-0` … `--sec-7` in `styles.css`, je Farbschema, siehe
  „Oberfläche nach Phasen“).
- Pausen zwischen Punkten: **M** auf einem laufenden Abschnitt („Abschnitt beenden“) lässt die Aufnahme ohne aktiven
  Abschnitt weiterlaufen, bis **N** den nächsten beginnt (`startNextPending` beginnt bei fehlendem offenem Abschnitt
  einfach an der Live-Stelle). Oberfläche: „Zwischen den Punkten“, wenn noch Punkte offen sind.
- **M** (`section.toggle`) beginnt bzw. beendet einen Abschnitt, **N**
  beendet den laufenden und beginnt den nächsten Ablaufpunkt. Marken werden
  sofort gesetzt, benannt wird danach (✎, Doppelklick, F2).
- **Abschnitte überlappen nie.** Die Regel steht in `src/shared/sections.js`
  und wird vom Hauptprozess *und* der Wellenform genutzt (UMD-Datei, damit
  beide dasselbe Ergebnis beim Ziehen bekommen): Stößt eine Marke an einen
  Nachbarn, wandert dessen angrenzende Marke mit, kürzer als 0,1 s wird keiner.
- Drag & Drop eines Ablaufpunkts (`placePending`): in einer Lücke füllt er
  sie genau, hinter dem letzten beginnt er an der Ablagestelle, mitten in einem
  Abschnitt kürzt er diesen. Ein Klick auf den Punkt im Ablaufplan (nur während der Aufnahme) und N (`startPending`) setzen dagegen
  immer an der Live-Stelle.
- **Vor dem ersten Start** (`status` `idle`) beginnt ein hineingezogener Ablaufpunkt bei 0 und bleibt offen (`end == null`),
  statt als 0:00–0:00 zu enden; `Session.start` sieht den offenen Abschnitt und beginnt keinen weiteren. Vorab lässt
  sich nur ein Punkt beginnen (`startPending`, Fehlermeldung beim zweiten).
- Alte Sessions mit `markers` (Version 1) werden in `loadFromFile` zu Abschnitten
  migriert (`migrateSections`). Session-Datei ist jetzt `version: 2`.
- Der Export kennt zusätzlich immer „Gesamte Aufnahme“ (`seg_full`). Der
  Snapshot heißt `sections` (nicht mehr `markers`).
- Schnittstellen-Namen bleiben aus Kompatibilität stehen: Companion-Aktion
  `marker_add` und WebSocket-Befehle `marker.add`/`marker.next` bedeuten jetzt
  Start/Ende-Umschalter bzw. „nächster Punkt“; Antwort enthält `change`
  (`started`/`ended`). Nicht `action` überschreiben (kollidiert mit der Antwort).

### Aufnahme, Fortsetzen, Schutz
- **Beim Start beginnt der erste offene Ablaufpunkt von selbst** (`Session.start` ruft `startNextPending(0)`; ohne Punkte
  passiert nichts; gilt nicht beim Anhängen mit „Fortsetzen“ und nicht beim Fortsetzen aus der Pause).
- **„Neue Aufnahme“ nach dem Beenden startet nicht gleich** (Wunsch des Nutzers, 2026-10-08): Nach der Rückfrage
  („Neue Aufnahme vorbereiten?“, nennt ungesicherte Abschnitte) geht es zurück in „Vorbereiten“
  (`prepareNewRecording` → IPC `session:new` mit `keepPlan` → `Session.prepareNext`): Gottesdienst und Ablauf bleiben,
  die Punkte sind wieder offen, eigene Abschnitte (M) entfallen, die beendete Aufnahme bleibt als Datei. So lässt sich
  vorher noch eine andere Vorlage oder ein anderer Termin wählen; gestartet wird ausdrücklich mit „Aufnahme starten“.
  Gilt für den Knopf, „Neue Aufnahme“ im Mini-Fenster und `Strg`/`Cmd`+R nach dem Beenden; Companion (`record.start`)
  startet weiter direkt (die Rückfrage in `startRecording` bleibt dafür). `reset()` setzt jetzt auch
  `_restoredDuration` zurück. Dateinamen werden nie überschrieben (`_freeBasePath` hängt `_2`, `_3` an).
- „Fortsetzen“ nach dem Beenden hängt an dieselbe WAV an
  (`WavWriter` mit `append`) und braucht dieselbe Abtastrate.
- Pause: Der Eingang läuft weiter, die Oberfläche verwirft die Blöcke (sonst
  wächst die Wellenform weiter) und gleicht danach die Peaks mit dem Hauptprozess ab.
- **Schlafsperre** (`powerSaveBlocker`) während Aufnahme/Pause. **Wächter** im
  Renderer: kommen 2,5 s keine Audioblöcke, wird der Eingang neu geöffnet und in
  dieselbe Datei weitergeschrieben (roter Balken, Lücke wird gemeldet). Anlass: Der
  Mac schlief ein, der Eingang blieb nach dem Aufwachen stumm, die Aufnahme stand
  still, die App zeigte weiter „läuft“.

### Ablaufplan und Standardpunkte
- Quellen der Abschnitte (`section.source`): `churchtools` (aus dem Ablaufplan), `plan` (Standardpunkte
  und in der Kachel selbst hinzugefügte Punkte), `manual` (mit M gesetzte Abschnitte). Alles außer `manual`
  zählt als Ablaufplan: Beim Entfernen eines gesetzten Abschnitts geht er zurück in den Plan, bei einer neuen
  Aufnahme werden die Plan-Punkte wieder offen (`manual` entfällt).
- Meldet ChurchTools für `/agenda` einen 404 (`err.status`) oder liefert keine Punkte, nutzt `ct:agenda` die
  Vorlage, deren Name zum Titel des Termins passt (`RoleLogic.templateForTitle`: alle Wörter des Vorlagennamens
  stehen als ganze Wörter im Titel, längster Name gewinnt; „Bibelstunde“ → Vorlage „Bibelstunde“), sonst die
  Standardvorlage aus `agendaTemplates`/`defaultTemplateId` (siehe „Vorlagen“ unten; Vorgabe: Einleitung,
  Kinderbeitrag, Predigt, Abschluss), und meldet `usedDefaults` und `templateName`. Der Termin wird dabei trotzdem gesetzt. `session:service` (ohne
  ChurchTools) trägt dieselbe Vorlage ein, wenn noch keine Abschnitte existieren. Ein vorhandener ChurchTools-Ablaufplan
  hat immer Vorrang.
- Liste „Ablauf“ (früher Kachel „Ablaufplan“): Knopf „ChurchTools …“ neben der Vorlagenwahl öffnet denselben Termin-Dialog wie der Klick auf den
  Gottesdienst in der Kopfzeile (`openServicePicker`); `#plan-source` zeigt die Herkunft: eine Zeile aus `session.agendaOrigin` (`{source, template}`, gesetzt in `setAgenda(items, source, templateName)`,
  in der Session-Datei gespeichert; bei alten Sessions aus `source` der Punkte abgeleitet): „Ablaufplan aus ChurchTools“ bzw.
  „Vorlage „Name““, bei ChurchTools-Termin (`service.id`) dahinter „· Dienste: n · Infotext ✓“ (Namen und Infotext im Tooltip).
- Liste „Ablauf“: Punkt hinzufügen (`section:add`), entfernen (`section:delete`), umsortieren per Drag in der
  Liste (`section:reorder`, setzt `order` der offenen Punkte neu). Dieselbe Drag-Quelle (`text/marker-id`) dient
  weiter zum Ablegen auf der Wellenform, das Ziel unterscheidet.

### Interpret aus ChurchTools
- Ablaufpunkt mit zuständiger Person (`item.responsible`, tolerant geparst in `responsibleText`/`personName`;
  verknüpfte Personen vor Freitext) → `artist` des Abschnitts (`setAgenda`: `it.responsible`).
- Dienstplanung: `churchtools.eventServices(eventId, wanted)` liest `GET /api/events/{id}?include=eventServices`,
  Dienstnamen über `GET /api/services`, Personennamen aus `es.person`, `es.name` (wenn ungleich Dienstname) oder
  per `GET /api/persons/{id}`; Filter: Dienstname enthält ein Wort aus Einstellung `artistServices`
  (Standard `Leitung, Predigt, Geschichte`; Dienste aus `RoleLogic.ALIASES` werden immer mitgelesen). Ergebnis in `session.service.suggestions` (`{role,name}`), im Editor
  (`editSection`) als Chips; passender Dienst zuerst (Wortvergleich: „Gebetsleitung“ passt nicht zu „Einleitung“; „Leitung“ → „Einleitung“ gilt nur über `ALIASES`).
  **Automatisch eintragen:** `Session.setAgenda` ruft `_applySuggestions()`: für Punkte ohne `artist` kommen die
  Namen aus `service.suggestions`, deren Dienst zum Punktnamen passt (`src/shared/roles.js`, `RoleLogic`:
  ganze Wörter, reine Zahlen zählen nicht; feste Zuordnung `ALIASES`: Dienst „Geschichte“ → Punkt „Kinderbeitrag“, Dienst „Leitung“ → Punkte „Einleitung“ und „Abschluss“; "Predigt 2" → Punkt "Predigt"; mehrere Treffer mit Komma; Rückfall `FALLBACKS`: passt kein Dienst zum Punkt „Einleitung“ (keine Leitung eingetragen, z. B. Bibelstunde), macht der erste Prediger sie). Dieselbe
  Regel sortiert die Chips im Editor. `setAgenda` gibt die Anzahl zurück (`autoFilled` in der Antwort von
  `ct:agenda`). Reihenfolge der Quellen: Ablaufplan-Person vor Dienstplanung.
  **Die genaue Antwortform von ChurchTools wurde nicht gegen eine echte Instanz geprüft** (nur mit nachgebauten
  Antworten); bei Abweichungen die echte Antwort ansehen und `eventServices` anpassen. Fehler beim Lesen stören
  den Termin-Import nicht (Hinweis per Toast, `suggestionError`).

### Meldungen (Toasts)
- Nur melden, was Aufmerksamkeit braucht: Fehler, Warnungen (Speicher, Eingang, Schreiben, Dienstplanung) und
  Hinweise, die sonst unsichtbar wären (z. B. Vorlage statt Ablaufplan, mehrere Termine heute). Bestätigungen, die
  man schon sieht (Aufnahme läuft/beendet, gespeichert, Rückgängig, Vorlage geladen, Schnitt entfernt), gibt es nicht.
  `toast()` zeigt dieselbe Meldung nicht doppelt und höchstens drei je Ort. **Fehler und Warnungen** (`error`/`warn`)
  erscheinen groß und farbig oben in der Mitte (`#alerts`, rot bzw. gelb, mit ⚠), bleiben mindestens 30 s (Fehler) bzw.
  15 s (Warnung) stehen und lassen sich per Klick schließen; Hinweise (`info`/`success`) klein unten rechts. Neue
  Meldungen daran messen. Ausnahme mit Knopf: Nach dem Entfernen eines Abschnitts bzw. Punkts (ohne Rückfrage) bietet
  ein Hinweis „Rückgängig“ an (`toast(level, text, timeout, { label, run })`).

### Infotext des Termins als Predigttitel
- `churchtools.eventServices` liefert zusätzlich `info` (`eventInfoText`: erste Zeile aus `description`, sonst
  `information`/`note`/`notes`/`info`, ohne HTML). Gespeichert in `session.service.info`; `Session._applyInfo()` hängt ihn
  beim ersten Abschnitt mit dem Wort „Predigt“ an: „Predigt: Kolosser 2,6-7 Verwurzelt in Christus“ (`baseLabel` merkt den
  ursprünglichen Namen, damit erneutes Laden keine Doppelten erzeugt und der Text nicht zweimal angehängt wird; Regel
  `RoleLogic.takesEventInfo`). Das Etikett ist Abschnittsname, Dateiname-`{abschnitt}` und ID3-Titel.
  Gerade Anführungszeichen aus ChurchTools (Titel der Ablaufpunkte und Infotext) setzt `typoQuotes` typografisch
  („…“, Apostroph ’), sonst stünden Schreibmaschinenzeichen in Namen, Dateinamen und ID3-Titeln.
  **Welches ChurchTools-Feld den Infotext trägt, ist nicht gegen eine echte Instanz geprüft** (mehrere Feldnamen
  werden probiert); bei Abweichungen die echte Antwort von `GET /api/events/{id}` ansehen und `eventInfoText` anpassen.

### Eingangsprotokoll (2026-10-11)
- Anlass: Am Kirchen-PC meldete der Wächter während einer echten Aufnahme immer wieder „Kein Audiosignal – der
  Eingang wird neu verbunden“, ohne dass am Pult etwas zu sehen war; in der Session fehlten etwa 2,5–3 Minuten gegenüber
  der Uhr. Ein Programmlog gab es bis dahin nur für den Updater. Die Ursache ist **ungeklärt** (Verdacht: Eingang
  „Systemstandard“/Windows-Ton, kurz hängende Oberfläche, Fenster gedrosselt).
- `src/main/inputlog.js` schreibt `userData/logs/eingang.log` (Ortszeit, eine Zeile je Ereignis, ab 2 MB → `.1`; Fehler
  beim Schreiben werden verschluckt, damit die Aufnahme nie gestört wird). Quellen: Hauptprozess (Lücken zwischen
  `audio:chunk` > 500 ms, `chunksStale`, Verzug des eigenen Zeitgebers, `powerMonitor`, Absturz der Oberfläche, Start/Ende),
  Oberfläche über IPC `log:input` (`window.api.logInput`): Lücken zwischen Blöcken, Wächter-Auslösung mit
  Zustandsfoto (`inputSnapshot`: Spur `zustand`/`stumm`, Audiokontext und Audiouhr, `visibilityState`, Fokus),
  Verzug des Wächter-Takts, `devicechange`, Zustandswechsel aus `Capture.onEvent` (Spur stumm/beendet, Kontext).
- **Aussetzer werden mit Stille gefüllt** (`Session.fillGap`, Stereo): Anlass war ein hörbarer Sprung in der Aufnahme –
  die fehlenden Sekunden stehen sonst gar nicht in der WAV, die Wellenform zeigt nichts, alles dahinter liegt gegenüber
  der Uhr zu früh. Ablauf: Der Wächter meldet `health:input` lost=true, der Hauptprozess merkt `fillGapPending`; beim
  ersten Audioblock mit Lücke (fehlend = Ankunft − Blocklänge − Ende des vorigen Blocks > 300 ms) füllt er sie über
  `pushAudio` in 0,5-s-Blöcken (Dauer, Wellenform, Lautheit wachsen mit; höchstens 300 s je Aussetzer). Das Merkmal
  bleibt gesetzt, bis die Wiederverbindung zu Ende ist (lost=false), damit ein verspäteter Block ohne echte Lücke es
  nicht verbraucht. Die Oberfläche holt danach Wellenform und Lautheit per `session.state()` neu (ihre mitgerechneten
  Peaks wären um die Lücke zu kurz). `session.gaps` (`{at, seconds}`) steht in der Session-Datei, damit man die Stellen
  findet. Bewusst **nur** bei Wiederverbindung, nicht bei jeder Verzögerung der Blöcke: Hängt nur die Oberfläche, kommen
  die Blöcke gesammelt nach, dann wäre Auffüllen falsch. Mehrspur füllt nicht (eigener Prozess meldet `gap`).
- Die Schwelle des Wächters (`WATCHDOG_MS` 2,5 s) bleibt unverändert, bis das Protokoll die Ursache zeigt – erst lesen,
  dann entscheiden.
- **Wächter setzt nach einem Hänger der Oberfläche eine Runde aus** (Takt > 1 s verspätet, höchstens einmal am Stück,
  nur bei laufender Erfassung; im Protokoll `waechterWartet: true`). Grund: Die Erfassung läuft im Audio-Thread weiter,
  ihre Blöcke warten in der Warteschlange; `recoverCapture` → `capture.stop()` setzt `port.onmessage = null` und würde
  sie verwerfen – aus einem Hänger würde echter Verlust. Geprüft (Mac, echte App, Oberfläche 3,5/6 s per DevTools
  blockiert): Aufnahmedauer = Uhrzeit, kein Neuverbinden. Dort kamen die Blöcke allerdings immer *vor* dem Takt an
  (dann griff der alte Wächter auch nicht); der Schutz deckt die umgekehrte Reihenfolge ab, die unter Windows nicht
  ausgeschlossen ist. Beim gewollten Schließen (`capture.stop`) wird `onstatechange` vorher entfernt, sonst stand bei
  jedem Beenden `audiokontext-weg` im Protokoll.
- **Ursache gefunden: Drosselung im Hintergrund** (2026-10-11, Hinweis des Nutzers: Aussetzer nur, wenn Ebbton nicht
  vorne war). Nachgestellt am Mac: Aufnahme, Fenster per AppleScript ausgeblendet, 7 min. Nach etwa 5 min drosselt
  Chromium stark: Zeitgeber bis 9 s verspätet, Audioblöcke kommen nur noch stoßweise (Lücken bis 7 s, die Audiouhr lief
  dabei ungestört weiter). Der Wächter verband zweimal neu und verwarf dabei die wartenden Blöcke – 16 s echtes Audio
  wurden zu Stille, 6 s fehlten ganz. Der Schutz „eine Runde aussetzen“ reicht dagegen nicht. **Abhilfe:**
  `backgroundThrottling: false` am Fenster und die Chromium-Schalter `disable-renderer-backgrounding`,
  `disable-background-timer-throttling`, `disable-backgrounding-occluded-windows` (oben in `main.js`, vor `ready`).
  Danach derselbe Test: Uhr 420,6 s, Aufnahme 420,4 s, keine einzige Protokollzeile zwischen Start und Ende;
  `document.visibilityState` bleibt `visible`. Die Schlafsperre `prevent-app-suspension` lief in beiden Fällen, sie
  verhindert die Drosselung durch Chromium also nicht. Die Schalter nicht entfernen, solange die Erfassung in der
  Oberfläche läuft.
- **Windows sieht anders aus** (Kirchen-PC, Stand *vor* der Abhilfe, Eingang „Stereomix“, je 7 min): minimiert −8,9 s,
  verdeckt (maximiertes Fenster darüber, Seite blieb `visible`) −6,8 s, im Vordergrund −0,08 s. Der Verlust ist **leise**:
  gleichmäßig 1,4–2 %, kein Wiederverbinden, keine `gaps`; die Audiouhr der Oberfläche läuft selbst zu langsam (der
  Audio-Thread bekommt zu wenig Rechenzeit, Chromium verwirft Eingangsdaten). Der Wächter sieht das nicht – bei Stereo
  gibt es keine Fehlbetragsmessung gegen die Uhr (Mehrspur hat eine).
- **Abhilfe reicht unter Windows nicht** (Kirchen-PC, gleicher Test mit 5135b92, 2026-10-11): minimiert −4,7 s (vorher
  −8,9), verdeckt −6,8 s (unverändert), Vordergrund −0,07 s. Die Abhilfe greift sichtbar: keine einzige Protokollzeile
  zwischen Start und Ende (vorher zehnmal `oberflaeche-haengt`), `visibilityState` bleibt auch minimiert `visible`. Der
  leise Verlust (1,1–1,6 %, keine `gaps`, kommt nach dem Zurückholen nicht wieder) bleibt aber. Geprüft per
  `GetProcessInformation(ProcessPowerThrottling)` nach 30 s und 6 min im Hintergrund: alle electron.exe-Prozesse
  Priorität Normal (GPU AboveNormal), **kein Effizienzmodus** (`state=0x0`) – Prozesspriorität/EcoQoS sind es also nicht.
  Verdacht (ungeprüft): Windows drosselt einzelne Threads (Audio-Thread des Renderers), solange das Fenster nicht vorne
  ist; per Prozessabfrage nicht sichtbar. (Überholt: Ursache war die Timer-Regel, siehe nächster Punkt.)
- **Ursache unter Windows: Timer-Regel von Windows 11** (bestätigt 2026-10-11, Kirchen-PC): Windows gewährt minimierten,
  verdeckten oder unhörbaren Programmen keine feine Timer-Auflösung mehr. Chromium nimmt GPU- und Audio-Prozess davon
  aus (`ProcessPowerThrottling`: `control=0x4 state=0x0`), den Renderer nicht. Test D (Mini-Fenster „immer oben“, Fokus
  woanders): +0,01 s – fehlender Fokus allein schadet nicht. Test E (minimiert, alle Ebbton-Prozesse per PowerShell
  `SetProcessInformation` ausgenommen): −0,09 s statt −4,7 s. **Abhilfe:** `timerres.js` nimmt den Renderer nach jedem
  Laden aus (`did-finish-load`, `webContents.getOSProcessId()`, neue PID nach Absturz/Neuladen → erneut). Ohne native
  Abhängigkeit: PowerShell mit kleiner C#-Klasse über `-EncodedCommand` (Skriptdateien sperrt die ExecutionPolicy am
  Kirchen-PC), asynchron. Ergebnis im Eingangsprotokoll (`timer-regel-ausgenommen` mit `control/state` bzw.
  `-fehlgeschlagen`), bei Fehlschlag Warnung „Fenster sichtbar lassen“. **Geprüft am Kirchen-PC** (6d9888e, Entwicklung,
  nicht gepackt): Renderer ausgenommen ohne Zutun (`control=0x4 state=0x0`, auch nach 6 min im Hintergrund), minimiert
  −0,01 s (vorher −4,7), verdeckt −0,02 s (vorher −6,8). Neuladen behält die PID (nichts zu tun); nach einem
  abgeschossenen Renderer wurde die neue PID 5 s später ausgenommen. Der erste Aufruf nach dem App-Start dauerte etwa
  18 s (PowerShell übersetzt die C#-Klasse); wer in dieser Zeit schon aufnimmt und minimiert, verliert dort noch etwas.
- **Fehlbetragsmessung (Stereo)** (`deficit.js`, `DeficitMeter`; Takt im Hauptprozess jede Sekunde): vergangene Zeit
  minus aufgenommene Dauer, Pausen ausgenommen, Messbeginn erst beim ersten neuen Block nach Start/Fortsetzen (sonst
  ~0,1 s Übertragungszeit als Dauer-Fehlbetrag). Gemeldet wird das **Minimum der letzten 10 Messungen** – Blöcke, die
  nach einem Hänger gesammelt nachkommen, sind kein Verlust. Mit Stille gefüllte Aussetzer zählen als aufgenommen.
  Protokoll `fehlbetrag` je angefangene halbe Sekunde, Gesamtwert bei `aufnahme-beendet`. Ab 2 s **Warnbalken** über
  `health.deficit` (halbe Sekunden, damit sich `health` nicht jede Sekunde ändert; auch für Netzwerk-Clients) statt einer
  Meldung – die verschwände nach 15 s, und gerade im Hintergrund sähe sie niemand; nach dem Beenden einmal als Warnung.
  Uhrendrift (< 100 ppm ≈ 0,5 s je 90 min) bleibt unter der Schwelle. Mehrspur misst selbst (`gap`). Geprüft am Mac:
  jeden 50. Block im Hauptprozess verworfen (Inspector) → Protokoll ab 0,5 s, Balken bei 2,5 s, Warnung nach dem Ende,
  Balken danach aus; Gegenprobe mit 3,5-s-Hänger ohne Verlust → Fehlbetrag 0.
- `lastChunkAt` wird beim Start gesetzt, sonst stand bei jedem Start `hauptprozess-keine-bloecke` im Protokoll. Ereignisliste und Deutung: `app/README.md`, Abschnitt „Eingangsprotokoll“.

### Absicherung der Aufnahme (Review Oktober 2026)
- Die Audioerfassung lebt im Renderer. Deshalb: kein „Neu laden“ im Mac-Menü (lag auf Cmd+R), Live-Reload des
  Renderers nicht während einer Aufnahme, und bei `render-process-gone` wird neu geladen. `init()` erkennt eine
  laufende Aufnahme und verbindet den Eingang sofort wieder (`recoverCapture`). Der Wächter im Renderer greift
  auch, wenn `capture.running` falsch ist; zusätzlich meldet der Hauptprozess `health.input = 'lost'`, wenn 5 s
  lang kein `audio:chunk` kommt (`chunksStale`). `recoverCapture` versucht es auch in der Pause weiter.
- `process.on('uncaughtException')` protokolliert nur (Electrons Fehlerdialog würde den Hauptprozess blockieren).
  Netzwerk: Nachrichten, die kein JSON-Objekt sind, werden abgewiesen; `wss.on('error')` fängt Port-Fehler.
- Speichern: Während der Aufnahme Autosave (3 s bei Änderungen, sonst alle 30 s für Wellenform/Dauer), danach
  gebündelt 800 ms nach jeder Änderung (`_scheduleSave`), `flushSave()` vor Laden/Neustart/Beenden. Session-Datei
  entsteht sofort beim Start. Eine geöffnete unterbrochene Aufnahme wird als wiederhergestellt gespeichert.
  Einstellungen werden atomar geschrieben (`.tmp` + `rename`).
- `start()` legt zuerst die WAV-Datei an; scheitert das, bleibt die angezeigte Aufnahme unverändert.
- WAV: siehe „Umgesetzte Review-Vorschläge“ (eigener Schreib-Thread, RF64 ab 4 GB). MP3-Export liest blockweise (30 s,
  `wav.readFrames`), räumt bei Fehlern die halbe Datei weg.
- Fernstart (`record.start` von Companion) startet ohne Rückfrage (`remote: true`); `record.toggle` beendet auch
  eine pausierte Aufnahme. Startbefehle setzen den Status lokal sofort auf `recording`, damit ein Doppeldruck die
  laufende Erfassung nicht beendet. Gehaltene Tasten (`e.repeat`) werden ignoriert.
- **Hinweistexte in den Einstellungen kurz halten** (Oktober 2026 gekürzt, waren zu lang): höchstens eine Zeile unter
  einem Feld, nur was man zum Ausfüllen braucht; Erklärungen gehören in `app/README.md`.
- Einstellungen: Reiter links (Audio · Mehrspur & Pult · Ablage & Export · ChurchTools · Vorlagen · Netzwerk · Programm),
  rechts nur die Gruppen des Reiters (`fieldset[data-tab]`, `showSettingsTab`; beim Öffnen immer zuletzt gewählter Reiter).
  Neue Felder in die passende Gruppe setzen; gelesen/gespeichert wird unabhängig von der Sichtbarkeit. Überarbeitung
  2026-10-08 siehe „Einstellungen (überarbeitet)“ unter „Oberfläche nach Phasen“.
- Der Netzwerkstatus steht nicht in der Kopfzeile (zu unwichtig), sondern nur in den Einstellungen unter „Netzwerk“
  (`#net-info`: Port, verbundene Clients).
- Einstellungen speichern startet die Netzwerkschnittstelle nur bei geänderten Werten neu. `settings:chooseFolder`
  wählt nur aus (speichert nichts). Der Updater sucht während einer Aufnahme nicht automatisch (siehe „Updates“).

### Umgesetzte Review-Vorschläge (Oktober 2026)
- **Schreiben in eigenem Thread** (`wav.js`): `WavWriter` öffnet die Datei synchron (Fehler sofort sichtbar),
  schreibt dann über einen Worker (`WORKER_SOURCE`, per `eval` gestartet, damit es aus `app.asar` heraus ohne
  entpackte Dateien läuft). Der Worker nutzt die fd des Hauptprozesses, schreibt Header etwa jede Sekunde,
  `fdatasync` alle 10 s; den fd schließt der Hauptprozess nach `closed`. `close()` liefert ein Versprechen;
  `Session.whenWritten()` / `session.writing` – Export, Fortsetzen und App-Beenden warten darauf. Ereignisse
  `error` (→ `health.write = 'error'`) und `slow` (> 32 MB Rückstau → `'slow'`).
- **RF64:** Neue Dateien haben 80 Byte Kopf mit `JUNK`-Block; ab 4 GB wird daraus `RF64`/`ds64`. `readInfo`
  liest Chunks und liefert `dataOffset` (44 bei alten Dateien, 80 bei neuen); alte Dateien werden beim Anhängen
  weiter im alten Format geschrieben (gedeckelt).
- **Cue-Marker in der WAV:** Nach dem Beenden (und bei jeder späteren Änderung der Abschnitte, über `save()`)
  schreibt `Session._syncCues` die Abschnitte per `wav.writeCues` hinter den `data`-Block: `cue `-Chunk plus
  `LIST/adtl` mit `labl` (Name, bei Interpret „Name (Interpret)“, Latin-1); typografische Anführungszeichen/Striche werden vorher zu ASCII (`toLatin1`), sonst entstünden Steuerzeichen und `ltxt` (Region mit Länge). Die Session-Datei
  bleibt maßgeblich. `readInfo` erkennt nachgestellte `cue `/`LIST`-Chunks und nimmt dann die Datenlänge aus dem Kopf
  statt der Dateigröße (sonst zählten sie als Audio). `WavWriter` mit `append` schneidet sie ab (`ftruncate`), beim
  erneuten Beenden kommen sie neu. RF64-Dateien (> 4 GB) bekommen keine Marker. Bei Aufnahmen, die nie beendet
  wurden (Absturz), gibt es keine.
- Beim Beenden gibt die Erfassung den angefangenen Block ab (`capture.flush()` vor `record.stop`).
- **Beenden-Rückfrage asynchron** (`confirmAndFinishRecording`, `guardClose`): blockiert den Hauptprozess nicht.
- **Fernbefehle mit echter Antwort:** `record.start/stop/toggle` warten auf `recording-started/-stopped`
  (`waitForRemote`, 8 s); die Oberfläche meldet Fehlschläge über `remote:result`.
- **Netzwerk:** Origin-Header → nur `monitor`; 5 Fehlversuche → 60 s Sperre (`auth_locked`); `monitor` bekommt
  den Zustand ohne Pfade/Namen (`_forRole`), Ereignisse ohne `wavPath`/`file` (`publishEvent`). „Im Ordner zeigen“ nur in Aufnahme-/Exportordner oder für eben
  exportierte Dateien (`revealable`). Passwortfelder verdeckt.
- **ChurchTools:** `requestAll` folgt der Paginierung; Kalender-Filter `churchToolsCalendarIds` (Auswahl in den
  Einstellungen, `ct:calendars`; Termine ohne Kalenderangabe bleiben); flache Überschriften im Ablaufplan
  werden Kategorie der folgenden Punkte.
- Die frühere, nie umgesetzte Einstellung `keepMasterWavDays` ist entfernt (wird beim Laden gelöscht) –
  automatisches Löschen von Masteraufnahmen ist bewusst nicht vorgesehen.
- Oberfläche: Aufnahmeknopf in der Pause „Aufnahme pausiert“ (gesperrt), „An Aufnahme anhängen“ statt
  „Fortsetzen“; Tooltips mit Cmd/Strg je System; Listenzeilen per Tastatur (Pfeile, Enter, F2); Fokus in
  Dialoge; Schnittfarben als CSS-Variablen (`--cut`, `--cut-text`); Wellenform reagiert auf andere
  Pixeldichte; typografische Anführungszeichen „…“ überall.
- Updater auf dem Mac ohne Zertifikat: Status `manual` mit Hinweis statt Fehler. Release-Workflow: Tag-Prüfung,
  Tests, Entwurf, beide Builds, dann Freigabe; Mac ohne Zertifikat ad hoc signiert (`-c.mac.identity=-`).
  App-Icon `app/build/icon.png` (1024 px, wird von electron-builder umgerechnet).
  Leere Secrets kommen als leere Umgebungsvariablen an: `CSC_LINK=""` hält electron-builder für einen Dateipfad
  („app not a file“), deshalb `unset CSC_LINK CSC_KEY_PASSWORD` im Zweig ohne Zertifikat.

### Releases nur für Windows (Oktober 2026)
- Mac-Releases vorerst abgeschaltet (kein Bedarf): Job `macos` in `release.yml` läuft nur mit Repository-Variable
  `MAC_RELEASE == 'true'`; `veroeffentlichen` gibt frei, wenn Windows erfolgreich und Mac erfolgreich **oder**
  übersprungen ist. Mac-Konfiguration in `package.json` und der Job bleiben stehen, damit das Einschalten reicht.

### Electron-Stand (Oktober 2026)
- Vor dem ersten Release von Electron 33 (ohne Sicherheitsupdates) auf **Electron 44** gehoben (Node 24, Chromium 152),
  dazu electron-builder 26 und electron-updater 6.8. Keine Erstveröffentlichung auf einem nicht mehr gepflegten
  Electron; vor jedem Release prüfen, ob die Hauptversion noch unterstützt wird (`npm view electron version`).
- Folgen: macOS ab 13 (`LSMinimumSystemVersion`), Bauen braucht Node ≥ 22.12 (CI: Node 24, `checkout`/`setup-node` v7).
  Ab Electron 43 öffnet `dialog.showOpenDialog` ohne `defaultPath` den Downloads-Ordner, deshalb gibt
  `settings:chooseFolder` den aktuellen Ordner mit (sonst Dokumente).
- **Vor Electron 45/46:** `safeStorage.encryptString/decryptString/isEncryptionAvailable` sind ab 45 veraltet und
  entfallen in 46. Dann `settings.js` auf `encryptStringAsync`/`decryptStringAsync` umbauen (entschlüsselt alte
  Werte weiter, bei `shouldReEncrypt` neu verschlüsseln), sonst ist der ChurchTools-Token weg.
- Geprüft nach dem Update: Tests auch mit Electrons Node (`ELECTRON_RUN_AS_NODE=1 electron --test test/*.test.js`),
  echte Aufnahme mit Abschnitten, Schnitt, Pause, Anhängen, Mithören, Mini-Fenster, MP3-Export mit ID3, Cue-Marker,
  ChurchTools-Token, gepackte Mac-App inkl. Schreib-Thread aus `app.asar`.
- **Tests:** `npm test` (`node --test`, Ordner `app/test/`, `helpers.js` ersetzt `./settings`). CI:
  `.github/workflows/test.yml` auf Windows und macOS. Neue Logik dort mit Tests absichern.

### Rückgängig, Schnitte, Vorlagen, Health
- **Rückgängig:** Pfeilknöpfe `#btn-undo`/`#btn-redo` im Kopf der Liste „Ablauf“ (Zustand aus `canUndo`/`canRedo` im Snapshot). `Session._changed()` vergleicht `JSON({sections, cuts})` mit dem letzten Stand und legt
  Änderungen auf einen Verlauf (`_undo`/`_redo`, 60 Schritte). `{ undoable: false }` für Änderungen, die nicht
  zurückgenommen werden sollen (Start, Stop, Laden, Ablaufplan laden: dort `_resetUndo()`). Mac: Menü
  „Widerrufen“ (eigener Eintrag, sendet `menu` `undo`; in Textfeldern `document.execCommand`), sonst Strg+Z
  im `keydown` (nur `ctrlKey`, damit nichts doppelt läuft).
- **Schnitte** (`session.cuts`, `{id,start,end|null}`): Taste X (live, `toggleCut`) oder Umschalt+Ziehen
  (`addCut`); überlappende werden verschmolzen, offene beim Stop geschlossen. `mp3.exportSegment` bekommt
  `skip` (`keepRanges` zerlegt in Teilstücke, jedes wird einzeln gelesen und codiert, 6 ms Fades an den
  Nähten). `exports[...].cuts` merkt die Schnitte zum Export, damit „geändert seit Export“ sie berücksichtigt.
  Segmente tragen `cuts` und `cutSeconds`.
- **Vorlagen:** Einstellungen `agendaTemplates` (`{id,name,items[]}`) und `defaultTemplateId`. Das frühere
  `defaultAgenda` wird beim Laden zur Vorlage „Gottesdienst“ migriert. `agenda:applyTemplate` ersetzt die
  offenen Punkte (Quelle `plan`); Auswahl `#plan-template` über der Liste „Ablauf“, Editor in den Einstellungen
  (Arbeitskopie `state.tpl`, gespeichert über `readTemplatesForSave`).
- **Health für Netzwerk-Clients:** Hauptprozess hält `health` (`input`: ok/silent/lost, `disk`) und hängt es an
  jeden veröffentlichten Zustand (`net.publishState({...snapshot, health})`). Stille = 20 s unter 0,001 Pegel
  (`levels`-Handler); `lost` meldet die Oberfläche über `health:input` (Wächter); Speicher alle 30 s
  (`refreshDisk`). Die Oberfläche zeigt `silent` als orangen, `lost` als roten Warnbalken (`applyHealth`).
- **Fallstrick Hilfsskripte:** Beim Bearbeiten von Dateien per Skript erst das Ergebnis berechnen und prüfen,
  dann schreiben. `open(p, 'w').write(fn(s))` leert die Datei, bevor `fn` läuft; ein Fehler dort hinterlässt
  eine leere Datei (so geschehen bei `settings.js`, wiederhergestellt mit `git checkout`).

### MP3-Export
- Einstellung `exportDir` (Oberordner). Gesetzt: Export ohne Dialog nach
  `<exportDir>/<Datum>_<Gottesdienstname aus ChurchTools>/`, vorhandene Dateien
  werden nie überschrieben (` (2)`). Leer: Zielordner wird beim Export abgefragt,
  die Dateien liegen dann direkt darin. Ordnername nutzt `slug()` und
  `session.service` (Datum lokal, Name aus ChurchTools).
- Dateiname: Muster `fileNamePattern`, Standard `{interpret}_{abschnitt}_{gottesdienst}_{datum}`
  (`buildFileName` in `main.js`). Ein leerer `{interpret}` hinterlässt keine doppelten
  Trennzeichen. Das alte Standardmuster `{datum}_{gottesdienst}_{abschnitt}` wird beim Laden der
  Einstellungen auf das neue umgestellt, selbst geänderte Muster bleiben unberührt.
- ID3-Tags (`id3.js`, eigener ID3v2.3-Schreiber, UTF-16): Titel = Abschnittsname, Album =
  `session.service.date`, Jahr, Interpret = `section.artist` bzw. Einstellung
  `defaultArtist`. `artist` ist ein Feld des Abschnitts (auch bei offenen Ablaufpunkten),
  bearbeitet direkt im Feld über `editSection()` (`app.js`): ein Overlay mit Name- und
  Interpret-Eingabe legt sich über Fähnchen bzw. Listenzeile (Enter speichern, Esc abbrechen,
  Fokusverlust speichert); es gibt keinen Dialog mehr. „Gesamte Aufnahme“ nimmt nur den Standard-Interpret. Das Start-Fähnchen
  der Wellenform zeigt den Interpreten hinter dem Namen (`hoverHandle` blendet „+ Interpret“
  ein); Doppelklick darauf startet den Editor im Interpret-Feld (`onRenameSection(id, 'artist', rect)`,
  `rect` = Fähnchen in Zeichenflächen-Koordinaten).
- Ausgewählt wird in der Liste „Ablauf“ (nach dem Beenden Häkchen je fertigem Abschnitt plus Zeile „Gesamte
  Aufnahme“, `fullRow`); der Knopf `#btn-export` steht als Hauptaktion im Transport und nennt, was gespeichert wird
  („2 Abschnitte als MP3 sichern“, „Alles gesichert ✓“; `updateExportButton`; `export:batch`, nacheinander, ein Fehler
  stoppt die übrigen nicht, `failed` in der Antwort). Vorausgewählt sind Abschnitte, die noch nicht gesichert
  wurden; **beim Beenden einer Aufnahme alle**, ohne Abschnitte die ganze Aufnahme (`prepareExportSelection`,
  `exportPrevStatus` erkennt den Wechsel recording/paused → stopped). Fortschritt über `export-progress` mit `index`/`total`.
- Gesicherte Abschnitte werden in der Session gemerkt (`exports`, Schlüssel =
  Segment-ID, mit Datei und Zeitraum). Weichen Anfang/Ende später ab, zeigt die
  Liste „geändert seit Export“. `exports` wird bei einer neuen Aufnahme geleert.

### Updates (Oktober 2026)
- Anlass: Am Kirchen-PC musste die Suche von Hand angestoßen werden, dann startete irgendwann der Installer ohne
  Ankündigung (`autoDownload` + `autoInstallOnAppQuit`, assistierter NSIS-Installer mit Seiten). Jetzt:
  `autoDownload = false`, `autoInstallOnAppQuit = false`; Ablauf Suche → Dialog „herunterladen?“ (`update:download`)
  → Fortschritt (`progress` in `update-status`) → Dialog „installieren?“ → `quitAndInstall(true, true)` (still, gleicher
  Ordner, Neustart). `install()` wartet 2,5 s (`installing` sichtbar) und prüft danach erneut auf Aufnahme.
- Nach dem Neustart: `lastVersion` in den Einstellungen ≠ laufende Version → `justUpdated`, Hinweis-Toast.
- Automatische Suche alle 2 h (Einstellung wird bei jedem Termin gelesen), nicht während Aufnahme, nicht wenn schon
  etwas gefunden/geladen ist. Fehler der automatischen Suche (offline) → kein Fehlerzustand, nur Vermerk in den
  Einstellungen; manuelle Suche, Download- und Installationsfehler öffnen den Dialog. „Später“ merkt sich Zustand+Version
  (`state.updateDismissed`), im Mini-Fenster wird der Dialog bis zum Verlassen aufgeschoben (`state.updatePrompt`).
- Protokoll `userData/logs/updater.log` (eigener kleiner Logger, max. 1 MB). Nicht gepackt (`npm run dev`) ist der
  Updater `unavailable`. Mac ohne Zertifikat: `manual` mit Knopf „Download-Seite öffnen“ (`update:openPage`).
- **Versionshinweise („Was ist neu?“):** Der Release-Workflow schreibt die Commit-Titel seit dem vorigen Tag als Notizen
  (ohne „Version x.y.z“, ohne Doppelte; Schritt „Versionshinweise zusammenstellen“, `fetch-depth: 0`). Vorher waren die
  Notizen leer, GitHub setzte dann die Tag-Nachricht („Version 1.0.3“, „Co-Authored-By: …“) ein und genau das stand im
  Dialog. `releaseNotesText` filtert solche Zeilen weiterhin heraus (alte Releases); `fullChangelog = true` zeigt die
  Hinweise aller übersprungenen Versionen mit Überschrift. **Commit-Titel landen damit bei den Nutzern:** verständlich formulieren.
  Interne Commits filtert der Workflow heraus: Titel, die mit `Doku`, `Test`/`Tests`, `CI`, `Intern`, `Release-Vorbereitung`
  oder `Release-Workflow` beginnen (gefolgt von Leerzeichen oder Doppelpunkt). **Alles andere, was Nutzer nicht betrifft,
  mit „Intern: “ beginnen** (z. B. Testkorrekturen, deren Titel mit einem anderen Wort anfängt). Anlass: In 1.1.1 stand
  „Test unter Windows: Hintergrund-Abhilfe verhindert den leisen Audioverlust nicht“ im Dialog – las sich, als wäre der
  Fehler ungelöst; die Hinweise mussten auf GitHub von Hand ersetzt werden.
- Tests: `test/updater.test.js` mit nachgebautem `autoUpdater` (Option `autoUpdater` im Konstruktor).

### Mithören
- Klick in die Wellenform setzt während der Aufnahme einen Hörcursor, Leertaste =
  Play/Pause (`monitor.js`). Gelesen wird blockweise aus der wachsenden WAV
  (`audio:read`, `Session.readAudio`), die Aufnahme bleibt unberührt. Marker
  werden weiterhin an der Live-Position gesetzt, nicht am Cursor.
- Ausgabegerät ist in den Einstellungen wählbar (`outputDeviceId`, `setSinkId`);
  über Lautsprecher landet das Mithören sonst im Mikrofon.

### ChurchTools
- ChurchTools behandelt `to` bei `/api/events` als **exklusiv** (`from = to` liefert nichts, so wurde der heutige Termin beim Start
  nicht geladen): `listServices` fragt bis zum Folgetag ab und filtert danach nach Ortsdatum.
- Beim Start wird heute geprüft: ein Termin wird geladen, bei mehreren der
  laufende bzw. nächste (Ende oder +2 h). Der Termin-Dialog zeigt die letzten und
  kommenden 5 Termine. ChurchTools liefert **UTC**; Zeit und Datum werden in
  Ortszeit umgerechnet (`withLocalTime`).

### Oberfläche
- **Mini-Fenster** (`setCompact` in `main.js`, IPC `window:compact`, Ereignis `compact`): dasselbe Fenster,
  nur verkleinert (Mindestgröße 320×164, Standard 360×168 unten rechts – jeweils Inhaltsgröße, Titelleiste/Rahmen kommen über
  `frameSize()` dazu, Lage in `compactBounds`; ältere, größere Lagen verwirft `settings.load` einmalig über `compactLayout: 2`), wahlweise
  immer im Vordergrund (`compactOnTop`). Bewusst kein zweites Fenster und kein Neuladen: Die Audioerfassung
  läuft in der Oberfläche. Die Ansicht blendet per `body.compact` alles außer Kopfzeile und Transport aus (M/N stehen
  jetzt im Transport); der laufende Abschnitt (`#current-item`, ein Button mit `#current-name`/`#current-artist`) steht groß
  mit Interpret im Mini-Fenster und öffnet per Klick `editSection` (nur im Mini-Fenster sichtbar; groß übernimmt das
  die Karte `#now-card` unter „Jetzt“); die Wellenform bleibt in 1000 px Breite außerhalb des Fensters (sonst Zoom 0 bei Breite 0).
  Nach dem Beenden (`body.review`) ersetzt die Karte `#compact-export` Aufnahme- und Abschnittsknöpfe: Zusammenfassung,
  ein Export-Knopf (`exportFromCompact` → `exportSelected`, wählt angehakte, sonst ungesicherte bzw. seit dem Export geänderte; ohne Abschnitte die ganze
  Aufnahme; ist alles gesichert, entfällt der Knopf) und „Neue Aufnahme“; Ergebnis und Fortschritt spiegelt `setExportResult` in beide Ansichten.
  Der Knopf N zeigt den Namen des ersten offenen Punkts (`#next-name`, `nextPending`, nach `order` sortiert).
  Die Wellenform baut ihre Zeichenfläche bei jeder Größenänderung neu auf (`ResizeObserver`) und beim Umschalten explizit
  (`applyCompact` → `wave.resize()`): Sonst kommt das Fenster-Ereignis vor der Umstellung der Ansicht und alles wirkt gestreckt.
  Die Laufzeit des aktuellen Abschnitts (`#current-elapsed`, `updateSectionElapsed`) tickt mit den `levels`-Meldungen aus
  `state.duration - state.sectionStart` und steht im Mini-Fenster in `#current-item`, groß in `#now-elapsed`; die Liste „Ablauf“ zeigt je Abschnitt `.dur`
  (`fmtLength`; beim laufenden mit `data-live`, von `updateSectionElapsed` mitgezählt).
  Dialoge passen nicht hinein: `openModal`, `confirmDialog` und `?` schalten vorher auf groß zurück.
  Kürzel Strg+Umschalt+M im Renderer, auf dem Mac Cmd+Umschalt+M über das Menü „Fenster“.
  **Aufbau (Stand 3):** `.transport` als Raster mit Bereichen „meters meters“ / „clock ctl“ / „current current“ /
  „mark next“; `.transport-controls` und `.clock` sind dort `display: contents`, die Knöpfe liegen direkt in den
  Bereichen. Kopfzeile (Name, „oben“, Umschalter) · Pegel als 5-px-Streifen L|R (Beschriftung, Zahl und Skala aus,
  „Übersteuert“ nur bei Übersteuerung) · Timer (28 px) mit „Aufnahme starten“ bzw. Pause/Beenden (Symbole, `.rec-ctl`;
  Beenden auch hier halten) · Karte des laufenden Abschnitts · M (normal) und N (Hauptknopf, „→ Predigt“). Je Phase nur
  die passenden Knöpfe (`body[data-phase]`, wie groß). „Immer oben“ heißt unter 380 px nur „oben“ (`.ontop-long`). Nach
  Änderungen alle vier Zustände bei 360×168 und 320×164 messen (kein Überlauf, keine abgeschnittenen Knöpfe).
- **Kopfleiste (aufgeräumt, Oktober 2026):** Alle Bedienelemente (Gottesdienst-Feld, Schild, Knöpfe, Umschalter) sind gleich
  hoch und gleich groß beschriftet – Variablen `--top-h`/`--top-font`/`--top-pad` auf `.topbar` (groß 40 px/15 px,
  unter 1180 px 36/14, kompakt 28/13, Mini 24/11; Block „Kopfleiste (aufgeräumt)“ am Ende von `styles.css`). Rechts
  Gruppen mit Abstand (`--top-group` vor „Aufnahmen“ und vor dem Ansicht-Umschalter): [Schild „● Mehrspur“] ·
  Aufnahmen/Einstellungen · Ansicht. Seit 2026-10-08 ruhiger: siehe „Kopfleiste (ruhiger)“ unter „Oberfläche nach Phasen“. Vorher: drei verschiedene Höhen (25/39/45 px) und kleinere Schrift in den
  Umschaltern – wirkte unordentlich.
- **Aufnahmeart in der Kopfzeile nur als Schild:** Stereo ist der Normalfall, Mehrspur wird selten genutzt. Deshalb kein
  Umschalter „Stereo | Mehrspur“ mehr (gab es kurz), sondern nur bei Mehrspur das farbige Schild `#btn-mode-badge`
  „● Mehrspur“ (`applyMode`; auch während einer Mehrspuraufnahme); Klick öffnet *Einstellungen → Audio* mit Fokus auf
  den Umschalter „Aufnahmeart“ (`openRecordingModeSetting`). Umgestellt wird dort oder per Companion (`mode.set`). Gemessen: kein Überlauf, Timer
  unverändert bei 1360/1024 groß und 960/760 kompakt, Mini 360 und 320 px.
- **Ansicht rechts oben (Variante „D“, Oktober 2026):** Größen-Umschalter „A A“ (`.size-switch`: kleines A =
  `#btn-dense` kompakt, großes A = `#btn-view-large` groß), daneben Symbolknöpfe (`.icon-btn`, Inline-SVG): Mini-Fenster
  `#btn-compact` und Hell/Dunkel `#btn-theme`. Der Text-Umschalter „Groß | Kompakt | Mini“ gefiel nicht. Im Mini-Fenster
  bleibt nur `#btn-compact` sichtbar (gedrückt; Klick = zurück in die vorige Ansicht, `state.dense`). Hell/Dunkel
  (`toggleTheme`) wechselt direkt und speichert `theme` (`light`/`dark`, auch aus „wie das System“ heraus); das Symbol zeigt
  das Ziel (dunkel → Sonne, hell → Mond). Zustand über `aria-pressed`. Renderer `setView(view)` → IPC
  `window:compact` mit `view` → `setView` im Hauptprozess (aus dem Mini-Fenster erst zurück, dann `setDense`).
- **Kompakte Ansicht** (**Voreinstellung**: `denseLayout: true`; `app:info` liefert `dense`): `body.dense` – dieselben Bereiche wie die große Ansicht, nur kleiner (Block
  „Kompakte Ansicht“ am Ende von `styles.css`). Der Hauptprozess senkt dafür die Mindestgröße auf `DENSE_MIN` 760×520
  (`normalMin()`, gilt auch beim Zurückschalten aus dem Mini-Fenster). **Umschalten ändert die Fenstergröße**
  (`setDense`): ein → Lage des großen Fensters in `largeBounds` (mit `maximized`), dann zuletzt benutzte kompakte
  Lage `denseBounds` bzw. `DENSE_DEFAULT` 960×640 um die bisherige Fenstermitte (`centeredBounds`); aus → `denseBounds`
  merken, `largeBounds` wiederherstellen (sonst 1360×880). Beides in den Einstellungen, damit es auch nach einem
  Neustart stimmt; die App startet in der kompakten Ansicht in `denseBounds`. Vollbild wird vorher verlassen; im
  Mini-Fenster wird nur die Einstellung gemerkt. Im Mini-Fenster wird `dense` nicht gesetzt
  (`applyDense`), damit sich die Regeln nicht in die Quere kommen. Nach Änderungen bei 760×520, 1024×680 und 1360×880
  messen; auch hier darf der Timer in keinem Zustand wandern (`.transport-controls` 412 px, Aufnahmeknopf 210 px).
- `body` hat `grid-template-columns: minmax(0, 1fr)`: Sonst macht die Mindestbreite der Kopfzeile (Badges, Knöpfe,
  langer Gottesdienstname) die Spalte breiter als das Fenster. Knöpfe der Kopfzeile und des Transports brechen nicht um
  (`nowrap`), stattdessen wird der Gottesdienstname mit „…“ gekürzt. Ab 1340 px hat der Transport 20 px Spaltenabstand,
  sonst passten die Knöpfe bei 1360 px nicht in die Außenspalte und brachen um.
- **Fallstrick `hidden`:** Eine Klasse mit eigenem `display` (z. B. `.follow { display: flex }`) überstimmt das
  `hidden`-Attribut – das Element bleibt sichtbar, obwohl der Code `hidden = true` setzt (so bei „Schleife“, ebenso bei
  der Statusseite fürs Handy). Für
  solche Elemente eine Regel `.klasse[hidden] { display: none; }` ergänzen; prüfen mit `getComputedStyle(el).display`.
- Der rote Punkt im Aufnahmeknopf hat `flex-shrink: 0`: Im großen Fenster (1360 px, beendete Aufnahme mit „An Aufnahme
  anhängen“) war der Knopf so knapp, dass der Punkt auf 0 px schrumpfte (sah aus wie verschwunden, kam beim Ziehen am
  Fenster wieder). Kleine feste Elemente in Flex-Knöpfen immer mit `flex-shrink: 0`; nachgemessen wird im echten
  Zustand (Aufnahme starten/beenden), nicht nur mit nachgestellter Fenstergröße – dort trat es nicht auf.
- Zeitangaben (Marken, Listen, Zeitleiste der Wellenform) nutzen dieselbe
  Schrift wie der große Timer: `var(--sans)` mit `font-variant-numeric: tabular-nums`.
  Keine Monospace-Schrift verwenden (`--mono` gibt es nicht mehr).
- Listen Ablaufplan/Abschnitte: Lange Namen werden mit „…“ gekürzt; die `.label` trägt den ganzen Titel samt Interpret als
  Tooltip (`fullTitle`), im Ablaufplan gefolgt vom Bedienhinweis der Zeile, bei Abschnitten vom Zeitraum.
- Wellenform-Beschriftung: Der Name am Start-Fähnchen wird mit „…“ auf den Platz bis zum Ende-Fähnchen
  gekürzt (`_fitText`, `_drawHandles`); reicht der Platz nicht, schrumpft das Ende-Fähnchen zur Lasche. Der
  Interpret erscheint nur bei genug Platz.
- **Wellenform zeichnen** (`_drawWave`): in Gerätepixeln; herausgezoomt fasst jede Spalte feste Buckets zusammen, gerechnet
  ab Aufnahmebeginn, und die Ansicht wird nur um ganze Pixel verschoben. Vorher wurden die Buckets ab dem linken Rand
  verteilt: Bei jedem Folgen/Ziehen sprangen die Spitzen zwischen den Spalten (Flackern bei langen Aufnahmen). Außen
  der Spitzenwert (halbtransparent), innen der leicht geglättete Mittelwert, damit herausgezoomt Kontur bleibt statt
  eines gleichmäßigen Blocks. Die Lautheitslinie nimmt ihre Stützstellen ebenso an festen Zeitpunkten.
- Wellenform: Standardansicht 5 Minuten (`DEFAULT_VISIBLE_SECONDS`, `setDefaultZoom()` beim Start und
  bei neuer/fortgesetzter Aufnahme), beendete Aufnahmen werden eingepasst (`fitZoom`). Der Zoom wird nicht
  mehr in den Einstellungen gespeichert.
- Die unteren Bereiche sind bewusst groß ausgelegt (Zeilenschrift 16 px, Überschriften 17 px, Knöpfe
  ✎/× 34 px Fläche, Eingabefelder 16 px); „Jetzt“ ist 360 px breit (unter 1180 px 300, kompakt 290/250). Zeilen der
  Liste „Ablauf“ sind einzeilig. Beim Ändern der Größen bei 1360×880 und 1024×680 messen.
- Kopfleiste, Transport und Werkzeugleiste sind ebenfalls groß (Dienstname 21 px, Aufnahmeknopf 18 px,
  Timer 60 px, Pegel 300 px breit). Für kleine Fenster gibt es zwei Abstufungen: `max-width: 1180px` (kleinere
  Schrift/Abstände, sonst läuft die Seite über) und `max-height: 820px` bzw. `720px` (Wellenform 150/120 px
  hoch, engere Leisten, damit unten genug Platz für die Listen bleibt). Mindestfenster ist 1024×680 (kompakt 760×520); nach
  Änderungen bei 1360×880 **und** 1024×680 messen (kein Überlauf: `scrollWidth == innerWidth`).
- **Der große Timer darf in keinem Zustand wandern** (bereit, läuft, pausiert, beendet): `.transport-controls` hat in
  allen Phasen dieselbe feste Breite (486 px, kompakt 412 px); die Knöpfe darin kürzen ihren Text („→ Pre…“) statt die
  Zone zu verbreitern. Gleiches Schriftgewicht des Timers in allen Zuständen (ein dickeres Gewicht während der Aufnahme
  verschob ihn um 1 px). Ändern sich Beschriftungen oder Größen, in allen vier Zuständen bei 1360, 1024, kompakt 960
  und 760 px die Timer-Lage messen (`#timecode`), siehe „Oberfläche nach Phasen“.
  Ab 1340 px Fensterbreite sitzt er exakt in der Fenstermitte (Spalten `1fr 300px 1fr`); darunter (Knöpfe + Pegel brauchen
  mehr Platz) bleibt er zwischen beiden stabil, aber nicht mittig.
- Layout unter der Wellenform: zwei Bereiche (Ablauf | Jetzt, bei Mehrspur Ablauf | Kanäle), ganz
  unten die Tastenleiste (`.keybar`). Die Kürzelliste steht zentral in `shortcutList()`
  (`app.js`) und speist Leiste und Dialog (`?`): neue Kürzel dort eintragen.
  Speicherplatz (`disk:free`, `fs.statfsSync`; Stunden aus der Abtastrate, 16 Bit Stereo) steht dauerhaft nur in den
  Einstellungen unter „Ablage“ (`#disk-info`); `#disk-badge` in der Kopfleiste erscheint nur bei knappem Platz
  (orange < 3 h, rot < 30 min).
- Layout-Vorschau ohne Electron: statischer Server auf `app/src` und eine Seite mit
  Mock-`window.api` (CSP verbietet Inline-Skripte, Mock als eigene Datei laden). Die
  Bildschirmfotos funktionieren im frisch geöffneten Tab ohne `resize_window`; mit gesetzter
  Fenstergröße waren sie unzuverlässig skaliert (dann Größen über `getBoundingClientRect()`
  messen). Für die Wellenform allein genügt eine Testseite mit `waveform.js` und Beispieldaten.
  Vorschau-Dateien (`_*.html/js`, `.claude/launch.json`) danach wieder löschen.

### Entwicklung
- `npm run dev` startet neu bei Änderungen im Hauptprozess, **außer während einer
  Aufnahme** (dann nur ein Hinweis). Änderungen am Renderer laden die Oberfläche
  sofort neu – ebenfalls **nicht während einer Aufnahme** (die Audioerfassung läuft in der Oberfläche). Nach Änderungen an `main`/`preload`/`shared` also App neu starten:
  `pkill -f "app/node_modules/[e]lectron"; cd app && npm run dev`
  (die Klammer in `[e]lectron` verhindert, dass pkill sich selbst beendet).
- Claude öffnet für den Neustart einen Terminal-Tab (`run_in_terminal`); davon sind höchstens
  6 pro Sitzung erlaubt. Vor jedem Neustart den vorherigen Tab mit `stop_terminal_tab`
  (`close: true`) schließen.
- DevTools öffnen nicht automatisch: F12 bzw. Strg/Cmd+Umschalt+I oder
  `npm run dev:tools`.
- Tests: `npm test` im Ordner `app/`. Für eigene Prüfskripte: `settings`-Modul per `Module._load` ersetzen
  (siehe `test/helpers.js`), Aufnahmen mit `stop()` beenden und auf `whenWritten()` warten.
- Mehrspur-Tests: Der Simulator tickt per `setInterval`; scheitert ein Test vor `unmonitor()`, endet der Testprozess nie
  (Windows-CI hing so stundenlang, alle Läufe ab 1.0.6). `multitrack.test.js` hält deshalb nach jedem Test alle
  Simulatoren an (`test.afterEach`). Blockgrößen sind systemabhängig (Windows öffnet mit `frameSize` 0, der Simulator
  nimmt dann 256 statt 512): Zeiten in Sekunden prüfen, nicht in Blöcken. Windows lässt sich grob nachstellen mit
  `process.platform = 'win32'` per `--require` plus `TEMP`; auf dem Mac gibt es kein `timeout` (`perl -e 'alarm …'`).
- Tests dürfen keine Dateideskriptoren unter der Hand schließen: Die Nummer wird sofort neu vergeben (z. B.
  an den Kanal des Testrunners) und der Schreib-Thread schreibt dann dort hinein.

### Name
Die App hieß früher „ChurchRecorder“ und heißt jetzt **Ebbton** (Ton + EBBP, Verein: Evangelische Baptisten-Brüdergemeinde
Pfungstadt). Kennungen: `appId` `de.ebbp.ebbton`, Companion-Modul `ebbton` (Variablen `$(ebbton:…)`), WebSocket-`app`-Feld
`ebbton`, Repo `paddepf/ebbton`. Electron legt die Einstellungen unter `userData/<name aus package.json>` ab, also
`~/Library/Application Support/ebbton` (Windows `%APPDATA%\ebbton`); beim Umbenennen musste der alte Ordner
`church-recorder` von Hand umbenannt werden, sonst startet die App mit leeren Einstellungen. Auch der ChurchTools-Token
ging dabei verloren: Er ist mit `safeStorage` verschlüsselt, dessen Schlüssel in der Schlüsselbundverwaltung unter dem
App-Namen liegt; unter neuem Namen gibt es einen neuen Schlüssel (Meldung „Token konnte nicht entschlüsselt werden“),
der Token musste in den Einstellungen neu eingetragen werden. Bei einer weiteren Umbenennung wieder daran denken.
Der Ordnername des lokalen Klons ist egal.

### Companion-Modul (API 2.1, Oktober 2026)
- Auf Modul-API 2.1 umgestellt (`@companion-module/base` ~2.1.3, Tools 3, Modulversion 2.0.0), weil am Kirchen-PC
  Companion 5.0.7 läuft. **Nicht auf API 2.2 heben, solange dort Companion 5.0.x läuft** (2.2 braucht Companion 5.1);
  vorher Companion-Version erfragen. Companion 4.x lädt das Modul nicht mehr.
- Unterschiede zu 1.x, die beim Weiterarbeiten zählen: Klasse wird `export default` exportiert (kein `runEntrypoint`),
  `export const UpgradeScripts`; Passwort (`secret-text`) kommt als drittes Argument von `init`/`configUpdated` im
  Secrets-Objekt (Getter `password` nimmt zur Sicherheit auch das alte `config.password`); Variablen als Objekt;
  `parseVariablesInString` gibt es nicht mehr (Companion setzt Variablen in `useVariables`-Feldern selbst ein);
  Presets `type: 'simple'` ohne `category`, Gliederung in `buildPresetStructure()`; `checkAllFeedbacks()` statt
  `checkFeedbacks()` ohne Argument. `apiVersion` im Manifest trägt das Build-Werkzeug ein.
- **Modul 2.2.0:** Variablen `current_artist`/`next_artist` (Personennamen fehlen beim Mitlese-Passwort, dann „-“), `section_elapsed`
  (im Modul aus `duration` − `currentSegment.start` gerechnet, tickt mit den `levels`), `item_index`/`item_total`/`item_progress`
  (Ablaufpunkte = `source` ≠ `manual`; begonnen = Anfang gesetzt), `loudness_*` (aus `levels.loudness`, nur Stereo), Rückmeldung
  `section_running` (optional mit Namensteil). Keine Änderung an der App-Schnittstelle nötig.
- Paket: `npm install && npm run package` im Ordner `companion-module/` → `ebbton-<version>.tgz`, in Companion über
  „Import module package“. Die `.tgz` wird nicht eingecheckt.

### Mehrspuraufnahme (Oktober 2026; seit 2026-10-08 in `main`, Test am echten Pult steht aus)
- Ziel: Aufnahmeart Stereo/Mehrspur wählbar (Einstellungen, Companion; in der Kopfzeile nur ein Schild bei Mehrspur); im Mehrspur-Modus alle 32 Kanäle des M32 über die DN32-USB-Karte
  (ASIO) aufnehmen, Kanalnamen/-farben per OSC vom Pult, später über die USB-Ausgänge zurückspielen (virtueller
  Soundcheck, Nachmischen). **Mehrspur ersetzt Stereo:** Für Mehrspur stellt der Nutzer am Pult die Kartenausgänge auf
  Kanal 1–32 um, die Matrix (sonst auf 1–2) fehlt dann. Kein eigener Stereo-Mix, kein MP3-Export im Mehrspur-Modus.
  Routing-Erkennung per OSC soll warnen, wenn Schalter und Pult nicht zusammenpassen. Eingangsquellen am Pult schaltet
  Ebbton **nicht** um (Gefahr: keine Mikros im Gottesdienst). Nur Windows; auf dem Mac nur Simulation bzw. CoreAudio.
- Festlegungen: 32 Mono-WAVs, 24 Bit, Rate des Treibers, Ordner pro Aufnahme, Dateinamen nach Pultnamen; alle Kanäle
  scharf, einzeln abwählbar; Abschnitte laufen mit; eigener Ordner für Mehrspur-Aufnahmen. Kanalübersicht als
  Bereich „Kanäle“ an der Stelle des Exports; die Wellenform (Abschnitte!) bleibt, sie zeigt den lautesten Kanal. Kirchen-PC: Samsung PM981a NVMe 512 GB, etwa 16,6 GB je Stunde bei 32 Kanälen.
- Reihenfolge: 1 Technik-Test (erledigt) → 2 Anbindung an die Session (erledigt) → 3 OSC/Routing mit Pult-Simulator (erledigt) →
  4 Oberfläche (erledigt) → 5 Zurückspielen (erledigt) → 6 Test am Pult (offen). Auf Wunsch schon vor dem Pult-Test
  nach `main` zusammengeführt (Branch `mehrspur` gelöscht, es wird nur noch auf `main` gearbeitet). Ohne Umstellung
  bleibt alles Stereo; ASIO/DN32, OSC-Adressen und Routing-Werte sind weiter ungeprüft.
- **Audio über `audify`** (MIT, RtAudio; N-API, also ohne Neubau für Electron; Windows-Builds mit ASIO). audify meldet
  Überläufe des Treibers nicht (Status im Callback wird ignoriert) und verwirft Blöcke mit abweichender Framezahl
  still. Deshalb eigene Aussetzererkennung in `engine.js`: 1 s ohne Block → `stall`, nach 3 s Gerät neu öffnen
  (wiederholt, neues RtAudio-Objekt, Gerät per Name), danach `gap` mit Stelle und Länge; zusätzlich Fehlbetrag
  gegen die Uhr über ein 5-s-Fenster (> 0,25 s → `gap`), damit Uhrendrift und verspätete Blöcke nicht zählen.
  Lücken werden nicht mit Stille aufgefüllt. Format vom Gerät: Int32, die oberen 3 Bytes ergeben 24 Bit.
- Puffer: unter ASIO `frameSize` 0 (= Einstellung im Treiber-Panel), sonst 512 (CoreAudio nähme sonst 15 Frames).
  Der Strom wird mit Ausgängen geöffnet, wenn das Gerät welche hat: ASIO erlaubt meist nur einen Strom je Gerät, das
  Zurückspielen muss über denselben laufen.
- **Eigener Prozess** (`utilityProcess`, `host.js`/`manager.js`): Erfassung und Schreiben laufen nicht im Hauptprozess
  (32 Kanäle ≈ 6 MB/s) und nicht in der Oberfläche. Schreiben: je Spur 0,5 s sammeln, dann ein asynchrones `pwrite`
  (Thread-Pool von Node), Kopf alle 2 s, `fdatasync` alle 10 s; Dateien werden mit `wx` angelegt (nie überschreiben),
  scheitert eine, werden die übrigen wieder gelöscht. `wav.buildHeader` hat dafür `bitsPerSample` bekommen (Standard 16).
- Technik-Test `EBBTON_MT_PROBE` (`probe.js`, ganz oben in `main.js` abgezweigt, siehe `app/README.md`): läuft auch mit
  der installierten App. Geprüft auf dem Mac (Oktober 2026): Simulation und echtes Mikrofon (CoreAudio), jeweils in
  Entwicklung und gepackt (`electron-builder --mac dir`); audify wird von electron-builder entpackt
  (`app.asar.unpacked`), Quellcode/`vendor` (17 MB) über `build.files` ausgeschlossen. **Noch nicht geprüft:** Windows mit
  ASIO (erst mit ASIO4ALL/FlexASIO ohne Pult, dann DN32-USB mit 32 Kanälen) und der Windows-Build im Release-Workflow.
  Der CI-Test „audify lädt“ prüft auf dem Windows-Runner, dass die ASIO-Schnittstelle vorhanden ist.
  Unter Linux wird er übersprungen (fehlendes `libpulse`; so scheiterte v1.0.6, als die Release-Vorbereitung noch auf
  Ubuntu lief). Seitdem testet `vorbereiten` in `release.yml` auf `windows-latest` (Git Bash), also dort, wo die App läuft.
- Gerätenamen von CoreAudio kommen bei Sonderzeichen verstümmelt an (audify); für ASIO („DN32-USB“) unerheblich.
- „Automatisch“ (kein Mehrspur-Gerät gewählt): meiste Eingänge, bei Gleichstand das Standard-Eingabegerät
  (`byInputsThenDefault`, `isDefault` aus `engine.devices`). Anlass: Auf dem Mac haben alle Eingänge einen Kanal,
  gewählt wurde zufällig das iPhone-Mikrofon (Continuity), das dann verschwand. audify reicht Meldungen aller
  RtAudio-Verbindungen an den zuletzt gesetzten Empfänger weiter; „no open stream to close“ (beim Aufräumen) wird
  verworfen, „Gerät neu öffnen fehlgeschlagen“ nur einmal je Ausfall protokolliert (sonst alle 3 s).
- **Anbindung an die Session (Schritt 2):** `session.mode` (`stereo`/`multitrack`), `tracks` (`{channel, name, file}`,
  `file` nur Dateiname) und `trackDir`. Im Mehrspur-Modus steht statt des `WavWriter` ein `TrackWriterProxy`
  (`manager.js`) in `session.writer`: Dauer aus den Pegelmeldungen, `pause()`/`resume()` (der Mehrspur-Prozess
  verwirft in der Pause, das Gerät bleibt offen), `close()` = Stopp im Prozess. So laufen Start, Pause, Stopp,
  Anhängen, Abschnitte, Autosave, Schlafsperre und `whenWritten` unverändert. Den Start macht der Hauptprozess
  (`startMultitrack`/`continueMultitrack` in `main.js`): Gerät wählen, `session.multitrackTarget()` legt den Ordner
  an, erst der Prozess die Dateien, dann `session.start({ multitrack })`; scheitert der Prozess, wird der leere
  Ordner wieder entfernt. Die Oberfläche ruft weiter `rec:start`/`rec:continue`, startet im Mehrspur-Modus aber
  keine eigene Erfassung, ihr Wächter und `recoverCapture` greifen dort nicht (`isMultitrack()`), ebenso nicht der
  `chunksStale`-Wächter im Hauptprozess; stattdessen `stall`/`gap` des Prozesses → `health.inputLost` und Meldungen.
- Mehrspur-Ablage: `<multitrackDir>/<Datum_Zeit_Gottesdienst>/` mit `NN_Kanalname.wav` und der Session-Datei; beim
  Laden werden die Spuren neben der Session-Datei gesucht (Ordner darf verschoben werden). `listSessions` liest
  zusätzlich die Unterordner des Mehrspur-Ordners. Gesucht wird nur auf Knopfdruck und nicht während einer
  Aufnahme (`multitrack:devices`): RtAudio lädt dafür die ASIO-Treiber zur Probe, ob das eine laufende
  WDM-Stereoaufnahme über denselben Treiber stört, ist ungeprüft.
- Wellenform: Der Mehrspur-Prozess liefert je 50 ms den Spitzenwert über alle aufgenommenen Spuren (`buckets` in der
  Pegelmeldung), Session und Oberfläche hängen sie an. Pegel der Session = lautester aufgenommener Kanal (`l` = `r`),
  dazu `tracks: {peaks, clips}` aller Gerätekanäle für die Oberfläche; ins Netzwerk geht nur der Gesamtpegel.
- Einstellungen: `recordingMode`, `multitrackDevice` (Name, leer = meiste Eingänge), `multitrackSimulate`,
  `multitrackArmed` (0-basiert, `null` = alle), `multitrackDir` (leer = `Mehrspur` im Aufnahmeordner). Vorerst
  in *Einstellungen → Audio*; Kanalwahl und Namen kommen mit Schritt 3/4 (bis dahin „Kanal n“).
- Kein MP3-Export, kein Mithören, keine Cue-Marker bei Mehrspur (`export:batch` lehnt ab). Beim Stopp endet der laufende Abschnitt bei der zuletzt gemeldeten Dauer (bis etwa 50 ms vor Dateiende).
- Geprüft (Mac, Simulator): Tests mit echter Engine (Session-Ablauf inkl. Laden/Anhängen) und die App per
  WebSocket-Fernsteuerung sowie per Knöpfen (Start, Abschnitt, Pause, Stopp, Anhängen, Einstellungen).
- **Oberfläche (Schritt 4):** Aufnahmeart = Einstellung `recordingMode` (in der Kopfzeile nur das Schild, siehe
  „Oberfläche“). `body.mt` (`multitrackView()`: folgt der Einstellung, während einer Aufnahme deren Art) ersetzt rechts
  „Jetzt“ durch
  den Bereich „Kanäle“ (`renderChannels`, `channelModel`, `applyTrackLevels`); die Spalte ist dann breiter
  (`minmax(380px, 1.25fr)`, kompakt 330 px), damit die Namen passen. Passen Aufnahmeart und angezeigte Aufnahme nicht
  zusammen: Seit dem Umbau nach Phasen richtet sich der Export nach der Art der *angezeigten* Aufnahme
  (`body.mt-session`): Eine Stereo-Aufnahme lässt sich auch bei „Mehrspur“ sichern (Hinweis im Kanal-Bereich), eine
  Mehrspuraufnahme bei „Stereo“ zeigt unter „Sichern“ nur „n Spuren als WAV gespeichert“ und keinen Sichern-Knopf. (Früher blieb der
  Kanal-Bereich bei angezeigter Mehrspuraufnahme stehen, egal wie die Aufnahmeart stand – wirkte wie ein Fehler.)
  Gemessen: kein Überlauf, Timer gleich in beiden Modi, keine gekürzten Kanalnamen bei 1360×880, 1024×680, kompakt
  960×640 und 760×520.
- **Abhören vor dem Start:** `engine.monitor()` öffnet das Gerät ohne Aufnahme; `start()` übernimmt den offenen Strom
  (ASIO: nur einer), `stop()` lässt ihn beim Abhören offen, `open()` mit anderer Rate (Anhängen) öffnet neu, während der
  Aufnahme wird ein Gerätewechsel abgelehnt. Hauptprozess `updateMonitor()` (Warteschlange, damit sich Aufrufe nicht
  überholen): im Mehrspur-Modus und ohne laufende Aufnahme offen, im Stereo-Modus geschlossen (gemessen); fehlt das
  Gerät, alle 10 s neuer Versuch; Aufrufe bei App-Start, Einstellungsänderung und nach `whenWritten` eines Stopps.
  Aussetzer beim Abhören (`stall`/`gap` mit `recording: false`) nur als Status, keine Meldung. Stürzt der Prozess ab,
  wird er nach 2 s neu gestartet, mehr als drei Abstürze je Minute → aus bis zum App-Neustart (Schutz vor
  Absturzschleifen durch einen Treiber). Kanalpegel gehen als `track-levels` an die Oberfläche (auch vor dem Start).
- Kanalwahl: Klick auf einen Kanal (nicht während der Aufnahme) schreibt `multitrackArmed`; alle gewählt → `null`
  (neue Gerätekanäle kommen automatisch dazu), keiner → abgelehnt. Während der Aufnahme zeigt der Bereich die Spuren
  der Aufnahme (fest), nicht aufgenommene Kanäle mit aktuellem Pultnamen. Stumm: gewählter Kanal 20 s unter 0,001 während
  der Aufnahme (wie die Stereo-Stillewarnung), nur im Kanal-Bereich, keine Meldung.
- Fehler aus Schritt 2 behoben: Die Oberfläche hing „An Aufnahme anhängen“, die Ansicht nach dem Beenden
  (`body.review`) und die Rückfrage vor einer neuen Aufnahme an `session.wavPath` – bei Mehrspur `null`. Jetzt
  `hasAudio(session)`. (Der damalige Test hatte den versteckten Knopf per Skript geklickt.)
- Geprüft (Mac, Simulator, echte App per DevTools-Protokoll): Kanalwahl, Aufnahme, Sperren, Stummwarnung, Neuladen
  der Oberfläche während der Aufnahme (Aufnahme läuft ungestört weiter), Beenden, Umschalten, Gerät im Stereo-Modus frei.
- **Zurückspielen (Schritt 5):** `player.js` liest die Spuren (0,5-s-Zwischenspeicher je Spur) und baut Ausgabeblöcke
  (Int32, alle Ausgänge, Spur auf Kanal k → Ausgang k, Kanäle ohne Spur still) mit Springen und Schleife (nahtlos).
  `engine.play()` nur bei offenem Gerät und ohne Aufnahme; den Takt gibt das Gerät vor: audify ruft nach jedem
  verbrauchten Block `frameOutputCallback`, dann wird nachgelegt (etwa 150 ms Vorlauf, `PLAY_AHEAD_SECONDS`); leere
  Warteschlange = Stille. Position = Anfang des gerade laufenden Blocks. `start()` beendet das Abspielen. Der Simulator
  verbraucht Ausgabeblöcke im Eingangstakt (`captureOutput` für Tests: lückenlos, richtige Reihenfolge, richtiger Ausgang).
- Hauptprozess `multitrack:play/seek/loop/stopPlay`: öffnet das Gerät mit der Rate der Aufnahme (`monitor` mit
  `sampleRate`); im Stereo-Modus wird es nach dem Ende bzw. Stopp per `updateMonitor()` wieder freigegeben (gemessen).
  Laden einer anderen Session oder „Neu“ beendet das Abspielen; die Oberfläche stoppt es auch vor einem Stereo-Start
  (bevor die Erfassung den Eingang öffnet). Oberfläche: „Zum Pult abspielen“/„Stopp“ (`toggleMultitrackPlayback`),
  Wellenform-Klick/Abschnitt-Klick springen (`setPlayhead`), „Schleife“ (`#chk-loop`, `playbackLoop`: gewählter
  Abschnitt, sonst ganze Aufnahme), Position im Kanal-Bereich, einmaliger Hinweis auf die Quelle am Pult.
  Knopf und Schleife gibt es nur in der Mehrspur-Ansicht (`applyPlayControls`); in der Stereo-Ansicht ist der Knopf bei
  einer Mehrspuraufnahme gesperrt (Tooltip: auf „Mehrspur“ schalten), die Schleife ausgeblendet. Umschalten auf
  Stereo gibt das Gerät frei und beendet damit ein laufendes Abspielen.
- Eingangsquellen am Pult schaltet Ebbton weiterhin nicht um. **Ungeprüft:** echte Ausgabe über ASIO/DN32 (Latenz,
  ob audify bei ASIO die Ausgabe sauber taktet) – erst am Pult.
- **Mischpult per OSC (Schritt 3, `src/main/mixer/`):** nur lesend, UDP 10023, eigenes kleines OSC (`osc.js`, keine
  Abhängigkeit). `client.js` liest `/ch/NN/config/name|color` und `/config/routing/CARD/1-8 … 25-32`, meldet sich mit
  `/xremote` an (alle 8 s erneuern, Änderungen am Pult kommen sofort), Lebenszeichen per `/xinfo`; 12 s ohne Antwort
  → `lost`, dann alle 5 s `/xinfo`, beim Wiederkommen alles neu lesen. Ein Lesevorgang, während dessen die Verbindung
  abriss (`_epoch`), oder bei dem nicht alle Kanalnamen antworteten, zählt nicht (sonst blieben nach einem
  Szenenwechsel bei ausgeschaltetem Pult alte Namen stehen – im Test gefunden). Routing-Antworten zählen dafür nicht
  mit, damit falsche Adressen kein Dauer-Nachlesen auslösen. Pultsuche: `/xinfo` per Broadcast.
- **Adressen und Routing-Werte sind nicht am echten M32 geprüft** (aus der inoffiziellen X32-OSC-Doku: Wert 0–19 =
  Eingangsblöcke AN/A/B/CARD, 20/21 = OUT1-8/OUT9-16 …). Deshalb Anlernen (`mixerRouting` `{stereo, multitrack}`,
  je vier Werte, `mixer:learn`): gemerkte Werte haben Vorrang vor der Faustregel „Block 1–8 führt Ausgänge = Stereo,
  Eingänge = Mehrspur“ (`m32.routingKind`). Am Pult prüfen, dann ggf. `ROUTING_SOURCES` korrigieren.
- Spur k = Pultkanal k (so beschrieben: im Mehrspur-Routing liefern die USB-Ausgänge die Kanäle 1–32). Name leer →
  „Kanal n“; Pult nicht erreichbar → Hinweis beim Start. Namen/Farben werden beim Start übernommen (`tracks[].color`),
  spätere Umbenennungen am Pult ändern laufende Aufnahmen nicht.
- Routing-Prüfung (`main.js`: `routingCheck`, `onMixerChange`): verglichen wird mit der Aufnahmeart der laufenden
  Aufnahme, sonst der eingestellten (`activeMode`). Ergebnis als `health.routing` (`ok`/`mismatch`/`unknown`, `null` ohne
  Pult), Warnung beim Wechsel zu `mismatch` und beim Mehrspur-Start, Warnbalken in der Oberfläche auch vor dem Start.
  Gilt auch im Stereo-Modus (Mehrspur-Routing vergessen zurückzustellen → Aufnahme hätte nur Kanal 1/2 roh).
- Pult-Simulator (`mixer/simulator.js`, Beispielnamen und -farben): läuft in der App nur bei Aufnahmeart Mehrspur mit
  „Simuliertes Pult“ und leerer IP (`configureMixer`); im Stereo-Modus nie, sonst meldete er ständig falsches Routing.
  Umschalten seines Routings über Knöpfe in *Einstellungen → Mehrspur & Pult → Zum Testen* (`mixer:simulateRouting`).
- Companion (Modul 2.1.0): Variablen `recording_mode`/`routing_status`, Rückmeldungen `routing_mismatch` (nur bei
  `mismatch`, nicht bei `unknown`, sonst stünde die Taste bei nicht erreichbarem Pult dauernd auf Rot) und
  `multitrack`, Aktion `mode_set` → WebSocket `mode.set` (`stereo`/`multitrack`/`toggle`, während der Aufnahme
  abgelehnt; `setRecordingMode` in `main.js` speichert, schickt `settings` an die Oberfläche – die zieht nur Schild
  und Ansicht nach, ein offener Einstellungsdialog behält seine Eingaben –, stellt Pult-Verbindung und Abhören um).
  Der Zustand für Netzwerk-Clients trägt dafür `recordingMode` (`netState()`: Art der laufenden, sonst der eingestellten
  Aufnahme). Preset „Aufnahmeart umschalten“, Rückmeldung zusätzlich im Preset „Eingang und Speicher“.
  Geprüft: Paketbau, Befehl gegen die echte App (umschalten, ablehnen, Oberfläche zieht mit); das Modul selbst in
  Companion noch nicht.

### Ergänzungen vom 2026-10-08 (aus der Ideenliste)
- **Taskleiste/Dock** (`updateTaskbar` in `main.js`, bei jedem `state` und jeder Gesundheitsänderung): Fenstertitel
  „● Aufnahme läuft – Ebbton“ bzw. „pausiert“/„Problem“ (Problem = Eingang `lost` oder Schreibfehler während der
  Aufnahme). Windows: farbiger Punkt über dem Taskleistensymbol (`setOverlayIcon`, Bild per `createFromBitmap`
  erzeugt, keine Datei; rot/orange/gelb), macOS: Dock-Abzeichen „●“/„❚❚“/„!“. Das `<title>` der Oberfläche wird über
  `page-title-updated` ignoriert, sonst überschriebe ein Neuladen den Titel. Geprüft auf dem Mac (Titel und
  `app.dock.getBadge()` per Node-Inspector); **das Overlay unter Windows ist noch nicht am Kirchen-PC gesehen.**
- **Mehrspur: Neustart nach Absturz** (`recoverMultitrack`): Stürzt der Mehrspur-Prozess während der Aufnahme ab, bleibt
  die Session `recording`/`paused`; der alte `TrackWriterProxy` wird aufgegeben (`abandon`: Dauer bleibt stehen, `close`
  beendet nichts), der Prozess neu gestartet und mit `append` an dieselben Spuren angehängt (`MultiWavWriter` gleicht
  auf die kürzeste Spur an), `Session.replaceWriter` setzt den neuen Stellvertreter ein (Wellenform wird aufgefüllt,
  Pause bleibt). Versuche nach 1, 2, 3, 3, 5 … 10 s (etwa 50 s), danach bzw. bei Absturzschleife (> 3 je Minute) wird die
  Aufnahme beendet. Meldung mit Stelle und Länge der Lücke; währenddessen `health.input = 'lost'`. Wer in der Zeit
  „Beenden“ drückt, beendet normal (der aufgegebene Stellvertreter hat nichts mehr zu schließen).
- **Lautheit beim MP3-Export** (`loudness.js`, `mp3.exportSegment` Option `loudness`): Einstellung `loudnessTarget`
  (Vorgabe −16 LUFS, 0 = aus; Auswahl in *Ablage & Export*). Zwei Durchgänge: Messung nach ITU-R BS.1770
  (K-Bewertung mit Koeffizienten wie libebur128 für jede Abtastrate, Gating −70/−10) und Spitzen je 64 Frames, dann
  Codieren mit fester Verstärkung (höchstens +20 dB, Stille wird nicht angehoben) und Begrenzer auf −1 dBFS (Sample-Peak):
  Verstärkung an den Blockgrenzen, linear dazwischen, vorausschauend ~6 dB je Block absenken, 20 dB/s zurück. Jede Datei
  für sich (nicht über alle Abschnitte gemeinsam). Kostet etwa 25 % mehr Exportzeit; die Messung gibt alle 5 s Audio
  den Hauptprozess frei. Geprüft: ffmpeg `ebur128` misst eine exportierte Datei mit −16,3 LUFS.
- **Lautheit in der Wellenform** (Schalter „LUFS“, Einstellung `loudnessMonitor`, Vorgabe an): Der Hauptprozess misst
  beim Stereo-Aufnehmen mit (`Session._measureLoudness` in `pushAudio`, `LoudnessMeter` aus `loudness.js`) und legt je
  100 ms einen Wert ab (`session.loudness`, LUFS mit 0,1 dB, `null` = Stille; in der Session-Datei als `loudness`).
  Alles Weitere rechnet `src/shared/loudness-curve.js` (UMD, Präfixsummen der Leistung): Momentary 4, Short-term 30
  Schritte, integriert mit Gating für beliebige Bereiche. Neue Werte gehen mit `levels.loudness.steps` an die Oberfläche
  (`state.loud`), komplett über `session:state` (`loudness`), nachgemessene über das Ereignis `loudness`. Fehlt die Kurve
  beim Laden (ältere/unterbrochene Aufnahme), misst `_computeLoudness` die WAV im Hintergrund nach (5-s-Stücke, Abbruch
  über `_loudJob`, wenn inzwischen etwas anderes geladen wird); 70 min dauerten etwa 6 s. Anhängen füllt die Kurve bis
  zur Dateilänge mit `null` auf. Mehrspur misst nicht (kein Mix; Schalter ausgeblendet).
  Zeichnen: `Waveform._drawLoudness` (Skala −50…−5 LUFS; Hilfslinien je nach Höhe der Wellenform alle 10 LU, alle
  20 LU oder keine; Ziel = `loudnessTarget` gestrichelt in der Farbe der Linie; `--loud` ist seit dem Umbau nach Phasen
  türkisblau statt gelb, damit sie nicht wie eine Warnung aussieht). Die Zahlen stehen rechts in einer Spalte mit Hintergrund
  (Linien enden davor), eine Zahl zu nah am Ziel entfällt. Herausgezoomt mittelt jeder Pixel über etwa 6 Pixel
  (mindestens 3 s), sonst zappelt die Linie bei Sprache.
  **Messwerte nicht in der Zeichenfläche:** Ein Kasten oben rechts und „Ziel −16“ links verdeckten je nach Größe viel
  (bei 760×520 ist die Wellenform nur ~40 px hoch). Jetzt meldet `_emitLoudness` die Werte (nur bei Änderung) über
  `onLoudness` an `#loud-readout` in der Werkzeugleiste: „LUFS · S · M · I · Abschnitt“, live M/S/I und laufender
  Abschnitt, sonst S an der Mausposition (echte 3 s, kann von der geglätteten Linie abweichen), I gesamt und gewählter
  Abschnitt (`wave.selectedSectionId` aus `state.selectedSectionId`, gesetzt in `renderLists`; vorher zählte nur der Klick
  in der Liste „Ablauf“).
  `renderLoudnessReadout` legt die Elemente einmal an und ändert danach nur Text/`hidden`: Live wechseln die Werte
  mehrmals je Sekunde, neu angelegte Elemente unter der Maus verhinderten jeden Tooltip. Erklärung als eigene Infobox
  `#loud-help` (CSS `:hover` + Geschwister, 0,35 s Verzögerung) statt `title` – der System-Tooltip erscheint auf dem Mac
  nur im aktiven Fenster und lässt sich nicht gliedern. `.loud-readout` bleibt auch ohne Inhalt stehen (Platzhalter vor
  dem Abspielknopf). Beim Abschnitt wird nur der Name mit „…“ gekürzt (höchstens 230 px), der Wert bleibt immer
  sichtbar; der ganze Name steht im Tooltip. Zu wenig Platz: Die hinteren Werte rutschen in eine abgeschnittene zweite Zeile (`flex-wrap`, feste Höhe),
  vorne bleibt S bzw. I. In flachen Wellenformen (`body.dense`, Fensterhöhe ≤ 820) sind die Schalter nur Symbole.
  Gemessen bei 1360×880, 1024×680, kompakt 960×640 und 760×520, beendet und live. Netzwerk bekommt `levels.loudness`
  ohne `steps`.
- **Werkzeugleiste der Wellenform (überarbeitet):** Die Kästchen „LUFS“, „Ansicht folgt“ (jetzt „Folgen“) und „Schleife“
  sind kleine Schalter (eckig wie alle Knöpfe) unten links in der Wellenform (`.wave-chips` in `.wave-wrap`, Kästchen unsichtbar im Label,
  Zustand per `:has(input:checked)`, Farben: LUFS `--loud`, Folgen `--plan`, Schleife `--manual`). Unten links, weil
  rechts Live-Stelle, Skala und Messwerte stehen. Abspielen ist ein Symbolknopf mit denselben Ecken wie alle Knöpfe (`setPlayButton`, `data-icon`
  play/pause/stop/listen, Bedeutung in Tooltip und `aria-label`; nur Mehrspur hat zusätzlich Text „Zum Pult“/„Stopp“),
  Zoom eine Lupen-Gruppe. Die IDs (`chk-*`, `btn-play`, `btn-zoom-*`) sind geblieben. In flachen Wellenformen (Lane unter
  110 px, z. B. kompakt 760×520) zeichnet die Lautheit nur jede zweite Skalenlinie und so viele Messwert-Zeilen, wie passen.
  Gemessen: kein Überlauf bei 1360, 1024 und kompakt 760 px.
- **Voreinstellung der Wellenform-Schalter** (*Einstellungen → Programm → Wellenform*): `loudnessMonitor` (LUFS) und
  `followLive` (Folgen). Der Schalter in der Wellenform ändert die Einstellung nicht mehr (vorher speicherte „LUFS“ bei
  jedem Klick): LUFS steht in `state.loudOn` bis zum Programmstart, Folgen wird bei jedem Aufnahmestart/-anhängen und beim
  Programmstart auf `followLive` gesetzt (`setFollow`). Eine beim Speichern geänderte Voreinstellung gilt sofort.
- **Ziehen verschiebt die Ansicht** (Wellenform und Zeitleiste, `_panning` in `waveform.js`): Die Hörmarke setzt jetzt erst
  das Loslassen, und nur wenn sich die Maus weniger als `PAN_THRESHOLD` (4 px) bewegt hat; vorher setzte `pointerdown`
  sofort die Marke. Fähnchen/Schnittränder (verschieben) und Umschalt+Ziehen (Schnitt) haben Vorrang. Zeiger „grab“,
  sobald es etwas zu verschieben gibt, beim Ziehen „grabbing“.
- **Statusseite für Handy/Tablet** (`src/status/`, ausgeliefert von `netserver.js` unter `/`, `/status.js`,
  `/status.css`; nur diese festen Namen, eigene CSP): meldet sich per WebSocket an (als Webseite immer Rolle `monitor`,
  also ohne Personennamen), Passwort im `localStorage` des Geräts. Zeigt Zustand, laufenden Timer (zwischen den
  Meldungen lokal weitergezählt), Pegel, Warnungen aus `health`, aktuellen und nächsten Punkt, Abschnittsliste.
  Adresse(n) stehen in *Einstellungen → Netzwerk* (`statusUrls` aus `net.statusInfo()`, IPv4 im LAN). Läuft nur, wenn die
  Netzwerkschnittstelle läuft (also mit Passwort). Steuern lässt sich dort bewusst nichts.
- **Archiv** („Aufnahmen“, `openLibrary`/`renderLibrary`): Liste nach Monat, Suche über Name, Datum, Interpreten und
  Abschnittsnamen, Filter (nicht vollständig gesichert, Stereo, Mehrspur, unterbrochen), Sicherungsstand je Aufnahme
  (`exportSummary` in `main.js` aus `exports` der Session-Datei: ✓ gesichert / n von m / ⚠ geändert seit Export / nicht
  gesichert; Mehrspur ohne Angabe), „📂“ zeigt die Session-Datei im Ordner. Aufnahmen ohne Gottesdienstnamen heißen
  „Ohne Gottesdienst“ (vorher stand der Dateiname da).

### Oberfläche nach Phasen (Umbau 2026-10-08)
Anlass: Designvorschläge (Artifact „Ebbton Designvorschläge“). Die Oberfläche beantwortet in jedem Moment „Was ist jetzt
dran?“; je Phase genau eine Hauptaktion, der Aufbau bleibt gleich, nur die Betonung wechselt.
- **Phasen:** `phaseOf(session)` → `body[data-phase]` = `prep` (vor dem Start, auch `stopped` ohne Audio), `rec`
  (Aufnahme/Pause), `save` (beendet mit Audio; `body.review` bleibt als Alias für das Mini-Fenster). Kopfzeile in der Mitte
  `#phase-steps` (Vorbereiten › Aufnehmen › Sichern, nur Anzeige; unter 1240 px nur die aktuelle). Unter dem Timer
  `#status-line` (`renderStatusLine`: Bereit · Pegel live / Aufnahme läuft / Pausiert / Beendet · n ungesichert).
- **Ausblenden statt ausgrauen:** Welche Transportknöpfe sichtbar sind, regelt nur CSS über `data-phase`: prep =
  `#btn-record` (rot, `.go`, „Aufnahme starten“ mit Taste) · rec = `#btn-next-item` (Hauptknopf, zweizeilig: klein
  „Nächster Punkt · N“, darunter groß nur der Name – so hat der Name fast die ganze Knopfbreite; vorher stand „→ Pre…“
  da), `#btn-marker` schmal und zweizeilig („Abschnitt / beenden“, `#marker-label` = „starten“/„beenden“),
  `.rec-ctl` mit `#btn-pause`/`#btn-stop` als Symbole. Ist kein Punkt mehr offen (`body[data-next="none"]`), täte N
  dasselbe wie M: N verschwindet, M wird zum breiten Hauptknopf; die Taste N beendet weiter den laufenden Abschnitt
  (`nextItem`) · save = `#btn-export` (Hauptknopf) und `#btn-record` leise als
  „Neue Aufnahme“ (`order: 2`); bei Mehrspur (kein Export) „Neue Aufnahme starten“ und `#btn-continue`. Stereo hat
  „An Aufnahme anhängen“ als `#now-continue` unter „Sichern“. Vor dem Start entfallen Werkzeugleiste und Übersicht,
  die Wellenform ist flacher (110 px, kompakt 80 px) – bewusst: Eine gleich hohe Wellenform mit Hinweis wurde
  ausprobiert und gefiel schlechter (2026-10-09). Der Wechsel ist dafür weich (0,32 s): Werkzeugleiste und Übersicht
  klappen über `max-height`/`height` auf statt `display: none`, die Wellenform wächst per `transition: height` und
  zeichnet sich über ihren `ResizeObserver` bei jedem Schritt neu; nicht im Mini-Fenster, nicht bei
  `prefers-reduced-motion`. Die Regeln für „prep“ tragen `.wave-section` im Selektor, sonst gewinnen die späteren
  `body.dense …`-Regeln (gleiche Spezifität). M/N/X und Pause/Beenden sind aus der Werkzeugleiste bzw. ihren
  alten Plätzen in den Transport gewandert; `#btn-cut` („✂ Schnitt“, nur rec) steht links über der Wellenform.
- **Knopf-Rollen:** `.primary` (Indigo, Hauptaktion), `.go` (rot gefüllt, nur „Aufnahme starten“), normal (grau),
  `.ghost` (leise), `.danger` (rote Schrift, kein roter Grund). Kürzel als `kbd.k` im Knopf. Knöpfe geben beim Drücken
  1 px nach; M/N leuchten nach dem Setzen kurz in der Abschnittsfarbe (`flashButton`, `--flash`). Die Klasse `flash`
  wird nach `animationend` entfernt, sonst leuchtet ein Knopf erneut, sobald er nach dem Ausblenden wieder erscheint.
- **Beenden halten:** `bindHold` – Maus/Touch oder Enter/Leertaste 600 ms halten (Balken `.hold-bar`), zu kurz → Hinweis.
  Beim Loslassen zählt die tatsächlich gehaltene Zeit (`performance.now()`), weil Chromium Timer im Hintergrundfenster
  drosselt – im Test kam der 600-ms-Timer erst nach dem Loslassen. `Strg`/`Cmd`+R und Companion beenden sofort.
- Das Eingabefeld unter der Liste „Ablauf“ hat bewusst keinen Platzhaltertext (Wunsch des Nutzers).
- **Liste „Ablauf“** (`#flow-list`, `renderFlow`/`flowRow`/`fullRow`) ersetzt Ablaufplan, Abschnitte und Export:
  gesetzte Abschnitte nach Zeit (`data-state` done/now), dahinter offene Punkte nach `order` (open, der erste während
  der Aufnahme „als Nächstes“), nach dem Beenden „Gesamte Aufnahme“ (full). Spalten fest per Variablen (`--tw` Zeitraum,
  `--dw` Länge, `--stw` Zustand), damit die Zeilen fluchten; vor dem Start 0. Die Liste richtet sich per
  Container-Abfrage nach der eigenen Breite (unter 640 px ohne Zeitraum, unter 460 px ohne Zustand); diese Regeln
  stehen am Ende von `styles.css` mit `body …`, sonst überstimmen sie die Fenstergrößen-Regeln. **Spalten nie mit
  `display: none` ausblenden** (dann rutschen die übrigen eine Spalte nach links und die Namen verschwinden), sondern
  `visibility: hidden` plus Breite 0. ✎/× nur beim Darüberfahren/Fokus; nie begonnene Punkte nach dem Beenden blass.
- **„Jetzt“** (`#panel-now`, `renderNow`): prep = Prüfliste `#prep-checks` (Eingang, Gottesdienst, Ablauf, Punkte ohne
  Interpret mit „Eintragen“, Speicher, Routing; `fillChecks` baut nur bei Änderung neu, sonst gingen Hover/Tooltips
  verloren) und „Beim Start beginnt automatisch …“; rec = Karte `#now-card` (laufender Abschnitt, Laufzeit, Klick =
  bearbeiten) und `#now-next` – bewusst ohne Prüfliste (Eingang/Speichern/Speicherplatz mit lauter ✓ wirkte sinnlos,
  Probleme melden Warnbalken und Meldungen); save = Zusammenfassung, Zielordner (nur Name, Pfad im Tooltip,
  `refreshExportTarget`), Format/Lautheit, Fortschritt, Ergebnis. Beim Phasenwechsel blendet der Bereich kurz ein
  (`fadeNowPanel`). Bei Mehrspur steht rechts „Kanäle“ statt „Jetzt“ (dann nennt `#status-line` den laufenden Abschnitt).
- **Pegel:** Skala −48 … 0 dBFS, Zonen Grün bis −9 / Gelb bis −3 / Rot (`.bar` mit `--zones`, Füllung über `clip-path`),
  Spitzenhalter 2 s (`<u>`), Zahl `#db-l/-r`, „Übersteuert“ (`#clip`) bleibt bis zum Klick (`state.clipLatched`).
  `setMeters` für Session-Pegel, Mehrspur-Kanäle und Vorhören; ohne neue Werte fällt die Anzeige nach 0,6 s auf null.
- **Pegel vor dem Start** (`prelisten`, Einstellung `prelisten`, Vorgabe an, *Audio*): eigene `Capture`-Instanz `pre`,
  getrennt von der Aufnahme-Erfassung, schickt nichts an den Hauptprozess. Nur Stereo und Phase prep;
  `startRecording`/`continueRecording` schließen sie vorher (`stopPrelisten` wartet auch einen gerade laufenden Start
  ab – zwei gleichzeitige `capture.start` wären undefiniert). Fehlschlag wird nicht in einer Schleife wiederholt.
- **Farben:** Jede Signalfarbe hat eine Bedeutung: Rot live/Fehler, Bernstein Achtung/Pause, **Grün `--ok` erledigt**
  (neu: gesichert, Eingang ok, Pegel normal), Indigo `--plan` handeln, Stahlblau Audio. Abschnittsfarben als feste
  Palette `--sec-0…7` je Farbschema (vorher `hsl(HUES[i], 55%, 62%)`); Zeilen bekommen `--sec: var(--sec-n)`
  (`window.sectionColorVar`), die Wellenform liest die Werte über `readColors().sections`. In der Wellenform nur ein
  4-px-Streifen unter den Fähnchen statt Flächentönung (gewählter Abschnitt leicht hinterlegt), neu gesetzte Marken
  blenden während der Aufnahme 350 ms ein (`_flash`).
- **Übersichtsleiste** `#overview` (Klasse `Overview` in `waveform.js`, gezeichnet in `Waveform.draw`): ganze Aufnahme
  mit Umriss, Abschnitten, Schnitten, Live-Stelle, Hörmarke und dem sichtbaren Ausschnitt als Rahmen; Klick springt,
  Ziehen verschiebt (schaltet „Folgen“ aus). Der Umriss wird nur bei neuen Daten neu gerechnet.
- Datum in der Kopfzeile menschlich („Do., 8. Okt. 2026“, `serviceDateText`; in Dateinamen bleibt ISO).
- **Kopfleiste (ruhiger):** Rechts waren sechs gleich laute, umrandete Knöpfe. Jetzt: „Aufnahmen“ mit Symbol (`.top-text`),
  Einstellungen als Zahnrad (`#btn-settings.icon-btn`), dann Größe „A A“ (behält als Segment den Rahmen), Mini und
  Hell/Dunkel – Symbole ohne Rahmen, erst beim Darüberfahren hinterlegt. **Hell/Dunkel bleibt bewusst in der Kopfleiste**
  (Wunsch des Nutzers). Kopfleiste flacher (10 px statt 14 px Innenabstand). Ohne Gottesdienst heißt das Feld
  „Gottesdienst wählen …“ und ist gestrichelt in Akzentfarbe (`.service-name.unset`).
- **Einstellungen (überarbeitet):** Zwischenüberschriften statt Kästen im Kasten, Feldnamen 15 px, Hinweise 13 px
  (vorher 13/11 px, deutlich kleiner als die Hauptansicht). Knöpfe in passender Breite (`justify-self: start`), keine über
  die volle Breite gezogenen mehr.
  - **Speichern:** Änderungen werden erkannt (`settingsValues` vergleicht je Reiter mit `takeSettingsSnapshot` beim
    Öffnen und nach dem Speichern; Kalender über `readCalendarSelection`, Vorlagen über den ganzen Entwurf). Geänderte
    Reiter tragen einen gelben Punkt, unten steht „Ungespeichert: …“, der Knopf heißt „Änderungen speichern“ (sonst
    gesperrt). Schließen mit ×, Esc, Hintergrund oder „Schließen“ fragt bei Änderungen „Änderungen verwerfen?“
    (`requestCloseSettings`). Sofort speichern bei jeder Änderung wurde bewusst nicht gewählt (Netzwerk-Neustart, Pfade).
  - **Audio:** oben die Aufnahmeart als Umschalter (`#rec-mode-seg` schreibt in das versteckte `#set-rec-mode`, damit
    der übrige Code unverändert bleibt; `syncRecModeSeg`), darunter Ein-/Ausgang. Mehrspur-Gerät, Pult, Routing und
    Kanäle stehen unter **„Mehrspur & Pult“** (`data-tab="mischpult"`). „Simuliertes Pult“ und die Simulator-Knöpfe
    stecken in einem zugeklappten Bereich „Zum Testen ohne Mischpult“ (offen, wenn der Simulator an ist). „Als … merken“
    nur bei verbundenem Pult, „Gemerktes vergessen“ nur, wenn etwas gemerkt ist. Die Simulator-Knöpfe waren trotz
    `hidden` sichtbar (`.row` mit `display: flex`) – jetzt `.row[hidden] { display: none }`.
  - **Ordner:** versteckte Felder (`#set-dir`, `#set-export-dir`, `#set-mt-dir`) plus Anzeige Name groß/Pfad klein
    (`renderPathViews`), Knöpfe „Ändern …“ und „Zurücksetzen“. Klasse `.is-empty` (nicht `.empty` – die globale Klasse
    zentriert Text).
  - **Dateiname:** Platzhalter als Chips (fügen an der Schreibmarke ein), darunter „Beispiel: …“ – gerechnet im
    Hauptprozess mit `buildFileName(label, artist, pattern)` über IPC `export:previewName`, also genau wie beim Export.
  - **Netzwerk/Pult:** Zustand oben als Schild (`.status-pill`, `data-level` ok/warn), statt „aktiv“ angehakt und darunter
    „bleibt aus“. Passwortfelder und Token haben ein Auge zum Anzeigen (bleiben standardmäßig verdeckt).
  - **ChurchTools:** Kalender laden beim ersten Öffnen des Reiters von selbst (`state.calendarsLoaded`), „Verbindung
    prüfen“ mit Ergebnis daneben.
  - **Vorlagen:** Punkte am Griff ziehen (Ziehen nur am Griff, damit Text markierbar bleibt) oder Alt + ↑/↓; „Löschen“ in
    roter Schrift; Standard als Schild bzw. Knopf „Als Standard festlegen“ (`#tpl-make-default`, vorher ein ausgegrautes
    Häkchen).
- Gemessen (echte App per DevTools-Protokoll, Zustände auch per `data-phase` nachgestellt): kein Überlauf, Timer fest bei
  1360×880, 1024×680, kompakt 960×640 und 760×520, Stereo und Mehrspur; Mini 360×168 und 320×164 in allen vier
  Zuständen; hell und dunkel. Echte Abläufe: Start, N, Beenden halten (kurz → Hinweis), Entfernen + Rückgängig.

### Entfernt: Mitschrift
Die lokale Transkription (whisper.cpp, Mitschrift-Panel, Einstellungen) wurde
bewusst wieder ausgebaut, weil sie keinen Mehrwert brachte. Nicht neu einbauen,
ohne vorher nachzufragen. Alte Sessions mit `transcript` im JSON werden ohne
Fehler geladen; das Feld wird ignoriert und beim Speichern nicht mehr geschrieben.
