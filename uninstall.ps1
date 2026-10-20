# ReportWriter 一键卸载
# 用法：双击 一键卸载.exe；或
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Root <程序目录>
# 自动化测试可加 -Data Keep / -Data Delete -NoPause。
param(
    [string]$Root = $PSScriptRoot,
    [ValidateSet('Prompt', 'Keep', 'Delete')]
    [string]$Data = 'Prompt',
    [string]$DataRoot = '',
    [string]$DesktopDir = '',
    [switch]$NoPause
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Windows.Forms

function Say($msg, $color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
}

$Root = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
$appPy = Join-Path $Root 'app.py'
$index = Join-Path $Root 'web\index.html'

# 只允许卸载看起来确实是 ReportWriter 的目录，避免误删。
if (-not (Test-Path -LiteralPath $appPy) -or -not (Test-Path -LiteralPath $index)) {
    [System.Windows.Forms.MessageBox]::Show(
        "这个目录看起来不是 ReportWriter：`n$Root`n`n没有找到 app.py 和 web\index.html，已取消。",
        'ReportWriter 卸载', 'OK', 'Error') | Out-Null
    exit 1
}
if ($Root -match '^[A-Za-z]:$') {
    [System.Windows.Forms.MessageBox]::Show(
        "拒绝卸载磁盘根目录：`n$Root",
        'ReportWriter 卸载', 'OK', 'Error') | Out-Null
    exit 1
}

$deleteData = ($Data -eq 'Delete')
if ($Data -eq 'Prompt') {
    $msg = @"
将卸载 ReportWriter：

  • 停止正在运行的 ReportWriter
  • 删除程序文件和桌面快捷方式
  • 不会动 DSH、nuist-stem-lab-report skill、Python、Word

是否同时删除历史任务和已经导出的报告？
  %LOCALAPPDATA%\ReportWriter

是：删除程序 + 历史任务/报告
否：只删程序，保留历史任务/报告
取消：不卸载
"@
    $ans = [System.Windows.Forms.MessageBox]::Show(
        $msg, '卸载 ReportWriter', 'YesNoCancel', 'Question')
    if ($ans -eq [System.Windows.Forms.DialogResult]::Cancel) {
        Say '已取消卸载。'
        exit 0
    }
    $deleteData = ($ans -eq [System.Windows.Forms.DialogResult]::Yes)
}

Say ''
Say '=== ReportWriter 卸载 ===' 'Cyan'
Say "程序目录：$Root"

# 1. 停止本目录启动的 Python 服务
Say '正在停止 ReportWriter …'
try {
    Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
        ForEach-Object {
            if ($_.CommandLine -and $_.CommandLine.IndexOf($appPy, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
                Say "  已停止进程 $($_.ProcessId)"
            }
        }
} catch {}
# 兼容手动 `python app.py` 启动：按 config.json 的端口找到监听进程
try {
    $cfgPath = Join-Path $Root 'config.json'
    if (Test-Path -LiteralPath $cfgPath) {
        $port = [int]((Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json).port)
        Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
            $ownerPid = $_.OwningProcess
            $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid" -ErrorAction SilentlyContinue
            if ($proc -and $proc.Name -match '^pythonw?\.exe$' -and
                $proc.CommandLine -and
                $proc.CommandLine.IndexOf($appPy, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                Stop-Process -Id $ownerPid -Force -ErrorAction SilentlyContinue
            }
        }
    }
} catch {}
Start-Sleep -Milliseconds 600

# 2. 删除桌面快捷方式（只删除指向本程序目录的那个）
try {
    if ($DesktopDir) {
        $desktop = [IO.Path]::GetFullPath($DesktopDir)
    } else {
        $desktop = [Environment]::GetFolderPath('Desktop')
    }
    $lnkPath = Join-Path $desktop 'ReportWriter.lnk'
    if (Test-Path -LiteralPath $lnkPath) {
        $ws = New-Object -ComObject WScript.Shell
        $shortcut = $ws.CreateShortcut($lnkPath)
        $target = ''
        if ($shortcut.TargetPath) {
            try { $target = [IO.Path]::GetFullPath($shortcut.TargetPath) } catch { $target = $shortcut.TargetPath }
        }
        $prefix = $Root + '\'
        if ($target -and ($target -eq $Root -or $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase))) {
            Remove-Item -LiteralPath $lnkPath -Force
            Say "已删除桌面快捷方式：$lnkPath"
        } else {
            Say "保留桌面快捷方式（目标不是本目录）：$lnkPath" 'Yellow'
        }
    }
} catch {
    Say "删除桌面快捷方式失败：$($_.Exception.Message)" 'Yellow'
}

# 3. 可选：删除历史任务、材料、报告和 Edge 配置
if ($DataRoot) {
    $dataRoot = [IO.Path]::GetFullPath($DataRoot)
} else {
    $dataRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ReportWriter'
}
if ($deleteData) {
    if (Test-Path -LiteralPath $dataRoot) {
        try {
            $profileDir = Join-Path $dataRoot 'edge-profile'
            Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.CommandLine -and
                    $_.CommandLine.IndexOf($profileDir, [StringComparison]::OrdinalIgnoreCase) -ge 0
                } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Milliseconds 500
            Remove-Item -LiteralPath $dataRoot -Recurse -Force
            Say "已删除历史任务和报告：$dataRoot"
        } catch {
            Say "删除历史任务失败：$($_.Exception.Message)" 'Yellow'
            Say "可以关闭 Edge 窗口后手动删除：$dataRoot" 'Yellow'
        }
    } else {
        Say "没有历史任务目录：$dataRoot"
    }
} else {
    Say "历史任务和报告已保留：$dataRoot" 'Green'
}

# 4. 删除程序文件（只删已知文件，避免误删同目录里的其他资料）
$knownFiles = @(
    '.gitattributes', '.gitignore', 'app.py', 'app.log', 'config.json',
    'install.ps1', 'LICENSE', 'README.md', 'requirements.txt',
    '一键安装.bat', '一键安装.exe', 'ReportWriter.exe',
    '启动ReportWriter.bat', '一键卸载.exe', 'uninstall.ps1'
)
$knownDirs = @('assets', 'web', 'vendor', 'tools', '示例', '__pycache__')
$selfPath = ''
if ($PSCommandPath) {
    try { $selfPath = [IO.Path]::GetFullPath($PSCommandPath) } catch {}
}

foreach ($rel in $knownFiles) {
    $p = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $p)) { continue }
    if ($selfPath -and ([IO.Path]::GetFullPath($p) -eq $selfPath)) {
        Say "跳过正在运行的卸载脚本：$rel" 'Yellow'
        continue
    }
    try {
        Remove-Item -LiteralPath $p -Recurse -Force
        Say "已删除：$rel"
    } catch {
        Say "删除失败：$rel（$($_.Exception.Message)）" 'Yellow'
    }
}
foreach ($rel in $knownDirs) {
    $p = Join-Path $Root $rel
    if (-not (Test-Path -LiteralPath $p)) { continue }
    try {
        Remove-Item -LiteralPath $p -Recurse -Force
        Say "已删除目录：$rel"
    } catch {
        Say "删除失败：$rel（$($_.Exception.Message)）" 'Yellow'
    }
}

# 5. 目录空了就删掉；有用户自己的文件则保留
$remaining = @(Get-ChildItem -LiteralPath $Root -Force -ErrorAction SilentlyContinue)
if ($remaining.Count -eq 0) {
    try {
        Remove-Item -LiteralPath $Root -Force
        Say "已删除空目录：$Root" 'Green'
    } catch {
        Say "程序目录未能删除：$Root" 'Yellow'
    }
} else {
    Say "程序文件已清理，但目录里还有其他文件，未删除：$Root" 'Yellow'
}

Say ''
if ($deleteData) {
    Say '卸载完成：程序和历史任务都已删除。' 'Green'
} else {
    Say '卸载完成：程序已删除，历史任务保留。' 'Green'
}
Say 'DSH、nuist-stem-lab-report skill、Python、Word 均未改动。'
if (-not $NoPause) {
    Read-Host '按回车退出' | Out-Null
}

# 如果自己是从 %TEMP%\ReportWriter-uninstall-* 运行的，退出后清掉临时副本
try {
    $scriptDir = Split-Path -Parent $PSCommandPath
    if ($scriptDir -and (Split-Path -Leaf $scriptDir) -like 'ReportWriter-uninstall-*') {
        Start-Process -FilePath $env:ComSpec `
            -ArgumentList "/c timeout /t 2 /nobreak >nul & rmdir /s /q `"$scriptDir`"" `
            -WindowStyle Hidden
    }
} catch {}
