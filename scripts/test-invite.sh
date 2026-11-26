#!/usr/bin/env bash
# 在本地 PostgreSQL 上检查邀请码和报错表：anon 读不到邀请码，登录用户只能提交自己的报错。
set -euo pipefail
cd "$(dirname "$0")/.."

sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "drop database if exists ielts_invite_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d postgres -c "create database ielts_invite_test;"
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test <<'SQL'
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
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end $$;
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -f supabase/schema.sql
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -f supabase/migrations/20261126120000_invite_codes_and_word_reports.sql
node scripts/generate-seed.mjs data/corpus_bv1nTNkzjEVn.json /tmp/ielts-invite-seed >/dev/null
for file in /tmp/ielts-invite-seed/*.sql; do
  sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -f "$file" >/dev/null
done

sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test <<'SQL'
insert into auth.users (id, email) values
  ('11111111-1111-4111-8111-111111111111', 'buyer-a@example.com'),
  ('22222222-2222-4222-8222-222222222222', 'buyer-b@example.com');
SQL

codes=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -tA -c "select public.generate_invite_codes(3);")
count=$(printf '%s\n' "$codes" | grep -cE '^[A-F0-9]{12}$')
if [[ "$count" != "3" ]]; then
  echo "邀请码格式或数量不对：$codes" >&2
  exit 1
fi
first=$(printf '%s\n' "$codes" | head -n 1)

set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -c "begin; set local role anon; select count(*) from public.invite_codes; commit;" >/tmp/ielts-invite-anon.txt 2>&1
anon_codes=$?
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -c "begin; set local role authenticated; select public.generate_invite_codes(1); commit;" >/tmp/ielts-invite-exec.txt 2>&1
auth_exec=$?
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -c "begin; set local role authenticated; select count(*) from public.word_reports; commit;" >/tmp/ielts-invite-read-reports.txt 2>&1
auth_read=$?
set -e
if [[ $anon_codes -eq 0 || $auth_exec -eq 0 || $auth_read -eq 0 ]]; then
  echo "权限过宽 anon=$anon_codes exec=$auth_exec read=$auth_read" >&2
  cat /tmp/ielts-invite-anon.txt /tmp/ielts-invite-exec.txt /tmp/ielts-invite-read-reports.txt >&2
  exit 1
fi

if sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test <<SQL >/tmp/ielts-invite-insert.txt 2>&1
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
insert into public.word_reports (user_id, item_id, note)
  values ('11111111-1111-4111-8111-111111111111', 'P1-001', '拼写');
commit;
SQL
then
  true
else
  echo "自己的报错插入失败" >&2
  cat /tmp/ielts-invite-insert.txt >&2
  exit 1
fi

set +e
sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test <<'SQL' >/tmp/ielts-invite-cross.txt 2>&1
begin;
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
set local role authenticated;
insert into public.word_reports (user_id, item_id, note)
  values ('22222222-2222-4222-8222-222222222222', 'P1-001', '不行');
commit;
SQL
cross=$?
set -e
if [[ $cross -eq 0 ]]; then
  echo "不该能替别人提交报错" >&2
  exit 1
fi

saved=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -tA -c "select count(*) from public.word_reports;")
if [[ "$saved" != "1" ]]; then
  echo "报错没有留下：$saved" >&2
  exit 1
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -c "update public.invite_codes set used_at = now(), used_email = 'buyer-a@example.com' where code = '$first' and used_at is null;" >/dev/null
second=$(sudo -u postgres psql -v ON_ERROR_STOP=1 -d ielts_invite_test -tA -c "update public.invite_codes set used_email = 'other@example.com' where code = '$first' and used_at is null returning code;")
if printf '%s\n' "$second" | grep -qE '^[A-F0-9]{12}$'; then
  echo "邀请码被用了两次：$second" >&2
  exit 1
fi

echo "invite ok $first"
