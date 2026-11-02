/**
 * Builds the Pi extension that adds the `computer` tool.
 *
 * The tool runs in the Pi process, not in Electron, so it drives the desktop
 * through a short-lived PowerShell helper. Coordinates are pixels of the
 * latest screenshot: the helper owns the virtual-screen origin and the scale,
 * and the model must not copy window bounds into a click.
 */
export function computerUseExtension(): string {
  return `import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';

const SCRIPT = ${JSON.stringify(DESKTOP_SCRIPT)};

let frame;

function fail(action, message) {
  return { content: [{ type: 'text', text: message }], details: { action }, isError: true };
}

function toScreen(x, y) {
  if (!frame) throw new Error('Call screenshot before using coordinates');
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error('x and y must be pixels in the latest screenshot');
  }
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || iy < 0 || ix >= frame.width || iy >= frame.height) {
    throw new Error('Coordinates are outside the latest screenshot (' + frame.width + 'x' + frame.height + ')');
  }
  return {
    x: Math.round(frame.originX + ix / frame.scale),
    y: Math.round(frame.originY + iy / frame.scale)
  };
}

function desktop(request, signal) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Computer Use currently supports Windows only'));
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new Error('Computer Use was aborted'));
      return;
    }
    // -Command - does not reliably read the helper from stdin on Windows
    // PowerShell, so the script is a file this call owns and deletes.
    const dir = mkdtempSync(join(tmpdir(), 'pi-computer-'));
    const file = join(dir, 'computer.ps1');
    writeFileSync(file, SCRIPT, 'utf8');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, COMPUTER_USE_REQUEST: JSON.stringify(request) }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', kill);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      if (error) reject(error);
      else resolve(value);
    };
    const kill = () => { try { child.kill(); } catch {} };
    const timer = setTimeout(kill, 20000);
    if (signal) signal.addEventListener('abort', kill, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 8000000) kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    child.on('error', (error) => finish(error));
    child.on('close', () => {
      if (signal && signal.aborted) {
        finish(new Error('Computer Use was aborted'));
        return;
      }
      const line = stdout.replace(/^\\uFEFF/, '').split(/\\r?\\n/).map((item) => item.trim()).filter((item) => item.startsWith('{')).pop();
      if (!line) {
        finish(new Error((stderr || stdout).trim() || 'Computer Use produced no result'));
        return;
      }
      try { finish(undefined, JSON.parse(line)); }
      catch (error) { finish(error); }
    });
  });
}

export default function (pi) {
  pi.registerTool({
    name: 'computer',
    label: 'Computer',
    description: 'Observe and operate the Windows desktop. screenshot returns an image; x and y for later actions are pixels in that image, origin top-left, and are invalid until a screenshot exists. list_windows names visible windows but its bounds are not click coordinates. click takes x, y, optional button left|right|middle and clicks 1-3. move takes x, y. type pastes text. key takes a combo such as enter, ctrl+l or alt+tab. scroll takes x, y, direction up|down|left|right and optional amount. Screenshot again after an action before deciding the next one. Main agent only.',
    defaultActive: false,
    annotations: { destructiveHint: true, readOnlyHint: false, openWorldHint: true },
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('screenshot'),
        Type.Literal('list_windows'),
        Type.Literal('click'),
        Type.Literal('move'),
        Type.Literal('type'),
        Type.Literal('key'),
        Type.Literal('scroll')
      ]),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      button: Type.Optional(Type.Union([Type.Literal('left'), Type.Literal('right'), Type.Literal('middle')])),
      clicks: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
      text: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      direction: Type.Optional(Type.Union([
        Type.Literal('up'), Type.Literal('down'), Type.Literal('left'), Type.Literal('right')
      ])),
      amount: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 }))
    }),
    async execute(_id, params, signal) {
      const action = params.action;
      try {
        const request = { action };
        if (action === 'click' || action === 'move' || action === 'scroll') {
          const point = toScreen(params.x, params.y);
          request.x = point.x;
          request.y = point.y;
        }
        if (action === 'click') {
          request.button = params.button || 'left';
          request.clicks = params.clicks || 1;
        }
        if (action === 'type') {
          if (typeof params.text !== 'string' || !params.text) throw new Error('type requires text');
          if (params.text.length > 8000) throw new Error('text is too long');
          request.text = params.text;
        }
        if (action === 'key') {
          if (typeof params.key !== 'string' || !params.key.trim()) throw new Error('key requires a combo such as enter or ctrl+l');
          request.key = params.key.trim();
        }
        if (action === 'scroll') {
          request.direction = params.direction || 'down';
          request.amount = params.amount || 3;
        }
        const payload = await desktop(request, signal);
        if (!payload || payload.ok === false) return fail(action, (payload && payload.error) || 'Computer Use failed');
        if (action === 'screenshot') {
          frame = {
            width: payload.width,
            height: payload.height,
            scale: payload.scale > 0 ? payload.scale : 1,
            originX: payload.originX,
            originY: payload.originY
          };
          const text = 'Screenshot ' + payload.width + 'x' + payload.height + '. Coordinates are pixels in this image, origin top-left.';
          return {
            content: [
              { type: 'text', text },
              { type: 'image', data: payload.image, mimeType: 'image/png' }
            ],
            details: {
              action,
              width: payload.width,
              height: payload.height,
              scale: frame.scale,
              originX: frame.originX,
              originY: frame.originY,
              image: { data: payload.image, mimeType: 'image/png' }
            }
          };
        }
        if (action === 'list_windows') {
          const windows = Array.isArray(payload.windows) ? payload.windows : payload.windows ? [payload.windows] : [];
          const lines = windows.map((window) => window.title + ' (' + window.width + 'x' + window.height + ' at ' + window.x + ',' + window.y + ')');
          return {
            content: [{ type: 'text', text: lines.length ? lines.join('\\n') : 'No visible windows' }],
            details: { action, windows }
          };
        }
        return {
          content: [{ type: 'text', text: payload.summary || action }],
          details: { action, x: request.x, y: request.y }
        };
      } catch (error) {
        const message = error && error.message ? error.message : String(error);
        return fail(action, message);
      }
    }
  });
}
`
}

/**
 * One PowerShell process per call. It is DPI-aware so a screenshot pixel and
 * a later click describe the same physical point, then scaled so the image
 * the model sees stays small enough to send back.
 */
const DESKTOP_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
function Write-Result($value) {
  $json = $value | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
}
try {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class WinDesktop {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public class WinWindow {
    public long handle; public uint pid; public string title;
    public int x; public int y; public int width; public int height;
  }
  static EnumProc callback;
  public static void EnableDpi() {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); }
    catch { try { SetProcessDPIAware(); } catch { } }
  }
  public static List<WinWindow> List() {
    var rows = new List<WinWindow>();
    callback = (h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, sb.Capacity);
      var title = sb.ToString();
      if (string.IsNullOrWhiteSpace(title)) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      int w = r.Right - r.Left;
      int hgt = r.Bottom - r.Top;
      if (w < 40 || hgt < 40) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (title.Length > 200) title = title.Substring(0, 200);
      rows.Add(new WinWindow { handle = h.ToInt64(), pid = pid, title = title, x = r.Left, y = r.Top, width = w, height = hgt });
      return rows.Count < 80;
    };
    EnumWindows(callback, IntPtr.Zero);
    return rows;
  }
  public static void Move(int x, int y) { SetCursorPos(x, y); }
  public static void Click(int x, int y, string button, int clicks) {
    SetCursorPos(x, y);
    uint down = 0x0002, up = 0x0004;
    if (button == "right") { down = 0x0008; up = 0x0010; }
    else if (button == "middle") { down = 0x0020; up = 0x0040; }
    if (clicks < 1) clicks = 1;
    if (clicks > 3) clicks = 3;
    for (int i = 0; i < clicks; i++) {
      mouse_event(down, 0, 0, 0, UIntPtr.Zero);
      mouse_event(up, 0, 0, 0, UIntPtr.Zero);
      if (i + 1 < clicks) System.Threading.Thread.Sleep(50);
    }
  }
  public static void Wheel(int x, int y, int delta, bool horizontal) {
    SetCursorPos(x, y);
    uint flags = horizontal ? 0x1000u : 0x0800u;
    mouse_event(flags, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
  }
  public static void KeyDown(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); }
  public static void KeyUp(byte vk) { keybd_event(vk, 0, 2, UIntPtr.Zero); }
  public static int VirtualKey(string name) {
    if (name.Length == 1) {
      char c = char.ToUpperInvariant(name[0]);
      if (c >= 'A' && c <= 'Z') return c;
      if (c >= '0' && c <= '9') return c;
    }
    switch (name) {
      case "enter": case "return": return 0x0D;
      case "tab": return 0x09;
      case "escape": case "esc": return 0x1B;
      case "backspace": case "back": return 0x08;
      case "delete": case "del": return 0x2E;
      case "up": return 0x26;
      case "down": return 0x28;
      case "left": return 0x25;
      case "right": return 0x27;
      case "home": return 0x24;
      case "end": return 0x23;
      case "pageup": return 0x21;
      case "pagedown": return 0x22;
      case "space": return 0x20;
      case "ctrl": case "control": return 0x11;
      case "alt": return 0x12;
      case "shift": return 0x10;
      case "win": case "meta": return 0x5B;
      case "f1": return 0x70; case "f2": return 0x71; case "f3": return 0x72; case "f4": return 0x73;
      case "f5": return 0x74; case "f6": return 0x75; case "f7": return 0x76; case "f8": return 0x77;
      case "f9": return 0x78; case "f10": return 0x79; case "f11": return 0x7A; case "f12": return 0x7B;
      default: return -1;
    }
  }
}
"@
  [WinDesktop]::EnableDpi()
  $req = $env:COMPUTER_USE_REQUEST | ConvertFrom-Json
  $action = [string]$req.action
  if ($action -eq 'list_windows') {
    $windows = @([WinDesktop]::List() | ForEach-Object {
      [ordered]@{ handle = $_.handle; pid = $_.pid; title = $_.title; x = $_.x; y = $_.y; width = $_.width; height = $_.height }
    })
    Write-Result ([ordered]@{ ok = $true; action = $action; windows = $windows })
    return
  }
  if ($action -eq 'screenshot') {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bmp.Size)
    $graphics.Dispose()
    $max = 1280
    $scale = 1.0
    $out = $bmp
    if ($bmp.Width -gt $max -and $bmp.Width -gt 0) {
      $scale = $max / $bmp.Width
      $nw = $max
      $nh = [Math]::Max(1, [int][Math]::Round($bmp.Height * $scale))
      $scaled = New-Object System.Drawing.Bitmap $nw, $nh
      $sg = [System.Drawing.Graphics]::FromImage($scaled)
      $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $sg.DrawImage($bmp, 0, 0, $nw, $nh)
      $sg.Dispose()
      $bmp.Dispose()
      $out = $scaled
    }
    $stream = New-Object System.IO.MemoryStream
    $out.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $stream.ToArray()
    $stream.Dispose()
    $width = $out.Width
    $height = $out.Height
    $out.Dispose()
    Write-Result ([ordered]@{
      ok = $true; action = $action; width = $width; height = $height; scale = $scale
      originX = $bounds.X; originY = $bounds.Y; image = [Convert]::ToBase64String($bytes)
    })
    return
  }
  if ($action -eq 'move') {
    [WinDesktop]::Move([int]$req.x, [int]$req.y)
    Write-Result ([ordered]@{ ok = $true; action = $action; summary = 'Moved' })
    return
  }
  if ($action -eq 'click') {
    $button = if ($req.button) { [string]$req.button } else { 'left' }
    $clicks = if ($req.clicks) { [int]$req.clicks } else { 1 }
    [WinDesktop]::Click([int]$req.x, [int]$req.y, $button, $clicks)
    Write-Result ([ordered]@{ ok = $true; action = $action; summary = 'Clicked' })
    return
  }
  if ($action -eq 'scroll') {
    $direction = if ($req.direction) { [string]$req.direction } else { 'down' }
    $amount = if ($req.amount) { [int]$req.amount } else { 3 }
    if ($amount -lt 1) { $amount = 1 }
    if ($amount -gt 20) { $amount = 20 }
    $delta = 120 * $amount
    $horizontal = $false
    if ($direction -eq 'up') { }
    elseif ($direction -eq 'down') { $delta = -$delta }
    elseif ($direction -eq 'right') { $horizontal = $true }
    elseif ($direction -eq 'left') { $horizontal = $true; $delta = -$delta }
    else { throw "Unknown scroll direction: $direction" }
    [WinDesktop]::Wheel([int]$req.x, [int]$req.y, $delta, $horizontal)
    Write-Result ([ordered]@{ ok = $true; action = $action; summary = "Scrolled $direction" })
    return
  }
  if ($action -eq 'type') {
    Add-Type -AssemblyName System.Windows.Forms
    $text = [string]$req.text
    $had = $false
    $backup = ''
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsText()) {
        $backup = [System.Windows.Forms.Clipboard]::GetText()
        $had = $true
      }
    } catch {}
    [System.Windows.Forms.Clipboard]::SetText($text)
    Start-Sleep -Milliseconds 40
    [WinDesktop]::KeyDown(0x11)
    [WinDesktop]::KeyDown(0x56)
    [WinDesktop]::KeyUp(0x56)
    [WinDesktop]::KeyUp(0x11)
    Start-Sleep -Milliseconds 40
    try {
      if ($had) { [System.Windows.Forms.Clipboard]::SetText($backup) }
      else { [System.Windows.Forms.Clipboard]::Clear() }
    } catch {}
    Write-Result ([ordered]@{ ok = $true; action = $action; summary = 'Typed' })
    return
  }
  if ($action -eq 'key') {
    $parts = @([string]$req.key -split '\\+' | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw 'key is empty' }
    $vks = New-Object System.Collections.Generic.List[int]
    foreach ($part in $parts) {
      $vk = [WinDesktop]::VirtualKey($part)
      if ($vk -lt 0) { throw "Unknown key: $part" }
      $vks.Add($vk)
    }
    for ($i = 0; $i -lt $vks.Count - 1; $i++) { [WinDesktop]::KeyDown([byte]$vks[$i]) }
    [WinDesktop]::KeyDown([byte]$vks[$vks.Count - 1])
    [WinDesktop]::KeyUp([byte]$vks[$vks.Count - 1])
    for ($i = $vks.Count - 2; $i -ge 0; $i--) { [WinDesktop]::KeyUp([byte]$vks[$i]) }
    Write-Result ([ordered]@{ ok = $true; action = $action; summary = ('Pressed ' + [string]$req.key) })
    return
  }
  throw "Unknown computer action: $action"
} catch {
  Write-Result ([ordered]@{ ok = $false; error = $_.Exception.Message })
}
`
