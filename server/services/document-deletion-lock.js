/**
 * Modul: Dokument-Löschsperre
 * Zweck: Verhindert neue Verknüpfungen zu Dokumenten, deren physische Löschung
 *        bereits läuft. Die Sperre ist pro Node-Prozess bewusst kurzlebig.
 */

const activeDocumentDeletes = new Set();

export class DocumentDeletionInProgressError extends Error {
  constructor() {
    super('The document is currently being deleted. Try again when the operation finishes.');
    this.name = 'DocumentDeletionInProgressError';
    this.reason = 'DOCUMENT_DELETE_IN_PROGRESS';
  }
}

export function lockDocumentDeletes(ids) {
  for (const id of ids || []) activeDocumentDeletes.add(Number(id));
}

export function unlockDocumentDeletes(ids) {
  for (const id of ids || []) activeDocumentDeletes.delete(Number(id));
}

export function documentDeleteIsActive(id) {
  return activeDocumentDeletes.has(Number(id));
}

export function assertDocumentsNotDeleting(ids) {
  if ((ids || []).some((id) => documentDeleteIsActive(id))) {
    throw new DocumentDeletionInProgressError();
  }
}

export function sendDocumentDeletionConflict(res, err) {
  if (!(err instanceof DocumentDeletionInProgressError)) return false;
  res.status(409).json({ error: err.message, code: 409, reason: err.reason });
  return true;
}
