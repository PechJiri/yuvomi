/**
 * Modul: Dokument-Verknuepfungen
 * Zweck: Die eine Mechanik, mit der ein Datensatz Dokumente aus dem
 *        Dokumente-Modul als Beleg traegt (#583).
 *
 * Genutzt von Budget-Buchungen (budget_entry_attachments) und geteilten
 * Ausgaben (expense_attachments). Beide Tabellen haben dieselbe Form:
 * Besitzer-Spalte, document_id, created_by - und dieselben zwei Regeln, die
 * hier stehen statt je Modul:
 *
 *   1. Verknuepfen kann man nur, was man sehen darf. Sonst liesse sich ueber
 *      geratene IDs der Name eines fremden Dokuments auslesen, indem man es
 *      anhaengt und den Datensatz neu laedt.
 *   2. Entfernen kann man nur, was man sieht. Sonst raeumte das Speichern
 *      eines geteilten Datensatzes den privaten Beleg einer anderen Person
 *      weg, den das Formular nie angezeigt hat.
 *
 * Die Sichtbarkeit selbst kommt aus document-access.js.
 */

import { documentVisibleSql, filterVisibleDocumentIds } from './document-access.js';
import { assertDocumentsNotDeleting } from './document-deletion-lock.js';

/** Felder, die ein Beleg preisgibt. Bewusst ohne Dateiinhalt. */
const DOCUMENT_COLUMNS = 'd.name, d.original_name, d.mime_type, d.file_size';

/**
 * Belege mehrerer Datensaetze in einer Abfrage (kein N+1 in Listen).
 *
 * Nicht sichtbare Dokumente fallen heraus, statt als leere Huelle zu
 * erscheinen: Wer den Beleg nicht sehen darf, soll auch nicht erfahren, dass
 * es ihn gibt.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {object} options
 * @param {string} options.table - Verknuepfungstabelle
 * @param {string} options.ownerColumn - Spalte mit der ID des Datensatzes
 * @param {number[]} options.ownerIds
 * @param {number} options.userId - wer schaut
 * @param {string[]} [options.extraColumns] - zusaetzliche Spalten der Verknuepfung
 * @returns {Map<number, object[]>} owner-ID → Belege
 */
export function loadDocumentLinks(database, { table, ownerColumn, ownerIds, userId, extraColumns = [] }) {
  const ids = [...new Set((ownerIds || []).filter((id) => Number.isInteger(id) && id > 0))];
  const byOwner = new Map();
  if (!ids.length) return byOwner;

  const placeholders = ids.map(() => '?').join(', ');
  const extra = extraColumns.length ? `, ${extraColumns.map((c) => `a.${c}`).join(', ')}` : '';
  const rows = database.prepare(`
    SELECT a.${ownerColumn} AS ownerId, a.id, a.document_id, a.created_at${extra}, ${DOCUMENT_COLUMNS}
    FROM ${table} a
    JOIN family_documents d ON d.id = a.document_id
    WHERE a.${ownerColumn} IN (${placeholders}) AND ${documentVisibleSql('d')}
    ORDER BY a.id ASC
  `).all(...ids, { userId });

  for (const { ownerId, ...attachment } of rows) {
    if (!byOwner.has(ownerId)) byOwner.set(ownerId, []);
    byOwner.get(ownerId).push(attachment);
  }
  return byOwner;
}

/**
 * Belege eines einzelnen Datensatzes.
 * @returns {object[]}
 */
export function documentLinksFor(database, { table, ownerColumn, ownerId, userId, extraColumns }) {
  return loadDocumentLinks(database, { table, ownerColumn, ownerIds: [ownerId], userId, extraColumns })
    .get(ownerId) || [];
}

/**
 * Setzt die Belege eines Datensatzes auf die uebergebene Dokumentenliste.
 * Siehe die beiden Regeln im Modulkopf.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {object} options
 * @param {string} options.table
 * @param {string} options.ownerColumn
 * @param {number} options.ownerId
 * @param {any} options.documentIds - Rohwert aus dem Request-Body
 * @param {number} options.userId
 * @param {object} [options.extraValues] - konstante Zusatzspalten beim Insert
 */
export function replaceDocumentLinks(database, { table, ownerColumn, ownerId, documentIds, userId, extraValues = {} }) {
  const wanted = assertDocumentLinkTargetsAvailable(database, documentIds, userId);

  const visibleExisting = database.prepare(`
    SELECT a.document_id
    FROM ${table} a
    JOIN family_documents d ON d.id = a.document_id
    WHERE a.${ownerColumn} = @ownerId AND ${documentVisibleSql('d')}
  `).all({ ownerId, userId }).map((row) => row.document_id);

  const keep = new Set(wanted);
  const remove = visibleExisting.filter((id) => !keep.has(id));

  const extraNames = Object.keys(extraValues);
  const columns = [ownerColumn, 'document_id', 'created_by', ...extraNames];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO ${table} (${columns.join(', ')})
    VALUES (${columns.map(() => '?').join(', ')})
  `);
  const drop = database.prepare(
    `DELETE FROM ${table} WHERE ${ownerColumn} = ? AND document_id = ?`
  );

  database.transaction(() => {
    for (const documentId of remove) drop.run(ownerId, documentId);
    for (const documentId of wanted) {
      insert.run(ownerId, documentId, userId, ...extraNames.map((name) => extraValues[name]));
    }
  })();
}

/** Prüft sichtbare Ziel-Dokumente vor einem Schreibvorgang und gibt ihre IDs zurück. */
export function assertDocumentLinkTargetsAvailable(database, documentIds, userId) {
  const visibleIds = filterVisibleDocumentIds(
    database,
    Array.isArray(documentIds) ? documentIds : [],
    userId,
  );
  assertDocumentsNotDeleting(visibleIds);
  return visibleIds;
}

/**
 * Prueft eine einzelne optionale Dokument-Referenz (z. B. settlements.proof_document_id).
 * @returns {number|null} die ID, wenn sichtbar - sonst null
 */
export function visibleDocumentRef(database, rawId, userId) {
  return assertDocumentLinkTargetsAvailable(database, [rawId], userId)[0] ?? null;
}
