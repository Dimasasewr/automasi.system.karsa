/* =========================================================
   KARSA FINANCE — FINAL DATABASE FIX / MIGRATION
   Tujuan:
   - Menyamakan database dengan app.js terbaru
   - Tidak menghapus data lama
   - Menambahkan tabel/kolom yang kurang
   - Double-entry journal
   - Kas & Bank
   - Penjualan / Pembelian
   - Piutang / Hutang
   - Produk / Stok / HPP
   - Audit log
   - RPC posting transaksi
   ========================================================= */

create extension if not exists pgcrypto;


/* =========================================================
   1. PROFILES
   ========================================================= */

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'finance'
    check (role in ('owner','director','finance','it')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists full_name text;

alter table public.profiles
  add column if not exists role text default 'finance';

alter table public.profiles
  add column if not exists active boolean default true;

alter table public.profiles
  add column if not exists created_at timestamptz default now();


/* =========================================================
   2. ACCOUNTS / COA
   ========================================================= */

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  name text not null,
  account_type text not null
    check (account_type in
      ('asset','liability','equity','revenue','expense','cogs')),
  normal_balance text not null
    check (normal_balance in ('debit','credit')),
  parent_id uuid references public.accounts(id),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

insert into public.accounts
(code,name,account_type,normal_balance)
values
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


/* =========================================================
   3. CASH ACCOUNTS
   ========================================================= */

create table if not exists public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  account_type text not null
    check (account_type in ('cash','bank')),
  account_id uuid references public.accounts(id),
  opening_balance numeric(18,2) not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.cash_accounts
  add column if not exists account_id uuid references public.accounts(id);

alter table public.cash_accounts
  add column if not exists opening_balance numeric(18,2) default 0;

alter table public.cash_accounts
  add column if not exists active boolean default true;

insert into public.cash_accounts
(name,account_type,account_id,opening_balance)
select
  'Kas Utama',
  'cash',
  a.id,
  0
from public.accounts a
where a.code='1100'
and not exists (
  select 1
  from public.cash_accounts
  where name='Kas Utama'
);

insert into public.cash_accounts
(name,account_type,account_id,opening_balance)
select
  'Bank Utama',
  'bank',
  a.id,
  0
from public.accounts a
where a.code='1200'
and not exists (
  select 1
  from public.cash_accounts
  where name='Bank Utama'
);

update public.cash_accounts c
set account_id = a.id
from public.accounts a
where c.account_id is null
and (
  (c.account_type='cash' and a.code='1100')
  or
  (c.account_type='bank' and a.code='1200')
);


/* =========================================================
   4. TRANSACTIONS
   ========================================================= */

create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  transaction_no text unique not null,
  transaction_date date not null default current_date,
  source_type text not null default 'manual',
  description text not null,
  category text not null,
  cash_account_id uuid references public.cash_accounts(id),
  cash_in numeric(18,2) not null default 0,
  cash_out numeric(18,2) not null default 0,
  reference_no text,
  pic text,
  status text not null default 'posted'
    check (status in ('draft','posted','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.transactions
  add column if not exists source_type text default 'manual';

alter table public.transactions
  add column if not exists cash_account_id uuid references public.cash_accounts(id);

alter table public.transactions
  add column if not exists reference_no text;

alter table public.transactions
  add column if not exists pic text;

alter table public.transactions
  add column if not exists created_by uuid references auth.users(id);

alter table public.transactions
  add column if not exists updated_at timestamptz default now();

update public.transactions
set source_type='manual'
where source_type is null;

update public.transactions t
set cash_account_id = c.id
from public.cash_accounts c
where t.cash_account_id is null
and (
  (
    coalesce(t.payment_method,'cash')='cash'
    and c.name='Kas Utama'
  )
  or
  (
    coalesce(t.payment_method,'cash')='bank'
    and c.name='Bank Utama'
  )
);


/* =========================================================
   5. SALES
   ========================================================= */

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  sale_no text unique not null,
  sale_date date not null default current_date,
  customer_name text,
  total numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  cash_account_id uuid references public.cash_accounts(id),
  status text not null default 'paid'
    check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.sales
  add column if not exists sale_date date default current_date;

alter table public.sales
  add column if not exists due_date date;

alter table public.sales
  add column if not exists cash_account_id uuid references public.cash_accounts(id);

alter table public.sales
  add column if not exists created_by uuid references auth.users(id);

alter table public.sales
  add column if not exists created_at timestamptz default now();


/* =========================================================
   6. PURCHASES
   ========================================================= */

create table if not exists public.purchases (
  id uuid primary key default gen_random_uuid(),
  purchase_no text unique not null,
  purchase_date date not null default current_date,
  supplier_name text,
  total numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  cash_account_id uuid references public.cash_accounts(id),
  status text not null default 'paid'
    check (status in ('unpaid','partial','paid','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

alter table public.purchases
  add column if not exists purchase_date date default current_date;

alter table public.purchases
  add column if not exists due_date date;

alter table public.purchases
  add column if not exists cash_account_id uuid references public.cash_accounts(id);

alter table public.purchases
  add column if not exists created_by uuid references auth.users(id);

alter table public.purchases
  add column if not exists created_at timestamptz default now();


/* =========================================================
   7. PIUTANG
   ========================================================= */

create table if not exists public.accounts_receivable (
  id uuid primary key default gen_random_uuid(),
  customer_name text not null,
  reference_no text,
  invoice_date date not null default current_date,
  amount numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  status text not null default 'unpaid'
    check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now()
);

alter table public.accounts_receivable
  add column if not exists invoice_date date default current_date;

alter table public.accounts_receivable
  add column if not exists created_at timestamptz default now();


/* =========================================================
   8. PEMBAYARAN PIUTANG
   ========================================================= */

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


/* =========================================================
   9. HUTANG
   ========================================================= */

create table if not exists public.accounts_payable (
  id uuid primary key default gen_random_uuid(),
  supplier_name text not null,
  reference_no text,
  invoice_date date not null default current_date,
  amount numeric(18,2) not null default 0,
  paid numeric(18,2) not null default 0,
  due_date date,
  status text not null default 'unpaid'
    check (status in ('unpaid','partial','paid')),
  created_at timestamptz not null default now()
);

alter table public.accounts_payable
  add column if not exists invoice_date date default current_date;

alter table public.accounts_payable
  add column if not exists created_at timestamptz default now();


/* =========================================================
   10. PEMBAYARAN HUTANG
   ========================================================= */

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


/* =========================================================
   11. PRODUCTS
   ========================================================= */

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

alter table public.products
  add column if not exists size text;

alter table public.products
  add column if not exists fabric_type text;

alter table public.products
  add column if not exists reorder_level numeric(18,3) default 0;

alter table public.products
  add column if not exists active boolean default true;

alter table public.products
  add column if not exists created_at timestamptz default now();

alter table public.products
  alter column stock_qty type numeric(18,3)
  using stock_qty::numeric;


/* =========================================================
   12. PRODUCT COST / HPP
   ========================================================= */

create table if not exists public.product_cost_components (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products(id) on delete cascade,
  component_group text not null
    check (component_group in
      ('bahan','produksi','packaging','aksesoris')),
  component_name text not null,
  unit text default 'pcs',
  qty numeric(18,4) not null default 1,
  unit_cost numeric(18,2) not null default 0,
  created_at timestamptz not null default now()
);


/* =========================================================
   13. MIGRASI HPP DARI STRUKTUR LAMA
   ========================================================= */

do $$
begin

  if exists (
    select 1
    from information_schema.columns
    where table_schema='public'
    and table_name='products'
    and column_name='fabric_cost'
  ) then

    insert into public.product_cost_components
    (product_id,component_group,component_name,unit,qty,unit_cost)

    select
      p.id,
      'bahan',
      'Kain',
      'pcs',
      1,
      coalesce(p.fabric_cost,0)

    from public.products p

    where coalesce(p.fabric_cost,0) > 0

    and not exists (
      select 1
      from public.product_cost_components c
      where c.product_id=p.id
    );

  end if;

end $$;


/* =========================================================
   14. STOCK MOVEMENTS
   ========================================================= */

create table if not exists public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  movement_no text unique not null,
  movement_date date not null default current_date,
  product_id uuid not null references public.products(id),
  movement_type text not null
    check (movement_type in ('in','out','adjustment')),
  qty numeric(18,3) not null,
  unit_cost numeric(18,2) not null default 0,
  source_type text,
  source_id uuid,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);


/* =========================================================
   15. JOURNAL HEADERS
   ========================================================= */

create table if not exists public.journal_headers (
  id uuid primary key default gen_random_uuid(),
  journal_no text unique not null,
  journal_date date not null default current_date,
  journal_type text not null
    check (journal_type in
      ('general','sales','purchase','receipt','payment')),
  source_type text,
  source_id uuid,
  description text not null,
  status text not null default 'posted'
    check (status in ('draft','posted','void')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);


/* =========================================================
   16. JOURNAL LINES
   ========================================================= */

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  journal_id uuid not null
    references public.journal_headers(id) on delete cascade,
  line_no integer not null,
  account_id uuid not null
    references public.accounts(id),
  description text,
  debit numeric(18,2) not null default 0,
  credit numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  check (
    debit >= 0
    and credit >= 0
    and not (debit > 0 and credit > 0)
  ),
  unique(journal_id,line_no)
);


/* =========================================================
   17. AUDIT LOG
   ========================================================= */

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


/* =========================================================
   18. V_PRODUCT_HPP
   ========================================================= */

create or replace view public.v_product_hpp
with (security_invoker = true)
as
select
  p.id,
  p.sku,
  p.name,
  p.size,
  p.fabric_type,
  p.stock_qty,
  p.selling_price,

  coalesce(
    sum(c.qty * c.unit_cost),
    0
  )::numeric(18,2) as hpp_per_unit,

  (
    p.selling_price
    -
    coalesce(sum(c.qty * c.unit_cost),0)
  )::numeric(18,2) as estimated_profit,

  case
    when p.selling_price > 0 then
      round(
        (
          (
            p.selling_price
            -
            coalesce(sum(c.qty * c.unit_cost),0)
          )
          /
          p.selling_price
          * 100
        )::numeric,
        2
      )
    else 0
  end as margin_percent

from public.products p

left join public.product_cost_components c
  on c.product_id=p.id

group by
  p.id,
  p.sku,
  p.name,
  p.size,
  p.fabric_type,
  p.stock_qty,
  p.selling_price;


/* =========================================================
   19. JOURNAL BALANCE VIEW
   ========================================================= */

create or replace view public.v_journal_balance
with (security_invoker = true)
as
select
  h.id,
  h.journal_no,
  h.journal_date,
  h.journal_type,
  h.source_type,
  h.source_id,
  h.description,
  h.status,

  coalesce(sum(l.debit),0)::numeric(18,2)
    as total_debit,

  coalesce(sum(l.credit),0)::numeric(18,2)
    as total_credit,

  (
    coalesce(sum(l.debit),0)
    -
    coalesce(sum(l.credit),0)
  )::numeric(18,2)
    as difference

from public.journal_headers h

left join public.journal_lines l
  on l.journal_id=h.id

group by h.id;


/* =========================================================
   20. CASH FLOW VIEW
   ========================================================= */

create or replace view public.v_cash_flow
with (security_invoker = true)
as
select
  t.transaction_date,
  coalesce(c.name,'-') as cash_account,
  t.transaction_no,
  t.description,
  t.source_type,
  t.cash_in,
  t.cash_out,
  (t.cash_in-t.cash_out) as net_cash

from public.transactions t

left join public.cash_accounts c
  on c.id=t.cash_account_id

where t.status='posted';


/* =========================================================
   21. PROFIT / LOSS VIEW
   ========================================================= */

create or replace view public.v_profit_loss
with (security_invoker = true)
as
select

  coalesce(
    sum(
      case
        when a.account_type='revenue'
        then l.credit-l.debit
        else 0
      end
    ),0
  ) as revenue,

  coalesce(
    sum(
      case
        when a.account_type='cogs'
        then l.debit-l.credit
        else 0
      end
    ),0
  ) as cogs,

  coalesce(
    sum(
      case
        when a.account_type='expense'
        then l.debit-l.credit
        else 0
      end
    ),0
  ) as expenses

from public.journal_headers h

join public.journal_lines l
  on l.journal_id=h.id

join public.accounts a
  on a.id=l.account_id

where h.status='posted';


/* =========================================================
   22. AUTO PROFILE
   ========================================================= */

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path=public
as $$
begin

  insert into public.profiles
  (id,full_name)

  values
  (
    new.id,
    coalesce(
      new.raw_user_meta_data->>'full_name',
      new.email
    )
  )

  on conflict(id) do nothing;

  return new;

end;
$$;

drop trigger if exists on_auth_user_created
on auth.users;

create trigger on_auth_user_created
after insert on auth.users

for each row
execute procedure public.handle_new_user();


/* =========================================================
   23. SYNC USER PROFILES YANG SUDAH ADA
   ========================================================= */

insert into public.profiles
(id,full_name)

select
  u.id,
  coalesce(
    u.raw_user_meta_data->>'full_name',
    u.email
  )

from auth.users u

where not exists (
  select 1
  from public.profiles p
  where p.id=u.id
);


/* =========================================================
   24. RPC — CASH TRANSACTION
   ========================================================= */

create or replace function public.post_cash_transaction(
  p_date date,
  p_direction text,
  p_category text,
  p_amount numeric,
  p_cash_account_id uuid,
  p_description text,
  p_reference text default null,
  p_pic text default null
)

returns public.transactions

language plpgsql
security definer
set search_path=public

as $$

declare
  r public.transactions;
  j public.journal_headers;

  cash_code text;
  contra_code text;
  journal_type text;

  n int;

begin

  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal harus lebih dari 0';
  end if;

  if p_direction not in ('in','out') then
    raise exception 'Jenis transaksi tidak valid';
  end if;

  if p_cash_account_id is null then
    raise exception 'Kas/Bank wajib dipilih';
  end if;

  if not exists (
    select 1
    from public.cash_accounts
    where id=p_cash_account_id
    and active=true
  ) then
    raise exception 'Kas/Bank tidak ditemukan';
  end if;


  select
    case
      when account_type='bank'
      then '1200'
      else '1100'
    end

  into cash_code

  from public.cash_accounts

  where id=p_cash_account_id;


  if p_direction='in' then

    contra_code :=
      case p_category

        when 'Penjualan'
        then '4100'

        when 'Modal'
        then '3100'

        when 'Pelunasan Piutang'
        then '1300'

        else '4200'

      end;

    journal_type := 'receipt';

  else

    contra_code :=
      case p_category

        when 'Pembelian'
        then '1400'

        when 'Prive'
        then '3200'

        when 'Bayar Hutang'
        then '2100'

        else '6100'

      end;

    journal_type := 'payment';

  end if;


  if not exists (
    select 1
    from public.accounts
    where code=contra_code
    and active=true
  ) then
    raise exception 'Akun % belum tersedia',contra_code;
  end if;


  select
    coalesce(
      max(
        (regexp_match(transaction_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.transactions;


  insert into public.transactions
  (
    transaction_no,
    transaction_date,
    source_type,
    description,
    category,
    cash_account_id,
    cash_in,
    cash_out,
    reference_no,
    pic,
    status,
    created_by
  )

  values
  (
    'TRX-'||lpad(n::text,5,'0'),
    coalesce(p_date,current_date),
    'manual',
    p_description,
    p_category,
    p_cash_account_id,

    case
      when p_direction='in'
      then p_amount
      else 0
    end,

    case
      when p_direction='out'
      then p_amount
      else 0
    end,

    p_reference,
    p_pic,
    'posted',
    auth.uid()
  )

  returning *
  into r;


  select
    coalesce(
      max(
        (regexp_match(journal_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.journal_headers;


  insert into public.journal_headers
  (
    journal_no,
    journal_date,
    journal_type,
    source_type,
    source_id,
    description,
    status,
    created_by
  )

  values
  (
    'JRN-'||lpad(n::text,5,'0'),
    r.transaction_date,
    journal_type,
    'transaction',
    r.id,
    r.description,
    'posted',
    auth.uid()
  )

  returning *
  into j;


  if p_direction='in' then

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      1,
      (select id from public.accounts where code=cash_code),
      r.description,
      p_amount,
      0
    ),
    (
      j.id,
      2,
      (select id from public.accounts where code=contra_code),
      r.description,
      0,
      p_amount
    );

  else

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      1,
      (select id from public.accounts where code=contra_code),
      r.description,
      p_amount,
      0
    ),
    (
      j.id,
      2,
      (select id from public.accounts where code=cash_code),
      r.description,
      0,
      p_amount
    );

  end if;


  insert into public.audit_logs
  (
    user_id,
    action,
    table_name,
    record_id,
    new_data
  )

  values
  (
    auth.uid(),
    'create',
    'transactions',
    r.id,
    to_jsonb(r)
  );


  return r;

end;
$$;


/* =========================================================
   25. RPC — SALES
   ========================================================= */

create or replace function public.post_sale(
  p_date date,
  p_customer text,
  p_total numeric,
  p_paid numeric,
  p_due date,
  p_cash_account_id uuid
)

returns public.sales

language plpgsql
security definer
set search_path=public

as $$

declare
  r public.sales;
  j public.journal_headers;

  remain numeric;
  cash_code text;

  n int;

begin

  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;

  if p_total is null
     or p_total <= 0
     or p_paid < 0
     or p_paid > p_total then

    raise exception 'Nilai penjualan tidak valid';

  end if;


  if p_paid > 0
     and p_cash_account_id is null then

    raise exception
      'Kas/Bank wajib dipilih jika ada pembayaran';

  end if;


  remain := p_total-p_paid;


  if p_cash_account_id is not null then

    select
      case
        when account_type='bank'
        then '1200'
        else '1100'
      end

    into cash_code

    from public.cash_accounts

    where id=p_cash_account_id
    and active=true;

  end if;


  select
    coalesce(
      max(
        (regexp_match(sale_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.sales;


  insert into public.sales
  (
    sale_no,
    sale_date,
    customer_name,
    total,
    paid,
    due_date,
    cash_account_id,
    status,
    created_by
  )

  values
  (
    'SALE-'||lpad(n::text,5,'0'),
    coalesce(p_date,current_date),
    nullif(p_customer,''),
    p_total,
    p_paid,
    p_due,
    p_cash_account_id,

    case
      when remain=0
      then 'paid'
      when p_paid=0
      then 'unpaid'
      else 'partial'
    end,

    auth.uid()
  )

  returning *
  into r;


  select
    coalesce(
      max(
        (regexp_match(journal_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.journal_headers;


  insert into public.journal_headers
  (
    journal_no,
    journal_date,
    journal_type,
    source_type,
    source_id,
    description,
    status,
    created_by
  )

  values
  (
    'JRN-'||lpad(n::text,5,'0'),
    r.sale_date,
    'sales',
    'sale',
    r.id,
    'Penjualan '||r.sale_no,
    'posted',
    auth.uid()
  )

  returning *
  into j;


  if p_paid > 0 then

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      1,
      (select id from public.accounts where code=cash_code),
      'Penjualan '||r.sale_no,
      p_paid,
      0
    );

  end if;


  if remain > 0 then

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      case
        when p_paid>0 then 2
        else 1
      end,
      (select id from public.accounts where code='1300'),
      'Penjualan '||r.sale_no,
      remain,
      0
    );

  end if;


  insert into public.journal_lines
  (
    journal_id,
    line_no,
    account_id,
    description,
    debit,
    credit
  )

  values
  (
    j.id,

    case
      when remain>0 then
        case
          when p_paid>0 then 3
          else 2
        end
      else 2
    end,

    (select id from public.accounts where code='4100'),

    'Penjualan '||r.sale_no,

    0,
    p_total
  );


  if remain>0 then

    insert into public.accounts_receivable
    (
      customer_name,
      reference_no,
      invoice_date,
      amount,
      paid,
      due_date,
      status
    )

    values
    (
      coalesce(p_customer,'Pelanggan'),
      r.sale_no,
      r.sale_date,
      p_total,
      p_paid,
      p_due,

      case
        when p_paid=0
        then 'unpaid'
        else 'partial'
      end
    );

  end if;


  insert into public.audit_logs
  (
    user_id,
    action,
    table_name,
    record_id,
    new_data
  )

  values
  (
    auth.uid(),
    'create',
    'sales',
    r.id,
    to_jsonb(r)
  );


  return r;

end;
$$;


/* =========================================================
   26. RPC — PURCHASE
   ========================================================= */

create or replace function public.post_purchase(
  p_date date,
  p_supplier text,
  p_total numeric,
  p_paid numeric,
  p_due date,
  p_cash_account_id uuid
)

returns public.purchases

language plpgsql
security definer
set search_path=public

as $$

declare
  r public.purchases;
  j public.journal_headers;

  remain numeric;
  cash_code text;

  n int;
  ln int := 1;

begin

  if auth.uid() is null then
    raise exception 'AUTH_REQUIRED';
  end if;


  if p_total is null
     or p_total <= 0
     or p_paid < 0
     or p_paid > p_total then

    raise exception 'Nilai pembelian tidak valid';

  end if;


  if p_paid > 0
     and p_cash_account_id is null then

    raise exception
      'Kas/Bank wajib dipilih jika ada pembayaran';

  end if;


  remain := p_total-p_paid;


  if p_cash_account_id is not null then

    select
      case
        when account_type='bank'
        then '1200'
        else '1100'
      end

    into cash_code

    from public.cash_accounts

    where id=p_cash_account_id
    and active=true;

  end if;


  select
    coalesce(
      max(
        (regexp_match(purchase_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.purchases;


  insert into public.purchases
  (
    purchase_no,
    purchase_date,
    supplier_name,
    total,
    paid,
    due_date,
    cash_account_id,
    status,
    created_by
  )

  values
  (
    'PUR-'||lpad(n::text,5,'0'),
    coalesce(p_date,current_date),
    nullif(p_supplier,''),
    p_total,
    p_paid,
    p_due,
    p_cash_account_id,

    case
      when remain=0
      then 'paid'
      when p_paid=0
      then 'unpaid'
      else 'partial'
    end,

    auth.uid()
  )

  returning *
  into r;


  select
    coalesce(
      max(
        (regexp_match(journal_no,'([0-9]+)$'))[1]::int
      ),
      0
    ) + 1

  into n

  from public.journal_headers;


  insert into public.journal_headers
  (
    journal_no,
    journal_date,
    journal_type,
    source_type,
    source_id,
    description,
    status,
    created_by
  )

  values
  (
    'JRN-'||lpad(n::text,5,'0'),
    r.purchase_date,
    'purchase',
    'purchase',
    r.id,
    'Pembelian '||r.purchase_no,
    'posted',
    auth.uid()
  )

  returning *
  into j;


  insert into public.journal_lines
  (
    journal_id,
    line_no,
    account_id,
    description,
    debit,
    credit
  )

  values
  (
    j.id,
    ln,
    (select id from public.accounts where code='1400'),
    'Pembelian '||r.purchase_no,
    p_total,
    0
  );

  ln := ln+1;


  if p_paid>0 then

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      ln,
      (select id from public.accounts where code=cash_code),
      'Pembelian '||r.purchase_no,
      0,
      p_paid
    );

    ln := ln+1;

  end if;


  if remain>0 then

    insert into public.journal_lines
    (
      journal_id,
      line_no,
      account_id,
      description,
      debit,
      credit
    )

    values
    (
      j.id,
      ln,
      (select id from public.accounts where code='2100'),
      'Pembelian '||r.purchase_no,
      0,
      remain
    );

  end if;


  if remain>0 then

    insert into public.accounts_payable
    (
      supplier_name,
      reference_no,
      invoice_date,
      amount,
      paid,
      due_date,
      status
    )

    values
    (
      coalesce(p_supplier,'Supplier'),
      r.purchase_no,
      r.purchase_date,
      p_total,
      p_paid,
      p_due,

      case
        when p_paid=0
        then 'unpaid'
        else 'partial'
      end
    );

  end if;


  insert into public.audit_logs
  (
    user_id,
    action,
    table_name,
    record_id,
    new_data
  )

  values
  (
    auth.uid(),
    'create',
    'purchases',
    r.id,
    to_jsonb(r)
  );


  return r;

end;
$$;


/* =========================================================
   27. RLS
   ========================================================= */

do $$
declare
  t text;
begin

  foreach t in array array[
    'profiles',
    'accounts',
    'cash_accounts',
    'transactions',
    'sales',
    'purchases',
    'accounts_receivable',
    'accounts_payable',
    'ar_payments',
    'ap_payments',
    'products',
    'stock_movements',
    'product_cost_components',
    'journal_headers',
    'journal_lines',
    'audit_logs'
  ]

  loop

    execute format(
      'alter table public.%I enable row level security',
      t
    );

  end loop;

end $$;


/* =========================================================
   28. READ POLICY
   ========================================================= */

do $$
declare
  t text;
begin

  foreach t in array array[
    'profiles',
    'accounts',
    'cash_accounts',
    'transactions',
    'sales',
    'purchases',
    'accounts_receivable',
    'accounts_payable',
    'ar_payments',
    'ap_payments',
    'products',
    'stock_movements',
    'product_cost_components',
    'journal_headers',
    'journal_lines',
    'audit_logs'
  ]

  loop

    execute format(
      'drop policy if exists "auth select" on public.%I',
      t
    );

    execute format(
      'create policy "auth select" on public.%I
       for select
       to authenticated
       using (true)',
      t
    );

  end loop;

end $$;


/* =========================================================
   29. INSERT POLICY
   ========================================================= */

do $$
declare
  t text;
begin

  foreach t in array array[
    'transactions',
    'sales',
    'purchases',
    'accounts_receivable',
    'accounts_payable',
    'ar_payments',
    'ap_payments',
    'products',
    'stock_movements',
    'product_cost_components',
    'journal_headers',
    'journal_lines'
  ]

  loop

    execute format(
      'drop policy if exists "auth insert" on public.%I',
      t
    );

    execute format(
      'create policy "auth insert" on public.%I
       for insert
       to authenticated
       with check (true)',
      t
    );

  end loop;

end $$;


/* =========================================================
   30. PROFILE POLICY
   ========================================================= */

drop policy if exists "auth insert profile"
on public.profiles;

create policy "auth insert profile"
on public.profiles

for insert
to authenticated

with check (
  id=auth.uid()
);


drop policy if exists "auth update profile"
on public.profiles;

create policy "auth update profile"
on public.profiles

for update
to authenticated

using (
  id=auth.uid()
)

with check (
  id=auth.uid()
);


/* =========================================================
   31. RPC PERMISSION
   ========================================================= */

revoke all on function public.post_cash_transaction(
  date,
  text,
  text,
  numeric,
  uuid,
  text,
  text,
  text
)
from public;

grant execute on function public.post_cash_transaction(
  date,
  text,
  text,
  numeric,
  uuid,
  text,
  text,
  text
)
to authenticated;


revoke all on function public.post_sale(
  date,
  text,
  numeric,
  numeric,
  date,
  uuid
)
from public;

grant execute on function public.post_sale(
  date,
  text,
  numeric,
  numeric,
  date,
  uuid
)
to authenticated;


revoke all on function public.post_purchase(
  date,
  text,
  numeric,
  numeric,
  date,
  uuid
)
from public;

grant execute on function public.post_purchase(
  date,
  text,
  numeric,
  numeric,
  date,
  uuid
)
to authenticated;


/* =========================================================
   32. INDEX
   ========================================================= */

create index if not exists idx_transactions_date
on public.transactions(transaction_date);

create index if not exists idx_sales_date
on public.sales(sale_date);

create index if not exists idx_purchases_date
on public.purchases(purchase_date);

create index if not exists idx_ar_due
on public.accounts_receivable(due_date);

create index if not exists idx_ap_due
on public.accounts_payable(due_date);

create index if not exists idx_stock_date
on public.stock_movements(movement_date);

create index if not exists idx_journal_date
on public.journal_headers(journal_date);

create index if not exists idx_journal_lines_journal
on public.journal_lines(journal_id);

create index if not exists idx_hpp_product
on public.product_cost_components(product_id);


/* =========================================================
   33. RELOAD SUPABASE POSTGREST SCHEMA
   ========================================================= */

notify pgrst, 'reload schema';


/* =========================================================
   SELESAI
   ========================================================= */

select
  'KARSA FINANCE DATABASE READY' as status,
  now() as executed_at;
