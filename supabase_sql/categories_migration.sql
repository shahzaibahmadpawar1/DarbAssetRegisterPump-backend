
-- Supabase SQL migration for Categories feature

-- Enable extensions if not already
create extension if not exists "pgcrypto";
create extension if not exists "uuid-ossp";

-- 1) Categories table
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamp with time zone default now()
);

-- 2) Add category_id to assets (nullable)
do $$
begin
  if not exists (
    select 1 from information_schema.columns 
    where table_name='assets' and column_name='category_id'
  ) then
    alter table public.assets
      add column category_id uuid references public.categories(id) on delete set null;
  end if;
end$$;

-- Optional helpful indexes
create index if not exists idx_assets_category_id on public.assets(category_id);
create index if not exists idx_categories_name on public.categories(name);
