-- 지출 일기 — 공유 가계부(household) 마이그레이션
-- schema.sql 실행이 이미 끝난 기존 프로젝트에 추가로 적용합니다.
-- Supabase 대시보드 > SQL Editor 에서 이 파일 전체를 한 번 실행하세요.

-- ---------------------------------------------------------------
-- 1. profiles — auth.users를 클라이언트에서 직접 조회할 수 없으므로
--    같은 가계부 멤버의 이름/이메일을 보여주기 위한 공개 테이블
-- ---------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text not null,
  full_name  text,
  avatar_url text,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 2. households
-- ---------------------------------------------------------------
create table public.households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- 3. household_members
-- ---------------------------------------------------------------
create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id      uuid not null references auth.users(id) on delete cascade,
  role         text not null default 'member' check (role in ('owner', 'member')),
  joined_at    timestamptz not null default now(),
  primary key (household_id, user_id)
);
create index household_members_user_id_idx on public.household_members(user_id);

-- 재귀적 RLS를 피하기 위한 security definer 헬퍼
-- (테이블 소유자 권한으로 실행되어 household_members RLS를 우회한다)
create or replace function public.my_household_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select household_id from public.household_members where user_id = auth.uid();
$$;

-- ---------------------------------------------------------------
-- 4. household_invites
-- ---------------------------------------------------------------
create table public.household_invites (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references public.households(id) on delete cascade,
  invited_email text not null,
  invited_by    uuid not null references auth.users(id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at    timestamptz not null default now(),
  responded_at  timestamptz
);
create index household_invites_email_idx on public.household_invites(invited_email);
create index household_invites_household_idx on public.household_invites(household_id);

-- ---------------------------------------------------------------
-- 5. 기존 테이블에 household_id 컬럼 추가 (nullable로 우선 추가 → 백필 → NOT NULL)
-- ---------------------------------------------------------------
alter table public.categories add column household_id uuid references public.households(id) on delete cascade;
alter table public.repeat_templates add column household_id uuid references public.households(id) on delete cascade;
alter table public.expense_items add column household_id uuid references public.households(id) on delete cascade;
alter table public.assets add column household_id uuid references public.households(id) on delete cascade;

-- ---------------------------------------------------------------
-- 6. 백필 — 기존 유저마다 개인 household를 만들고 기존 데이터를 옮긴다
-- ---------------------------------------------------------------
do $$
declare
  u record;
  new_household_id uuid;
begin
  for u in select id, email, raw_user_meta_data from auth.users loop
    insert into public.profiles (id, email, full_name, avatar_url)
    values (
      u.id, u.email,
      u.raw_user_meta_data ->> 'full_name',
      u.raw_user_meta_data ->> 'avatar_url'
    )
    on conflict (id) do nothing;

    insert into public.households (name, created_by)
    values (coalesce(u.raw_user_meta_data ->> 'full_name', u.email) || '의 가계부', u.id)
    returning id into new_household_id;

    insert into public.household_members (household_id, user_id, role)
    values (new_household_id, u.id, 'owner');

    update public.categories set household_id = new_household_id where user_id = u.id and household_id is null;
    update public.repeat_templates set household_id = new_household_id where user_id = u.id and household_id is null;
    update public.expense_items set household_id = new_household_id where user_id = u.id and household_id is null;
    update public.assets set household_id = new_household_id where user_id = u.id and household_id is null;
  end loop;
end $$;

alter table public.categories alter column household_id set not null;
alter table public.repeat_templates alter column household_id set not null;
alter table public.expense_items alter column household_id set not null;
alter table public.assets alter column household_id set not null;

create index categories_household_id_idx on public.categories(household_id);
create index repeat_templates_household_id_idx on public.repeat_templates(household_id);
create index expense_items_household_id_idx on public.expense_items(household_id);
create index assets_household_id_idx on public.assets(household_id);

-- ---------------------------------------------------------------
-- 7. 기존 user_id 기반 RLS 정책을 household_id 기반으로 교체
-- ---------------------------------------------------------------
drop policy "categories_select_own" on public.categories;
drop policy "categories_insert_own" on public.categories;
drop policy "categories_update_own" on public.categories;
drop policy "categories_delete_own" on public.categories;
create policy "categories_select_member" on public.categories for select using (household_id in (select public.my_household_ids()));
create policy "categories_insert_member" on public.categories for insert with check (household_id in (select public.my_household_ids()));
create policy "categories_update_member" on public.categories for update using (household_id in (select public.my_household_ids())) with check (household_id in (select public.my_household_ids()));
create policy "categories_delete_member" on public.categories for delete using (household_id in (select public.my_household_ids()));

drop policy "repeat_templates_select_own" on public.repeat_templates;
drop policy "repeat_templates_insert_own" on public.repeat_templates;
drop policy "repeat_templates_update_own" on public.repeat_templates;
drop policy "repeat_templates_delete_own" on public.repeat_templates;
create policy "repeat_templates_select_member" on public.repeat_templates for select using (household_id in (select public.my_household_ids()));
create policy "repeat_templates_insert_member" on public.repeat_templates for insert with check (household_id in (select public.my_household_ids()));
create policy "repeat_templates_update_member" on public.repeat_templates for update using (household_id in (select public.my_household_ids())) with check (household_id in (select public.my_household_ids()));
create policy "repeat_templates_delete_member" on public.repeat_templates for delete using (household_id in (select public.my_household_ids()));

drop policy "expense_items_select_own" on public.expense_items;
drop policy "expense_items_insert_own" on public.expense_items;
drop policy "expense_items_update_own" on public.expense_items;
drop policy "expense_items_delete_own" on public.expense_items;
create policy "expense_items_select_member" on public.expense_items for select using (household_id in (select public.my_household_ids()));
create policy "expense_items_insert_member" on public.expense_items for insert with check (household_id in (select public.my_household_ids()));
create policy "expense_items_update_member" on public.expense_items for update using (household_id in (select public.my_household_ids())) with check (household_id in (select public.my_household_ids()));
create policy "expense_items_delete_member" on public.expense_items for delete using (household_id in (select public.my_household_ids()));

drop policy "assets_select_own" on public.assets;
drop policy "assets_insert_own" on public.assets;
drop policy "assets_update_own" on public.assets;
drop policy "assets_delete_own" on public.assets;
create policy "assets_select_member" on public.assets for select using (household_id in (select public.my_household_ids()));
create policy "assets_insert_member" on public.assets for insert with check (household_id in (select public.my_household_ids()));
create policy "assets_update_member" on public.assets for update using (household_id in (select public.my_household_ids())) with check (household_id in (select public.my_household_ids()));
create policy "assets_delete_member" on public.assets for delete using (household_id in (select public.my_household_ids()));

-- ---------------------------------------------------------------
-- 8. profiles / households / household_members / household_invites RLS
-- ---------------------------------------------------------------
alter table public.profiles enable row level security;
create policy "profiles_select_self_or_household" on public.profiles for select using (
  id = auth.uid()
  or id in (select user_id from public.household_members where household_id in (select public.my_household_ids()))
);

alter table public.households enable row level security;
create policy "households_select_member" on public.households for select using (id in (select public.my_household_ids()));
create policy "households_insert_self" on public.households for insert with check (created_by = auth.uid());

alter table public.household_members enable row level security;
create policy "household_members_select_member" on public.household_members for select using (household_id in (select public.my_household_ids()));
create policy "household_members_insert_via_invite" on public.household_members for insert with check (
  user_id = auth.uid()
  and household_id in (
    select household_id from public.household_invites
    where lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  )
);
create policy "household_members_delete_self_or_owner" on public.household_members for delete using (
  user_id = auth.uid()
  or household_id in (select id from public.households where created_by = auth.uid())
);

alter table public.household_invites enable row level security;
create policy "household_invites_select_member_or_invitee" on public.household_invites for select using (
  household_id in (select public.my_household_ids())
  or lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);
create policy "household_invites_insert_member" on public.household_invites for insert with check (
  household_id in (select public.my_household_ids()) and invited_by = auth.uid()
);
create policy "household_invites_update_member_or_invitee" on public.household_invites for update using (
  household_id in (select public.my_household_ids())
  or lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
) with check (
  household_id in (select public.my_household_ids())
  or lower(invited_email) = lower(coalesce(auth.jwt() ->> 'email', ''))
);
create policy "household_invites_delete_member" on public.household_invites for delete using (
  household_id in (select public.my_household_ids())
);

-- ---------------------------------------------------------------
-- 9. handle_new_user() 재작성 — 신규 가입 시 profile + 개인 household 생성
-- ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_household_id uuid;
begin
  insert into public.profiles (id, email, full_name, avatar_url) values (
    new.id, new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  );

  insert into public.households (name, created_by)
  values (coalesce(new.raw_user_meta_data ->> 'full_name', new.email) || '의 가계부', new.id)
  returning id into new_household_id;

  insert into public.household_members (household_id, user_id, role)
  values (new_household_id, new.id, 'owner');

  insert into public.categories (household_id, user_id, name, type, deletable, system) values
    (new_household_id, new.id, '식비', 'expense', true, false),
    (new_household_id, new.id, '교통', 'expense', true, false),
    (new_household_id, new.id, '쇼핑', 'expense', true, false),
    (new_household_id, new.id, '문화/여가', 'expense', true, false),
    (new_household_id, new.id, '주거/공과금', 'expense', true, false),
    (new_household_id, new.id, '의료/건강', 'expense', true, false),
    (new_household_id, new.id, '기타', 'expense', true, false),
    (new_household_id, new.id, '계획 외 지출', 'expense', false, true),
    (new_household_id, new.id, '월급', 'income', true, false),
    (new_household_id, new.id, '금융수익', 'income', true, false),
    (new_household_id, new.id, '기타 부대수익', 'income', true, false);
  return new;
end;
$$;
-- on_auth_user_created 트리거는 기존과 동일한 함수를 재사용하므로 재생성 불필요
