// 检查生成的 SQL 能还原全部单词，并且没有把词表写进 site/。
import { createRequire } from "node:module";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { buildSeed } = require("./seed-lib.js");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = JSON.parse(readFileSync(join(root, "data", "corpus_bv1nTNkzjEVn.json"), "utf8"));
const seed = buildSeed(corpus);

function unescapeSql(value) {
  return value.replace(/''/g, "'");
}

function tuples(sql) {
  const out = [];
  const re = /\('((?:[^']|'')*)',\s*(\d+),\s*'((?:[^']|'')*)',\s*(null|'(?:[^']|'')*'),\s*(\d+)\)/g;
  let match;
  while ((match = re.exec(sql))) {
    out.push({
      id: unescapeSql(match[1]),
      page: Number(match[2]),
      en: unescapeSql(match[3]),
      zh: match[4] === "null" ? null : unescapeSql(match[4].slice(1, -1)),
      t: Number(match[5]),
    });
  }
  return out;
}

const itemFiles = seed.files.filter((file) => file.name.startsWith("01_items_"));
const parsed = itemFiles.flatMap((file) => tuples(file.sql));
if (parsed.length !== corpus.total) {
  throw new Error("解析出的单词数是 " + parsed.length + "，JSON 是 " + corpus.total);
}
const byId = new Map(parsed.map((item) => [item.id, item]));
for (const page of corpus.pages) {
  if (!seed.files[0].sql.includes("'" + page.title.replace(/'/g, "''") + "'")) {
    throw new Error("视频标题没有写入 SQL：" + page.title);
  }
  for (const item of page.items) {
    const row = byId.get(item.id);
    if (!row || row.en !== item.en || row.t !== item.t || row.page !== page.page) {
      throw new Error("还原失败：" + item.id);
    }
    if ((item.zh || null) !== row.zh) throw new Error("中文还原失败：" + item.id);
  }
}
const apostrophe = parsed.find((item) => item.en.includes("'"));
if (!apostrophe) throw new Error("没有找到带撇号的单词，转义测试无效");
const rawLine = itemFiles.map((file) => file.sql).join("\n");
if (rawLine.includes("'" + apostrophe.en + "'")) {
  throw new Error("撇号没有转义：" + apostrophe.en);
}

function walk(dir, found) {
  for (const name of readdirSync(dir)) {
    if (name === "vendor") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else found.push(full);
  }
}
const siteFiles = [];
walk(join(root, "site"), siteFiles);
const marker = apostrophe.en;
for (const file of siteFiles.concat([join(root, "README.md"), join(root, "supabase", "schema.sql")])) {
  const text = readFileSync(file, "utf8");
  if (text.includes(marker)) throw new Error("公开文件含有词表内容：" + file);
}

console.log("seed ok", seed.videoCount, "videos", seed.itemCount, "items", itemFiles.length, "chunks");
