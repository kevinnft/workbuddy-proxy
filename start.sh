#!/usr/bin/env bash
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

if [ ! -d node_modules ]; then
  npm install
fi

exec node server.js
