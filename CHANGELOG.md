# Changelog

Semantic versioning. `version` lives in `package.json` and is reported by
`GET /health` and `GET /admin/state`, and shown in the console header.

## 1.1.0 — 2026-08-30

Added — remaining credits
- New upstream client for the WorkBuddy billing endpoint
  `POST /v2/billing/meter/get-user-resource`, the same one the desktop app uses
  for its credit balance.
- New endpoints:
  - `GET /admin/credits` — loopback only, used by the UI, `?force=1` bypasses cache
  - `GET /v1/credits` — `Bearer <proxyKey>`, supports `?account=<email|uid>` and `?force=1`
- Per-account cache, 60s TTL.
- Full `COMMODITY_CODES` table (20 package codes) so raw package codes are shown
  as readable names (Pro Trial Monthly, Bonus Pack, …).
- New **Credits** tab in the console: per-package rows with left/used/total,
  a progress bar, reset/expiry date, and Sisa/Terpakai/Total KPIs in the toolbar.

Added — version reporting
- `package.json` version is read at startup and exposed as `version` on
  `GET /health` and `GET /admin/state`.
- Console shows it in the header pill and under **Settings → Upstream**.

Changed
- `start.sh` (Ubuntu/macOS) re-runs `npm install` when `node_modules` is missing,
  so `git pull && ./start.sh` works on a fresh clone.

## 1.0.0 — 2026-08-28

- Initial release: OpenAI-compatible `/v1/chat/completions` (stream + non-stream)
  in front of WorkBuddy desktop quota.
- Keycloak token import from the desktop app, browser login flow, token refresh.
- Account round-robin, `reasoning_effort` per model, HTTP egress proxy pool
  (round-robin / sticky) with health check and prune.
- Web console: chat, request log with usage stats, model list, proxy manager,
  account manager, settings.
