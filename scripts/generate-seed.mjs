// 从本地 JSON 生成 seed/*.sql。这些 SQL 含有全部单词，已被 .gitignore 排除。
// 用法：node scripts/generate-seed.mjs [json路径] [输出目录]
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { buildSeed } = require('./seed-lib.js');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(process.argv[2] || join(root, 'data', 'corpus_bv1nTNkzjEVn.json'));
const outDir = resolve(process.argv[3] || join(root, 'seed'));

const corpus = JSON.parse(readFileSync(input, 'utf8'));
const seed = buildSeed(corpus);
mkdirSync(outDir, { recursive: true });
for (const file of seed.files) {
  writeFileSync(join(outDir, file.name), file.sql, 'utf8');
  console.log(file.name + '  ' + file.title);
}
console.log('视频 ' + seed.videoCount + '，单词 ' + seed.itemCount);
console.log('写到 ' + outDir);
console.log('按文件名顺序，把每个文件粘贴到 Supabase SQL Editor 运行。不要把这个文件夹上传到 GitHub。');
