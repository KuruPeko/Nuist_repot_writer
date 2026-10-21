# ReportWriter 一键安装（Windows，无需管理员权限）
# 做四件事：找依赖 → 装 pypdf 到 vendor\ → 按检测结果写 config.json → 自检 + 建桌面快捷方式
# 不写注册表、不改系统 PATH、不装服务。
# 用法：双击 一键安装.exe；脚本方式：powershell -ExecutionPolicy Bypass -File install.ps1 [-NoLaunch]

param(
    [switch]$NoLaunch,
    [string]$WorkRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Root       = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Root 'config.json'
$VendorDir  = Join-Path $Root 'vendor'
$DesktopDir = [Environment]::GetFolderPath('Desktop')
$Total      = 7
$script:WarnCount = 0
$script:Step = 0

# ---------- 输出小工具 ----------
function Step($title) {
    $script:Step++
    Write-Host ''
    Write-Host ("[{0}/{1}] {2}" -f $script:Step, $Total, $title) -ForegroundColor Cyan
}
function Ok($msg)   { Write-Host "      √ $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "      · $msg" -ForegroundColor Gray }
function Warn($msg) { $script:WarnCount++; Write-Host "      ! $msg" -ForegroundColor Yellow }
function Die($msg) {
    Write-Host "      × $msg" -ForegroundColor Red
    Write-Host ''
    Write-Host '安装中止。把上面的错误信息发给作者即可。' -ForegroundColor Red
    if (-not $NoLaunch) { Read-Host '按回车退出' | Out-Null }
    exit 1
}

# 跑外部命令并把 stderr 也收进来：PowerShell 5.1 在 EAP=Stop 下会把原生命令的 stderr 当异常抛出
function Invoke-Native($exe, [string[]]$cmdArgs) {
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $merged = & $exe @cmdArgs 2>&1
        $code = $LASTEXITCODE
        $lines = @()
        foreach ($item in $merged) { $lines += ("$item") }
        return [pscustomobject]@{ Code = $code; Lines = $lines; Text = ($lines -join "`n").Trim() }
    } catch {
        return [pscustomobject]@{ Code = 1; Lines = @("$($_.Exception.Message)"); Text = "$($_.Exception.Message)" }
    } finally {
        $ErrorActionPreference = $old
    }
}

function Read-Config {
    if (-not (Test-Path -LiteralPath $ConfigPath)) { return @{} }
    try {
        $obj = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $hash = @{}
        foreach ($p in $obj.PSObject.Properties) { $hash[$p.Name] = $p.Value }
        return $hash
    } catch {
        Warn "config.json 读不动（$($_.Exception.Message)），按「没有配置」继续"
        return @{}
    }
}

function Expand-Path($p) {
    if ([string]::IsNullOrWhiteSpace($p)) { return $null }
    $p = [Environment]::ExpandEnvironmentVariables($p)
    if ($p.StartsWith('~')) { $p = Join-Path $env:USERPROFILE $p.Substring(1).TrimStart('\', '/') }
    if (-not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $Root $p }
    return [IO.Path]::GetFullPath($p)
}

# ---------- 0. 开场 ----------
Write-Host ''
Write-Host '  ┌──────────────────────────────────────────────┐' -ForegroundColor DarkCyan
Write-Host '  │  ReportWriter · 实验报告生成器  一键安装      │' -ForegroundColor DarkCyan
Write-Host '  └──────────────────────────────────────────────┘' -ForegroundColor DarkCyan
Info "安装目录：$Root"
if (-not (Test-Path -LiteralPath (Join-Path $Root 'app.py'))) {
    Die "这里没有 app.py。请把本脚本放在解压出来的 ReportWriter 文件夹里再运行。"
}

$cfg = Read-Config

# ---------- 1. Python ----------
Step '检查 Python'
$pyCandidates = @()
$cfgPy = Expand-Path $cfg['python']
if ($cfgPy) { $pyCandidates += ,@($cfgPy, @()) }
$pyCandidates += ,@((Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'), @())
$pyCandidates += ,@('python.exe', @())
$pyCandidates += ,@('py.exe', @('-3'))

$Python = $null
$PyArgs = @()
foreach ($cand in $pyCandidates) {
    $exe = $cand[0]
    $extra = $cand[1]
    $resolved = $null
    if (Test-Path -LiteralPath $exe) {
        $resolved = (Resolve-Path -LiteralPath $exe).Path
    } else {
        $cmd = Get-Command $exe -ErrorAction SilentlyContinue
        if ($cmd) { $resolved = $cmd.Source }
    }
    if (-not $resolved) { continue }
    $probe = Invoke-Native $resolved (@($extra) + @('-c', 'import sys;print(sys.version_info[0])'))
    if ($probe.Code -eq 0 -and $probe.Text.Trim() -eq '3') {
        $Python = $resolved
        $PyArgs = $extra
        break
    }
}
if (-not $Python) {
    Write-Host ''
    Write-Host '  没找到可用的 Python 3。' -ForegroundColor Red
    Write-Host '  最省事的做法：先装好 DSH（它自带 Python），再回来运行本脚本；' -ForegroundColor Yellow
    Write-Host '  或者自己装 Python 3.10+ 并勾选 "Add python.exe to PATH"。' -ForegroundColor Yellow
    Die '缺少 Python 3'
}
$verProbe = Invoke-Native $Python (@($PyArgs) + @('-c', "import sys;print('.'.join(map(str,sys.version_info[:3])))"))
Ok "Python $($verProbe.Text)"
Info $Python

$depProbe = Invoke-Native $Python (@($PyArgs) + @('-c', 'import docx, PIL'))
if ($depProbe.Code -ne 0) {
    Warn '这个 Python 里没有 python-docx / Pillow，封面生成会失败；建议改用 DSH 自带的 Python'
}

# 写回 config 时用可移植的 %USERPROFILE% 前缀
$PyForConfig = $Python
if ($PyForConfig.StartsWith($env:USERPROFILE, 'OrdinalIgnoreCase')) {
    $PyForConfig = '%USERPROFILE%' + $PyForConfig.Substring($env:USERPROFILE.Length)
}

# ---------- 2. dsh ----------
Step '查找 dsh'
$DshCandidates = @()
$cfgDsh = Expand-Path $cfg['dsh']
if ($cfgDsh) { $DshCandidates += $cfgDsh }
foreach ($name in @('dsh.cmd', 'dsh.exe', 'dsh')) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue
    if ($cmd) { $DshCandidates += $cmd.Source }
}
$DshCandidates += 'D:\dsh\resources\runtime\cli\bin\dsh.cmd'
$DshCandidates += 'C:\dsh\resources\runtime\cli\bin\dsh.cmd'
$DshCandidates += (Join-Path $env:LOCALAPPDATA 'Programs\dsh\resources\runtime\cli\bin\dsh.cmd')

$Dsh = $null
foreach ($c in $DshCandidates) {
    if ($c -and (Test-Path -LiteralPath $c)) { $Dsh = $c; break }
}
if (-not $Dsh) {
    Write-Host '      没自动找到 dsh.cmd。' -ForegroundColor Yellow
    Info '通常在这里：<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd'
    $ans = Read-Host '      请粘贴 dsh.cmd 的完整路径（直接回车 = 跳过，软件里写作功能将不可用）'
    if ($ans) {
        $ans = $ans.Trim('"', ' ')
        if (Test-Path -LiteralPath $ans) { $Dsh = (Resolve-Path -LiteralPath $ans).Path }
        else { Warn "这个路径不存在：$ans" }
    }
}
if ($Dsh) { Ok $Dsh } else { Warn '没配 dsh：封面、材料整理照常可用，但「开始写报告」会失败' }

# DSH 写报告需要鉴权：桌面端登录账号，或 DEEPSEEK_API_KEY
$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$CredPath = Join-Path $DshHome '.credentials.yaml'
$HeadlessPatch = Join-Path $DshHome 'profiles\headless\cordis.patch.yml'
$HasAccount = $false
$HasApiKey = [bool]$env:DEEPSEEK_API_KEY
$HasRoute = $false
try {
    if (Test-Path -LiteralPath $CredPath) {
        $CredText = Get-Content -LiteralPath $CredPath -Raw -Encoding UTF8
        $HasAccount = ($CredText -match 'deepseek-account-platform/default:') -and
                      ($CredText -match 'token:') -and
                      ($CredText -notmatch 'dsh_mock_')
    }
    if (Test-Path -LiteralPath $HeadlessPatch) {
        $HasRoute = (Get-Content -LiteralPath $HeadlessPatch -Raw -Encoding UTF8) -match 'agent-default-model'
    }
} catch {}
if ($HasAccount) {
    Ok '检测到 DSH 已登录账号（headless 会自动使用账号路由）'
} elseif ($HasApiKey) {
    Ok '检测到环境变量 DEEPSEEK_API_KEY'
} elseif ($HasRoute) {
    Ok '检测到 headless profile 的自定义模型配置'
} else {
    Warn 'DSH 还没有登录账号，也没有配置 DEEPSEEK_API_KEY'
    Info '请先打开 DeepSeek Harness 登录，或设置 DEEPSEEK_API_KEY；否则「开始写报告」会报 no API key'
}

# ---------- 3. skill ----------
Step '检查 nuist-stem-lab-report skill'
$SkillCandidates = @()
$cfgSkill = Expand-Path $cfg['skill_root']
if ($cfgSkill) { $SkillCandidates += $cfgSkill }
$SkillCandidates += (Join-Path $env:USERPROFILE '.agents\skills\nuist-stem-lab-report')

$Skill = $null
foreach ($c in $SkillCandidates) {
    if ($c -and (Test-Path -LiteralPath (Join-Path $c 'SKILL.md'))) { $Skill = $c; break }
}
if ($Skill) {
    Ok $Skill
} else {
    $Skill = Join-Path $env:USERPROFILE '.agents\skills\nuist-stem-lab-report'
    Warn "没找到 skill。请把它放到：$Skill"
    Info 'skill 决定报告的章节结构、课程模板和验收标准；缺了它报告质量会明显下降。'
}

# ---------- 4. pypdf ----------
Step '准备 pypdf（PDF 取字用）'
if (-not (Test-Path -LiteralPath $VendorDir)) { New-Item -ItemType Directory -Path $VendorDir | Out-Null }
$env:PYTHONPATH = $VendorDir
$pypdfProbe = Invoke-Native $Python (@($PyArgs) + @('-c', 'import pypdf'))
if ($pypdfProbe.Code -eq 0) {
    $v = Invoke-Native $Python (@($PyArgs) + @('-c', 'import pypdf;print(pypdf.__version__)'))
    Ok "已有 pypdf $($v.Text)（vendor\ 内置，无需联网）"
} elseif (Test-Path -LiteralPath (Join-Path $VendorDir 'pypdf\__init__.py')) {
    # 包在，但当前 Python 导入失败：最常见的是 Python 低于 3.9
    Warn 'vendor\ 里已内置 pypdf，但当前 Python 无法导入（pypdf 需要 Python 3.9+）'
    Info '请改用 DSH 自带的 Python（安装脚本会优先选它），或升级 Python 3'
} else {
    Info 'vendor\ 里没有 pypdf（可能下载时漏了），尝试用 pip 安装…'
    $pip = Invoke-Native $Python (@($PyArgs) + @('-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check',
            '-r', (Join-Path $Root 'requirements.txt'), '--target', $VendorDir))
    foreach ($line in $pip.Lines) {
        if ($line -match 'Successfully installed|ERROR|error:|Could not|No matching') { Info $line }
    }
    $pypdfProbe = Invoke-Native $Python (@($PyArgs) + @('-c', 'import pypdf'))
    if ($pypdfProbe.Code -eq 0) {
        $v = Invoke-Native $Python (@($PyArgs) + @('-c', 'import pypdf;print(pypdf.__version__)'))
        Ok "pypdf $($v.Text) 已装进 vendor\"
    } else {
        Warn 'pypdf 没装上：PDF 材料将抽不出文字（图片、DOCX、TXT 不受影响）'
        Info '完整仓库的 vendor\ 已内置 pypdf；重新解压一份仓库即可，无需联网安装'
    }
}

# ---------- 5. 选择工作区 ----------
Step '选择工作区'
$DefaultWork = Expand-Path $cfg['work_root']
if (-not $DefaultWork) { $DefaultWork = Join-Path $env:LOCALAPPDATA 'ReportWriter\tasks' }
$WorkRootChosen = if ($WorkRoot) { Expand-Path $WorkRoot } else { '' }

if (-not $WorkRootChosen) {
    Info '任务目录、材料和输出报告都会放在这个根目录下。'
    Info '推荐 C: 盘纯英文路径；D: 盘也可以，安装器会尝试补 DSH 沙箱需要的 ACL。'
    $ans = Read-Host "  工作区根目录（回车使用：$DefaultWork）"
    if ([string]::IsNullOrWhiteSpace($ans)) { $WorkRootChosen = $DefaultWork }
    else { $WorkRootChosen = Expand-Path ($ans.Trim().Trim('"')) }
}

$Who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
while ($true) {
    if ([string]::IsNullOrWhiteSpace($WorkRootChosen)) { $WorkRootChosen = $DefaultWork }
    $ascii = $WorkRootChosen -match '^[\x20-\x7E]+$'
    $drive = [IO.Path]::GetPathRoot($WorkRootChosen)
    if (-not $ascii -or $drive -notmatch '^[Cc]:\\$') {
        Warn '这个路径不是 C: 盘或包含非 ASCII 字符；DSH 沙箱需要 WRITE_DAC/WRITE_OWNER。'
        Info "安装器会尝试给当前用户 $Who 补 FullControl；失败时会让你换路径。"
        if (-not $WorkRoot) {
            $ok = Read-Host '  继续使用这个路径吗？(y/N)'
            if ($ok -notmatch '^[Yy]') {
                $ans = Read-Host "  换一个路径（回车使用默认：$DefaultWork）"
                if ([string]::IsNullOrWhiteSpace($ans)) { $WorkRootChosen = $DefaultWork }
                else { $WorkRootChosen = Expand-Path ($ans.Trim().Trim('"')) }
                continue
            }
        }
    }

    try {
        if (Test-Path -LiteralPath $WorkRootChosen -PathType Leaf) { throw '这是一个文件，不是目录' }
        if (-not (Test-Path -LiteralPath $WorkRootChosen)) {
            New-Item -ItemType Directory -Path $WorkRootChosen -Force | Out-Null
        }
        $WorkRootChosen = (Resolve-Path -LiteralPath $WorkRootChosen).Path.TrimEnd('\', '/')
        if ($WorkRootChosen -match '^[A-Za-z]:$') { throw '请不要使用磁盘根目录作为工作区' }
        $probe = Join-Path $WorkRootChosen ('.rw_write_test_' + [guid]::NewGuid().ToString('N'))
        Set-Content -LiteralPath $probe -Value 'ok' -Encoding ASCII
        Remove-Item -LiteralPath $probe -Force
    } catch {
        Warn "工作区不可用：$($_.Exception.Message)"
        if ($WorkRoot) { throw }
        $ans = Read-Host "  换一个路径（回车使用默认：$DefaultWork）"
        if ([string]::IsNullOrWhiteSpace($ans)) { $WorkRootChosen = $DefaultWork }
        else { $WorkRootChosen = Expand-Path ($ans.Trim().Trim('"')) }
        continue
    }

    # DSH 的 workspace-write 沙箱要修改工作区 DACL；Modify 权限不够，需要 FullControl/WRITE_DAC。
    Info '正在给工作区补 DSH 沙箱所需的 ACL（当前用户 FullControl）…'
    $grant = Invoke-Native 'icacls.exe' @($WorkRootChosen, '/grant', "$($Who):(OI)(CI)F", '/T', '/C')
    if ($grant.Code -ne 0) {
        $read = Invoke-Native 'icacls.exe' @($WorkRootChosen)
        if ($read.Code -ne 0 -or $read.Text -notmatch [regex]::Escape($Who)) {
            Warn "无法给工作区补完全控制权限：$($grant.Text)"
            Warn 'DSH 沙箱仍然会报 grantWrite 失败。'
            if ($WorkRoot) { throw '工作区 ACL 修复失败' }
            $ans = Read-Host "  换一个路径（回车使用默认：$DefaultWork）"
            if ([string]::IsNullOrWhiteSpace($ans)) { $WorkRootChosen = $DefaultWork }
            else { $WorkRootChosen = Expand-Path ($ans.Trim().Trim('"')) }
            continue
        }
        Warn '根目录权限已补上，但部分子文件更新失败；新任务目录会继承 FullControl。'
    } else {
        Ok '已补充工作区 ACL（当前用户 FullControl）'
    }
    break
}
$WorkRoot = $WorkRootChosen
Ok "工作区：$WorkRoot"

# ---------- 6. 写 config.json ----------
Step '写入 config.json'
$patch = [ordered]@{
    python       = $PyForConfig
    vendor       = 'vendor'
    skill_root   = $Skill
    work_root    = $WorkRoot
    timeout      = 2700
    port         = 8791
    open_browser = $true
}
if ($Dsh) { $patch['dsh'] = $Dsh }

$patchFile = Join-Path ([IO.Path]::GetTempPath()) ("rw_patch_{0}.json" -f ([guid]::NewGuid().ToString('N')))
($patch | ConvertTo-Json -Depth 4) | Set-Content -LiteralPath $patchFile -Encoding UTF8

$pyPatch = @'
import json, os, sys
base, patch = sys.argv[1], sys.argv[2]
data = {}
if os.path.exists(base):
    try:
        with open(base, encoding='utf-8-sig') as f:
            data = json.load(f)
    except Exception:
        data = {}
with open(patch, encoding='utf-8-sig') as f:
    data.update(json.load(f))
if not data.get('dsh'):
    data.pop('dsh', None)
with open(base, 'w', encoding='utf-8', newline='\n') as f:
    f.write(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
print('keys:', ', '.join(sorted(data)))
'@
$cfgWrite = Invoke-Native $Python (@($PyArgs) + @('-c', $pyPatch, $ConfigPath, $patchFile))
Remove-Item -LiteralPath $patchFile -Force -ErrorAction SilentlyContinue
if ($cfgWrite.Code -ne 0) { Die "写 config.json 失败：$($cfgWrite.Text)" }
Info $cfgWrite.Text
Ok "已写 $ConfigPath（UTF-8 无 BOM）"

# ---------- 6. 自检 + 快捷方式 ----------
Step '自检：生成一张封面预览和一份封面 DOCX'
$pyTest = @'
import os, sys, tempfile, pathlib, shutil
root = sys.argv[1]
sys.path.insert(0, root)
os.chdir(root)
import app
app.load_config()
info = {'course': '安装自检', 'title': '一键安装自检实验', 'name': '自检', 'cls': '自检班',
        'sid': '202400000000', 'teacher': '自检老师', 'date': '2026-01-01'}
png = app.render_cover_png(info)
print('PREVIEW %d' % len(png))
tmp = pathlib.Path(tempfile.mkdtemp())
try:
    out = tmp / '封面.docx'
    app.build_cover_docx(info, out)
    import docx
    d = docx.Document(str(out))
    print('DOCX %d paras=%d sections=%d imgs=%d' % (
        out.stat().st_size, len(d.paragraphs), len(d.sections), len(d.inline_shapes)))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print('CONFIG dsh=%s' % (app.CONFIG.get('dsh') or '(未配置)'))
print('CONFIG python=%s' % app.CONFIG.get('python'))
print('CONFIG skill=%s' % (app.CONFIG.get('skill_root') or '(未配置)'))
try:
    mode, note = app.dsh_auth_state()
    print('AUTH %s %s' % (mode, note))
except Exception as e:
    print('AUTH unknown %s' % e)
print('SELFTEST OK')
'@
$test = Invoke-Native $Python (@($PyArgs) + @('-c', $pyTest, $Root))
foreach ($line in $test.Lines) {
    if ($line -match '^(PREVIEW|DOCX|CONFIG|AUTH|SELFTEST)') { Info $line }
    elseif ($line.Trim()) { Warn $line }
}
if ($test.Code -ne 0) { Die '自检失败（上面是 Python 的原始报错）' }
Ok '封面能生成、能落盘，配置读得动'

if ($DesktopDir -and (Test-Path -LiteralPath $DesktopDir)) {
    try {
        $lnkPath = Join-Path $DesktopDir 'ReportWriter.lnk'
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut($lnkPath)
        $AppExe = Join-Path $Root 'ReportWriter.exe'
        if (-not (Test-Path -LiteralPath $AppExe)) { throw '找不到 ReportWriter.exe，跳过桌面快捷方式' }
        $lnk.TargetPath = $AppExe
        $lnk.WorkingDirectory = $Root
        $lnk.Description = 'ReportWriter · 实验报告生成器'
        $IconPath = Join-Path $Root 'assets\app.ico'
        if (Test-Path -LiteralPath $IconPath) { $lnk.IconLocation = "$IconPath,0" }
        $lnk.Save()
        Ok "桌面快捷方式：$lnkPath"
    } catch {
        Warn "桌面快捷方式没建成：$($_.Exception.Message)"
    }
}

# ---------- 收尾 ----------
Write-Host ''
if ($script:WarnCount -gt 0) {
    Write-Host "  安装完成（有 $script:WarnCount 条提醒，见上面 ! 行）" -ForegroundColor Yellow
} else {
    Write-Host '  安装完成，一切正常' -ForegroundColor Green
}
Write-Host '  用法：双击桌面 ReportWriter，或运行 ReportWriter.exe' -ForegroundColor Gray
Write-Host '  卸载：双击程序目录里的 一键卸载.exe' -ForegroundColor Gray
Write-Host ''
$launch = 'n'
if (-not $NoLaunch) { $launch = Read-Host '  现在就启动 ReportWriter 吗？(Y/n)' }
if (-not $NoLaunch -and ($launch -eq '' -or $launch -match '^[Yy]')) {
    $AppExe = Join-Path $Root 'ReportWriter.exe'
    if (Test-Path -LiteralPath $AppExe) {
        Start-Process -FilePath $AppExe -WorkingDirectory $Root
        Write-Host '  已启动，窗口马上出来。' -ForegroundColor Green
    } else {
        Warn '找不到 ReportWriter.exe，无法自动启动'
    }
}
Write-Host ''
if (-not $NoLaunch) { Read-Host '按回车关闭安装窗口' | Out-Null }
