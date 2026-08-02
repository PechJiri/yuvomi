/**
 * Modul: Budget-Tracker – Einträge
 * Zweck: Monatsübersicht, Eintragsliste, CSV-Export, Eintrags-CRUD + Serien.
 */

import express from 'express';
import { createLogger } from '../../logger.js';
import * as db from '../../db.js';
import { str, oneOf, date as validateDate, num, rrule, collectErrors, MAX_TITLE, MONTH_RE } from '../../middleware/validate.js';
import { normalizeBudgetVisibility } from '../../services/budget-visibility.js';
import { attachmentsFor, replaceAttachments, withAttachments } from './attachments.js';
import {
  budgetFilter, getBudgetMode, mayEdit,
  DATE_RE, thisMonthLocalKey, cents,
  generateRecurringInstances, RECURRENCE_INTERVAL_KEYS, effectiveMonthly,
  validCategoryKeys, defaultCategory, validateSubcategory, validateAccountRef,
  entryWithLoanMeta, refreshLoanStatus, fromBudgetAmount,
} from './helpers.js';

const log = createLogger('Budget');
const router = express.Router();

/**
 * GET /api/v1/budget/summary
 * Monatsübersicht: Einnahmen, Ausgaben, Saldo, Aufschlüsselung nach Kategorie.
 * Query: ?month=YYYY-MM  (default: aktueller Monat)
 * Response: { data: { month, income, expenses, balance, byCategory: [] } }
 */
router.get('/summary', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 7); // YYYY-MM
    const month = req.query.month || today;

    if (!MONTH_RE.test(month))
      return res.status(400).json({ error: 'month muss YYYY-MM sein', code: 400 });

    const from = `${month}-01`;
    const to   = `${month}-31`;

    // Sichtbarkeit/Scope (#476/#505): dieselbe Filterung wie die Eintragsliste,
    // damit Summen private Fremd-Einträge nicht mit einrechnen.
    const filter = budgetFilter(req, 'budget_entries');

    const totals = db.get().prepare(`
      SELECT
        SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
        SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
        SUM(amount) AS balance
      FROM budget_entries
      WHERE date BETWEEN ? AND ?${filter.clause}
    `).get(from, to, ...filter.params);

    const byCategory = db.get().prepare(`
      SELECT category,
             SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
             SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expenses,
             SUM(amount) AS total
      FROM budget_entries
      WHERE date BETWEEN ? AND ?${filter.clause}
      GROUP BY category
      ORDER BY ABS(SUM(amount)) DESC
    `).all(from, to, ...filter.params);

    res.json({
      data: {
        month,
        income:     totals.income   || 0,
        expenses:   totals.expenses || 0,
        balance:    totals.balance  || 0,
        byCategory,
      },
    });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * Leitet Zeitraum aus from/to oder month ab.
 * @param {object} query - { from?, to?, month? }
 * @returns {object} { from: YYYY-MM-DD, to: YYYY-MM-DD }
 */
export function resolveExportRange({ from, to, month }) {
  if (DATE_RE.test(from || '') && DATE_RE.test(to || '')) return { from, to };
  const m = MONTH_RE.test(month || '') ? month : thisMonthLocalKey();
  return { from: `${m}-01`, to: `${m}-31` };
}

/**
 * GET /api/v1/budget/export
 * Monatseinträge als CSV-Download.
 * Query: ?month=YYYY-MM or ?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Response: text/csv
 */
router.get('/export', (req, res) => {
  try {
    const { from, to } = resolveExportRange(req.query);
    const filename = (DATE_RE.test(req.query.from || '') && DATE_RE.test(req.query.to || ''))
      ? `budget-${from}_${to}.csv`
      : `budget-${req.query.month || thisMonthLocalKey()}.csv`;
    const filter = budgetFilter(req, 'b');
    const entries = db.get().prepare(`
      SELECT b.*, u.display_name AS creator_name
      FROM budget_entries b
      LEFT JOIN users u ON u.id = b.created_by
      WHERE b.date BETWEEN ? AND ?${filter.clause}
      ORDER BY b.date ASC
    `).all(from, to, ...filter.params);

    const header = 'Date,Title,Amount,Category,Subcategory,Recurring,Created by\n';
    const csvSafe = (val) => {
      let s = String(val || '').replace(/"/g, '""');
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return `"${s}"`;
    };
    const rows   = entries.map((e) =>
      [
        e.date,
        csvSafe(e.title),
        // Punkt-Dezimal ohne Tausendertrennung: in einem komma-getrennten CSV
        // wäre ein Komma-Dezimaltrenner ein zweites Feldtrennzeichen (Spalte
        // zerreißt). Punkt-Dezimal ist maschinenlesbar, überall parsebar und
        // deckt sich mit der region-abhängigen Anzeige für Punkt-Locales (#521).
        e.amount.toFixed(2),
        e.category,
        e.subcategory || '',
        e.is_recurring ? 'Yes' : 'No',
        csvSafe(e.creator_name),
      ].join(',')
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('﻿' + header + rows); // BOM für Excel
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * GET /api/v1/budget
 * Einträge eines Monats abrufen.
 * Query: ?month=YYYY-MM&category=<cat>
 * Response: { data: Entry[] }
 */
router.get('/', (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 7);
    const month = req.query.month || today;
    const loanId = req.query.loan_id ? parseInt(req.query.loan_id, 10) : null;

    if (!loanId && !MONTH_RE.test(month))
      return res.status(400).json({ error: 'month muss YYYY-MM sein', code: 400 });

    if (!loanId) generateRecurringInstances(db.get(), month);

    const from   = `${month}-01`;
    const to     = `${month}-31`;
    let sql      = `
      SELECT b.*, u.display_name AS creator_name,
             p.id AS loan_payment_id,
             p.loan_id AS loan_id,
             p.installment_number AS loan_installment_number,
             l.title AS loan_title,
             l.borrower AS loan_borrower
      FROM budget_entries b
      LEFT JOIN users u ON u.id = b.created_by
      LEFT JOIN budget_loan_payments p ON p.budget_entry_id = b.id
      LEFT JOIN budget_loans l ON l.id = p.loan_id
    `;
    const params = [];

    if (loanId) {
      sql += ' WHERE p.loan_id = ?';
      params.push(loanId);
    } else {
      sql += ' WHERE b.date BETWEEN ? AND ?';
      params.push(from, to);
    }

    if (req.query.category && validCategoryKeys().includes(req.query.category)) {
      sql += ' AND b.category = ?';
      params.push(req.query.category);
    }

    if (req.query.account_id) {
      const accountId = parseInt(req.query.account_id, 10);
      if (Number.isInteger(accountId) && accountId > 0) {
        sql += ' AND b.account_id = ?';
        params.push(accountId);
      }
    }

    // Sichtbarkeit/Scope (#476/#505). In der Loan-Drilldown-Ansicht kein
    // Mein/Haushalt-Scope, nur Sichtbarkeit.
    const filter = budgetFilter(req, 'b', { scoped: !loanId });
    sql += filter.clause;
    params.push(...filter.params);

    sql += ' ORDER BY b.date DESC, b.created_at DESC';

    const entries = db.get().prepare(sql).all(...params);
    res.json({ data: withAttachments(entries, req.authUserId || req.session.userId) });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * POST /api/v1/budget
 * Neuen Eintrag anlegen.
 * Body: { title, amount, category?, subcategory?, date, is_recurring?, recurrence_rule? }
 * Response: { data: Entry }
 */
router.post('/', (req, res) => {
  try {
    const vTitle  = str(req.body.title,    'Titel',  { max: MAX_TITLE });
    const vAmount = num(req.body.amount,  'Betrag', { required: true });
    const fallbackCategory = defaultCategory(Number(req.body.amount) < 0 ? 'expense' : 'income');
    const vCat    = oneOf(req.body.category || fallbackCategory, validCategoryKeys(), 'Kategorie');
    const vDate   = validateDate(req.body.date,   'Datum',  true);
    const vRrule  = rrule(req.body.recurrence_rule, 'Wiederholung');
    const vInterval = oneOf(req.body.recurrence_interval || 'monthly', RECURRENCE_INTERVAL_KEYS, 'Intervall');
    const vInvoiceStatus = req.body.invoice_status === undefined ? { value: null } : oneOf(req.body.invoice_status, ['open', 'paid', 'partial'], 'Fakturastatus');
    const vInstallments = req.body.invoice_installments === undefined ? { value: null } : num(req.body.invoice_installments, 'Anzahl Raten', { required: false });
    const vPaidInstallments = req.body.invoice_paid_installments === undefined ? { value: null } : num(req.body.invoice_paid_installments, 'Zahlte Raten', { required: false });
    const vDueDay = req.body.invoice_due_day === undefined ? { value: null } : num(req.body.invoice_due_day, 'Fälligkeitstag', { required: false });
    const vClosingDay = req.body.invoice_closing_day === undefined ? { value: null } : num(req.body.invoice_closing_day, 'Schlusselungstag', { required: false });
    const errors  = collectErrors([vTitle, vAmount, vCat, vDate, vRrule, vInterval, vInvoiceStatus, vInstallments, vPaidInstallments, vDueDay, vClosingDay]);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const subcategory = validateSubcategory(vCat.value, req.body.subcategory);
    if (subcategory === null) {
      return res.status(400).json({ error: 'Invalid subcategory.', code: 400 });
    }

    const accountRef = validateAccountRef(req.body.account_id);
    if (accountRef.error) return res.status(400).json({ error: accountRef.error, code: 400 });

    const invoiceStatus = vInvoiceStatus.value;
    const invoiceInstallments = vInstallments.value == null ? null : Math.trunc(Number(vInstallments.value));
    const invoicePaidInstallments = vPaidInstallments.value == null ? 0 : Math.trunc(Number(vPaidInstallments.value));
    const invoiceDueDay = vDueDay.value == null ? null : Math.trunc(Number(vDueDay.value));
    const invoiceClosingDay = vClosingDay.value == null ? null : Math.trunc(Number(vClosingDay.value));
    if (invoiceInstallments !== null && (!Number.isInteger(invoiceInstallments) || invoiceInstallments < 1 || invoiceInstallments > 360)) {
      return res.status(400).json({ error: 'Anzahl Raten muss zwischen 1 und 360 liegen.', code: 400 });
    }
    if (invoicePaidInstallments !== null && (!Number.isInteger(invoicePaidInstallments) || invoicePaidInstallments < 0 || invoicePaidInstallments > (invoiceInstallments ?? 360))) {
      return res.status(400).json({ error: 'Zahlte Raten ist ungültig.', code: 400 });
    }
    if (invoiceDueDay !== null && (!Number.isInteger(invoiceDueDay) || invoiceDueDay < 1 || invoiceDueDay > 31)) {
      return res.status(400).json({ error: 'Fälligkeitstag muss zwischen 1 und 31 liegen.', code: 400 });
    }
    if (invoiceClosingDay !== null && (!Number.isInteger(invoiceClosingDay) || invoiceClosingDay < 1 || invoiceClosingDay > 31)) {
      return res.status(400).json({ error: 'Schlusselungstag muss zwischen 1 und 31 liegen.', code: 400 });
    }

    // Intervall + virtuelles Budget nur für wiederkehrende Einträge.
    const isRecurring = req.body.is_recurring ? 1 : 0;
    const interval    = isRecurring ? vInterval.value : 'monthly';
    const isVirtual   = isRecurring && req.body.recurrence_virtual ? 1 : 0;
    // Virtuell: amount hält den geglätteten Monatsanteil, full den eingegebenen Periodenbetrag.
    const storeAmount = isVirtual ? effectiveMonthly(vAmount.value, interval) : vAmount.value;
    const fullAmount  = isVirtual ? cents(vAmount.value) : null;

    // Eigentümerschaft (fix = Ersteller:in) + Sichtbarkeit (#476/#505).
    // Default-Sichtbarkeit hängt vom Haushalts-Modus ab: personal → private.
    const me = req.authUserId || req.session.userId;
    const visibility = normalizeBudgetVisibility(
      req.body.visibility,
      getBudgetMode() === 'personal' ? 'private' : 'shared'
    );

    const addMonthsToDate = (dateKey, months) => {
      const [year, month, day] = dateKey.split('-').map((part) => Number(part));
      const next = new Date(year, month - 1 + months, day);
      return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    };
    const installmentInsert = db.get().prepare(`
      INSERT INTO budget_entries
        (title, amount, category, subcategory, date, is_recurring, recurrence_rule,
         recurrence_interval, recurrence_virtual, recurrence_full_amount, account_id, created_by,
         owner_id, visibility, invoice_status, invoice_installments, invoice_paid_installments,
         invoice_due_day, invoice_closing_day, invoice_series_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const originalTotalAmount = Number(vAmount.value) || 0;
    const installmentAmount = invoiceInstallments && invoiceInstallments > 1
      ? Number((originalTotalAmount / invoiceInstallments).toFixed(2))
      : originalTotalAmount;
    const installmentBase = Math.abs(installmentAmount);
    const installmentRemainder = invoiceInstallments && invoiceInstallments > 1
      ? Math.abs(originalTotalAmount) - (installmentBase * invoiceInstallments)
      : 0;

    const installmentLabel = (number, total) => total > 1 ? `${vTitle.value} (${number}/${total})` : vTitle.value;
    const currentInstallmentLabel = installmentLabel(1, invoiceInstallments || 1);
    const invoiceSeriesId = invoiceInstallments && invoiceInstallments > 1
      ? `invoice-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : null;

    // Ein Ratenkauf ist keine Wiederholung: die Raten liegen als eigene Zeilen
    // in der Zukunft, nicht als Serie mit Regel. Deshalb die Wiederholungsfelder
    // NUR bei Raten neutralisieren - eine normale Buchung behält isRecurring,
    // interval, isVirtual und den geglätteten storeAmount, sonst verlieren alle
    // neuen wiederkehrenden Buchungen ihre Wiederholung.
    const isInstallment = Boolean(invoiceInstallments && invoiceInstallments > 1);
    const result = installmentInsert.run(
      currentInstallmentLabel,
      isInstallment ? installmentAmount : storeAmount,
      vCat.value || fallbackCategory, subcategory, vDate.value,
      isInstallment ? 0 : isRecurring, vRrule.value,
      isInstallment ? 'monthly' : interval,
      isInstallment ? 0 : isVirtual,
      isInstallment ? null : fullAmount,
      accountRef.value,
      me, me, visibility, invoiceStatus, invoiceInstallments, invoicePaidInstallments,
      invoiceDueDay, invoiceClosingDay, invoiceSeriesId
    );

    if (invoiceInstallments && invoiceInstallments > 1) {
      const signedStartAmount = Math.sign(originalTotalAmount) || -1;
      for (let i = 1; i < invoiceInstallments; i += 1) {
        const futureDate = addMonthsToDate(vDate.value, i);
        const futureAmount = Math.abs(installmentAmount) + (i === invoiceInstallments - 1 ? installmentRemainder : 0);
        const signedAmount = signedStartAmount * futureAmount;
        installmentInsert.run(
          installmentLabel(i + 1, invoiceInstallments),
          signedAmount,
          vCat.value || fallbackCategory,
          subcategory,
          futureDate,
          0,
          vRrule.value,
          'monthly',
          0,
          null,
          accountRef.value,
          me,
          me,
          visibility,
          'open',
          invoiceInstallments,
          0,
          invoiceDueDay,
          invoiceClosingDay,
          invoiceSeriesId
        );
      }
    }

    // Belege (#583): optional, deshalb erst nach dem Insert - der Eintrag steht
    // auch ohne sie, ein unbekanntes Dokument darf ihn nicht scheitern lassen.
    replaceAttachments(result.lastInsertRowid, req.body.attachment_document_ids, me);

    const entry = entryWithLoanMeta(result.lastInsertRowid);
    res.status(201).json({ data: { ...entry, attachments: attachmentsFor(entry.id, me) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id/series
 * Aktualisiert das Serien-Original und löscht zukünftige Instanzen (ab aktuellem Monat),
 * sodass sie beim nächsten Monatsaufruf mit den neuen Werten neu erzeugt werden.
 * Body: wie PUT /:id (date wird ignoriert – das Datum des Originals bleibt erhalten)
 * Response: { data: Parent-Entry }
 */
router.put('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return res.status(400).json({ error: 'Not a recurring entry.', code: 400 });

    const parent = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(parentId);
    if (!parent) return res.status(404).json({ error: 'Series parent not found', code: 404 });

    const checks = [];
    if (req.body.title    !== undefined) checks.push(str(req.body.title,    'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.amount   !== undefined) checks.push(num(req.body.amount,   'Betrag'));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validCategoryKeys(), 'Kategorie'));
    if (req.body.recurrence_rule !== undefined) checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    if (req.body.recurrence_interval !== undefined) checks.push(oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Intervall'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const { title, amount, category, subcategory: requestedSubcategory, is_recurring, recurrence_rule } = req.body;
    const finalTitle    = title     !== undefined ? title.trim()                        : parent.title;
    const finalAmount   = amount    !== undefined ? Number(amount)                     : parent.amount;
    const finalCategory = category  !== undefined ? category                           : parent.category;
    const finalSubcat   = requestedSubcategory !== undefined
      ? (validateSubcategory(finalCategory, requestedSubcategory) ?? parent.subcategory)
      : parent.subcategory;
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : parent.is_recurring;
    const finalInterval  = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (parent.recurrence_interval || 'monthly');
    const finalVirtual   = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : parent.recurrence_virtual;
    const finalFull      = finalVirtual
      ? (amount !== undefined ? cents(finalAmount) : (parent.recurrence_full_amount ?? parent.amount))
      : null;
    const storeAmount    = finalVirtual ? effectiveMonthly(finalFull, finalInterval) : finalAmount;
    const finalRrule     = recurrence_rule !== undefined ? (recurrence_rule || null) : parent.recurrence_rule;

    // Sichtbarkeit ist eine Serien-Eigenschaft (#476/#505): eine Änderung wirkt auf
    // Parent UND alle bereits materialisierten Instanzen, sonst blieben Alt-Instanzen
    // auf dem alten Wert (privat→geteilt = Leak). Künftige Instanzen werden gelöscht
    // und erben den neuen Wert bei der Neu-Generierung (generateRecurringInstances).
    const nextVisibility = req.body.visibility !== undefined
      ? normalizeBudgetVisibility(req.body.visibility)
      : null;

    const currentMonthStart = new Date().toISOString().slice(0, 7) + '-01';

    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE budget_entries SET
          title                  = ?,
          amount                 = ?,
          category               = ?,
          subcategory            = ?,
          is_recurring           = ?,
          recurrence_rule        = ?,
          recurrence_interval    = ?,
          recurrence_virtual     = ?,
          recurrence_full_amount = ?,
          visibility             = COALESCE(?, visibility)
        WHERE id = ?
      `).run(finalTitle, storeAmount, finalCategory, finalSubcat,
             finalRecurring, finalRrule, finalInterval, finalVirtual, finalFull,
             nextVisibility, parentId);

      db.get().prepare(`
        DELETE FROM budget_entries WHERE recurrence_parent_id = ? AND date >= ?
      `).run(parentId, currentMonthStart);

      if (nextVisibility) {
        db.get().prepare(`
          UPDATE budget_entries SET visibility = ? WHERE recurrence_parent_id = ?
        `).run(nextVisibility, parentId);
      }
    })();

    // Belege bleiben hier bewusst unberuehrt (#583): sie gehoeren zur einzelnen
    // Buchung, nicht zur Serie - eine Stromrechnung hat je Monat einen eigenen
    // Beleg. Der Preis dafuer: die oben geloeschten kuenftigen Instanzen nehmen
    // ihre Verknuepfungen mit. Die Dokumente selbst bleiben im Dokumente-Modul.
    const me = req.authUserId || req.session.userId;
    const updated = entryWithLoanMeta(parentId);
    res.json({ data: { ...updated, attachments: attachmentsFor(parentId, me) } });
  } catch (err) {
    log.error('PUT /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/** Atualiza uma compra parcelada inteira ou a parcela atual e as seguintes. */
router.put('/:id/installments', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });
    if (!entry.invoice_series_id) return res.status(400).json({ error: 'Not an installment purchase.', code: 400 });
    if (!['all', 'future'].includes(req.body.scope)) return res.status(400).json({ error: 'Invalid installment scope.', code: 400 });

    const checks = [];
    if (req.body.title !== undefined) checks.push(str(req.body.title, 'Titel', { max: MAX_TITLE, required: false }));
    if (req.body.amount !== undefined) checks.push(num(req.body.amount, 'Betrag'));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validCategoryKeys(), 'Kategorie'));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const category = req.body.category ?? entry.category;
    const subcategory = req.body.subcategory !== undefined
      ? validateSubcategory(category, req.body.subcategory)
      : entry.subcategory;
    if (subcategory === null) return res.status(400).json({ error: 'Invalid subcategory.', code: 400 });

    const accountProvided = req.body.account_id !== undefined;
    const accountRef = accountProvided ? validateAccountRef(req.body.account_id) : { value: null };
    if (accountRef.error) return res.status(400).json({ error: accountRef.error, code: 400 });
    // O sufixo "(n/total)" identifica cada linha da série e não faz parte do
    // título base. A interface antiga enviava o título completo ao editar,
    // o que produzia, por exemplo, "Compra (1/3) (1/3)".
    const baseTitle = req.body.title === undefined
      ? null
      : req.body.title.trim().replace(/\s\(\d+\/\d+\)$/, '');
    const isAll = req.body.scope === 'all';
    const targets = db.get().prepare(`
      SELECT id, title FROM budget_entries
      WHERE invoice_series_id = ? AND (? = 1 OR date >= ?)
    `).all(entry.invoice_series_id, isAll ? 1 : 0, entry.date);
    const update = db.get().prepare(`
      UPDATE budget_entries SET
        title = COALESCE(?, title), amount = COALESCE(?, amount), category = COALESCE(?, category),
        subcategory = COALESCE(?, subcategory), account_id = CASE WHEN ? = 1 THEN ? ELSE account_id END
      WHERE id = ?
    `);
    for (const target of targets) {
      const installmentSuffix = target.title.match(/\s\(\d+\/\d+\)$/)?.[0] || '';
      update.run(
        baseTitle !== null ? `${baseTitle}${installmentSuffix}` : null,
        req.body.amount !== undefined ? cents(req.body.amount) : null,
        req.body.category ?? null,
        subcategory,
        accountProvided ? 1 : 0,
        accountRef.value,
        target.id
      );
    }
    const me = req.authUserId || req.session.userId;
    const updated = entryWithLoanMeta(id);
    res.json({ data: { ...updated, attachments: attachmentsFor(id, me) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

router.delete('/:id/installments', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });
    if (!entry.invoice_series_id || !['all', 'future'].includes(req.query.scope)) return res.status(400).json({ error: 'Invalid installment scope.', code: 400 });
    db.get().prepare(`
      DELETE FROM budget_entries WHERE invoice_series_id = ? AND (? = 'all' OR date >= ?)
    `).run(entry.invoice_series_id, req.query.scope, entry.date);
    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id/series
 * Löscht das Serien-Original und alle zugehörigen Instanzen.
 * Response: 204 No Content
 */
router.delete('/:id/series', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const parentId = entry.recurrence_parent_id ?? (entry.is_recurring ? entry.id : null);
    if (!parentId) return res.status(400).json({ error: 'Not a recurring entry.', code: 400 });

    db.get().transaction(() => {
      db.get().prepare('DELETE FROM budget_entries WHERE recurrence_parent_id = ?').run(parentId);
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(parentId);
    })();

    res.status(204).end();
  } catch (err) {
    log.error('DELETE /budget/:id/series error:', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * PUT /api/v1/budget/:id
 * Eintrag bearbeiten.
 * Body: alle Felder optional
 * Response: { data: Entry }
 */
router.put('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const checks = [];
    if (req.body.title    !== undefined) checks.push(str(req.body.title,    'Titel',  { max: MAX_TITLE, required: false }));
    if (req.body.amount   !== undefined) checks.push(num(req.body.amount,   'Betrag'));
    if (req.body.category !== undefined) checks.push(oneOf(req.body.category, validCategoryKeys(), 'Kategorie'));
    if (req.body.date     !== undefined) checks.push(validateDate(req.body.date,    'Datum'));
    if (req.body.recurrence_rule !== undefined) checks.push(rrule(req.body.recurrence_rule, 'Wiederholung'));
    if (req.body.recurrence_interval !== undefined) checks.push(oneOf(req.body.recurrence_interval, RECURRENCE_INTERVAL_KEYS, 'Intervall'));
    if (req.body.invoice_status !== undefined) checks.push(oneOf(req.body.invoice_status, ['open', 'paid', 'partial'], 'Fakturastatus'));
    if (req.body.invoice_installments !== undefined) checks.push(num(req.body.invoice_installments, 'Anzahl Raten', { required: false }));
    if (req.body.invoice_paid_installments !== undefined) checks.push(num(req.body.invoice_paid_installments, 'Zahlte Raten', { required: false }));
    if (req.body.invoice_due_day !== undefined) checks.push(num(req.body.invoice_due_day, 'Fälligkeitstag', { required: false }));
    if (req.body.invoice_closing_day !== undefined) checks.push(num(req.body.invoice_closing_day, 'Schlusselungstag', { required: false }));
    const errors = collectErrors(checks);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });
    const { title, amount, category, subcategory: requestedSubcategory, date, is_recurring, recurrence_rule } = req.body;
    const normalizedTitle = title !== undefined && entry.invoice_series_id
      ? `${title.trim().replace(/\s\(\d+\/\d+\)$/, '')}${entry.title.match(/\s\(\d+\/\d+\)$/)?.[0] || ''}`
      : title?.trim();
    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);
    if (linkedPayment && amount !== undefined && Number(amount) <= 0) {
      return res.status(400).json({ error: 'Loan repayment entries must remain income.', code: 400 });
    }
    // Währung je Darlehen (#582): Der Budget-Eintrag steht in Budget-Währung, die
    // gekoppelte Rate dagegen in Darlehenswährung. Beide Richtungen unten rechnen
    // deshalb über den festen Kurs des Darlehens um - sonst würde ein Edit des
    // Eintrags die Restschuld eines Fremdwährungs-Darlehens verfälschen.
    const linkedLoan = linkedPayment
      ? db.get().prepare('SELECT total_amount, currency, exchange_rate FROM budget_loans WHERE id = ?').get(linkedPayment.loan_id)
      : null;
    const linkedPaymentAmount = linkedPayment && amount !== undefined
      ? fromBudgetAmount(amount, linkedLoan)
      : null;
    if (linkedPayment && amount !== undefined) {
      const otherPaid = db.get().prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total
        FROM budget_loan_payments
        WHERE loan_id = ? AND id != ?
      `).get(linkedPayment.loan_id, linkedPayment.id).total;
      if (linkedPaymentAmount - (Number(linkedLoan?.total_amount || 0) - Number(otherPaid || 0)) > 0.005) {
        return res.status(400).json({ error: 'Amount cannot be greater than the remaining loan amount.', code: 400 });
      }
    }
    const nextCategory = category ?? entry.category;
    const subcategory = requestedSubcategory !== undefined || category !== undefined
      ? validateSubcategory(nextCategory, requestedSubcategory ?? entry.subcategory)
      : undefined;
    if (subcategory === null) {
      return res.status(400).json({ error: 'Invalid subcategory.', code: 400 });
    }

    const invoiceInstallmentsProvided = req.body.invoice_installments !== undefined;
    const invoicePaidInstallmentsProvided = req.body.invoice_paid_installments !== undefined;
    const invoiceDueDayProvided = req.body.invoice_due_day !== undefined;
    const invoiceClosingDayProvided = req.body.invoice_closing_day !== undefined;
    const nextInvoiceInstallments = invoiceInstallmentsProvided ? Math.trunc(Number(req.body.invoice_installments)) : entry.invoice_installments;
    const nextInvoicePaidInstallments = invoicePaidInstallmentsProvided ? Math.trunc(Number(req.body.invoice_paid_installments)) : (entry.invoice_paid_installments ?? 0);
    const nextInvoiceDueDay = invoiceDueDayProvided ? Math.trunc(Number(req.body.invoice_due_day)) : entry.invoice_due_day;
    const nextInvoiceClosingDay = invoiceClosingDayProvided ? Math.trunc(Number(req.body.invoice_closing_day)) : entry.invoice_closing_day;
    if (invoiceInstallmentsProvided && (!Number.isInteger(nextInvoiceInstallments) || nextInvoiceInstallments < 1 || nextInvoiceInstallments > 360)) {
      return res.status(400).json({ error: 'Anzahl Raten muss zwischen 1 und 360 liegen.', code: 400 });
    }
    if (invoicePaidInstallmentsProvided && (!Number.isInteger(nextInvoicePaidInstallments) || nextInvoicePaidInstallments < 0 || nextInvoicePaidInstallments > (nextInvoiceInstallments ?? 360))) {
      return res.status(400).json({ error: 'Zahlte Raten ist ungültig.', code: 400 });
    }
    if (invoiceDueDayProvided && (!Number.isInteger(nextInvoiceDueDay) || nextInvoiceDueDay < 1 || nextInvoiceDueDay > 31)) {
      return res.status(400).json({ error: 'Fälligkeitstag muss zwischen 1 und 31 liegen.', code: 400 });
    }
    if (invoiceClosingDayProvided && (!Number.isInteger(nextInvoiceClosingDay) || nextInvoiceClosingDay < 1 || nextInvoiceClosingDay > 31)) {
      return res.status(400).json({ error: 'Schlusselungstag muss zwischen 1 und 31 liegen.', code: 400 });
    }
    const nextInvoiceStatus = req.body.invoice_status !== undefined ? req.body.invoice_status : entry.invoice_status;

    // Konto-Zuordnung: undefined ⇒ unverändert; null/'' ⇒ Zuordnung entfernen; id ⇒ setzen.
    const accountProvided = req.body.account_id !== undefined;
    let accountValue = null;
    if (accountProvided) {
      const accountRef = validateAccountRef(req.body.account_id);
      if (accountRef.error) return res.status(400).json({ error: accountRef.error, code: 400 });
      accountValue = accountRef.value;
    }

    // Wiederkehrungs-Felder auflösen (Intervall + virtuelles Budget).
    const finalRecurring = is_recurring !== undefined ? (is_recurring ? 1 : 0) : entry.is_recurring;
    const finalInterval = req.body.recurrence_interval !== undefined
      ? req.body.recurrence_interval
      : (entry.recurrence_interval || 'monthly');
    let finalVirtual = req.body.recurrence_virtual !== undefined
      ? (req.body.recurrence_virtual ? 1 : 0)
      : entry.recurrence_virtual;
    if (!finalRecurring) finalVirtual = 0;
    // Konfigurierter Periodenbetrag (vorzeichenbehaftet): neue Eingabe, sonst bisheriger Vollbetrag.
    const configuredFull = amount !== undefined
      ? Number(amount)
      : (entry.recurrence_full_amount != null ? entry.recurrence_full_amount : entry.amount);
    const nextAmount = finalVirtual ? effectiveMonthly(configuredFull, finalInterval) : cents(configuredFull);
    const nextFull   = finalVirtual ? cents(configuredFull) : null;

    // Sichtbarkeit umschaltbar (privat/geteilt); owner_id bleibt fix (#476/#505).
    const nextVisibility = req.body.visibility !== undefined
      ? normalizeBudgetVisibility(req.body.visibility)
      : null;

    const tx = db.get().transaction(() => {
      db.get().prepare(`
        UPDATE budget_entries
        SET title                  = COALESCE(?, title),
            amount                 = ?,
            category               = COALESCE(?, category),
            subcategory            = COALESCE(?, subcategory),
            date                   = COALESCE(?, date),
            is_recurring           = ?,
            recurrence_rule        = ?,
            recurrence_interval    = ?,
            recurrence_virtual     = ?,
            recurrence_full_amount = ?,
            visibility             = COALESCE(?, visibility),
            invoice_status         = COALESCE(?, invoice_status),
            invoice_installments   = CASE WHEN ? = 1 THEN ? ELSE invoice_installments END,
            invoice_paid_installments = CASE WHEN ? = 1 THEN ? ELSE invoice_paid_installments END,
            invoice_due_day        = CASE WHEN ? = 1 THEN ? ELSE invoice_due_day END,
            invoice_closing_day    = CASE WHEN ? = 1 THEN ? ELSE invoice_closing_day END,
            account_id             = CASE WHEN ? = 1 THEN ? ELSE account_id END
        WHERE id = ?
      `).run(
        normalizedTitle ?? null,
        nextAmount,
        category ?? null,
        subcategory !== undefined ? subcategory : null,
        date ?? null,
        finalRecurring,
        recurrence_rule !== undefined ? (recurrence_rule || null) : entry.recurrence_rule,
        finalInterval,
        finalVirtual,
        nextFull,
        nextVisibility,
        nextInvoiceStatus,
        invoiceInstallmentsProvided ? 1 : 0,
        nextInvoiceInstallments,
        invoicePaidInstallmentsProvided ? 1 : 0,
        nextInvoicePaidInstallments,
        invoiceDueDayProvided ? 1 : 0,
        nextInvoiceDueDay,
        invoiceClosingDayProvided ? 1 : 0,
        nextInvoiceClosingDay,
        accountProvided ? 1 : 0,
        accountValue,
        id
      );

      if (linkedPayment) {
        db.get().prepare(`
          UPDATE budget_loan_payments
          SET amount = COALESCE(?, amount),
              paid_date = COALESCE(?, paid_date)
          WHERE id = ?
        `).run(
          linkedPaymentAmount,
          date ?? null,
          linkedPayment.id
        );
        refreshLoanStatus(linkedPayment.loan_id);
      }
    });
    tx();

    // Belege (#583): nur anfassen, wenn das Feld mitkommt. Ein PUT, das nur den
    // Betrag korrigiert, darf die angehaengten Belege nicht stillschweigend
    // abraeumen.
    const me = req.authUserId || req.session.userId;
    if (req.body.attachment_document_ids !== undefined) {
      replaceAttachments(id, req.body.attachment_document_ids, me);
    }

    const updated = entryWithLoanMeta(id);

    res.json({ data: { ...updated, attachments: attachmentsFor(id, me) } });
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

/**
 * DELETE /api/v1/budget/:id
 * Eintrag löschen.
 * Response: 204 No Content
 */
router.delete('/:id', (req, res) => {
  try {
    const id    = parseInt(req.params.id, 10);
    const entry = db.get().prepare('SELECT * FROM budget_entries WHERE id = ?').get(id);
    if (!entry) return res.status(404).json({ error: 'Entry not found', code: 404 });
    if (!mayEdit(req, entry)) return res.status(403).json({ error: 'You cannot modify this entry.', code: 403 });

    const linkedPayment = db.get().prepare(`
      SELECT * FROM budget_loan_payments WHERE budget_entry_id = ?
    `).get(id);
    const invoicePayment = db.get().prepare(`
      SELECT * FROM budget_account_invoice_payments
      WHERE (debit_entry_id = ? OR credit_entry_id = ?) AND reversed_at IS NULL
    `).get(id, id);

    const tx = db.get().transaction(() => {
      if (invoicePayment) {
        // Os dois lançamentos formam uma transferência inseparável. Excluir um
        // deles desfaz o pagamento inteiro, inclusive o estado da fatura.
        if (invoicePayment.debit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(invoicePayment.debit_entry_id);
        if (invoicePayment.credit_entry_id) db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(invoicePayment.credit_entry_id);
        db.get().prepare(`UPDATE budget_account_invoice_payments SET reversed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(invoicePayment.id);
        db.get().prepare(`
          UPDATE budget_account_invoices
          SET paid_amount = MAX(0, paid_amount - ?),
              status = CASE WHEN paid_amount - ? <= 0.005 THEN 'closed' WHEN paid_amount - ? >= amount - 0.005 THEN 'paid' ELSE 'partial' END,
              paid_at = CASE WHEN paid_amount - ? >= amount - 0.005 THEN paid_at ELSE NULL END
          WHERE account_id = ? AND statement_month = ?
        `).run(invoicePayment.amount, invoicePayment.amount, invoicePayment.amount, invoicePayment.amount, invoicePayment.account_id, invoicePayment.statement_month);
        return;
      }
      if (linkedPayment) {
        db.get().prepare('DELETE FROM budget_loan_payments WHERE id = ?').run(linkedPayment.id);
      }
      db.get().prepare('DELETE FROM budget_entries WHERE id = ?').run(id);
      if (linkedPayment) refreshLoanStatus(linkedPayment.loan_id);
    });
    tx();

    // Wenn eine Instanz gelöscht wird: Monat als übersprungen markieren
    if (entry.recurrence_parent_id) {
      const month = entry.date.slice(0, 7);
      db.get().prepare(
        'INSERT OR IGNORE INTO budget_recurrence_skipped (parent_id, month) VALUES (?, ?)'
      ).run(entry.recurrence_parent_id, month);
    }

    res.status(204).end();
  } catch (err) {
    log.error('', err);
    res.status(500).json({ error: 'Internal error', code: 500 });
  }
});

export default router;
