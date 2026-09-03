/**
 * Modul: Inventar – Gegenstaende
 * Zweck: CRUD + Liste + Dokument-/Buchungsverknuepfung (Stufen 1-3). Keine
 *        Abo-Verknuepfung, die kommt in einer spaeteren Stufe.
 *
 * Kein Eigentuemer-Gate: Inventar ist Haushaltseigentum wie der Vorrat.
 * created_by bleibt als Herkunftsnachweis (nullable, ON DELETE SET NULL).
 */

import express from 'express';
import * as db from '../../db.js';
import { createLogger } from '../../logger.js';
import {
  str, oneOf, num, date, id as idParam, collectErrors, MAX_TITLE, MAX_TEXT, MAX_SHORT,
} from '../../middleware/validate.js';
import {
  assertDocumentLinkTargetsAvailable, documentLinksFor, loadDocumentLinks, replaceDocumentLinks,
} from '../../services/document-links.js';
import { sendDocumentDeletionConflict } from '../../services/document-deletion-lock.js';
import {
  ROLES, visibleEntry, linkabilityError, entryHasLinks, linkEntry, unlinkEntry,
  loadLinkedEntriesForItems, loadLinkedEntries, computeTotal,
} from './entry-links.js';
import { warrantyEndDate, reminderDateForWarranty } from '../../services/inventory-deadlines.js';
import { dataUrlContentMatches } from '../../utils/file-signature.js';
import {
  validateTrackedDatesInput, writeTrackedDates, removeTrackedDateReminders, loadTrackedDates, loadTrackedDatesForItems,
} from './item-dates.js';

const log = createLogger('Inventory');
const router = express.Router();

const CONDITIONS = ['new', 'good', 'fair', 'poor'];
const STATUSES = ['active', 'sold', 'disposed', 'lost'];
const CURRENCY_RE = /^[A-Z]{3}$/;
const MAX_PHOTO_LENGTH = 6_990_507; // ~5 MB raw image in base64, same cap as birthdays.js
const PHOTO_RE = /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DOCS = { table: 'inventory_item_documents', ownerColumn: 'item_id' };

const WARRANTY_REMINDER_OFFSET_DAYS = 30;

/**
 * Erinnerungs-Lebenszyklus, identisches Muster wie server/routes/subscriptions.js
 * #syncReminder: bei jedem Schreiben erst löschen, dann - falls die Bedingungen
 * greifen - neu anlegen. Kein Diffing, keine Sonderfälle für "nur ein Feld hat
 * sich geändert".
 */
function syncReminder(item) {
  const database = db.get();
  database.prepare(`
    DELETE FROM reminders WHERE entity_type = 'inventory_item' AND entity_id = ?
  `).run(item.id);

  if (!item.purchase_date || item.warranty_months == null || !item.created_by) return;

  const warrantyEnd = warrantyEndDate(item.purchase_date, item.warranty_months);
  const remindAt = reminderDateForWarranty(warrantyEnd, WARRANTY_REMINDER_OFFSET_DAYS);

  // Bereits vergangene Erinnerungstermine nicht anlegen (Design-Doc §4): sonst
  // nagt ein zurückdatiertes Altgerät sofort nach dem Anlegen. remind_at ist
  // naiv-UTC (siehe public/utils/reminder-offset.js) - ein 'Z'-Suffix macht den
  // Vergleich gegen Date.now() korrekt statt einen zweiten Zeitzonen-Offset einzuführen.
  if (new Date(`${remindAt}Z`).getTime() <= Date.now()) return;

  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('inventory_item', ?, ?, ?)
  `).run(item.id, remindAt, item.created_by);
}

/** Gleiches Muster wie server/routes/subscriptions.js#budgetCurrency(). */
function householdCurrency() {
  return db.get().prepare("SELECT value FROM sync_config WHERE key = 'currency'").get()?.value || 'EUR';
}

/** Gleiche Regel wie server/routes/birthdays.js#validatePhotoData - ein
 *  einzelnes optionales Bild je Datensatz, gleiche Groessen-/Typgrenze. */
function validatePhotoData(val) {
  if (val === undefined) return { value: undefined, error: null };
  if (val === null || val === '') return { value: null, error: null };
  const s = String(val).trim();
  if (s.length > MAX_PHOTO_LENGTH) return { value: null, error: 'Photo is too large.' };
  if (!PHOTO_RE.test(s)) return { value: null, error: 'Photo must be a valid image data URL.' };
  // Der Regex prueft die Deklaration, diese Zeile den Inhalt (#937).
  if (!dataUrlContentMatches(s)) return { value: null, error: 'Photo content does not match its image type.' };
  return { value: s, error: null };
}

function validCategoryKeys() {
  return db.get().prepare('SELECT key FROM inventory_categories').all().map((r) => r.key);
}

/**
 * Ortspfad fuer die Anzeige, z. B. "Keller · Regal 2" fuer einen Unterort,
 * "Garage" fuer einen Top-Ebene-Ort. NULL fuer ortlose Gegenstaende.
 */
function locationPath(locationId) {
  if (locationId == null) return null;
  const loc = db.get().prepare('SELECT * FROM inventory_locations WHERE id = ?').get(locationId);
  if (!loc) return null;
  if (loc.parent_id == null) return loc.name;
  const parent = db.get().prepare('SELECT name FROM inventory_locations WHERE id = ?').get(loc.parent_id);
  return parent ? `${parent.name} · ${loc.name}` : loc.name;
}

function loadItem(id, userId) {
  const item = db.get().prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  if (!item) return null;
  const category = db.get().prepare('SELECT name, icon, label_key FROM inventory_categories WHERE key = ?').get(item.category);
  const linkedEntries = loadLinkedEntries(item.id, userId);
  return {
    ...item,
    category_name: category?.name ?? item.category,
    category_icon: category?.icon ?? 'package',
    category_label_key: category?.label_key ?? null,
    location_path: locationPath(item.location_id),
    attachments: documentLinksFor(db.get(), { ...DOCS, ownerId: item.id, userId }),
    linked_entries: linkedEntries,
    linked_entries_total: computeTotal(linkedEntries),
    tracked_dates: loadTrackedDates(item.id),
  };
}

function loadItems({ category, locationId, status, q } = {}, userId) {
  const clauses = [];
  const params = [];
  if (category !== undefined) { clauses.push('ii.category = ?'); params.push(category); }
  if (locationId !== undefined) { clauses.push('ii.location_id = ?'); params.push(locationId); }
  if (status !== undefined) { clauses.push('ii.status = ?'); params.push(status); }
  if (q) {
    clauses.push('(ii.name LIKE ? OR ii.brand LIKE ? OR ii.model LIKE ? OR ii.serial_number LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.get().prepare(`
    SELECT ii.*, ic.name AS category_name, ic.icon AS category_icon, ic.label_key AS category_label_key
    FROM inventory_items ii
    LEFT JOIN inventory_categories ic ON ic.key = ii.category
    ${where}
    ORDER BY ii.name COLLATE NOCASE ASC
  `).all(...params);
  const byItem = loadDocumentLinks(db.get(), { ...DOCS, ownerIds: rows.map((r) => r.id), userId });
  const entriesByItem = loadLinkedEntriesForItems(rows.map((r) => r.id), userId);
  const datesByItem = loadTrackedDatesForItems(rows.map((r) => r.id));
  return rows.map((row) => {
    const linkedEntries = entriesByItem.get(row.id) || [];
    return {
      ...row,
      location_path: locationPath(row.location_id),
      attachments: byItem.get(row.id) || [],
      linked_entries: linkedEntries,
      linked_entries_total: computeTotal(linkedEntries),
      tracked_dates: datesByItem.get(row.id) || [],
    };
  });
}

/**
 * Validiert die Felder eines Gegenstands fuer ein volles Replace (POST wie PUT
 * identisch). Ein weggelassenes Feld wird NULL/Default - kein Feld behaelt den
 * Altwert (siehe die erste, einfachere Inventar-Version dieses Projekts, wo genau
 * diese Inkonsistenz per Review-Fund korrigiert werden musste).
 */
function validateItemFields(body) {
  const values = {};
  const results = [];

  const vName = str(body.name, 'Name', { max: MAX_TITLE });
  results.push(vName);
  values.name = vName.value;

  const vBrand = str(body.brand, 'Marke', { max: MAX_SHORT, required: false });
  results.push(vBrand);
  values.brand = vBrand.value;

  const vModel = str(body.model, 'Modell', { max: MAX_SHORT, required: false });
  results.push(vModel);
  values.model = vModel.value;

  const vSerial = str(body.serial_number, 'Seriennummer', { max: MAX_SHORT, required: false });
  results.push(vSerial);
  values.serial_number = vSerial.value;

  const categoryKeys = validCategoryKeys();
  const vCategory = oneOf(body.category || 'other', categoryKeys, 'Kategorie');
  results.push(vCategory);
  values.category = vCategory.value ?? 'other';

  if (body.location_id === null || body.location_id === '' || body.location_id === undefined) {
    values.location_id = null;
  } else {
    const vLoc = idParam(body.location_id, 'Ort');
    results.push(vLoc);
    if (vLoc.value !== null) {
      const exists = db.get().prepare('SELECT id FROM inventory_locations WHERE id = ?').get(vLoc.value);
      if (!exists) results.push({ error: 'Location not found.' });
    }
    values.location_id = vLoc.value;
  }

  const vPurchaseDate = date(body.purchase_date, 'Kaufdatum');
  results.push(vPurchaseDate);
  values.purchase_date = vPurchaseDate.value;

  if (body.purchase_price === null || body.purchase_price === '' || body.purchase_price === undefined) {
    values.purchase_price = null;
  } else {
    const vPrice = num(body.purchase_price, 'Kaufpreis');
    results.push(vPrice);
    if (vPrice.value !== null && vPrice.value < 0) results.push({ error: 'Kaufpreis darf nicht negativ sein.' });
    values.purchase_price = vPrice.value;
  }

  if (body.currency === null || body.currency === '' || body.currency === undefined) {
    values.currency = householdCurrency();
  } else {
    const currency = String(body.currency).toUpperCase();
    if (!CURRENCY_RE.test(currency)) results.push({ error: 'Currency must be a three-letter ISO code.' });
    values.currency = currency;
  }

  const vVendor = str(body.vendor, 'Haendler', { max: MAX_SHORT, required: false });
  results.push(vVendor);
  values.vendor = vVendor.value;

  if (body.warranty_months === null || body.warranty_months === '' || body.warranty_months === undefined) {
    values.warranty_months = null;
  } else {
    const vWarranty = num(body.warranty_months, 'Garantiemonate');
    results.push(vWarranty);
    if (vWarranty.value !== null && (!Number.isInteger(vWarranty.value) || vWarranty.value < 0 || vWarranty.value > 600)) {
      results.push({ error: 'Garantiemonate muss eine ganze Zahl zwischen 0 und 600 sein.' });
    }
    values.warranty_months = vWarranty.value;
  }

  const vCondition = oneOf(body.condition || 'good', CONDITIONS, 'Zustand');
  results.push(vCondition);
  values.condition = vCondition.value ?? 'good';

  const vStatus = oneOf(body.status || 'active', STATUSES, 'Status');
  results.push(vStatus);
  values.status = vStatus.value ?? 'active';

  const vNotes = str(body.notes, 'Notiz', { max: MAX_TEXT, required: false });
  results.push(vNotes);
  values.notes = vNotes.value;

  const vPhoto = validatePhotoData(body.photo_data);
  results.push(vPhoto);
  // `?? null`, nicht `vPhoto.value`: ein fehlendes Feld validiert als
  // `{value: undefined}`, aber dies ist ein volles Replace (Global
  // Constraints) - ein weggelassenes Foto wird NULL, nicht "unveraendert".
  values.photo_data = vPhoto.value ?? null;

  return { values, errors: collectErrors(results) };
}

// --------------------------------------------------------
// GET /api/v1/inventory/items   Query: ?category=&location_id=&status=&q=
// --------------------------------------------------------
router.get('/', (req, res) => {
  try {
    const category = typeof req.query.category === 'string' && req.query.category ? req.query.category : undefined;
    let locationId;
    if (req.query.location_id !== undefined) {
      const n = parseInt(req.query.location_id, 10);
      if (!n || n < 1) return res.status(400).json({ error: 'location_id must be a positive number.', code: 400 });
      locationId = n;
    }
    const status = typeof req.query.status === 'string' && STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : undefined;
    const userId = req.authUserId || req.session.userId;

    res.json({ data: loadItems({ category, locationId, status, q }, userId) });
  } catch (err) {
    log.error('GET / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// GET /api/v1/inventory/items/:id
// --------------------------------------------------------
router.get('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const userId = req.authUserId || req.session.userId;
    const item = loadItem(vId.value, userId);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.json({ data: item });
  } catch (err) {
    log.error('GET /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/items
// --------------------------------------------------------
router.post('/', (req, res) => {
  try {
    const userId = req.authUserId || req.session.userId;

    // Kaufpreis-Vorbelegung (Design-Doc §5.6): entry_id wird VOR dem Insert
    // geprueft, damit eine ungueltige Buchung nie einen verwaisten Gegenstand
    // anlegt. Vorbelegt wird nur, wenn purchase_price fehlt UND die Buchung
    // noch keine andere Verknuepfung hat (Sammelrechnung, zweiter Gegenstand).
    let effectiveBody = req.body;
    let entry = null;
    const rawEntryId = req.body.entry_id;
    if (rawEntryId !== undefined && rawEntryId !== null && rawEntryId !== '') {
      const vEntryId = idParam(rawEntryId, 'Buchung');
      if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });
      entry = visibleEntry(vEntryId.value, userId);
      if (!entry) return res.status(404).json({ error: 'Booking not found.', code: 404 });
      const linkError = linkabilityError(entry);
      if (linkError) return res.status(linkError.code).json({ error: linkError.error, code: linkError.code });

      const priceOmitted = req.body.purchase_price === undefined || req.body.purchase_price === null || req.body.purchase_price === '';
      if (priceOmitted && !entryHasLinks(entry.id)) {
        effectiveBody = { ...req.body, purchase_price: Math.abs(entry.amount) };
      }
    }

    const { values, errors } = validateItemFields(effectiveBody);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    const { values: trackedDateValues, errors: trackedDateErrors } = validateTrackedDatesInput(req.body.tracked_dates);
    if (trackedDateErrors.length) return res.status(400).json({ error: trackedDateErrors.join(' '), code: 400 });

    // Insert und Erinnerungs-Sync in einer Transaktion (gleiches Muster wie
    // DELETE /:id): wirft syncReminder - etwa an einem Kaufdatum, das die
    // Datumsrechnung nicht parsen kann -, darf der Gegenstand nicht trotzdem
    // geschrieben bleiben, waehrend die Anfrage mit 500 endet.
    assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, userId);
    const result = db.get().transaction(() => {
      const inserted = db.get().prepare(`
        INSERT INTO inventory_items
          (name, brand, model, serial_number, category, location_id, purchase_date,
           purchase_price, currency, vendor, warranty_months, condition,
           status, notes, photo_data, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        values.name, values.brand, values.model, values.serial_number, values.category,
        values.location_id, values.purchase_date, values.purchase_price,
        values.currency, values.vendor, values.warranty_months, values.condition, values.status,
        values.notes, values.photo_data, userId,
      );

      syncReminder({
        id: inserted.lastInsertRowid,
        purchase_date: values.purchase_date,
        warranty_months: values.warranty_months,
        created_by: userId,
      });

      writeTrackedDates(inserted.lastInsertRowid, trackedDateValues, userId);

      return inserted;
    })();

    // Belege sind optional, deshalb erst nach dem Insert - der Gegenstand
    // steht auch ohne sie, ein unbekanntes Dokument darf ihn nicht scheitern lassen.
    replaceDocumentLinks(db.get(), {
      ...DOCS, ownerId: result.lastInsertRowid, documentIds: req.body.attachment_document_ids, userId,
    });

    if (entry) {
      linkEntry({ itemId: result.lastInsertRowid, entryId: entry.id, role: 'purchase', amountShare: null, userId });
    }

    res.status(201).json({ data: loadItem(result.lastInsertRowid, userId) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    log.error('POST / error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// PUT /api/v1/inventory/items/:id   Volles Replace, siehe Kommentar oben.
// --------------------------------------------------------
router.put('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id, created_by FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const { values, errors } = validateItemFields(req.body);
    if (errors.length) return res.status(400).json({ error: errors.join(' '), code: 400 });

    let trackedDateValues = null;
    if (req.body.tracked_dates !== undefined) {
      const result = validateTrackedDatesInput(req.body.tracked_dates);
      if (result.errors.length) return res.status(400).json({ error: result.errors.join(' '), code: 400 });
      trackedDateValues = result.values;
    }

    // A rejected in-flight attachment must not leave the item fields or its
    // reminders half-updated.
    const userId = req.authUserId || req.session.userId;
    if (req.body.attachment_document_ids !== undefined) {
      assertDocumentLinkTargetsAvailable(db.get(), req.body.attachment_document_ids, userId);
    }

    // Update und Erinnerungs-Sync in einer Transaktion, gleiche Begruendung wie
    // im POST-Handler: kein halb geschriebener Zustand, wenn syncReminder wirft.
    db.get().transaction(() => {
      db.get().prepare(`
        UPDATE inventory_items
        SET name = ?, brand = ?, model = ?, serial_number = ?, category = ?, location_id = ?,
            purchase_date = ?, purchase_price = ?, currency = ?, vendor = ?,
            warranty_months = ?, condition = ?, status = ?, notes = ?, photo_data = ?
        WHERE id = ?
      `).run(
        values.name, values.brand, values.model, values.serial_number, values.category,
        values.location_id, values.purchase_date, values.purchase_price,
        values.currency, values.vendor, values.warranty_months, values.condition, values.status,
        values.notes, values.photo_data, item.id,
      );

      syncReminder({
        id: item.id,
        purchase_date: values.purchase_date,
        warranty_months: values.warranty_months,
        created_by: item.created_by,
      });

      if (trackedDateValues !== null) {
        writeTrackedDates(item.id, trackedDateValues, item.created_by);
      }
    })();

    // Belege nur anfassen, wenn das Feld mitkommt - ein PUT, das nur einen
    // Wert korrigiert, darf angehaengte Belege nicht stillschweigend abraeumen
    // (gleiches Muster wie server/routes/budget/entries.js#PUT /:id).
    if (req.body.attachment_document_ids !== undefined) {
      replaceDocumentLinks(db.get(), {
        ...DOCS, ownerId: item.id, documentIds: req.body.attachment_document_ids, userId,
      });
    }

    res.json({ data: loadItem(item.id, userId) });
  } catch (err) {
    if (sendDocumentDeletionConflict(res, err)) return;
    log.error('PUT /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// POST /api/v1/inventory/items/:id/entries   Body: { entry_id, role?, amount_share? }
// --------------------------------------------------------
router.post('/:id/entries', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const vEntryId = idParam(req.body.entry_id, 'Buchung');
    if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });

    const vRole = oneOf(req.body.role || 'purchase', ROLES, 'Rolle');
    if (vRole.error) return res.status(400).json({ error: vRole.error, code: 400 });

    let amountShare = null;
    if (req.body.amount_share !== undefined && req.body.amount_share !== null && req.body.amount_share !== '') {
      const vShare = num(req.body.amount_share, 'Anteil');
      if (vShare.error) return res.status(400).json({ error: vShare.error, code: 400 });
      if (vShare.value !== null && vShare.value < 0) {
        return res.status(400).json({ error: 'Anteil darf nicht negativ sein.', code: 400 });
      }
      amountShare = vShare.value;
    }

    const userId = req.authUserId || req.session.userId;
    const result = linkEntry({ itemId: item.id, entryId: vEntryId.value, role: vRole.value, amountShare, userId });
    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    res.status(201).json({ data: loadItem(item.id, userId) });
  } catch (err) {
    log.error('POST /:id/entries error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/items/:id/entries/:entryId
// Entfernt ALLE Verknuepfungen zwischen Gegenstand und Buchung (rollenunabhaengig).
// --------------------------------------------------------
router.delete('/:id/entries/:entryId', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });
    const item = db.get().prepare('SELECT id FROM inventory_items WHERE id = ?').get(vId.value);
    if (!item) return res.status(404).json({ error: 'Item not found.', code: 404 });

    const vEntryId = idParam(req.params.entryId, 'Buchung-ID');
    if (vEntryId.error) return res.status(400).json({ error: vEntryId.error, code: 400 });

    const userId = req.authUserId || req.session.userId;
    const result = unlinkEntry({ itemId: item.id, entryId: vEntryId.value, userId });
    if (result.error) return res.status(result.code).json({ error: result.error, code: result.code });

    res.json({ data: loadItem(item.id, userId) });
  } catch (err) {
    log.error('DELETE /:id/entries/:entryId error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

// --------------------------------------------------------
// DELETE /api/v1/inventory/items/:id
// --------------------------------------------------------
router.delete('/:id', (req, res) => {
  try {
    const vId = idParam(req.params.id, 'Gegenstand-ID');
    if (vId.error) return res.status(400).json({ error: vId.error, code: 400 });

    const deleted = db.get().transaction(() => {
      db.get().prepare("DELETE FROM reminders WHERE entity_type = 'inventory_item' AND entity_id = ?").run(vId.value);
      removeTrackedDateReminders(vId.value);
      return db.get().prepare('DELETE FROM inventory_items WHERE id = ?').run(vId.value);
    })();

    if (deleted.changes === 0) return res.status(404).json({ error: 'Item not found.', code: 404 });
    res.status(204).end();
  } catch (err) {
    log.error('DELETE /:id error:', err);
    res.status(500).json({ error: 'Internal server error.', code: 500 });
  }
});

export default router;
