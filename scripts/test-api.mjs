// 用真实的 supabase-js 对本地替身跑登录、分页、RLS 和勾选隔离。
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire("/tmp/sbtest/package.json");
const { createClient } = require("@supabase/supabase-js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = 54321;
const anonKey = "test-anon-key";
const url = "http://127.0.0.1:" + port;

const child = spawn(process.execPath, [
  join(root, "scripts", "mock-supabase.mjs"),
  "--port", String(port),
  "--data", join(root, "data", "corpus_bv1nTNkzjEVn.json"),
], { stdio: ["ignore", "pipe", "pipe"] });
child.stderr.on("data", (chunk) => process.stderr.write(chunk));
await new Promise((resolvePromise, reject) => {
  const timer = setTimeout(() => reject(new Error("mock 没有启动")), 8000);
  child.stdout.on("data", (chunk) => {
    if (String(chunk).includes("mock supabase")) {
      clearTimeout(timer);
      resolvePromise();
    }
  });
  child.on("exit", (code) => reject(new Error("mock 退出 " + code)));
});

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function fetchAll(make) {
  const pageSize = 1000;
  const rows = [];
  for (let from = 0; from <= 20000; from += pageSize) {
    const result = await make(from, from + pageSize - 1);
    if (result.error) throw result.error;
    const batch = result.data || [];
    rows.push(...batch);
    if (batch.length < pageSize) break;
  }
  return rows;
}

try {
  const anon = await fetch(url + "/rest/v1/items?select=id&limit=1", { headers: { apikey: anonKey, authorization: "Bearer " + anonKey } });
  assert(anon.status === 401, "未登录应读不到单词，实际 " + anon.status);

  const clientA = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const bad = await clientA.auth.signInWithPassword({ email: "buyer-a@example.com", password: "nope" });
  assert(bad.error, "错误密码应该登录失败");

  const loginA = await clientA.auth.signInWithPassword({ email: "buyer-a@example.com", password: "password-a" });
  assert(!loginA.error && loginA.data.user, loginA.error && loginA.error.message);
  const userA = loginA.data.user.id;

  const corpus = JSON.parse(readFileSync(join(root, "data", "corpus_bv1nTNkzjEVn.json"), "utf8"));
  const sample = corpus.pages[0].items[0];
  const videos = await fetchAll((from, to) => clientA.from("videos").select("page,title,url").order("page").range(from, to));
  const items = await fetchAll((from, to) => clientA.from("items").select("id,page,en,zh,t").order("page").order("t").order("id").range(from, to));
  assert(videos.length === 32, "视频数 " + videos.length);
  assert(items.length === corpus.total, "单词数 " + items.length);
  const found = items.find((item) => item.id === sample.id);
  assert(found && found.en === sample.en && found.t === sample.t, "单词内容不一致");

  const blocked = await clientA.from("items").insert({ id: "P1-99999", page: 1, en: "nope", t: 1 });
  assert(blocked.error, "登录用户不应该能改词表");

  const otherTick = await clientA.from("ticks").insert({ user_id: "22222222-2222-4222-8222-222222222222", item_id: sample.id });
  assert(otherTick.error, "不应该能给别人写勾选");

  const own = await clientA.from("ticks").upsert(
    { user_id: userA, item_id: sample.id },
    { onConflict: "user_id,item_id", ignoreDuplicates: true }
  );
  assert(!own.error, own.error && own.error.message);
  const font = await clientA.from("preferences").upsert(
    { user_id: userA, font_size: 30 },
    { onConflict: "user_id" }
  );
  assert(!font.error, font.error && font.error.message);

  const clientB = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const loginB = await clientB.auth.signInWithPassword({ email: "buyer-b@example.com", password: "password-b" });
  assert(!loginB.error, loginB.error && loginB.error.message);
  const ticksB = await clientB.from("ticks").select("item_id,user_id");
  assert(!ticksB.error, ticksB.error && ticksB.error.message);
  assert((ticksB.data || []).length === 0, "用户 B 看到了用户 A 的勾选");
  const prefsB = await clientB.from("preferences").select("font_size,user_id");
  assert(!prefsB.error && (prefsB.data || []).length === 0, "用户 B 看到了用户 A 的字号");

  const ticksA = await clientA.from("ticks").select("item_id");
  assert(ticksA.data && ticksA.data.length === 1 && ticksA.data[0].item_id === sample.id, "用户 A 的勾选没有保存");
  const prefsA = await clientA.from("preferences").select("font_size");
  assert(prefsA.data && prefsA.data[0] && prefsA.data[0].font_size === 30, "字号没有保存");

  const removed = await clientA.from("ticks").delete().eq("user_id", userA).eq("item_id", sample.id);
  assert(!removed.error, removed.error && removed.error.message);
  const after = await clientA.from("ticks").select("item_id");
  assert(after.data && after.data.length === 0, "勾选没有删除");

  const updated = await clientA.auth.updateUser({ password: "password-a2" });
  assert(!updated.error, updated.error && updated.error.message);
  await clientA.auth.signOut();
  const oldPassword = await clientA.auth.signInWithPassword({ email: "buyer-a@example.com", password: "password-a" });
  assert(oldPassword.error, "旧密码仍然可以登录");
  const newPassword = await clientA.auth.signInWithPassword({ email: "buyer-a@example.com", password: "password-a2" });
  assert(!newPassword.error, "新密码不能登录");

  console.log("api ok");
} finally {
  child.kill("SIGTERM");
}
