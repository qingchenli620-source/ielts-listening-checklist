// 本地测试用的 Supabase 替身：只实现这个网页实际调用的 Auth 和 REST。
// 不是真的 Supabase。权限规则按 supabase/schema.sql 里的 RLS 来模拟。
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const port = Number(arg("--port", "54321"));
const dataPath = arg("--data", "");
const staticDir = arg("--static", "");
const overrideConfig = args.includes("--config-override");
const anonKey = arg("--anon-key", "test-anon-key");

if (!dataPath) {
  console.error("用法：node scripts/mock-supabase.mjs --data data/corpus_bv1nTNkzjEVn.json --static site --config-override");
  process.exit(1);
}

const corpus = JSON.parse(readFileSync(dataPath, "utf8"));
const videos = corpus.pages.map(function (page) {
  return {
    page: page.page,
    title: page.title,
    cid: page.cid,
    duration_s: page.duration_s,
    url: page.url,
  };
});
const items = [];
corpus.pages.forEach(function (page) {
  page.items.forEach(function (item) {
    items.push({ id: item.id, page: page.page, en: item.en, zh: item.zh, t: item.t });
  });
});

const users = [
  { id: "11111111-1111-4111-8111-111111111111", email: "buyer-a@example.com", password: "password-a" },
  { id: "22222222-2222-4222-8222-222222222222", email: "buyer-b@example.com", password: "password-b" },
];
const ticks = [];
const preferences = [];
const wordReports = [];
const inviteCodes = [
  { code: "A1B2C3D4E5F6", created_at: "2026-01-01T00:00:00.000Z", used_at: null, used_by: null, used_email: null },
  { code: "DEADBEEF0000", created_at: "2026-01-01T00:00:00.000Z", used_at: "2026-01-02T00:00:00.000Z", used_by: "11111111-1111-4111-8111-111111111111", used_email: "buyer-a@example.com" },
];
const sessions = new Map();
const refreshTokens = new Map();

const tables = { videos: videos, items: items, ticks: ticks, preferences: preferences, word_reports: wordReports };

function publicUser(user) {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: user.email,
    email_confirmed_at: "2026-01-01T00:00:00.000Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

function issue(user) {
  const access = randomBytes(24).toString("hex");
  const refresh = randomBytes(24).toString("hex");
  sessions.set(access, user);
  refreshTokens.set(refresh, user);
  const expiresIn = 60 * 60;
  return {
    access_token: access,
    token_type: "bearer",
    expires_in: expiresIn,
    expires_at: Math.floor(Date.now() / 1000) + expiresIn,
    refresh_token: refresh,
    user: publicUser(user),
  };
}

function send(res, status, body, extra) {
  const headers = Object.assign({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  }, extra || {});
  res.writeHead(status, headers);
  if (body === undefined || body === null) res.end();
  else res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    req.on("data", function (chunk) { chunks.push(chunk); });
    req.on("end", function () {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(null);
      try { resolve(JSON.parse(raw)); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function bearer(req) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : "";
}

function currentUser(req) {
  return sessions.get(bearer(req)) || null;
}

function decodeFilterValue(raw) {
  if (raw.length >= 2 && raw.charAt(0) === '"' && raw.charAt(raw.length - 1) === '"') {
    return raw.slice(1, -1).replace(/\\"/g, '"');
  }
  return raw;
}

function parseFilters(params) {
  const reserved = new Set(["select", "order", "offset", "limit", "on_conflict", "columns"]);
  const filters = [];
  for (const [key, value] of params.entries()) {
    if (reserved.has(key)) continue;
    const match = String(value).match(/^(eq|neq|gt|gte|lt|lte)\.(.*)$/s);
    if (!match) continue;
    filters.push({ column: key, op: match[1], value: decodeFilterValue(match[2]) });
  }
  return filters;
}

function matches(row, filters) {
  return filters.every(function (filter) {
    const left = row[filter.column];
    if (filter.op === "eq") return String(left) === String(filter.value);
    if (filter.op === "neq") return String(left) !== String(filter.value);
    const a = Number(left);
    const b = Number(filter.value);
    if (filter.op === "gt") return a > b;
    if (filter.op === "gte") return a >= b;
    if (filter.op === "lt") return a < b;
    if (filter.op === "lte") return a <= b;
    return false;
  });
}

function visibleRows(table, user) {
  const rows = tables[table] || [];
  if (table === "videos" || table === "items") return rows.slice();
  return rows.filter(function (row) { return row.user_id === user.id; });
}

function canInsert(table, user, row) {
  if (table === "ticks" || table === "preferences" || table === "word_reports") return row.user_id === user.id;
  return false;
}

function normalizeCode(raw) {
  return String(raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function handleRegister(req, res) {
  if (req.method === "OPTIONS") {
    send(res, 204, null);
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, { error: "只接受 POST" });
    return;
  }
  const body = await readBody(req);
  const email = String((body && body.email) || "").trim().toLowerCase();
  const password = String((body && body.password) || "");
  const code = normalizeCode(body && body.code);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    send(res, 400, { error: "邮箱格式不对" });
    return;
  }
  if (password.length < 6) {
    send(res, 400, { error: "密码至少 6 位" });
    return;
  }
  if (!/^[A-F0-9]{12}$/.test(code)) {
    send(res, 400, { error: "邀请码不正确" });
    return;
  }
  const invite = inviteCodes.find(function (row) { return row.code === code && !row.used_at; });
  if (!invite) {
    send(res, 400, { error: "邀请码无效或已经使用过" });
    return;
  }
  if (users.some(function (user) { return user.email === email; })) {
    send(res, 400, { error: "这个邮箱已经注册，请直接登录" });
    return;
  }
  invite.used_at = new Date().toISOString();
  invite.used_email = email;
  const user = { id: randomUUID(), email: email, password: password };
  users.push(user);
  invite.used_by = user.id;
  send(res, 200, { ok: true });
}

function project(row, select) {
  if (!select || select === "*") return Object.assign({}, row);
  const out = {};
  select.split(",").forEach(function (column) {
    const name = column.trim();
    if (!name) return;
    out[name] = row[name] === undefined ? null : row[name];
  });
  return out;
}

function sortRows(rows, order) {
  if (!order) return rows;
  const keys = order.split(",").map(function (part) {
    const bits = part.trim().split(".");
    return { column: bits[0], dir: bits[1] === "desc" ? -1 : 1 };
  });
  return rows.slice().sort(function (a, b) {
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const av = a[key.column];
      const bv = b[key.column];
      if (av === bv) continue;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av > bv) return key.dir;
      if (av < bv) return -key.dir;
    }
    return 0;
  });
}

function conflictColumns(params, table) {
  const raw = params.get("on_conflict");
  if (raw) return raw.split(",").map(function (column) { return column.trim(); });
  if (table === "ticks") return ["user_id", "item_id"];
  if (table === "preferences") return ["user_id"];
  return ["id"];
}

function sameKey(row, other, columns) {
  return columns.every(function (column) { return String(row[column]) === String(other[column]); });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function serveStatic(req, res, url) {
  if (!staticDir) return false;
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  if (overrideConfig && pathname === "/config.js") {
    const body = 'window.IELTS_CONFIG = ' + JSON.stringify({
      supabaseUrl: "http://127.0.0.1:" + port,
      supabaseAnonKey: anonKey,
      purchaseNote: "测试购买说明：付款后联系站长开通。",
    }) + ";\n";
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(body);
    return true;
  }
  const relative = pathname.replace(/^\/+/, "");
  const root = resolve(staticDir);
  const file = resolve(join(root, relative));
  if (file !== root && !file.startsWith(root + sep)) {
    send(res, 403, { message: "forbidden" });
    return true;
  }
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  const ext = file.slice(file.lastIndexOf("."));
  res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
  res.end(readFileSync(file));
  return true;
}

async function handleAuth(req, res, url) {
  if (req.method === "POST" && url.pathname === "/auth/v1/token") {
    const body = await readBody(req);
    const grant = url.searchParams.get("grant_type");
    if (grant === "password") {
      const email = String((body && body.email) || "").toLowerCase();
      const user = users.find(function (candidate) { return candidate.email === email && candidate.password === body.password; });
      if (!user) {
        send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials" });
        return;
      }
      send(res, 200, issue(user));
      return;
    }
    if (grant === "refresh_token") {
      const user = refreshTokens.get(body && body.refresh_token);
      if (!user) {
        send(res, 400, { error: "invalid_grant", error_description: "Invalid Refresh Token" });
        return;
      }
      send(res, 200, issue(user));
      return;
    }
    send(res, 400, { error: "unsupported_grant_type", error_description: "unsupported grant" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/auth/v1/user") {
    const user = currentUser(req);
    if (!user) {
      send(res, 401, { message: "invalid claim", code: "bad_jwt" });
      return;
    }
    send(res, 200, publicUser(user));
    return;
  }
  if (req.method === "PUT" && url.pathname === "/auth/v1/user") {
    const user = currentUser(req);
    if (!user) {
      send(res, 401, { message: "invalid claim", code: "bad_jwt" });
      return;
    }
    const body = await readBody(req);
    if (body && body.password) {
      if (String(body.password).length < 6) {
        send(res, 422, { message: "Password should be at least 6 characters", code: "weak_password" });
        return;
      }
      user.password = String(body.password);
    }
    send(res, 200, publicUser(user));
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/v1/logout") {
    const token = bearer(req);
    const user = sessions.get(token);
    sessions.delete(token);
    if (user) {
      for (const [refresh, owner] of refreshTokens) {
        if (owner === user) refreshTokens.delete(refresh);
      }
    }
    send(res, 204, null);
    return;
  }
  if (req.method === "POST" && url.pathname === "/auth/v1/signup") {
    send(res, 422, { code: "signup_disabled", msg: "Signups not allowed for this instance" });
    return;
  }
  send(res, 404, { message: "not found" });
}

async function handleRest(req, res, url) {
  const table = url.pathname.replace(/^\/rest\/v1\//, "");
  if (table === "invite_codes") {
    send(res, 401, { message: "permission denied for table invite_codes", code: "42501" });
    return;
  }
  if (table === "word_reports" && req.method !== "POST") {
    send(res, 401, { message: "permission denied for table word_reports", code: "42501" });
    return;
  }
  if (!tables[table]) {
    send(res, 404, { message: "table not found", code: "PGRST205" });
    return;
  }
  const user = currentUser(req);
  if (!user) {
    send(res, 401, { message: "JWT missing", code: "PGRST301" });
    return;
  }
  const filters = parseFilters(url.searchParams);
  const prefer = String(req.headers.prefer || "").toLowerCase();

  if (req.method === "GET") {
    let rows = visibleRows(table, user).filter(function (row) { return matches(row, filters); });
    rows = sortRows(rows, url.searchParams.get("order"));
    const offset = Number(url.searchParams.get("offset") || 0);
    const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 1000;
    const slice = rows.slice(offset, offset + limit);
    send(res, 200, slice.map(function (row) { return project(row, url.searchParams.get("select")); }), {
      "content-range": offset + "-" + (slice.length ? offset + slice.length - 1 : offset) + "/" + rows.length,
    });
    return;
  }

  if (req.method === "POST") {
    const body = await readBody(req);
    const incoming = Array.isArray(body) ? body : [body];
    const columns = conflictColumns(url.searchParams, table);
    const saved = [];
    for (const row of incoming) {
      if (!row || !canInsert(table, user, row)) {
        send(res, 403, { message: "new row violates row-level security policy", code: "42501" });
        return;
      }
      const existing = tables[table].find(function (candidate) { return sameKey(candidate, row, columns); });
      if (existing) {
        if (existing.user_id && existing.user_id !== user.id) {
          send(res, 403, { message: "new row violates row-level security policy", code: "42501" });
          return;
        }
        if (prefer.indexOf("ignore-duplicates") === -1) Object.assign(existing, row);
        saved.push(existing);
      } else {
        const copy = Object.assign({}, row);
        if ((table === "ticks" || table === "word_reports") && !copy.created_at) copy.created_at = new Date().toISOString();
        if (table === "word_reports" && !copy.id) copy.id = randomUUID();
        tables[table].push(copy);
        saved.push(copy);
      }
    }
    if (prefer.indexOf("return=minimal") >= 0) {
      send(res, 201, null);
      return;
    }
    send(res, 201, saved);
    return;
  }

  if (req.method === "PATCH") {
    const body = await readBody(req);
    const rows = visibleRows(table, user).filter(function (row) { return matches(row, filters); });
    rows.forEach(function (row) { Object.assign(row, body); });
    send(res, 200, rows);
    return;
  }

  if (req.method === "DELETE") {
    const survivors = [];
    let removed = 0;
    tables[table].forEach(function (row) {
      const mine = table === "videos" || table === "items" ? false : row.user_id === user.id;
      if (mine && matches(row, filters)) removed++;
      else survivors.push(row);
    });
    if ((table === "videos" || table === "items") && filters.length) {
      send(res, 403, { message: "permission denied", code: "42501" });
      return;
    }
    tables[table].length = 0;
    survivors.forEach(function (row) { tables[table].push(row); });
    send(res, 204, null, { "x-removed": String(removed) });
    return;
  }

  send(res, 405, { message: "method not allowed" });
}

const server = createServer(async function (req, res) {
  const url = new URL(req.url, "http://127.0.0.1:" + port);
  res.setHeader("access-control-allow-origin", req.headers.origin || "*");
  res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "*");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  res.setHeader("access-control-expose-headers", "content-range");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (url.pathname === "/functions/v1/register") {
      await handleRegister(req, res);
      return;
    }
    if (url.pathname.startsWith("/auth/v1/")) {
      await handleAuth(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      await handleRest(req, res, url);
      return;
    }
    if (serveStatic(req, res, url)) return;
    send(res, 404, { message: "not found" });
  } catch (err) {
    console.error(err);
    send(res, 500, { message: "mock error" });
  }
});

server.listen(port, "127.0.0.1", function () {
  console.log("mock supabase http://127.0.0.1:" + port + " videos=" + videos.length + " items=" + items.length);
});
