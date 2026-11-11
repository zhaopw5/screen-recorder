@echo off
title DeepSeek Screen Recorder
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js not found. Please install Node.js 20+ first:
  echo   https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules\sherpa-onnx-node\sherpa-onnx.js" (
  echo.
  echo   Missing speech engine: node_modules\sherpa-onnx-node
  echo   Please unzip the complete folder again.
  echo.
  pause
  exit /b 1
)

node server.mjs
echo.
echo   Server stopped. Press any key to close.
pause >nul
