-- 已有项目补这一份即可。不要重跑整个 schema.sql。
-- 在 Supabase → SQL Editor 里整段运行。可以重复运行。
-- 不会改 videos / items / ticks / preferences。
--
-- 邀请码只有数据库管理员和服务端密钥能读写。
-- 公开的 anon key 不能生成、查看或核销邀请码。
-- 单词报错只有登录用户能提交自己的，不能查看别人的。

create table if not exists public.invite_codes (
  code text primary key check (code ~ '^[A-F0-9]{12}$'),
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_by uuid references auth.users (id) on delete set null,
  used_email text
);

create index if not exists invite_codes_used_at_idx on public.invite_codes (used_at);

create table if not exists public.word_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  item_id text not null references public.items (id) on delete cascade,
  note text,
  created_at timestamptz not null default now(),
  constraint word_reports_note_len check (note is null or char_length(note) <= 500)
);

create index if not exists word_reports_created_at_idx on public.word_reports (created_at desc);

comment on table public.invite_codes is '一次性邀请码。用过之后不能再用。';
comment on table public.word_reports is '买家报告单词有误。站长在 SQL Editor 里查看。';

alter table public.invite_codes enable row level security;
alter table public.word_reports enable row level security;

revoke all on table public.invite_codes from public, anon, authenticated;
revoke all on table public.word_reports from public, anon, authenticated;

grant insert on table public.word_reports to authenticated;
grant all on table public.invite_codes to service_role;
grant all on table public.word_reports to service_role;

drop policy if exists word_reports_insert_own on public.word_reports;
create policy word_reports_insert_own
  on public.word_reports
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- 没有 select / update / delete 策略：登录用户不能读报错，也不能改别人的。

create or replace function public.generate_invite_codes(n integer)
returns setof text
language plpgsql
as $$
declare
  i integer;
  attempt integer;
  new_code text;
begin
  if n is null or n < 1 or n > 500 then
    raise exception '数量要在 1 到 500 之间';
  end if;

  for i in 1..n loop
    attempt := 0;
    loop
      new_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));
      begin
        insert into public.invite_codes (code) values (new_code);
        exit;
      exception when unique_violation then
        attempt := attempt + 1;
        if attempt > 20 then
          raise exception '生成邀请码失败，请再运行一次';
        end if;
      end;
    end loop;
    return next new_code;
  end loop;
end;
$$;

revoke all on function public.generate_invite_codes(integer) from public, anon, authenticated;
grant execute on function public.generate_invite_codes(integer) to postgres;
