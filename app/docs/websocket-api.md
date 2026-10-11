# Netzwerkschnittstelle

Der Ebbton stellt im lokalen Netzwerk einen WebSocket-Server bereit.
Darüber lässt sich der Aufnahmestatus mitlesen (Dashboard) und die Aufnahme
steuern (Bitfocus Companion).

- Adresse: `ws://<rechner>:<port>/` – Standardport **8765**
- Zusätzlich: `GET http://<rechner>:<port>/health` liefert ohne Anmeldung
  `{"app":"ebbton","protocol":1,"status":"recording"}` –
  praktisch für eine einfache Erreichbarkeitsprüfung im Dashboard.
- `GET http://<rechner>:<port>/` liefert eine fertige **Statusseite** für Handy und Tablet (`/status.js`,
  `/status.css`). Sie meldet sich selbst per WebSocket an und bekommt als Webseite nur die Rolle `monitor`.
- Alle Nachrichten sind JSON-Objekte mit einem Feld `type`.

## Anmeldung

Jede Verbindung muss sich innerhalb von 10 Sekunden anmelden, sonst wird sie
getrennt. Es gibt zwei Rollen:

| Rolle | Passwort aus | Rechte |
|---|---|---|
| `control` | „Passwort für Steuerung“ | mitlesen und steuern |
| `monitor` | „Passwort nur zum Mitlesen“ | nur mitlesen |

Ist kein Monitor-Passwort gesetzt, existiert die Rolle nicht.

- **Browser** (Verbindungen mit `Origin`-Header, also Webseiten) erhalten immer nur die Rolle `monitor`, auch
  mit dem Steuer-Passwort – eine fremde Webseite soll den Recorder nicht steuern können. Companion und eigene
  Programme senden keinen `Origin`-Header.
- Nach **5 Fehlversuchen** von derselben Adresse ist die Anmeldung dort 60 Sekunden gesperrt
  (Fehler `auth_locked`).
- Die Rolle `monitor` bekommt den Zustand **ohne Dateipfade und Personennamen** (`wavPath`, `artist`,
  `service.suggestions` und die Dateinamen in `exports` fehlen). Auch in Ereignissen fehlen für sie
  `wavPath` und `file`.

```json
{ "type": "auth", "password": "geheim" }
```

Alternativ als Query-Parameter: `ws://host:8765/?password=geheim&role=monitor`

Antwort:

```json
{ "type": "auth", "ok": true, "role": "control" }
```

Wer sich mit dem Steuer-Passwort anmeldet, kann sich mit `"role": "monitor"`
freiwillig auf Mitlesen beschränken.

## Nachrichten vom Recorder

### `state` – vollständiger Zustand

Wird direkt nach der Anmeldung und bei jeder Änderung gesendet (max. 10×/s).

```json
{
  "type": "state",
  "payload": {
    "status": "recording",
    "service": {
      "id": 4711, "name": "Sonntagsgottesdienst", "date": "2026-09-06",
      "suggestions": [ { "role": "Predigt", "name": "Ben Muster" } ]
    },
    "duration": 1832.4,
    "startedAt": "2026-09-06T09:30:02.000Z",
    "sampleRate": 48000,
    "channels": 2,
    "levels": { "l": 0.42, "r": 0.39, "clip": false },
    "mode": "stereo",
    "recordingMode": "stereo",
    "tracks": [],
    "sections": [
      { "id": "sec_x1", "label": "Predigt", "category": "Verkündigung", "color": 2,
        "start": 1420.5, "end": null, "source": "churchtools" },
      { "id": "sec_x2", "label": "Segen", "color": 3,
        "start": null, "end": null, "source": "churchtools" }
    ],
    "pending": [
      { "id": "sec_x2", "label": "Segen", "start": null, "end": null, "source": "churchtools" }
    ],
    "segments": [
      { "id": "seg_sec_x1", "label": "Predigt", "start": 1420.5, "end": 1832.4, "markerId": "sec_x1", "open": true }
    ],
    "currentSegment": { "id": "seg_sec_x1", "label": "Predigt", "start": 1420.5, "end": 1832.4, "open": true },
    "cuts": [ { "id": "cut_x1", "start": 1500.0, "end": 1512.5 } ],
    "wavPath": "C:\\Aufnahmen\\2026-09-06_0930_Sonntagsgottesdienst.wav",
    "health": {
      "input": "ok",
      "write": "ok",
      "writeMessage": null,
      "routing": "ok",
      "deficit": null,
      "disk": { "freeBytes": 52000000000, "hoursLeft": 75.2, "level": "ok" }
    }
  }
}
```

`cuts` sind Stellen, die beim MP3-Export ausgelassen werden (`end` ist `null`, solange ein
Schnitt läuft). `health.input` ist `ok`, `silent` (seit über 20 s kaum Pegel) oder `lost`
(Eingang ausgefallen, wird neu verbunden); `health.write` ist `ok`, `slow` (Laufwerk kommt nicht
hinterher, Audio wird gepuffert) oder `error` (Schreibfehler, z. B. Platte voll – Text in `writeMessage`);
`health.routing` sagt, ob das Routing der USB-Ausgänge am Mischpult zur Aufnahmeart passt: `ok`, `mismatch`
(z. B. Mehrspur eingestellt, Pult liefert aber die Stereo-Matrix), `unknown` (Pult nicht erreichbar oder Routing
nicht eindeutig) oder `null` (keine Pult-Verbindung eingerichtet).
`health.deficit` ist während einer Stereo-Aufnahme die Zahl der Sekunden (in halben Sekunden), die der Aufnahme
gegenüber der Uhr fehlen, sobald es mindestens 2 s sind – Audio geht dann leise verloren; sonst `null`.
`health.disk.level` ist `ok`, `warn` (unter
3 Stunden Platz) oder `low` (unter 30 Minuten). `health` ändert sich unabhängig von der
Aufnahme; der Speicherwert wird alle 30 Sekunden erneuert. Während einer Aufnahme kommt der Zustand
zusätzlich alle 5 Sekunden, auch ohne Änderung.

`status` ist einer von `idle`, `recording`, `paused`, `stopped`.
Alle Zeitangaben sind Sekunden seit Aufnahmebeginn.

`mode` ist die Art der angezeigten Aufnahme, `recordingMode` die gerade gültige Aufnahmeart (während einer
Aufnahme deren Art, sonst die eingestellte – das, was die nächste Aufnahme wird). Beide sind `stereo` oder
`multitrack` (Mehrspuraufnahme aller Kanäle des Mischpults). Bei
`multitrack` nennt `tracks` die aufgenommenen Kanäle (`[{ "channel": 0, "name": "Kanal 1" }, …]`, `channel`
0-basiert), `wavPath` ist `null`, `channels` die Zahl der Spuren und `levels` der Pegel des lautesten
aufgenommenen Kanals (in `l` und `r` gleich). `health.input` wird `lost`, wenn das Mischpult keine Daten mehr
liefert. Befehle und Ereignisse sind in beiden Modi gleich. Spuren tragen zusätzlich `color` (Kanalfarbe am Pult,
0–15 wie beim X32/M32, ab 8 invertiert; `null`, wenn das Pult nicht erreichbar war).

### `levels` – Pegel

Getrennt vom Zustand und auf 5×/s gedrosselt, damit das Netz nicht geflutet wird.

```json
{ "type": "levels", "payload": { "l": 0.42, "r": 0.39, "clip": false, "duration": 1832.4 } }
```

`l` und `r` sind Spitzenwerte von 0 bis 1. `clip` bleibt nach einer
Übersteuerung zwei Sekunden lang `true`.

Bei Stereo-Aufnahmen kommt zusätzlich die Lautheit nach EBU R128 mit (LUFS, auf 0,1 gerundet, `null` = Stille):

```json
"loudness": { "momentary": -18.2, "shortTerm": -19.5, "integrated": -20.1, "section": -19.8 }
```

`momentary` = letzte 0,4 s, `shortTerm` = letzte 3 s, `integrated` = ganze Aufnahme, `section` = laufender
Abschnitt (`null` ohne Abschnitt). Die integrierten Werte ändern sich höchstens einmal je Sekunde.

### `event` – Ereignisse

```json
{ "type": "event", "event": "recording.started", "payload": { "wavPath": "…" } }
```

| Ereignis | `payload` für `control` | für `monitor` |
|---|---|---|
| `recording.started` | `{ wavPath }` | `{}` |
| `recording.stopped` | `{ wavPath, duration }` | `{ duration }` |
| `export.finished` | `{ file, label }` | `{ label }` |

### Weitere

- `hello` – direkt beim Verbindungsaufbau, enthält `protocol`
- `pong` – Antwort auf `ping`
- `result` – Antwort auf einen Befehl
- `error` – mit `code` (`auth_failed`, `unauthorized`, `read_only`,
  `unknown_action`, `unknown_type`, `auth_timeout`, `auth_locked`, `bad_json`) und `message`.
  Nach `auth_failed` trennt der Recorder die Verbindung nach kurzer Zeit.

## Nachrichten an den Recorder

### `command` – nur mit Rolle `control`

```json
{ "type": "command", "id": 17, "action": "marker.add", "params": { "label": "Predigt" } }
```

| Aktion | Wirkung |
|---|---|
| `record.start` | Aufnahme starten – ohne Rückfrage am PC, auch wenn dort eine beendete Aufnahme angezeigt wird (sie bleibt gespeichert). In der Pause: fortsetzen. Läuft schon eine: `ok:false` |
| `record.stop` | Aufnahme beenden und speichern (auch eine pausierte); ohne laufende Aufnahme `ok:false` |
| `record.toggle` | Starten bzw. beenden – eine pausierte Aufnahme wird beendet |
| `record.pause` | Pausieren |
| `record.resume` | Fortsetzen |
| `marker.add` | Abschnitt beginnen (Anfangsmarke, optional `params.label`); läuft schon einer, wird er beendet (Endmarke) |
| `marker.next` | Laufenden Abschnitt beenden und den nächsten offenen Ablaufpunkt beginnen lassen |
| `cut.toggle` | Schnitt an der aktuellen Stelle beginnen bzw. beenden (nur während der Aufnahme); Antwort `change`: `started`, `ended` oder `discarded` |
| `undo` / `redo` | Letzte Änderung an Abschnitten oder Schnitten zurücknehmen bzw. wiederholen |
| `template.apply` | Vorlage für Programmpunkte laden: `params.name` (oder `params.id`), ohne Angabe die Standardvorlage; ersetzt die offenen Punkte |
| `mode.set` | Aufnahmeart für die nächste Aufnahme: `params.mode` `stereo`, `multitrack` oder `toggle`; Antwort enthält `mode`. Während einer Aufnahme `ok:false`. Das Routing am Pult stellt Ebbton dabei nicht um |

Antwort:

```json
{ "type": "result", "id": 17, "action": "marker.add", "ok": true, "change": "started", "section": { "…": "…" } }
```

`record.start`, `record.stop` und `record.toggle` antworten erst, wenn die Aufnahme tatsächlich läuft bzw.
beendet ist (`ok: true`). Scheitert der Start am Aufnahmerechner (z. B. Eingang nicht verfügbar) oder kommt
innerhalb von 8 Sekunden keine Rückmeldung, lautet die Antwort `ok: false` mit `error`.

`change` ist `started` oder `ended`, je nachdem, ob eine Anfangs- oder Endmarke gesetzt wurde.

Das mitgesendete `id`-Feld kommt unverändert zurück und dient der Zuordnung.

### Weitere

- `{ "type": "get_state", "id": 3 }` – Zustand erneut anfordern
- `{ "type": "ping", "id": 3 }` – Verbindungstest

## Beispiel: Dashboard-Anbindung

```js
const ws = new WebSocket('ws://recorder.local:8765/');

ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', password: 'mitlesen' }));

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'state') {
    render(msg.payload.status, msg.payload.currentSegment?.label, msg.payload.duration);
  }
  if (msg.type === 'levels') {
    setMeters(msg.payload.l, msg.payload.r, msg.payload.clip);
  }
};
```

## Hinweise für den Betrieb

- Der Server ist für ein vertrauenswürdiges lokales Netz gedacht. Die
  Verbindung ist unverschlüsselt (`ws://`), das Passwort schützt vor
  versehentlichem Zugriff, nicht vor einem Angreifer im selben Netz.
- Ohne gesetztes Steuer-Passwort startet der Server nicht.
- Die Windows-Firewall fragt beim ersten Start nach einer Freigabe für den Port.
