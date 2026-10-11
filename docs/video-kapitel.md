# Video-Kapitel aus Ebbton-Abschnitten – Auftrag für den Server

Diese Beschreibung richtet sich an die Claude-Instanz auf dem Debian-Server. Sie enthält alles, was mit dem
Nutzer bereits abgestimmt ist, das Datenformat von Ebbton und einen Vorschlag zur Umsetzung. Was unter
„Offene Punkte“ steht, bitte vor dem Bauen mit dem Nutzer klären.

## Ziel

Im Gottesdienst laufen zwei Aufnahmen parallel:

- **Ebbton** (Electron-App, dieses Repo) nimmt den Ton als WAV auf. Während der Aufnahme setzt man dort
  Abschnitte wie „Einleitung“, „Kinderbeitrag“ oder „Predigt: Kolosser 2,6-7 …“, jeweils mit Anfang, Ende und
  Interpret.
- **OBS** nimmt auf einem anderen PC das Video als MP4 auf.

Ein Dienst auf dem Server soll die Ebbton-Abschnitte als **Kapitel in die MP4-Dateien auf der NAS**
schreiben. Die Zeitbasis beider Aufnahmen ist verschieden. Deshalb wird der Versatz **über den Ton**
bestimmt: Beide PCs bekommen dasselbe Signal vom Mischpult.

## Umgebung

| Teil | Beschreibung |
|---|---|
| Ebbton-PC | Windows, Kirche. Speichert WAV, MP3 und `.session.json` in einen Aufnahmeordner. Dieser Ordner wird **beim Herunterfahren des PCs vollständig auf die NAS kopiert**. |
| OBS-PC | Anderer Rechner. Speichert MP4-Dateien auf der NAS. Bekommt dasselbe Tonsignal wie Ebbton. |
| NAS | Ablage für beide. Pfade und Freigaben: siehe „Offene Punkte“. |
| Server | Debian mit Docker-Containern. Hier läuft der neue Dienst. |
| Status-Dashboard | Vorhanden, die Server-Instanz kennt es. Der Dienst meldet dorthin seinen Stand. |

## Festgelegte Entscheidungen

Diese Punkte sind mit dem Nutzer abgestimmt und nicht mehr offen:

1. **Das Original-MP4 wird ersetzt**, es entsteht keine Kopie daneben. Das **Änderungsdatum der Datei bleibt
   erhalten** (mtime und atime vom Original übernehmen).
2. **Dateinamen werden nicht angefasst.** Kein Umbenennen, Verschieben oder Einsortieren.
3. **Bei Unsicherheit wird nichts getan.** Ist der Ton-Abgleich nicht eindeutig, bleibt das Video unverändert
   und der Dienst meldet es auf dem Dashboard. Es gibt keine Näherung über die Uhrzeit.
4. **Läuft nachts automatisch oder auf Knopfdruck**, nicht laufend beim Eintreffen neuer Dateien.
5. **Status und Fehler erscheinen auf dem vorhandenen Status-Dashboard.**
6. Normalerweise gibt es **eine einzige durchgehende Video-Aufnahme** je Gottesdienst. Fälle mit mehreren
   Dateien müssen nicht automatisch gelöst werden. Es reicht, sie als „unsicher“ zu melden.
7. Auf der NAS ist genug Platz, um ein Video kurzzeitig doppelt abzulegen (temporäre Datei vor dem Ersetzen).
8. Der Ebbton-Ordner wird **nur gelesen**. Ebbton selbst muss für diesen Dienst nicht geändert werden.

## Offene Punkte (mit dem Nutzer klären)

- Pfade bzw. Freigaben auf der NAS: Ebbton-Ordner, OBS-Ordner, wie sie im Container eingebunden werden
  (SMB/NFS) und welche Benutzer- und Gruppen-ID beim Schreiben verwendet wird.
- Ordnerstruktur der Videos: flach, oder Unterordner je Datum/Gottesdienst?
- Anbindung an das Dashboard: Format und Weg (Push, Abfrage, Datei …).
- Wie sieht der „Knopf“ aus? Zum Beispiel ein Knopf im Dashboard, der einen HTTP-Endpunkt des Dienstes aufruft.
  Uhrzeit für den nächtlichen Lauf.
- OBS-Einstellungen: Format (normales MP4, fragmentiertes oder Hybrid-MP4), Dateinamensmuster, Zeitzone des
  OBS-PCs, Anzahl der Tonspuren und welche davon das Mischpultsignal enthält.
- Sollen YouTube-Zeitmarken (Textdatei neben dem Video oder nur auf dem Dashboard) mit ausgegeben werden?
  Das wäre eine zusätzliche Datei. Der Nutzer will Dateinamen nicht anfassen, eine Zusatzdatei ist also nicht
  ohne Nachfrage erlaubt.
- Wie mit einer Lücke vor dem ersten Abschnitt umgehen (siehe „Kapitel bilden“).
- Nutzt jemand die Videos in Jellyfin, Plex o. ä.? Das ist wichtig für den Namen der temporären Datei (siehe
  „Schreiben“).

## Eingangsdaten: Ebbton

### Dateien im Aufnahmeordner (Stereo, heutiger Stand)

Je Aufnahme liegen im Aufnahmeordner nebeneinander:

```
2026-10-05_1002_Gottesdienst.wav            Masteraufnahme
2026-10-05_1002_Gottesdienst.session.json   Abschnitte und Metadaten (maßgeblich)
<Exportordner>/…/*.mp3                       MP3-Exporte (für diesen Dienst egal)
```

- Muster für den Namen: `<YYYY-MM-DD>_<HHMM>_<Gottesdienstname>`. Die Uhrzeit ist die Ortszeit des
  Ebbton-PCs beim Start. Bei Namensgleichheit kommt `_2`, `_3` dazu.
- Zusammengehörig sind gleicher Basisname + `.wav` und `.session.json`. **Das Feld `wavPath` in der
  Session-Datei nicht verwenden**: Es enthält den lokalen Windows-Pfad des Kirchen-PCs.
- Am selben Tag können mehrere Sessions liegen, auch kurze Testaufnahmen von wenigen Sekunden. Die Zuordnung
  zum Video entscheidet der Ton-Abgleich, nicht der Name.

### Session-Datei (`*.session.json`, `version: 2`)

Beispiel, gekürzt:

```json
{
  "version": 2,
  "app": "ebbton",
  "service": { "id": 7014, "name": "Gottesdienst", "date": "2026-10-05",
               "info": "Kolosser 2,6-7 \"Verwurzelt in Christus\"", "suggestions": [] },
  "agendaOrigin": { "source": "churchtools", "template": null },
  "status": "stopped",
  "finalized": true,
  "startedAt": "2026-10-05T08:02:13.157Z",
  "sampleRate": 48000,
  "channels": 2,
  "duration": 5421.37,
  "wavPath": "C:\\Users\\…\\2026-10-05_1002_Gottesdienst.wav",
  "sections": [
    { "id": "sec_…_3", "label": "Einleitung", "artist": "Max Muster", "category": null,
      "start": 0, "end": 612.4, "source": "churchtools", "order": 0, "color": 0 },
    { "id": "sec_…_8", "label": "Predigt: Kolosser 2,6-7 \"Verwurzelt in Christus\"",
      "baseLabel": "Predigt", "artist": "Thomas Beck",
      "start": 1830.0, "end": 4012.7, "source": "churchtools", "order": 2, "color": 2 },
    { "id": "sec_…_9", "label": "Abschluss", "start": null, "end": null, "source": "plan" }
  ],
  "cuts": [ { "id": "cut_…", "start": 100.0, "end": 130.0 } ],
  "exports": {},
  "peaks": [ … ]
}
```

Relevante Felder:

| Feld | Bedeutung |
|---|---|
| `status`, `finalized` | Nur `status == "stopped"` und `finalized == true` verarbeiten. Bei `recording`/`paused` ist die Aufnahme abgebrochen oder die Kopie unvollständig: als „wartet“ bzw. Warnung melden, nicht verarbeiten. |
| `startedAt` | Start der **ersten** Aufnahme, ISO-8601 in **UTC**, Uhr des Ebbton-PCs. Nur für die grobe Vorauswahl verwenden (siehe Abgleich). |
| `duration` | Länge der WAV in Sekunden. Im Zweifel die Länge aus der WAV selbst nehmen. |
| `sections[]` | Abschnitte. Zeiten `start`/`end` in **Sekunden ab Anfang der WAV-Datei**. |
| `sections[].start == null` | Nicht gesetzter Ablaufpunkt: **ignorieren**. |
| `sections[].end == null` | Nur bei abgebrochener Aufnahme möglich: Ende = Ende der WAV. |
| `sections[].label` | Kapitelname. Kann Anführungszeichen, Umlaute, Doppelpunkte enthalten. |
| `sections[].artist` | Interpret (optional, kann fehlen oder leer sein). |
| `sections[].source` | `churchtools`, `plan` oder `manual`. Für die Kapitel ohne Bedeutung, alle gesetzten Abschnitte zählen. |
| `cuts[]` | Schnitte für den MP3-Export. **Für die Kapitel ignorieren**: Das Video wird nicht geschnitten. |
| `gaps[]` | Optional, ältere Dateien haben es nicht. Aussetzer des Audioeingangs, die Ebbton mit Stille gefüllt hat (`at` Stelle, `seconds` Länge). **Für die Kapitel ignorieren:** Die WAV enthält die Lücke als Stille, die Abschnittszeiten passen deshalb weiter zur Uhr und zum Video. |
| `service.name`, `service.date` | Name und Datum des Gottesdienstes (Ortsdatum), gut für die Anzeige auf dem Dashboard. |

Regeln, die für die Abschnitte gelten:

- **Abschnitte überlappen nie.** Zwischen Abschnitten kann es Lücken geben (Pause zwischen zwei Punkten).
- Die Reihenfolge in `sections[]` ist **nicht** die zeitliche: nach `start` sortieren.
- Alte Dateien mit `markers` statt `sections` (Version 1) stammen nur aus der Entwicklungszeit: überspringen
  und melden.

### Wichtig für den Zeitabgleich: Pausen und Anhängen

- **Pause in Ebbton:** Während einer Pause wird **nichts** in die WAV geschrieben. Die WAV-Zeit bleibt stehen,
  das Video läuft weiter. Ab dieser Stelle ist der Versatz zwischen Video und WAV größer. Die Session-Datei
  speichert **nicht**, wann pausiert wurde.
- **„An Aufnahme anhängen“:** Nach dem Beenden kann man an dieselbe WAV weiter anhängen. Das wirkt für den
  Abgleich genauso wie eine Pause (Sprung im Versatz).
- Der Versatz `t_video - t_wav` kann deshalb **nur wachsen**, und zwar in Sprüngen. Ein abnehmender Versatz
  bedeutet einen Fehler im Abgleich.
- Daneben driften beide Aufnahmegeräte leicht auseinander, typisch weniger als 0,3 s in zwei Stunden. Für
  Kapitel ist das unerheblich, die Prüfung muss es aber zulassen.

### WAV-Format

- 16 Bit PCM, meist 48 kHz, Stereo.
- Neuere Dateien haben einen 80-Byte-Kopf mit `JUNK`-Block, ab 4 GB das Format **RF64** (`ds64`).
- Nach dem Beenden schreibt Ebbton **hinter** den `data`-Block noch `cue `- und `LIST/adtl`-Blöcke (Abschnitte
  als Marker). Die WAV deshalb mit ffmpeg dekodieren, nicht selbst parsen und nicht die Dateigröße als
  Audiolänge nehmen. Die Marker in der WAV nicht verwenden, maßgeblich ist die Session-Datei.

### Mehrspuraufnahmen (seit 2026-10-08 in `main`, selten genutzt)

Ebbton hat einen Mehrspur-Modus (32 Kanäle vom Pult). Er **ersetzt** die Stereoaufnahme, es gibt dann also
keine Stereo-WAV. Normalfall bleibt Stereo. Das Format:

- Je Aufnahme ein **Ordner** `<YYYY-MM-DD>_<HHMM>_<Name>/` mit der Session-Datei
  `<YYYY-MM-DD>_<HHMM>_<Name>.session.json` und je Kanal einer Mono-WAV, z. B. `01_Predigt.wav`,
  `02_Moderation.wav`. Diese Ordner liegen standardmäßig in einem Unterordner `Mehrspur/` des Aufnahmeordners;
  in den Ebbton-Einstellungen („Ordner für Mehrspuraufnahmen“) kann aber auch ein anderer Ordner gewählt sein –
  dann liegt er womöglich nicht im Aufnahmeordner und wird nicht mit auf die NAS kopiert.
- In der Session: `"mode": "multitrack"`, `"wavPath": null`,
  `"tracks": [{ "channel": 0, "name": "Predigt", "color": 1, "file": "01_Predigt.wav" }, …]`. Abschnitte und
  Zeiten funktionieren wie bei Stereo. Fehlt `mode`, ist es `stereo`.
- Für den Abgleich gibt es kein Summensignal. Eine Mischung der Sprechkanäle bilden (z. B. die Spuren, deren
  Name „Predigt“, „Moderation“ oder „Headset“ enthält), oder alle Spuren aufsummieren. Bei 24 Bit nach 8 kHz
  Mono dekodieren, die Bittiefe macht dann keinen Unterschied.

Nicht vorab bauen, aber so anlegen, dass „Referenzton einer Session laden“ eine austauschbare Funktion ist.

## Eingangsdaten: OBS

- MP4 auf der NAS, eine durchgehende Datei je Gottesdienst.
- Startzeit: aus dem Dateinamen (OBS-Standard `%CCYY-%MM-%DD %hh-%mm-%ss`, **Ortszeit des OBS-PCs**) oder
  aus `format.tags.creation_time` (ffprobe). Beides nur für die grobe Vorauswahl verwenden.
- Welche Tonspur das Pultsignal enthält, ist zu klären (siehe „Offene Punkte“).
- OBS schreibt eine Datei, solange die Aufnahme läuft. Bei normalem MP4 ist die Datei bis zum Ende ohne
  `moov` und nicht lesbar. Nur Dateien anfassen, deren Größe und mtime sich eine Weile (z. B. 30 min) nicht
  geändert haben und die ffprobe fehlerfrei öffnet.

## Verarbeitung

### 1. Bestand erfassen

- Alle Videos im OBS-Ordner, alle Sessions im Ebbton-Ordner.
- Eine Session ist bereit, wenn `status == stopped`, `finalized == true`, die WAV (bei Mehrspur: die Spuren aus
  `tracks[].file` neben der Session-Datei) vorhanden ist und
  Session-Datei und WAV seit mindestens 10 min unverändert sind. Die Kopie beim Herunterfahren kann mitten
  im Lauf sein.
- Bereits bearbeitete Videos erkennen (siehe „Merken“).

### 2. Grobe Zuordnung

- Zeitraum der Session: `startedAt` bis `startedAt + duration`, plus großzügige Reserve für Pausen.
- Zeitraum des Videos: Start bis Start + Länge.
- Kandidaten sind Paare, deren Zeiträume sich mit **±30 min Toleranz** überschneiden. Die Uhren beider PCs
  können abweichen. Sehr kurze Sessions (z. B. < 2 min oder ohne gesetzte Abschnitte) nicht als Kandidaten
  verwenden.
- Mehrere Kandidaten sind kein Fehler, der Ton-Abgleich entscheidet. Bleibt danach mehr als eine gute
  Zuordnung übrig: **unsicher, nichts tun**.

### 3. Ton-Abgleich

Vorschlag zum Vorgehen, Details beim Bauen festlegen:

1. Beide Töne mit ffmpeg dekodieren: Mono, 8 kHz, float (`-ac 1 -ar 8000 -f f32le`). Bei zwei Stunden sind
   das etwa 58 Mio. Werte, also gut im Speicher.
   - Lautstärke und Klang können sich unterscheiden (OBS-Pegel, Kompressor, Hall vom Raummikrofon). Vor dem
     Vergleich normalisieren, z. B. einen Hochpass ab ca. 100 Hz anwenden und dann jedes Fenster auf Varianz 1
     bringen. Statt des Rohsignals kann auch die Hüllkurve verwendet werden.
2. **Ankerpunkte** in der WAV festlegen: alle Abschnittsgrenzen sowie zusätzlich ein Raster etwa alle 2 min.
   Für jeden Anker ein Fenster von ca. 20 s nehmen. Ist das Fenster still, auf die nächste Stelle mit Signal
   ausweichen.
3. Jedes Fenster im Video suchen, per normierter Kreuzkorrelation über FFT (`scipy.signal.correlate` mit
   `method="fft"`):
   - Zuerst **global** über das ganze Video für einige Anker, um den groben Versatz zu bestimmen.
   - Danach **lokal** für alle Anker im Bereich ±60 s um den erwarteten Versatz. Wegen der Pausen den Bereich
     nach oben offen lassen: Der nächste Anker darf auch deutlich später kommen. In dem Fall erneut global
     suchen.
4. **Gütemaße je Anker:**
   - Höhe des normierten Maximums (Startwert etwa ≥ 0,5),
   - Abstand zum zweithöchsten Maximum außerhalb von ±1 s (z. B. Verhältnis ≥ 1,5).

   Die Schwellwerte mit echten Aufnahmen bestimmen und anpassen.
5. **Prüfung der Folge:** Der Versatz muss zwischen Ankern konstant bleiben (±0,3 s, Drift) oder nach oben
   springen (Pause). Ein Sprung nach unten oder einzelne Ausreißer bedeuten: Anker verwerfen. Danach muss
   **jede Abschnittsgrenze** durch einen sicheren Anker in ihrer Nähe abgedeckt sein (zwischen zwei
   übereinstimmenden Ankern ohne Sprung).
6. Ist irgendeine Abschnittsgrenze nicht sicher zuzuordnen: **unsicher, nichts schreiben**, mit Begründung
   auf dem Dashboard (welcher Abschnitt, welcher Wert).

Ein Sprung durch eine Pause liegt zwischen zwei Ankern. Fällt er genau zwischen Anker und Abschnittsgrenze,
wäre die Grenze falsch zugeordnet. Deshalb steht an jeder Abschnittsgrenze selbst ein Anker (Fenster direkt
nach dem Anfang bzw. direkt vor dem Ende des Abschnitts).

### 4. Kapitel bilden

- Jeder gesetzte Abschnitt wird ein Kapitel. Zeiten: `t_video = t_wav + Versatz an dieser Stelle`.
- **Titel:** `label`, bei Interpret `label – artist`, z. B.
  „Predigt: Kolosser 2,6-7 "Verwurzelt in Christus" – Thomas Beck“. Format mit dem Nutzer abstimmen, falls
  er etwas anderes möchte.
- MP4-Kapitel liegen lückenlos hintereinander. Vorschlag:
  - Lücken zwischen zwei Abschnitten dem vorherigen Kapitel zuschlagen. Das Kapitel endet also beim Beginn
    des nächsten.
  - Vor dem ersten Abschnitt (Video läuft schon, Gottesdienst noch nicht): ein Kapitel „Beginn“ ab 0, wenn
    die Lücke länger als ein paar Sekunden ist. **Mit dem Nutzer klären.**
  - Das letzte Kapitel endet am Videoende.
- Abschnitte, die vor dem Videoanfang oder nach dem Videoende liegen, werden abgeschnitten bzw. entfallen.
  Das kommt vor, wenn OBS später gestartet oder früher beendet wurde. Auf dem Dashboard vermerken.

### 5. Schreiben

1. Freien Platz prüfen: mindestens die Videogröße plus Reserve.
2. Metadatendatei im FFMETADATA-Format erzeugen (Sonderzeichen `=`, `;`, `#`, `\` und Zeilenumbruch mit `\`
   maskieren):

   ```
   ;FFMETADATA1
   [CHAPTER]
   TIMEBASE=1/1000
   START=0
   END=612400
   title=Einleitung – Max Muster
   [CHAPTER]
   …
   ```

3. Ohne Neukodierung in eine temporäre Datei **im selben Ordner** schreiben, damit das spätere Umbenennen
   atomar ist:

   ```
   ffmpeg -nostdin -i video.mp4 -i kapitel.txt \
          -map 0 -map_metadata 0 -map_chapters 1 -c copy \
          -movflags +faststart  \
          .video.mp4.ebbton-tmp.mp4
   ```

   - `-map 0` übernimmt alle Streams (alle Tonspuren). `-map_metadata 0` behält die globalen Metadaten wie
     `creation_time`. Vorhandene Kapitel (z. B. Marker aus OBS) werden ersetzt.
   - `+faststart` ist optional: Es schreibt die Datei ein zweites Mal um, ist aber gut fürs Abspielen übers
     Netz.
   - Den temporären Namen so wählen, dass Medienserver und OBS ihn ignorieren, z. B. mit Punkt am Anfang.
     Dazu den Nutzer fragen, ob Jellyfin o. ä. den Ordner überwacht.
4. **Prüfen** mit ffprobe: gleiche Anzahl und Art der Streams, gleiche Codecs, Dauer ±0,1 s, Kapitelanzahl
   und erste Kapitelzeit wie geplant. Bei Abweichung die temporäre Datei löschen, Original unangetastet
   lassen, Fehler melden.
5. **Ersetzen:**
   - Die `stat`-Werte des Originals vorher sichern.
   - Rechte (`chmod`) und, soweit die Freigabe es zulässt, Eigentümer auf die temporäre Datei übertragen.
   - `os.replace(tmp, original)`.
   - Danach `os.utime(original, (atime, mtime))` mit den gesicherten Werten. Auf SMB-Freigaben prüfen, ob mtime
     wirklich übernommen wird (einmal von Hand testen).
6. Vor dem Ersetzen erneut prüfen, ob sich das Original seit dem Start des Laufs verändert hat (Größe, mtime).
   Wenn ja, abbrechen.

Es wird nie gelöscht außer der eigenen temporären Datei. Bricht der Dienst mittendrin ab, bleibt höchstens
eine temporäre Datei liegen. Der nächste Lauf räumt sie weg, wenn sie älter als ein paar Stunden ist.

### 6. Merken

Weil das Änderungsdatum erhalten bleibt, kann der Dienst bearbeitete Videos nicht an der mtime erkennen.
Deshalb einen eigenen Zustand im Container-Volume führen (SQLite oder JSON). Je Video:

- Pfad, Größe nach dem Schreiben, mtime,
- zugeordnete Session (Pfad),
- **Prüfsumme der geschriebenen Kapitel** (Titel und Zeiten),
- Versätze und Gütewerte,
- Zeitpunkt, Ergebnis.

Bei jedem Lauf:

- Die Kapitel aus der aktuellen Session berechnen. Ist die Prüfsumme gleich, nichts tun.
- Ist sie anders, weil im Ebbton nachträglich Abschnitte verschoben oder umbenannt wurden und die
  Session-Datei neu auf die NAS kopiert wurde: Kapitel neu schreiben.

Der Ton-Abgleich muss dafür nicht wiederholt werden, solange die WAV gleich geblieben ist (Größe und mtime
der WAV mit speichern).

Zusätzlich kann die Prüfsumme als Metadatum ins MP4 (z. B. `comment` oder eigener Tag mit
`-movflags use_metadata_tags`). Dann bleibt die Erkennung erhalten, wenn der Zustand verloren geht.

### 7. Melden (Dashboard)

Je Video ein Zustand mit Kurztext:

| Zustand | Bedeutung |
|---|---|
| `erledigt` | Kapitel geschrieben (Anzahl, Session, Versatz, Zeitpunkt) |
| `aktuell` | Nichts zu tun, Kapitel entsprechen der Session |
| `wartet` | Video oder Session noch nicht stabil bzw. noch nicht auf der NAS, keine passende Session |
| `unsicher` | Abgleich nicht eindeutig: welcher Abschnitt, welche Werte. **Video unverändert.** |
| `fehler` | ffmpeg/ffprobe/Schreibfehler, mit Meldung. **Video unverändert.** |

Dazu Zeitpunkt und Ergebnis des letzten Laufs. „Kein passendes Video“ zu einer Session ist normal (nicht jede
Aufnahme hat ein Video), höchstens als Hinweis anzeigen.

## Auslösen

- **Nachts:** fester Zeitpunkt (z. B. 3:00, mit dem Nutzer abstimmen), im Container per Scheduler.
- **Knopfdruck:** HTTP-Endpunkt, z. B. `POST /run`, den das Dashboard aufruft. Es läuft immer nur ein Lauf
  gleichzeitig (Sperre). Ein zweiter Aufruf während eines Laufs meldet „läuft bereits“.
- Sinnvoll: `POST /run?dry=1` bzw. ein Probelauf-Schalter. Der berechnet alles, schreibt aber nichts und
  zeigt geplante Kapitel mit Videozeiten, Versätzen und Gütewerten an. **Die ersten echten Gottesdienste
  zuerst im Probelauf ansehen** und die Kapitelzeiten im Video stichprobenartig prüfen, bevor geschrieben
  wird.

## Technik (Vorschlag)

- Container: Python 3.12, `ffmpeg`/`ffprobe` aus Debian, `numpy`, `scipy`, kleiner HTTP-Server (z. B.
  FastAPI oder `http.server`), Zeitplanung im Prozess (z. B. APScheduler) oder per Cron.
- Volumes:
  - Ebbton-Ordner **nur lesend** (`:ro`),
  - OBS-Ordner lesend und schreibend,
  - eigenes Volume für den Zustand und die Logs.
- `TZ=Europe/Berlin` setzen. Die OBS-Dateinamen sind Ortszeit, `startedAt` ist UTC.
- Konfiguration über Umgebungsvariablen: Pfade, Zeitplan, Schwellwerte, Probelauf an/aus, Tonspur-Index im
  Video, Dashboard-Ziel.
- Ressourcen: Dekodieren und Korrelieren für einen Gottesdienst dauern ca. 1–2 min CPU. Das Schreiben ist
  durch das Netz begrenzt (mehrere GB lesen und schreiben).

## Testen

1. **Synthetisch** (automatische Tests): aus einer echten WAV ein künstliches „Video“ bauen, d. h. eine
   Tonspur mit Vorlauf, anderem Pegel, leichtem Hall bzw. Filter und einer eingefügten Pause (Stück Audio,
   das in der WAV fehlt). Der Abgleich muss Versatz und Sprung finden. Zusätzlich ein fremdes Audio als
   Gegenprobe: Ergebnis muss „unsicher“ sein.
2. **Echte Daten:** einen vergangenen Gottesdienst (WAV, Session, MP4) im Probelauf. Kapitelzeiten in VLC
   oder mpv nachprüfen.
3. **Schreiben:** an einer Kopie eines Videos auf derselben NAS-Freigabe prüfen:
   - Kapitel sichtbar (VLC, mpv, QuickTime),
   - Video unverändert abspielbar,
   - mtime erhalten,
   - Rechte unverändert.

## Bezug zum Ebbton-Repo

- Session-Logik: `app/src/main/session.js` (`save()` schreibt die Datei, `start()` den Dateinamen).
- WAV: `app/src/main/wav.js`.
- Regeln für Abschnitte: `app/src/shared/sections.js`.
- Entwurfsentscheidungen von Ebbton: `CLAUDE.md` im Repo-Wurzelordner.

Ändert sich in Ebbton das Format der Session-Datei, muss dieser Dienst angepasst werden. Bitte in Ebbtons
`CLAUDE.md` vermerken, wo der Dienst liegt, sobald er existiert.
