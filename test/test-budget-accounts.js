/**
 * Modul: Budget-Konten (#495)
 * Zweck: CRUD für Konten, laufender Saldo (Startsaldo + zugeordnete Einträge),
 *        Nettovermögen, account_id-Verdrahtung (POST/PUT/Filter) und die
 *        Invariante beim Löschen: Einträge bleiben erhalten, account_id → NULL.
 * Ausführen: npm run test:budget-accounts
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import Database from 'better-sqlite3-multiple-ciphers';
import express from 'express';

process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'budget-accounts-test-secret';

const { MIGRATIONS, get, _setTestDatabase } = await import('../server/db.js');
const { default: budgetRouter } = await import('../server/routes/budget.js');

const moduleDatabase = get();
const suiteDatabase = buildMigratedDatabase(MIGRATIONS);
_setTestDatabase(suiteDatabase);
moduleDatabase.close();

const ADMIN_ID = seedUser();
// Eine garantiert gültige Kategorie je Typ ermitteln (Migrationen seeden Standardkategorien).
const EXPENSE_CAT = pickCategory('expense');
const INCOME_CAT = pickCategory('income');

test.after(() => suiteDatabase.close());

function applyMigration(db, migration) {
  if (typeof migration.up === 'function') migration.up(db);
  else db.exec(migration.up);
  if (typeof migration.afterUp === 'function') migration.afterUp(db);
  db.prepare('INSERT INTO schema_migrations (version, description) VALUES (?, ?)')
    .run(migration.version, migration.description);
}

function buildMigratedDatabase(migrations) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )
  `);
  for (const migration of migrations) applyMigration(db, migration);
  return db;
}

function seedUser() {
  const info = suiteDatabase.prepare(`
    INSERT INTO users (username, display_name, password_hash, role)
    VALUES ('admin', 'Admin', 'x', 'admin')
  `).run();
  return Number(info.lastInsertRowid);
}

function pickCategory(type) {
  const row = suiteDatabase.prepare(
    'SELECT key FROM budget_categories WHERE type = ? ORDER BY sort_order ASC LIMIT 1'
  ).get(type);
  assert.ok(row, `Standardkategorie für ${type} muss durch Migrationen existieren`);
  return row.key;
}

function createHarness({ userId = ADMIN_ID, role = 'admin' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUserId = userId;
    req.authRole = role;
    req.session = { userId, role };
    next();
  });
  app.use('/api/v1/budget', budgetRouter);
  const server = http.createServer(app);
  return {
    async call(method, pathname, body) {
      if (!server.listening) {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      }
      const base = `http://127.0.0.1:${server.address().port}/api/v1/budget`;
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null };
    },
    close() {
      return new Promise((resolve) => (server.listening ? server.close(resolve) : resolve()));
    },
  };
}

function cleanup() {
  suiteDatabase.exec('DELETE FROM budget_entries; DELETE FROM budget_accounts;');
}

const PAST = '2020-06-15';        // zählt zum aktuellen Saldo (date <= heute)
const FUTURE = '2999-01-01';      // nur im projizierten Saldo

test('POST /accounts legt Konto an; Saldo = Startsaldo ohne Einträge', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '/accounts', { name: 'Girokonto', type: 'checking', starting_balance: 1000 });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.name, 'Girokonto');
    assert.equal(res.body.data.type, 'checking');
    assert.equal(res.body.data.starting_balance, 1000);
    assert.equal(res.body.data.current_balance, 1000);
    assert.equal(res.body.data.projected_balance, 1000);
  } finally { await h.close(); }
});

test('laufender Saldo = Startsaldo + zugeordnete Einträge bis heute', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 100 })).body.data;
    // Einkommen +50 (heute-vergangen), Ausgabe -30 (vergangen), +200 (Zukunft, nur projiziert)
    await h.call('POST', '', { title: 'Lohn', amount: 50, category: INCOME_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Kauf', amount: -30, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Zukunft', amount: 200, category: INCOME_CAT, date: FUTURE, account_id: acc.id });

    const list = (await h.call('GET', '/accounts')).body.data;
    const a = list.accounts.find((x) => x.id === acc.id);
    assert.equal(a.current_balance, 120);        // 100 + 50 - 30
    assert.equal(a.projected_balance, 320);      // + 200 Zukunft
    assert.equal(list.net_worth, 120);           // Nettovermögen = aktueller Saldo
  } finally { await h.close(); }
});

test('Nettovermögen summiert nur aktive Konten', async () => {
  cleanup();
  const h = createHarness();
  try {
    const a = (await h.call('POST', '/accounts', { name: 'A', starting_balance: 100 })).body.data;
    const b = (await h.call('POST', '/accounts', { name: 'B', starting_balance: 250 })).body.data;
    await h.call('PUT', `/accounts/${b.id}`, { archived: true });

    const res = (await h.call('GET', '/accounts')).body.data;
    assert.equal(res.accounts.length, 1, 'archivierte Konten sind standardmäßig ausgeblendet');
    assert.equal(res.net_worth, 100);

    const all = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(all.accounts.length, 2);
    assert.equal(all.net_worth, 100, 'net_worth ignoriert archivierte auch bei include_archived');
    assert.ok(a && b);
  } finally { await h.close(); }
});

test('account_id-Filter in GET /budget', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const month = PAST.slice(0, 7);
    await h.call('POST', '', { title: 'Mit Konto', amount: -10, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Ohne Konto', amount: -20, category: EXPENSE_CAT, date: PAST });

    const filtered = (await h.call('GET', `/?month=${month}&account_id=${acc.id}`)).body.data;
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].title, 'Mit Konto');
    assert.equal(filtered[0].account_id, acc.id);

    const all = (await h.call('GET', `/?month=${month}`)).body.data;
    assert.equal(all.length, 2);
  } finally { await h.close(); }
});

test('POST /budget: ungültige account_id → 400', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: 99999 });
    assert.equal(res.status, 400);
  } finally { await h.close(); }
});

test('PUT /budget/:id setzt und entfernt account_id', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST })).body.data;
    assert.equal(entry.account_id, null);

    const set = await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    assert.equal(set.body.data.account_id, acc.id);

    const cleared = await h.call('PUT', `/${entry.id}`, { account_id: null });
    assert.equal(cleared.body.data.account_id, null);

    // account_id nicht mitsenden ⇒ unverändert
    await h.call('PUT', `/${entry.id}`, { account_id: acc.id });
    const untouched = await h.call('PUT', `/${entry.id}`, { title: 'y' });
    assert.equal(untouched.body.data.account_id, acc.id);
  } finally { await h.close(); }
});

test('PUT /accounts/:id aktualisiert Felder', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', type: 'checking', starting_balance: 10 })).body.data;
    const res = await h.call('PUT', `/accounts/${acc.id}`, { name: 'Neu', type: 'savings', starting_balance: 500 });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.name, 'Neu');
    assert.equal(res.body.data.type, 'savings');
    assert.equal(res.body.data.starting_balance, 500);
    assert.equal(res.body.data.current_balance, 500);
  } finally { await h.close(); }
});

test('DELETE /accounts/:id: Einträge bleiben erhalten, account_id → NULL', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Konto', starting_balance: 0 })).body.data;
    const entry = (await h.call('POST', '', { title: 'x', amount: -5, category: EXPENSE_CAT, date: PAST, account_id: acc.id })).body.data;

    const del = await h.call('DELETE', `/accounts/${acc.id}`);
    assert.equal(del.status, 204);

    const row = suiteDatabase.prepare('SELECT * FROM budget_entries WHERE id = ?').get(entry.id);
    assert.ok(row, 'Eintrag muss erhalten bleiben');
    assert.equal(row.account_id, null, 'Zuordnung muss geleert sein');

    const list = (await h.call('GET', '/accounts')).body.data;
    assert.equal(list.accounts.length, 0);
  } finally { await h.close(); }
});

test('POST /accounts akzeptiert Kreditkarten-Metadaten und meldet verfügbare Limit-Reserve', async () => {
  cleanup();
  const h = createHarness();
  try {
    const res = await h.call('POST', '/accounts', {
      name: 'Visa',
      type: 'credit',
      starting_balance: -150,
      credit_bank: 'ING',
      credit_limit: 1000,
      closing_day: 25,
      due_day: 10,
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.credit_bank, 'ING');
    assert.equal(res.body.data.credit_limit, 1000);
    assert.equal(res.body.data.closing_day, 25);
    assert.equal(res.body.data.due_day, 10);
    assert.equal(res.body.data.current_balance, -150);
    assert.equal(res.body.data.available_limit, 850);

    const list = (await h.call('GET', '/accounts')).body.data;
    const card = list.accounts.find((a) => a.id === res.body.data.id);
    assert.ok(card);
    assert.equal(card.credit_bank, 'ING');
    assert.equal(card.available_limit, 850);
  } finally { await h.close(); }
});

test('PUT /accounts/:id aktualisiert Kreditkarten-Metadaten', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Kredit', type: 'credit', starting_balance: -50 })).body.data;
    const res = await h.call('PUT', `/accounts/${acc.id}`, {
      credit_bank: 'Sparkasse',
      credit_limit: 1500,
      closing_day: 28,
      due_day: 12,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.credit_bank, 'Sparkasse');
    assert.equal(res.body.data.credit_limit, 1500);
    assert.equal(res.body.data.closing_day, 28);
    assert.equal(res.body.data.due_day, 12);
  } finally { await h.close(); }
});

test('POST /budget akzeptiert Kreditkarten-Rechnungsmetadaten und schreibt sie persistiert', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', {
      name: 'Visa',
      type: 'credit',
      starting_balance: -100,
      credit_bank: 'ING',
      credit_limit: 1000,
      closing_day: 25,
      due_day: 10,
    })).body.data;

    const res = await h.call('POST', '', {
      title: 'Kartenzahlung',
      amount: -79.9,
      category: EXPENSE_CAT,
      date: PAST,
      account_id: acc.id,
      invoice_status: 'partial',
      invoice_installments: 6,
      invoice_paid_installments: 2,
      invoice_due_day: 11,
      invoice_closing_day: 26,
    });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.invoice_status, 'partial');
    assert.equal(res.body.data.invoice_installments, 6);
    assert.equal(res.body.data.invoice_paid_installments, 2);
    assert.equal(res.body.data.invoice_due_day, 11);
    assert.equal(res.body.data.invoice_closing_day, 26);

    const row = suiteDatabase.prepare('SELECT invoice_status, invoice_installments, invoice_paid_installments, invoice_due_day, invoice_closing_day FROM budget_entries WHERE id = ?').get(res.body.data.id);
    assert.ok(row);
    assert.equal(row.invoice_status, 'partial');
    assert.equal(row.invoice_installments, 6);
    assert.equal(row.invoice_paid_installments, 2);
    assert.equal(row.invoice_due_day, 11);
    assert.equal(row.invoice_closing_day, 26);
  } finally { await h.close(); }
});

test('POST /budget cria parcelas futuras para o cartão de crédito conforme o número de parcelas', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', {
      name: 'Visa',
      type: 'credit',
      starting_balance: 0,
      credit_bank: 'ING',
      credit_limit: 1000,
      closing_day: 25,
      due_day: 10,
    })).body.data;

    const res = await h.call('POST', '', {
      title: 'Compra parcelada',
      amount: -300,
      category: EXPENSE_CAT,
      date: PAST,
      account_id: acc.id,
      invoice_status: 'open',
      invoice_installments: 3,
      invoice_paid_installments: 1,
    });

    assert.equal(res.status, 201);

    const june = await h.call('GET', `/?month=2020-06`);
    const july = await h.call('GET', `/?month=2020-07`);
    const august = await h.call('GET', `/?month=2020-08`);

    assert.equal(june.body.data.length, 1, 'mês de criação recebe a primeira parcela');
    assert.equal(july.body.data.length, 1, 'mês seguinte recebe a segunda parcela');
    assert.equal(august.body.data.length, 1, 'terceiro mês recebe a última parcela');
    assert.equal(june.body.data[0].amount, -100);
    assert.equal(july.body.data[0].amount, -100);
    assert.equal(august.body.data[0].amount, -100);
  } finally { await h.close(); }
});

test('PUT /budget/:id/installments altera todas ou apenas as parcelas futuras', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Visa', type: 'credit' })).body.data;
    const paymentAccount = (await h.call('POST', '/accounts', { name: 'Conta', type: 'checking' })).body.data;
    const created = await h.call('POST', '', {
      title: 'Notebook', amount: -300, category: EXPENSE_CAT, date: PAST,
      account_id: acc.id, invoice_installments: 3,
    });
    const first = created.body.data;
    assert.ok(first.invoice_series_id, 'a compra parcelada recebe uma série');

    const future = await h.call('PUT', `/${first.id}/installments`, {
      scope: 'future', title: 'Notebook corrigido', amount: -110,
    });
    assert.equal(future.status, 200);
    const rowsAfterFuture = suiteDatabase.prepare(`
      SELECT title, amount FROM budget_entries WHERE invoice_series_id = ? ORDER BY date
    `).all(first.invoice_series_id);
    assert.deepEqual(rowsAfterFuture.map((row) => row.title), ['Notebook corrigido (1/3)', 'Notebook corrigido (2/3)', 'Notebook corrigido (3/3)']);
    assert.deepEqual(rowsAfterFuture.map((row) => row.amount), [-110, -110, -110]);

    const thisOnly = await h.call('PUT', `/${first.id}`, { title: 'Notebook corrigido (1/3)' });
    assert.equal(thisOnly.status, 200);
    assert.equal(thisOnly.body.data.title, 'Notebook corrigido (1/3)');

    const second = suiteDatabase.prepare(`
      SELECT id FROM budget_entries WHERE invoice_series_id = ? ORDER BY date LIMIT 1 OFFSET 1
    `).get(first.invoice_series_id);
    const all = await h.call('PUT', `/${second.id}/installments`, { scope: 'all', title: 'Notebook final' });
    assert.equal(all.status, 200);
    assert.equal(suiteDatabase.prepare(`SELECT COUNT(*) AS count FROM budget_entries WHERE invoice_series_id = ? AND title LIKE 'Notebook final%'`).get(first.invoice_series_id).count, 3);
  } finally { await h.close(); }
});

test('PUT /budget atualiza o status e as parcelas da fatura', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Visa', type: 'credit' })).body.data;
    const created = await h.call('POST', '', {
      title: 'Compra no cartão', amount: -120, category: EXPENSE_CAT, date: PAST,
      account_id: acc.id, invoice_status: 'open', invoice_installments: 3,
      invoice_paid_installments: 0,
    });
    assert.equal(created.status, 201);

    const paid = await h.call('PUT', `/${created.body.data.id}`, {
      invoice_status: 'partial', invoice_paid_installments: 1,
    });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.invoice_status, 'partial');
    assert.equal(paid.body.data.invoice_paid_installments, 1);

    const closed = await h.call('PUT', `/${created.body.data.id}`, {
      invoice_status: 'paid', invoice_paid_installments: 3,
    });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.invoice_status, 'paid');
    assert.equal(closed.body.data.invoice_paid_installments, 3);
  } finally { await h.close(); }
});

test('fatura mensal do cartão fecha e paga uma única vez por cartão', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Visa', type: 'credit' })).body.data;
    const paymentAccount = (await h.call('POST', '/accounts', { name: 'Conta', type: 'checking' })).body.data;
    await h.call('POST', '', { title: 'Mercado', amount: -80, category: EXPENSE_CAT, date: PAST, account_id: acc.id });
    await h.call('POST', '', { title: 'Estorno', amount: 10, category: INCOME_CAT, date: PAST, account_id: acc.id });
    const month = PAST.slice(0, 7);

    const listed = await h.call('GET', `/accounts/invoices?month=${month}`);
    assert.equal(listed.status, 200);
    assert.equal(listed.body.data[0].amount, 70);
    assert.equal(listed.body.data[0].status, 'open');

    const history = await h.call('GET', `/accounts/${acc.id}/invoices/history`);
    assert.equal(history.status, 200);
    assert.equal(history.body.data[0].statement_month, month);
    assert.equal(history.body.data[0].amount, 70);

    const closed = await h.call('POST', `/accounts/${acc.id}/invoice/close`, { month });
    assert.equal(closed.status, 200);
    assert.equal(closed.body.data.status, 'closed');
    assert.equal(closed.body.data.amount, 70);

    const partial = await h.call('POST', `/accounts/${acc.id}/invoice/pay`, { month, payment_account_id: paymentAccount.id, payment_amount: 20 });
    assert.equal(partial.status, 200);
    assert.equal(partial.body.data.status, 'partial');
    assert.equal(partial.body.data.paid_amount, 20);
    const paid = await h.call('POST', `/accounts/${acc.id}/invoice/pay`, { month, payment_account_id: paymentAccount.id, payment_amount: 50 });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.data.status, 'paid');
    assert.equal((await h.call('POST', `/accounts/${acc.id}/invoice/pay`, { month, payment_account_id: paymentAccount.id })).status, 409);

    const reversed = await h.call('POST', `/accounts/${acc.id}/invoice/payments/${paid.body.data.payments[0].id}/reverse`, { month });
    assert.equal(reversed.status, 200);
    assert.equal(reversed.body.data.status, 'partial');
  } finally { await h.close(); }
});

test('POST /accounts validiert Name und Typ', async () => {
  cleanup();
  const h = createHarness();
  try {
    assert.equal((await h.call('POST', '/accounts', { name: '', type: 'checking' })).status, 400);
    assert.equal((await h.call('POST', '/accounts', { name: 'X', type: 'bogus' })).status, 400);
    // Negativer Startsaldo ist erlaubt (z. B. Kreditkarte)
    const credit = await h.call('POST', '/accounts', { name: 'Karte', type: 'credit', starting_balance: -300 });
    assert.equal(credit.status, 201);
    assert.equal(credit.body.data.current_balance, -300);
  } finally { await h.close(); }
});

test('color: gültiger HEX wird gespeichert, ungültiger abgelehnt', async () => {
  cleanup();
  const h = createHarness();
  try {
    const ok = await h.call('POST', '/accounts', { name: 'Farbig', color: '#2563EB' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.data.color, '#2563EB');
    // #542: Der Konto-Farbpicker speichert theme-aware Serien-Tokens statt Hex -
    // die müssen akzeptiert werden, sonst schlägt "Konto anlegen" mit Farbwahl fehl.
    const token = await h.call('POST', '/accounts', { name: 'Token', color: 'var(--chart-series-2)' });
    assert.equal(token.status, 201);
    assert.equal(token.body.data.color, 'var(--chart-series-2)');
    // PUT akzeptiert das Token ebenfalls
    const tokenPut = await h.call('PUT', `/accounts/${ok.body.data.id}`, { color: 'var(--chart-series-5)' });
    assert.equal(tokenPut.body.data.color, 'var(--chart-series-5)');
    // Ungültige Farbe (kein #RRGGBB) → 400
    assert.equal((await h.call('POST', '/accounts', { name: 'X', color: 'blau' })).status, 400);
    // Beliebiger CSS-Ausdruck bleibt abgelehnt (Allowlist ist eng, kein style-Injection)
    assert.equal((await h.call('POST', '/accounts', { name: 'Y', color: 'var(--x); background:url(evil)' })).status, 400);
    assert.equal((await h.call('POST', '/accounts', { name: 'Z', color: 'var(--module-accent)' })).status, 400);
    // Farbe entfernen (leerer Wert → NULL)
    const cleared = await h.call('PUT', `/accounts/${ok.body.data.id}`, { color: '' });
    assert.equal(cleared.body.data.color, null);
  } finally { await h.close(); }
});

test('archived: PUT toggelt, include_archived steuert Sichtbarkeit, net_worth ignoriert archivierte', async () => {
  cleanup();
  const h = createHarness();
  try {
    const acc = (await h.call('POST', '/accounts', { name: 'Alt', starting_balance: 400 })).body.data;
    await h.call('PUT', `/accounts/${acc.id}`, { archived: true });

    const active = (await h.call('GET', '/accounts')).body.data;
    assert.equal(active.accounts.length, 0, 'archiviert ⇒ standardmäßig unsichtbar');
    assert.equal(active.net_worth, 0);

    const withArchived = (await h.call('GET', '/accounts?include_archived=1')).body.data;
    assert.equal(withArchived.accounts.length, 1);
    assert.equal(withArchived.accounts[0].archived, 1);

    // Wiederherstellen
    await h.call('PUT', `/accounts/${acc.id}`, { archived: false });
    const restored = (await h.call('GET', '/accounts')).body.data;
    assert.equal(restored.accounts.length, 1);
    assert.equal(restored.net_worth, 400);
  } finally { await h.close(); }
});
