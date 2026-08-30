@echo off
REM Launcher for Windows. Safe to run after `git pull`.
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18+ required: https://nodejs.org/
  exit /b 1
)

if not exist config.json (
  copy config.example.json config.json >nul
  echo created config.json from example - set proxyKey, then login via http://127.0.0.1:8790/
)

if not exist proxies.txt (
  copy proxies.example.txt proxies.txt >nul
)

if not exist node_modules (
  echo installing dependencies...
  call npm install
)

for /f "usebackq delims=" %%v in (`node -p "require('./package.json').version" 2^>nul`) do set WBVER=%%v
if not defined WBVER set WBVER=?
echo workbuddy-proxy v%WBVER% ^-^> http://127.0.0.1:8790/

node server.js
