-- 오늘의 가계부 — Supabase 스키마
-- Supabase 대시보드 > SQL Editor 에서 이 파일 전체를 실행하세요.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------
-- categories
-- ---------------------------------------------------------------
create table public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name       text not null,
  type       text not null check (type in ('expense', 'income')),
  deletable  boolean not null default true,
  system     boolean not null default false,
  created_at timestamptz not null default now()
);
create index categories_user_id_idx on public.categories(user_id);

alter table public.categories enable row level security;
create policy "categories_select_own" on public.categories for select using (auth.uid() = user_id);
create policy "categories_insert_own" on public.categories for insert with check (auth.uid() = user_id);
create policy "categories_update_own" on public.categories for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "categories_delete_own" on public.categories for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- repeat_templates (categories 이후에 생성: FK)
-- ---------------------------------------------------------------
create table public.repeat_templates (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id     uuid references public.categories(id) on delete set null,
  memo            text not null default '',
  expected_amount numeric not null,
  repeat_type     text not null check (repeat_type in ('daily', 'weekly', 'monthly')),
  start_date      date not null,
  active          boolean not null default true,
  weekdays        integer[],
  day_of_month    integer check (day_of_month between 1 and 31),
  created_at      timestamptz not null default now()
);
create index repeat_templates_user_id_idx on public.repeat_templates(user_id);
create index repeat_templates_active_idx on public.repeat_templates(user_id, active);

alter table public.repeat_templates enable row level security;
create policy "repeat_templates_select_own" on public.repeat_templates for select using (auth.uid() = user_id);
create policy "repeat_templates_insert_own" on public.repeat_templates for insert with check (auth.uid() = user_id);
create policy "repeat_templates_update_own" on public.repeat_templates for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "repeat_templates_delete_own" on public.repeat_templates for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- expense_items (categories + repeat_templates 이후에 생성: FK)
-- ---------------------------------------------------------------
create table public.expense_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade default auth.uid(),
  date            date not null,
  category_id     uuid references public.categories(id) on delete set null,
  memo            text not null default '',
  expected_amount numeric,
  actual_amount   numeric,
  payment_method  text check (payment_method in ('card', 'cash', 'transfer', 'etc')),
  planned         boolean not null default true,
  reason_text     text not null default '',
  template_id     uuid references public.repeat_templates(id) on delete set null,
  created_at      timestamptz not null default now()
);
create index expense_items_user_id_idx on public.expense_items(user_id);
create index expense_items_user_date_idx on public.expense_items(user_id, date);
-- 같은 반복 템플릿이 같은 날짜에 두 번 생성되는 것을 방지 (동시 접속 등 경합 방지)
create unique index expense_items_template_date_uniq
  on public.expense_items(template_id, date)
  where template_id is not null;

alter table public.expense_items enable row level security;
create policy "expense_items_select_own" on public.expense_items for select using (auth.uid() = user_id);
create policy "expense_items_insert_own" on public.expense_items for insert with check (auth.uid() = user_id);
create policy "expense_items_update_own" on public.expense_items for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "expense_items_delete_own" on public.expense_items for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- assets
-- ---------------------------------------------------------------
create table public.assets (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name       text not null,
  amount     numeric not null,
  updated_at date not null default current_date,
  created_at timestamptz not null default now()
);
create index assets_user_id_idx on public.assets(user_id);

alter table public.assets enable row level security;
create policy "assets_select_own" on public.assets for select using (auth.uid() = user_id);
create policy "assets_insert_own" on public.assets for insert with check (auth.uid() = user_id);
create policy "assets_update_own" on public.assets for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "assets_delete_own" on public.assets for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------
-- 신규 가입 시 기본 카테고리 11개 자동 시드
-- (서버 사이드 트리거 — 클라이언트 코드 실행 여부와 무관하게 항상 보장됨)
-- ---------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.categories (user_id, name, type, deletable, system) values
    (new.id, '식비', 'expense', true, false),
    (new.id, '교통', 'expense', true, false),
    (new.id, '쇼핑', 'expense', true, false),
    (new.id, '문화/여가', 'expense', true, false),
    (new.id, '주거/공과금', 'expense', true, false),
    (new.id, '의료/건강', 'expense', true, false),
    (new.id, '기타', 'expense', true, false),
    (new.id, '계획 외 지출', 'expense', false, true),
    (new.id, '월급', 'income', true, false),
    (new.id, '금융수익', 'income', true, false),
    (new.id, '기타 부대수익', 'income', true, false);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
