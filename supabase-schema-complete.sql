-- ============================================================
-- KARSA FINANCE SYSTEM — COMPLETE SUPABASE DATABASE
-- Double-entry accounting + operational finance + stock + HPP
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- MASTER ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'finance'
    check (role in ('owner','director','finance','it')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  account_type text not null check (account_type in
    ('asset','liability','equity','revenue','expense','cogs')),
  normal_balance text not null check (normal_balance in ('debit','credit')),
  parent_id uuid references public.accounts(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text not null check (account_type in ('cash','bank')),
  account_id uuid references public.accounts(id),
  opening_balance numeric(18,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- ---------- TRANSACTIONS ----------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_no text unique not null,
  transaction_date date not null default current_date,
  source_type text not null,
  description text not null,
  category text not null,
  cash_account_id uuid references public.cash_accounts(id),
  cash_in numeric(18,2) not null default 0,
  cash_out numeric(18,2) not null default 0,
  reference_no text,
  pic text,
  status text not null default 'posted' check (status in ('draft','posted','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (cash_in >= 0 and cash_out >= 0 and not (cash_in > 0 and cash_out > 0))
);

-- ---------- SALES / PURCHASES ----------
create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_no text unique not null,
  sale_date date not null default current_date,
  customer_name text,
  total numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  cash_account_id uuid references public.cash_accounts(id),
  status text not null default 'paid' check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (total >= 0 and paid >= 0 and paid <= total)
);

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_no text unique not null,
  purchase_date date not null default current_date,
  supplier_name text,
  total numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  cash_account_id uuid references public.cash_accounts(id),
  status text not null default 'paid' check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  check (total >= 0 and paid >= 0 and paid <= total)
);

-- ---------- AR/AP ----------
create table if not exists public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  reference_no text,
  invoice_date date not null default current_date,
  amount numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  status text not null default 'unpaid' check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now(),
  check (amount >= 0 and paid >= 0 and paid <= amount)
);

create table if not exists public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  reference_no text,
  invoice_date date not null default current_date,
  amount numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  status text not null default 'unpaid' check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now(),
  check (amount >= 0 and paid >= 0 and paid <= amount)
);

create table if not exists public.ar_payments (
  id uuid primary key default gen_random_uuid(),
  ar_id uuid not null references public.accounts_receivable(id) on delete cascade,
  payment_date date not null default current_date,
  amount numeric(18,2) not null,
  cash_account_id uuid references public.cash_accounts(id),
  reference_no text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.ap_payments (
  id uuid primary key default gen_random_uuid(),
  ap_id uuid not null references public.accounts_payable(id) on delete cascade,
  payment_date date not null default current_date,
  amount numeric(18,2) not null,
  cash_account_id uuid references public.cash_accounts(id),
  reference_no text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- PRODUCTS / STOCK ----------
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  name text not null,
  size text,
  fabric_type text,
  selling_price numeric(18,2) not null default 0,
  stock_qty numeric(18,3) not null default 0,
  reorder_level numeric(18,3) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_no text unique not null,
  movement_date date not null default current_date,
  product_id uuid not null references public.products(id),
  movement_type text not null check (movement_type in ('in','out','adjustment')),
  qty numeric(18,3) not null,
  unit_cost numeric(18,2) not null default 0,
  source_type text,
  source_id uuid,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ---------- HPP ----------
create table if not exists public.product_cost_components (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  component_group text not null check (component_group in ('bahan','produksi','packaging','aksesoris')),
  component_name text not null,
  unit text default 'pcs',
  qty numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);

create or replace view public.v_product_hpp as
select
  p.id, p.sku, p.name, p.selling_price,
  coalesce(sum(c.qty*c.unit_cost),0)::numeric(18,2) as hpp_per_unit,
  (p.selling_price-coalesce(sum(c.qty*c.unit_cost),0))::numeric(18,2) as estimated_profit,
  case when p.selling_price > 0
    then round(((p.selling_price-coalesce(sum(c.qty*c.unit_cost),0))/p.selling_price*100)::numeric,2)
    else 0 end as margin_percent
from public.products p
left join public.product_cost_components c on c.product_id=p.id
group by p.id;

-- ---------- JOURNAL ----------
create table if not exists public.journal_headers (
  id uuid primary key default gen_random_uuid(),
  journal_no text unique not null,
  journal_date date not null default current_date,
  journal_type text not null check (journal_type in
    ('general','sales','purchase','receipt','payment')),
  source_type text,
  source_id uuid,
  description text not null,
  status text not null default 'posted' check (status in ('draft','posted','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null references public.journal_headers(id) on delete cascade,
  line_no integer not null,
  account_id uuid not null references public.accounts(id),
  description text,
  debit numeric(18,2) not null default 0,
  credit numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  check (debit >= 0 and credit >= 0 and not (debit > 0 and credit > 0)),
  unique(journal_id,line_no)
);

create or replace view public.v_journal_balance as
select
  h.id,h.journal_no,h.journal_date,h.journal_type,h.source_type,h.source_id,
  h.description,h.status,
  coalesce(sum(l.debit),0)::numeric(18,2) total_debit,
  coalesce(sum(l.credit),0)::numeric(18,2) total_credit,
  (coalesce(sum(l.debit),0)-coalesce(sum(l.credit),0))::numeric(18,2) difference
from public.journal_headers h
left join public.journal_lines l on l.journal_id=h.id
group by h.id;

-- ---------- AUDIT ----------
create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id),
  action text not null,
  table_name text,
  record_id uuid,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

-- ---------- SEED CHART OF ACCOUNTS ----------
insert into public.accounts(code,name,account_type,normal_balance) values
('1100','Kas','asset','debit'),
('1200','Bank','asset','debit'),
('1300','Piutang Usaha','asset','debit'),
('1400','Persediaan','asset','debit'),
('2100','Hutang Usaha','liability','credit'),
('3100','Modal Pemilik','equity','credit'),
('3200','Prive / Penarikan Pemilik','equity','debit'),
('4100','Penjualan','revenue','credit'),
('4200','Pendapatan Lain','revenue','credit'),
('5100','HPP','cogs','debit'),
('6100','Beban Operasional','expense','debit'),
('6200','Beban Administrasi','expense','debit'),
('6300','Beban Lain','expense','debit')
on conflict(code) do nothing;

-- ---------- VIEWS FOR REPORTING ----------
create or replace view public.v_cash_flow as
select
  t.transaction_date,
  coalesce(c.name,'-') cash_account,
  t.transaction_no,t.description,t.source_type,
  t.cash_in,t.cash_out,
  (t.cash_in-t.cash_out) net_cash
from public.transactions t
left join public.cash_accounts c on c.id=t.cash_account_id
where t.status='posted';

create or replace view public.v_profit_loss as
select
  coalesce(sum(case when a.account_type='revenue' then l.credit-l.debit else 0 end),0) revenue,
  coalesce(sum(case when a.account_type='cogs' then l.debit-l.credit else 0 end),0) cogs,
  coalesce(sum(case when a.account_type='expense' then l.debit-l.credit else 0 end),0) expenses
from public.journal_headers h
join public.journal_lines l on l.journal_id=h.id
join public.accounts a on a.id=l.account_id
where h.status='posted';

-- ---------- RLS ----------
do $$ declare t text;
begin
  foreach t in array array[
    'profiles','accounts','cash_accounts','transactions','sales','purchases',
    'accounts_receivable','accounts_payable','ar_payments','ap_payments',
    'products','stock_movements','product_cost_components',
    'journal_headers','journal_lines','audit_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists "auth select" on public.%I',t);
    execute format('create policy "auth select" on public.%I for select to authenticated using (true)',t);
  end loop;
end $$;

-- Basic authenticated inserts; production role policies can be tightened later.
do $$ declare t text;
begin
  foreach t in array array[
    'transactions','sales','purchases','accounts_receivable','accounts_payable',
    'ar_payments','ap_payments','products','stock_movements',
    'product_cost_components','journal_headers','journal_lines'
  ]
  loop
    execute format('drop policy if exists "auth insert" on public.%I',t);
    execute format('create policy "auth insert" on public.%I for insert to authenticated with check (true)',t);
  end loop;
end $$;

-- Profile trigger for Auth users.
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

-- ---------- ACCOUNTING RULES / FORMULAS ----------
-- Sales paid:       Dr Kas/Bank, Cr Penjualan
-- Sales credit:     Dr Piutang, Cr Penjualan
-- Purchase paid:    Dr Persediaan/HPP, Cr Kas/Bank
-- Purchase credit:  Dr Persediaan/HPP, Cr Hutang
-- Other receipt:    Dr Kas/Bank, Cr Pendapatan Lain
-- Expense payment:  Dr Beban, Cr Kas/Bank
-- Capital in:       Dr Kas/Bank, Cr Modal
-- Owner withdrawal: Dr Prive, Cr Kas/Bank
-- AR collection:    Dr Kas/Bank, Cr Piutang
-- AP payment:       Dr Hutang, Cr Kas/Bank
-- Sale inventory cost: Dr HPP, Cr Persediaan
-- Ending stock: Beginning + Stock In - Stock Out +/- Adjustments
-- HPP/unit: SUM(qty_component * unit_cost)
-- Gross profit: Sales - HPP
-- Net profit: Gross profit - operating expenses

-- ---------- V2 HARDENING / RPC POSTING ----------
-- Safe defaults for the first existing Auth user and a default cash account.
insert into public.cash_accounts(name,account_type,account_id,opening_balance)
select 'Kas Utama','cash',a.id,0 from public.accounts a
where a.code='1100' and not exists (select 1 from public.cash_accounts where name='Kas Utama');
insert into public.cash_accounts(name,account_type,account_id,opening_balance)
select 'Bank Utama','bank',a.id,0 from public.accounts a
where a.code='1200' and not exists (select 1 from public.cash_accounts where name='Bank Utama');

-- Existing Auth users may have been created before the profile trigger was installed.
insert into public.profiles(id,full_name)
select u.id, coalesce(u.raw_user_meta_data->>'full_name',u.email)
from auth.users u
where not exists (select 1 from public.profiles p where p.id=u.id);

-- The app is login-only. These policies do not create public registration.
drop policy if exists "auth insert profile" on public.profiles;
create policy "auth insert profile" on public.profiles for insert to authenticated with check (id=auth.uid());
drop policy if exists "auth update profile" on public.profiles;
create policy "auth update profile" on public.profiles for update to authenticated using (id=auth.uid()) with check (id=auth.uid());

-- ---------- ATOMIC CASH TRANSACTION ----------
create or replace function public.post_cash_transaction(
  p_date date, p_direction text, p_category text, p_amount numeric,
  p_cash_account_id uuid, p_description text, p_reference text default null, p_pic text default null
) returns public.transactions
language plpgsql security definer set search_path=public
as $$
declare
  r public.transactions;
  j public.journal_headers;
  cash_code text;
  contra_code text;
  journal_type text;
  n int;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Nominal harus lebih dari 0'; end if;
  if p_direction not in ('in','out') then raise exception 'Jenis transaksi tidak valid'; end if;
  if p_cash_account_id is null then raise exception 'Kas/Bank wajib dipilih'; end if;
  if not exists(select 1 from cash_accounts where id=p_cash_account_id and active) then raise exception 'Kas/Bank tidak ditemukan'; end if;
  select case when account_type='bank' then '1200' else '1100' end into cash_code from cash_accounts where id=p_cash_account_id;
  if p_direction='in' then
    contra_code := case p_category when 'Penjualan' then '4100' when 'Modal' then '3100' when 'Pelunasan Piutang' then '1300' else '4200' end;
    journal_type := 'receipt';
  else
    contra_code := case p_category when 'Pembelian' then '1400' when 'Prive' then '3200' when 'Bayar Hutang' then '2100' else '6100' end;
    journal_type := 'payment';
  end if;
  if not exists(select 1 from accounts where code=contra_code and active) then raise exception 'Akun % belum tersedia', contra_code; end if;
  select coalesce(max((regexp_match(transaction_no,'([0-9]+)$'))[1]::int),0)+1 into n from transactions;
  insert into transactions(transaction_no,transaction_date,source_type,description,category,cash_account_id,cash_in,cash_out,reference_no,pic,status,created_by)
  values('TRX-'||lpad(n::text,5,'0'),coalesce(p_date,current_date),'manual',p_description,p_category,p_cash_account_id,case when p_direction='in' then p_amount else 0 end,case when p_direction='out' then p_amount else 0 end,p_reference,p_pic,'posted',auth.uid()) returning * into r;
  select coalesce(max((regexp_match(journal_no,'([0-9]+)$'))[1]::int),0)+1 into n from journal_headers;
  insert into journal_headers(journal_no,journal_date,journal_type,source_type,source_id,description,status,created_by)
  values('JRN-'||lpad(n::text,5,'0'),r.transaction_date,journal_type,'transaction',r.id,r.description,'posted',auth.uid()) returning * into j;
  if p_direction='in' then
    insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,1,(select id from accounts where code=cash_code),r.description,p_amount,0),(j.id,2,(select id from accounts where code=contra_code),r.description,0,p_amount);
  else
    insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,1,(select id from accounts where code=contra_code),r.description,p_amount,0),(j.id,2,(select id from accounts where code=cash_code),r.description,0,p_amount);
  end if;
  insert into audit_logs(user_id,action,table_name,record_id,new_data) values(auth.uid(),'create','transactions',r.id,to_jsonb(r));
  return r;
end $$;

-- ---------- ATOMIC SALE ----------
create or replace function public.post_sale(
  p_date date, p_customer text, p_total numeric, p_paid numeric, p_due date, p_cash_account_id uuid
) returns public.sales
language plpgsql security definer set search_path=public
as $$
declare
  r public.sales; j public.journal_headers; remain numeric; cash_code text; n int;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_total is null or p_total <= 0 or p_paid < 0 or p_paid > p_total then raise exception 'Nilai penjualan tidak valid'; end if;
  if p_paid > 0 and p_cash_account_id is null then raise exception 'Kas/Bank wajib dipilih jika ada pembayaran'; end if;
  remain:=p_total-p_paid;
  if p_cash_account_id is not null then select case when account_type='bank' then '1200' else '1100' end into cash_code from cash_accounts where id=p_cash_account_id and active; end if;
  select coalesce(max((regexp_match(sale_no,'([0-9]+)$'))[1]::int),0)+1 into n from sales;
  insert into sales(sale_no,sale_date,customer_name,total,paid,due_date,cash_account_id,status,created_by)
  values('SALE-'||lpad(n::text,5,'0'),coalesce(p_date,current_date),nullif(p_customer,''),p_total,p_paid,p_due,p_cash_account_id,case when remain=0 then 'paid' when p_paid=0 then 'unpaid' else 'partial' end,auth.uid()) returning * into r;
  select coalesce(max((regexp_match(journal_no,'([0-9]+)$'))[1]::int),0)+1 into n from journal_headers;
  insert into journal_headers(journal_no,journal_date,journal_type,source_type,source_id,description,status,created_by)
  values('JRN-'||lpad(n::text,5,'0'),r.sale_date,'sales','sale',r.id,'Penjualan '||r.sale_no,'posted',auth.uid()) returning * into j;
  if p_paid>0 then insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,1,(select id from accounts where code=cash_code),'Penjualan '||r.sale_no,p_paid,0); end if;
  if remain>0 then insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,case when p_paid>0 then 2 else 1 end,(select id from accounts where code='1300'),'Penjualan '||r.sale_no,remain,0); end if;
  insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,case when remain>0 then case when p_paid>0 then 3 else 2 end else 2 end,(select id from accounts where code='4100'),'Penjualan '||r.sale_no,0,p_total);
  if remain>0 then insert into accounts_receivable(customer_name,reference_no,invoice_date,amount,paid,due_date,status) values(coalesce(p_customer,'Pelanggan'),r.sale_no,r.sale_date,p_total,p_paid,p_due,case when p_paid=0 then 'unpaid' else 'partial' end); end if;
  insert into audit_logs(user_id,action,table_name,record_id,new_data) values(auth.uid(),'create','sales',r.id,to_jsonb(r));
  return r;
end $$;

-- ---------- ATOMIC PURCHASE ----------
create or replace function public.post_purchase(
  p_date date, p_supplier text, p_total numeric, p_paid numeric, p_due date, p_cash_account_id uuid
) returns public.purchases
language plpgsql security definer set search_path=public
as $$
declare
  r public.purchases; j public.journal_headers; remain numeric; cash_code text; n int; ln int:=1;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED'; end if;
  if p_total is null or p_total <= 0 or p_paid < 0 or p_paid > p_total then raise exception 'Nilai pembelian tidak valid'; end if;
  if p_paid > 0 and p_cash_account_id is null then raise exception 'Kas/Bank wajib dipilih jika ada pembayaran'; end if;
  remain:=p_total-p_paid;
  if p_cash_account_id is not null then select case when account_type='bank' then '1200' else '1100' end into cash_code from cash_accounts where id=p_cash_account_id and active; end if;
  select coalesce(max((regexp_match(purchase_no,'([0-9]+)$'))[1]::int),0)+1 into n from purchases;
  insert into purchases(purchase_no,purchase_date,supplier_name,total,paid,due_date,cash_account_id,status,created_by)
  values('PUR-'||lpad(n::text,5,'0'),coalesce(p_date,current_date),nullif(p_supplier,''),p_total,p_paid,p_due,p_cash_account_id,case when remain=0 then 'paid' when p_paid=0 then 'unpaid' else 'partial' end,auth.uid()) returning * into r;
  select coalesce(max((regexp_match(journal_no,'([0-9]+)$'))[1]::int),0)+1 into n from journal_headers;
  insert into journal_headers(journal_no,journal_date,journal_type,source_type,source_id,description,status,created_by)
  values('JRN-'||lpad(n::text,5,'0'),r.purchase_date,'purchase','purchase',r.id,'Pembelian '||r.purchase_no,'posted',auth.uid()) returning * into j;
  insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,ln,(select id from accounts where code='1400'),'Pembelian '||r.purchase_no,p_total,0); ln:=ln+1;
  if p_paid>0 then insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,ln,(select id from accounts where code=cash_code),'Pembelian '||r.purchase_no,0,p_paid); ln:=ln+1; end if;
  if remain>0 then insert into journal_lines(journal_id,line_no,account_id,description,debit,credit) values(j.id,ln,(select id from accounts where code='2100'),'Pembelian '||r.purchase_no,0,remain); end if;
  if remain>0 then insert into accounts_payable(supplier_name,reference_no,invoice_date,amount,paid,due_date,status) values(coalesce(p_supplier,'Supplier'),r.purchase_no,r.purchase_date,p_total,p_paid,p_due,case when p_paid=0 then 'unpaid' else 'partial' end); end if;
  insert into audit_logs(user_id,action,table_name,record_id,new_data) values(auth.uid(),'create','purchases',r.id,to_jsonb(r));
  return r;
end $$;

revoke all on function public.post_cash_transaction(date,text,text,numeric,uuid,text,text,text) from public;
grant execute on function public.post_cash_transaction(date,text,text,numeric,uuid,text,text,text) to authenticated;
revoke all on function public.post_sale(date,text,numeric,numeric,date,uuid) from public;
grant execute on function public.post_sale(date,text,numeric,numeric,date,uuid) to authenticated;
revoke all on function public.post_purchase(date,text,numeric,numeric,date,uuid) from public;
grant execute on function public.post_purchase(date,text,numeric,numeric,date,uuid) to authenticated;
