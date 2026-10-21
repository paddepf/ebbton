/* Windows 11: Ausnahme von der Timer-Regel für die Oberfläche.

   Windows gewährt Programmen, die minimiert, ganz verdeckt oder unhörbar sind, keine feine Timer-Auflösung mehr.
   Chromium nimmt seinen GPU- und Audio-Prozess davon aus, den Renderer nicht – dort läuft aber unsere Audioerfassung.
   Folge am Kirchen-PC: Im Hintergrund fehlten leise 1–1,5 % der Aufnahme. Mit derselben Ausnahme für den Renderer
   (PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION in der ControlMask, StateMask 0 = „nicht ignorieren“) fehlte
   nichts mehr (Test vom 2026-10-11, siehe CLAUDE.md).

   Node kann `SetProcessInformation` nicht selbst aufrufen; ohne zusätzliche native Abhängigkeit geht es über
   PowerShell mit einer kleinen C#-Hilfsklasse. Läuft asynchron in eigenem Prozess, blockiert also nichts.

   Das Übersetzen der Klasse (Add-Type ruft den C#-Compiler) kostete am Kirchen-PC beim ersten Aufruf etwa 18 s; so
   lange war die Oberfläche nach dem Start ungeschützt. Deshalb wird die Klasse einmal als DLL in `cacheDir`
   übersetzt und danach nur noch geladen. Der Dateiname enthält eine Prüfsumme des Quelltexts, eine geänderte Klasse
   wird also neu übersetzt. Klappt das Zwischenspeichern nicht, wird wie früher im Speicher übersetzt. */

'use strict';

const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');

const CSHARP = `
using System;
using System.Runtime.InteropServices;
public static class EbbtonTimerRes {
  [StructLayout(LayoutKind.Sequential)]
  public struct State { public uint Version; public uint ControlMask; public uint StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetProcessInformation(IntPtr h, int cls, ref State s, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr h, int cls, ref State s, uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  public static string Apply(uint pid) {
    // PROCESS_SET_INFORMATION | PROCESS_QUERY_LIMITED_INFORMATION; Klasse 4 = ProcessPowerThrottling
    IntPtr h = OpenProcess(0x0200 | 0x1000, false, pid);
    if (h == IntPtr.Zero) return "fehler open " + Marshal.GetLastWin32Error();
    try {
      State s = new State { Version = 1, ControlMask = 4, StateMask = 0 };
      if (!SetProcessInformation(h, 4, ref s, (uint)Marshal.SizeOf(s))) return "fehler set " + Marshal.GetLastWin32Error();
      State r = new State { Version = 1 };
      if (!GetProcessInformation(h, 4, ref r, (uint)Marshal.SizeOf(r))) return "ok";
      return "ok control=0x" + r.ControlMask.ToString("x") + " state=0x" + r.StateMask.ToString("x");
    } finally { CloseHandle(h); }
  }
}`;

/** Pfad der zwischengespeicherten DLL (Prüfsumme des Quelltexts im Namen). */
function cachedAssemblyPath(cacheDir) {
  const hash = crypto.createHash('sha1').update(CSHARP).digest('hex').slice(0, 10);
  return path.join(cacheDir, `EbbtonTimerRes-${hash}.dll`);
}

/** Text als PowerShell-Zeichenkette in einfachen Anführungszeichen. */
const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;

/**
 * PowerShell-Befehl für eine PID, als `-EncodedCommand` (UTF-16LE, Base64) – keine Probleme mit Anführungszeichen.
 * Mit `dll`: zwischengespeicherte Klasse laden, fehlt sie, übersetzen und ablegen; Ausgabe endet mit `weg=…`
 * (zwischenspeicher / neu-uebersetzt / speicher).
 */
function encodedCommand(pid, dll) {
  const apply = `[EbbtonTimerRes]::Apply(${Number(pid) >>> 0})`;
  const script = !dll
    ? `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CSHARP}\n'@\n${apply}`
    : [
      `$ErrorActionPreference = 'Stop'`,
      `$quelle = @'\n${CSHARP}\n'@`,
      `$dll = ${psQuote(dll)}`,
      `$weg = 'zwischenspeicher'`,
      `try { Add-Type -Path $dll } catch {`,
      `  $weg = 'neu-uebersetzt'`,
      `  $tmp = $dll + '.' + $PID + '.tmp.dll'`,
      `  try {`,
      `    New-Item -ItemType Directory -Force -Path (Split-Path $dll) | Out-Null`,
      `    Add-Type -TypeDefinition $quelle -OutputAssembly $tmp`,
      `    Move-Item -Force $tmp $dll`,
      `    if (-not ('EbbtonTimerRes' -as [type])) { Add-Type -Path $dll }`,
      `  } catch {`,
      `    $weg = 'speicher'`,
      `    if (-not ('EbbtonTimerRes' -as [type])) { Add-Type -TypeDefinition $quelle }`,
      `  } finally { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }`,
      `}`,
      `${apply} + ' weg=' + $weg`
    ].join('\n');
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir;
  return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/**
 * Nimmt den Prozess `pid` von der Timer-Regel aus (nur Windows).
 * @param {string} [opts.cacheDir] Ordner für die übersetzte Hilfsklasse (sonst jedes Mal neu übersetzen)
 * @returns {Promise<{ok: boolean, skipped?: boolean, detail: string, ms?: number}>} lehnt nie ab
 */
function exemptFromTimerThrottling(pid, { platform = process.platform, run = execFile, cacheDir = null } = {}) {
  if (platform !== 'win32') return Promise.resolve({ ok: false, skipped: true, detail: 'nur Windows' });
  if (!(Number(pid) > 0)) return Promise.resolve({ ok: false, detail: 'keine PID' });
  const started = Date.now();
  const dll = cacheDir ? cachedAssemblyPath(cacheDir) : null;
  return new Promise((resolve) => {
    run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(pid, dll)],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        const ms = Date.now() - started;
        if (err || !out.startsWith('ok')) {
          resolve({ ok: false, detail: out || String(stderr || '').trim().slice(0, 300) || String(err && err.message || err), ms });
        } else {
          resolve({ ok: true, detail: out, ms });
        }
      });
  });
}

module.exports = { exemptFromTimerThrottling, encodedCommand, cachedAssemblyPath };
