"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const egressLib = require("./egress");

const ROOT = __dirname;
const CFG_PATH = path.join(ROOT, "config.json");
const ACC_PATH = path.join(ROOT, "accounts.json");
const PUBLIC = path.join(ROOT, "public");

const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const PORT = Number(cfg.port || 8790);
const HOST = cfg.host || "127.0.0.1";
const UPSTREAM = String(cfg.upstream || "https://www.workbuddy.ai").replace(/\/+$/, "");
const PLATFORM = cfg.platform || "workbuddy-ai";
const PREFIX = cfg.prefixPath || "/plugin";
const PRODUCT = cfg.product || "SaaS";
const CLIENT_VER = cfg.clientVersion || "5.4.2";
const IDE_TYPE = cfg.ideType || "workbuddy-ai";
const IDE_NAME = cfg.ideName || "WorkBuddy AI";
const UA = cfg.userAgent || ("WorkBuddyAI/" + CLIENT_VER);
const CHAT_PATH = cfg.chatPath || "/v2/chat/completions";
const MODELS_PATH = cfg.modelsPath || "/v3/config";
const SYS_PROMPT = cfg.systemPrompt || "You are a helpful assistant.";
const PROXY_KEY = cfg.proxyKey || "sk-wb-local-change-me";
if (!cfg.effortByModel || typeof cfg.effortByModel !== "object") cfg.effortByModel = {};

if (!cfg.egress || typeof cfg.egress !== "object") cfg.egress = { enabled: false, mode: "roundrobin", file: "proxies.txt", list: [] };
const pool = egressLib.createPool({ enabled: !!cfg.egress.enabled, mode: cfg.egress.mode || "roundrobin" });
const proxyFile = egressLib.resolveFile(ROOT, cfg.egress.file || "proxies.txt");
if (Array.isArray(cfg.egress.list) && cfg.egress.list.length) pool.loadLines(cfg.egress.list);
else pool.loadFile(proxyFile);
pool.setEnabled(!!cfg.egress.enabled);
pool.setMode(cfg.egress.mode || "roundrobin");

let accounts = loadAccounts();
let modelsCache = { at: 0, list: [] };
const pendingLogins = new Map();
let accountCursor = 0;
const requestLog = [];
const MAX_REQUESTS = 80;
const ipCache = { direct: "", labels: {} };
const LOG_PATH = path.join(ROOT, "requests.jsonl");
const DAY_MS = 86400000;
const STATS_KEEP_MS = 30 * DAY_MS;
let statsRows = [];
let saveAccTimer = null;
let logWriteBuf = [];
let logWriteTimer = null;

function loadAccounts() {
  try {
    const raw = JSON.parse(fs.readFileSync(ACC_PATH, "utf8"));
    const list = Array.isArray(raw) ? raw : raw.accounts || [];
    return list;
  } catch {
    return [];
  }
}

function saveAccounts() {
  if (saveAccTimer) return;
  saveAccTimer = setTimeout(function () {
    saveAccTimer = null;
    try {
      const tmp = ACC_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify({ accounts: accounts }));
      fs.renameSync(tmp, ACC_PATH);
    } catch (e) {
      console.error("saveAccounts", e.message);
    }
  }, 2000);
}

function compactEntry(entry) {
  const tok = entry.tokens || {};
  return {
    ts: entry.ts,
    ok: !!entry.ok,
    account: entry.account || "",
    model: entry.model || "",
    effort: entry.effort || "",
    proxy: entry.proxy || "direct",
    ip: entry.ip || "",
    ms: entry.ms || 0,
    status: entry.status || 0,
    tokens: {
      prompt: tok.prompt || 0,
      completion: tok.completion || 0,
      total: tok.total || 0,
      reasoning: tok.reasoning || 0,
    },
  };
}

function loadStatsRows() {
  statsRows = [];
  if (!fs.existsSync(LOG_PATH)) return;
  const cutoff = now() - STATS_KEEP_MS;
  let text = "";
  try { text = fs.readFileSync(LOG_PATH, "utf8"); } catch { return; }
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    try {
      const j = JSON.parse(line);
      if (j && j.ts >= cutoff) statsRows.push(j);
    } catch {}
  }
}

function flushLogBuf() {
  if (!logWriteBuf.length) return;
  const chunk = logWriteBuf.join("");
  logWriteBuf = [];
  fs.appendFile(LOG_PATH, chunk, function () {});
}

function pushRequest(entry) {
  const row = compactEntry(entry);
  requestLog.unshift(row);
  if (requestLog.length > MAX_REQUESTS) requestLog.length = MAX_REQUESTS;
  statsRows.push(row);
  const cutoff = now() - STATS_KEEP_MS;
  if (statsRows.length > 4000) {
    statsRows = statsRows.filter(function (r) { return r.ts >= cutoff; });
  }
  logWriteBuf.push(JSON.stringify(row) + "\n");
  if (!logWriteTimer) {
    logWriteTimer = setTimeout(function () {
      logWriteTimer = null;
      flushLogBuf();
    }, 400);
  }
}

function publicRequests(limit) {
  limit = Math.min(Number(limit) || 80, MAX_REQUESTS);
  return requestLog.slice(0, limit);
}

function windowStats(ms) {
  const from = now() - ms;
  let n = 0;
  let prompt = 0;
  let completion = 0;
  let reasoning = 0;
  const models = {};
  for (let i = 0; i < statsRows.length; i++) {
    const r = statsRows[i];
    if (!r || r.ts < from) continue;
    n++;
    const t = r.tokens || {};
    prompt += t.prompt || 0;
    completion += t.completion || 0;
    reasoning += t.reasoning || 0;
    const id = r.model || "unknown";
    if (!models[id]) models[id] = { n: 0, prompt: 0, completion: 0, reasoning: 0 };
    models[id].n++;
    models[id].prompt += t.prompt || 0;
    models[id].completion += t.completion || 0;
    models[id].reasoning += t.reasoning || 0;
  }
  const modelList = Object.keys(models).map(function (id) {
    const m = models[id];
    return {
      id: id,
      requests: m.n,
      tokens: m.prompt + m.completion,
      prompt: m.prompt,
      completion: m.completion,
      reasoning: m.reasoning,
    };
  }).sort(function (a, b) { return b.requests - a.requests; });
  return {
    requests: n,
    tokens: prompt + completion,
    prompt: prompt,
    completion: completion,
    reasoning: reasoning,
    models: modelList,
  };
}

function usageStats() {
  return {
    h24: windowStats(DAY_MS),
    d3: windowStats(3 * DAY_MS),
    d7: windowStats(7 * DAY_MS),
    d30: windowStats(30 * DAY_MS),
  };
}

function inferIp(label) {
  if (!label || label === "direct") return ipCache.direct || "";
  if (ipCache.labels[label]) return ipCache.labels[label];
  const host = String(label).split(":")[0];
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    ipCache.labels[label] = host;
    return host;
  }
  return "";
}

function now() {
  return Date.now();
}

function isLoopback(req) {
  const ip = req.socket.remoteAddress || "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function send(res, status, body, headers) {
  const h = Object.assign({ "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }, headers || {});
  const data = Buffer.isBuffer(body) || typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, h);
  res.end(data);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let n = 0;
    req.on("data", function (c) {
      n += c.length;
      if (n > 20 * 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", function () {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const a = req.headers.authorization || "";
  if (a.toLowerCase().startsWith("bearer ")) return a.slice(7).trim();
  return "";
}

function requireProxyKey(req, res) {
  const key = bearer(req);
  if (key !== PROXY_KEY) {
    send(res, 401, { error: { message: "Invalid API key", type: "invalid_request_error" } });
    return false;
  }
  return true;
}

function publicAccount(a) {
  return {
    id: a.id,
    email: a.email || "",
    uid: a.uid || "",
    disabled: !!a.disabled,
    requests: a.requests || 0,
    errors: a.errors || 0,
    tokens_in: a.tokens_in || 0,
    tokens_out: a.tokens_out || 0,
    last_used: a.last_used || 0,
    last_error: a.last_error || "",
    cooldown_until: a.cooldown_until || 0,
    expires_at: a.expires_at || 0,
  };
}

function upsertAccount(tok, extra) {
  extra = extra || {};
  const uid = extra.uid || extra.account && extra.account.uid || "";
  const email = extra.email || extra.account && extra.account.nickname || extra.account && extra.account.email || "";
  let acc = uid ? accounts.find(function (x) { return x.uid === uid; }) : null;
  if (!acc && email) acc = accounts.find(function (x) { return x.email === email; });
  const expiresIn = Number(tok.expiresIn || 0);
  const lastRefresh = tok.lastRefreshTime || now();
  const expiresAt = tok.expiresAt || (expiresIn ? lastRefresh + expiresIn * 1000 : 0);
  if (!acc) {
    acc = {
      id: "acc_" + crypto.randomBytes(6).toString("hex"),
      uid: uid,
      email: email,
      accessToken: tok.accessToken,
      refreshToken: tok.refreshToken,
      tokenType: tok.tokenType || "Bearer",
      sessionState: tok.sessionState || "",
      scope: tok.scope || "",
      expires_at: expiresAt,
      lastRefreshTime: lastRefresh,
      last_used: 0,
      requests: 0,
      errors: 0,
      tokens_in: 0,
      tokens_out: 0,
      disabled: false,
      last_error: "",
      cooldown_until: 0,
    };
    accounts.push(acc);
  } else {
    acc.accessToken = tok.accessToken || acc.accessToken;
    if (tok.refreshToken) acc.refreshToken = tok.refreshToken;
    acc.expires_at = expiresAt || acc.expires_at;
    acc.lastRefreshTime = lastRefresh;
    if (uid) acc.uid = uid;
    if (email) acc.email = email;
    acc.disabled = false;
    acc.last_error = "";
  }
  saveAccounts();
  return acc;
}

function importDesktopSession() {
  const p = cfg.importAuthFile;
  if (!p || !fs.existsSync(p)) return null;
  try {
    const s = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!s.auth || !s.auth.accessToken) return null;
    return upsertAccount(s.auth, { account: s.account, uid: s.account && s.account.uid, email: s.account && s.account.nickname });
  } catch (e) {
    console.error("import desktop session failed", e.message);
    return null;
  }
}

function persistCfg() {
  const tmp = CFG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CFG_PATH);
}

function currentProxyLines() {
  if (Array.isArray(cfg.egress.list) && cfg.egress.list.length) return cfg.egress.list.slice();
  if (fs.existsSync(proxyFile)) {
    return fs.readFileSync(proxyFile, "utf8").split(/\r?\n/).filter(function (line) {
      return !!egressLib.parseLine(line);
    });
  }
  return [];
}

function saveProxyLines(lines) {
  const cleaned = [];
  const seen = {};
  (lines || []).forEach(function (line) {
    const p = egressLib.parseLine(line);
    if (!p || seen[p.label]) return;
    seen[p.label] = true;
    cleaned.push(line.trim());
  });
  cfg.egress.list = cleaned;
  pool.loadLines(cleaned);
  try { fs.writeFileSync(proxyFile, cleaned.length ? cleaned.join("\n") + "\n" : "# host:port:user:pass\n"); } catch {}
  persistCfg();
  return pool.snapshot();
}

function usableAccounts() {
  const t = now();
  return accounts.filter(function (a) {
    return !a.disabled && a.accessToken && (a.cooldown_until || 0) <= t;
  });
}

function pickAccount() {
  const usable = usableAccounts();
  if (!usable.length) return null;
  if (usable.length === 1) return usable[0];
  const idx = accountCursor % usable.length;
  accountCursor = (accountCursor + 1) % usable.length;
  return usable[idx];
}

function nextUnusedAccount(tried) {
  const usable = usableAccounts();
  for (let i = 0; i < usable.length; i++) {
    if (!tried.has(usable[i].id)) return usable[i];
  }
  return null;
}

function upstreamHeaders(acc, extra) {
  const h = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-Product": PRODUCT,
    "X-Product-Version": CLIENT_VER,
    "X-IDE-Type": IDE_TYPE,
    "X-IDE-Name": IDE_NAME,
    "X-IDE-Version": CLIENT_VER,
  };
  if (acc && acc.accessToken) h.Authorization = "Bearer " + acc.accessToken;
  if (acc && acc.uid) h["X-User-Id"] = acc.uid;
  if (extra) Object.assign(h, extra);
  return h;
}

async function upFetch(url, opts) {
  opts = opts || {};
  const key = opts.stickyKey || "";
  const res = await pool.request(url, {
    method: opts.method || "GET",
    headers: opts.headers || {},
    body: opts.body,
    signal: opts.signal,
  }, key);
  return res;
}

async function refreshAccount(acc) {
  if (!acc.refreshToken) throw new Error("no refresh token");
  const res = await upFetch(UPSTREAM + "/v2" + PREFIX + "/auth/token/refresh", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Accept": "application/json",
      "X-Product": PRODUCT,
      "X-Refresh-Token": acc.refreshToken,
      "X-Auth-Refresh-Source": "plugin",
      "X-No-User-Id": "true",
      "X-No-Authorization": "true",
    },
    body: "{}",
    stickyKey: acc.id || acc.uid,
  });
  const j = await res.json().catch(function () { return {}; });
  if (!res.ok || j.code && j.code !== 0 || !j.data || !j.data.accessToken) {
    acc.disabled = true;
    acc.last_error = "refresh failed " + res.status + " " + (j.msg || j.error || "");
    saveAccounts();
    throw new Error(acc.last_error);
  }
  const tok = j.data;
  tok.lastRefreshTime = now();
  acc.accessToken = tok.accessToken;
  if (tok.refreshToken) acc.refreshToken = tok.refreshToken;
  const expiresIn = Number(tok.expiresIn || 0);
  acc.expires_at = expiresIn ? now() + expiresIn * 1000 : acc.expires_at;
  acc.lastRefreshTime = tok.lastRefreshTime;
  acc.disabled = false;
  acc.last_error = "";
  saveAccounts();
  return acc;
}

async function maybeRefresh(acc) {
  if (!acc.expires_at) return acc;
  if (acc.expires_at - now() > 60 * 60 * 1000) return acc;
  try {
    return await refreshAccount(acc);
  } catch (e) {
    console.error("refresh", acc.email, e.message);
    return acc;
  }
}

function reasoningMeta(m) {
  const r = m && m.reasoning && typeof m.reasoning === "object" ? m.reasoning : {};
  const efforts = Array.isArray(r.supportedEfforts) && r.supportedEfforts.length
    ? r.supportedEfforts.slice()
    : (r.effort ? [r.effort] : []);
  return {
    supports_reasoning: !!(m && (m.supportsReasoning || m.onlyReasoning || efforts.length)),
    only_reasoning: !!(m && m.onlyReasoning),
    can_disable_thinking: !!r.canDisableThinking,
    default_effort: r.defaultEffort || r.effort || "",
    reasoning_efforts: efforts,
    reasoning: Object.keys(r).length ? r : undefined,
  };
}

function extraModelEntries() {
  const extra = Array.isArray(cfg.extraModels) ? cfg.extraModels : [];
  return extra.filter(function (m) { return m && m.id; }).map(function (m) {
    const meta = reasoningMeta(m);
    return {
      id: m.id,
      object: "model",
      created: Math.floor(now() / 1000),
      owned_by: "workbuddy",
      name: m.name || m.id,
      credits: m.credits || "x0.00",
      vendor: m.vendor || "",
      supports_tools: m.supportsToolCall !== false,
      supports_images: !!m.supportsImages,
      supports_reasoning: meta.supports_reasoning,
      only_reasoning: meta.only_reasoning,
      can_disable_thinking: meta.can_disable_thinking,
      default_effort: meta.default_effort,
      reasoning_efforts: meta.reasoning_efforts,
      reasoning: meta.reasoning,
    };
  });
}

function mergeExtraModels(list) {
  const seen = {};
  const out = [];
  extraModelEntries().concat(list || []).forEach(function (m) {
    if (!m || !m.id || seen[m.id]) return;
    seen[m.id] = true;
    out.push(m);
  });
  return out;
}

async function fetchModels(acc) {
  const res = await upFetch(UPSTREAM + MODELS_PATH, {
    headers: upstreamHeaders(acc, { Accept: "application/json" }),
    stickyKey: acc && (acc.id || acc.uid),
  });
  const j = await res.json().catch(function () { return {}; });
  const raw = j && j.data && Array.isArray(j.data.models) ? j.data.models : [];
  const list = raw.filter(function (m) { return m && m.id; }).map(function (m) {
    const meta = reasoningMeta(m);
    return {
      id: m.id,
      object: "model",
      created: Math.floor(now() / 1000),
      owned_by: "workbuddy",
      name: m.name || m.id,
      credits: m.credits || "",
      vendor: m.vendor || "",
      supports_tools: !!m.supportsToolCall,
      supports_images: !!m.supportsImages,
      supports_reasoning: meta.supports_reasoning,
      only_reasoning: meta.only_reasoning,
      can_disable_thinking: meta.can_disable_thinking,
      default_effort: meta.default_effort,
      reasoning_efforts: meta.reasoning_efforts,
      reasoning: meta.reasoning,
    };
  });
  const merged = mergeExtraModels(list);
  if (merged.length) {
    modelsCache = { at: now(), list: merged };
  }
  return modelsCache.list;
}

function openaiModels() {
  const fallback = [
    { id: "default-model", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "fast-model", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "balanced-model", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "primary-model", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "deep-model", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "hy3", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "hy4-preview", object: "model", created: 0, owned_by: "workbuddy", name: "Hy4-Preview", credits: "x0.00" },
    { id: "gpt-5.6-sol", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gpt-5.6-terra", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gpt-5.6-luna", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gpt-5.5", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gpt-5.4", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gpt-5.3-codex", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "gemini-3.5-flash", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "glm-5.3", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "glm-5.2", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "kimi-k3", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "kimi-k2.6", object: "model", created: 0, owned_by: "workbuddy" },
    { id: "minimax-m3", object: "model", created: 0, owned_by: "workbuddy" },
  ];
  const list = mergeExtraModels(modelsCache.list.length ? modelsCache.list : fallback).map(function (m) {
    const selected = (cfg.effortByModel && cfg.effortByModel[m.id]) || "";
    return Object.assign({}, m, { selected_effort: selected });
  });
  return { object: "list", data: list };
}

function ensureSystem(messages) {
  const msgs = Array.isArray(messages) ? messages.slice() : [];
  if (!msgs.length || msgs[0].role !== "system") {
    msgs.unshift({ role: "system", content: SYS_PROMPT });
  }
  return msgs;
}

function textOf(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(function (p) {
      if (typeof p === "string") return p;
      if (p && p.type === "text") return p.text || "";
      if (p && p.text) return p.text;
      return "";
    }).join("");
  }
  if (typeof content === "object" && content.text) return content.text;
  return JSON.stringify(content);
}

function normalizeMessages(messages) {
  return ensureSystem(messages).map(function (m) {
    const out = { role: m.role, content: textOf(m.content) };
    if (m.name) out.name = m.name;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.tool_calls) out.tool_calls = m.tool_calls;
    return out;
  });
}

function buildUpstreamBody(body) {
  const out = {
    model: body.model || "default-model",
    messages: normalizeMessages(body.messages || []),
    stream: true,
  };
  if (body.max_tokens != null) out.max_tokens = body.max_tokens;
  if (body.max_completion_tokens != null && body.max_tokens == null) out.max_tokens = body.max_completion_tokens;
  if (body.temperature != null) out.temperature = body.temperature;
  if (body.top_p != null) out.top_p = body.top_p;
  if (body.stop != null) out.stop = body.stop;
  if (body.tools) out.tools = body.tools;
  if (body.tool_choice) out.tool_choice = body.tool_choice;
  if (body.response_format) out.response_format = body.response_format;
  const effort = pickReasoningEffort(body);
  if (effort) out.reasoning_effort = effort;
  return out;
}

function pickReasoningEffort(body) {
  if (!body || typeof body !== "object") return "";
  const raw = body.reasoning_effort || body.reasoningEffort
    || (body.reasoning && typeof body.reasoning === "object" && body.reasoning.effort)
    || "";
  let v = String(raw).trim().toLowerCase();
  if (v === "default" || v === "auto" || v === "none" || v === "off") v = "";
  if (!v) {
    const model = body.model || "default-model";
    v = String((cfg.effortByModel && cfg.effortByModel[model]) || "").trim().toLowerCase();
    if (v === "default" || v === "auto" || v === "none" || v === "off") v = "";
  }
  return v;
}

function setModelEffort(modelId, effort) {
  if (!modelId) return false;
  if (!cfg.effortByModel || typeof cfg.effortByModel !== "object") cfg.effortByModel = {};
  const v = String(effort || "").trim().toLowerCase();
  if (!v || v === "default" || v === "auto" || v === "none" || v === "off") delete cfg.effortByModel[modelId];
  else cfg.effortByModel[modelId] = v;
  persistCfg();
  return true;
}

function parseSseBlock(block) {
  const lines = String(block).split("\n");
  let data = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.indexOf("data:") === 0) {
      const part = line.slice(5).trim();
      data += (data ? "\n" : "") + part;
    }
  }
  return data;
}

function accumulateChunks(text) {
  let content = "";
  let reasoning = "";
  let id = "chatcmpl_" + crypto.randomBytes(8).toString("hex");
  let model = "default-model";
  let finish = "stop";
  let usage = null;
  const parts = String(text).split("\n\n");
  for (let i = 0; i < parts.length; i++) {
    const data = parseSseBlock(parts[i]);
    if (!data || data === "[DONE]") continue;
    let j;
    try { j = JSON.parse(data); } catch { continue; }
    if (j.id) id = j.id;
    if (j.model) model = j.model;
    if (j.usage) usage = j.usage;
    const ch = j.choices && j.choices[0];
    if (!ch) continue;
    if (ch.finish_reason && ch.finish_reason !== "") finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
  }
  const msg = { role: "assistant", content: content };
  if (reasoning) msg.reasoning_content = reasoning;
  return {
    id: id,
    object: "chat.completion",
    created: Math.floor(now() / 1000),
    model: model,
    choices: [{ index: 0, message: msg, finish_reason: finish || "stop", logprobs: null }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

async function chatOnce(acc, body, signal) {
  const res = await upFetch(UPSTREAM + CHAT_PATH, {
    method: "POST",
    headers: upstreamHeaders(acc, { Accept: "text/event-stream" }),
    body: JSON.stringify(body),
    signal: signal,
    stickyKey: acc.id || acc.uid,
  });
  return res;
}

async function handleChat(req, res, body) {
  const wantStream = !!body.stream;
  const upBody = buildUpstreamBody(body);
  const t0 = now();
  let lastErr = null;
  const tried = new Set();
  for (let i = 0; i < Math.max(1, accounts.length); i++) {
    let acc = i === 0 ? pickAccount() : nextUnusedAccount(tried);
    if (!acc || tried.has(acc.id)) acc = nextUnusedAccount(tried);
    if (!acc) break;
    tried.add(acc.id);
    await maybeRefresh(acc);
    acc.last_used = now();
    acc.requests = (acc.requests || 0) + 1;
    try {
      const up = await chatOnce(acc, upBody, req.aborted ? undefined : undefined);
      if (up.status === 401 || up.status === 403) {
        try {
          await refreshAccount(acc);
          const up2 = await chatOnce(acc, upBody);
          if (up2.ok) return await pipeChat(up2, res, wantStream, acc, upBody, t0);
        } catch (e) {
          lastErr = e;
          acc.errors = (acc.errors || 0) + 1;
          acc.last_error = String(e.message || e);
          logFailed(acc, upBody, t0, 401, String(e.message || e));
          continue;
        }
      }
      if (up.status === 429) {
        acc.cooldown_until = now() + 60 * 1000;
        acc.last_error = "429";
        saveAccounts();
        lastErr = new Error("429");
        logFailed(acc, upBody, t0, 429, "rate limited", up._egress);
        continue;
      }
      if (up.status >= 500) {
        acc.errors = (acc.errors || 0) + 1;
        acc.last_error = "upstream " + up.status;
        lastErr = new Error(acc.last_error);
        logFailed(acc, upBody, t0, up.status, acc.last_error, up._egress);
        continue;
      }
      if (!up.ok) {
        const txt = await up.text();
        acc.errors = (acc.errors || 0) + 1;
        acc.last_error = txt.slice(0, 200);
        saveAccounts();
        logFailed(acc, upBody, t0, up.status, acc.last_error, up._egress);
        if (!res.headersSent) send(res, up.status, tryJson(txt) || { error: { message: txt.slice(0, 500) } });
        return;
      }
      return await pipeChat(up, res, wantStream, acc, upBody, t0);
    } catch (e) {
      lastErr = e;
      acc.errors = (acc.errors || 0) + 1;
      acc.last_error = String(e.message || e);
      logFailed(acc, upBody, t0, 0, acc.last_error);
    }
  }
  saveAccounts();
  if (!res.headersSent) {
    send(res, 503, { error: { message: lastErr ? String(lastErr.message || lastErr) : "no usable workbuddy account", type: "api_error" } });
  }
}

function usageFrom(u) {
  u = u || {};
  const det = u.completion_tokens_details || {};
  return {
    prompt: u.prompt_tokens || 0,
    completion: u.completion_tokens || 0,
    total: u.total_tokens || 0,
    reasoning: det.reasoning_tokens || u.completion_thinking_tokens || 0,
    credit: u.credit || 0,
  };
}

function logFailed(acc, upBody, t0, status, error, egress) {
  pushRequest({
    id: "req_" + crypto.randomBytes(4).toString("hex"),
    ts: now(),
    ms: now() - t0,
    status: status || 0,
    ok: false,
    error: String(error || "").slice(0, 180),
    account: acc && (acc.email || acc.uid || acc.id) || "",
    uid: acc && acc.uid || "",
    model: upBody && upBody.model || "",
    effort: upBody && upBody.reasoning_effort || "",
    proxy: egress || "direct",
    ip: "",
    tokens: { prompt: 0, completion: 0, total: 0, reasoning: 0, credit: 0 },
  });
}

function tryJson(txt) {
  try { return JSON.parse(txt); } catch { return null; }
}

async function pipeChat(up, res, wantStream, acc, upBody, t0) {
  const egressLabel = up._egress || "direct";
  const entry = {
    id: "req_" + crypto.randomBytes(3).toString("hex"),
    ts: now(),
    ms: 0,
    status: 200,
    ok: true,
    error: "",
    account: acc.email || acc.uid || acc.id,
    uid: acc.uid || "",
    model: (upBody && upBody.model) || "",
    effort: (upBody && upBody.reasoning_effort) || "",
    proxy: egressLabel,
    ip: inferIp(egressLabel),
    tokens: { prompt: 0, completion: 0, total: 0, reasoning: 0, credit: 0 },
  };
  res.setHeader("X-WorkBuddy-Account", entry.account);
  res.setHeader("X-WorkBuddy-Egress", egressLabel);
  if (wantStream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
      "X-WorkBuddy-Account": entry.account,
      "X-WorkBuddy-Egress": egressLabel,
    });
    const reader = up.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let sawDone = false;
    let usage = null;
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      const chunk = dec.decode(step.value, { stream: true });
      buf += chunk;
      res.write(chunk);
      if (chunk.indexOf("[DONE]") >= 0) sawDone = true;
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (let i = 0; i < parts.length; i++) {
        const data = parseSseBlock(parts[i]);
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.usage) usage = j.usage;
        } catch {}
      }
    }
    if (!sawDone) res.write("data: [DONE]\n\n");
    res.end();
    if (usage) {
      acc.tokens_in = (acc.tokens_in || 0) + (usage.prompt_tokens || 0);
      acc.tokens_out = (acc.tokens_out || 0) + (usage.completion_tokens || 0);
      saveAccounts();
    }
    entry.ms = now() - (t0 || now());
    entry.tokens = usageFrom(usage);
    pushRequest(entry);
    return;
  }
  const txt = await up.text();
  const completion = accumulateChunks(txt);
  if (completion.usage) {
    acc.tokens_in = (acc.tokens_in || 0) + (completion.usage.prompt_tokens || 0);
    acc.tokens_out = (acc.tokens_out || 0) + (completion.usage.completion_tokens || 0);
    saveAccounts();
  }
  entry.ms = now() - (t0 || now());
  entry.tokens = usageFrom(completion.usage);
  pushRequest(entry);
  send(res, 200, completion);
}

async function loginStart() {
  const res = await upFetch(UPSTREAM + "/v2" + PREFIX + "/auth/state?platform=" + encodeURIComponent(PLATFORM), {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Accept": "application/json",
      "Content-Type": "application/json",
      "X-Product": PRODUCT,
      "X-No-Authorization": "true",
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    },
    body: "{}",
  });
  const j = await res.json().catch(function () { return {}; });
  const data = j.data || {};
  if (!data.state || !data.authUrl) {
    throw new Error(j.msg || "auth state failed");
  }
  let authUrl = String(data.authUrl);
  if (authUrl.indexOf("version=") < 0) {
    authUrl += (authUrl.indexOf("?") >= 0 ? "&" : "?") + "version=5";
  }
  pendingLogins.set(data.state, { started: now(), authUrl: authUrl });
  return { state: data.state, authUrl: authUrl };
}

async function loginPoll(state) {
  const res = await upFetch(UPSTREAM + "/v2" + PREFIX + "/auth/token?state=" + encodeURIComponent(state), {
    headers: {
      "User-Agent": UA,
      "Accept": "application/json",
      "X-Product": PRODUCT,
      "X-No-Authorization": "true",
      "X-No-User-Id": "true",
      "X-No-Enterprise-Id": "true",
      "X-No-Department-Info": "true",
    },
  });
  const j = await res.json().catch(function () { return {}; });
  if (j.code === 11217 || !j.data || !j.data.accessToken) {
    return { status: "pending", msg: j.msg || "login ing..." };
  }
  const tok = j.data;
  tok.lastRefreshTime = now();
  let account = null;
  try {
    const ar = await upFetch(UPSTREAM + "/v2" + PREFIX + "/login/account?state=" + encodeURIComponent(state), {
      headers: {
        "User-Agent": UA,
        "Accept": "application/json",
        "X-Product": PRODUCT,
        "Authorization": "Bearer " + tok.accessToken,
        "X-No-User-Id": "true",
        "X-No-Enterprise-Id": "true",
        "X-No-Department-Info": "true",
      },
    });
    const aj = await ar.json().catch(function () { return {}; });
    account = aj.data || null;
  } catch {}
  const acc = upsertAccount(tok, { account: account, uid: account && account.uid, email: account && account.nickname });
  pendingLogins.delete(state);
  try { await fetchModels(acc); } catch {}
  return { status: "ok", account: publicAccount(acc) };
}

function serveStatic(req, res, url) {
  let rel = url.pathname === "/" ? "/index.html" : url.pathname;
  rel = path.normalize(rel).replace(/^(\.\.[\/\\])+/, "");
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    send(res, 403, { error: "forbidden" });
    return true;
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
  const ext = path.extname(file).toLowerCase();
  const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".ico": "image/x-icon" };
  res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function onRequest(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, X-WorkBuddy-Account",
      "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    });
    res.end();
    return;
  }
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);
  const p = url.pathname;

  try {
    if (p === "/healthz" || p === "/health") {
      send(res, 200, { ok: true, accounts: accounts.filter(function (a) { return !a.disabled; }).length });
      return;
    }

    if (p.startsWith("/admin/")) {
      if (!isLoopback(req)) {
        send(res, 403, { error: "admin is loopback-only" });
        return;
      }
      if (p === "/admin/state" && req.method === "GET") {
        const eg = pool.snapshot();
        send(res, 200, {
          ok: true,
          base_url: "http://" + HOST + ":" + PORT + "/v1",
          proxy_key: PROXY_KEY,
          upstream: UPSTREAM,
          accounts: accounts.map(publicAccount),
          account_rr: usableAccounts().length > 1,
          models: openaiModels().data,
          effortByModel: cfg.effortByModel || {},
          egress: eg,
          requests: publicRequests(40),
          stats: usageStats(),
        });
        return;
      }
      if (p === "/admin/requests" && req.method === "GET") {
        send(res, 200, { ok: true, requests: publicRequests(url.searchParams.get("limit") || 100) });
        return;
      }
      if (p === "/admin/requests" && req.method === "DELETE") {
        requestLog.length = 0;
        send(res, 200, { ok: true, requests: [] });
        return;
      }
      if (p === "/admin/egress" && req.method === "GET") {
        send(res, 200, pool.snapshot());
        return;
      }
      if (p === "/admin/egress" && req.method === "POST") {
        const raw = await readBody(req);
        const j = JSON.parse(raw.toString("utf8") || "{}");
        if (typeof j.enabled === "boolean") {
          cfg.egress.enabled = j.enabled;
          pool.setEnabled(j.enabled);
        }
        if (j.mode) {
          cfg.egress.mode = j.mode === "sticky" ? "sticky" : "roundrobin";
          pool.setMode(cfg.egress.mode);
        }
        if (typeof j.file === "string") cfg.egress.file = j.file;
        if (Array.isArray(j.list)) {
          saveProxyLines(j.list);
        } else if (j.reload) {
          cfg.egress.list = [];
          pool.loadFile(egressLib.resolveFile(ROOT, cfg.egress.file || "proxies.txt"));
          persistCfg();
        } else {
          persistCfg();
        }
        send(res, 200, { ok: true, egress: pool.snapshot() });
        return;
      }
      if (p === "/admin/effort" && req.method === "POST") {
        const raw = await readBody(req);
        const j = JSON.parse(raw.toString("utf8") || "{}");
        if (j.map && typeof j.map === "object") {
          cfg.effortByModel = {};
          Object.keys(j.map).forEach(function (id) { setModelEffort(id, j.map[id]); });
        } else if (j.model) {
          setModelEffort(j.model, j.effort);
        } else {
          send(res, 400, { error: "need model+effort or map" });
          return;
        }
        send(res, 200, { ok: true, effortByModel: cfg.effortByModel || {}, models: openaiModels().data });
        return;
      }
      if (p === "/admin/egress/add" && req.method === "POST") {
        const raw = await readBody(req);
        const j = JSON.parse(raw.toString("utf8") || "{}");
        const incoming = Array.isArray(j.lines) ? j.lines : String(j.line || j.text || "").split(/\r?\n/);
        const merged = currentProxyLines().concat(incoming);
        send(res, 200, { ok: true, egress: saveProxyLines(merged) });
        return;
      }
      if (p === "/admin/egress/remove" && req.method === "POST") {
        const raw = await readBody(req);
        const j = JSON.parse(raw.toString("utf8") || "{}");
        const drop = {};
        [].concat(j.label || [], j.labels || []).forEach(function (x) { if (x) drop[String(x)] = true; });
        const keep = currentProxyLines().filter(function (line) {
          const pxy = egressLib.parseLine(line);
          return pxy && !drop[pxy.label];
        });
        send(res, 200, { ok: true, egress: saveProxyLines(keep) });
        return;
      }
      if (p === "/admin/egress/check" && req.method === "POST") {
        const results = await pool.checkAll(8000, 10);
        send(res, 200, { ok: true, results: results, egress: pool.snapshot() });
        return;
      }
      if (p === "/admin/egress/prune" && req.method === "POST") {
        const results = await pool.checkAll(8000, 10);
        const dead = {};
        results.forEach(function (r) { if (!r.ok) dead[r.label] = true; });
        const keep = currentProxyLines().filter(function (line) {
          const pxy = egressLib.parseLine(line);
          return pxy && !dead[pxy.label];
        });
        const snap = saveProxyLines(keep);
        send(res, 200, {
          ok: true,
          removed: results.filter(function (r) { return !r.ok; }).length,
          kept: snap.count,
          results: results,
          egress: snap,
        });
        return;
      }
      if (p === "/admin/login/start" && req.method === "POST") {
        const out = await loginStart();
        send(res, 200, out);
        return;
      }
      if (p === "/admin/login/poll" && req.method === "GET") {
        const state = url.searchParams.get("state") || "";
        if (!state) {
          send(res, 400, { error: "missing state" });
          return;
        }
        const out = await loginPoll(state);
        send(res, 200, out);
        return;
      }
      if (p === "/admin/import" && req.method === "POST") {
        const acc = importDesktopSession();
        send(res, 200, { ok: !!acc, account: acc ? publicAccount(acc) : null });
        return;
      }
      if (p === "/admin/accounts" && req.method === "POST") {
        const raw = await readBody(req);
        const j = JSON.parse(raw.toString("utf8") || "{}");
        if (!j.accessToken && !j.auth) {
          send(res, 400, { error: "need accessToken" });
          return;
        }
        const tok = j.auth || j;
        const acc = upsertAccount(tok, { uid: j.uid, email: j.email, account: j.account });
        send(res, 200, publicAccount(acc));
        return;
      }
      if (p.indexOf("/admin/accounts/") === 0 && req.method === "DELETE") {
        const id = decodeURIComponent(p.slice("/admin/accounts/".length));
        const n = accounts.length;
        accounts = accounts.filter(function (a) { return a.id !== id && a.uid !== id && a.email !== id; });
        saveAccounts();
        send(res, 200, { ok: true, removed: n - accounts.length });
        return;
      }
      if (p.indexOf("/admin/accounts/") === 0 && p.endsWith("/refresh") && req.method === "POST") {
        const id = decodeURIComponent(p.slice("/admin/accounts/".length, p.length - "/refresh".length));
        const acc = accounts.find(function (a) { return a.id === id || a.uid === id; });
        if (!acc) {
          send(res, 404, { error: "not found" });
          return;
        }
        await refreshAccount(acc);
        send(res, 200, publicAccount(acc));
        return;
      }
      send(res, 404, { error: "not found" });
      return;
    }

    if (p === "/v1/models" && req.method === "GET") {
      if (!requireProxyKey(req, res)) return;
      const acc = pickAccount();
      if (acc && now() - modelsCache.at > 5 * 60 * 1000) {
        try { await fetchModels(acc); } catch {}
      }
      send(res, 200, openaiModels());
      return;
    }

    if ((p === "/v1/chat/completions" || p === "/chat/completions") && req.method === "POST") {
      if (!requireProxyKey(req, res)) return;
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString("utf8") || "{}");
      await handleChat(req, res, body);
      return;
    }

    if (req.method === "GET" && serveStatic(req, res, url)) return;

    send(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
  } catch (e) {
    console.error(req.method, p, e);
    if (!res.headersSent) send(res, 500, { error: { message: String(e.message || e), type: "api_error" } });
  }
}

if (!accounts.length) {
  const imported = importDesktopSession();
  if (imported) console.log("imported desktop session", imported.email || imported.uid);
}
loadStatsRows();
for (let i = statsRows.length - 1; i >= 0 && requestLog.length < MAX_REQUESTS; i--) {
  requestLog.push(statsRows[i]);
}

const server = http.createServer(onRequest);
server.listen(PORT, HOST, async function () {
  console.log("workbuddy-proxy http://" + HOST + ":" + PORT);
  console.log("openai base  http://" + HOST + ":" + PORT + "/v1");
  console.log("web          http://" + HOST + ":" + PORT + "/");
  const acc = pickAccount();
  if (acc) {
    try {
      await fetchModels(acc);
      console.log("models", modelsCache.list.length, "account", acc.email || acc.uid);
    } catch (e) {
      console.error("models warmup failed", e.message);
    }
  } else {
    console.log("no accounts — open web UI and login");
  }
});
