-- 雅思听力词汇勾选表
-- 在 Supabase → SQL Editor → New query 中整段粘贴并运行。
-- 可以重复运行。这里没有单词，只有表结构和权限。
--
-- 运行这份脚本的是 Supabase 的管理员，不受下面的权限限制。
-- 所以接下来导入词表时，SQL Editor 仍然可以写入。
-- 网页里的访客（anon）什么都读不到。
-- 登录后的买家（authenticated）只能读词表，并且只能读写自己的勾选和字号。

create table if not exists public.videos (
  page integer primary key check (page > 0),
  title text not null,
  cid bigint,
  duration_s integer,
  url text not null
);

create table if not exists public.items (
  id text primary key,
  page integer not null references public.videos (page) on delete cascade,
  en text not null,
  zh text,
  t integer not null check (t >= 0),
  constraint items_id_matches_page check (split_part(id, '-', 1) = 'P' || page::text)
);

create index if not exists items_page_t_id_idx on public.items (page, t, id);

create table if not exists public.ticks (
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null references public.items (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

create index if not exists ticks_user_id_idx on public.ticks (user_id);

create table if not exists public.preferences (
  user_id uuid primary key references auth.users (id) on delete cascade,
  font_size integer not null default 18 check (font_size between 12 and 40)
);

comment on table public.videos is '听力视频分集。只有登录用户可以读。';
comment on table public.items is '单词。只有登录用户可以读。网页不能修改。';
comment on table public.ticks is '每个买家自己的勾选。';
comment on table public.preferences is '每个买家自己的字号。';

alter table public.videos enable row level security;
alter table public.items enable row level security;
alter table public.ticks enable row level security;
alter table public.preferences enable row level security;

-- 新建表时 Supabase 会默认把权限授给 anon。先全部收回，再只开放需要的操作。
revoke all on table public.videos from public, anon, authenticated;
revoke all on table public.items from public, anon, authenticated;
revoke all on table public.ticks from public, anon, authenticated;
revoke all on table public.preferences from public, anon, authenticated;

grant select on table public.videos to authenticated;
grant select on table public.items to authenticated;
grant select, insert, delete on table public.ticks to authenticated;
grant select, insert, update on table public.preferences to authenticated;

drop policy if exists videos_read_authenticated on public.videos;
create policy videos_read_authenticated
  on public.videos
  for select
  to authenticated
  using (true);

drop policy if exists items_read_authenticated on public.items;
create policy items_read_authenticated
  on public.items
  for select
  to authenticated
  using (true);

drop policy if exists ticks_read_own on public.ticks;
create policy ticks_read_own
  on public.ticks
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists ticks_insert_own on public.ticks;
create policy ticks_insert_own
  on public.ticks
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists ticks_delete_own on public.ticks;
create policy ticks_delete_own
  on public.ticks
  for delete
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists preferences_read_own on public.preferences;
create policy preferences_read_own
  on public.preferences
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists preferences_insert_own on public.preferences;
create policy preferences_insert_own
  on public.preferences
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists preferences_update_own on public.preferences;
create policy preferences_update_own
  on public.preferences
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
