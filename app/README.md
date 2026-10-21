# Ebbton

Aufnahmeprogramm für Gottesdienste. Nimmt eine Stereospur des Audioeingangs auf,
gliedert sie über Abschnitte mit verschiebbarer Anfangs- und Endmarke in die Programmpunkte des Ablaufplans und
speichert einen ausgewählten Abschnitt – zum Beispiel die Predigt – als MP3.

- Durchgehende, verlustfreie WAV-Masteraufnahme; Abschnitte sind Metadaten (Session-Datei, nach dem Beenden zusätzlich als Cue-Marker in der WAV, lesbar in Audacity, Reaper u. a.)
- Ablaufplan aus ChurchTools, Punkte per Drag-and-Drop auf die Wellenform
- Netzwerkschnittstelle für ein eigenes Monitoring-Dashboard
- Fernsteuerung über Bitfocus Companion

## Installation für die Entwicklung

Voraussetzung: Node.js 22.12 oder neuer (empfohlen 24 LTS), weil Electron 45 und
electron-builder 26 das zum Installieren und Bauen verlangen.

```bash
npm install
npm start
```

Fertige Installationsdateien bauen:

```bash
npm run dist        # Windows: NSIS-Installer (.exe) in release/
npm run dist:mac    # macOS: DMG und ZIP in release/
```

### Entwicklung abwechselnd auf Mac und Windows

Das Repository ist auf beiden Systemen gleich einzurichten:

1. [Git for Windows](https://git-scm.com/download/win) und Node.js 24 (LTS)
   installieren, ein Editor wie VS Code oder die Claude-Desktop-App ist optional.
2. Klonen und starten (im Ordner `app/`):
   ```bash
   git clone https://github.com/paddepf/ebbton.git
   cd ebbton/app
   npm install
   npm run dev
   ```
   Die Entwicklerwerkzeuge öffnen sich nicht von selbst (sie würden bei jedem
   Neustart den Fokus holen): per `F12` bzw. `Strg`/`Cmd` + `Umschalt` + `I`
   ein- und ausblenden, oder dauerhaft starten mit `npm run dev:tools`.
3. Arbeitsablauf: vor dem Arbeiten `git pull`, danach committen und pushen.
   Aktuell wird auf beiden Rechnern direkt auf `main` gearbeitet (Testphase);
   bei produktiver Nutzung sollten Änderungen am Aufnahmerechner auf Branches.

Pro Rechner einmalig und nicht im Repository: der ChurchTools-Token und das
Netzwerkpasswort. Unter Windows kann es bei nativen Modulen nötig sein, die
Visual Studio Build Tools zu installieren; aktuell hat die App keine.

Gebaut wird jeweils auf dem Zielsystem – ein Mac-Build lässt sich nicht unter
Windows erzeugen. Der mitgelieferte Workflow erledigt beides auf GitHub.

## Einrichtung beim ersten Start

Die Einstellungen öffnet das Zahnrad oben rechts. Sie sind in Reiter gegliedert (links: Audio, Mehrspur & Pult,
Ablage & Export, ChurchTools, Vorlagen, Netzwerk, Programm). Geänderte Reiter tragen einen gelben Punkt; gespeichert wird
mit „Änderungen speichern“, beim Schließen ohne Speichern fragt die App nach.

Ordner werden als Name mit Pfad darunter angezeigt und über „Ändern …“ gewählt. Unter dem Dateinamen-Muster lassen sich
die Platzhalter per Klick einfügen, darunter steht ein Beispiel, wie die MP3-Datei heißen wird.

1. **Einstellungen → Audio:** Aufnahmeart (Stereo ist der Normalfall), Eingang, Ausgang (fürs Mithören) und Abtastrate wählen. Die Auswahl wird
   gespeichert und beim nächsten Start wiederverwendet.
2. **Einstellungen → Ablage:** Ordner für die Aufnahmen festlegen. Rechne mit
   etwa 700 MB pro Stunde für die WAV-Masteraufnahme. Zusätzlich lässt sich ein
   Oberordner für die MP3-Exporte angeben (z. B. „Aufnahmen 2026“); darin
   entsteht je Gottesdienst ein Unterordner `Datum_Gottesdienstname`. Der **Dateiname**
   der MP3s ist ein Muster mit den Platzhaltern `{interpret}`, `{abschnitt}`,
   `{gottesdienst}`, `{datum}` und `{zeit}`; Standard ist
   `{interpret}_{abschnitt}_{gottesdienst}_{datum}`. Fehlt der Interpret, entfällt er
   samt Trennzeichen (z. B. `Predigt_Sonntagsgottesdienst_2026-10-05.mp3`).
3. **Einstellungen → ChurchTools:** Adresse und Personal Access Token eintragen,
   dann „Verbindung prüfen“. Der Token wird über die Schlüsselverwaltung des
   Betriebssystems verschlüsselt abgelegt.
4. **Einstellungen → Netzwerk:** Ein Passwort für die Steuerung vergeben, sonst
   startet die Schnittstelle nicht. Optional ein zweites Passwort nur zum
   Mitlesen für das Dashboard.

## Ablauf eines Gottesdienstes

Die Oberfläche folgt den drei Phasen eines Sonntags; oben in der Mitte steht, in welcher man gerade ist
(**Vorbereiten › Aufnehmen › Sichern**). Je Phase gibt es genau einen hervorgehobenen Knopf, was gerade nicht geht,
ist ausgeblendet. Unten links steht die Liste **„Ablauf“** (alle Programmpunkte: offen, laufend, fertig), rechts der
Bereich **„Jetzt“** mit dem, was die Phase braucht.

1. **Vorbereiten.** Oben auf den Namen klicken und den Gottesdienst wählen. Ist für heute genau
   ein Termin eingetragen, wird er beim Start automatisch geladen. Die Programmpunkte erscheinen in der
   Liste „Ablauf“ als offene Punkte (gestrichelte Farbmarke). Dieselbe Auswahl öffnet auch der Knopf
   „ChurchTools …“ über der Liste; darunter steht in einer Zeile, ob der Plan aus ChurchTools oder aus welcher
   Vorlage stammt, mit Zahl der Dienste und Infotext (Details im Tooltip). Offene Punkte lassen sich am Griff
   (⋮⋮) umsortieren, unten kommen neue dazu.
   Rechts prüft **„Bereit für den Start?“**: Eingang (mit Pegel – der Eingang wird dafür schon vor dem Start
   geöffnet, gespeichert wird nichts; abschaltbar unter *Einstellungen → Audio*), Gottesdienst, Ablauf, Punkte
   ohne Interpret („Eintragen“ springt direkt ins Feld), Speicherplatz und ggf. das Mischpult-Routing. Darunter
   steht, welcher Punkt beim Start automatisch beginnt.
2. **Aufnahme starten** (roter Knopf, `Strg`/`Cmd` + `R`). Die Wellenform wächst mit, der obere Fensterrand
   leuchtet rot. **Der erste Punkt des Ablaufs beginnt dabei automatisch** (bei Sekunde 0); ohne Ablaufpunkte
   läuft zunächst kein Abschnitt.
3. **Aufnehmen.** Hauptknopf ist jetzt **„Nächster Punkt“** (Taste **N**), darunter groß der Name des Punkts, z. B.
   „Predigt“: Er beendet den laufenden Abschnitt und beginnt diesen Punkt. Daneben **„Abschnitt starten / beenden“**
   (Taste **M**) für eigene Abschnitte. Ist kein Punkt mehr offen, verschwindet N und „Abschnitt beenden“ wird zum
   Hauptknopf (die Taste N beendet den laufenden Abschnitt weiterhin). Ein Klick auf einen offenen Punkt in der Liste beginnt ihn ebenfalls. Die Marke
   wird sofort gesetzt (der Knopf leuchtet kurz in der Farbe des neuen Abschnitts), benannt wird danach direkt im
   Feld (siehe unten). Jeder Abschnitt hat eine feste Farbe in Wellenform und Liste.
   Rechts zeigt **„Jetzt“** den laufenden Abschnitt groß mit Laufzeit (Klick = Name/Interpret bearbeiten), den
   nächsten Punkt. Probleme mit Eingang, Laufwerk oder Speicherplatz melden der Warnbalken und die Meldungen oben.
   **Pause** (❚❚) und **Beenden** (■) stehen als Symbole rechts neben M. **Beenden muss man kurz gedrückt halten**
   (der Balken im Knopf läuft voll), damit ein versehentlicher Klick keinen Gottesdienst beendet; `Strg`/`Cmd` + `R`
   beendet sofort. Pausiert wird der Pause-Knopf gelb und setzt fort.
   **Pausen zwischen zwei Punkten:** Ist nach einem Punkt eine längere Pause (Ansage, Umbau, Stille), die in keinem
   der beiden Abschnitte landen soll, zuerst **„Abschnitt beenden“** (`M`) drücken: Die Aufnahme läuft ohne aktiven
   Abschnitt weiter („Zwischen den Punkten“), bis **N** den nächsten beginnt. Ohne Zwischenschritt beginnt der
   nächste Punkt nahtlos da, wo der vorige endet.
4. Marken sitzen selten sofort richtig. Sie lassen sich jederzeit – auch während
   der Aufnahme – am Fähnchen auf der Wellenform verschieben; mit der
   Leertaste lässt sich dabei in die Aufnahme hineinhören. Die **Übersichtsleiste** über der Wellenform zeigt die
   ganze Aufnahme mit allen Abschnitten und als Rahmen den sichtbaren Ausschnitt: Klick springt hin, der Rahmen
   lässt sich ziehen. Nach „Beenden“ werden noch laufende Abschnitte am Ende der Aufnahme geschlossen.
5. **Sichern.** Nach dem Beenden tragen die fertigen Abschnitte in der Liste Häkchen (alle vorausgewählt,
   „Alle“/„Keine“ schalten um), dazu den Stand: „✓ gesichert“, „⚠ geändert“ (Marken oder Schnitte seit dem Export
   verändert) oder „ungesichert“; Datei und Zeitraum im Tooltip, die Länge ohne Schnitte. Ganz unten steht
   „Gesamte Aufnahme“. Der Hauptknopf oben nennt, was gespeichert wird („2 Abschnitte als MP3 sichern“); ist alles
   gesichert, steht dort „Alles gesichert ✓“. Rechts unter **„Sichern“** stehen Zielordner (ganzer Pfad im Tooltip),
   Format und Fortschritt; „An Aufnahme anhängen“ nimmt in dieselbe Datei weiter auf. „Neue Aufnahme“ steht bewusst
   leise neben dem Sichern-Knopf; sie startet nicht gleich, sondern führt nach einer Rückfrage zurück zu
   „Vorbereiten“: Gottesdienst und Ablauf bleiben, die Punkte sind wieder offen, und man kann noch eine andere Vorlage
   oder einen anderen Termin wählen, bevor man mit „Aufnahme starten“ beginnt. Nie begonnene Punkte erscheinen blass.
   Ist ein Export-Oberordner eingestellt, wird ohne Rückfrage
   in dessen Unterordner `Datum_Gottesdienstname` gespeichert (bei gleichem Namen
   mit „ (2)“ usw.); ohne Oberordner wird ein Zielordner abgefragt. Die MP3s
   erhalten ID3-Tags: **Titel** = Abschnittsname, **Album** = Datum des
   Gottesdienstes (z. B. `2026-10-05`), **Jahr**, **Interpret** = der beim
   Abschnitt eingetragene Name, sonst der „Standard-Interpret“ aus den Einstellungen.
   Den Interpreten trägst du direkt im Feld ein (siehe „Name und Interpret direkt
   bearbeiten") – auch schon bei den offenen Punkten, bevor sie
   aufgenommen werden. Er steht hell hinter dem Namen, fehlt er, erscheint beim
   Darüberfahren „+ Interpret“.
   Lange Namen werden in der Liste mit „…“ gekürzt; beim Darüberfahren erscheint
   der ganze Titel samt Interpret. ✎ und × erscheinen beim Darüberfahren. **Entfernen** geht ohne Rückfrage, dafür
   bietet ein Hinweis unten rechts „Rückgängig“ an.

**Pegel:** Oben rechts zeigen zwei Balken den Spitzenpegel in dBFS (Skala −48 … 0): grün bis −9, gelb bis −3,
darüber rot. Der Strich hält die Spitze 2 Sekunden, rechts steht ihr Wert. „Übersteuert“ bleibt stehen, bis man es
anklickt – so sieht man es auch, wenn man gerade nicht hingeschaut hat.

**Lautheit (LUFS) in der Wellenform:** Der Schalter „LUFS“ unten links in der Wellenform blendet die Lautheit nach EBU R128
als türkisblaue Linie ein (Skala rechts −10 … −40, gestrichelt in derselben Farbe das Ziel aus „Lautstärke angleichen“). Die Linie ist die
Short-term-Lautheit, also das Mittel der letzten 3 s; herausgezoomt wird sie zusätzlich geglättet. Die Messwerte stehen
in der Leiste über der Wellenform: während der Aufnahme S (letzte 3 s), M (letzte 0,4 s), I (integriert über die ganze
Aufnahme) und der laufende Abschnitt; danach S an der Mausposition, I gesamt und der gewählte Abschnitt (Klick auf
den Abschnitt in der Liste „Ablauf“ oder auf sein Fähnchen). Bei wenig Platz fallen die
hinteren Werte weg. Fährt man mit der Maus über die Anzeige, erklärt eine Infobox S, M und I. Ältere
Aufnahmen werden beim Öffnen einmal im Hintergrund nachgemessen (etwa 6 s je Stunde). Nur bei Stereo.

Die MP3-Dateien werden beim Export auf eine einheitliche Lautheit gebracht (Einstellungen → Ablage & Export →
„Lautstärke angleichen“, Vorgabe −16 LUFS wie bei Podcasts; „Aus“ lässt sie wie aufgenommen). Leise Aufnahmen werden
dabei höchstens um 20 dB angehoben, Spitzen sanft auf −1 dBFS begrenzt. Die WAV bleibt unverändert.

Die WAV-Masteraufnahme bleibt erhalten. Über „Aufnahmen“ kann eine frühere
Session erneut geöffnet, die Marken nachjustiert und ein weiterer Abschnitt
exportiert werden. Das Archiv ist nach Monaten gegliedert, lässt sich durchsuchen (Gottesdienst, Datum,
Interpret, Abschnitt) und filtern (z. B. „Nicht vollständig gesichert“); jede Aufnahme zeigt, ob ihre Abschnitte
schon als MP3 gesichert sind, und „📂“ öffnet ihren Ordner.

Während einer Aufnahme zeigt der Fenstertitel „● Aufnahme läuft“; unter Windows trägt das Symbol in der
Taskleiste einen roten Punkt (pausiert orange, bei Problemen gelb), auf dem Mac das Dock-Symbol ein Abzeichen.

### Interpret aus ChurchTools

- **Ablaufplan:** Ist bei einem Ablaufpunkt in ChurchTools eine zuständige Person eingetragen, wird sie
  automatisch als Interpret übernommen (jederzeit änderbar).
- **Dienstplanung:** Auch ohne Ablaufplan sind meist Dienste wie „Leitung“ und „Predigt“ besetzt. Beim Wählen
  eines Termins liest die App diese Personen aus der Dienstplanung. Beim Bearbeiten eines Abschnitts erscheinen
  sie als **Vorschläge zum Anklicken** (Name · Dienst) unter den Eingabefeldern; ein Klick übernimmt den Namen
  und speichert.
- **Automatisch eintragen:** Passt ein Dienst zum Namen eines Ablaufpunkts, wird die Person direkt als Interpret
  eingetragen – zum Beispiel der Dienst „Predigt 2“ beim Punkt „Predigt“. Verglichen werden ganze Wörter
  („Leitung“ passt nicht zu „Einleitung“), Zahlen zählen nicht („Predigt 2“ passt nicht zu „Lied 2“).
  Sind mehrere Dienste passend (z. B. „Predigt“ und „Predigt 2“), stehen alle Namen mit Komma dort. Eine
  zuständige Person aus dem Ablaufplan hat Vorrang, und jeder Eintrag lässt sich ändern. Die übrigen Personen
  bleiben als Vorschläge zum Anklicken; passende stehen zuerst und haben einen grünen Rand. Welche Dienste gelesen werden, steht unter **Einstellungen → ChurchTools →
  Dienste für Interpret-Vorschläge** (Standard: `Leitung, Predigt, Geschichte`, durch Komma getrennt; der Dienst „Geschichte“ gehört fest zum Ablaufpunkt „Kinderbeitrag“, „Leitung“ fest zu „Einleitung“ und „Abschluss“; diese Dienste werden immer gelesen; der Dienstname muss
  das Wort enthalten, „Leitung“ findet also auch „Gebetsleitung“).
- Beim Wählen des Termins meldet die App nur Ungewöhnliches: dass kein Ablaufplan vorlag (und welche Vorlage
  geladen wurde) oder dass die Dienstplanung nicht gelesen werden konnte. Eingetragene Punkte, Interpreten und
  Infotext stehen direkt in den Listen.

### Name und Interpret direkt bearbeiten

Ohne Dialog, direkt am Element: ein kleines Eingabefeld legt sich über das Fähnchen
oder die Listenzeile, links der Name, rechts der Interpret.
- **Wellenform:** Doppelklick auf das Fähnchen eines Abschnitts. Ein Doppelklick auf den
  Interpreten (bzw. „+ Interpret“) springt direkt in dieses Feld.
- **Liste „Ablauf“:** Doppelklick auf den Namen, ✎ (beim Darüberfahren), ein Klick auf den Interpreten oder `F2`
  in der gewählten Zeile. (Ein einfacher Klick wählt einen fertigen Abschnitt bzw. beginnt während der Aufnahme
  einen offenen Punkt.)
- **„Jetzt“:** Klick auf die Karte des laufenden Abschnitts.

`Enter` speichert, `Esc` bricht ab, `Tab` wechselt zwischen Name und Interpret, ein Klick
daneben speichert ebenfalls.

### Rückgängig, Schnitte und Warnungen

- **Rückgängig / Wiederholen:** zwei Pfeilknöpfe im Kopf der Liste „Ablauf“ (grau, wenn nichts zu tun ist) oder `Strg`/`Cmd` + `Z` nehmen die letzte Änderung an Abschnitten oder Schnitten
  zurück (Marke gesetzt, verschoben, gelöscht, umbenannt …), `Umschalt` + `Strg`/`Cmd` + `Z` bzw. `Strg` + `Y`
  stellt sie wieder her. Bis zu 60 Schritte; auch das Laden einer Vorlage oder eines Ablaufplans lässt sich
  zurücknehmen. Mit „Beenden“, einer neuen Aufnahme oder dem Öffnen einer anderen beginnt der Verlauf neu. In Eingabefeldern wirkt
  Rückgängig wie gewohnt auf den Text.
- **Schnitte (Stellen, die im MP3 fehlen sollen):** Ein Husten oder eine Störung mitten im Abschnitt lässt sich
  auslassen, ohne die Aufnahme zu verändern. Während der Aufnahme beginnt `X` einen Schnitt und beendet ihn
  mit dem zweiten Druck (oder Knopf „✂ Schnitt“ über der Wellenform). Nachträglich: mit `Umschalt` + Ziehen in der Wellenform aufziehen. Schnitte erscheinen
  rot schraffiert, ihre Ränder lassen sich ziehen, ein Doppelklick entfernt sie. Beim Export fehlen die Stellen
  (mit kurzer Ein-/Ausblendung an den Nahtstellen); nach dem Beenden zeigt die Liste die gekürzte Länge (Tooltip
  „✂ −0:12“). „⚠ geändert“ erscheint auch, wenn sich die Schnitte seit dem Export geändert haben.
- **Eingang überwacht:** Kommt über 20 Sekunden fast kein Pegel (Mischpult stumm, Kabel gezogen), erscheint ein
  oranger Balken. Fällt der Eingang ganz aus, ein roter. Beides sehen auch Companion und Dashboards (`health`).

### Ablaufplan bearbeiten und Standardpunkte

Hat ein Termin in ChurchTools **keinen Ablaufplan** (die Abfrage meldet 404) oder wird
ohne ChurchTools aufgenommen, trägt die App die **Standard-Programmpunkte** ein
(Vorgabe: Einleitung, Kinderbeitrag, Predigt, Abschluss). Das ist die **Standardvorlage**.
Unter **Einstellungen → Vorlagen für Programmpunkte** lassen sich beliebig viele Vorlagen anlegen
(z. B. „Gottesdienst“, „Jugend“, „Gebetsabend“): Vorlage wählen, Namen und Punkte bearbeiten (↑/↓ zum
Umsortieren), neue Vorlage mit „Neu“, und eine als Standard festlegen. Über der Liste „Ablauf“ lädt das Auswahlfeld
**„Vorlage laden …“** jederzeit eine andere Vorlage; die offenen Punkte werden dabei (nach Rückfrage)
ersetzt, bereits gesetzte Abschnitte bleiben.

**Infotext als Predigttitel:** Trägt der Termin in ChurchTools einen Infotext (z. B. bei der Bibelstunde
„Kolosser 2,6-7 Verwurzelt in Christus“), hängt die App ihn beim Laden an den Abschnitt „Predigt“ an – er heißt
dann „Predigt: Kolosser 2,6-7 Verwurzelt in Christus“ und landet so auch im Dateinamen und im MP3-Titel. Nur die
erste Zeile wird genommen; der Name lässt sich jederzeit wie gewohnt ändern. Der Text steht dann im Namen des
Abschnitts. Gerade Anführungszeichen aus ChurchTools (`"…"`) werden dabei – wie in den Namen der
Ablaufpunkte – typografisch gesetzt („…“).

**Passende Vorlage automatisch:** Fehlt der Ablaufplan, nimmt die App nicht blind die Standardvorlage,
sondern die Vorlage, deren **Name zum Titel des Gottesdienstes passt** – ein Termin „Bibelstunde“ (oder
„Bibelstunde im Gemeindehaus“) lädt die Vorlage „Bibelstunde“. Das gilt für jede selbst angelegte Vorlage:
alle Wörter des Vorlagennamens müssen als ganze Wörter im Titel vorkommen (Groß-/Kleinschreibung egal), bei
mehreren Treffern gewinnt der längere Name. Ohne Treffer gilt die Standardvorlage. Hat ChurchTools einen
Ablaufplan, bleibt dieser maßgeblich.

In der Liste **Ablauf** lassen sich die Punkte jederzeit anpassen:
- **Hinzufügen:** unten Namen eintippen, Enter oder „+“.
- **Entfernen:** × neben dem Punkt (erscheint beim Darüberfahren). Ein bereits gesetzter Abschnitt aus dem Ablaufplan
  wird dabei wieder ein offener Punkt; „Rückgängig“ im Hinweis nimmt es zurück.
- **Umsortieren:** einen offenen Punkt am Griff (⋮⋮) auf einen anderen ziehen (oberhalb/unterhalb
  der Mitte entscheidet, davor oder dahinter) oder auf den freien Platz darunter, um ihn ans
  Ende zu setzen. N nimmt immer den obersten offenen Punkt.

### Oberfläche rund um die Wellenform

Die Wellenform zeigt beim Start und bei jeder neuen oder fortgesetzten Aufnahme
standardmäßig **5 Minuten** auf einmal; mit den Lupen-Knöpfen rechts über der Wellenform, `Strg` + Mausrad oder
`Umschalt` + Mausrad lässt sich zoomen. Hineingezoomt verschiebt **Ziehen mit der Maus** (in der Wellenform oder der
Zeitleiste) die Ansicht hin und her; ein einfacher Klick ohne Bewegung setzt wie gewohnt die Hörmarke. Eine beendete
oder geöffnete Aufnahme wird komplett eingepasst. Lange
Abschnittsnamen werden an der Marke mit „…“ gekürzt, damit sich Beschriftungen
nicht überlappen; weiter hineinzoomen zeigt mehr vom Namen.

Über der Wellenform rechts sitzt der **Abspielknopf**: ▶ spielt ab der Marke, ❚❚ hält an; während der
Aufnahme zeigt er einen Kopfhörer (Mithören ab dem Cursor), bei Mehrspur „▶ Zum Pult“ bzw. „■ Stopp“. Unten links in
der Wellenform liegen die Schalter **LUFS** (Lautheitslinie), **Folgen** (Ansicht läuft mit der Live-Stelle mit) und
bei Mehrspur **Schleife**; eingeschaltet sind sie farbig. Wie „LUFS“ und „Folgen“ beim Start stehen, legt
*Einstellungen → Programm → Wellenform* fest; in der Wellenform umgeschaltet gilt es nur bis zum nächsten Programmstart
(LUFS) bzw. bis zur nächsten Aufnahme (Folgen).

Unter der Wellenform stehen drei Bereiche: **Ablaufplan** (offene Punkte),
**Abschnitte** (gesetzte Abschnitte mit Zeitraum, Doppelklick zum Umbenennen) und
**Abschnitte exportieren**. Ganz unten zeigt eine Leiste die wichtigsten
**Tastenkürzel** („alle Kürzel (?)“ öffnet die komplette Liste). Rechts oben in
der Kopfleiste steht der **freie Speicherplatz** und wie viele Aufnahmestunden das
sind; unter 3 Stunden wird die Anzeige orange, unter 30 Minuten rot (dann auch mit
Meldung während der Aufnahme).

### Tastaturkürzel

| Taste | Wirkung |
|---|---|
| `Strg` + `R` (macOS: `Cmd` + `R`) | Aufnahme starten bzw. beenden (auch eine pausierte) |
| `M` | Abschnitt starten bzw. beenden (Anfangs-/Endmarke setzen) |
| `N` | Laufenden Abschnitt beenden und nächsten Ablaufpunkt beginnen |
| `X` | Schnitt starten bzw. beenden (Stelle fehlt im MP3) |
| `Strg`/`Cmd` + `Z` | Rückgängig; `Umschalt` + `Strg`/`Cmd` + `Z` oder `Strg` + `Y`: Wiederholen |
| `F2` | Gewählten Abschnitt bearbeiten (Name und Interpret) |
| `?` | Alle Tastenkürzel anzeigen (nochmal `?` oder `Esc` schließt) |
| `Strg` + `Umschalt` + `M` (macOS: `Cmd` + `Umschalt` + `M`) | Mini-Fenster ein/aus |
| `Esc` | Offenen Dialog schließen |
| `Leertaste` | Abspielen/Pause; während der Aufnahme: Mithören ab dem Hörcursor |
| Mausrad | auf der Wellenform scrollen |
| `Strg` + Mausrad oder `Umschalt` + Mausrad | zoomen |

Gehaltene Tasten wiederholen nicht (sonst würden sich z. B. Abschnitte im Wechsel starten und beenden).

### Meldungen

**Fehler und Warnungen** (z. B. Platte voll, Eingang ausgefallen, wenig Speicher) erscheinen groß und farbig oben
in der Mitte: rot für Fehler, gelb für Warnungen. Sie bleiben mindestens 15 bzw. 30 Sekunden stehen und lassen
sich per Klick schließen. Kleine Hinweise erscheinen dezent unten rechts und verschwinden von selbst. Bestätigungen
für das, was man ohnehin sieht, gibt es nicht.

### Laufzeit des aktuellen Abschnitts

Rechts unter **„Jetzt“** (im Mini-Fenster in der Karte des laufenden Abschnitts) steht groß, **wie lange der aktuelle
Abschnitt schon läuft** – als `2:20`, ab einer Stunde `1:04:00`. Die Anzeige läuft mit der Aufnahme mit und
verschwindet, wenn kein Abschnitt aktiv ist (z. B. in der Pause zwischen zwei Punkten). Auch in der Liste
**Ablauf** steht hinter jedem Abschnitt seine **Laufzeit** (bei einem laufenden zählt sie mit). Unter dem Timer steht
der Zustand: „Bereit“, „Aufnahme läuft“, „Pausiert“ oder „Beendet“ mit Sicherungsstand („2 ungesichert“).

### Mini-Fenster

Rechts oben wählt **„A A“** die Größe (kleines A = kompakt, großes A = groß), das Fenster-Symbol daneben schaltet
ins **Mini-Fenster** und zurück, das Sonnen- bzw. Mondsymbol wechselt direkt zwischen **hell und dunkel**.

Wird nebenher am PC gearbeitet, verkleinert **„Mini“** die App auf ein sehr kleines
Fenster (ab 320 × 164) mit Gottesdienstname, Timer, Pegel (schmaler Streifen), dem **laufenden Abschnitt groß mit Interpret** und den Knöpfen
für Aufnahme bzw. Pause und Beenden (gedrückt halten) neben dem Timer, darunter „Abschnitt starten“ und als
Hauptknopf der nächste Punkt (der Knopf nennt ihn – „→ Predigt“; ist keiner mehr offen, steht dort „→ Abschnitt
beenden“). Ein Klick auf den laufenden Abschnitt (oder ✎) öffnet
direkt die Eingabe für Name und Interpret samt Vorschlägen aus der Dienstplanung (Klick auf den Interpret
setzt den Cursor gleich dorthin); im großen Fenster geht das über die Karte unter „Jetzt“. Die Tastenkürzel gelten weiter. Es liegt beim
ersten Mal unten rechts und merkt sich danach Lage und Größe. Mit **„Immer oben“** bleibt es über
anderen Programmen (Voreinstellung, abschaltbar). **Nach dem Beenden** der Aufnahme verschwinden die Aufnahmeknöpfe;
stattdessen zeigt das Mini-Fenster, wie viele Abschnitte noch nicht gesichert sind, und einen Knopf **„… als MP3
sichern“** (angehakte bzw. noch nicht gesicherte oder seit dem Export geänderte Abschnitte, ohne Abschnitte die gesamte
Aufnahme; ist alles gesichert, steht dort „alles gesichert ✓“ und der Knopf entfällt), dazu Fortschritt
und „Im Ordner zeigen“. „Neue Aufnahme“ darunter bereitet die nächste vor (zurück zu „Vorbereiten“). **„Groß“** bzw. **„Kompakt“** stellt die vorherige Größe
wieder her. Öffnet sich ein Dialog (z. B. Rückfrage beim Start, Einstellungen, `?`), schaltet die App
selbst auf das große Fenster um. Die Aufnahme läuft beim Umschalten unverändert weiter.

### Kompakte Ansicht

**„Kompakt“** (Voreinstellung) verkleinert Schrift, Knöpfe, Abstände und Wellenform,
lässt aber **alle Bereiche und Funktionen** stehen: Ablauf, „Jetzt“, Wellenform und Tastenleiste. So
lässt sich auch in einem kleineren Fenster (ab 760 × 520 statt 1024 × 680) vollständig arbeiten. In sehr schmalen
Fenstern bzw. schmaler Liste entfallen die Zeitspalte (Zeitraum im Tooltip), bei sehr schmaler Liste auch der Zustand, das Datum neben dem Gottesdienstnamen und bei
sehr niedrigen die Tastenleiste (Kürzel weiter über `?`). Beim Einschalten wird das Fenster passend verkleinert
(beim ersten Mal 960 × 640, danach die zuletzt benutzte Größe), beim Ausschalten bekommt es wieder seine vorherige Größe.
Die Wahl bleibt gespeichert; die App startet dann gleich in der kompakten Größe. Das Mini-Fenster ist davon
unabhängig und sieht immer gleich aus.

### Kalender, Beenden, Bedienung per Tastatur

- **Kalender:** Unter Einstellungen → ChurchTools lassen sich die Kalender wählen, deren Termine in der Auswahl
  erscheinen (ohne Häkchen: alle); die Liste lädt beim Öffnen des Reiters von selbst.
- **Fehlersuche ChurchTools:** „Antworten zum Termin speichern“ (Einstellungen → ChurchTools) schreibt, was
  ChurchTools zum gewählten Gottesdienst liefert (Termin mit Dienstplanung, Ablaufplan, Dienste, Beispielpersonen), als
  `churchtools-<Termin>-<Zeit>.json` in den Ordner `logs` des Programmordners und zeigt die Datei. Der Token steht nicht
  darin, Personennamen schon – die Datei nicht weitergeben. Gedacht für den Fall, dass Interpreten oder Infotext nicht
  ankommen: Dort sieht man, unter welchen Feldern ChurchTools sie wirklich liefert.
- **Beenden:** Beim Schließen während einer Aufnahme fragt die App nach, ohne die Aufnahme dabei
  anzuhalten, und schließt erst, wenn die Datei vollständig geschrieben ist.
- **Pause:** In der Pause sind Timer, Fensterrand und Pause-Knopf gelb; derselbe Knopf (jetzt ▶) setzt fort.
  „An Aufnahme anhängen“ (unter „Sichern“) hängt an eine bereits beendete Aufnahme an.
- **Beenden der Aufnahme:** den ■-Knopf kurz gedrückt halten (Maus oder `Enter`/Leertaste); ein kurzer Klick zeigt
  nur einen Hinweis. `Strg`/`Cmd` + `R` und Companion beenden sofort.
- **Tastatur:** Die Zeilen der Liste „Ablauf“ lassen sich mit `Tab` erreichen,
  mit den Pfeiltasten wechseln, mit `Enter` auslösen (Ablaufpunkt beginnen bzw. Abschnitt
  anzeigen) und mit `F2` bearbeiten.

## Netzwerkschnittstelle

Beschreibung aller Nachrichten: [`docs/websocket-api.md`](docs/websocket-api.md).

Kurz: `ws://<rechner>:8765/`, Anmeldung mit
`{"type":"auth","password":"…"}`, danach kommen `state`- und `levels`-Nachrichten.
Für eine reine Statusabfrage genügt `http://<rechner>:8765/health`.

**Statusseite für Handy und Tablet:** `http://<rechner>:8765/` im Browser öffnen (die genaue Adresse steht unter
Einstellungen → Netzwerk) und mit dem Passwort zum Mitlesen anmelden. Die Seite zeigt Zustand, Laufzeit, Pegel,
Warnungen sowie den aktuellen und nächsten Ablaufpunkt – praktisch für den Prediger oder wenn man nicht am
Technikplatz steht. Steuern lässt sich dort nichts. Bricht die Verbindung ab, wird die Anzeige blass („getrennt –
Anzeige veraltet“) und der Timer bleibt stehen, bis die Seite wieder verbunden ist.

Das Companion-Modul liegt im Ordner `companion-module/` dieses Repositorys.

## Updates

Die App sucht kurz nach dem Start und danach alle zwei Stunden, ob im GitHub-Repository
ein neues Release liegt (abschaltbar in den Einstellungen; dort auch „Jetzt nach Update suchen“
mit Ergebnis und Zeitpunkt der letzten Suche). Jeder Schritt braucht eine Zustimmung:

1. **Gefunden:** Ein Dialog nennt die neue und die installierte Version samt „Was ist neu?“ und
   fragt, ob heruntergeladen werden soll. „Später“ lässt oben den Knopf „Update … verfügbar“ stehen.
2. **Download:** Fortschrittsbalken mit Prozent, MB, Geschwindigkeit und Restzeit; der Dialog kann
   geschlossen werden („Im Hintergrund weiter“), der Kopfzeilen-Knopf zählt mit.
3. **Bereit:** Zweite Rückfrage „Jetzt installieren und neu starten?“. Danach wird Ebbton beendet,
   das Update unter Windows ohne Installer-Fragen eingespielt und Ebbton von selbst neu gestartet
   (etwa eine halbe Minute). Nach dem Neustart meldet die App „aktualisiert: alt → neu“.

Beim Beenden der App wird nie ungefragt installiert. Fehler beim Download oder bei der Installation
erscheinen im Dialog mit „Erneut versuchen“ und Link zur Download-Seite; schlägt nur die automatische
Suche fehl (kein Internet), gibt es keine Meldung, nur einen Vermerk in den Einstellungen. Protokoll:
`logs/updater.log` im Einstellungsordner (`%APPDATA%\ebbton` bzw. `~/Library/Application Support/ebbton`).

**Während einer laufenden oder pausierten Aufnahme wird weder gesucht, heruntergeladen noch installiert.**

### Eingangsprotokoll

Meldet die App „Kein Audiosignal – der Eingang wird neu verbunden“, obwohl am Pult alles in Ordnung scheint, hilft
`logs/eingang.log` im Einstellungsordner (`%APPDATA%\ebbton` bzw. `~/Library/Application Support/ebbton`; über 2 MB wird
daraus `eingang.log.1`). Eine Zeile je Ereignis: Ortszeit mit Offset · Stufe · Ereignis · Daten als JSON.

| Ereignis | Bedeutung |
|---|---|
| `aufnahme-gestartet` / `-beendet` | Rahmen; der Start nennt Version, Modus und Abtastrate, das Ende bei Stereo den gesamten Fehlbetrag gegen die Uhr (`fehlbetragSekunden`, `gemessenMinuten`) |
| `fehlbetrag` | Der Stereo-Aufnahme fehlen gegenüber der Uhr so viele Sekunden (je angefangene halbe Sekunde ein Eintrag, mit `prozent`) – leiser Verlust ohne einzelnen Aussetzer. Ab 2 s Warnbalken in der Oberfläche, nach dem Beenden eine Warnung |
| `timer-regel-ausgenommen` / `-fehlgeschlagen` | Nur Windows: Die Oberfläche wurde von der Timer-Regel für Hintergrundfenster ausgenommen (mit `control`/`state`) bzw. nicht |
| `eingang-geoeffnet` | Eingang (neu) geöffnet, mit Gerätename, Kontext- und Spurzustand |
| `luecke-in-oberflaeche` / `luecke-zwischen-bloecken` | Zwischen zwei 100-ms-Blöcken vergingen > 500 ms (Oberfläche bzw. Hauptprozess gemessen) – auch Aussetzer unter der 2,5-s-Schwelle des Wächters |
| `wiederverbinden-start` | Der Wächter hat ausgelöst: seit wie vielen ms keine Blöcke, dazu Zustand von Spur (`zustand`, `stumm`), Audiokontext, Fenster (`sichtbar`, `fokus`) |
| `wiederverbunden` / `wiederverbinden-fehlgeschlagen` | Ausgang des Versuchs, `fehlenSekunden` = Lücke in der Aufnahme |
| `luecke-mit-stille-gefuellt` | Die Lücke wurde mit Stille aufgefüllt (`sekunden`, `bei` = Stelle in der Aufnahme); auch in der Session-Datei unter `gaps` |
| `eingang-spur-stumm` / `-wieder-da` / `-beendet` | Chromium stuft die Eingangsspur als stumm/weg ein (Gerät, Energiesparen, Datenschutz) |
| `audiokontext-suspended` / `-closed` | Der Audiokontext wurde angehalten |
| `geraete-geaendert` | Geräte eingesteckt/entfernt oder Standardgerät gewechselt (Eingang steht auf „Systemstandard“) |
| `oberflaeche-haengt` / `hauptprozess-haengt` | Der Zeitgeber der Oberfläche bzw. des Hauptprozesses blieb > 1 s aus: Rechner oder Fenster ausgelastet/gedrosselt. `waechterWartet: true` = der Wächter hat deshalb eine Runde ausgesetzt (siehe unten) |
| `hauptprozess-keine-bloecke` / `-bloecke-wieder-da` | Der Hauptprozess bekam 5 s lang keine Blöcke |
| `oberflaeche-beendet` | Die Oberfläche ist abgestürzt und wird neu geladen |
| `energie-suspend` / `-resume` / `-lock-screen` … | Ruhezustand, Sperrbildschirm, Netz/Akku |

So liest man es: `eingang-spur-stumm` oder `geraete-geaendert` kurz vor dem Aussetzer → Gerät bzw. Windows-Ton;
`oberflaeche-haengt`/`hauptprozess-haengt` zur selben Zeit → Rechner ausgelastet; `energie-*` → Ruhezustand;
nichts davon, nur `luecke-*` bei laufender Spur → Treiber/Gerät liefert zu spät.
Bekannte Ursache: Chromium drosselte Ebbton im Hintergrund (minimiert/verdeckt, ab etwa 5 min) so stark, dass die
Audioblöcke nur noch stoßweise ankamen und der Wächter neu verband. Seit Oktober 2026 läuft Ebbton deshalb ohne
Hintergrund-Drosselung. Viele `oberflaeche-haengt`-Zeilen mit `"sichtbar":"hidden"` deuten darauf, dass das nicht greift.
Unter Windows fehlten trotzdem noch etwa 1–1,5 % Audio, solange Ebbton minimiert oder verdeckt war: Windows 11 gibt
solchen Programmen keine feine Timer-Auflösung mehr. Ebbton nimmt seine Oberfläche deshalb beim Start davon aus;
im Protokoll steht dann `timer-regel-ausgenommen` (bei Erfolg mit `control=0x4 state=0x0`, dazu `weg` und `dauerMs`:
`zwischenspeicher` = Hilfsklasse aus `cache/EbbtonTimerRes-….dll` geladen, `neu-uebersetzt` = einmalig übersetzt und
abgelegt, `speicher` = Ablegen ging nicht, jedes Mal neu übersetzt). Steht dort
`timer-regel-fehlgeschlagen`, erscheint auch eine Warnung – dann Ebbton während der Aufnahme sichtbar lassen, am
einfachsten als Mini-Fenster mit „immer oben“.
Hing die Oberfläche (`oberflaeche-haengt`), verbindet der Wächter in dieser Runde nicht neu: Die Erfassung lief im
eigenen Thread weiter, ihre Blöcke kommen gleich nach – Neuverbinden würde sie verwerfen. Folgt trotzdem
`wiederverbinden-start`, war der Eingang wirklich weg.
Der Dialog öffnet sich dann nicht von selbst, die Knöpfe sind mit Hinweis gesperrt.

### Neue Version veröffentlichen

1. Im Ordner `app/` die Version erhöhen: `npm version patch --no-git-tag-version`
   (oder `minor` / `major`). Weil das Git-Repository eine Ebene höher liegt, legt
   `npm version` dort keinen Tag an.
2. Änderung committen und den Tag selbst setzen – er muss zur Version in
   `package.json` passen, denn veröffentlicht wird unter dieser Version:
   `git tag v1.2.3` und `git push --tags`.
3. Der Workflow `.github/workflows/release.yml` prüft, ob Tag und Version
   übereinstimmen, lässt die Tests laufen, legt einen Release-Entwurf an, baut
   die Windows-Version hinein und gibt das Release erst frei, wenn sie vollständig ist.
   Als Versionshinweise trägt er die Commit-Titel seit dem vorigen Release ein; die App
   zeigt sie im Update-Dialog unter „Was ist neu?“.
   **Mac-Releases sind vorerst abgeschaltet.** Wieder einschalten: auf GitHub unter
   *Settings → Secrets and variables → Actions → Variables* die Variable `MAC_RELEASE`
   mit dem Wert `true` anlegen; dann baut der Workflow auch die Mac-Version (ohne
   Zertifikat ad hoc signiert) und wartet mit der Freigabe auf beide. Ohne Mac-Release
   meldet eine installierte Mac-App bei „Jetzt nach Update suchen“ einen Fehler
   (`latest-mac.yml` fehlt); neue Mac-Versionen lokal mit `npm run dist:mac` bauen.

Der Windows-Installer lässt sich auf einem Mac mit Apple Silicon nur mit Rosetta
bauen (das NSIS-Werkzeug von electron-builder ist ein Intel-Programm); verlässlich
entsteht er im Workflow auf einem Windows-Rechner.

Da das Repository öffentlich ist, braucht niemand ein Zugriffstoken, um Updates
herunterzuladen – `electron-updater` liest öffentliche Releases ohne Anmeldung.
Ein `GH_TOKEN` ist nur beim Veröffentlichen selbst nötig (siehe oben), nicht
beim Herunterladen auf den Aufnahmerechnern.

## Besonderheiten unter macOS

Die App läuft auf macOS 13 (Ventura) und neuer (Vorgabe von Electron 45), sowohl auf Intel als auch auf Apple
Silicon. Ein paar Dinge unterscheiden sich:

- **Mikrofonfreigabe.** Beim ersten Start fragt macOS nach dem Zugriff auf den
  Audioeingang. Wird das abgelehnt, nimmt die App nichts auf. Nachträglich
  freigeben unter *Systemeinstellungen → Datenschutz & Sicherheit → Mikrofon*.
- **Menüleiste.** Oben am Bildschirm liegt ein Menü mit den üblichen Kürzeln.
  Aufnahme starten und beenden geht dort mit `Cmd` + `R`, Abschnitt starten/beenden
  mit `Cmd` + `M`, der nächste Ablaufpunkt mit `Cmd` + `Alt` + `N`, Rückgängig mit
  `Cmd` + `Z`. Die Kürzel aus dem Fenster (`M`, `N`, `X`, Leertaste) funktionieren
  weiterhin.
- **Beenden mit `Cmd` + `Q`** fragt nach, solange eine Aufnahme läuft.

### Signierung und Notarisierung

Ohne Apple-Entwicklerzertifikat (99 $ im Jahr) lässt sich die App zwar bauen und
benutzen – beim ersten Öffnen blockiert Gatekeeper sie aber. Seit macOS 15 hilft
der frühere Rechtsklick → *Öffnen* nicht mehr: Nach dem ersten Startversuch unter
*Systemeinstellungen → Datenschutz & Sicherheit* auf **„Dennoch öffnen“** klicken.
Meldet macOS die App als „beschädigt“, entfernt
`xattr -dr com.apple.quarantine /Applications/Ebbton.app` die Sperre.

**Wichtig:** Die automatische Update-Funktion arbeitet auf macOS ausschließlich
mit signierten Apps. Ohne Zertifikat muss jede neue Version von Hand installiert
werden; unter Windows bleiben die Updates davon unberührt.

Sobald ein Zertifikat vorliegt, sind nur zwei Schritte nötig:

1. In `package.json` unter `build.mac` `"notarize"` auf `true` setzen.
2. Im GitHub-Repository diese Secrets hinterlegen – der Workflow nutzt sie
   automatisch:

   | Secret | Inhalt |
   |---|---|
   | `MAC_CERT_P12` | Zertifikat als Base64-kodierte .p12-Datei |
   | `MAC_CERT_PASSWORD` | Passwort der .p12-Datei |
   | `APPLE_ID` | Apple-ID des Entwicklerkontos |
   | `APPLE_APP_PASSWORD` | app-spezifisches Passwort |
   | `APPLE_TEAM_ID` | Team-ID aus dem Entwicklerportal |

Die Rechte für Mikrofon und Netzwerk stehen bereits
in `build/entitlements.mac.plist`.

## Aufbau des Projekts

```
src/main/        Hauptprozess
  main.js        Fenster, IPC, Verdrahtung
  session.js     Zustand, Abschnitte, Aufnahme/Fortsetzen, Autosave
  wav.js         WAV/RF64 schreiben (eigener Thread), lesen, Cue-Marker (Abschnitte) eintragen
  mp3.js         MP3-Export eines Abschnitts (LAME als WebAssembly)
  mp3pool.js     mehrere MP3-Exporte gleichzeitig in eigenen Threads
  loudness.js    Lautheit messen (LUFS) und Spitzen begrenzen für den Export
  id3.js         ID3-Tags (Titel, Interpret, Album, Jahr)
  churchtools.js ChurchTools-API
  netserver.js   WebSocket-Schnittstelle
  updater.js     Updates über GitHub Releases
  inputlog.js    Eingangsprotokoll (logs/eingang.log, siehe „Eingangsprotokoll“)
  deficit.js     Fehlbetrag der Stereo-Aufnahme gegen die Uhr (leiser Verlust)
  timerres.js    Windows: Oberfläche von der Timer-Regel für Hintergrundfenster ausnehmen
  settings.js    Einstellungen, Token-Verschlüsselung
  multitrack/    Mehrspuraufnahme
    engine.js    Gerät öffnen (audify/ASIO), Pegel, Aussetzer erkennen, Gerät neu öffnen
    writer.js    eine 24-Bit-Mono-WAV je Spur
    simulator.js nachgebautes 32-Kanal-Pult für Entwicklung und Tests
    player.js    Zurückspielen: Spuren lesen, Ausgabeblöcke für alle Ausgänge, Springen, Schleife
    host.js      Einstieg des eigenen Mehrspur-Prozesses (Electron utilityProcess)
    manager.js   Hauptprozess-Seite: startet den Prozess, Befehle und Ereignisse
    probe.js     Technik-Test (siehe unten)
  mixer/         Verbindung zum Mischpult (M32, OSC, nur lesend)
    osc.js       OSC kodieren/lesen
    m32.js       Adressen, Farben, Routing-Werte und -Bewertung des M32
    client.js    Verbindung (Namen, Farben, Routing, /xremote), Pultsuche
    simulator.js nachgebautes M32 für Entwicklung und Tests
    link.js      Verbindung passend zu den Einstellungen, Routing-Prüfung
src/shared/      Von Hauptprozess und Oberfläche gemeinsam genutzt
  sections.js    Regeln für Abschnitte (Verschieben ohne Überlappung)
  roles.js       Zuordnung Dienst (ChurchTools) zu Programmpunkt
  loudness-curve.js  Lautheitskurve: Momentary, Short-term, integriert aus 100-ms-Werten
src/preload.js   Brücke zur Oberfläche
src/status/      Statusseite für Handy/Tablet (vom Netzwerkserver ausgeliefert)
src/renderer/    Oberfläche
  capture.js     Audioerfassung (AudioWorklet)
  monitor.js     Mithören der laufenden Aufnahme
  waveform.js    Wellenform und Abschnittsmarken
  app.js         Bedienlogik
```

Audio wird in der Oberfläche erfasst, als Int16-Blöcke an den Hauptprozess
übergeben und von einem eigenen Schreib-Thread auf die Festplatte geschrieben (ein
langsames Laufwerk bremst so nie die Aufnahme; alle 10 Sekunden werden die Daten fest
auf die Platte gezwungen). Ab 4 GB (gut 6 Stunden) wird die Datei im laufenden Betrieb
zu **RF64**, der WAV-Erweiterung für große Dateien – es bleibt eine Datei, die gängige
Programme (Audacity, VLC, Reaper …) öffnen. Der Hauptprozess
berechnet Pegel und Wellenform-Spitzenwerte und führt die einzige gültige
Version des Zustands – Oberfläche, Netzwerk und Companion sehen alle dasselbe.

### Mehrspuraufnahme (am echten Pult noch ungeprüft)

Für Aufnahmen aller 32 Kanäle des Midas M32 (DN32-USB-Karte, ASIO) gibt es einen eigenen Aufnahmeweg:
Ein eigener Prozess öffnet das Gerät über `audify` (RtAudio; unter Windows ASIO) und schreibt je
Kanal eine 24-Bit-Mono-WAV. Die Oberfläche erfasst dabei nichts selbst.
Stürzt dieser Prozess während der Aufnahme ab, startet Ebbton ihn neu und schreibt in dieselben Spuren weiter;
es fehlt nur die Zeit dazwischen (Meldung mit Stelle und Länge). Gelingt das etwa 50 s lang nicht, wird die Aufnahme beendet.

**Bedienung:** Die Aufnahmeart wird unter *Einstellungen → Audio → Aufnahmeart* gewählt (oder per Companion); im
Normalfall Stereo. Ist Mehrspur eingestellt, steht oben rechts ein farbiges Schild **„● Mehrspur“** – ein Klick darauf
öffnet die Einstellung. Im Mehrspur-Modus steht rechts der Bereich **Kanäle** statt „Jetzt“ (es gibt keinen MP3-Export): alle Kanäle mit
Name und Farbe vom Pult und Pegel – schon vor dem Start, denn das Gerät ist im Mehrspur-Modus ständig offen.
Ein Klick auf einen Kanal wählt ihn für die nächste Aufnahme ab bzw. wieder an (durchgestrichen = wird nicht
aufgenommen), „Alle“ und „Nur benannte“ (Kanäle mit Namen am Pult) wählen schnell aus. Rot umrandet = übersteuert,
gelb umrandet = seit über 20 s still während der Aufnahme (die Namen stehen auch oben im Bereich). Darüber stehen
Gerät, Abtastrate, Zahl der gewählten Kanäle und der Platz in Stunden; fehlt das Gerät (Pult aus), versucht
Ebbton es alle 10 s erneut. Der große Pegel zeigt den lautesten gewählten Kanal.
Gerät wählen unter *Einstellungen → Mehrspur & Pult* („Geräte suchen“ fragt die Geräte ab, unter Windows die
ASIO-Treiber; nur außerhalb einer Aufnahme) oder „Automatisch“ (Gerät mit den meisten Eingängen). „Simuliertes
Pult“ (zugeklappt unter „Zum Testen ohne Mischpult“) nimmt ein nachgebautes 32-Kanal-Pult auf (zum Ausprobieren). Aufnehmen wie gewohnt: Start, Pause, Abschnitte,
Beenden, „An Aufnahme anhängen“, auch per Companion. Am Mischpult müssen die USB-Ausgänge dafür auf den Kanälen
1–32 liegen. Die Spuren landen je Aufnahme in einem Unterordner des Mehrspur-Ordners (*Ablage & Export*, sonst
`Mehrspur` im Aufnahmeordner), zusammen mit der Session-Datei; die Liste „Aufnahmen“ zeigt sie mit an.
MP3-Export, Mithören während der Aufnahme und Cue-Marker gibt es bei Mehrspuraufnahmen nicht; das Mini-Fenster
zeigt nach dem Beenden nur „Mehrspur: n Spuren gespeichert“.

**Zurückspielen zum Pult** (virtueller Soundcheck, Nachmischen): Bei einer beendeten Mehrspuraufnahme (Aufnahmeart
Mehrspur; bei Aufnahmeart Stereo ist der Knopf gesperrt) spielt
„Zum Pult abspielen“ (oder die Leertaste) die Spuren über die USB-Ausgänge – Spur von Kanal 5 auf USB-Ausgang 5 –,
ab der Marke in der Wellenform. Klick in die Wellenform springt, Klick auf einen Abschnitt springt an dessen Anfang;
mit „Schleife“ wird der gewählte Abschnitt (sonst die ganze Aufnahme) wiederholt. Im Kanal-Bereich steht die
Position. Am Mischpult müssen die Kanäle dafür die USB-Karte als Quelle haben – das stellt Ebbton bewusst nicht
selbst um. Eine neue Aufnahme beendet das Abspielen.

**Mischpult (Einstellungen → Mehrspur & Pult):** IP des M32 eintragen oder „Pult im Netz suchen“.
Ebbton liest dann per OSC – nur lesend – die Kanalnamen und -farben (die Spuren heißen wie am Pult,
z. B. `01_Predigt.wav`; ist das Pult nicht erreichbar, „Kanal 1“ …) und das Routing der USB-Kartenausgänge. Passt
das Routing nicht zur Aufnahmeart (Mehrspur eingestellt, aber Matrix auf USB 1–2, oder umgekehrt), erscheint ein
Warnbalken, auch vor dem Start, und Companion sieht `health.routing = mismatch`. Am zuverlässigsten wird die Prüfung,
wenn man beide Routings einmal anlernt: am Pult Stereo einstellen → „Als Stereo merken“, Mehrspur einstellen →
„Als Mehrspur merken“. Ohne Anlernen gilt die Faustregel „Ausgänge des Pults auf USB 1–8 = Stereo, Eingänge = Mehrspur“.
Mit „Simuliertes Pult“ (Audio) und ohne IP läuft ein eingebauter Pult-Simulator mit Beispielnamen; dessen Routing
lässt sich zum Ausprobieren der Warnung umschalten.

**Technik-Test**, läuft statt der App und prüft Gerät, Prozess und Schreiben – auch mit der installierten App:

```
EBBTON_MT_PROBE=list      Geräte auflisten
EBBTON_MT_PROBE=auto      Gerät mit den meisten Eingängen 10 s aufnehmen
EBBTON_MT_PROBE=<id>      dieses Gerät aufnehmen
EBBTON_MT_PROBE=simulate  simuliertes 32-Kanal-Pult aufnehmen
EBBTON_MT_SECONDS=30      Dauer ändern
```

Windows (Eingabeaufforderung): `set EBBTON_MT_PROBE=auto` und danach
`"%LOCALAPPDATA%\Programs\Ebbton\Ebbton.exe"` bzw. im Ordner `app/` `npx electron .`;
macOS/Entwicklung: `EBBTON_MT_PROBE=auto npx electron .`. Ergebnis als Dialog und in
`logs/mt-probe.log` im Einstellungsordner; die Testaufnahme bleibt im Temp-Ordner (Pfad im Protokoll).

Tests: `npm test` im Ordner `app/` (Node-Testrunner, ohne Electron). Sie liegen in `test/` und
laufen bei jedem Push automatisch auf Windows und macOS (`.github/workflows/test.yml`).

## Sicherheitshinweis

Die Netzwerkschnittstelle ist für ein vertrauenswürdiges lokales Netz gedacht.
Die Verbindung ist unverschlüsselt; das Passwort verhindert versehentlichen
Zugriff, schützt aber nicht gegen einen Angreifer im selben Netz. Zusätzlich:
Webseiten im Browser dürfen nur mitlesen, nach 5 Fehlversuchen wird eine Adresse
für eine Minute gesperrt, und mit dem Mitlese-Passwort sind weder Dateipfade noch
Personennamen zu sehen.
