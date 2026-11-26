# 雅思听力词汇勾选表

这是一个放在 GitHub Pages 上的付费词表。买家用邀请码自己注册，登录后勾选单词，点时间可以跳到 B 站视频里的原句。勾选和字号保存在 Supabase，换手机或电脑登录同一个邮箱就能看到。

单词不在这个仓库里，也不会出现在未登录的页面上。没有账号的人只能看到登录页。

部署完成后的网址：

https://wdppx620.github.io/ielts-listening-checklist/

## 你需要亲手做的事

1. 创建一个免费的 Supabase 项目。
2. 在 SQL Editor 里运行 `supabase/schema.sql`。
3. 用本仓库的工具，把语料库 JSON 生成 SQL，再分段粘贴到 SQL Editor。
4. 关闭公开注册，并关掉匿名登录。注册走邀请码，这一项要一直关着。
5. 把 Supabase 网址和 anon key 填进 `site/config.js`，提交到 `main`。
6. 在仓库 Settings → Pages 里把 Source 选成 GitHub Actions。
7. 部署邀请码函数后，在 SQL Editor 里生成邀请码发给买家。也可以继续在后台手动建账号。重置密码、删除账号的办法不变。

网页本身不用安装、不用打包。买家打开上面的网址即可。

## 开始之前

准备这三样东西：

- 这个 GitHub 仓库的管理权限。
- 一个 Supabase 账号：[https://supabase.com](https://supabase.com)（用 GitHub 登录即可，选 Free 计划）。
- 语料库文件 `corpus_bv1nTNkzjEVn.json`。把它放在自己电脑上。不要上传到 GitHub，不要发到群里。

Supabase 项目的数据库密码，和买家的登录密码不是一回事。数据库密码你自己保管。买家的密码是你后面逐个创建账号时设置的。

## 1. 创建 Supabase 项目

1. 打开 [https://supabase.com/dashboard](https://supabase.com/dashboard)，点 **New project**。
2. 起一个名字，例如 `ielts-listening`。
3. 设置数据库密码，记在只有你知道的地方。
4. 区域选离买家近一些的，例如 Singapore。区域以后不能改。
5. 等项目状态变成可用（右上角不再转圈）。可能要几分钟。

然后打开 **Project Settings → API**（有的项目叫 **API Keys**）：

- 复制 **Project URL**。形如 `https://xxxxxxxx.supabase.co`。
- 复制公开钥匙：
  - 如果页面上是 **anon** / **public**，复制这一把。
  - 如果页面上是 **Publishable key** 和 **Secret key**，复制 **Publishable key**。
- **不要**复制 `service_role`，也 **不要**复制 **Secret key**。那两把钥匙能绕过所有权限。网页里一旦写上，别人就能直接改你的数据库。

## 2. 建立数据表

1. 在 Supabase 左侧打开 **SQL Editor**。
2. 点 **New query**。
3. 打开本仓库的 `supabase/schema.sql`，全选复制，粘贴进去。
4. 点 **Run**。
5. 看到 **Success** 就可以。这个脚本没有单词，只有表和权限，重复运行也没关系。

它会建立四张表：

| 表 | 内容 | 谁能访问 |
| --- | --- | --- |
| `videos` | 32 集视频的标题和链接 | 登录用户只能读 |
| `items` | 单词、时间、可选中文 | 登录用户只能读 |
| `ticks` | 每个买家勾了哪些词 | 只能读写自己的 |
| `preferences` | 每个买家的字号 | 只能读写自己的 |

没登录的访客（anon）对这四张表没有任何权限。

## 3. 导入单词

先确认第 2 步已经成功。导入可以重复做，已经存在的行会自动跳过。

### 用浏览器（推荐）

1. 在 GitHub 仓库页面点 **Code → Download ZIP**，解压。
2. 双击打开解压出来的 `tools/make-seed.html`。要在自己的电脑上打开，不要在 GitHub 网页里打开。
3. 选择 `corpus_bv1nTNkzjEVn.json`。
4. 页面会列出大约 9 段 SQL。按顺序处理每一段：
   - 点 **复制**（如果复制没反应，点 **下载**，用记事本打开再全选复制）。
   - 回到 Supabase → **SQL Editor** → **New query**，粘贴，点 **Run**。
   - 看到 **Success** 再做下一段。
5. 最后一段 `99_check.sql` 的结果必须是：

```text
videos = 32
items  = 5463
```

如果数字不对，从第一段再运行一遍。这个脚本可以重复运行。

生成出来的 SQL 含有全部单词。不要把它们提交到 GitHub。仓库已经忽略了 `data/` 和 `seed/` 这两个文件夹，请不要手动把它们加进去。

### 用命令行（可选）

如果电脑已经装了 Node.js：

```bash
mkdir -p data
# 把 JSON 放到 data/corpus_bv1nTNkzjEVn.json
node scripts/generate-seed.mjs
```

然后按 `seed/` 里的文件名顺序，把每个文件粘贴到 SQL Editor 运行。

## 4. 关闭公开注册

公开注册必须保持关闭。网页上的「注册」不会走 Supabase 的公开注册，而是把邀请码交给服务器上的函数。函数核对邀请码后才建账号。

如果把 **Allow new users to sign up** 打开，别人拿到网页里的 anon key 就可以不填邀请码自己注册。

1. 打开 **Authentication → Sign In / Providers**（有的项目在 **Authentication → Providers**）。
2. 确认 **Email** 是开启的。买家靠邮箱和密码登录，这一项不能关。
3. 关掉 **Allow new users to sign up**（允许新用户注册）。它有时在这一页的最上面，有时在 Email 的设置里。
4. 确认 **Allow anonymous sign-ins**（匿名登录）也是关的。

关掉之后：

- 没有邀请码就不能注册。
- 你在后台手动添加的账号仍然可以登录。
- 用过的邀请码不能再用。

可选，但建议做，否则「忘记密码」的邮件会跳到 localhost：

1. 打开 **Authentication → URL Configuration**。
2. **Site URL** 填：

```text
https://wdppx620.github.io/ielts-listening-checklist/
```

3. **Redirect URLs** 里也加上同一条。

## 5. 填写 config.js

只改 `site/config.js` 这一个文件。

1. 在 GitHub 打开 `site/config.js`，点铅笔图标编辑。也可以在电脑上改完再提交。
2. `supabaseUrl` 换成第 1 步的 Project URL，不要末尾斜杠。
3. `supabaseAnonKey` 换成 anon public key 或 publishable key。
4. `purchaseNote` 写成你希望出现在登录页上的购买说明，例如微信号。用 `\n` 可以换行。
5. 提交到 **main** 分支。

anon / publishable key 出现在网页里是正常的。真正拦住别人的是第 2 步的权限，以及第 4 步关掉的注册。`service_role` 和 secret key 绝不能写进这个文件。写错的话，网页会拒绝启动并提示你改回来。

## 6. 打开 GitHub Pages

1. 打开仓库 **Settings → Pages**。
2. **Build and deployment → Source** 选 **GitHub Actions**。
3. 打开 **Actions**。`main` 上每一次提交都会跑 **Deploy GitHub Pages**。
4. 等它变成绿色。
5. 打开 [https://wdppx620.github.io/ielts-listening-checklist/](https://wdppx620.github.io/ielts-listening-checklist/)。

如果 Action 是红色，点进去看错误。最常见的是 Pages 还没选 GitHub Actions。选好之后，在失败的那次运行里点 **Re-run jobs**。

登录页应该出现，并且看不到任何单词。如果页面写着「还没有填写」，说明 `config.js` 还是占位符，或者新的部署还没跑完。改完后强制刷新（Ctrl+F5）。

然后用下一节的方法给自己开一个账号，登录后看页面底部是不是：

```text
共 32 集 · 5463 个单词
```

能看到这行，并且能勾选、搜索、改字号，就配置好了。

## 7. 给买家开通账号

买家付款后，生成一个邀请码，私下发给对方。对方打开网站，点「注册」，填写自己的邮箱、密码和邀请码。注册成功会直接登录，不需要再去邮箱里点确认信。

一个邀请码只能用一次。用过之后会记下邮箱和使用时间。

在 **SQL Editor → New query** 里运行：

```sql
select public.generate_invite_codes(20);
```

把 `20` 换成你这次要的数量，最少 1，最多 500。结果里每一行是一个邀请码。

查看哪些用过、哪些还没用：

```sql
select
  code,
  created_at,
  used_at,
  used_email,
  case when used_at is null then '未使用' else '已使用' end as status
from public.invite_codes
order by created_at desc;
```

只看还没用的：

```sql
select code, created_at
from public.invite_codes
where used_at is null
order by created_at;
```

登录页底部的购买说明可以改成「付款后把邀请码发给你」。改 `site/config.js` 里的 `purchaseNote`。

仍然可以手动建账号：Authentication → Users → Add user → Create new user，勾选 **Auto Confirm User**。这不消耗邀请码。不要用 Invite user，除非对方愿意去邮箱里点链接。

## 8. 重置密码

买家还记得旧密码时：登录后点右上角 **修改密码**。

买家忘了密码时，用 SQL 改密码。这样做不会丢掉他已经勾过的词。

1. 打开 **SQL Editor → New query**。
2. 粘贴下面这段，把邮箱和新密码换成真实的，然后 Run：

```sql
update auth.users
set encrypted_password = extensions.crypt('这里换成新密码', extensions.gen_salt('bf'))
where email = '买家的邮箱';
```

3. 如果提示 `function extensions.crypt does not exist`，改成下面这样再运行：

```sql
update auth.users
set encrypted_password = crypt('这里换成新密码', gen_salt('bf'))
where email = '买家的邮箱';
```

4. 成功时会显示更新了 1 行。把新密码私下发给买家。

SQL Editor 里会留下这段文字，所以用完可以清掉查询历史，密码不要用买家在别的网站用过的密码。

另一条路是邮件重置，前提是第 4 步已经把 Site URL 改成了这个网站：

1. **Authentication → Users**，找到这个人。
2. 右侧 **⋮ → Reset password**。
3. 对方打开邮件里的链接，会回到这个网站，并被要求设置新密码。

如果邮件里的链接打开的是 `localhost`，就是 Site URL 还没改。邮件没收到时，用上面的 SQL。

不要用「删掉用户再重建」来改密码。删掉用户会连带删掉他的勾选。

## 9. 取消某人的访问

1. **Authentication → Users**。
2. 找到这个人，右侧 **⋮ → Delete user**。
3. 确认删除。

对方立刻不能再登录。他的勾选和字号会一起删除。单词表本身还在，其他买家不受影响。

## 10. 查看买家报告的错误

登录后，每个单词旁边有「报错」。对方可以留下一句说明。你在 SQL Editor 里查看：

```sql
select
  r.created_at,
  u.email,
  r.item_id,
  i.page,
  i.en,
  i.t,
  r.note
from public.word_reports r
join public.items i on i.id = r.item_id
left join auth.users u on u.id = r.user_id
order by r.created_at desc;
```

买家只能提交自己的报错，不能看到别人提交的内容。

## 买家看到的功能

- 用邀请码注册，或用已有邮箱登录。
- 按 P1 到 P32 分集，每集有「已勾选 / 总数」和进度条。
- 勾选单词。勾选会马上记到账号里。
- 点时间，在新标签打开 B 站对应的秒数。
- 搜索英文。
- 「只看已勾选」。
- 视频下拉框，选项里也有每一集的进度。
- 导出已勾选的单词，或导出「单词、视频、时间、链接」。
- 字号 A− / A+，范围 14 到 36，记在账号里。
- 清空自己的全部勾选。
- 修改密码、退出、刷新（从账号重新拉取勾选和字号）。
- 每个单词可以点「报错」，附上一句说明。

旧的单文件原型把勾选存在浏览器本地，这个网站不会把那些勾选搬过来。

## 常见问题

**登录页一直说还没有填写 Supabase。**  
`site/config.js` 仍是 `YOUR_PROJECT_REF` 或 `YOUR_SUPABASE_ANON_KEY`，或者改完还没部署。看 Actions 是不是绿色，然后强制刷新。

**邮箱或密码不正确。**  
密码区分大小写。也可以在 SQL Editor 用第 8 步重设。

**这个账号还没激活。**  
这是手动创建的账号，创建时没有勾选 Auto Confirm User。删掉这个用户，重新创建并勾选。用邀请码注册的账号不需要这一步。还没勾选过单词的话，删掉没有损失。

**邀请码无效或已经使用过。**  
对照上面的查询，看这个码是不是已经有 `used_at`。用过的码不能再用，再生成一个即可。

**注册页一直连不上。**  
公开注册要保持关闭。另外要确认名为 `register` 的函数已经部署，并且 `verify_jwt` 是关闭的。没有部署这个函数时，注册会失败，登录和手动开通的账号不受影响。

**能登录，但词表是空的，或底部不是 5463。**  
`99_check.sql` 的结果不是 32 和 5463。把生成的 SQL 按顺序再运行一遍。

**能登录，但提示词表读取失败。**  
`schema.sql` 没跑成功，或 anon key 填错。可以重新运行 `schema.sql`。

**勾选换一台设备看不到。**  
两台设备要登录同一个邮箱。登录后如果还是旧的，点「刷新」。

**担心仓库是公开的。**  
可以公开。词表只在 Supabase 里，并且只有登录用户能读。不要把 `data/`、`seed/` 或生成的 SQL 提交上去。登录之后的买家可以在自己的浏览器里看到全部单词，这是正常的，因为他已经买了账号。

## 网站里有哪些文件

- `site/`：实际发布到 GitHub Pages 的网页。`config.js` 是唯一要改的配置。`vendor/supabase.js` 是已下载好的登录库，避免买家的浏览器再去加载国外 CDN。
- `supabase/schema.sql`：第一次建表和权限。已经建过库就不要整份重跑。
- `supabase/migrations/20261126120000_invite_codes_and_word_reports.sql`：给已经建好的库加上邀请码和报错。在 SQL Editor 里整段运行一次。
- `supabase/functions/register/index.ts`：注册函数。要部署到 Supabase，并且 `verify_jwt` 设为关闭。部署时不要把 service_role / secret key 写进网页。
- `supabase/config.toml`：标明这个函数不校验登录令牌。安全靠「公开注册关闭」和「邀请码只用一次」。
- `tools/make-seed.html` 和 `scripts/generate-seed.mjs`：在你自己的电脑上把 JSON 变成 SQL。
- `.github/workflows/pages.yml`：推到 `main` 时，只把 `site/` 发布到 GitHub Pages。
- `scripts/test-*.mjs` 和 `scripts/mock-supabase.mjs`：开发时用来检查网页，部署和卖给买家都不需要运行。
