#!/usr/bin/env bash
# 在本机 PostgreSQL 上执行真正的 schema.sql 和 RLS，确认 anon 读不到、买家只能动自己的行。
set -euo pipefail
cd "$(dirname "$0")/.."

sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists ielts_rls_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "create database ielts_rls_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test <<'SQL'
create schema if not exists auth;
create table auth.users (
  id uuid primary key,
  email text
);
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -f supabase/schema.sql
node scripts/generate-seed.mjs data/corpus_bv1nTNkzjEVn.json /tmp/ielts-seed
for file in /tmp/ielts-seed/*.sql; do
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -f "$file" >/tmp/ielts-seed-run.txt
done
check=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -tA -c "select (select count(*) from public.videos)::text || ',' || (select count(*) from public.items)::text;")
if [[ "$check" != "32,5463" ]]; then
  echo "导入结果不对：$check" >&2
  exit 1
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'buyer-a@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'buyer-b@example.com');
insert into public.ticks (user_id, item_id)
  values ('22222222-2222-4222-8222-222222222222', 'P1-002');
insert into public.preferences (user_id, font_size)
  values ('22222222-2222-4222-8222-222222222222', 18);
SQL

count=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -tA <<'SQL' | grep -E '^[0-9]+,'
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
insert into public.ticks (user_id, item_id)
  values ('11111111-1111-4111-8111-111111111111', 'P1-001');
insert into public.preferences (user_id, font_size)
  values ('11111111-1111-4111-8111-111111111111', 22);
update public.preferences set font_size = 30
  where user_id = '11111111-1111-4111-8111-111111111111';
update public.preferences set font_size = 99
  where user_id = '22222222-2222-4222-8222-222222222222';
delete from public.ticks
  where user_id = '22222222-2222-4222-8222-222222222222';
select
  (select count(*) from public.items)::text || ',' ||
  (select count(*) from public.ticks)::text || ',' ||
  (select coalesce(string_agg(item_id, ',' order by item_id), '') from public.ticks) || ',' ||
  (select font_size::text from public.preferences where user_id = '11111111-1111-4111-8111-111111111111');
commit;
SQL
)
# A 能读到 5463 个词，只能看见自己的 1 条勾选，字号改成 30。B 的勾选删不掉。
if [[ "$count" != "5463,1,P1-001,30" ]]; then
  echo "用户 A 的 RLS 结果不对：$count" >&2
  exit 1
fi

b_font=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -tA -c "select font_size from public.preferences where user_id = '22222222-2222-4222-8222-222222222222';")
b_tick=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test -tA -c "select count(*) from public.ticks where user_id = '22222222-2222-4222-8222-222222222222';")
if [[ "$b_font" != "18" || "$b_tick" != "1" ]]; then
  echo "用户 A 改动了用户 B 的数据：font=$b_font ticks=$b_tick" >&2
  exit 1
fi

set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test <<'SQL' >/tmp/ielts-anon.txt 2>&1
begin;
set local role anon;
select count(*) from public.items;
commit;
SQL
anon_status=$?
set -e
if [[ $anon_status -eq 0 ]]; then
  echo "anon 不该读到 items" >&2
  exit 1
fi
if ! grep -q "permission denied" /tmp/ielts-anon.txt; then
  echo "anon 的报错不是 permission denied：" >&2
  cat /tmp/ielts-anon.txt >&2
  exit 1
fi

set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test <<'SQL' >/tmp/ielts-cross.txt 2>&1
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
insert into public.ticks (user_id, item_id)
  values ('22222222-2222-4222-8222-222222222222', 'P1-003');
commit;
SQL
cross_status=$?
set -e
if [[ $cross_status -eq 0 ]]; then
  echo "用户 A 不该能插入用户 B 的勾选" >&2
  exit 1
fi

set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_rls_test <<'SQL' >/tmp/ielts-write-items.txt 2>&1
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
insert into public.items (id, page, en, t) values ('P1-99999', 1, 'nope', 1);
commit;
SQL
write_status=$?
set -e
if [[ $write_status -eq 0 ]]; then
  echo "登录用户不该能插入单词" >&2
  exit 1
fi

echo "rls ok $check"
