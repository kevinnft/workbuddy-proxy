"use strict";

const fs = require("fs");
const path = require("path");
const { ProxyAgent, fetch: ufetch } = require("undici");

function parseLine(line) {
  const s = String(line || "").trim();
  if (!s || s[0] === "#") return null;
  let host = "";
  let port = 0;
  let user = "";
  let pass = "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      host = u.hostname;
      port = Number(u.port || (u.protocol === "https:" ? 443 : 80));
      user = decodeURIComponent(u.username || "");
      pass = decodeURIComponent(u.password || "");
    } catch {
      return null;
    }
  } else {
    const parts = s.split(":");
    if (parts.length < 2) return null;
    host = parts[0];
    port = Number(parts[1]);
    if (parts.length >= 4) {
      user = parts[2];
      pass = parts.slice(3).join(":");
    }
  }
  if (!host || !port) return null;
  const auth = user ? encodeURIComponent(user) + ":" + encodeURIComponent(pass) + "@" : "";
  const uri = "http://" + auth + host + ":" + port;
  const label = host + ":" + port + (user ? ":" + user : "");
  return { host: host, port: port, user: user, pass: pass, uri: uri, label: label };
}

function createPool(opts) {
  opts = opts || {};
  const state = {
    enabled: !!opts.enabled,
    mode: opts.mode === "sticky" ? "sticky" : "roundrobin",
    list: [],
    cursor: 0,
    agents: [],
  };

  function rebuildAgents() {
    for (let i = 0; i < state.agents.length; i++) {
      try { state.agents[i].close(); } catch {}
    }
    state.agents = state.list.map(function (p) {
      return new ProxyAgent({
        uri: p.uri,
        bodyTimeout: 0,
        headersTimeout: 120000,
        connectTimeout: 15000,
      });
    });
  }

  function loadLines(lines) {
    const out = [];
    const seen = {};
    (lines || []).forEach(function (line) {
      const p = parseLine(line);
      if (!p) return;
      if (seen[p.label]) return;
      seen[p.label] = true;
      out.push(p);
    });
    state.list = out;
    state.cursor = 0;
    rebuildAgents();
    return state.list.length;
  }

  function loadFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return 0;
    const text = fs.readFileSync(filePath, "utf8");
    return loadLines(text.split(/\r?\n/));
  }

  function pick(key) {
    if (!state.enabled || !state.list.length) return { proxy: null, agent: null, label: "direct" };
    let idx = 0;
    if (state.mode === "sticky" && key) {
      let h = 0;
      const s = String(key);
      for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
      idx = h % state.list.length;
    } else {
      idx = state.cursor % state.list.length;
      state.cursor = (state.cursor + 1) % state.list.length;
    }
    return { proxy: state.list[idx], agent: state.agents[idx], label: state.list[idx].label, index: idx };
  }

  async function request(url, init, key) {
    init = init || {};
    const picked = pick(key);
    const headers = Object.assign({}, init.headers || {});
    if (picked.agent) {
      return ufetch(url, {
        method: init.method || "GET",
        headers: headers,
        body: init.body,
        signal: init.signal,
        dispatcher: picked.agent,
      }).then(function (res) {
        res._egress = picked.label;
        return res;
      });
    }
    return fetch(url, {
      method: init.method || "GET",
      headers: headers,
      body: init.body,
      signal: init.signal,
    }).then(function (res) {
      res._egress = "direct";
      return res;
    });
  }

  async function checkOne(item, timeoutMs) {
    timeoutMs = timeoutMs || 8000;
    const ac = new AbortController();
    const t = setTimeout(function () { ac.abort(); }, timeoutMs);
    const agent = new ProxyAgent({ uri: item.uri, bodyTimeout: 0, headersTimeout: timeoutMs, connectTimeout: timeoutMs });
    try {
      const res = await ufetch("https://api.ipify.org?format=json", { dispatcher: agent, signal: ac.signal });
      const j = await res.json();
      return { ok: true, label: item.label, ip: j.ip || "" };
    } catch (e) {
      return { ok: false, label: item.label, error: String(e.message || e) };
    } finally {
      clearTimeout(t);
      try { agent.close(); } catch {}
    }
  }

  function snapshot() {
    return {
      enabled: state.enabled,
      mode: state.mode,
      count: state.list.length,
      cursor: state.cursor,
      labels: state.list.map(function (p) { return p.label; }),
      items: state.list.map(function (p) {
        return { label: p.label, host: p.host, port: p.port, user: p.user };
      }),
    };
  }

  async function checkAll(timeoutMs, concurrency) {
    timeoutMs = timeoutMs || 8000;
    concurrency = concurrency || 8;
    const items = state.list.slice();
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const chunk = items.slice(i, i + concurrency);
      const part = await Promise.all(chunk.map(function (it) { return checkOne(it, timeoutMs); }));
      results.push.apply(results, part);
    }
    return results;
  }

  function lookupByLabel(label) {
    for (let i = 0; i < state.list.length; i++) {
      if (state.list[i].label === label) return state.list[i];
    }
    return null;
  }

  function setEnabled(v) { state.enabled = !!v; }
  function setMode(m) { state.mode = m === "sticky" ? "sticky" : "roundrobin"; }

  return {
    loadLines: loadLines,
    loadFile: loadFile,
    pick: pick,
    request: request,
    checkOne: checkOne,
    checkAll: checkAll,
    snapshot: snapshot,
    lookupByLabel: lookupByLabel,
    setEnabled: setEnabled,
    setMode: setMode,
    parseLine: parseLine,
  };
}

module.exports = { parseLine: parseLine, createPool: createPool, resolveFile: function (root, file) {
  if (!file) return "";
  return path.isAbsolute(file) ? file : path.join(root, file);
} };
