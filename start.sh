#!/usr/bin/env bash
# Launcher for Ubuntu/macOS. Safe to run after `git pull`.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18+ required. Ubuntu: sudo apt-get install -y nodejs npm" >&2
  exit 1
fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "created config.json from example — set proxyKey, then login via http://127.0.0.1:8790/"
fi

if [ ! -f proxies.txt ]; then
  cp proxies.example.txt proxies.txt
fi

# Reinstall when deps are missing or package.json is newer than the install
# (handles a fresh clone and a pull that bumped dependencies).
NEED_INSTALL=0
if [ ! -d node_modules ]; then
  NEED_INSTALL=1
elif [ package.json -nt node_modules ]; then
  NEED_INSTALL=1
fi
if [ "$NEED_INSTALL" -eq 1 ]; then
  echo "installing dependencies..."
  npm install
  touch node_modules
fi

if [ -f package.json ]; then
  VER=$(node -p "require('./package.json').version" 2>/dev/null || echo "?")
  echo "workbuddy-proxy v${VER} → http://127.0.0.1:8790/"
fi

exec node server.js
