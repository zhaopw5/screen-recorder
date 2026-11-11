# 把 Electron 版打包安装到本机（ASCII 路径，避免 Electron 在中文路径下启动失败）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$electron = Join-Path $root 'node_modules\electron\dist'
if (-not (Test-Path (Join-Path $electron 'electron.exe'))) {
  throw '未找到 Electron，请先在本目录运行：npm install'
}

# 默认装到源码同级的 ScreenRecorder 目录（纯英文路径，避免 Electron 在中文路径下启动失败）
$install = Join-Path (Split-Path $root -Parent) 'ScreenRecorder'
if (Test-Path $install) { Remove-Item $install -Recurse -Force }
New-Item -ItemType Directory -Path $install | Out-Null

Write-Host "复制 Electron 运行时 → $install"
Copy-Item (Join-Path $electron '*') $install -Recurse -Force
Rename-Item (Join-Path $install 'electron.exe') 'ScreenRecorder.exe'
Remove-Item (Join-Path $install 'resources\default_app.asar') -Force -ErrorAction SilentlyContinue

$app = Join-Path $install 'resources\app'
New-Item -ItemType Directory -Path $app | Out-Null

Write-Host '复制应用代码…'
Copy-Item 'package.json', 'server.mjs', 'README.md' $app -Force
Copy-Item 'lib', 'public', 'electron', 'bin', 'docs', 'assets', 'models' $app -Recurse -Force
New-Item -ItemType Directory -Path (Join-Path $app 'node_modules') -Force | Out-Null
# 语音识别原生包不放在 npm 依赖里（避免 npm install 时被当成 extraneous 清掉），统一从 vendor 取
Copy-Item 'vendor\sherpa-onnx-node', 'vendor\sherpa-onnx-win-x64' (Join-Path $app 'node_modules') -Recurse -Force

# 目标目录若继承了「低完整性级别」或受限 ACL（某些沙箱工具会留下这种目录），
# 复制进去的 Electron 会启动即崩溃（0x80000003）。复制完统一恢复成普通用户目录。
$who = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $install /inheritance:r | Out-Null
& icacls.exe $install /grant:r "${who}:(OI)(CI)F" | Out-Null
& icacls.exe $install /grant "${who}:F" /T /C | Out-Null
& icacls.exe $install /setintegritylevel Medium /T /C | Out-Null

Write-Host '创建快捷方式…'
$exe = Join-Path $install 'ScreenRecorder.exe'
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {
  $lnk = $ws.CreateShortcut((Join-Path $dir '录屏助手.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $install
  $lnk.Description = '录屏助手：屏幕 + 系统声音 + 本地转写 + AI 纪要'
  $lnk.IconLocation = (Join-Path $app 'assets\icon.ico') + ',0'
  $lnk.Save()
}

$size = (Get-ChildItem $install -Recurse -File | Measure-Object Length -Sum).Sum / 1MB
Write-Host ''
Write-Host ("安装完成：{0}（{1:N0} MB）" -f $install, $size)
Write-Host '桌面和开始菜单都有「录屏助手」快捷方式了。'
