# 录屏助手 依赖准备脚本
# 用法：powershell -ExecutionPolicy Bypass -File setup.ps1
# 作用：准备本地语音识别模型（models/）和 ffmpeg（bin/），两者都不进 git 仓库。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

function Write-Step($msg) { Write-Host "  $msg" }

Write-Host ''
Write-Host '=== 录屏助手 依赖准备 ==='
Write-Host ''

# ---------------------------------------------------------------- 语音模型
$modelDir = Join-Path $root 'models\sensevoice-onnx'
$vadDir = Join-Path $root 'models\silero'
$modelPath = Join-Path $modelDir 'model.int8.onnx'
$tokensPath = Join-Path $modelDir 'tokens.txt'
$vadPath = Join-Path $vadDir 'silero_vad.onnx'

if ((Test-Path $modelPath) -and (Test-Path $tokensPath) -and (Test-Path $vadPath)) {
  Write-Step '[1/2] 语音模型已存在，跳过。'
} else {
  New-Item -ItemType Directory -Force -Path $modelDir, $vadDir | Out-Null
  $dshModels = Join-Path $env:USERPROFILE '.dsh\speech-to-text\sensevoice\models'

  if (Test-Path (Join-Path $dshModels 'sensevoice-onnx\model.int8.onnx')) {
    Write-Step "[1/2] 发现 DeepSeek Harness 的模型缓存，直接复制：$dshModels"
    Copy-Item (Join-Path $dshModels 'sensevoice-onnx\model.int8.onnx') $modelPath -Force
    Copy-Item (Join-Path $dshModels 'sensevoice-onnx\tokens.txt') $tokensPath -Force
    Copy-Item (Join-Path $dshModels 'silero\silero_vad.onnx') $vadPath -Force
  } else {
    $mirror = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
    $hf = 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
    $base = $mirror

    Write-Step '[1/2] 下载 SenseVoiceSmall int8（约 228 MB）…'
    try {
      Invoke-WebRequest "$base/model.int8.onnx" -OutFile $modelPath -UseBasicParsing
      Invoke-WebRequest "$base/tokens.txt" -OutFile $tokensPath -UseBasicParsing
    } catch {
      Write-Step "  镜像下载失败，改用 HuggingFace 官方源重试…"
      $base = $hf
      Invoke-WebRequest "$base/model.int8.onnx" -OutFile $modelPath -UseBasicParsing
      Invoke-WebRequest "$base/tokens.txt" -OutFile $tokensPath -UseBasicParsing
    }

    Write-Step '[1/2] 下载 Silero VAD（约 1.8 MB）…'
    try {
      Invoke-WebRequest 'https://hf-mirror.com/csukuangfj/vad/resolve/main/silero_vad.onnx' -OutFile $vadPath -UseBasicParsing
    } catch {
      Invoke-WebRequest 'https://huggingface.co/csukuangfj/vad/resolve/main/silero_vad.onnx' -OutFile $vadPath -UseBasicParsing
    }
  }

  $sizeMb = [Math]::Round((Get-Item $modelPath).Length / 1MB)
  Write-Step "      完成：$modelPath ($sizeMb MB)"
}

# ---------------------------------------------------------------- ffmpeg（可选）
$ffmpegPath = Join-Path $root 'bin\ffmpeg.exe'
if (Test-Path $ffmpegPath) {
  Write-Step '[2/2] ffmpeg 已存在，跳过。'
} else {
  Write-Step '[2/2] 下载 ffmpeg（约 110 MB，可跳过：没有它只会少了封面图和 webm 时长修复）…'
  $tmpDir = Join-Path $env:TEMP ('rec-ffmpeg-' + [guid]::NewGuid().ToString('N'))
  $zip = Join-Path $env:TEMP ('rec-ffmpeg-' + [guid]::NewGuid().ToString('N') + '.zip')
  try {
    $ProgressPreference = 'SilentlyContinue'
    Invoke-WebRequest 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $tmpDir -Force
    $exe = Get-ChildItem $tmpDir -Recurse -Filter ffmpeg.exe | Select-Object -First 1
    if (-not $exe) { throw '压缩包里没有找到 ffmpeg.exe' }
    New-Item -ItemType Directory -Force -Path (Split-Path $ffmpegPath) | Out-Null
    Copy-Item $exe.FullName $ffmpegPath -Force
    Write-Step "      完成：$ffmpegPath"
  } catch {
    Write-Step "      跳过 ffmpeg（$($_.Exception.Message)）。软件仍可正常录制。"
  } finally {
    Remove-Item $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host '依赖准备完成。接下来：'
Write-Host '  npm install       # 安装 Electron'
Write-Host '  npm run app       # 开发模式运行'
Write-Host '  npm run build     # 打包安装到本机并创建桌面快捷方式'
Write-Host ''
