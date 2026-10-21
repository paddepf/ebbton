'use strict';

/* Echte settings.js mit nachgebautem Electron (app.getPath, safeStorage): Token-Verschlüsselung seit Electron 45. */

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebbton-settings-'));
const storage = {
  available: true,
  reEncrypt: false,
  async isAsyncEncryptionAvailable() { return this.available; },
  async encryptStringAsync(text) { return Buffer.from('X' + text, 'utf8'); },
  async decryptStringAsync(buf) {
    const s = buf.toString('utf8');
    if (!s.startsWith('X')) throw new Error('kaputt');
    return { result: s.slice(1), shouldReEncrypt: this.reEncrypt };
  }
};
const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return { app: { getPath: () => dir }, safeStorage: storage };
  return originalLoad.call(this, request, ...rest);
};
const settings = require('../src/main/settings');
const stored = () => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).churchToolsToken;

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('Token: verschlüsselt speichern und lesen', async () => {
  const enc = await settings.encryptSecret('geheim');
  assert.equal(enc, 'enc:' + Buffer.from('Xgeheim').toString('base64'));
  settings.save({ churchToolsToken: enc });
  assert.equal(await settings.churchToolsToken(), 'geheim');
  assert.equal(settings.forRenderer().encryptionAvailable, true);
  assert.equal(settings.forRenderer().churchToolsToken, undefined);
});

test('Token: shouldReEncrypt speichert neu verschlüsselt', async () => {
  settings.save({ churchToolsToken: 'enc:' + Buffer.from('Xalt').toString('base64') });
  storage.reEncrypt = true;
  let calls = 0;
  const orig = storage.encryptStringAsync;
  storage.encryptStringAsync = async (t) => { calls++; return Buffer.from('Xneu-' + t); };
  try {
    assert.equal(await settings.churchToolsToken(), 'alt');
    assert.equal(calls, 1);
    assert.equal(stored(), 'enc:' + Buffer.from('Xneu-alt').toString('base64'));
  } finally {
    storage.reEncrypt = false;
    storage.encryptStringAsync = orig;
  }
});

test('Token: ohne Verschlüsselung als Klartext, alte Formen bleiben lesbar, Fehler ergeben leer', async () => {
  storage.available = false;
  try {
    const plain = await settings.encryptSecret('offen');
    assert.equal(plain, 'plain:' + Buffer.from('offen').toString('base64'));
    assert.equal((await settings.decryptSecret(plain)).value, 'offen');
    assert.equal(settings.forRenderer().encryptionAvailable, false);
  } finally {
    storage.available = true;
  }
  assert.equal((await settings.decryptSecret('rohtoken')).value, 'rohtoken');
  assert.equal(await settings.encryptSecret(''), '');
  const orig = console.error;
  console.error = () => {};
  try {
    assert.equal((await settings.decryptSecret('enc:' + Buffer.from('falsch').toString('base64'))).value, '');
  } finally {
    console.error = orig;
  }
});
