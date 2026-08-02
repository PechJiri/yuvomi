/**
 * Modul: Budget-Tracker – Konten (#495)
 * Zweck: getrennte Konten mit Startsaldo, laufendem/prognostiziertem Saldo, Nettovermögen.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, num, color as validateColor, collectErrors, MAX_SHORT } from '../../middleware/validate.js';
import { budgetFilter, listAccounts, ACCOUNT_TYPE_KEYS, nextAccountSortOrder, cents } from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

function invoiceMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : null;
}

function statementFor(account, month, req) {
  const [year, monthNumber] = month.split('-').map(Number);
  const nextMonth = `${monthNumber === 12 ? year + 1 : year}-${String(monthNumber === 12 ? 1 : monthNumber + 1).padStart(2, '0')}`;
  const filter = budgetFilter(req, 'b', { scoped: true });
  const entries = db.get().prepare(`
    SELECT b.* FROM budget_entries b
    WHERE b.account_id = ? AND b.date >= ? AND b.date < ?${filter.clause}
    ORDER BY b.date DESC, b.created_at DESC
  `).all(account.id, `${month}-01`, `${nextMonth}-01`, ...filter.params);
  let saved = db.get().prepare(`
    SELECT status, amount, paid_amount, closed_at, paid_at FROM budget_account_invoices
    WHERE account_id = ? AND statement_month = ?
  `).get(account.id, month);
  const liveAmount = cents(entries.reduce((sum, entry) => sum - Number(entry.amount || 0), 0));
  const today = new Date();
  const isCurrentMonth = month === `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  if (!saved && entries.length === 0 && isCurrentMonth && account.closing_day && today.getDate() >= account.closing_day) {
    db.get().prepare(`
      INSERT INTO budget_account_invoices (account_id, statement_month, status, amount, closed_at, created_by)
      VALUES (?, ?, 'closed', 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
    `).run(account.id, month, req.authUserId || req.session.userId);
    saved = db.get().prepare(`SELECT status, amount, paid_amount, closed_at, paid_at FROM budget_account_invoices WHERE account_id = ? AND statement_month = ?`).get(account.id, month);
  }
  const payments = db.get().prepare(`
    SELECT id, amount, created_at FROM budget_account_invoice_payments
    WHERE account_id = ? AND statement_month = ? AND reversed_at IS NULL ORDER BY created_at DESC
  `).all(account.id, month);
  return {
    account_id: account.id,
    statement_month: month,
    status: saved?.status || 'open',
    amount: saved ? Number(saved.amount) : liveAmount,
    paid_amount: Number(saved?.paid_amount || 0),
    closed_at: saved?.closed_at || null,
    paid_at: saved?.paid_at || null,
    payments,
    entries,
  };
}

/** One monthly statement per credit card. */
router.get('/accounts/invoices', (req, res) => {
  try {
    const month = invoiceMonth(req.query.month);
    if (!month) return res.status(400).json({ error: 'Invalid statement month.', code: 400 });
    const accounts = listAccounts(false, budgetFilter(req, 'e', { scoped: true }))
      .filter((account) => account.type === 'credit');
    res.json({ data: accounts.map((account) => ({ account, ...statementFor(account, month, req) })) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.get('/accounts/:id/invoices/history', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const account = listAccounts(false, budgetFilter(req, 'e', { scoped: true }))
      .find((item) => item.id === id && item.type === 'credit');
    if (!account) return res.status(404).json({ error: 'Credit-card account not found.', code: 404 });
    const filter = budgetFilter(req, 'b', { scoped: true });
    const months = db.get().prepare(`
      SELECT statement_month AS month FROM budget_account_invoices WHERE account_id = ?
      UNION
      SELECT substr(b.date, 1, 7) AS month FROM budget_entries b WHERE b.account_id = ?${filter.clause}
      ORDER BY month DESC
    `).all(id, id, ...filter.params).map((row) => row.month);
    res.json({ data: months.map((month) => statementFor(account, month, req)) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/accounts/:id/invoice/:action', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const month = invoiceMonth(req.body.month);
    const action = req.params.action;
    if (!month || !['close', 'pay'].includes(action)) return res.status(400).json({ error: 'Invalid invoice action.', code: 400 });
    const account = listAccounts(false, budgetFilter(req, 'e', { scoped: true }))
      .find((item) => item.id === id && item.type === 'credit');
    if (!account) return res.status(404).json({ error: 'Credit-card account not found.', code: 404 });

    let current = statementFor(account, month, req);
    if (action === 'close') {
      if (current.status !== 'open') return res.status(409).json({ error: 'Invoice is already closed.', code: 409 });
      db.get().prepare(`
        INSERT INTO budget_account_invoices (account_id, statement_month, status, amount, closed_at, created_by)
        VALUES (?, ?, 'closed', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
        ON CONFLICT(account_id, statement_month) DO UPDATE SET
          status = 'closed', amount = excluded.amount, paid_amount = 0,
          closed_at = excluded.closed_at, paid_at = NULL, created_by = excluded.created_by
      `).run(id, month, current.amount, req.authUserId || req.session.userId);
    } else {
      if (current.status === 'open') {
        db.get().prepare(`
          INSERT INTO budget_account_invoices (account_id, statement_month, status, amount, closed_at, created_by)
          VALUES (?, ?, 'closed', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?)
          ON CONFLICT(account_id, statement_month) DO UPDATE SET
            status = 'closed', amount = excluded.amount, paid_amount = 0,
            closed_at = excluded.closed_at, paid_at = NULL, created_by = excluded.created_by
        `).run(id, month, current.amount, req.authUserId || req.session.userId);
        current = statementFor(account, month, req);
      }
      if (!['closed', 'partial'].includes(current.status)) return res.status(409).json({ error: 'Invoice must be closed before payment.', code: 409 });
      const remainingAmount = cents(current.amount - current.paid_amount);
      const paymentAmount = cents(req.body.payment_amount ?? remainingAmount);
      if (!Number.isFinite(paymentAmount) || paymentAmount <= 0 || paymentAmount - remainingAmount > 0.005) return res.status(400).json({ error: 'Invalid payment amount.', code: 400 });
      const paymentAccountId = parseInt(req.body.payment_account_id, 10);
      const paymentAccount = listAccounts(false, budgetFilter(req, 'e', { scoped: true }))
        .find((item) => item.id === paymentAccountId && item.id !== id && item.type !== 'credit');
      if (!paymentAccount) return res.status(400).json({ error: 'A valid payment account is required.', code: 400 });
      const me = req.authUserId || req.session.userId;
      const paymentDate = new Date().toISOString().slice(0, 10);
      db.get().transaction(() => {
        const debitEntry = db.get().prepare(`
          INSERT INTO budget_entries (title, amount, category, date, account_id, created_by, owner_id, visibility)
          VALUES (?, ?, 'gifts_transfers', ?, ?, ?, ?, 'shared')
        `).run(`Invoice payment: ${account.name}`, -paymentAmount, paymentDate, paymentAccount.id, me, me);
        const creditEntry = db.get().prepare(`
          INSERT INTO budget_entries (title, amount, category, date, account_id, created_by, owner_id, visibility)
          VALUES (?, ?, 'gifts_transfers', ?, ?, ?, ?, 'shared')
        `).run(`Invoice payment: ${account.name}`, paymentAmount, paymentDate, account.id, me, me);
        db.get().prepare(`
          INSERT INTO budget_account_invoice_payments (account_id, statement_month, amount, debit_entry_id, credit_entry_id, created_by)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(id, month, paymentAmount, debitEntry.lastInsertRowid, creditEntry.lastInsertRowid, me);
        db.get().prepare(`
          UPDATE budget_account_invoices
          SET paid_amount = paid_amount + ?,
              status = CASE WHEN paid_amount + ? >= amount - 0.005 THEN 'paid' ELSE 'partial' END,
              paid_at = CASE WHEN paid_amount + ? >= amount - 0.005 THEN strftime('%Y-%m-%dT%H:%M:%SZ', 'now') ELSE NULL END
          WHERE account_id = ? AND statement_month = ?
        `).run(paymentAmount, paymentAmount, paymentAmount, id, month);
      })();
    }
    res.json({ data: statementFor(account, month, req) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/accounts/:id/invoice/payments/:paymentId/reverse', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const paymentId = parseInt(req.params.paymentId, 10);
    const month = invoiceMonth(req.body.month);
    if (!month) return res.status(400).json({ error: 'Invalid statement month.', code: 400 });
    const account = listAccounts(false, budgetFilter(req, 'e', { scoped: true })).find((item) => item.id === id && item.type === 'credit');
    if (!account) return res.status(404).json({ error: 'Credit-card account not found.', code: 404 });
    const payment = db.get().prepare(`SELECT * FROM budget_account_invoice_payments WHERE id = ? AND account_id = ? AND statement_month = ? AND reversed_at IS NULL`).get(paymentId, id, month);
    if (!payment) return res.status(404).json({ error: 'Invoice payment not found.', code: 404 });
    db.get().transaction(() => {
      if (payment.debit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.debit_entry_id);
      if (payment.credit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.credit_entry_id);
      db.get().prepare(`UPDATE budget_account_invoice_payments SET reversed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(payment.id);
      db.get().prepare(`
        UPDATE budget_account_invoices
        SET paid_amount = MAX(0, paid_amount - ?),
            status = CASE WHEN paid_amount - ? <= 0.005 THEN 'closed' WHEN paid_amount - ? >= amount - 0.005 THEN 'paid' ELSE 'partial' END,
            paid_at = CASE WHEN paid_amount - ? >= amount - 0.005 THEN paid_at ELSE NULL END
        WHERE account_id = ? AND statement_month = ?
      `).run(payment.amount, payment.amount, payment.amount, payment.amount, id, month);
    })();
    res.json({ data: statementFor(account, month, req) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.post('/accounts/:id/invoice/reopen/paid', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const month = invoiceMonth(req.body.month);
    if (!month) return res.status(400).json({ error: 'Invalid statement month.', code: 400 });
    const account = listAccounts(false, budgetFilter(req, 'e', { scoped: true })).find((item) => item.id === id && item.type === 'credit');
    if (!account) return res.status(404).json({ error: 'Credit-card account not found.', code: 404 });
    const current = statementFor(account, month, req);
    if (current.status !== 'paid') return res.status(409).json({ error: 'Only paid invoices can be reopened.', code: 409 });
    const payments = db.get().prepare(`SELECT * FROM budget_account_invoice_payments WHERE account_id = ? AND statement_month = ? AND reversed_at IS NULL`).all(id, month);
    db.get().transaction(() => {
      for (const payment of payments) {
        if (payment.debit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.debit_entry_id);
        if (payment.credit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(payment.credit_entry_id);
        db.get().prepare(`UPDATE budget_account_invoice_payments SET reversed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(payment.id);
      }
      db.get().prepare(`UPDATE budget_account_invoices SET status = 'open', paid_amount = 0, paid_at = NULL WHERE account_id = ? AND statement_month = ?`).run(id, month);
    })();
    res.json({ data: statementFor(account, month, req) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/budget/accounts
 * Listet Konten mit Startsaldo und laufendem Saldo; zusätzlich das Gesamt-Nettovermögen.
 * Query: ?include_archived=1  (default: nur aktive Konten)
 * Response: { data: { accounts: [], net_worth } }
 */
router.get('/accounts', (req, res) => {
  try {
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const accounts = listAccounts(includeArchived, budgetFilter(req, 'e', { scoped: false }));
    const netWorth = cents(accounts
      .filter((a) => !a.archived)
      .reduce((sum, a) => sum + a.current_balance, 0));
    res.json({ data: { accounts, net_worth: netWorth } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * POST /api/v1/budget/accounts
 * Neues Konto anlegen.
 * Body: { name, type?, starting_balance?, currency?, color? }
 * Response: { data: Account }
 */
router.post('/accounts', (req, res) => {
  try {
    const vName    = str(req.body.name, 'Name', { max: MAX_SHORT });
    const vType    = oneOf(req.body.type || 'checking', ACCOUNT_TYPE_KEYS, 'Kontotyp');
    const vBalance = num(req.body.starting_balance ?? 0, 'Startsaldo', { required: false });
    const vColor   = validateColor(req.body.color, 'Farbe', { allowTokens: true });
    const vBank    = req.body.credit_bank === undefined ? { value: null } : str(req.body.credit_bank, 'Bank', { max: MAX_SHORT, required: false });
    const vLimit   = req.body.credit_limit === undefined ? { value: null } : num(req.body.credit_limit, 'Kreditlimit', { required: false });
    const vClosing = req.body.closing_day === undefined ? { value: null } : num(req.body.closing_day, 'Schlusselungstag', { required: false });
    const vDue     = req.body.due_day === undefined ? { value: null } : num(req.body.due_day, 'Fälligkeitstag', { required: false });
    const errors   = collectErrors([vName, vType, vBalance, vColor, vBank, vLimit, vClosing, vDue]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null;
    const color    = vColor.value;
    const creditBank = vBank.value === null || vBank.value === '' ? null : String(vBank.value).trim();
    const creditLimit = vLimit.value == null ? null : cents(vLimit.value);
    const closingDay = vClosing.value == null ? null : Math.trunc(Number(vClosing.value));
    const dueDay = vDue.value == null ? null : Math.trunc(Number(vDue.value));

    if (creditLimit !== null && creditLimit < 0) return res.status(400).json({ error: 'Kreditlimit darf nicht negativ sein.', code: 400 });
    if (closingDay !== null && (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31)) return res.status(400).json({ error: 'Schlusselungstag muss zwischen 1 und 31 liegen.', code: 400 });
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) return res.status(400).json({ error: 'Fälligkeitstag muss zwischen 1 und 31 liegen.', code: 400 });

    const result = db.get().prepare(`
      INSERT INTO budget_accounts (
        name, type, starting_balance, currency, color, sort_order, created_by,
        credit_bank, credit_limit, closing_day, due_day
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      vName.value, vType.value, cents(vBalance.value ?? 0),
      currency, color, nextAccountSortOrder(),
      req.authUserId || req.session.userId,
      creditBank, creditLimit, closingDay, dueDay
    );

    const account = listAccounts(true, budgetFilter(req, 'e', { scoped: false })).find((a) => a.id === Number(result.lastInsertRowid));
    res.status(201).json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/accounts/:id
 * Konto aktualisieren (Name, Typ, Startsaldo, Währung, Farbe, Archiv-Status).
 * Response: { data: Account }
 */
router.put('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT * FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const checks = [];
    if (req.body.name !== undefined) checks.push(str(req.body.name, 'Name', { max: MAX_SHORT }));
    if (req.body.type !== undefined) checks.push(oneOf(req.body.type, ACCOUNT_TYPE_KEYS, 'Kontotyp'));
    if (req.body.starting_balance !== undefined) checks.push(num(req.body.starting_balance, 'Startsaldo'));
    if (req.body.color !== undefined) checks.push(validateColor(req.body.color, 'Farbe', { allowTokens: true }));
    if (req.body.credit_bank !== undefined) checks.push(str(req.body.credit_bank, 'Bank', { max: MAX_SHORT, required: false }));
    if (req.body.credit_limit !== undefined) checks.push(num(req.body.credit_limit, 'Kreditlimit', { required: false }));
    if (req.body.closing_day !== undefined) checks.push(num(req.body.closing_day, 'Schlusselungstag', { required: false }));
    if (req.body.due_day !== undefined) checks.push(num(req.body.due_day, 'Fälligkeitstag', { required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const currency = req.body.currency !== undefined
      ? (req.body.currency ? str(req.body.currency, 'Währung', { max: 8 }).value : null)
      : existing.currency;
    const color = req.body.color !== undefined
      ? validateColor(req.body.color, 'Farbe', { allowTokens: true }).value
      : existing.color;
    const archived = req.body.archived !== undefined ? (req.body.archived ? 1 : 0) : existing.archived;
    const creditBank = req.body.credit_bank !== undefined
      ? (req.body.credit_bank === '' || req.body.credit_bank === null ? null : String(req.body.credit_bank).trim())
      : existing.credit_bank;
    const creditLimit = req.body.credit_limit !== undefined
      ? (req.body.credit_limit === '' || req.body.credit_limit === null ? null : cents(req.body.credit_limit))
      : existing.credit_limit;
    const closingDay = req.body.closing_day !== undefined
      ? (req.body.closing_day === '' || req.body.closing_day === null ? null : Math.trunc(Number(req.body.closing_day)))
      : existing.closing_day;
    const dueDay = req.body.due_day !== undefined
      ? (req.body.due_day === '' || req.body.due_day === null ? null : Math.trunc(Number(req.body.due_day)))
      : existing.due_day;

    if (creditLimit !== null && creditLimit < 0) return res.status(400).json({ error: 'Kreditlimit darf nicht negativ sein.', code: 400 });
    if (closingDay !== null && (!Number.isInteger(closingDay) || closingDay < 1 || closingDay > 31)) return res.status(400).json({ error: 'Schlusselungstag muss zwischen 1 und 31 liegen.', code: 400 });
    if (dueDay !== null && (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31)) return res.status(400).json({ error: 'Fälligkeitstag muss zwischen 1 und 31 liegen.', code: 400 });

    db.get().prepare(`
      UPDATE budget_accounts
      SET name             = COALESCE(?, name),
          type             = COALESCE(?, type),
          starting_balance = COALESCE(?, starting_balance),
          currency         = ?,
          color            = ?,
          archived         = ?,
          credit_bank      = ?,
          credit_limit     = ?,
          closing_day      = ?,
          due_day          = ?
      WHERE id = ?
    `).run(
      req.body.name !== undefined ? String(req.body.name).trim() : null,
      req.body.type !== undefined ? req.body.type : null,
      req.body.starting_balance !== undefined ? cents(req.body.starting_balance) : null,
      currency, color, archived,
      creditBank, creditLimit, closingDay, dueDay, id
    );

    const account = listAccounts(true, budgetFilter(req, 'e', { scoped: false })).find((a) => a.id === id);
    res.json({ data: account });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/accounts/:id
 * Konto löschen. Zugeordnete Einträge bleiben erhalten (account_id wird geleert).
 * Response: 204 No Content
 */
router.delete('/accounts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const existing = db.get().prepare('SELECT id FROM budget_accounts WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Account not found', code: 404 });

    const tx = db.get().transaction(() => {
      // Zuordnung explizit leeren (unabhängig vom FK-Pragma), Einträge bleiben bestehen.
      db.get().prepare('UPDATE budget_entries SET account_id = NULL WHERE account_id = ?').run(id);
      db.get().prepare('DELETE FROM budget_accounts WHERE id = ?').run(id);
    });
    tx();

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
