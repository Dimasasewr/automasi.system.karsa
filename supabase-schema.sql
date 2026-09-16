-- KARSA Finance System — Supabase schema
-- Login memakai Supabase Auth. Tidak ada register dari website.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'finance' check (role in ('owner','director','finance','it')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_no text unique not null,
  transaction_date date not null default current_date,
  description text not null,
  category text not null,
  cash_in numeric(15,2) not null default 0,
  cash_out numeric(15,2) not null default 0,
  payment_method text not null default 'cash' check (payment_method in ('cash','bank')),
  reference_no text, pic text,
  status text not null default 'posted' check (status in ('draft','posted','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cash_in >= 0 and cash_out >= 0 and not (cash_in > 0 and cash_out > 0))
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_no text unique not null,
  sale_date date not null default current_date,
  customer_name text, total numeric(15,2) not null default 0,
  paid numeric(15,2) not null default 0,
  payment_method text not null default 'cash' check (payment_method in ('cash','bank')),
  status text not null default 'paid' check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_no text unique not null,
  purchase_date date not null default current_date,
  supplier_name text, total numeric(15,2) not null default 0,
  paid numeric(15,2) not null default 0,
  payment_method text not null default 'cash' check (payment_method in ('cash','bank')),
  status text not null default 'paid' check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id), created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null, name text not null, size text, fabric_type text,
  fabric_cost numeric(15,2) not null default 0, satin_cost numeric(15,2) not null default 0,
  sticker_cost numeric(15,2) not null default 0, paper_bag_cost numeric(15,2) not null default 0,
  thanks_card_cost numeric(15,2) not null default 0, ziplock_cost numeric(15,2) not null default 0,
  zipper_cost numeric(15,2) not null default 0, handtag_cost numeric(15,2) not null default 0,
  rami_cost numeric(15,2) not null default 0, selling_price numeric(15,2) not null default 0,
  stock_qty integer not null default 0, created_at timestamptz not null default now()
);

create table if not exists public.journal_entries (
  id uuid primary key default gen_random_uuid(),
  journal_no text unique not null, journal_date date not null default current_date,
  source_type text not null, source_id uuid, description text not null,
  account_debit text not null, account_credit text not null,
  amount numeric(15,2) not null default 0, created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null, reference_no text,
  amount numeric(15,2) not null default 0, paid numeric(15,2) not null default 0,
  due_date date, status text not null default 'unpaid' check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now()
);

create table if not exists public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null, reference_no text,
  amount numeric(15,2) not null default 0, paid numeric(15,2) not null default 0,
  due_date date, status text not null default 'unpaid' check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now()
);

-- RLS dasar: user login boleh membaca data; insert transaksi/jurnal hanya atas nama dirinya.
do $$ declare t text;
begin
  foreach t in array array['profiles','transactions','sales','purchases','products','journal_entries','accounts_receivable','accounts_payable']
  loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists "authenticated read" on public.%I',t);
    execute format('create policy "authenticated read" on public.%I for select to authenticated using (true)',t);
  end loop;
end $$;

drop policy if exists "own transaction insert" on public.transactions;
create policy "own transaction insert" on public.transactions for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists "own sales insert" on public.sales;
create policy "own sales insert" on public.sales for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists "own purchases insert" on public.purchases;
create policy "own purchases insert" on public.purchases for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists "own journal insert" on public.journal_entries;
create policy "own journal insert" on public.journal_entries for insert to authenticated
with check (created_by = auth.uid());

drop policy if exists "products insert" on public.products;
create policy "products insert" on public.products for insert to authenticated
with check (true);

-- Profil otomatis ketika akun Auth dibuat.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path=public
as $$
begin
  insert into public.profiles(id,full_name)
  values(new.id,coalesce(new.raw_user_meta_data->>'full_name',new.email))
  on conflict(id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
for each row execute procedure public.handle_new_user();
