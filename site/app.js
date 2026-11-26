"use strict";

var state = {
  client: null,
  userId: null,
  videos: [],
  videoByPage: new Map(),
  itemsByPage: new Map(),
  itemById: new Map(),
  ticks: new Set(),
  fontSize: 18,
  pageFilter: 0,
  query: "",
  onlyTicked: false,
  exportText: "",
  reportItemId: "",
};

var desiredTicks = new Map();
var runningTicks = new Set();
var pendingSaves = 0;
var fontTimer = 0;
var toastTimer = 0;
var searchTimer = 0;
var composing = false;

function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmt(totalSeconds) {
  var t = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  var minutes = Math.floor(t / 60);
  var seconds = t % 60;
  return minutes + ":" + String(seconds).padStart(2, "0");
}

function fontStorageKey() {
  return "ielts-font-" + state.userId;
}

function decodeJwtPayload(token) {
  var parts = String(token).split(".");
  if (parts.length < 2 || parts[0].slice(0, 3) !== "eyJ") return null;
  try {
    var b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch (err) {
    return null;
  }
}

function isSecretKey(key) {
  if (/^sb_secret_/i.test(key) || /^sb_service_/i.test(key)) return true;
  var payload = decodeJwtPayload(key);
  return !!(payload && payload.role === "service_role");
}

function readConfig() {
  var cfg = window.IELTS_CONFIG || {};
  var url = String(cfg.supabaseUrl || "").trim().replace(/\/+$/, "");
  var key = String(cfg.supabaseAnonKey || "").trim();
  var note = String(cfg.purchaseNote || "");
  var problems = [];
  if (!/^https?:\/\//i.test(url) || /YOUR_PROJECT/i.test(url)) {
    problems.push("还没有填写 Supabase 网址。请修改 site/config.js 里的 supabaseUrl。");
  }
  if (!key || /YOUR_SUPABASE|YOUR_ANON|YOUR_KEY/i.test(key)) {
    problems.push("还没有填写 anon key。请修改 site/config.js 里的 supabaseAnonKey。");
  } else if (isSecretKey(key)) {
    problems.push("config.js 里填的是 service_role / secret key。请改填 anon public key 或 publishable key。secret key 不能放在网页里。");
  }
  return { url: url, key: key, note: note, problems: problems };
}

function toast(message) {
  var el = document.getElementById("toast");
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, 2400);
}

function setSync(mode) {
  var el = document.getElementById("sync");
  el.dataset.mode = mode;
  el.textContent = mode === "saving" ? "正在保存…" : mode === "error" ? "保存失败" : "已同步";
}

function loginErrorText(error) {
  var msg = (error && error.message) || "";
  if (/invalid login/i.test(msg)) return "邮箱或密码不正确。";
  if (/email not confirmed/i.test(msg)) return "这个账号还没激活。请联系站长，创建账号时需要勾选 Auto Confirm User。";
  if (/fetch|network|failed to fetch/i.test(msg)) return "连不上服务器。请检查网络，或联系站长确认网站配置。";
  return "登录失败。请稍后再试。";
}

function showConfigProblems(problems) {
  var box = document.getElementById("config-problems");
  box.hidden = false;
  box.textContent = problems.join("\n");
  document.querySelectorAll("#login-form input, #login-form button, #register-form input, #register-form button, .tab").forEach(function (el) {
    el.disabled = true;
  });
}

function jumpUrl(video, seconds) {
  var base = video && video.url ? video.url : "https://www.bilibili.com/video/BV1nTNkzjEVn/";
  return base + (base.indexOf("?") >= 0 ? "&" : "?") + "t=" + Math.max(0, Math.floor(Number(seconds) || 0));
}

function progressPercent(prog) {
  if (!prog.total || !prog.n) return 0;
  return Math.max((prog.n / prog.total) * 100, 3);
}

function pageProgress(page) {
  var items = state.itemsByPage.get(page) || [];
  var n = 0;
  for (var i = 0; i < items.length; i++) if (state.ticks.has(items[i].id)) n++;
  return { n: n, total: items.length };
}

function visibleItems(page) {
  var items = state.itemsByPage.get(page) || [];
  var q = state.query.trim().toLowerCase();
  return items.filter(function (item) {
    if (state.onlyTicked && !state.ticks.has(item.id)) return false;
    if (!q) return true;
    if (item.en.toLowerCase().indexOf(q) >= 0) return true;
    return !!(item.zh && item.zh.toLowerCase().indexOf(q) >= 0);
  });
}

function filtersActive() {
  return state.onlyTicked || state.query.trim() !== "" || state.pageFilter !== 0;
}

function wordsHtml(items) {
  return items.map(function (item) {
    var on = state.ticks.has(item.id);
    var video = state.videoByPage.get(item.page);
    var zh = item.zh ? '<span class="zh">' + esc(item.zh) + "</span>" : "";
    return (
      '<div class="word' + (on ? " on" : "") + '" data-id="' + esc(item.id) + '">' +
        '<label class="word-label">' +
          '<input type="checkbox"' + (on ? " checked" : "") + ' aria-label="' + esc(item.en) + '">' +
          '<span class="text"><span class="en">' + esc(item.en) + "</span>" + zh + "</span>" +
        "</label>" +
        '<button type="button" class="flag">报错</button>' +
        '<a class="jump" target="_blank" rel="noopener noreferrer" href="' + esc(jumpUrl(video, item.t)) + '">▶ ' + fmt(item.t) + "</a>" +
      "</div>"
    );
  }).join("");
}

function updateGlobalCount() {
  document.getElementById("global-count").textContent = "已勾选 " + state.ticks.size + " / " + state.itemById.size;
}

function refreshVideoOptions() {
  var sel = document.getElementById("video");
  var want = state.videos.length + 1;
  if (sel.options.length !== want) {
    var current = sel.value || "0";
    var html = '<option value="0">全部视频</option>';
    for (var i = 0; i < state.videos.length; i++) html += '<option value="' + state.videos[i].page + '"></option>';
    sel.innerHTML = html;
    sel.value = current;
  }
  sel.options[0].textContent = "全部视频";
  state.videos.forEach(function (video, index) {
    var prog = pageProgress(video.page);
    var opt = sel.options[index + 1];
    opt.value = String(video.page);
    opt.textContent = "P" + video.page + " " + video.title + "（" + prog.n + "/" + prog.total + "）";
  });
}

function refreshProgressDom() {
  document.querySelectorAll("#list details.video").forEach(function (details) {
    var page = Number(details.dataset.page);
    var prog = pageProgress(page);
    var n = details.querySelector(".tick-n");
    var total = details.querySelector(".tick-d");
    if (n) n.textContent = String(prog.n);
    if (total) total.textContent = String(prog.total);
    var fill = details.querySelector(".bar-fill");
    var bar = details.querySelector(".bar");
    var pct = progressPercent(prog);
    if (fill) fill.style.width = pct + "%";
    if (bar) {
      bar.setAttribute("aria-valuenow", String(prog.n));
      bar.setAttribute("aria-valuemax", String(prog.total));
      bar.setAttribute("aria-label", "已勾选 " + prog.n + " 个，共 " + prog.total + " 个");
    }
    var shown = details.querySelector(".shown-n");
    var body = details.querySelector(".words");
    if (shown && body && body.dataset.filled === "1") {
      shown.textContent = String(body.querySelectorAll(".word").length);
    }
  });
  updateGlobalCount();
  refreshVideoOptions();
}

function renderList() {
  var list = document.getElementById("list");
  var empty = document.getElementById("empty");
  var openAll = filtersActive();
  var parts = [];
  var any = false;
  for (var i = 0; i < state.videos.length; i++) {
    var video = state.videos[i];
    if (state.pageFilter && video.page !== state.pageFilter) continue;
    var items = visibleItems(video.page);
    if (openAll && items.length === 0) continue;
    any = true;
    var prog = pageProgress(video.page);
    var pct = progressPercent(prog);
    var duration = video.duration_s == null ? "" : '<span class="dur">时长 ' + fmt(video.duration_s) + "</span>";
    var shown = '<span class="sum-shown"' + (openAll ? "" : " hidden") + '>显示 <span class="shown-n">' + items.length + "</span></span>";
    parts.push(
      '<details class="video" data-page="' + video.page + '"' + (openAll ? " open" : "") + ">" +
        "<summary>" +
          '<span class="chev" aria-hidden="true"></span>' +
          '<span class="sum-main"><span class="sum-id">P' + video.page + '</span><span class="sum-title">' + esc(video.title) + "</span></span>" +
          '<span class="sum-meta">' +
            '<span class="sum-count"><span class="tick-n">' + prog.n + '</span>/<span class="tick-d">' + prog.total + "</span></span>" +
            shown + duration +
            '<span class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="' + prog.total + '" aria-valuenow="' + prog.n + '" aria-label="已勾选 ' + prog.n + " 个，共 " + prog.total + ' 个"><span class="bar-fill" style="width:' + pct + '%"></span></span>' +
          "</span>" +
        "</summary>" +
        '<div class="words" data-filled="' + (openAll ? "1" : "0") + '">' + (openAll ? wordsHtml(items) : "") + "</div>" +
      "</details>"
    );
  }
  list.innerHTML = parts.join("");
  if (!state.videos.length) empty.textContent = "词表是空的。请联系站长确认已经导入数据。";
  else empty.textContent = "没有符合条件的单词";
  empty.hidden = any;
  updateGlobalCount();
}

function applyFont(size, persist) {
  size = Math.max(14, Math.min(36, Math.round(Number(size) || 18)));
  state.fontSize = size;
  document.getElementById("app").style.setProperty("--word-size", size + "px");
  document.getElementById("font-label").textContent = String(size);
  document.getElementById("font-down").disabled = size <= 14;
  document.getElementById("font-up").disabled = size >= 36;
  if (state.userId) localStorage.setItem(fontStorageKey(), String(size));
  if (persist) scheduleFontSave(size);
}

function scheduleFontSave(size) {
  clearTimeout(fontTimer);
  setSync("saving");
  fontTimer = setTimeout(function () {
    state.client.from("preferences").upsert(
      { user_id: state.userId, font_size: size },
      { onConflict: "user_id" }
    ).then(function (result) {
      if (result.error) {
        console.error(result.error);
        setSync("error");
        toast("字号没有保存成功");
        return;
      }
      if (pendingSaves === 0) setSync("ok");
    });
  }, 250);
}

async function fetchAll(make) {
  var pageSize = 1000;
  var rows = [];
  for (var from = 0; from <= 20000; from += pageSize) {
    var result = await make(from, from + pageSize - 1);
    if (result.error) throw result.error;
    var batch = result.data || [];
    rows = rows.concat(batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

async function loadAll() {
  document.getElementById("loading").hidden = false;
  document.getElementById("load-error").hidden = true;
  var videos = await fetchAll(function (from, to) {
    return state.client.from("videos").select("page,title,cid,duration_s,url").order("page", { ascending: true }).range(from, to);
  });
  var items = await fetchAll(function (from, to) {
    return state.client.from("items").select("id,page,en,zh,t").order("page", { ascending: true }).order("t", { ascending: true }).order("id", { ascending: true }).range(from, to);
  });
  var tickRows = await fetchAll(function (from, to) {
    return state.client.from("ticks").select("item_id").eq("user_id", state.userId).order("item_id", { ascending: true }).range(from, to);
  });
  var prefs = await state.client.from("preferences").select("font_size").eq("user_id", state.userId);
  if (prefs.error) throw prefs.error;

  state.videos = videos;
  state.videoByPage = new Map(videos.map(function (video) { return [video.page, video]; }));
  state.itemsByPage = new Map();
  state.itemById = new Map();
  items.forEach(function (item) {
    if (!state.itemsByPage.has(item.page)) state.itemsByPage.set(item.page, []);
    state.itemsByPage.get(item.page).push(item);
    state.itemById.set(item.id, item);
  });
  state.ticks = new Set(tickRows.map(function (row) { return row.item_id; }));

  var serverSize = prefs.data && prefs.data[0] ? Number(prefs.data[0].font_size) : NaN;
  var cached = Number(localStorage.getItem(fontStorageKey()));
  applyFont(Number.isFinite(serverSize) ? serverSize : (Number.isFinite(cached) ? cached : 18), false);
  refreshVideoOptions();
  renderList();
  document.getElementById("footer-stats").textContent =
    "共 " + videos.length + " 集 · " + items.length + " 个单词。勾选和字号保存在你的账号里，换设备登录同一个邮箱即可同步。";
  document.getElementById("loading").hidden = true;
}

async function refreshTicksOnly() {
  setSync("saving");
  var tickRows = await fetchAll(function (from, to) {
    return state.client.from("ticks").select("item_id").eq("user_id", state.userId).order("item_id", { ascending: true }).range(from, to);
  });
  var prefs = await state.client.from("preferences").select("font_size").eq("user_id", state.userId);
  if (prefs.error) throw prefs.error;
  state.ticks = new Set(tickRows.map(function (row) { return row.item_id; }));
  if (prefs.data && prefs.data[0] && Number.isFinite(Number(prefs.data[0].font_size))) {
    applyFont(Number(prefs.data[0].font_size), false);
  }
  renderList();
  refreshVideoOptions();
  setSync("ok");
}

function queueTick(id, on) {
  desiredTicks.set(id, on);
  pumpTick(id);
}

async function pumpTick(id) {
  if (runningTicks.has(id)) return;
  runningTicks.add(id);
  pendingSaves++;
  setSync("saving");
  try {
    while (desiredTicks.has(id)) {
      var want = desiredTicks.get(id);
      desiredTicks.delete(id);
      var result = want
        ? await state.client.from("ticks").upsert(
          { user_id: state.userId, item_id: id },
          { onConflict: "user_id,item_id", ignoreDuplicates: true }
        )
        : await state.client.from("ticks").delete().eq("user_id", state.userId).eq("item_id", id);
      if (result.error) throw result.error;
    }
  } catch (err) {
    console.error(err);
    runningTicks.delete(id);
    pendingSaves = Math.max(0, pendingSaves - 1);
    setSync("error");
    toast("勾选没有保存成功，正在重新同步…");
    try { await refreshTicksOnly(); } catch (refreshErr) { console.error(refreshErr); }
    return;
  }
  runningTicks.delete(id);
  pendingSaves = Math.max(0, pendingSaves - 1);
  if (desiredTicks.has(id)) {
    pumpTick(id);
    return;
  }
  if (pendingSaves === 0) setSync("ok");
}

function leaveApp() {
  state.userId = null;
  state.ticks = new Set();
  state.videos = [];
  state.videoByPage = new Map();
  state.itemsByPage = new Map();
  state.itemById = new Map();
  state.pageFilter = 0;
  state.query = "";
  state.onlyTicked = false;
  document.getElementById("list").innerHTML = "";
  document.getElementById("search").value = "";
  document.getElementById("only").checked = false;
  document.getElementById("video").innerHTML = "";
  document.getElementById("export-panel").hidden = true;
  document.getElementById("global-count").textContent = "已勾选 0 / 0";
  document.getElementById("footer-stats").textContent = "";
  document.getElementById("font-label").textContent = "18";
  document.getElementById("who").textContent = "";
  document.getElementById("loading").hidden = true;
  document.getElementById("app").hidden = true;
  document.getElementById("app").style.removeProperty("--word-size");
  document.getElementById("password").value = "";
  document.getElementById("login").hidden = false;
  document.getElementById("boot").hidden = true;
}

async function enterApp(session, recovery) {
  state.userId = session.user.id;
  document.getElementById("who").textContent = session.user.email || "";
  document.getElementById("login").hidden = true;
  document.getElementById("boot").hidden = true;
  document.getElementById("app").hidden = false;
  if (recovery) openPassword(true);
  try {
    await loadAll();
    setSync("ok");
  } catch (err) {
    console.error(err);
    document.getElementById("loading").hidden = true;
    var box = document.getElementById("load-error");
    box.hidden = false;
    box.textContent = "词表读取失败。请刷新页面重试。如果这是刚开通的账号，请联系站长确认词表已经导入。";
  }
}

function openPassword(recovery) {
  document.getElementById("password-lead").textContent = recovery
    ? "请设置一个新密码。设置完成后即可继续使用。"
    : "设置一个新密码。至少 6 位。";
  document.getElementById("password-error").hidden = true;
  document.getElementById("new-password").value = "";
  document.getElementById("new-password-2").value = "";
  document.getElementById("password-modal").hidden = false;
  document.getElementById("new-password").focus();
}

function closePassword() {
  document.getElementById("password-modal").hidden = true;
}

function orderedTickedItems() {
  var rows = [];
  state.videos.forEach(function (video) {
    (state.itemsByPage.get(video.page) || []).forEach(function (item) {
      if (state.ticks.has(item.id)) rows.push(item);
    });
  });
  return rows;
}

function showExport(mode) {
  var rows = orderedTickedItems();
  if (!rows.length) {
    toast("还没有勾选任何单词");
    return;
  }
  var lines = rows.map(function (item) {
    if (mode === "words") return item.en;
    var video = state.videoByPage.get(item.page);
    return [item.en, "P" + item.page, fmt(item.t), jumpUrl(video, item.t)].join("\t");
  });
  state.exportText = lines.join("\n");
  document.getElementById("export-meta").textContent = mode === "words"
    ? "共 " + lines.length + " 个单词"
    : "共 " + lines.length + " 行：单词、视频、时间、链接。用制表符隔开，可以粘贴到表格里。";
  document.getElementById("export-text").value = state.exportText;
  document.getElementById("export-panel").hidden = false;
  document.getElementById("export-panel").scrollIntoView({ block: "nearest" });
}

async function copyExport() {
  var text = state.exportText;
  var area = document.getElementById("export-text");
  try {
    await navigator.clipboard.writeText(text);
    toast("已复制");
    return;
  } catch (err) {
    area.focus();
    area.select();
    try {
      if (document.execCommand("copy")) {
        toast("已复制");
        return;
      }
    } catch (copyErr) { /* 下面提示手动复制 */ }
  }
  toast("请在文本框里全选并复制");
}

function showAuthTab(name) {
  var register = name === "register";
  document.getElementById("login-form").hidden = register;
  document.getElementById("register-form").hidden = !register;
  document.getElementById("tab-login").classList.toggle("on", !register);
  document.getElementById("tab-register").classList.toggle("on", register);
  document.getElementById("tab-login").setAttribute("aria-selected", register ? "false" : "true");
  document.getElementById("tab-register").setAttribute("aria-selected", register ? "true" : "false");
}

function closeReport() {
  document.getElementById("report-modal").hidden = true;
}

async function registerAccount() {
  var button = document.getElementById("reg-submit");
  var err = document.getElementById("reg-error");
  var email = document.getElementById("reg-email").value.trim();
  var password = document.getElementById("reg-password").value;
  var again = document.getElementById("reg-password-2").value;
  var code = document.getElementById("reg-code").value;
  err.hidden = true;
  if (password.length < 6) {
    err.hidden = false;
    err.textContent = "密码至少 6 位。";
    return;
  }
  if (password !== again) {
    err.hidden = false;
    err.textContent = "两次输入的密码不一致。";
    return;
  }
  button.disabled = true;
  button.textContent = "正在注册…";
  try {
    var cfg = readConfig();
    var response = await fetch(cfg.url + "/functions/v1/register", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: cfg.key,
        authorization: "Bearer " + cfg.key,
      },
      body: JSON.stringify({ email: email, password: password, code: code }),
    });
    var payload = {};
    try { payload = await response.json(); } catch (parseErr) { payload = {}; }
    if (!response.ok || !payload.ok) {
      err.hidden = false;
      err.textContent = payload.error || "注册没有成功，请稍后再试。";
      return;
    }
    var signedIn = await state.client.auth.signInWithPassword({ email: email, password: password });
    if (signedIn.error || !signedIn.data.session) {
      showAuthTab("login");
      document.getElementById("email").value = email;
      var loginErr = document.getElementById("login-error");
      loginErr.hidden = false;
      loginErr.textContent = "注册成功了，但自动登录失败。请用刚才的邮箱和密码登录。";
      return;
    }
    await enterApp(signedIn.data.session, false);
  } catch (networkErr) {
    console.error(networkErr);
    err.hidden = false;
    err.textContent = "连不上注册服务。请稍后再试。";
  } finally {
    button.disabled = false;
    button.textContent = "注册";
  }
}

function wire() {
  document.getElementById("tab-login").addEventListener("click", function () { showAuthTab("login"); });
  document.getElementById("tab-register").addEventListener("click", function () { showAuthTab("register"); });
  document.getElementById("register-form").addEventListener("submit", function (event) {
    event.preventDefault();
    registerAccount();
  });

  document.getElementById("login-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var button = document.getElementById("login-submit");
    var err = document.getElementById("login-error");
    err.hidden = true;
    button.disabled = true;
    button.textContent = "正在登录…";
    var email = document.getElementById("email").value.trim();
    var password = document.getElementById("password").value;
    var result = await state.client.auth.signInWithPassword({ email: email, password: password });
    button.disabled = false;
    button.textContent = "登录";
    if (result.error || !result.data.session) {
      console.error(result.error);
      err.hidden = false;
      err.textContent = loginErrorText(result.error);
      return;
    }
    await enterApp(result.data.session, false);
  });

  document.getElementById("logout").addEventListener("click", async function () {
    await state.client.auth.signOut();
    leaveApp();
  });

  document.getElementById("search").addEventListener("compositionstart", function () { composing = true; });
  document.getElementById("search").addEventListener("compositionend", function () {
    composing = false;
    state.query = document.getElementById("search").value;
    renderList();
  });
  document.getElementById("search").addEventListener("input", function () {
    if (composing) return;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function () {
      state.query = document.getElementById("search").value;
      renderList();
    }, 120);
  });

  document.getElementById("video").addEventListener("change", function () {
    state.pageFilter = Number(document.getElementById("video").value) || 0;
    renderList();
  });
  document.getElementById("only").addEventListener("change", function () {
    state.onlyTicked = document.getElementById("only").checked;
    renderList();
  });
  document.getElementById("font-down").addEventListener("click", function () { applyFont(state.fontSize - 2, true); });
  document.getElementById("font-up").addEventListener("click", function () { applyFont(state.fontSize + 2, true); });
  document.getElementById("export-words").addEventListener("click", function () { showExport("words"); });
  document.getElementById("export-detail").addEventListener("click", function () { showExport("detail"); });
  document.getElementById("export-close").addEventListener("click", function () {
    document.getElementById("export-panel").hidden = true;
  });
  document.getElementById("export-copy").addEventListener("click", copyExport);
  document.getElementById("refresh").addEventListener("click", async function () {
    try {
      await refreshTicksOnly();
      toast("已从账号同步");
    } catch (err) {
      console.error(err);
      setSync("error");
      toast("同步失败");
    }
  });

  document.getElementById("clear-open").addEventListener("click", function () {
    document.getElementById("modal").hidden = false;
  });
  document.getElementById("modal-cancel").addEventListener("click", function () {
    document.getElementById("modal").hidden = true;
  });
  document.getElementById("modal").addEventListener("click", function (event) {
    if (event.target.id === "modal") document.getElementById("modal").hidden = true;
  });
  document.getElementById("modal-confirm").addEventListener("click", async function () {
    var button = document.getElementById("modal-confirm");
    button.disabled = true;
    try {
      var result = await state.client.from("ticks").delete().eq("user_id", state.userId);
      if (result.error) throw result.error;
      state.ticks.clear();
      renderList();
      refreshVideoOptions();
      document.getElementById("modal").hidden = true;
      setSync("ok");
      toast("已清空勾选");
    } catch (err) {
      console.error(err);
      toast("清空失败，请稍后再试");
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById("open-password").addEventListener("click", function () { openPassword(false); });
  document.getElementById("password-cancel").addEventListener("click", closePassword);
  document.getElementById("password-modal").addEventListener("click", function (event) {
    if (event.target.id === "password-modal") closePassword();
  });
  document.getElementById("password-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var first = document.getElementById("new-password").value;
    var second = document.getElementById("new-password-2").value;
    var err = document.getElementById("password-error");
    err.hidden = true;
    if (first.length < 6) {
      err.hidden = false;
      err.textContent = "密码至少 6 位。";
      return;
    }
    if (first !== second) {
      err.hidden = false;
      err.textContent = "两次输入的密码不一致。";
      return;
    }
    var button = document.getElementById("password-save");
    button.disabled = true;
    var result = await state.client.auth.updateUser({ password: first });
    button.disabled = false;
    if (result.error) {
      console.error(result.error);
      err.hidden = false;
      err.textContent = /reauth|nonce|current password/i.test(result.error.message || "")
        ? "项目要求验证旧密码，网页里改不了。请联系站长重置密码。"
        : "密码没有改成功。请稍后再试，或联系站长重置。";
      return;
    }
    closePassword();
    toast("密码已更新");
  });

  document.getElementById("list").addEventListener("toggle", function (event) {
    var details = event.target;
    if (!details.classList || !details.classList.contains("video") || !details.open) return;
    var body = details.querySelector(".words");
    if (!body || body.dataset.filled === "1") return;
    body.innerHTML = wordsHtml(visibleItems(Number(details.dataset.page)));
    body.dataset.filled = "1";
  }, true);

  document.getElementById("list").addEventListener("change", function (event) {
    var input = event.target;
    if (!input || input.type !== "checkbox") return;
    var row = input.closest(".word");
    if (!row) return;
    var id = row.dataset.id;
    var on = input.checked;
    if (on) state.ticks.add(id);
    else state.ticks.delete(id);
    row.classList.toggle("on", on);
    if (state.onlyTicked && !on) {
      var details = row.closest("details");
      row.remove();
      var shown = details && details.querySelector(".shown-n");
      if (shown) shown.textContent = String(details.querySelectorAll(".word").length);
      if (details && !details.querySelector(".word")) details.remove();
      if (!document.querySelector("#list details")) document.getElementById("empty").hidden = false;
    }
    refreshProgressDom();
    queueTick(id, on);
  });

  document.getElementById("list").addEventListener("click", function (event) {
    var button = event.target.closest(".flag");
    if (!button) return;
    var row = button.closest(".word");
    if (!row) return;
    state.reportItemId = row.dataset.id;
    var item = state.itemById.get(state.reportItemId);
    document.getElementById("report-word").textContent = item ? item.en : state.reportItemId;
    document.getElementById("report-note").value = "";
    document.getElementById("report-error").hidden = true;
    document.getElementById("report-modal").hidden = false;
    document.getElementById("report-note").focus();
  });

  document.getElementById("report-cancel").addEventListener("click", closeReport);
  document.getElementById("report-modal").addEventListener("click", function (event) {
    if (event.target.id === "report-modal") closeReport();
  });
  document.getElementById("report-form").addEventListener("submit", async function (event) {
    event.preventDefault();
    var err = document.getElementById("report-error");
    var button = document.getElementById("report-save");
    var note = document.getElementById("report-note").value.trim();
    err.hidden = true;
    if (note.length > 500) {
      err.hidden = false;
      err.textContent = "说明请控制在 500 字以内。";
      return;
    }
    button.disabled = true;
    var result = await state.client.from("word_reports").insert({
      user_id: state.userId,
      item_id: state.reportItemId,
      note: note || null,
    });
    button.disabled = false;
    if (result.error) {
      console.error(result.error);
      err.hidden = false;
      err.textContent = "没有提交成功，请稍后再试。";
      return;
    }
    closeReport();
    toast("已提交，谢谢");
  });

  document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;
    document.getElementById("modal").hidden = true;
    closePassword();
    closeReport();
  });
}

async function boot() {
  var arrivedFromRecovery = /(?:^|#|&)type=recovery(?:&|$)/.test(location.hash);
  var cfg = readConfig();
  document.getElementById("purchase-note").textContent = cfg.note || "购买后请联系站长开通账号。";
  wire();
  if (!window.supabase || !window.supabase.createClient) {
    document.getElementById("boot").hidden = true;
    document.getElementById("login").hidden = false;
    showConfigProblems(["页面脚本没有加载完整。请强制刷新（Ctrl+F5）。"]);
    return;
  }
  if (cfg.problems.length) {
    document.getElementById("boot").hidden = true;
    document.getElementById("login").hidden = false;
    showConfigProblems(cfg.problems);
    return;
  }
  state.client = window.supabase.createClient(cfg.url, cfg.key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });
  state.client.auth.onAuthStateChange(function (event) {
    if (event === "PASSWORD_RECOVERY") openPassword(true);
    if (event === "SIGNED_OUT" && !document.getElementById("app").hidden) leaveApp();
  });
  try {
    var sessionResult = await state.client.auth.getSession();
    if (location.hash.indexOf("access_token") >= 0 || location.hash.indexOf("type=") >= 0) {
      history.replaceState(null, "", location.pathname + location.search);
    }
    if (sessionResult.error) throw sessionResult.error;
    if (!sessionResult.data.session) {
      document.getElementById("boot").hidden = true;
      document.getElementById("login").hidden = false;
      return;
    }
    await enterApp(sessionResult.data.session, arrivedFromRecovery);
  } catch (err) {
    console.error(err);
    document.getElementById("boot").hidden = true;
    document.getElementById("login").hidden = false;
    var errEl = document.getElementById("login-error");
    errEl.hidden = false;
    errEl.textContent = "连不上服务器。请检查网络，或联系站长确认网站配置。";
  }
}

boot();
