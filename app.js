/* KARSA Finance System — Supabase Auth + PostgreSQL
   Login, session, loading, dashboard, transaksi, jurnal, export.
*/
(() => {
  'use strict';

  const SB_URL = String(window.KARSA_CONFIG?.SUPABASE_URL || '').trim();
  const SB_KEY = String(window.KARSA_CONFIG?.SUPABASE_KEY || '').trim();
  const DEMO_MODE = Boolean(window.KARSA_CONFIG?.DEMO_MODE);

  const state = {
    transactions: [],
    sales: [],
    purchases: [],
    ar: [],
    ap: [],
    arPayments: [],
    apPayments: [],
    products: [],
    hpp: [],
    journals: [],
    journalLines: [],
    accounts: [],
    cashAccounts: [],
    costComponents: [],
    stockMovements: [],
    profile: null
  };

  let sb = null;
  let user = null;
  let loginBusy = false;
  let handledSessionId = null;

  const $ = id => document.getElementById(id);

  function configured() {
    return !!(
      SB_URL &&
      SB_KEY &&
      !/PASTE_/i.test(SB_URL) &&
      !/PASTE_/i.test(SB_KEY)
    );
  }

  function errorText(error) {
    if (!error) return 'Terjadi kesalahan.';
    if (typeof error === 'string') return error;

    return (
      error.message ||
      error.error_description ||
      error.details ||
      error.hint ||
      'Terjadi kesalahan.'
    );
  }

  async function withTimeout(promise, ms = 12000, label = 'Permintaan Supabase') {
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `${label} timeout setelah ${Math.round(ms / 1000)} detik.`
          )
        );
      }, ms);
    });

    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function showLoader(show = true) {
    const loader = $('loader');
    if (!loader) return;

    loader.classList.toggle('hidden', !show);
  }

  function setLoader(text) {
    const el = $('loaderStatus');
    if (el) el.textContent = text;
  }

  function showAuth() {
    $('auth')?.classList.remove('hidden');
    $('app')?.classList.add('hidden');
  }

  function showApp() {
    $('auth')?.classList.add('hidden');
    $('app')?.classList.remove('hidden');
  }

  function authMessage(message = '', success = false) {
    const el = $('authMessage');
    if (!el) return;

    el.textContent = message;
    el.classList.toggle('success', Boolean(success));
    el.classList.toggle('error', Boolean(message && !success));
  }

  function toast(message, success = true) {
    let el = $('toast');

    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.className = 'toast';
      document.body.appendChild(el);
    }

    el.textContent = message;
    el.classList.toggle('error', !success);
    el.classList.add('show');

    clearTimeout(el._timer);

    el._timer = setTimeout(() => {
      el.classList.remove('show');
    }, 3500);
  }

  async function query(
    table,
    columns = '*',
    order = 'created_at',
    ascending = false
  ) {
    let q = sb.from(table).select(columns);

    if (order) {
      q = q.order(order, { ascending });
    }

    const { data, error } = await withTimeout(
      q,
      12000,
      `Memuat ${table}`
    );

    if (error) throw error;

    return data || [];
  }

  async function loadAll() {
    const tasks = [
      ['transactions', 'transactions', 'transaction_date'],
      ['sales', 'sales', 'sale_date'],
      ['purchases', 'purchases', 'purchase_date'],
      ['accounts_receivable', 'ar', 'invoice_date'],
      ['accounts_payable', 'ap', 'invoice_date'],
      ['ar_payments', 'arPayments', 'payment_date'],
      ['ap_payments', 'apPayments', 'payment_date'],
      ['products', 'products', 'created_at'],
      ['accounts', 'accounts', 'code'],
      ['cash_accounts', 'cashAccounts', 'created_at'],
      ['journal_headers', 'journals', 'journal_date'],
      ['v_product_hpp', 'hpp', 'name'],
      ['product_cost_components', 'costComponents', 'created_at'],
      ['stock_movements', 'stockMovements', 'movement_date'],
      ['journal_lines', 'journalLines', 'line_no'],
      ['profiles', 'profile', 'created_at']
    ];

    const results = await Promise.allSettled(
      tasks.map(async ([table, key, order]) => {
        if (table === 'profiles') {
          const { data, error } = await withTimeout(
            sb
              .from('profiles')
              .select('*')
              .eq('id', user.id)
              .maybeSingle(),
            8000,
            'Memuat profile'
          );

          if (error) throw error;

          return data || null;
        }

        return await query(
          table,
          '*',
          order,
          table === 'journal_lines'
        );
      })
    );

    const warnings = [];

    results.forEach((result, i) => {
      const [table, key] = tasks[i];

      if (result.status === 'fulfilled') {
        state[key] =
          result.value ||
          (key === 'profile' ? null : []);
      } else {
        if (key === 'profile') {
          state.profile = null;
        } else {
          state[key] = [];
        }

        warnings.push(
          `${table}: ${errorText(result.reason)}`
        );

        console.warn(
          '[KARSA Finance] Gagal memuat',
          table,
          result.reason
        );
      }
    });

    window.KARSA_STATE = state;

    return warnings;
  }

  function money(value) {
    const n = Number(value || 0);

    return new Intl.NumberFormat('id-ID', {
      style: 'currency',
      currency: 'IDR',
      maximumFractionDigits: 0
    }).format(n);
  }

  function number(value) {
    return new Intl.NumberFormat('id-ID').format(
      Number(value || 0)
    );
  }

  function date(value) {
    if (!value) return '-';

    const d = new Date(value);

    if (Number.isNaN(d.getTime())) return value;

    return new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'medium'
    }).format(d);
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function sum(rows, field) {
    return rows.reduce(
      (total, row) =>
        total + Number(row?.[field] || 0),
      0
    );
  }

  function table(target, headers, rows, empty = 'Belum ada data.') {
    const el =
      typeof target === 'string'
        ? $(target)
        : target;

    if (!el) return;

    if (!rows || !rows.length) {
      el.innerHTML = `
        <div class="empty-state">
          ${escapeHtml(empty)}
        </div>
      `;
      return;
    }

    el.innerHTML = `
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              ${headers
                .map(h => `<th>${escapeHtml(h)}</th>`)
                .join('')}
            </tr>
          </thead>

          <tbody>
            ${rows
              .map(row => {
                if (Array.isArray(row)) {
                  return `
                    <tr>
                      ${row
                        .map(
                          cell =>
                            `<td>${cell ?? ''}</td>`
                        )
                        .join('')}
                    </tr>
                  `;
                }

                return `
                  <tr>
                    ${headers
                      .map(
                        h =>
                          `<td>${escapeHtml(
                            row?.[h] ?? ''
                          )}</td>`
                      )
                      .join('')}
                  </tr>
                `;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderDashboard() {
    const trx = state.transactions || [];
    const sales = state.sales || [];
    const purchases = state.purchases || [];
    const ar = state.ar || [];
    const ap = state.ap || [];

    const income = trx
      .filter(x => String(x.type || '').toLowerCase() === 'income')
      .reduce(
        (a, x) => a + Number(x.amount || 0),
        0
      );

    const expense = trx
      .filter(x => String(x.type || '').toLowerCase() === 'expense')
      .reduce(
        (a, x) => a + Number(x.amount || 0),
        0
      );

    const salesTotal =
      sum(sales, 'total_amount') ||
      sum(sales, 'amount') ||
      sum(sales, 'grand_total');

    const purchaseTotal =
      sum(purchases, 'total_amount') ||
      sum(purchases, 'amount') ||
      sum(purchases, 'grand_total');

    const arTotal =
      sum(ar, 'remaining_amount') ||
      sum(ar, 'amount_due') ||
      sum(ar, 'total_amount');

    const apTotal =
      sum(ap, 'remaining_amount') ||
      sum(ap, 'amount_due') ||
      sum(ap, 'total_amount');

    const cash =
      income -
      expense;

    const selectors = {
      dashboardIncome: income,
      dashboardExpense: expense,
      dashboardSales: salesTotal,
      dashboardPurchase: purchaseTotal,
      dashboardAR: arTotal,
      dashboardAP: apTotal,
      dashboardCash: cash
    };

    Object.entries(selectors).forEach(([id, value]) => {
      const el = $(id);
      if (el) el.textContent = money(value);
    });

    const trxBody = $('dashboardTransactions');

    if (trxBody) {
      table(
        trxBody,
        ['Tanggal', 'ID', 'Keterangan', 'Nominal'],
        trx.slice(0, 10).map(x => [
          date(x.transaction_date),
          escapeHtml(x.transaction_no || x.id || '-'),
          escapeHtml(
            x.description ||
            x.notes ||
            x.category ||
            '-'
          ),
          money(x.amount)
        ])
      );
    }
  }

  function renderCash() {
    const rows = state.transactions || [];

    table(
      'cashTable',
      ['Tanggal', 'ID', 'Jenis', 'Keterangan', 'Nominal'],
      rows.slice(0, 100).map(x => [
        date(x.transaction_date),
        escapeHtml(
          x.transaction_no ||
          x.reference_no ||
          x.id ||
          '-'
        ),
        escapeHtml(x.type || '-'),
        escapeHtml(
          x.description ||
          x.notes ||
          x.category ||
          '-'
        ),
        money(x.amount)
      ])
    );
  }

  function renderTransactions() {
    const rows = state.transactions || [];

    table(
      'transactionsTable',
      ['Tanggal', 'ID', 'Jenis', 'Keterangan', 'Nominal'],
      rows.map(x => [
        date(x.transaction_date),
        escapeHtml(
          x.transaction_no ||
          x.reference_no ||
          x.id ||
          '-'
        ),
        escapeHtml(x.type || '-'),
        escapeHtml(
          x.description ||
          x.notes ||
          x.category ||
          '-'
        ),
        money(x.amount)
      ])
    );
  }

  function renderSales() {
    const rows = state.sales || [];

    table(
      'salesTable',
      ['Tanggal', 'No. Penjualan', 'Pelanggan', 'Total'],
      rows.map(x => [
        date(x.sale_date),
        escapeHtml(
          x.sale_no ||
          x.invoice_no ||
          x.transaction_no ||
          x.id ||
          '-'
        ),
        escapeHtml(
          x.customer_name ||
          x.customer ||
          '-'
        ),
        money(
          x.total_amount ||
          x.amount ||
          x.grand_total
        )
      ])
    );
  }

  function renderPurchases() {
    const rows = state.purchases || [];

    table(
      'purchasesTable',
      ['Tanggal', 'No. Pembelian', 'Supplier', 'Total'],
      rows.map(x => [
        date(x.purchase_date),
        escapeHtml(
          x.purchase_no ||
          x.invoice_no ||
          x.transaction_no ||
          x.id ||
          '-'
        ),
        escapeHtml(
          x.supplier_name ||
          x.supplier ||
          '-'
        ),
        money(
          x.total_amount ||
          x.amount ||
          x.grand_total
        )
      ])
    );
  }

  function renderAR() {
    const rows = state.ar || [];

    table(
      'arTable',
      [
        'Tanggal',
        'Invoice',
        'Pelanggan',
        'Jatuh Tempo',
        'Sisa'
      ],
      rows.map(x => [
        date(x.invoice_date),
        escapeHtml(
          x.invoice_no ||
          x.reference_no ||
          x.id ||
          '-'
        ),
        escapeHtml(
          x.customer_name ||
          x.customer ||
          '-'
        ),
        date(x.due_date),
        money(
          x.remaining_amount ||
          x.amount_due ||
          x.total_amount
        )
      ])
    );
  }

  function renderAP() {
    const rows = state.ap || [];

    table(
      'apTable',
      [
        'Tanggal',
        'Invoice',
        'Supplier',
        'Jatuh Tempo',
        'Sisa'
      ],
      rows.map(x => [
        date(x.invoice_date),
        escapeHtml(
          x.invoice_no ||
          x.reference_no ||
          x.id ||
          '-'
        ),
        escapeHtml(
          x.supplier_name ||
          x.supplier ||
          '-'
        ),
        date(x.due_date),
        money(
          x.remaining_amount ||
          x.amount_due ||
          x.total_amount
        )
      ])
    );
  }

  function renderStock() {
    const rows = state.products || [];

    table(
      'stockTable',
      [
        'Produk',
        'SKU',
        'Ukuran',
        'Bahan',
        'Stok',
        'Minimum'
      ],
      rows.map(x => [
        escapeHtml(x.name || '-'),
        escapeHtml(x.sku || x.code || '-'),
        escapeHtml(x.size || '-'),
        escapeHtml(x.fabric_type || '-'),
        number(x.stock_qty || x.stock || 0),
        number(x.reorder_level || 0)
      ])
    );
  }

  function renderJournal() {
    const rows = state.journals || [];

    table(
      'journalTable',
      [
        'Tanggal',
        'No. Jurnal',
        'Keterangan',
        'Status'
      ],
      rows.map(x => [
        date(x.journal_date),
        escapeHtml(
          x.journal_no ||
          x.reference_no ||
          x.id ||
          '-'
        ),
        escapeHtml(
          x.description ||
          x.memo ||
          '-'
        ),
        escapeHtml(
          x.status ||
          'posted'
        )
      ])
    );
  }

  function renderReports() {
    const sales =
      sum(state.sales, 'total_amount') ||
      sum(state.sales, 'amount') ||
      sum(state.sales, 'grand_total');

    const purchases =
      sum(state.purchases, 'total_amount') ||
      sum(state.purchases, 'amount') ||
      sum(state.purchases, 'grand_total');

    const expense = state.transactions
      .filter(
        x =>
          String(x.type || '').toLowerCase() ===
          'expense'
      )
      .reduce(
        (a, x) =>
          a + Number(x.amount || 0),
        0
      );

    const income = state.transactions
      .filter(
        x =>
          String(x.type || '').toLowerCase() ===
          'income'
      )
      .reduce(
        (a, x) =>
          a + Number(x.amount || 0),
        0
      );

    const values = {
      reportSales: sales,
      reportPurchases: purchases,
      reportIncome: income,
      reportExpense: expense,
      reportProfit: sales - expense
    };

    Object.entries(values).forEach(([id, value]) => {
      const el = $(id);
      if (el) el.textContent = money(value);
    });
  }

  function renderAll() {
    renderDashboard();
    renderCash();
    renderTransactions();
    renderSales();
    renderPurchases();
    renderAR();
    renderAP();
    renderStock();
    renderJournal();
    renderReports();
  }

  function updateProfile() {
    const profile = state.profile || {};

    const name =
      profile.full_name ||
      profile.name ||
      user?.user_metadata?.full_name ||
      user?.email ||
      'Finance';

    const email =
      profile.email ||
      user?.email ||
      '';

    [
      'profileName',
      'userName',
      'sidebarUserName'
    ].forEach(id => {
      const el = $(id);
      if (el) el.textContent = name;
    });

    [
      'profileEmail',
      'userEmail',
      'sidebarUserEmail'
    ].forEach(id => {
      const el = $(id);
      if (el) el.textContent = email;
    });
  }

  async function refresh() {
    if (!user || !sb) return;

    try {
      const warnings = await loadAll();

      updateProfile();
      renderAll();

      if (warnings.length) {
        console.warn(
          '[KARSA Finance] Warning:',
          warnings
        );
      }

      return warnings;
    } catch (error) {
      console.error(
        '[KARSA Finance] Refresh error:',
        error
      );

      toast(
        `Gagal memperbarui data: ${errorText(error)}`,
        false
      );

      throw error;
    }
  }

  async function login() {
    if (!configured()) {
      throw new Error(
        'Supabase belum dikonfigurasi. Isi config.js dengan Project URL dan Publishable/anon public key.'
      );
    }

    if (!sb) {
      throw new Error(
        'Koneksi Supabase belum siap. Tunggu sebentar lalu coba lagi.'
      );
    }

    if (loginBusy) return;

    const email =
      $('loginEmail')?.value.trim() ||
      '';

    const password =
      $('loginPass')?.value ||
      '';

    if (!email || !password) {
      throw new Error(
        'Email dan password wajib diisi.'
      );
    }

    loginBusy = true;

    const button =
      $('loginForm')?.querySelector(
        'button[type="submit"]'
      );

    if (button) {
      button.disabled = true;
      button.dataset.originalText =
        button.textContent;

      button.textContent =
        'Menghubungkan…';
    }

    authMessage(
      'Menghubungkan ke Supabase…',
      true
    );

    try {
      const result = await withTimeout(
        sb.auth.signInWithPassword({
          email,
          password
        }),
        15000,
        'Login Supabase'
      );

      const { data, error } = result;

      if (error) throw error;

      if (!data?.session) {
        throw new Error(
          'Login belum menghasilkan session.'
        );
      }

      user = data.session.user;

      await handleSession(
        data.session
      );
    } finally {
      loginBusy = false;

      if (button) {
        button.disabled = false;

        button.textContent =
          button.dataset.originalText ||
          'Masuk ke Finance';
      }
    }
  }

  async function logout() {
    if (!sb) return;

    try {
      await withTimeout(
        sb.auth.signOut(),
        10000,
        'Logout Supabase'
      );
    } finally {
      user = null;
      handledSessionId = null;

      showAuth();
      showLoader(false);
      authMessage('');
    }
  }

  async function handleSession(session) {
    if (!session?.user) {
      handledSessionId = null;
      user = null;

      showLoader(false);
      showAuth();

      return;
    }

    user = session.user;

    const sessionId =
      session.user.id;

    if (
      handledSessionId ===
      sessionId
    ) {
      showLoader(false);
      showApp();
      return;
    }

    handledSessionId =
      sessionId;

    /*
     * SESSION VALID.
     * Jangan menunggu database untuk menampilkan aplikasi.
     */
    showLoader(false);
    showApp();
    authMessage('');

    /*
     * Load database di belakang layar.
     * Kalau ada tabel bermasalah, aplikasi tetap terbuka.
     */
    try {
      const warnings =
        await Promise.race([
          loadAll(),

          new Promise(resolve =>
            setTimeout(
              () =>
                resolve([
                  'background-timeout'
                ]),
              15000
            )
          )
        ]);

      try {
        updateProfile();
        renderAll();
      } catch (renderError) {
        console.error(
          '[KARSA Finance] Render error:',
          renderError
        );

        toast(
          'Login berhasil. Sebagian tampilan belum dapat dirender.',
          false
        );
      }

      if (
        Array.isArray(warnings) &&
        warnings.length
      ) {
        console.warn(
          '[KARSA Finance] Data warning:',
          warnings
        );
      }
    } catch (error) {
      console.error(
        '[KARSA Finance] Background load error:',
        error
      );

      toast(
        'Login berhasil. Data sedang tidak tersedia; halaman tetap dapat digunakan.',
        false
      );
    } finally {
      showLoader(false);
      showApp();
    }
  }

  function go(page) {
    if (!page) return;

    document
      .querySelectorAll(
        '.page, [data-page-content]'
      )
      .forEach(el => {
        el.classList.add('hidden');
      });

    const target =
      $(`page-${page}`) ||
      $(`${page}Page`) ||
      $(`page${page}`);

    if (target) {
      target.classList.remove('hidden');
    }

    document
      .querySelectorAll('.nav-item')
      .forEach(btn => {
        btn.classList.toggle(
          'active',
          btn.dataset.page === page
        );
      });

    document
      .querySelectorAll('[data-page-title]')
      .forEach(el => {
        el.textContent = page;
      });
  }

  function closeModal() {
    $('modal')?.classList.add('hidden');

    const content =
      $('modalContent');

    if (content) {
      content.innerHTML = '';
    }
  }

  function openModal(title, html) {
    const modal = $('modal');

    if (!modal) return;

    const titleEl =
      $('modalTitle');

    const content =
      $('modalContent');

    if (titleEl) {
      titleEl.textContent =
        title;
    }

    if (content) {
      content.innerHTML =
        html;
    }

    modal.classList.remove(
      'hidden'
    );
  }

  function transactionModal() {
    openModal(
      'Transaksi Kas',
      `
        <form id="transactionForm" class="form-grid">

          <label>
            Tanggal
            <input
              id="transactionDate"
              type="date"
              value="${new Date()
                .toISOString()
                .slice(0, 10)}"
              required
            >
          </label>

          <label>
            Jenis
            <select id="transactionType" required>
              <option value="income">
                Uang Masuk
              </option>
              <option value="expense">
                Uang Keluar
              </option>
            </select>
          </label>

          <label class="full">
            Keterangan
            <input
              id="transactionDescription"
              type="text"
              placeholder="Contoh: Pembayaran supplier"
              required
            >
          </label>

          <label>
            Nominal
            <input
              id="transactionAmount"
              type="number"
              min="0"
              step="1"
              required
            >
          </label>

          <label>
            Metode
            <select id="transactionMethod">
              <option value="cash">
                Kas
              </option>
              <option value="bank">
                Bank
              </option>
            </select>
          </label>

          <div class="full modal-actions">
            <button
              type="button"
              class="secondary-btn"
              onclick="KARSA.closeModal()"
            >
              Batal
            </button>

            <button
              type="submit"
              class="gold-btn"
            >
              Simpan Transaksi
            </button>
          </div>

        </form>
      `
    );

    $('transactionForm')
      ?.addEventListener(
        'submit',
        async e => {
          e.preventDefault();

          try {
            await createCashTransaction();
          } catch (error) {
            toast(
              errorText(error),
              false
            );
          }
        }
      );
  }

  async function createCashTransaction() {
    if (!sb || !user) {
      throw new Error(
        'Session belum tersedia.'
      );
    }

    const transactionDate =
      $('transactionDate')
        ?.value;

    const type =
      $('transactionType')
        ?.value;

    const description =
      $('transactionDescription')
        ?.value.trim();

    const amount = Number(
      $('transactionAmount')
        ?.value || 0
    );

    const method =
      $('transactionMethod')
        ?.value ||
      'cash';

    if (!description) {
      throw new Error(
        'Keterangan wajib diisi.'
      );
    }

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      throw new Error(
        'Nominal harus lebih besar dari 0.'
      );
    }

    const prefix =
      type === 'income'
        ? 'INC'
        : 'EXP';

    const count =
      state.transactions.filter(
        x =>
          String(
            x.transaction_no || ''
          ).startsWith(
            `${prefix}-`
          )
      ).length + 1;

    const transactionNo =
      `${prefix}-${String(
        count
      ).padStart(4, '0')}`;

    const payload = {
      transaction_no:
        transactionNo,

      transaction_date:
        transactionDate,

      type,

      description,

      amount,

      payment_method:
        method,

      created_by:
        user.id
    };

    const {
      data,
      error
    } = await withTimeout(
      sb
        .from('transactions')
        .insert(payload)
        .select()
        .single(),
      12000,
      'Menyimpan transaksi'
    );

    if (error) throw error;

    /*
     * Jika RPC jurnal tersedia, buat jurnal otomatis.
     * Jika belum tersedia, transaksi tetap tersimpan.
     */
    try {
      await createJournalFromCash(
        data
      );
    } catch (journalError) {
      console.warn(
        '[KARSA Finance] Jurnal otomatis gagal:',
        journalError
      );
    }

    closeModal();

    toast(
      `Transaksi ${transactionNo} berhasil disimpan.`
    );

    await refresh();
  }

  async function createJournalFromCash(
    transaction
  ) {
    if (!transaction) return;

    const amount =
      Number(
        transaction.amount || 0
      );

    if (
      !Number.isFinite(amount) ||
      amount <= 0
    ) {
      return;
    }

    const isIncome =
      String(
        transaction.type || ''
      ).toLowerCase() ===
      'income';

    /*
     * Coba RPC jika tersedia.
     * Tidak membuat aplikasi gagal apabila
     * database belum memiliki RPC tersebut.
     */
    const { error } =
      await withTimeout(
        sb.rpc(
          'post_cash_transaction',
          {
            p_transaction_id:
              transaction.id
          }
        ),
        12000,
        'Membuat jurnal'
      );

    if (error) {
      throw error;
    }
  }

  function saleModal() {
    openModal(
      'Penjualan',
      `
        <form id="saleForm" class="form-grid">

          <label>
            Tanggal
            <input
              id="saleDate"
              type="date"
              value="${new Date()
                .toISOString()
                .slice(0, 10)}"
              required
            >
          </label>

          <label>
            Pelanggan
            <input
              id="saleCustomer"
              type="text"
              placeholder="Nama pelanggan"
              required
            >
          </label>

          <label>
            Nomor Invoice
            <input
              id="saleInvoice"
              type="text"
              placeholder="SALE-0001"
            >
          </label>

          <label>
            Total
            <input
              id="saleTotal"
              type="number"
              min="0"
              step="1"
              required
            >
          </label>

          <div class="full modal-actions">

            <button
              type="button"
              class="secondary-btn"
              onclick="KARSA.closeModal()"
            >
              Batal
            </button>

            <button
              type="submit"
              class="gold-btn"
            >
              Simpan Penjualan
            </button>

          </div>

        </form>
      `
    );

    $('saleForm')
      ?.addEventListener(
        'submit',
        async e => {
          e.preventDefault();

          try {
            await createSale();
          } catch (error) {
            toast(
              errorText(error),
              false
            );
          }
        }
      );
  }

  async function createSale() {
    if (!sb || !user) {
      throw new Error(
        'Session belum tersedia.'
      );
    }

    const saleDate =
      $('saleDate')?.value;

    const customer =
      $('saleCustomer')
        ?.value.trim();

    const invoice =
      $('saleInvoice')
        ?.value.trim();

    const total = Number(
      $('saleTotal')?.value || 0
    );

    if (!customer) {
      throw new Error(
        'Nama pelanggan wajib diisi.'
      );
    }

    if (
      !Number.isFinite(total) ||
      total <= 0
    ) {
      throw new Error(
        'Total penjualan harus lebih besar dari 0.'
      );
    }

    const saleCount =
      state.sales.length + 1;

    const saleNo =
      invoice ||
      `SALE-${String(
        saleCount
      ).padStart(4, '0')}`;

    const payload = {
      sale_no: saleNo,
      invoice_no: saleNo,
      sale_date: saleDate,
      customer_name: customer,
      total_amount: total,
      amount: total,
      created_by: user.id
    };

    const {
      data,
      error
    } = await withTimeout(
      sb
        .from('sales')
        .insert(payload)
        .select()
        .single(),
      12000,
      'Menyimpan penjualan'
    );

    if (error) throw error;

    try {
      await withTimeout(
        sb.rpc(
          'post_sale',
          {
            p_sale_id:
              data.id
          }
        ),
        12000,
        'Membuat jurnal penjualan'
      );
    } catch (error) {
      console.warn(
        '[KARSA Finance] RPC post_sale tidak tersedia/gagal:',
        error
      );
    }

    closeModal();

    toast(
      `Penjualan ${saleNo} berhasil disimpan.`
    );

    await refresh();
  }

  function purchaseModal() {
    openModal(
      'Pembelian',
      `
        <form id="purchaseForm" class="form-grid">

          <label>
            Tanggal
            <input
              id="purchaseDate"
              type="date"
              value="${new Date()
                .toISOString()
                .slice(0, 10)}"
              required
            >
          </label>

          <label>
            Supplier
            <input
              id="purchaseSupplier"
              type="text"
              placeholder="Nama supplier"
              required
            >
          </label>

          <label>
            Nomor Invoice
            <input
              id="purchaseInvoice"
              type="text"
              placeholder="PUR-0001"
            >
          </label>

          <label>
            Total
            <input
              id="purchaseTotal"
              type="number"
              min="0"
              step="1"
              required
            >
          </label>

          <div class="full modal-actions">

            <button
              type="button"
              class="secondary-btn"
              onclick="KARSA.closeModal()"
            >
              Batal
            </button>

            <button
              type="submit"
              class="gold-btn"
            >
              Simpan Pembelian
            </button>

          </div>

        </form>
      `
    );

    $('purchaseForm')
      ?.addEventListener(
        'submit',
        async e => {
          e.preventDefault();

          try {
            await createPurchase();
          } catch (error) {
            toast(
              errorText(error),
              false
            );
          }
        }
      );
  }

  async function createPurchase() {
    if (!sb || !user) {
      throw new Error(
        'Session belum tersedia.'
      );
    }

    const purchaseDate =
      $('purchaseDate')?.value;

    const supplier =
      $('purchaseSupplier')
        ?.value.trim();

    const invoice =
      $('purchaseInvoice')
        ?.value.trim();

    const total = Number(
      $('purchaseTotal')
        ?.value || 0
    );

    if (!supplier) {
      throw new Error(
        'Nama supplier wajib diisi.'
      );
    }

    if (
      !Number.isFinite(total) ||
      total <= 0
    ) {
      throw new Error(
        'Total pembelian harus lebih besar dari 0.'
      );
    }

    const purchaseCount =
      state.purchases.length + 1;

    const purchaseNo =
      invoice ||
      `PUR-${String(
        purchaseCount
      ).padStart(4, '0')}`;

    const payload = {
      purchase_no:
        purchaseNo,

      invoice_no:
        purchaseNo,

      purchase_date:
        purchaseDate,

      supplier_name:
        supplier,

      total_amount:
        total,

      amount:
        total,

      created_by:
        user.id
    };

    const {
      data,
      error
    } = await withTimeout(
      sb
        .from('purchases')
        .insert(payload)
        .select()
        .single(),
      12000,
      'Menyimpan pembelian'
    );

    if (error) throw error;

    try {
      await withTimeout(
        sb.rpc(
          'post_purchase',
          {
            p_purchase_id:
              data.id
          }
        ),
        12000,
        'Membuat jurnal pembelian'
      );
    } catch (error) {
      console.warn(
        '[KARSA Finance] RPC post_purchase tidak tersedia/gagal:',
        error
      );
    }

    closeModal();

    toast(
      `Pembelian ${purchaseNo} berhasil disimpan.`
    );

    await refresh();
  }

  function productModal() {
    openModal(
      'Produk',
      `
        <form id="productForm" class="form-grid">

          <label>
            Nama Produk
            <input
              id="productName"
              type="text"
              required
            >
          </label>

          <label>
            SKU
            <input
              id="productSku"
              type="text"
            >
          </label>

          <label>
            Ukuran
            <input
              id="productSize"
              type="text"
              placeholder="S / M / L / XL"
            >
          </label>

          <label>
            Jenis Bahan
            <input
              id="productFabric"
              type="text"
            >
          </label>

          <label>
            Stok Awal
            <input
              id="productStock"
              type="number"
              min="0"
              step="1"
              value="0"
            >
          </label>

          <label>
            Minimum Stok
            <input
              id="productReorder"
              type="number"
              min="0"
              step="1"
              value="0"
            >
          </label>

          <div class="full modal-actions">

            <button
              type="button"
              class="secondary-btn"
              onclick="KARSA.closeModal()"
            >
              Batal
            </button>

            <button
              type="submit"
              class="gold-btn"
            >
              Simpan Produk
            </button>

          </div>

        </form>
      `
    );

    $('productForm')
      ?.addEventListener(
        'submit',
        async e => {
          e.preventDefault();

          try {
            await createProduct();
          } catch (error) {
            toast(
              errorText(error),
              false
            );
          }
        }
      );
  }

  async function createProduct() {
    if (!sb || !user) {
      throw new Error(
        'Session belum tersedia.'
      );
    }

    const name =
      $('productName')
        ?.value.trim();

    const sku =
      $('productSku')
        ?.value.trim();

    const size =
      $('productSize')
        ?.value.trim();

    const fabric =
      $('productFabric')
        ?.value.trim();

    const stock =
      Number(
        $('productStock')
          ?.value || 0
      );

    const reorder =
      Number(
        $('productReorder')
          ?.value || 0
      );

    if (!name) {
      throw new Error(
        'Nama produk wajib diisi.'
      );
    }

    const payload = {
      name,
      sku: sku || null,
      size: size || null,
      fabric_type:
        fabric || null,
      stock_qty:
        stock,
      reorder_level:
        reorder,
      active: true,
      created_by:
        user.id
    };

    const {
      error
    } = await withTimeout(
      sb
        .from('products')
        .insert(payload),
      12000,
      'Menyimpan produk'
    );

    if (error) throw error;

    closeModal();

    toast(
      'Produk berhasil disimpan.'
    );

    await refresh();
  }

  function exportWorkbook() {
    if (!window.XLSX) {
      throw new Error(
        'Library Excel belum dimuat.'
      );
    }

    const wb =
      XLSX.utils.book_new();

    const datasets = [
      ['Transaksi', state.transactions],
      ['Penjualan', state.sales],
      ['Pembelian', state.purchases],
      ['Piutang', state.ar],
      ['Hutang', state.ap],
      ['Pembayaran Piutang', state.arPayments],
      ['Pembayaran Hutang', state.apPayments],
      ['Produk', state.products],
      ['HPP', state.hpp],
      ['Jurnal', state.journals],
      ['Detail Jurnal', state.journalLines],
      ['Akun', state.accounts],
      ['Kas Bank', state.cashAccounts],
      ['Komponen HPP', state.costComponents],
      ['Mutasi Stok', state.stockMovements]
    ];

    datasets.forEach(
      ([name, rows]) => {
        const clean =
          Array.isArray(rows)
            ? rows
            : [];

        const ws =
          XLSX.utils.json_to_sheet(
            clean
          );

        XLSX.utils.book_append_sheet(
          wb,
          ws,
          name.slice(0, 31)
        );
      }
    );

    XLSX.writeFile(
      wb,
      `KARSA-Finance-${new Date()
        .toISOString()
        .slice(0, 10)}.xlsx`
    );

    toast(
      'File Excel berhasil dibuat.'
    );
  }

  function downloadCSV(type = 'transactions') {
    const map = {
      transactions:
        state.transactions,
      sales:
        state.sales,
      purchases:
        state.purchases,
      ar:
        state.ar,
      ap:
        state.ap,
      products:
        state.products,
      journals:
        state.journals,
      journalLines:
        state.journalLines
    };

    const rows =
      map[type] || [];

    if (!rows.length) {
      toast(
        'Tidak ada data untuk diekspor.',
        false
      );
      return;
    }

    const headers =
      Object.keys(rows[0]);

    const csv = [
      headers.join(','),
      ...rows.map(row =>
        headers
          .map(header => {
            const value =
              row[header] ?? '';

            return `"${String(value)
              .replace(/"/g, '""')}"`
          })
          .join(',')
      )
    ].join('\n');

    const blob =
      new Blob(
        ['\ufeff' + csv],
        {
          type:
            'text/csv;charset=utf-8;'
        }
      );

    const url =
      URL.createObjectURL(blob);

    const a =
      document.createElement('a');

    a.href = url;

    a.download =
      `KARSA-${type}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`;

    document.body.appendChild(a);

    a.click();

    a.remove();

    URL.revokeObjectURL(url);

    toast(
      'CSV berhasil diekspor.'
    );
  }

  function exportData(type) {
    if (type === 'xlsx' || type === 'excel') {
      exportWorkbook();
      return;
    }

    if (type === 'csv') {
      downloadCSV(
        $('exportType')?.value ||
        'transactions'
      );
      return;
    }

    if (type === 'transactions') {
      downloadCSV('transactions');
      return;
    }

    if (type === 'sales') {
      downloadCSV('sales');
      return;
    }

    if (type === 'purchases') {
      downloadCSV('purchases');
      return;
    }

    if (type === 'ar') {
      downloadCSV('ar');
      return;
    }

    if (type === 'ap') {
      downloadCSV('ap');
      return;
    }

    if (type === 'products') {
      downloadCSV('products');
      return;
    }

    if (type === 'journals') {
      downloadCSV('journals');
      return;
    }

    exportWorkbook();
  }

  function bind() {
    $('loginForm')
      ?.addEventListener(
        'submit',
        async e => {
          e.preventDefault();

          try {
            await login();
          } catch (error) {
            authMessage(
              errorText(error),
              false
            );
          }
        }
      );

    $('logout')
      ?.addEventListener(
        'click',
        async () => {
          try {
            await logout();
          } catch (error) {
            toast(
              errorText(error),
              false
            );
          }
        }
      );

    $('closeModal')
      ?.addEventListener(
        'click',
        closeModal
      );

    $('modal')
      ?.addEventListener(
        'click',
        e => {
          if (
            e.target.id ===
            'modal'
          ) {
            closeModal();
          }
        }
      );

    $('quickBtn')
      ?.addEventListener(
        'click',
        transactionModal
      );

    $('heroAdd')
      ?.addEventListener(
        'click',
        transactionModal
      );

    $('cashAdd')
      ?.addEventListener(
        'click',
        transactionModal
      );

    $('trxAdd')
      ?.addEventListener(
        'click',
        transactionModal
      );

    $('saleAdd')
      ?.addEventListener(
        'click',
        saleModal
      );

    $('purchaseAdd')
      ?.addEventListener(
        'click',
        purchaseModal
      );

    $('productAdd')
      ?.addEventListener(
        'click',
        productModal
      );

    document
      .querySelectorAll(
        '.nav-item'
      )
      .forEach(button => {
        button.addEventListener(
          'click',
          () =>
            go(
              button.dataset.page
            )
        );
      });

    document
      .querySelectorAll(
        '[data-go]'
      )
      .forEach(button => {
        button.addEventListener(
          'click',
          () =>
            go(
              button.dataset.go
            )
        );
      });

    document
      .querySelectorAll(
        '[data-export]'
      )
      .forEach(button => {
        button.addEventListener(
          'click',
          () =>
            exportData(
              button.dataset
                .export
            )
        );
      });

    setInterval(() => {
      const clock =
        $('clock');

      if (clock) {
        clock.textContent =
          new Intl.DateTimeFormat(
            'id-ID',
            {
              dateStyle:
                'medium',
              timeStyle:
                'short'
            }
          ).format(
            new Date()
          );
      }
    }, 1000);
  }

  async function init() {
    bind();

    showLoader(true);

    setLoader(
      'Memeriksa konfigurasi…'
    );

    if (!configured()) {
      showLoader(false);
      showAuth();

      authMessage(
        'Supabase belum dikonfigurasi. Buka config.js lalu isi Project URL dan Publishable/anon public key.'
      );

      return;
    }

    if (
      !window.supabase?.createClient
    ) {
      showLoader(false);
      showAuth();

      authMessage(
        'Library Supabase gagal dimuat. Pastikan koneksi internet aktif lalu refresh halaman.'
      );

      return;
    }

    try {
      sb =
        window.supabase.createClient(
          SB_URL,
          SB_KEY,
          {
            auth: {
              persistSession:
                true,

              autoRefreshToken:
                true,

              detectSessionInUrl:
                true
            }
          }
        );

      sb.auth.onAuthStateChange(
        (_event, session) => {
          setTimeout(() => {
            handleSession(
              session
            ).catch(error => {
              console.error(
                '[KARSA Finance] Session handler error:',
                error
              );

              showLoader(false);

              if (
                session?.user
              ) {
                showApp();
              } else {
                showAuth();
              }

              toast(
                errorText(error),
                false
              );
            });
          }, 0);
        }
      );

      setLoader(
        'Memeriksa session…'
      );

      const {
        data,
        error
      } = await withTimeout(
        sb.auth.getSession(),
        10000,
        'Pemeriksaan session'
      );

      if (error) {
        throw error;
      }

      if (data?.session) {
        await handleSession(
          data.session
        );
      } else {
        user = null;

        showLoader(false);
        showAuth();
      }
    } catch (error) {
      console.error(
        '[KARSA Finance] Init error:',
        error
      );

      showLoader(false);
      showAuth();

      authMessage(
        errorText(error),
        false
      );
    }
  }

  window.KARSA = {
    state,
    refresh,
    login,
    logout,
    downloadCSV,
    exportWorkbook,
    exportData,
    money,
    number,
    closeModal,
    go
  };

  document.addEventListener(
    'DOMContentLoaded',
    init
  );
})();
