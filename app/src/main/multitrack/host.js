'use strict';

/**
 * Einstieg des Mehrspur-Prozesses (Electron `utilityProcess`). Nimmt Befehle vom Hauptprozess
 * entgegen und reicht die Ereignisse der Engine zurück.
 *
 * Befehle: {id, cmd: 'devices'|'monitor'|'unmonitor'|'info'|'start'|'pause'|'resume'|'stop'|'play'|'seek'|'loop'|'stopPlayback', args} → Antwort {id, ok, result | error}.
 * Ereignisse: {event, data}.
 */

const { MultitrackEngine } = require('./engine');

const port = process.parentPort;
const engine = new MultitrackEngine();

const send = (msg) => port.postMessage(msg);

for (const ev of ['levels', 'stall', 'gap', 'reopen', 'device-error', 'device-warning', 'write-error', 'slow', 'playback']) {
  engine.on(ev, (data) => send({ event: ev, data }));
}

const commands = {
  devices: (args) => engine.devices(args || {}),
  monitor: (args) => engine.monitor(args),
  unmonitor: () => engine.unmonitor(),
  start: (args) => engine.start(args),
  play: (args) => engine.play(args),
  seek: (args) => engine.seek(args.seconds),
  loop: (args) => engine.setLoop(args.loop),
  stopPlayback: () => engine.stopPlayback(),
  pause: () => engine.pause(),
  resume: () => engine.resume(),
  stop: () => engine.stop()
};

port.on('message', async ({ data }) => {
  const { id, cmd, args } = data || {};
  try {
    if (!commands[cmd]) throw new Error(`Unbekannter Befehl: ${cmd}`);
    send({ id, ok: true, result: await commands[cmd](args) });
  } catch (err) {
    send({ id, ok: false, error: err.message });
  }
});

process.on('uncaughtException', (err) => send({ event: 'device-error', data: { type: 'exception', message: err.message } }));

send({ event: 'ready', data: { pid: process.pid } });
