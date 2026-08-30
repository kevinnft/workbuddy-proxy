#!/usr/bin/env bash
# Install Node deps + optional systemd user service (Ubuntu 22.04/24.04).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "installing nodejs + npm..."
  sudo apt-get update -y
  sudo apt-get install -y nodejs npm
fi

node -v
npm -v
npm install

if [ ! -f config.json ]; then
  cp config.example.json config.json
fi
if [ ! -f proxies.txt ]; then
  cp proxies.example.txt proxies.txt
fi
chmod +x start.sh

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"
sed "s|__WORKDIR__|$ROOT|g; s|__NODE__|$(command -v node)|g" \
  "$ROOT/workbuddy-proxy.service" > "$UNIT_DIR/workbuddy-proxy.service"

systemctl --user daemon-reload
systemctl --user enable --now workbuddy-proxy.service
echo "running at http://127.0.0.1:8790/"
echo "logs: journalctl --user -u workbuddy-proxy -f"
echo
echo "after a git pull:  systemctl --user restart workbuddy-proxy"
