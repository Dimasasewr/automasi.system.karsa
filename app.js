/* KARSA Finance System — production-style client layer
   Supabase Auth + PostgreSQL + double-entry journals + CSV/XLSX export.
   No public registration: users are created in Supabase Authentication. */
(() => {
  'use strict';

  const SB_URL = String(window.KARSA_CONFIG?.SUPABASE_URL || '').trim();
  const SB_KEY = String(window.KARSA_CONFIG?.SUPABASE_KEY || '').trim();
  const DEMO_MODE = Boolean(window.KARSA_CONFIG?.DEMO_MODE);
  const state = {
    transactions: [], sales: [], purchases: [], ar: [], ap: [], arPayments: [], apPayments: [],
    products: [], hpp: [], journals: [], journalLines: [], accounts: [], cashAccounts: [], costComponents: [], stockMovements: [], profile: null
  };
  let sb = null;
  let user = null;
  let toastTimer = null;

  const $ = id => document.getElementById(id);
  const num = v => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const money = v => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num(v));
  const dateToday = () => new Date().toISOString().slice(0, 10);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data';
  const configured = () => !!(SB_URL && SB_KEY && !/PASTE_/i.test(SB_URL) && !/PASTE_/i.test(SB_KEY));

  function toast(text, ok = true) {
    const el = $('toast'); if (!el) return;
    el.textContent = text; el.classList.toggle('error', !ok); el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function authMessage(text, ok = false) {
    const el = $('authMessage'); if (!el) return;
    el.textContent = text; el.className = 'auth-message ' + (ok ? 'ok' : 'error');
  }
  function setLoader(text) { if ($('loaderStatus')) $('loaderStatus').textContent = text; }
  function showLoader(on) { $('loader')?.classList.toggle('hidden', !on); }
  function showAuth() { $('auth')?.classList.remove('hidden'); $('app')?.classList.add('hidden'); }
  function showApp() { $('auth')?.classList.add('hidden'); $('app')?.classList.remove('hidden'); }

  function errorText(error) {
    if (!error) return 'Terjadi kesalahan.';
    return error.message || error.details || error.hint || 'Terjadi kesalahan pada Supabase.';
  }
  async function withTimeout(promise, ms = 12000, label = 'Permintaan Supabase') {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${Math.round(ms / 1000)} detik.`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function query(table, columns = '*', order = 'created_at', ascending = false) {
    let q = sb.from(table).select(columns);
    if (order) q = q.order(order, { ascending });
    const { data, error } = await withTimeout(q, 12000, `Memuat ${table}`);
    if (error) throw error;
    return data || [];
  }
  async function insert(table, row) {
    const payload = { ...row };
    if (user && ['transactions','sales','purchases','ar_payments','ap_payments','products','stock_movements','journal_headers'].includes(table)) payload.created_by = user.id;
    const { data, error } = await withTimeout(sb.from(table).insert(payload).select().single(), 12000, `Menyimpan ${table}`);
    if (error) throw error;
    return data;
  }

  async function loadAll() {
    const tasks = [
      ['transactions','transactions','transaction_date'], ['sales','sales','sale_date'], ['purchases','purchases','purchase_date'],
      ['accounts_receivable','ar','invoice_date'], ['accounts_payable','ap','invoice_date'], ['ar_payments','arPayments','payment_date'],
      ['ap_payments','apPayments','payment_date'], ['products','products','created_at'], ['accounts','accounts','code'],
      ['cash_accounts','cashAccounts','created_at'], ['journal_headers','journals','journal_date'],
      ['v_product_hpp','hpp','name'], ['product_cost_components','costComponents','created_at'], ['stock_movements','stockMovements','movement_date']
    ];

    const results = await Promise.allSettled(tasks.map(([table, key, order]) => query(table, '*', order, false)));
    const warnings = [];
    results.forEach((result, i) => {
      const [table, key] = tasks[i];
      if (result.status === 'fulfilled') {
        state[key] = result.value || [];
      } else {
        state[key] = [];
        warnings.push(`${table}: ${errorText(result.reason)}`);
        console.warn('[KARSA Finance] Gagal memuat', table, result.reason);
      }
    });

    try {
      state.journalLines = await query('journal_lines', '*', 'line_no', true);
    } catch (e) {
      state.journalLines = [];
      warnings.push(`journal_lines: ${errorText(e)}`);
    }

    try {
      const { data, error } = await withTimeout(
        sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
        12000,
        'Memuat profile'
      );
      if (error) throw error;
      state.profile = data;
    } catch (e) {
      state.profile = null;
      console.warn('[KARSA Finance] Profile tidak dapat dimuat:', e);
    }

    window.KARSA_STATE = state;
    return warnings;
  }

  function account(code) { return state.accounts.find(a => a.code === code); }
  function accountId(code) { return account(code)?.id || null; }
  function cashId() { return state.cashAccounts[0]?.id || null; }
  function ensureAccount(code, label) { const id = accountId(code); if (!id) throw new Error(`Akun ${code} (${label}) belum ada. Jalankan SQL database KARSA terlebih dahulu.`); return id; }
  function ensureCash() { const id = cashId(); if (!id) throw new Error('Belum ada Kas/Bank. Buat minimal satu rekening di Supabase atau jalankan SQL setup KARSA.'); return id; }
  function nextNo(prefix, rows, field) {
    const max = rows.reduce((m, r) => { const x = String(r[field] || '').match(/(\d+)$/); return x ? Math.max(m, Number(x[1])) : m; }, 0);
    return `${prefix}-${String(max + 1).padStart(5, '0')}`;
  }

  async function createJournal({ type, date, description, sourceType, sourceId, lines }) {
    const clean = lines.filter(x => num(x.debit) > 0 || num(x.credit) > 0).map((x, i) => ({ ...x, debit: num(x.debit), credit: num(x.credit), line_no: i + 1 }));
    const debit = clean.reduce((s, x) => s + x.debit, 0);
    const credit = clean.reduce((s, x) => s + x.credit, 0);
    if (!clean.length) throw new Error('Jurnal tidak memiliki baris.');
    if (Math.abs(debit - credit) > 0.01) throw new Error(`Jurnal tidak balance. Debit ${money(debit)} ≠ Kredit ${money(credit)}.`);
    for (const line of clean) if (!line.account_id) throw new Error('Ada akun jurnal yang belum tersedia. Jalankan SQL setup.');
    const header = await insert('journal_headers', {
      journal_no: nextNo('JRN', state.journals, 'journal_no'), journal_date: date || dateToday(), journal_type: type,
      source_type: sourceType || null, source_id: sourceId || null, description, status: 'posted'
    });
    const { error } = await withTimeout(sb.from('journal_lines').insert(clean.map(x => ({ journal_id: header.id, line_no: x.line_no, account_id: x.account_id, description: x.description || description, debit: x.debit, credit: x.credit }))), 12000, 'Menyimpan detail jurnal');
    if (error) throw error;
    return header;
  }

  async function addCashTransaction(data) {
    const amount = num(data.cash_in) || num(data.cash_out);
    const direction = num(data.cash_in) > 0 ? 'in' : 'out';
    if ((num(data.cash_in) > 0) === (num(data.cash_out) > 0)) throw new Error('Isi salah satu: Uang Masuk atau Uang Keluar.');
    const { data: row, error } = await withTimeout(sb.rpc('post_cash_transaction', {
      p_date: data.transaction_date || dateToday(), p_direction: direction, p_category: data.category, p_amount: amount,
      p_cash_account_id: data.cash_account_id || null, p_description: String(data.description || '').trim(),
      p_reference: data.reference_no || null, p_pic: data.pic || null
    }), 12000, 'Menyimpan transaksi kas');
    if (error) throw error;
    return row;
  }

  function formField(label, name, type = 'text', value = '', extra = '') {
    return `<div class="field"><label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label></div>`;
  }
  function selectField(label, name, options, value = '', extra = '') {
    return `<div class="field"><label>${esc(label)}<select name="${esc(name)}" ${extra}><option value="">Pilih...</option>${options.map(o => `<option value="${esc(o.value)}" ${String(o.value)===String(value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label></div>`;
  }
  function modal(title, eyebrow, html, onSubmit) {
    $('modalEyebrow').textContent = eyebrow; $('modalTitle').textContent = title; $('modalForm').innerHTML = html + '<div class="form-actions"><button type="button" class="close-form" id="cancelForm">Batal</button><button class="gold-btn" type="submit">Simpan & Posting</button></div>';
    $('modal').classList.remove('hidden');
    $('cancelForm').onclick = closeModal;
    $('modalForm').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { await onSubmit(fd); closeModal(); await refresh(); toast('Data berhasil disimpan.'); } catch (err) { toast(errorText(err), false); } };
  }
  function closeModal() { $('modal')?.classList.add('hidden'); $('modalForm').innerHTML = ''; }

  function cashOptions() { return state.cashAccounts.map(c => ({ value: c.id, label: `${c.name} (${c.account_type === 'bank' ? 'Bank' : 'Kas'})` })); }
  function transactionModal() {
    const cash = cashOptions();
    modal('Tambah transaksi', 'TRANSACTION', `<div class="form-grid">
      ${formField('Tanggal','transaction_date','date',dateToday(),'required')}
      ${selectField('Jenis','direction',[{value:'in',label:'Uang Masuk'},{value:'out',label:'Uang Keluar'}],'in','required')}
      ${selectField('Kategori','category',[{value:'Penjualan',label:'Penjualan'},{value:'Modal',label:'Modal'},{value:'Pelunasan Piutang',label:'Pelunasan Piutang'},{value:'Pendapatan Lain',label:'Pendapatan Lain'},{value:'Pembelian',label:'Pembelian'},{value:'Pengeluaran',label:'Pengeluaran'},{value:'Bayar Hutang',label:'Bayar Hutang'},{value:'Prive',label:'Prive'}],'','required')}
      ${formField('Nominal','amount','number','','min="0" step="0.01" required')}
      ${selectField('Kas / Bank','cash_account_id',cash,'',cash.length?'required':'')}
      ${formField('Referensi','reference_no','text','','placeholder="Invoice / bukti"')}
      ${formField('PIC','pic','text','','placeholder="Nama PIC"')}
      <div class="field full"><label>Keterangan<textarea name="description" rows="3" required></textarea></label></div>
    </div>`, async fd => {
      const direction = fd.get('direction'); const amount = num(fd.get('amount'));
      if (amount <= 0) throw new Error('Nominal harus lebih dari 0.');
      await addCashTransaction({ transaction_date: fd.get('transaction_date'), category: fd.get('category'), description: fd.get('description'), cash_account_id: fd.get('cash_account_id'), cash_in: direction==='in'?amount:0, cash_out: direction==='out'?amount:0, reference_no: fd.get('reference_no'), pic: fd.get('pic'), source_type:'manual' });
    });
  }

  function saleModal() {
    modal('Tambah penjualan', 'SALES', `<div class="form-grid">
      ${formField('Tanggal','sale_date','date',dateToday(),'required')}
      ${formField('Pelanggan','customer_name','text','','placeholder="Nama pelanggan"')}
      ${formField('Total Penjualan','total','number','','min="0" step="0.01" required')}
      ${formField('Dibayar','paid','number','0','min="0" step="0.01" required')}
      ${formField('Jatuh Tempo','due_date','date')}
      ${selectField('Kas / Bank','cash_account_id',cashOptions())}
    </div>`, async fd => {
      const total=num(fd.get('total')), paid=num(fd.get('paid'));
      if(total<=0)throw new Error('Total penjualan harus lebih dari 0.');
      if(paid<0||paid>total)throw new Error('Nominal dibayar tidak valid.');
      const { error } = await withTimeout(sb.rpc('post_sale', {
        p_date: fd.get('sale_date') || dateToday(), p_customer: fd.get('customer_name') || null, p_total: total, p_paid: paid,
        p_due: fd.get('due_date') || null, p_cash_account_id: fd.get('cash_account_id') || null
      }), 12000, 'Menyimpan penjualan');
      if(error)throw error;
    });
  }

  function purchaseModal() {
    modal('Tambah pembelian', 'PURCHASES', `<div class="form-grid">
      ${formField('Tanggal','purchase_date','date',dateToday(),'required')}
      ${formField('Supplier','supplier_name','text','','placeholder="Nama supplier"')}
      ${formField('Total Pembelian','total','number','','min="0" step="0.01" required')}
      ${formField('Dibayar','paid','number','0','min="0" step="0.01" required')}
      ${formField('Jatuh Tempo','due_date','date')}
      ${selectField('Kas / Bank','cash_account_id',cashOptions())}
    </div>`, async fd => {
      const total=num(fd.get('total')), paid=num(fd.get('paid'));
      if(total<=0)throw new Error('Total pembelian harus lebih dari 0.');
      if(paid<0||paid>total)throw new Error('Nominal dibayar tidak valid.');
      const { error } = await withTimeout(sb.rpc('post_purchase', {
        p_date: fd.get('purchase_date') || dateToday(), p_supplier: fd.get('supplier_name') || null, p_total: total, p_paid: paid,
        p_due: fd.get('due_date') || null, p_cash_account_id: fd.get('cash_account_id') || null
      }), 12000, 'Menyimpan penjualan');
      if(error)throw error;
    });
  }

  function productModal() {
    modal('Tambah produk & HPP', 'PRODUCT / HPP', `<div class="form-grid">
      ${formField('SKU','sku','text','','required')}${formField('Nama Produk','name','text','','required')}
      ${formField('Ukuran','size','text','','placeholder="S / M / L / XL"')}${formField('Jenis Kain','fabric_type','text')}
      ${formField('Harga Jual','selling_price','number','0','min="0" step="0.01" required')}${formField('Stok Awal','stock_qty','number','0','min="0" step="0.001"')}
      ${formField('Batas Reorder','reorder_level','number','0','min="0" step="0.001"')}
      <div class="field full"><label>Komponen HPP <span class="field-help">format: nama|kelompok|qty|harga satuan, satu per baris</span><textarea name="components" rows="8" placeholder="Kain Utama|bahan|1|45000\nSatin 1|bahan|0.2|10000\nResleting|aksesoris|1|3000\nSticker|packaging|1|500\nPaper Bag|packaging|1|2500\nThanks Card|packaging|1|1000\nPlastik Zip Lock|packaging|1|700\nHandtag|aksesoris|1|1000\nTali Rami|aksesoris|1|500\nOngkos Produksi|produksi|1|15000"></textarea></label></div>
    </div>`, async fd => {
      const row=await insert('products',{sku:fd.get('sku').trim(),name:fd.get('name').trim(),size:fd.get('size')||null,fabric_type:fd.get('fabric_type')||null,selling_price:num(fd.get('selling_price')),stock_qty:num(fd.get('stock_qty')),reorder_level:num(fd.get('reorder_level')),active:true});
      const lines=String(fd.get('components')||'').split('\n').map(x=>x.trim()).filter(Boolean);
      const allowed=new Set(['bahan','produksi','packaging','aksesoris']);
      for(const line of lines){const [name,group='bahan',qty='1',cost='0']=line.split('|').map(x=>x.trim()); if(!name)continue; const g=allowed.has(group.toLowerCase())?group.toLowerCase():'bahan'; await insert('product_cost_components',{product_id:row.id,component_group:g,component_name:name,unit:'pcs',qty:num(qty),unit_cost:num(cost)});}
      if(num(fd.get('stock_qty'))>0) await insert('stock_movements',{movement_no:nextNo('STK',state.stockMovements,'movement_no'),movement_date:dateToday(),product_id:row.id,movement_type:'in',qty:num(fd.get('stock_qty')),unit_cost:0,source_type:'opening',note:'Stok awal'});
    });
  }

  function renderTable(target, headers, rows, empty='Belum ada data.') {
    const el=$(target); if(!el)return;
    if(!rows.length){el.innerHTML=`<div class="empty">${esc(empty)}</div>`;return;}
    el.innerHTML=`<table><thead><tr>${headers.map(h=>`<th>${esc(h.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${h.render ? h.render(r) : esc(r[h.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  // Safe table helper (separate from renderTable to keep cell callbacks readable).
  function table(target, columns, rows, empty='Belum ada data.') {
    const el=$(target); if(!el)return;
    if(!rows.length){el.innerHTML=`<div class="empty">${esc(empty)}</div>`;return;}
    el.innerHTML=`<table><thead><tr>${columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${c.render?c.render(row):esc(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function renderDashboard() {
    const t=state.transactions.filter(x=>x.status==='posted'); const inSum=t.reduce((s,x)=>s+num(x.cash_in),0), outSum=t.reduce((s,x)=>s+num(x.cash_out),0);
    const ar=state.ar.reduce((s,x)=>s+Math.max(0,num(x.amount)-num(x.paid)),0), ap=state.ap.reduce((s,x)=>s+Math.max(0,num(x.amount)-num(x.paid)),0), bal=state.cashAccounts.reduce((s,x)=>s+num(x.opening_balance),0)+inSum-outSum;
    ['sBalance','heroBalance'].forEach(id=>$(id)&&( $(id).textContent=money(bal) )); if($('sIn'))$('sIn').textContent=money(inSum);if($('sOut'))$('sOut').textContent=money(outSum);if($('sAR'))$('sAR').textContent=money(ar);if($('sAP'))$('sAP').textContent=money(ap);
    table('recent',[{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`}],t.slice(0,8));
    $('controlList').innerHTML=[
      `<div class="attention-item"><div class="bar"></div><div><strong>${state.journals.length} jurnal tercatat</strong><small>Jurnal tersimpan di database Supabase.</small></div></div>`,
      `<div class="attention-item"><div class="bar"></div><div><strong>${state.products.length} produk aktif</strong><small>HPP dihitung dari komponen produk.</small></div></div>`,
      `<div class="attention-item"><div class="bar ${ar>0?'red':''}"></div><div><strong>${money(ar)} piutang tersisa</strong><small>Periksa jatuh tempo pada menu Piutang.</small></div></div>`,
      `<div class="attention-item"><div class="bar ${ap>0?'red':''}"></div><div><strong>${money(ap)} hutang tersisa</strong><small>Periksa kewajiban pada menu Hutang.</small></div></div>`
    ].join('');
  }
  function renderCash(){
    const totalIn=state.transactions.reduce((s,x)=>s+num(x.cash_in),0), totalOut=state.transactions.reduce((s,x)=>s+num(x.cash_out),0), opening=state.cashAccounts.reduce((s,x)=>s+num(x.opening_balance),0);
    $('cashCards').innerHTML=`<div class="stat-card"><span>Saldo Awal</span><strong>${money(opening)}</strong></div><div class="stat-card"><span>Masuk</span><strong>${money(totalIn)}</strong></div><div class="stat-card"><span>Keluar</span><strong>${money(totalOut)}</strong></div><div class="stat-card"><span>Saldo</span><strong>${money(opening+totalIn-totalOut)}</strong></div>`;
    table('cashTable',[{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Rekening',render:r=>esc(state.cashAccounts.find(c=>c.id===r.cash_account_id)?.name||'-')},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`}],state.transactions);
  }
  function renderTransactions(){table('trxTable',[{label:'ID',render:r=>`<span class="badge">${esc(r.transaction_no)}</span>`},{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Kategori',render:r=>esc(r.category)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`},{label:'Status',render:r=>esc(r.status)}],state.transactions);}
  function renderSales(){table('salesTable',[{label:'No',render:r=>`<span class="badge">${esc(r.sale_no)}</span>`},{label:'Tanggal',render:r=>esc(r.sale_date)},{label:'Customer',render:r=>esc(r.customer_name||'-')},{label:'Total',render:r=>money(r.total)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.total)-num(r.paid))},{label:'Status',render:r=>esc(r.status)}],state.sales);}
  function renderPurchases(){table('purchaseTable',[{label:'No',render:r=>`<span class="badge">${esc(r.purchase_no)}</span>`},{label:'Tanggal',render:r=>esc(r.purchase_date)},{label:'Supplier',render:r=>esc(r.supplier_name||'-')},{label:'Total',render:r=>money(r.total)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.total)-num(r.paid))},{label:'Status',render:r=>esc(r.status)}],state.purchases);}
  function renderAR(){table('arTable',[{label:'Customer',render:r=>esc(r.customer_name)},{label:'Referensi',render:r=>esc(r.reference_no||'-')},{label:'Tanggal',render:r=>esc(r.invoice_date)},{label:'Total',render:r=>money(r.amount)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.amount)-num(r.paid))},{label:'Jatuh Tempo',render:r=>esc(r.due_date||'-')},{label:'Status',render:r=>esc(r.status)}],state.ar);}
  function renderAP(){table('apTable',[{label:'Supplier',render:r=>esc(r.supplier_name)},{label:'Referensi',render:r=>esc(r.reference_no||'-')},{label:'Tanggal',render:r=>esc(r.invoice_date)},{label:'Total',render:r=>money(r.amount)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.amount)-num(r.paid))},{label:'Jatuh Tempo',render:r=>esc(r.due_date||'-')},{label:'Status',render:r=>esc(r.status)}],state.ap);}
  function renderStock(){table('stockTable',[{label:'SKU',render:r=>`<span class="badge">${esc(r.sku)}</span>`},{label:'Produk',render:r=>esc(r.name)},{label:'Ukuran',render:r=>esc(r.size||'-')},{label:'Kain',render:r=>esc(r.fabric_type||'-')},{label:'Stok',render:r=>num(r.stock_qty)},{label:'HPP/Unit',render:r=>money(r.hpp_per_unit)},{label:'Harga Jual',render:r=>money(r.selling_price)},{label:'Laba/Unit',render:r=>money(r.estimated_profit)},{label:'Margin',render:r=>`${num(r.margin_percent).toFixed(2)}%`}],state.hpp.length?state.hpp:state.products.map(p=>({...p,hpp_per_unit:0,estimated_profit:num(p.selling_price),margin_percent:100})));}
  function renderJournal(){
    const rows=state.journals.map(h=>{const ls=state.journalLines.filter(l=>l.journal_id===h.id);return {...h,lines:ls};});
    table('journalTable',[{label:'No',render:r=>`<span class="badge">${esc(r.journal_no)}</span>`},{label:'Tanggal',render:r=>esc(r.journal_date)},{label:'Jenis',render:r=>esc(r.journal_type)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Debit',render:r=>money(r.lines.reduce((s,l)=>s+num(l.debit),0))},{label:'Kredit',render:r=>money(r.lines.reduce((s,l)=>s+num(l.credit),0))},{label:'Balance',render:r=>{const d=r.lines.reduce((s,l)=>s+num(l.debit),0),c=r.lines.reduce((s,l)=>s+num(l.credit),0);return Math.abs(d-c)<.01?'<span class="badge ok-badge">BALANCE</span>':'<span class="badge danger-badge">SELISIH</span>';}}],rows);
  }
  function renderReports(){
    const revenue=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='revenue'?num(l.credit)-num(l.debit):0)},0);
    const cogs=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='cogs'?num(l.debit)-num(l.credit):0)},0);
    const expense=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='expense'?num(l.debit)-num(l.credit):0)},0);
    const gross=revenue-cogs, net=gross-expense;
    $('reportCards').innerHTML=`<div class="stat-card"><span>Pendapatan</span><strong>${money(revenue)}</strong></div><div class="stat-card"><span>HPP</span><strong>${money(cogs)}</strong></div><div class="stat-card"><span>Laba Kotor</span><strong>${money(gross)}</strong></div><div class="stat-card"><span>Beban</span><strong>${money(expense)}</strong></div><div class="stat-card"><span>Laba Bersih</span><strong>${money(net)}</strong></div>`;
    table('reportTable',[{label:'Laporan',render:r=>esc(r.name)},{label:'Nilai',render:r=>money(r.value)}],[{name:'Penjualan',value:revenue},{name:'HPP',value:cogs},{name:'Laba Kotor',value:gross},{name:'Beban Operasional',value:expense},{name:'Laba Bersih',value:net}]);
  }
  function renderAll(){renderDashboard();renderCash();renderTransactions();renderSales();renderPurchases();renderAR();renderAP();renderStock();renderJournal();renderReports();}

  function csvEscape(v){return `"${String(v??'').replace(/"/g,'""')}"`;}
  function downloadCSV(filename, rows){
    if(!rows.length){toast('Tidak ada data untuk diexport.',false);return;}
    const headers=Object.keys(rows[0]); const text=[headers.map(csvEscape).join(','),...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\r\n');
    const blob=new Blob(['\ufeff'+text],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); const url=URL.createObjectURL(blob); a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);
  }
  function journalExportRows(){return state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({journal_no:h.journal_no,tanggal:h.journal_date,jenis:h.journal_type,referensi:h.source_type||'',keterangan:h.description,akun:state.accounts.find(a=>a.id===l.account_id)?.code||'',nama_akun:state.accounts.find(a=>a.id===l.account_id)?.name||'',debit:num(l.debit),kredit:num(l.credit),status:h.status})));}
  function exportData(type){
    const map={transactions:state.transactions,journal:journalExportRows(),sales:state.sales,purchases:state.purchases,ar:state.ar,ap:state.ap,stock:state.hpp};
    if(type==='xlsx'){exportWorkbook();return;}
    if(type==='all'){downloadCSV(`KARSA-Finance-Semua-${dateToday()}.csv`,state.transactions);return;}
    downloadCSV(`KARSA-Finance-${slug(type)}-${dateToday()}.csv`,map[type]||[]);
  }
  function exportWorkbook(){
    if(!window.XLSX){toast('Library Excel belum termuat. Pastikan koneksi internet tersedia.',false);return;}
    const wb=XLSX.utils.book_new();
    const add=(name,rows)=>{const data=rows.length?rows:[{Keterangan:'Tidak ada data'}];XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),name.slice(0,31));};
    add('Petunjuk',[{Item:'KARSA Finance',Keterangan:'Workbook export dari Supabase'},{Item:'Saldo',Keterangan:'Saldo Awal + Uang Masuk - Uang Keluar'},{Item:'HPP',Keterangan:'Qty x Harga Satuan; total produk = SUM komponen'},{Item:'Laba Bersih',Keterangan:'Pendapatan - HPP - Beban'},{Item:'Spreadsheet',Keterangan:'File XLSX dapat dibuka/import ke Google Sheets.'}]);
    add('Transaksi',state.transactions);add('Penjualan',state.sales);add('Pembelian',state.purchases);add('Piutang',state.ar);add('Hutang',state.ap);add('Produk_HPP',state.hpp);add('Komponen_HPP',state.costComponents);add('Stok',state.stockMovements);add('Jurnal',journalExportRows());add('Akun',state.accounts);add('Kas_Bank',state.cashAccounts);

    const cashSheet=[['Rekening','Saldo Awal','Uang Masuk','Uang Keluar','Saldo Akhir']];
    state.cashAccounts.forEach((c,i)=>{
      const row=i+2, ins=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_in),0), outs=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_out),0);
      cashSheet.push([c.name,num(c.opening_balance),ins,outs,null]);
      cashSheet[cashSheet.length-1][4]={f:`B${row}+C${row}-D${row}`};
    });
    const wsCash=XLSX.utils.aoa_to_sheet(cashSheet);XLSX.utils.book_append_sheet(wb,wsCash,'Rumus_Kas');

    const hppSheet=[['SKU','Produk','Harga Jual','HPP/Unit','Laba/Unit','Margin %']];
    state.hpp.forEach((p,i)=>{const r=i+2;hppSheet.push([p.sku,p.name,num(p.selling_price),num(p.hpp_per_unit),null,null]);hppSheet[hppSheet.length-1][4]={f:`C${r}-D${r}`};hppSheet[hppSheet.length-1][5]={f:`IF(C${r}>0,E${r}/C${r},0)`};});
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(hppSheet),'Rumus_HPP');

    const journalRows=journalExportRows();
    const jr=[['Jurnal','Debit','Kredit','Selisih']];
    journalRows.forEach((x,i)=>{const r=i+2;jr.push([x.journal_no,num(x.debit),num(x.kredit),null]);jr[jr.length-1][3]={f:`B${r}-C${r}`};});
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(jr),'Rumus_Jurnal');

    const rev=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='revenue'?num(l.credit)-num(l.debit):0)},0);
    const cogs=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='cogs'?num(l.debit)-num(l.credit):0)},0);
    const expense=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='expense'?num(l.debit)-num(l.credit):0)},0);
    const lr=[['Komponen','Nilai'],['Pendapatan',null],['HPP',null],['Laba Kotor',null],['Beban',null],['Laba Bersih',null]];
    lr[1][1]={f:`SUMIF(Jurnal!G:G,"Penjualan",Jurnal!I:I)`};
    // The exact current journal totals are also stored in a formula-friendly snapshot below.
    lr[2][1]={f:`SUMIF(Jurnal!G:G,"HPP",Jurnal!H:H)`}; lr[3][1]={f:'B2-B3'}; lr[4][1]={f:`SUMIF(Jurnal!G:G,"Beban*",Jurnal!H:H)`}; lr[5][1]={f:'B4-B5'};
    // Jurnal uses nama_akun in column G and debit/kredit in H/I; the snapshot is kept alongside for portability.
    lr.push(['Snapshot Pendapatan',rev],['Snapshot HPP',cogs],['Snapshot Beban',expense]);
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(lr),'Laba_Rugi');
    XLSX.writeFile(wb,`KARSA-Finance-${dateToday()}.xlsx`);toast('Workbook Excel berhasil dibuat. XLSX dapat dibuka di Microsoft Excel atau Google Sheets.');
  }

  function go(page){
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
    document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===page));
    const title=[...document.querySelectorAll('.nav-item')].find(x=>x.dataset.page===page); $('pageTitle').textContent=title?title.textContent.replace(/^./,'').trim():page;
    window.scrollTo({top:0,behavior:'smooth'});
  }
  async function refresh(){
    if(!sb || !user) return;
    try {
      const warnings = await loadAll();
      try { renderAll(); } catch(e) { console.error('[KARSA Finance] Render error:', e); toast('Data masuk, tetapi sebagian tampilan gagal dirender: '+errorText(e), false); }
      updateProfile();
      if(warnings.length) console.warn('[KARSA Finance] Data warning:', warnings);
      return warnings;
    } catch(e) {
      console.error('[KARSA Finance] Refresh error:', e);
      toast('Gagal memuat ulang data: '+errorText(e), false);
      throw e;
    }
  }
  function updateProfile(){const name=state.profile?.full_name||user?.email?.split('@')[0]||'Finance';if($('profileName'))$('profileName').textContent=name;if($('profileEmail'))$('profileEmail').textContent=user?.email||'-';if($('avatar'))$('avatar').textContent=name.slice(0,2).toUpperCase();}

  let loginBusy = false;
  let handledSessionId = null;

  async function login(){
    if(!configured()) throw new Error('Supabase belum dikonfigurasi. Isi config.js dengan Project URL dan Publishable/anon public key.');
    if(!sb) throw new Error('Koneksi Supabase belum siap. Tunggu sebentar lalu coba lagi.');
    if(loginBusy) return;

    const email = $('loginEmail')?.value.trim() || '';
    const password = $('loginPass')?.value || '';
    if(!email || !password) throw new Error('Email dan password wajib diisi.');

    loginBusy = true;
    const button = $('loginForm')?.querySelector('button[type="submit"]');
    if(button){ button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = 'Menghubungkan…'; }
    authMessage('Menghubungkan ke Supabase…', true);

    try {
      const result = await withTimeout(
        sb.auth.signInWithPassword({ email, password }),
        15000,
        'Login Supabase'
      );
      const { data, error } = result;
      if(error) throw error;
      if(!data?.session) throw new Error('Login belum menghasilkan session.');

      // Jangan menunggu loadAll di dalam callback auth.
      user = data.session.user;
      await handleSession(data.session);
    } finally {
      loginBusy = false;
      if(button){ button.disabled = false; button.textContent = button.dataset.originalText || 'Masuk ke Finance'; }
    }
  }

  async function logout(){
    if(!sb) return;
    try { await withTimeout(sb.auth.signOut(), 10000, 'Logout Supabase'); }
    finally { user = null; handledSessionId = null; showAuth(); showLoader(false); }
  }

  async function handleSession(session){
    if(!session?.user){
      handledSessionId = null;
      user = null;
      showLoader(false);
      showAuth();
      return;
    }

    user = session.user;
    const sessionId = session.access_token || session.user.id;
    if (handledSessionId === sessionId) return;
    handledSessionId = sessionId;
    // Tampilkan area aplikasi segera supaya UI tidak pernah terkunci di loader.
    showLoader(false);
    showAuth();
    authMessage('');

    try {
      setLoader('Memuat data Finance…');
      const warnings = await loadAll();
      try { updateProfile(); renderAll(); }
      catch (renderError) {
        console.error('[KARSA Finance] Render error:', renderError);
        toast('Login berhasil. Sebagian tampilan belum dapat dirender.', false);
      }
      showApp();
      if(warnings.length) toast('Login berhasil. Beberapa data belum termuat; cek Console untuk detail.', false);
    } catch(e) {
      console.error('[KARSA Finance] loadAll error:', e);
      // Login tetap dianggap berhasil meskipun data database bermasalah.
      showApp();
      toast(`Login berhasil, tetapi data belum termuat: ${errorText(e)}`, false);
    } finally {
      showLoader(false);
    }
  }

  function bind(){
    $('loginForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await login();}catch(err){authMessage(errorText(err),false);}});
    $('logout')?.addEventListener('click',async()=>{try{await logout();}catch(e){toast(errorText(e),false);}});
    $('closeModal')?.addEventListener('click',closeModal); $('modal')?.addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});
    $('quickBtn')?.addEventListener('click',transactionModal); $('heroAdd')?.addEventListener('click',transactionModal); $('cashAdd')?.addEventListener('click',transactionModal); $('trxAdd')?.addEventListener('click',transactionModal); $('saleAdd')?.addEventListener('click',saleModal); $('purchaseAdd')?.addEventListener('click',purchaseModal); $('productAdd')?.addEventListener('click',productModal);
    document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
    document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
    document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>exportData(b.dataset.export)));
    setInterval(()=>{if($('clock'))$('clock').textContent=new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date());},1000);
  }

  async function init(){
    bind();
    showLoader(true);
    setLoader('Memeriksa konfigurasi…');

    if(!configured()){
      showLoader(false);
      showAuth();
      authMessage('Supabase belum dikonfigurasi. Buka config.js lalu isi Project URL dan Publishable/anon public key.');
      return;
    }

    if(!window.supabase?.createClient){
      showLoader(false);
      showAuth();
      authMessage('Library Supabase gagal dimuat. Pastikan koneksi internet aktif lalu refresh halaman.');
      return;
    }

    try {
      sb = window.supabase.createClient(SB_URL, SB_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });

      // Listener auth TIDAK boleh menunggu query database di dalam callback.
      sb.auth.onAuthStateChange((_event, session) => {
        setTimeout(() => {
          handleSession(session).catch(e => {
            console.error('[KARSA Finance] Session handler error:', e);
            showLoader(false);
            if(session?.user) showApp(); else showAuth();
            toast(errorText(e), false);
          });
        }, 0);
      });

      setLoader('Memeriksa session…');
      const { data, error } = await withTimeout(
        sb.auth.getSession(),
        10000,
        'Pemeriksaan session'
      );
      if(error) throw error;

      if(data?.session){
        await handleSession(data.session);
      } else {
        user = null;
        showLoader(false);
        showAuth();
      }
    } catch(err) {
      console.error('[KARSA Finance] Init error:', err);
      showLoader(false);
      showAuth();
      authMessage(errorText(err), false);
    }
  }
  window.KARSA={state,refresh,login,logout,downloadCSV,exportWorkbook,exportData,money};
  document.addEventListener('DOMContentLoaded',init);
})();
