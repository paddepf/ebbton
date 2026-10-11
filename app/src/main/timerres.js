/* Windows 11: Ausnahme von der Timer-Regel für die Oberfläche.

   Windows gewährt Programmen, die minimiert, ganz verdeckt oder unhörbar sind, keine feine Timer-Auflösung mehr.
   Chromium nimmt seinen GPU- und Audio-Prozess davon aus, den Renderer nicht – dort läuft aber unsere Audioerfassung.
   Folge am Kirchen-PC: Im Hintergrund fehlten leise 1–1,5 % der Aufnahme. Mit derselben Ausnahme für den Renderer
   (PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION in der ControlMask, StateMask 0 = „nicht ignorieren“) fehlte
   nichts mehr (Test vom 2026-10-11, siehe CLAUDE.md).

   Node kann `SetProcessInformation` nicht selbst aufrufen; ohne zusätzliche native Abhängigkeit geht es über
   PowerShell mit einer kleinen C#-Hilfsklasse. Läuft asynchron in eigenem Prozess, blockiert also nichts. */

'use strict';

const { execFile } = require('child_process');
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

/** PowerShell-Befehl für eine PID, als `-EncodedCommand` (UTF-16LE, Base64) – keine Probleme mit Anführungszeichen. */
function encodedCommand(pid) {
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CSHARP}\n'@\n[EbbtonTimerRes]::Apply(${Number(pid) >>> 0})`;
  return Buffer.from(script, 'utf16le').toString('base64');
}

function powershellPath() {
  const root = process.env.SystemRoot || process.env.windir;
  return root ? path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

/**
 * Nimmt den Prozess `pid` von der Timer-Regel aus (nur Windows).
 * @returns {Promise<{ok: boolean, skipped?: boolean, detail: string}>} lehnt nie ab
 */
function exemptFromTimerThrottling(pid, { platform = process.platform, run = execFile } = {}) {
  if (platform !== 'win32') return Promise.resolve({ ok: false, skipped: true, detail: 'nur Windows' });
  if (!(Number(pid) > 0)) return Promise.resolve({ ok: false, detail: 'keine PID' });
  return new Promise((resolve) => {
    run(powershellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(pid)],
      { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err || !out.startsWith('ok')) {
          resolve({ ok: false, detail: out || String(stderr || '').trim().slice(0, 300) || String(err && err.message || err) });
        } else {
          resolve({ ok: true, detail: out });
        }
      });
  });
}

module.exports = { exemptFromTimerThrottling, encodedCommand };
