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

## Update (existing install)

```bash
git pull
npm install          # only needed when dependencies changed
# restart: start.sh / start.cmd, or: systemctl --user restart workbuddy-proxy
```

`start.sh` re-runs `npm install` automatically when `node_modules` is missing,
so on Ubuntu a plain `git pull && ./start.sh` is enough.

The running version is shown in the console header (`v1.1.0`) and under
**Settings → Upstream**. `GET /health` returns it as `version`.

## OpenAI client

```
base_url = http://127.0.0.1:8790/v1
api_key  = value of proxyKey in config.json
model    = hy3 | hy4-preview | gpt-5.6-luna | …
```

If a model is set to `high` under **Models**, the proxy injects `reasoning_effort` even when the client omits it.

WorkBuddy chat is SSE-only. Non-stream OpenAI calls are still streamed upstream, then assembled.

## Remaining credits

The console has a **Credits** tab showing how much quota is left, per package.

Under the hood it calls the same endpoint the WorkBuddy desktop app uses:

```
POST https://www.workbuddy.ai/v2/billing/meter/get-user-resource
{ "PageNumber": 1, "PageSize": 100, "ProductCode": "p_tcaca",
  "Status": [0, 3], "OnlyValidPeriod": true }
```

The response `data.Response.Data.Accounts[]` gives one entry per package with
`CycleCapacitySizePrecise` (total), `CycleCapacityRemainPrecise` (left) and
`CycleEndTime` (reset).

The proxy exposes it as:

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /admin/credits` | loopback only | used by the UI, `?force=1` bypasses cache |
| `GET /v1/credits` | `Bearer <proxyKey>` | `?account=<email\|uid>`, `?force=1` |

Results are cached per account for 60 seconds. `force=1` re-hits upstream.

```bash
curl -s -H "Authorization: Bearer $PROXY_KEY" \
  http://127.0.0.1:8790/v1/credits | jq '.accounts[0] | {usageLeft, usageUsed, usageTotal}'
```

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
CHANGELOG.md       release notes
```

See [CHANGELOG.md](CHANGELOG.md) for the version history.
