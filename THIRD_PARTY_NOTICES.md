# 第三方组件说明

本项目的自有代码以 MIT 协议发布（见 `LICENSE`）。仓库里还包含或运行时会用到下列第三方组件，它们各自遵循自己的许可证。

## 已随仓库提供

### sherpa-onnx（`vendor/sherpa-onnx-node`、`vendor/sherpa-onnx-win-x64`）

- 项目：https://github.com/k2-fsa/sherpa-onnx
- 许可证：Apache License 2.0
- 说明：本地语音识别运行时，含 ONNX Runtime 动态库。仓库内为 Windows x64 预编译版本（v1.13.8），仅用于免安装运行。

## 由 `setup.ps1` 下载，不随仓库分发

### SenseVoiceSmall 模型

- 项目：https://github.com/FunAudioLLM/SenseVoice
- 模型发布页：https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
- 说明：中英日韩粤语音识别模型（int8 量化，约 228 MB）。使用前请阅读上游模型卡与许可证。

### Silero VAD

- 项目：https://github.com/snakers4/silero-vad
- 许可证：MIT
- 说明：语音活动检测模型（约 1.8 MB），用于自动断句。

### FFmpeg

- 项目：https://ffmpeg.org/
- 许可证：LGPL 2.1+ / GPL 2+（取决于构建选项，本项目下载的是 gyan.dev 的 essentials 构建）
- 说明：仅用于给网页录像补写时长信息、抽取封面帧；不是运行必需项。

## 其他

- Electron（MIT）、Node.js（MIT）等依赖的许可证见各自 npm 包。
- 本项目与 DeepSeek、DeepSeek Harness 无隶属关系。仓库中出现的相关名称仅用于说明可选的配置来源。
