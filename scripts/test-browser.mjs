// 用无头 Chrome 把登录、勾选、搜索、字号、导出和两个账号的隔离走一遍。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/tmp/pw/package.json");
const puppeteer = require("puppeteer-core");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "data", "corpus_bv1nTNkzjEVn.json"), "utf8"));
const sample = corpus.pages[0].items.find((item) => item.en.includes("'")) || corpus.pages[0].items[0];
const shots = "/tmp/ielts-shots";
mkdirSync(shots, { recursive: true });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

function waitForLine(child, text) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error("没有等到：" + text)), 8000);
    const onData = (chunk) => {
      if (String(chunk).includes(text)) {
        clearTimeout(timer);
        resolvePromise();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error("进程退出 " + code + "，还在等 " + text)));
  });
}

const staticServer = spawn("python3", ["-m", "http.server", "8765", "--bind", "127.0.0.1"], {
  cwd: join(root, "site"),
  stdio: ["ignore", "pipe", "pipe"],
});
const mock = spawn(process.execPath, [
  join(root, "scripts", "mock-supabase.mjs"),
  "--port", "54322",
  "--data", join(root, "data", "corpus_bv1nTNkzjEVn.json"),
  "--static", join(root, "site"),
  "--config-override",
], { stdio: ["ignore", "pipe", "pipe"] });

const browser = await puppeteer.launch({
  executablePath: "/usr/bin/google-chrome",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--window-size=1280,900"],
});

try {
  await waitForLine(mock, "mock supabase");
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);

  await page.setViewport({ width: 1280, height: 900 });
  await page.goto("http://127.0.0.1:8765/", { waitUntil: "networkidle0" });
  await page.waitForSelector("#config-problems");
  const unconfigured = await page.$eval("#config-problems", (el) => el.textContent);
  assert(unconfigured.includes("还没有填写"), unconfigured);
  const raw = await page.content();
  assert(!raw.includes(sample.en), "未配置页面的源码里出现了单词");
  assert(await page.$("#list") === null || await page.$eval("#app", (el) => el.hidden), "未登录时词表区域不该打开");
  const purchase = await page.$eval("#purchase-note", (el) => el.textContent);
  assert(purchase.includes("联系方式"), purchase);
  await page.screenshot({ path: join(shots, "login-unconfigured.png") });

  await page.setCacheEnabled(false);
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (request.url().endsWith("/config.js")) {
      const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
      request.respond({
        status: 200,
        contentType: "application/javascript",
        body: "window.IELTS_CONFIG = " + JSON.stringify({
          supabaseUrl: "https://example.supabase.co",
          supabaseAnonKey: header + "." + payload + ".sig",
          purchaseNote: "购买说明",
        }) + ";",
      });
      return;
    }
    request.continue();
  });
  await page.reload({ waitUntil: "networkidle0" });
  const secretWarning = await page.$eval("#config-problems", (el) => el.textContent);
  assert(secretWarning.includes("不能放在网页里"), secretWarning);
  await page.setRequestInterception(false);

  const app = await browser.newPage();
  app.setDefaultTimeout(20000);
  await app.setViewport({ width: 1280, height: 900 });
  await app.goto("http://127.0.0.1:54322/", { waitUntil: "networkidle0" });
  await app.waitForSelector("#login-form");
  const note = await app.$eval("#purchase-note", (el) => el.textContent);
  assert(note.includes("测试购买说明"), note);
  assert(!(await app.$eval("#app", (el) => el.hidden === false)), "还没登录就打开了词表");
  await app.screenshot({ path: join(shots, "login.png") });

  async function login(email, password) {
    await app.$eval("#email", (el) => { el.value = ""; });
    await app.$eval("#password", (el) => { el.value = ""; });
    await app.type("#email", email);
    await app.type("#password", password);
    await app.click("#login-submit");
  }

  await login("buyer-a@example.com", "wrong-password");
  await app.waitForSelector("#login-error:not([hidden])");
  const loginError = await app.$eval("#login-error", (el) => el.textContent);
  assert(loginError.includes("邮箱或密码不正确"), loginError);

  await login("buyer-a@example.com", "password-a");
  await app.waitForFunction(() => document.getElementById("footer-stats").textContent.includes("5463"));
  const footer = await app.$eval("#footer-stats", (el) => el.textContent);
  assert(footer.includes("共 32 集"), footer);
  const hiddenWords = await app.$$eval("#list .en", (nodes) => nodes.length);
  assert(hiddenWords === 0, "默认应先折叠，不把 5 千行都画出来，实际 " + hiddenWords);
  const summaries = await app.$$eval("#list .sum-id", (nodes) => nodes.map((node) => node.textContent));
  assert(summaries[0] === "P1" && summaries.length === 32, "分集数量不对 " + summaries.length);

  await app.$eval("#search", (el) => { el.value = ""; });
  await app.type("#search", sample.en);
  await app.waitForSelector("#list .word");
  const shown = await app.$$eval("#list .en", (nodes) => nodes.map((node) => node.textContent));
  assert(shown.every((text) => text.toLowerCase().includes(sample.en.toLowerCase())), "搜索结果里有不匹配的词");
  const link = await app.$eval("#list .jump", (el) => el.href);
  assert(link.includes("bilibili.com") && link.includes("t=" + sample.t), link);
  await app.click("#list .word input");
  await app.waitForFunction(() => document.getElementById("global-count").textContent.startsWith("已勾选 1 /"));
  await app.waitForFunction(() => document.getElementById("sync").dataset.mode === "ok");
  const progress = await app.$eval("#list .sum-count", (el) => el.textContent);
  assert(progress.startsWith("1/"), "本集进度没更新：" + progress);
  await app.screenshot({ path: join(shots, "search-ticked.png") });

  await app.click("#only");
  await app.waitForFunction(() => document.querySelectorAll("#list .word").length >= 1);
  const onlyCount = await app.$$eval("#list .word", (nodes) => nodes.length);
  const onlyChecked = await app.$$eval("#list .word input", (nodes) => nodes.every((node) => node.checked));
  assert(onlyCount >= 1 && onlyChecked, "只看已勾选没有只留下勾过的词");

  await app.click("#export-words");
  await app.waitForSelector("#export-panel:not([hidden])");
  const exported = await app.$eval("#export-text", (el) => el.value);
  assert(exported.split("\n").includes(sample.en), exported);
  await app.click("#export-detail");
  const detail = await app.$eval("#export-text", (el) => el.value);
  assert(detail.includes(sample.en) && detail.includes("bilibili.com") && detail.includes("P1"), detail);
  await app.click("#export-close");

  await app.click("#font-up");
  await app.click("#font-up");
  await app.click("#font-up");
  await app.waitForFunction(() => document.getElementById("font-label").textContent === "24");
  await app.waitForFunction(() => getComputedStyle(document.querySelector("#list .en")).fontSize === "24px");
  await app.waitForFunction(() => document.getElementById("sync").dataset.mode === "ok");

  await app.reload({ waitUntil: "networkidle0" });
  await app.waitForFunction(() => document.getElementById("footer-stats").textContent.includes("5463"));
  await app.waitForFunction(() => document.getElementById("global-count").textContent.startsWith("已勾选 1 /"));
  await app.waitForFunction(() => document.getElementById("font-label").textContent === "24");
  const wordSize = await app.$eval("#app", (el) => el.style.getPropertyValue("--word-size"));
  assert(wordSize === "24px", wordSize);

  await app.click("#logout");
  await app.waitForSelector("#login:not([hidden])");
  assert(await app.$eval("#app", (el) => el.hidden), "退出后词表还在");
  const afterLogout = await app.content();
  assert(!afterLogout.includes(sample.en), "退出后页面源码还留着单词");

  await login("buyer-b@example.com", "password-b");
  await app.waitForFunction(() => {
    const who = document.getElementById("who").textContent;
    const loading = document.getElementById("loading");
    return who.includes("buyer-b@example.com") && loading.hidden &&
      document.getElementById("footer-stats").textContent.includes("5463");
  });
  const countB = await app.$eval("#global-count", (el) => el.textContent);
  const fontB = await app.$eval("#font-label", (el) => el.textContent);
  assert(countB === "已勾选 0 / 5463", countB);
  assert(fontB === "18", "用户 B 不该继承用户 A 的字号：" + fontB);

  await app.click("#logout");
  await app.waitForSelector("#login:not([hidden])");
  await login("buyer-a@example.com", "password-a");
  await app.waitForFunction(() => {
    return document.getElementById("who").textContent.includes("buyer-a@example.com") &&
      document.getElementById("loading").hidden &&
      document.getElementById("global-count").textContent.startsWith("已勾选 1 /");
  });
  await app.waitForFunction(() => document.getElementById("font-label").textContent === "24");

  await app.click("#clear-open");
  await app.click("#modal-confirm");
  await app.waitForFunction(() => document.getElementById("global-count").textContent.startsWith("已勾选 0 /"));

  await app.click("#open-password");
  await app.type("#new-password", "password-a2");
  await app.type("#new-password-2", "password-a2");
  await app.click("#password-save");
  await app.waitForFunction(() => document.getElementById("toast").textContent.includes("密码已更新"));
  await app.click("#logout");
  await app.waitForSelector("#login:not([hidden])");
  await login("buyer-a@example.com", "password-a2");
  await app.waitForFunction(() => {
    return document.getElementById("who").textContent.includes("buyer-a@example.com") &&
      document.getElementById("loading").hidden &&
      document.getElementById("footer-stats").textContent.includes("5463");
  });

  await app.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await app.$eval("#search", (el) => { el.value = ""; });
  await app.type("#search", sample.en.slice(0, 4));
  await app.waitForSelector("#list .word");
  const overflow = await app.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert(overflow <= 1, "手机宽度溢出 " + overflow + "px");
  await app.screenshot({ path: join(shots, "mobile-search.png"), fullPage: false });

  await app.setViewport({ width: 1280, height: 900 });
  await app.screenshot({ path: join(shots, "desktop-after-mobile.png") });
  console.log("browser ok", sample.id);
} finally {
  await browser.close();
  mock.kill("SIGTERM");
  staticServer.kill("SIGTERM");
}
