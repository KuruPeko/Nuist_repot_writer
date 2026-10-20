# 重新生成根目录的 一键安装.exe（需要 Windows 自带的 .NET Framework csc.exe）。
# 图标来自 assets\app.ico；不签名，首次下载运行时可能出现 SmartScreen 提示。
$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Csc = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $Csc) { throw '找不到 csc.exe（需要 .NET Framework 4.x）' }
$Icon = Join-Path $Root 'assets\app.ico'
if (-not (Test-Path -LiteralPath $Icon)) { throw "找不到图标：$Icon" }

$Targets = @(
    @{ Source = 'InstallLauncher.cs'; Out = '一键安装.exe' },
    @{ Source = 'AppLauncher.cs';     Out = 'ReportWriter.exe' }
)
foreach ($t in $Targets) {
    $Source = Join-Path $PSScriptRoot $t.Source
    $Out = Join-Path $Root $t.Out
    & $Csc /nologo /target:winexe /optimize+ /codepage:65001 `
        /r:System.Windows.Forms.dll `
        "/win32icon:$Icon" "/out:$Out" $Source
    if ($LASTEXITCODE -ne 0) { throw "csc 编译失败：$($t.Source)（退出码 $LASTEXITCODE）" }
    $fi = Get-Item -LiteralPath $Out
    Write-Host ("已生成：{0}（{1:N1} KB）" -f $fi.FullName, ($fi.Length / 1KB)) -ForegroundColor Green
}
