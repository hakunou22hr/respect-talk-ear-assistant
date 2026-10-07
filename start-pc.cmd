@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS from https://nodejs.org/ and run this file again.
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo Enter your Gemini API key in .env, save it, then run this file again.
  start "" notepad ".env"
  pause
  exit /b 0
)
echo Open http://localhost:8787 in Chrome or Edge after the server starts.
echo Keep this window open. Press Ctrl+C to stop the server.
node --env-file-if-exists=.env server/local.js
pause
