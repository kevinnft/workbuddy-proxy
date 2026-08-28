# WorkBuddy Proxy

Local OpenAI-compatible API + web console for [WorkBuddy](https://www.workbuddy.ai/) desktop quota.

Chat completions and reasoning tokens come from WorkBuddy (`POST https://www.workbuddy.ai/v2/chat/completions`). This process only forwards: auth headers, account round-robin, optional HTTP egress, and `reasoning_effort`.

## Requirements

- Node.js 18+
- A WorkBuddy account (login in the web UI, or import a desktop session file)

## Quick start

### Windows

```bat
copy config.example.json config.json
copy proxies.example.txt proxies.txt
npm install
node server.js
```

Or `start.cmd`.

### Ubuntu / Debian

```bash
chmod +x start.sh install-ubuntu.sh
./start.sh
```

Foreground: `./start.sh`  
systemd user service:

```bash
./install-ubuntu.sh
journalctl --user -u workbuddy-proxy -f
```

Open http://127.0.0.1:8790/ → **Accounts** → Login browser.

## OpenAI client

```
base_url = http://127.0.0.1:8790/v1
api_key  = value of proxyKey in config.json
model    = hy3 | hy4-preview | gpt-5.6-luna | …
```

If a model is set to `high` under **Models**, the proxy injects `reasoning_effort` even when the client omits it.

WorkBuddy chat is SSE-only. Non-stream OpenAI calls are still streamed upstream, then assembled.

## Config (not committed)

Copy `config.example.json` → `config.json`.

| Field | Meaning |
|---|---|
| `proxyKey` | Local API key for `/v1` |
| `port` / `host` | Default `127.0.0.1:8790` |
| `importAuthFile` | Optional desktop `workbuddy-desktop-ai.info` path |
| `effortByModel` | Server-side reasoning per model id |
| `egress` | HTTP proxy pool (`proxies.txt`, `host:port:user:pass`) |

Do not commit `config.json`, `accounts.json`, `proxies.txt`, or `requests.jsonl`.

## Layout

```
server.js          HTTP server (OpenAI + admin + static UI)
egress.js          HTTP CONNECT pool (undici ProxyAgent)
public/index.html  console
start.sh           Ubuntu/macOS launcher
start.cmd          Windows launcher
install-ubuntu.sh  deps + systemd --user
```
