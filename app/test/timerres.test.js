'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { exemptFromTimerThrottling, encodedCommand } = require('../src/main/timerres');

const decode = (b64) => Buffer.from(b64, 'base64').toString('utf16le');

test('Timer-Regel: außerhalb von Windows passiert nichts', async () => {
  let called = false;
  const r = await exemptFromTimerThrottling(1234, { platform: 'darwin', run: () => { called = true; } });
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(called, false);
});

test('Timer-Regel: PowerShell-Skript mit Here-String und PID, ohne Skriptdatei', async () => {
  let args = null;
  const r = await exemptFromTimerThrottling(4321, {
    platform: 'win32',
    run: (_exe, a, _opts, cb) => { args = a; cb(null, 'ok control=0x4 state=0x0\r\n', ''); }
  });
  assert.deepStrictEqual(r, { ok: true, detail: 'ok control=0x4 state=0x0' });
  assert.ok(!args.includes('-File'));
  const script = decode(args[args.indexOf('-EncodedCommand') + 1]);
  assert.match(script, /Add-Type -TypeDefinition @'\n/);
  assert.match(script, /\n'@\n/);                       // Ende des Here-Strings am Zeilenanfang
  assert.match(script, /\[EbbtonTimerRes\]::Apply\(4321\)$/);
  assert.match(script, /ControlMask = 4, StateMask = 0/);
});

test('Timer-Regel: Fehler werden gemeldet, nie geworfen', async () => {
  const failed = await exemptFromTimerThrottling(5, { platform: 'win32', run: (_e, _a, _o, cb) => cb(null, 'fehler set 87', '') });
  assert.strictEqual(failed.ok, false);
  assert.strictEqual(failed.detail, 'fehler set 87');
  const crashed = await exemptFromTimerThrottling(5, { platform: 'win32', run: (_e, _a, _o, cb) => cb(new Error('ENOENT'), '', '') });
  assert.strictEqual(crashed.ok, false);
  assert.match(crashed.detail, /ENOENT/);
  const noPid = await exemptFromTimerThrottling(0, { platform: 'win32', run: () => assert.fail('nicht aufrufen') });
  assert.strictEqual(noPid.ok, false);
});

test('Timer-Regel: PID wird als Zahl eingesetzt (kein Text aus fremder Quelle im Skript)', () => {
  assert.match(decode(encodedCommand('12; Remove-Item x')), /Apply\(0\)$/);
});
