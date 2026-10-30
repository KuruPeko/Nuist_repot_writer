# -*- coding: utf-8 -*-
"""
ReportWriter · 自动复现引擎
============================
在本机真实运行实验软件（MATLAB / LabVIEW / CAD / 任意 exe / 串口下位机），
通过「窗口抓取 + Windows 远程控制 + 串口连接」采集真实运行证据：
截图 PNG、串口日志、控制台输出，随后作为材料写进实验报告。

实现说明
--------
* 只依赖 Python 标准库；截图 / 键鼠 / 串口全部通过本机 PowerShell + .NET 完成
  （System.Drawing 屏幕抓取、user32 键鼠注入、System.IO.Ports 串口）。
* PowerShell 脚本在首次使用时生成到 `<程序目录>/replay_scripts/`，纯 ASCII，
  含中文的窗口标题 / 路径一律作为命令行参数传入，避免代码页问题。
* 截图坐标是屏幕像素（虚拟屏幕坐标系）；「测试截图」按钮抓全屏，可用来量坐标。
"""
from __future__ import annotations

import os
import queue
import re
import shlex
import subprocess
import threading
import time
import traceback
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# PowerShell 脚本的落盘目录：优先程序目录，失败（只读安装 / 权限受限）时
# 退到 %LOCALAPPDATA%\ReportWriter，再退到临时目录；也可用 RW_SCRIPT_DIR 指定。
_script_dir_candidates = []
if os.environ.get("RW_SCRIPT_DIR"):
    _script_dir_candidates.append(Path(os.environ["RW_SCRIPT_DIR"]))
_script_dir_candidates += [
    ROOT / "replay_scripts",
    Path(os.environ.get("LOCALAPPDATA") or ROOT) / "ReportWriter" / "replay_scripts",
    Path(os.environ.get("TEMP") or ROOT) / "ReportWriter_replay_scripts",
]
SCRIPT_DIR = _script_dir_candidates[0]

# ---------------------------------------------------------------- 小工具
def decode_bytes(b: bytes) -> str:
    for enc in ("utf-8", "gbk"):
        try:
            return b.decode(enc)
        except Exception:
            continue
    return b.decode("utf-8", "replace")


def safe_name(s: str, fallback="截图", limit=30) -> str:
    s = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", (s or "").strip())
    s = re.sub(r"\s+", " ", s).strip(" .")
    return (s or fallback)[:limit]


# ---------------------------------------------------------------- 状态
class ReplayState:
    """一次复现的运行状态（接口与 ReportWriter 的 RunState 保持一致风格）。"""

    def __init__(self):
        self.state = "idle"          # idle | running | done | failed | canceled
        self.lines = []              # [seq, stream, text]
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        self.started = None
        self.finished = None
        self.pct = 0
        self.stage = ""
        self.artifacts = []          # [{name, path, kind, size}]
        self.summary = ""
        self.pids = []               # 启动的进程 pid（停止时强杀）

    def add(self, stream: str, text: str):
        text = (text or "").rstrip("\r\n")
        if not text:
            return
        with self.lock:
            self.lines.append([len(self.lines), stream, text])

    def snapshot(self, start: int = 0):
        with self.lock:
            return self.lines[start:], len(self.lines)

    def add_artifact(self, path: Path, kind: str, rel_base: Path):
        try:
            rel = path.relative_to(rel_base).as_posix()
        except ValueError:
            rel = str(path)
        with self.lock:
            self.artifacts.append({
                "name": path.name, "path": rel, "kind": kind,
                "size": path.stat().st_size,
            })

    def public(self) -> dict:
        with self.lock:
            arts = list(self.artifacts)
        return {
            "state": self.state,
            "pct": self.pct,
            "stage": self.stage,
            "started": self.started,
            "finished": self.finished,
            "summary": self.summary,
            "artifacts": arts,
        }

    def reset(self):
        with self.lock:
            self.state = "idle"
            self.lines = []
            self.cancel = threading.Event()
            self.started = None
            self.finished = None
            self.pct = 0
            self.stage = ""
            self.artifacts = []
            self.summary = ""
            self.pids = []


# ---------------------------------------------------------------- PowerShell 脚本
# 多个脚本共用的 user32 P/Invoke 源码（纯 ASCII）
_WIN_CS = r"""
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RWWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public static IntPtr FindByTitle(string contains) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      if (contains.Length > 0 && t.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (long)(r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  public static RECT RectOf(IntPtr h) { RECT r; GetWindowRect(h, out r); return r; }
}
"""

_INPUT_CS = r"""
using System;
using System.Runtime.InteropServices;
public class RWInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
}
"""

SHOT_PS = r"""param([string]$Title = "", [string]$Out = "")
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
""" + _WIN_CS + r"""'@
  [RWWin]::SetProcessDPIAware() | Out-Null
  $x = 0; $y = 0; $w = 0; $h = 0
  if ($Title -ne "") {
    $hwnd = [RWWin]::FindByTitle($Title)
    if ($hwnd -eq [IntPtr]::Zero) { Write-Output "ERR:NOWINDOW"; exit 2 }
    [RWWin]::ShowWindow($hwnd, 9) | Out-Null
    [RWWin]::SetForegroundWindow($hwnd) | Out-Null
    Start-Sleep -Milliseconds 400
    $r = [RWWin]::RectOf($hwnd)
    $x = $r.Left; $y = $r.Top; $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height
  }
  if ($w -le 0 -or $h -le 0) { Write-Output "ERR:EMPTY"; exit 3 }
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()
  $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Output "OK:$Out"
} catch {
  Write-Output ("ERR:" + $_.Exception.Message)
  exit 1
}
"""

INPUT_PS = r"""param([string]$Mode = "", [string]$Text = "", [int]$X = -1, [int]$Y = -1, [string]$Title = "")
$ErrorActionPreference = "Stop"
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -TypeDefinition @'
""" + _WIN_CS + _INPUT_CS + r"""'@
  [RWWin]::SetProcessDPIAware() | Out-Null
  $hwnd = [IntPtr]::Zero
  if ($Title -ne "") {
    $hwnd = [RWWin]::FindByTitle($Title)
    if ($hwnd -ne [IntPtr]::Zero) {
      [RWWin]::ShowWindow($hwnd, 9) | Out-Null
      [RWWin]::SetForegroundWindow($hwnd) | Out-Null
      Start-Sleep -Milliseconds 300
    }
  }
  switch -Exact ($Mode) {
    "activate" {
      if ($hwnd -eq [IntPtr]::Zero) { Write-Output "ERR:NOWINDOW"; exit 2 }
      Write-Output "OK"
    }
    "type" {
      if ($Text.Length -gt 0) {
        try { Set-Clipboard -Value $Text }
        catch { [System.Windows.Forms.Clipboard]::SetText($Text) }
        Start-Sleep -Milliseconds 250
        [System.Windows.Forms.SendKeys]::SendWait("^v")
      }
      Write-Output "OK"
    }
    "key" {
      [System.Windows.Forms.SendKeys]::SendWait($Text)
      Write-Output "OK"
    }
    { $_ -in @("click", "dclick", "rclick") } {
      $cx = $X; $cy = $Y
      if ($cx -lt 0 -or $cy -lt 0) {
        if ($hwnd -ne [IntPtr]::Zero) {
          $r = [RWWin]::RectOf($hwnd)
          $cx = [int](($r.Left + $r.Right) / 2); $cy = [int](($r.Top + $r.Bottom) / 2)
        } else {
          $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
          $cx = [int]($vs.Left + $vs.Width / 2); $cy = [int]($vs.Top + $vs.Height / 2)
        }
      }
      [RWInput]::SetCursorPos($cx, $cy) | Out-Null
      Start-Sleep -Milliseconds 120
      switch -Exact ($Mode) {
        "click" {
          [RWInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 60
          [RWInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
        }
        "dclick" {
          for ($i = 0; $i -lt 2; $i++) {
            [RWInput]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 50
            [RWInput]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
            Start-Sleep -Milliseconds 80
          }
        }
        "rclick" {
          [RWInput]::mouse_event(8, 0, 0, 0, [UIntPtr]::Zero)
          Start-Sleep -Milliseconds 60
          [RWInput]::mouse_event(16, 0, 0, 0, [UIntPtr]::Zero)
        }
      }
      Write-Output "OK:$cx,$cy"
    }
    default { Write-Output "ERR:MODE"; exit 4 }
  }
} catch {
  Write-Output ("ERR:" + $_.Exception.Message)
  exit 1
}
"""

SERIAL_PS = r"""param([string]$Port = "", [int]$Baud = 9600, [string]$Log = "", [switch]$List)
$ErrorActionPreference = "Stop"
try {
  if ($List) {
    $names = [System.IO.Ports.SerialPort]::GetPortNames()
    Write-Output ("OK:" + ($names -join ","))
    exit 0
  }
  $sp = New-Object System.IO.Ports.SerialPort($Port, $Baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $sp.ReadTimeout = 300
  $sp.DtrEnable = $true
  $sp.RtsEnable = $true
  $sp.Open()
  Write-Output "OK:OPEN"
  while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line -eq "close") { break }
    if ($line.StartsWith("send:")) {
      $sp.Write($line.Substring(5))
      Start-Sleep -Milliseconds 120
      Write-Output "OK:SEND"
    } elseif ($line.StartsWith("read:")) {
      $sec = [double]$line.Substring(5)
      $deadline = (Get-Date).AddSeconds($sec)
      $sb = New-Object System.Text.StringBuilder
      while ((Get-Date) -lt $deadline) {
        try {
          $l = $sp.ReadLine()
          [void]$sb.Append($l); [void]$sb.Append("`r`n")
        } catch { }
      }
      try { $rest = $sp.ReadExisting(); if ($rest) { [void]$sb.Append($rest) } } catch { }
      $txt = $sb.ToString()
      if ($Log -ne "" -and $txt.Length -gt 0) {
        $stamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
        Add-Content -Path $Log -Value ("---- {0} read {1:0.#} s ----`r`n{2}" -f $stamp, $sec, $txt) -Encoding UTF8
      }
      Write-Output ("OK:READ " + $txt.Length)
    } else { Write-Output "ERR:CMD" }
  }
  $sp.Close()
  Write-Output "OK:CLOSE"
} catch {
  Write-Output ("ERR:" + $_.Exception.Message)
  exit 1
}
"""

_SCRIPTS = {
    "rw_shot.ps1": SHOT_PS,
    "rw_input.ps1": INPUT_PS,
    "rw_serial.ps1": SERIAL_PS,
}
_scripts_ready = False


def ensure_scripts():
    """把内置 PowerShell 脚本写到可用目录（每次更新覆盖，随程序升级）。

    目录按候选顺序尝试：环境变量指定 → 程序目录 → %LOCALAPPDATA% → 临时目录。
    """
    global _scripts_ready
    if _scripts_ready:
        return
    global SCRIPT_DIR
    last_err = None
    for cand in _script_dir_candidates:
        try:
            cand.mkdir(parents=True, exist_ok=True)
            probe = cand / ".rw_write_probe"
            probe.write_text("ok", "ascii")
            probe.unlink(missing_ok=True)
            SCRIPT_DIR = cand
            break
        except OSError as e:
            last_err = e
            continue
    else:
        raise RuntimeError(f"找不到可写的脚本目录（最后一个失败原因：{last_err}）")
    for name, body in _SCRIPTS.items():
        (SCRIPT_DIR / name).write_text(body, "ascii")
    _scripts_ready = True


def ps_run(script: str, params: dict, timeout: int = 90) -> tuple[int, str]:
    """执行一个内置 ps1：params 里 True → 开关，None/False → 省略。"""
    ensure_scripts()
    cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
           "-File", str(SCRIPT_DIR / script)]
    for k, v in params.items():
        if v is None or v is False:
            continue
        if v is True:
            cmd.append(f"-{k}")
        else:
            cmd += [f"-{k}", str(v)]
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return r.returncode, decode_bytes(r.stdout) + decode_bytes(r.stderr)


def ps_out_error(out: str) -> str:
    """从 ps 输出里取 ERR: 原因。"""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("ERR:"):
            return line[4:]
    return (out or "未知错误").strip().splitlines()[-1][:200]


# ---------------------------------------------------------------- 串口
def list_serial_ports() -> list:
    try:
        _, out = ps_run("rw_serial.ps1", {"List": True}, timeout=30)
        for line in out.splitlines():
            if line.startswith("OK:"):
                names = [x.strip() for x in line[3:].split(",") if x.strip()]
                return sorted(names, key=lambda s: (len(s), s))
    except Exception:
        pass
    return []


class SerialSession:
    """一个长驻 PowerShell 进程保持串口打开，send/read 走 stdin 协议。

    合并成一个会话的原因：很多下位机（如 Arduino）DTR 一变化就会复位，
    每条指令都开/关串口会把板子反复重启，采不到输出。
    """

    def __init__(self, port: str, baud: int, log_path: Path, state: ReplayState):
        ensure_scripts()
        self.state = state
        cmd = ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
               "-File", str(SCRIPT_DIR / "rw_serial.ps1"),
               "-Port", port, "-Baud", str(int(baud)), "-Log", str(log_path)]
        self.proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.q: queue.Queue = queue.Queue()
        self.t = threading.Thread(target=self._pump, daemon=True)
        self.t.start()
        ack = self._wait(20)
        if "OK:OPEN" not in ack:
            raise RuntimeError(f"串口 {port} 打开失败：{ps_out_error(ack) or ack.strip()}")
        state.add("app", f"串口已打开：{port} @ {baud}")

    def _pump(self):
        try:
            for raw in iter(self.proc.stdout.readline, b""):
                if not raw:
                    break
                self.q.put(decode_bytes(raw))
        except Exception:
            pass
        self.q.put(None)

    def _wait(self, timeout: float) -> str:
        try:
            item = self.q.get(timeout=timeout)
        except queue.Empty:
            return ""
        return item or ""

    def send(self, text: str):
        self.proc.stdin.write(("send:" + text + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        ack = self._wait(15)
        if "OK:SEND" not in ack:
            raise RuntimeError(f"串口发送失败：{ps_out_error(ack)}")

    def read(self, seconds: float):
        self.proc.stdin.write((f"read:{max(1, float(seconds)):.1f}\n").encode("utf-8"))
        self.proc.stdin.flush()
        ack = self._wait(float(seconds) + 20)
        if "OK:READ" not in ack:
            raise RuntimeError(f"串口读取失败：{ps_out_error(ack)}")

    def close(self):
        try:
            self.proc.stdin.write(b"close\n")
            self.proc.stdin.flush()
            self._wait(8)
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass


# ---------------------------------------------------------------- 软件探测
def _where_first(name: str) -> str:
    try:
        r = subprocess.run(["where", name], capture_output=True, timeout=15)
        for line in decode_bytes(r.stdout).splitlines():
            line = line.strip()
            if line and Path(line).exists():
                return line
    except Exception:
        pass
    return ""


def _glob_first(patterns) -> str:
    for pat in patterns:
        try:
            p = Path(pat)
            hits = [h for h in p.parent.glob(p.name) if h.exists()]
        except Exception:
            continue
        if hits:
            hits.sort(key=lambda x: x.as_posix(), reverse=True)
            return str(hits[0])
    return ""


def find_tool(kind: str) -> str:
    """探测本机实验软件路径；找不到返回空串。"""
    kind = (kind or "").lower()
    if kind == "matlab":
        p = _where_first("matlab.exe") or _where_first("matlab")
        if p and "matlab" in p.lower():
            return p
        return _glob_first([
            r"C:\Program Files\MATLAB\*\bin\matlab.exe",
            r"C:\Program Files\Polyspace\*\bin\matlab.exe",
        ])
    if kind == "labview":
        return _glob_first([
            r"C:\Program Files\National Instruments\LabVIEW *\LabVIEW.exe",
            r"C:\Program Files (x86)\National Instruments\LabVIEW *\LabVIEW.exe",
        ])
    if kind == "cad":
        return _glob_first([
            r"C:\Program Files\Autodesk\AutoCAD *\acad.exe",
            r"C:\Program Files\Autodesk\AutoCAD *\* acad.exe",
        ])
    if kind == "sevenzip":
        for c in (r"C:\Program Files\7-Zip\7z.exe",
                  r"C:\Program Files (x86)\7-Zip\7z.exe"):
            if Path(c).exists():
                return c
        return _where_first("7z.exe") or _where_first("7z")
    if kind == "winrar":
        for c in (r"C:\Program Files\WinRAR\WinRAR.exe",
                  r"C:\Program Files (x86)\WinRAR\WinRAR.exe",
                  r"C:\Program Files\WinRAR\UnRAR.exe",
                  r"C:\Program Files (x86)\WinRAR\UnRAR.exe"):
            if Path(c).exists():
                return c
        return _where_first("WinRAR.exe") or _where_first("UnRAR.exe") or _where_first("winrar")
    return ""


def env_report() -> dict:
    return {
        "serial_ports": list_serial_ports(),
        "tools": {
            "matlab": find_tool("matlab"),
            "labview": find_tool("labview"),
            "cad": find_tool("cad"),
        },
    }


# ---------------------------------------------------------------- 步骤 DSL
RUNNERS = ("matlab", "labview", "cad", "serial", "generic")
OPS = {"launch", "wait", "activate", "type", "key", "click", "dclick", "rclick",
       "shot", "console", "serial_open", "serial_send", "serial_read",
       "matlab_batch", "kill"}
_REST_OPS = {"type", "key", "shot", "serial_send"}

RUNNER_LABEL = {
    "matlab": "MATLAB（批处理运行并导出图窗）",
    "labview": "LabVIEW（打开 VI 并截图）",
    "cad": "CAD（打开图纸并截图）",
    "serial": "串口（连接下位机采集输出）",
    "generic": "通用程序（打开文件并截图）",
}


def detect_runner(file: Path) -> str:
    e = Path(file).suffix.lower()
    if e in {".m", ".mlx", ".mlapp"}:
        return "matlab"
    if e in {".vi", ".lvproj", ".lvlb", ".vim", ".ctl"}:
        return "labview"
    if e in {".dwg", ".dxf", ".step", ".stp", ".iges", ".igs", ".stl", ".jt",
             ".sldprt", ".sldasm", ".slddrw", ".ipt", ".iam", ".idw",
             ".prt", ".catpart", ".catproduct", ".catdrawing"}:
        return "cad"
    return "generic"


def parse_steps(text: str) -> list:
    """把界面上的步骤 DSL 解析成指令列表。

    每行一条指令；`#` 开头是注释。支持：
      launch / wait 秒 / activate / type 文本 / key 组合键 /
      click x y / dclick x y / rclick x y（不填坐标=点窗口中心）/
      shot 名称 / console / serial_open / serial_send 文本 / serial_read 秒 /
      matlab_batch / kill
    """
    steps = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or line.startswith("//"):
            continue
        parts = line.split(None, 1)
        op = parts[0].lower()
        rest = parts[1].strip() if len(parts) > 1 else ""
        if op not in OPS:
            raise ValueError(f"不认识的指令「{parts[0]}」，可用：{' / '.join(sorted(OPS))}")
        step = {"op": op}
        if op == "wait" or op == "serial_read":
            try:
                step["sec"] = float(rest)
            except ValueError:
                raise ValueError(f"「{op}」需要一个秒数，例如：{op} 5")
            if step["sec"] <= 0 or step["sec"] > 3600:
                raise ValueError(f"「{op}」的秒数要在 0~3600 之间")
        elif op in ("click", "dclick", "rclick"):
            nums = re.findall(r"-?\d+", rest)
            if len(nums) >= 2:
                step["x"], step["y"] = int(nums[0]), int(nums[1])
        elif op in _REST_OPS:
            if op == "serial_send":
                # 常见转义：\r \n \t
                rest = (rest.replace(r"\r\n", "\r\n").replace(r"\r", "\r")
                            .replace(r"\n", "\n").replace(r"\t", "\t"))
            step["text"] = rest
        steps.append(step)
    if not steps:
        raise ValueError("复现步骤是空的")
    return steps


def default_steps(runner: str, file_path, shots: int = 2, interval: float = 5.0) -> list:
    """按复现方式自动编排一份默认步骤。"""
    runner = runner if runner in RUNNERS else "generic"
    shots = max(1, min(12, int(shots or 2)))
    interval = max(1.0, min(120.0, float(interval or 5.0)))
    if runner == "matlab":
        return [{"op": "matlab_batch"}]
    if runner == "serial":
        return [{"op": "serial_open"}, {"op": "wait", "sec": 2},
                {"op": "serial_read", "sec": 10}]
    steps = [{"op": "launch"}]
    if runner == "labview":
        steps += [{"op": "wait", "sec": 15}, {"op": "activate"},
                  {"op": "shot", "text": "打开VI"}, {"op": "key", "text": "^r"},
                  {"op": "wait", "sec": 6}, {"op": "shot", "text": "运行前面板"}]
    elif runner == "cad":
        steps += [{"op": "wait", "sec": 25}, {"op": "shot", "text": "打开图纸"},
                  {"op": "wait", "sec": 10}, {"op": "shot", "text": "图纸视图"}]
    else:
        steps += [{"op": "wait", "sec": 8}, {"op": "shot", "text": "启动界面"}]
    # 余下的截图按间隔铺开
    for i in range(max(0, shots - 1)):
        steps += [{"op": "wait", "sec": interval},
                  {"op": "shot", "text": f"运行结果{i + 1}"}]
    steps += [{"op": "kill"}]
    return steps


# ---------------------------------------------------------------- MATLAB 批处理
_MATLAB_WRAPPER = """% ReportWriter 自动复现：批处理运行实验脚本并导出全部图窗（本文件由程序生成）
outdir = '{outdir}';
src = '{src}';
try
  run(src);
catch e
  fprintf(2, 'RW_ERROR: %s\\n', getReport(e));
end
figs = findall(groot, 'Type', 'figure');
k = 0;
for i = 1:numel(figs)
  f = figs(numel(figs) - i + 1);  % 按创建顺序导出
  k = k + 1;
  out = fullfile(outdir, sprintf('matlab_fig_%02d.png', k));
  try
    exportgraphics(f, out, 'Resolution', 150);
  catch
    try
      saveas(f, out);
    catch
    end
  end
  if exist(out, 'file')
    fprintf('RW_FIG: %s\\n', out);
  end
end
fprintf('RW_DONE\\n');
"""


def _run_matlab_batch(plan: dict, art_dir: Path, state: ReplayState,
                      cancel, timeout: int) -> str:
    """无界面跑 .m 脚本，把所有 figure 导出成 PNG。返回控制台输出的落盘路径。"""
    src = Path(plan.get("file") or "")
    if not src.exists():
        raise RuntimeError(f"MATLAB 批处理需要目标脚本文件，未找到：{src}")
    if src.suffix.lower() not in (".m", ".mlx"):
        raise RuntimeError(f"MATLAB 批处理只支持 .m/.mlx，当前是 {src.name}")
    matlab = (plan.get("exe") or "").strip() or find_tool("matlab")
    if not matlab or not Path(matlab).exists():
        raise RuntimeError("没有找到 MATLAB，请在「软件路径」里手填 matlab.exe 的完整路径")

    mrun = art_dir.parent / "replay_matlab"     # 任务根目录是纯 ASCII，避开编码坑
    figs_dir = mrun / "figs"
    mrun.mkdir(parents=True, exist_ok=True)
    figs_dir.mkdir(parents=True, exist_ok=True)
    # 脚本复制成 ASCII 名字再运行（原路径可能含中文）
    local_src = mrun / ("rw_src" + (".mlx" if src.suffix.lower() == ".mlx" else ".m"))
    local_src.write_bytes(src.read_bytes())
    wrapper = mrun / "rw_matlab_run.m"
    wrapper.write_text(_MATLAB_WRAPPER.format(
        outdir=str(figs_dir).replace("'", "''"),
        src=str(local_src).replace("'", "''")), "utf-8")

    out_txt = art_dir / "控制台输出_MATLAB.txt"
    state.add("app", f"MATLAB 批处理运行：{src.name}（首次启动 MATLAB 可能要 30~90 秒）")
    stmt = f"run('{wrapper}')"
    cmd = [matlab, "-batch", stmt]
    t0 = time.time()
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=max(120, timeout),
                           cwd=str(mrun))
        out = decode_bytes(r.stdout) + decode_bytes(r.stderr)
        code = r.returncode
    except subprocess.TimeoutExpired:
        out, code = "MATLAB 运行超时被中止", -1
    except FileNotFoundError:
        raise RuntimeError(f"无法启动 MATLAB：{matlab}")
    state.add("app", f"MATLAB 退出码 {code}，用时 {time.time() - t0:.0f} 秒")
    out_txt.write_text(out or "", "utf-8")

    picked = 0
    for fig in sorted(figs_dir.glob("matlab_fig_*.png")):
        dst = art_dir / "截图" / fig.name
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_bytes(fig.read_bytes())
        state.add_artifact(dst, "复现截图", art_dir.parent)
        state.add("shot", f"MATLAB 图窗已导出：{dst.name}")
        picked += 1
    if "RW_ERROR:" in out:
        err = out.split("RW_ERROR:", 1)[1].strip().splitlines()
        state.add("error", "MATLAB 运行报错：" + "；".join(err[:3]))
    if picked == 0 and code != 0:
        tail = "\n".join((out or "").strip().splitlines()[-5:])
        raise RuntimeError(f"MATLAB 没有产出图窗（退出码 {code}）：{tail[:400]}")
    return str(out_txt)


# ---------------------------------------------------------------- 主流程
class _Canceled(Exception):
    pass


def _describe(step: dict) -> str:
    op = step.get("op", "")
    if op == "launch":
        return "启动实验软件"
    if op == "wait":
        return f"等待 {step.get('sec', 0):g} 秒"
    if op == "shot":
        return f"截图：{step.get('text') or '屏幕'}"
    if op == "type":
        return "输入文本"
    if op == "key":
        return f"按键 {step.get('text', '')}"
    if op in ("click", "dclick", "rclick"):
        return {"click": "单击", "dclick": "双击", "rclick": "右键"}[op] + \
               (f" ({step['x']},{step['y']})" if "x" in step else "（窗口中心）")
    if op == "serial_open":
        return "打开串口"
    if op == "serial_send":
        return "串口发送"
    if op == "serial_read":
        return f"串口读取 {step.get('sec', 0):g} 秒"
    if op == "matlab_batch":
        return "MATLAB 批处理运行"
    if op == "kill":
        return "关闭实验软件"
    return op


def run_replay(plan: dict, art_dir: Path, state: ReplayState, cancel,
               timeout: int, log_fn=None) -> dict:
    """执行一次复现。返回 {ok, error, artifacts, record}；产物同时登记进 state。"""
    ensure_scripts()
    art_dir = Path(art_dir)
    shot_dir = art_dir / "截图"
    shot_dir.mkdir(parents=True, exist_ok=True)
    steps = plan.get("steps") or []
    runner = plan.get("runner") or "generic"
    window = (plan.get("window") or "").strip()
    serial_cfg = plan.get("serial") or {}
    keep_open = bool(plan.get("keep_open"))
    launched = []          # [(Popen, note)]
    console_proc = None
    serial = None
    shot_no = 0
    t0 = time.time()
    ok, err = True, ""
    state.started = datetime.now().isoformat(timespec="seconds")
    state.state = "running"
    state.add("app", f"开始自动复现（{RUNNER_LABEL.get(runner, runner)}），共 {len(steps)} 步")
    if window:
        state.add("app", f"目标窗口标题包含「{window}」")

    def killed():
        for p, _note in launched:
            try:
                if p.poll() is None:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)],
                                   capture_output=True, timeout=30)
            except Exception:
                pass

    def need_kill_window():
        if not window:
            return
        try:
            subprocess.run(
                ["powershell", "-NoProfile", "-NonInteractive", "-Command",
                 "Get-Process | Where-Object { $_.MainWindowTitle -like '*" +
                 window.replace("'", "''") + "*' } | Stop-Process -Force"],
                capture_output=True, timeout=30)
        except Exception:
            pass

    def check_cancel():
        if cancel.is_set():
            raise _Canceled()

    def do_shot(name: str):
        nonlocal shot_no
        shot_no += 1
        out = shot_dir / f"{shot_no:02d}_{safe_name(name)}.png"
        code, outp = ps_run("rw_shot.ps1", {"Title": window, "Out": str(out)},
                            timeout=60)
        if code != 0 or "ERR:" in outp:
            reason = ps_out_error(outp)
            if window and reason == "NOWINDOW":
                state.add("app", f"没找到标题含「{window}」的窗口，改为抓全屏")
                code, outp = ps_run("rw_shot.ps1", {"Out": str(out)}, timeout=60)
        if code == 0 and out.exists():
            state.add_artifact(out, "复现截图", art_dir.parent)
            state.add("shot", f"📸 已截图：{out.name}")
        else:
            state.add("error", f"截图失败：{ps_out_error(outp)}")

    try:
        for idx, step in enumerate(steps, 1):
            check_cancel()
            if time.time() - t0 > timeout:
                raise RuntimeError(f"复现总时长超过 {timeout // 60} 分钟，已中止")
            state.pct = int((idx - 1) * 100 / max(1, len(steps)))
            state.stage = f"[{idx}/{len(steps)}] {_describe(step)}"
            state.add("app", f"▶ {state.stage}")
            op = step.get("op")

            if op == "launch":
                exe = (plan.get("exe") or "").strip()
                args = (plan.get("args") or "").strip()
                fpath = (plan.get("file") or "").strip()
                if exe:
                    cmd = [exe]
                    if fpath and plan.get("pass_file", True):
                        cmd.append(fpath)
                    if args:
                        cmd += shlex.split(args, posix=False)
                    p = subprocess.Popen(cmd, cwd=str(art_dir.parent))
                    launched.append((p, exe))
                    state.pids.append(p.pid)
                    state.add("app", f"已启动：{exe}（pid {p.pid}）")
                elif fpath:
                    fp = Path(fpath)
                    if fp.suffix.lower() in (".exe", ".bat", ".cmd", ".com"):
                        cmd = [str(fp)] + (shlex.split(args, posix=False) if args else [])
                        p = subprocess.Popen(cmd, cwd=str(fp.parent))
                        launched.append((p, fp.name))
                        state.pids.append(p.pid)
                        state.add("app", f"已启动：{fp.name}（pid {p.pid}）")
                    else:
                        import os
                        os.startfile(str(fp))
                        state.add("app", f"已用系统默认程序打开：{fp.name}")
                else:
                    raise RuntimeError("launch 步骤需要「目标文件」或「软件路径」")

            elif op == "wait":
                end = time.time() + float(step.get("sec", 1))
                while time.time() < end:
                    check_cancel()
                    time.sleep(0.2)

            elif op == "activate":
                code, outp = ps_run("rw_input.ps1",
                                    {"Mode": "activate", "Title": window}, timeout=30)
                if code != 0:
                    state.add("error", f"激活窗口失败：{ps_out_error(outp)}")

            elif op == "type":
                code, outp = ps_run("rw_input.ps1",
                                    {"Mode": "type", "Text": step.get("text", ""),
                                     "Title": window}, timeout=30)
                if code != 0:
                    state.add("error", f"输入文本失败：{ps_out_error(outp)}")

            elif op == "key":
                code, outp = ps_run("rw_input.ps1",
                                    {"Mode": "key", "Text": step.get("text", ""),
                                     "Title": window}, timeout=30)
                if code != 0:
                    state.add("error", f"按键失败：{ps_out_error(outp)}")

            elif op in ("click", "dclick", "rclick"):
                params = {"Mode": op, "Title": window}
                if "x" in step:
                    params["X"], params["Y"] = step["x"], step["y"]
                code, outp = ps_run("rw_input.ps1", params, timeout=30)
                if code != 0:
                    state.add("error", f"{_describe(step)}失败：{ps_out_error(outp)}")
                else:
                    state.add("app", "  " + outp.strip().splitlines()[0])

            elif op == "shot":
                do_shot(step.get("text") or f"截图{shot_no}")

            elif op == "console":
                if console_proc and console_proc.stdout:
                    state.add("app", "读取控制台输出…")
                    time.sleep(2)
                else:
                    state.add("app", "本次启动没有采集控制台输出（需要以命令行方式启动）")

            elif op == "serial_open":
                port = (serial_cfg.get("port") or "").strip()
                if not port:
                    raise RuntimeError("串口步骤需要先选择串口（COM 口）")
                serial = SerialSession(port, int(serial_cfg.get("baud") or 9600),
                                       art_dir / "串口日志.txt", state)

            elif op == "serial_send":
                if serial is None:
                    raise RuntimeError("请先执行 serial_open 再发送")
                serial.send(step.get("text", ""))
                state.add("serial", f"已发送：{step.get('text', '')!r}")

            elif op == "serial_read":
                if serial is None:
                    port = (serial_cfg.get("port") or "").strip()
                    if not port:
                        raise RuntimeError("串口步骤需要先选择串口（COM 口）")
                    serial = SerialSession(port, int(serial_cfg.get("baud") or 9600),
                                           art_dir / "串口日志.txt", state)
                sec = float(step.get("sec", 5))
                serial.read(sec)
                state.add("serial", f"已读取 {sec:g} 秒并写入 串口日志.txt")

            elif op == "matlab_batch":
                out_txt = _run_matlab_batch(plan, art_dir, state, cancel, timeout)
                if out_txt:
                    p = Path(out_txt)
                    if p.exists():
                        state.add_artifact(p, "复现日志", art_dir.parent)

            elif op == "kill":
                killed()
                need_kill_window()
                state.add("app", "已关闭实验软件")

        state.pct = 99
    except _Canceled:
        ok, err = False, "已手动停止"
        state.add("app", "⏹ 已停止复现")
    except Exception as e:
        ok, err = False, str(e)
        state.add("error", f"复现失败：{e}")
        if log_fn:
            log_fn("复现失败\n" + traceback.format_exc())
    finally:
        if serial:
            serial.close()
        if not keep_open:
            killed()
            need_kill_window()
        state.finished = datetime.now().isoformat(timespec="seconds")
        state.pct = 100 if ok else state.pct
        state.state = "done" if ok else ("canceled" if err == "已手动停止" else "failed")
        if not ok and err != "已手动停止":
            state.stage = "复现失败"
        elif not ok:
            state.stage = "已停止"
        else:
            state.stage = "复现完成"

    # 汇总产物 + 写复现记录
    arts = state.public()["artifacts"]
    log_txt = art_dir / "串口日志.txt"
    if log_txt.exists() and not any(a["path"].endswith("串口日志.txt") for a in arts):
        state.add_artifact(log_txt, "复现日志", art_dir.parent)
        arts = state.public()["artifacts"]

    record = _write_record(plan, art_dir, state, steps, ok, err, t0)
    if record and record.exists():
        state.add_artifact(record, "复现记录", art_dir.parent)
        arts = state.public()["artifacts"]

    shot_n = sum(1 for a in arts if a["kind"] == "复现截图")
    state.summary = (f"{'完成' if ok else '未完成'}：截图 {shot_n} 张，"
                     f"产物 {len(arts)} 项" + (f"（{err}）" if err and err != "已手动停止" else ""))
    state.add("app", "🏁 " + state.summary)
    return {"ok": ok, "error": err, "artifacts": arts, "record": str(record or "")}


def _write_record(plan: dict, art_dir: Path, state: ReplayState,
                  steps: list, ok: bool, err: str, t0: float) -> Path:
    try:
        lines = [
            "# 复现记录", "",
            f"- 复现方式：{RUNNER_LABEL.get(plan.get('runner') or '', plan.get('runner') or '')}",
            f"- 目标文件：{plan.get('file') or '（无）'}",
            f"- 软件路径：{plan.get('exe') or '（自动探测）'}",
            f"- 窗口标题：{plan.get('window') or '（未指定）'}",
            f"- 串口：{(plan.get('serial') or {}).get('port') or '（未使用）'}"
            f" @ {(plan.get('serial') or {}).get('baud') or '-'}",
            f"- 开始时间：{state.started}",
            f"- 结束时间：{state.finished}",
            f"- 结果：{'成功' if ok else ('手动停止' if err == '已手动停止' else '失败：' + err)}",
            f"- 用时：{time.time() - t0:.0f} 秒", "",
            "## 执行步骤", "",
        ]
        for i, s in enumerate(steps, 1):
            lines.append(f"{i}. {_describe(s)}")
        lines += ["", "## 产物清单", ""]
        for a in state.public()["artifacts"]:
            lines.append(f"- `{a['path']}`（{a['kind']}）")
        lines += ["",
                  "说明：以上产物由 ReportWriter 在本机自动运行实验软件采集，",
                  "属于真实运行结果；报告中的运行结果必须以这些截图与日志为准。"]
        p = art_dir / "复现记录.md"
        p.write_text("\n".join(lines), "utf-8")
        return p
    except Exception:
        return None


# ---------------------------------------------------------------- 测试截图
def test_shot(out_path: Path) -> Path:
    """抓一张全屏（给界面上「抓一张屏幕试试」用，方便确定点击坐标）。"""
    code, outp = ps_run("rw_shot.ps1", {"Out": str(out_path)}, timeout=60)
    if code != 0 or not Path(out_path).exists():
        raise RuntimeError(f"截图失败：{ps_out_error(outp)}")
    return Path(out_path)
