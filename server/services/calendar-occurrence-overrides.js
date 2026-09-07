/**
 * Model primitives for linked local recurrence overrides (#975).
 *
 * The route layer deliberately consumes these small, dependency-free helpers so
 * every occurrence mutation applies the same ownership and eligibility rules.
 */

import { visibilityWhere } from './visibility.js';
import {
  ASSIGNED_USERS_SQL, expandRecurringEvents, MAX_EXPANSION_ITERATIONS,
} from './calendar-events.js';
import {
  dropInheritedEventReminders, eventAuthorId, fanOutEventReminders,
} from './event-reminder-fanout.js';

export const OVERRIDE_FIELDS = Object.freeze([
  'title',
  'description',
  'start_datetime',
  'end_datetime',
  'all_day',
  'location',
  'color',
  'icon',
  'assignments',
  'visibility',
  'countdown',
  'attachment',
  'reminders',
]);

const OVERRIDE_FIELD_SET = new Set(OVERRIDE_FIELDS);

export class CalendarOccurrenceError extends Error {
  constructor(message, {
    status = 400,
    code = 'invalid_override_fields',
    conflict = null,
    orphanedOverrideCount = null,
  } = {}) {
    super(message);
    this.name = 'CalendarOccurrenceError';
    this.status = status;
    this.code = code;
    if (conflict) this.conflict = conflict;
    if (orphanedOverrideCount !== null) {
      this.orphanedOverrideCount = orphanedOverrideCount;
    }
  }
}

function invalidOverrideFields(message) {
  return new CalendarOccurrenceError(message, {
    status: 400,
    code: 'invalid_override_fields',
  });
}

function invalidRecurrenceIdentity(message, { status = 400 } = {}) {
  return new CalendarOccurrenceError(message, {
    status,
    code: 'invalid_recurrence_id',
  });
}

/**
 * Parses the persisted closed override vocabulary into canonical order of first
 * appearance. Empty, partial, or unknown metadata cannot identify an override.
 */
export function parseOverrideFields(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw invalidOverrideFields('overridden_fields must be a non-empty JSON array.');
  }

  let fields;
  try {
    fields = JSON.parse(value);
  } catch {
    throw invalidOverrideFields('overridden_fields must be valid JSON.');
  }
  if (!Array.isArray(fields) || fields.length === 0) {
    throw invalidOverrideFields('overridden_fields must be a non-empty JSON array.');
  }

  const unique = [];
  for (const field of fields) {
    if (typeof field !== 'string' || !OVERRIDE_FIELD_SET.has(field)) {
      throw invalidOverrideFields('overridden_fields contains an unsupported field.');
    }
    if (!unique.includes(field)) unique.push(field);
  }
  return unique;
}

export function isLinkedOccurrence(row) {
  const hasIdentity = Number.isInteger(Number(row?.recurrence_parent_id))
    && Number(row.recurrence_parent_id) > 0
    && typeof row.recurrence_id === 'string'
    && row.recurrence_id.trim() !== ''
    && typeof row.overridden_fields === 'string'
    && row.overridden_fields.trim() !== '';
  if (!hasIdentity) return false;
  try {
    parseOverrideFields(row.overridden_fields);
    return true;
  } catch {
    return false;
  }
}

export function seriesIdFor(row) {
  return isLinkedOccurrence(row) ? Number(row.recurrence_parent_id) : row?.id ?? null;
}

export function recurrenceIdFor(row) {
  if (isLinkedOccurrence(row)) return row.recurrence_id;
  if (!row?.recurrence_rule) return null;
  if (typeof row.recurrence_identity === 'string' && row.recurrence_identity.trim() !== '') {
    return row.recurrence_identity;
  }
  return typeof row.start_datetime === 'string' ? row.start_datetime.slice(0, 10) : null;
}

function isDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function exactLookupIterationLimit(master, recurrenceId) {
  const start = new Date(`${master.start_datetime.slice(0, 10)}T00:00:00Z`).getTime();
  const requested = new Date(`${recurrenceId}T00:00:00Z`).getTime();
  if (!Number.isFinite(start) || requested < start) return 1;
  const calendarDays = Math.floor((requested - start) / 86400000);
  return Math.min(calendarDays + 2, MAX_EXPANSION_ITERATIONS);
}

/**
 * Expands one original recurrence slot without applying the master's EXDATEs.
 * The displayed child start is deliberately irrelevant to this lookup.
 */
export function baseOccurrenceFor(master, recurrenceId) {
  if (!master?.recurrence_rule || !isDateKey(recurrenceId)) {
    throw invalidRecurrenceIdentity('recurrence_id must identify a recurring series date.');
  }

  const occurrences = expandRecurringEvents(
    [master],
    recurrenceId,
    recurrenceId,
    new Map(),
    {
      includeRecurrenceIdentity: true,
      maxIterations: exactLookupIterationLimit(master, recurrenceId),
    },
  );
  const occurrence = occurrences.find((candidate) => candidate.recurrence_identity === recurrenceId);
  if (!occurrence) {
    throw invalidRecurrenceIdentity('recurrence_id is not an occurrence of this series.');
  }
  return occurrence;
}

const OVERRIDE_PROPERTIES = Object.freeze({
  title: ['title'],
  description: ['description'],
  start_datetime: ['start_datetime'],
  end_datetime: ['end_datetime'],
  all_day: ['all_day'],
  location: ['location'],
  color: ['color'],
  icon: ['icon'],
  assignments: [
    'assigned_to', 'assigned_name', 'assigned_color', 'assigned_users_json', 'assigned_users',
  ],
  visibility: ['visibility'],
  countdown: ['countdown'],
  attachment: [
    'attachment_name', 'attachment_mime', 'attachment_size', 'attachment_data',
    'attachment_document_id', 'attachment_preview_url', 'attachment_download_url',
  ],
  reminders: [],
});

function copyMarkedProperties(target, child, fields) {
  for (const field of fields) {
    for (const property of OVERRIDE_PROPERTIES[field]) {
      if (Object.hasOwn(child, property)) target[property] = child[property];
    }
  }
}

function loadOccurrenceMasters(database, parentIds) {
  if (parentIds.length === 0) return [];
  const placeholders = parentIds.map(() => '?').join(',');
  return database.prepare(`
    SELECT e.*,
           u_assigned.display_name AS assigned_name,
           u_assigned.avatar_color AS assigned_color,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    WHERE e.id IN (${placeholders})
  `).all(...parentIds);
}

/**
 * Composes one linked replacement from its current series defaults and the
 * child's explicit override markers.
 */
export function resolveOccurrence(database, child, master = null) {
  if (!isLinkedOccurrence(child)) {
    throw invalidRecurrenceIdentity('The event is not a linked occurrence override.');
  }

  const parentId = Number(child.recurrence_parent_id);
  if (master && Number(master.id) !== parentId) {
    throw invalidRecurrenceIdentity('The recurrence parent does not match the linked occurrence.');
  }
  const hasAssignmentProjection = master
    && Object.hasOwn(master, 'assigned_name')
    && Object.hasOwn(master, 'assigned_color')
    && Object.hasOwn(master, 'assigned_users_json');
  const parent = hasAssignmentProjection ? master : loadOccurrenceMasters(database, [parentId])[0];
  if (!parent) {
    throw invalidRecurrenceIdentity('The recurrence parent does not exist.', { status: 404 });
  }
  if (Number(parent.id) !== parentId) {
    throw invalidRecurrenceIdentity('The recurrence parent does not match the linked occurrence.');
  }

  const fields = parseOverrideFields(child.overridden_fields);
  const base = baseOccurrenceFor(parent, child.recurrence_id);
  const resolved = {
    ...base,
    id: child.id,
    recurrence_parent_id: parentId,
    recurrence_id: child.recurrence_id,
    recurrence_identity: child.recurrence_id,
    overridden_fields: child.overridden_fields,
  };
  copyMarkedProperties(resolved, child, fields);

  const ownsAssignments = fields.includes('assignments');
  const ownsAttachment = fields.includes('attachment');
  const ownsReminders = fields.includes('reminders');
  return {
    ...resolved,
    series_id: Number(parent.id),
    recurrence_id: child.recurrence_id,
    is_occurrence_override: true,
    is_recurring_instance: 1,
    assignment_owner_id: ownsAssignments ? Number(child.id) : Number(parent.id),
    attachment_owner_id: ownsAttachment ? Number(child.id) : Number(parent.id),
    reminder_owner_id: ownsReminders ? Number(child.id) : Number(parent.id),
    reminder_anchor_start: ownsReminders ? resolved.start_datetime : parent.start_datetime,
  };
}

/** Resolves a mixed row set while loading every referenced parent once. */
export function resolveEventRows(database, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const parentIds = [...new Set(rows
    .filter(isLinkedOccurrence)
    .map((row) => Number(row.recurrence_parent_id)))];
  if (parentIds.length === 0) return rows;

  const masters = loadOccurrenceMasters(database, parentIds);
  const mastersById = new Map(masters.map((master) => [Number(master.id), master]));
  return rows.map((row) => isLinkedOccurrence(row)
    ? resolveOccurrence(database, row, mastersById.get(Number(row.recurrence_parent_id)))
    : row);
}

/** Loads linked replacements by series owner and their displayed overlap. */
export function loadLinkedOverrides(database, parentIds, from = null, to = null) {
  const ids = [...new Set((parentIds ?? [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];

  const where = [`recurrence_parent_id IN (${ids.map(() => '?').join(',')})`];
  const params = [...ids];
  if (from) {
    where.push('DATE(COALESCE(end_datetime, start_datetime)) >= DATE(?)');
    params.push(from);
  }
  if (to) {
    where.push('DATE(start_datetime) <= DATE(?)');
    params.push(to);
  }
  return database.prepare(`
    SELECT * FROM calendar_events
    WHERE ${where.join('\n      AND ')}
    ORDER BY start_datetime ASC, id ASC
  `).all(...params);
}

function hasColumn(database, table, column) {
  return database.prepare(`PRAGMA table_info(${table})`).all().some((entry) => entry.name === column);
}

function hasGeneratedOwner(database, eventId) {
  const owners = [
    ['birthdays', 'calendar_event_id'],
    ['birthdays', 'name_day_calendar_event_id'],
    ['housekeeping_work_sessions', 'calendar_event_id'],
  ];

  for (const [table, column] of owners) {
    if (!hasColumn(database, table, column)) continue;
    const owner = database.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ? LIMIT 1`).get(eventId);
    if (owner) return true;
  }
  return false;
}

function hasOutlookLink(database, eventId) {
  if (!hasColumn(database, 'outlook_event_links', 'event_id')) return false;
  return Boolean(database.prepare(
    'SELECT 1 FROM outlook_event_links WHERE event_id = ? LIMIT 1'
  ).get(eventId));
}

function hasActiveOutlookAutoSyncTarget(database, eventId) {
  const requiredColumns = [
    ['outlook_accounts', 'needs_reauth'],
    ['outlook_accounts', 'auto_sync_calendar_id'],
    ['outlook_accounts', 'owner_user_id'],
    ['calendar_events', 'visibility'],
    ['calendar_events', 'created_by'],
    ['event_assignments', 'event_id'],
    ['event_assignments', 'user_id'],
  ];
  if (!requiredColumns.every(([table, column]) => hasColumn(database, table, column))) return false;

  return Boolean(database.prepare(`
    SELECT 1
    FROM outlook_accounts oa
    JOIN calendar_events e ON e.id = ? AND e.external_source = 'local'
    WHERE oa.needs_reauth = 0
      AND oa.auto_sync_calendar_id IS NOT NULL
      AND oa.owner_user_id IS NOT NULL
      AND ${visibilityWhere('e', 'event_assignments', 'event_id', 'oa.owner_user_id')}
    LIMIT 1
  `).get(eventId));
}

/**
 * Determines whether one persisted series may use local occurrence overrides.
 * Classification is evaluated before authorization so callers can report a
 * normal 400 capability error independently of a 403 ownership error.
 */
export function isEligibleLocalSeries(database, row, actorId, isAdmin) {
  const ineligible = !row?.recurrence_rule
    || row.external_source !== 'local'
    || row.external_calendar_id != null
    || row.calendar_ref_id != null
    || row.subscription_id != null
    || row.external_object_url != null
    || row.target_google_calendar_id != null
    || row.target_caldav_account_id != null
    || row.target_caldav_calendar_url != null
    || row.target_outlook_account_id != null
    || row.target_outlook_calendar_id != null
    || row.recurrence_parent_id != null
    || hasGeneratedOwner(database, row.id)
    || hasOutlookLink(database, row.id)
    || hasActiveOutlookAutoSyncTarget(database, row.id);

  if (ineligible) return { eligible: false, reason: 'ineligible_series' };
  if (!isAdmin && row.created_by !== actorId) return { eligible: false, reason: 'not_authorized' };
  return { eligible: true, reason: null };
}

const SCALAR_OVERRIDE_FIELDS = Object.freeze([
  'title', 'description', 'start_datetime', 'end_datetime', 'all_day', 'location',
  'color', 'icon', 'visibility', 'countdown',
]);

function runTransaction(database, work) {
  if (typeof database.transaction === 'function') return database.transaction(work)();
  database.exec('BEGIN');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function loadSeriesForMutation(database, seriesId, actorId, isAdmin) {
  const id = Number(seriesId);
  const master = Number.isInteger(id) && id > 0
    ? database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(id)
    : null;
  if (!master) {
    throw new CalendarOccurrenceError('Calendar series not found.', {
      status: 404,
      code: 'calendar_series_not_found',
    });
  }
  const eligibility = isEligibleLocalSeries(database, master, actorId, isAdmin);
  if (!eligibility.eligible) {
    const unauthorized = eligibility.reason === 'not_authorized';
    throw new CalendarOccurrenceError(
      unauthorized ? 'Not authorized.' : 'This calendar series cannot use occurrence overrides.',
      {
        status: unauthorized ? 403 : 400,
        code: eligibility.reason,
      },
    );
  }
  return master;
}

function normalizeScalar(field, value) {
  if (field === 'all_day' || field === 'countdown') return value ? 1 : 0;
  if (['description', 'end_datetime', 'location', 'color'].includes(field)) return value || null;
  return value;
}

function sameScalar(left, right) {
  return (left ?? null) === (right ?? null);
}

function canonicalIds(values) {
  return [...new Set((values ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function canonicalOffsets(values) {
  return [...new Set((values ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value >= 0))]
    .sort((left, right) => left - right);
}

function assignmentIds(database, eventId) {
  return database.prepare(`
    SELECT user_id FROM event_assignments
    WHERE event_id = ?
    ORDER BY user_id
  `).all(eventId).map((row) => Number(row.user_id));
}

function sameNumberSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

const ATTACHMENT_PROPERTIES = Object.freeze([
  'attachment_name', 'attachment_mime', 'attachment_size', 'attachment_data',
  'attachment_document_id',
]);

function attachmentValues(source) {
  const result = {};
  for (const property of ATTACHMENT_PROPERTIES) result[property] = source?.[property] ?? null;
  return result;
}

function sameAttachment(left, right) {
  return ATTACHMENT_PROPERTIES.every((property) => sameScalar(left[property], right[property]));
}

function syncOwnedAttachmentAccess(database, documentId, visibility, userIds) {
  if (!documentId
      || !hasColumn(database, 'family_documents', 'visibility')
      || !hasColumn(database, 'family_document_access', 'document_id')
      || !hasColumn(database, 'family_document_access', 'user_id')) return;
  const documentVisibility = visibility === 'private'
    ? 'private'
    : visibility === 'assignees'
      ? 'restricted'
      : 'family';
  database.prepare('UPDATE family_documents SET visibility = ? WHERE id = ?')
    .run(documentVisibility, documentId);
  database.prepare('DELETE FROM family_document_access WHERE document_id = ?').run(documentId);
  if (documentVisibility !== 'restricted') return;
  const insert = database.prepare(`
    INSERT OR IGNORE INTO family_document_access (document_id, user_id) VALUES (?, ?)
  `);
  for (const userId of userIds) insert.run(documentId, userId);
}

function wallTimeMs(value) {
  const raw = String(value ?? '');
  const normalized = raw.includes('T') ? raw : `${raw}T09:00:00`;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);
  return Date.parse(zoned ? normalized : `${normalized}Z`);
}

function reminderOffsets(database, eventId, actorId, anchorStart) {
  const anchor = wallTimeMs(anchorStart);
  if (!Number.isFinite(anchor)) return [];
  return [...new Set(database.prepare(`
    SELECT remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ? AND dismissed = 0
  `).all(eventId, actorId).map((row) =>
    Math.round((anchor - wallTimeMs(row.remind_at)) / 60000)
  ).filter((offset) => Number.isInteger(offset) && offset >= 0))]
    .sort((left, right) => left - right);
}

function remindAtForOffset(anchorStart, offset) {
  const anchor = wallTimeMs(anchorStart);
  const result = new Date(anchor - offset * 60000).toISOString();
  return /Z$/.test(String(anchorStart)) ? result : result.slice(0, 19);
}

function replaceAssignments(database, eventId, userIds) {
  const before = assignmentIds(database, eventId);
  database.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(eventId);
  const insert = database.prepare(`
    INSERT OR IGNORE INTO event_assignments (event_id, user_id) VALUES (?, ?)
  `);
  for (const userId of userIds) insert.run(eventId, userId);
  const removed = before.filter((userId) => !userIds.includes(userId));
  dropInheritedEventReminders(database, eventId, removed);
  const authorId = eventAuthorId(database, eventId);
  if (authorId !== null) fanOutEventReminders(database, eventId, authorId);
}

function replaceReminders(database, eventId, actorId, anchorStart, offsets) {
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND created_by = ?
  `).run(eventId, actorId);
  const insert = database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, ?, ?)
  `);
  for (const offset of offsets) {
    insert.run(eventId, remindAtForOffset(anchorStart, offset), actorId);
  }
}

/**
 * Creates or updates one local replacement and its EXDATE in one transaction.
 * `changes` is already validated route data; omitted properties retain the
 * existing replacement value or continue inheriting from the master.
 */
export function upsertOccurrenceOverride(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  reminderOffsets: requestedReminderOffsets,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const base = baseOccurrenceFor(master, recurrenceId);
    const existing = database.prepare(`
      SELECT * FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id = ?
    `).get(master.id, recurrenceId);
    const current = existing ? resolveOccurrence(database, existing, master) : base;
    const existingFields = existing ? parseOverrideFields(existing.overridden_fields) : [];
    const materialized = { ...current };
    for (const field of SCALAR_OVERRIDE_FIELDS) {
      if (Object.hasOwn(changes, field)) {
        materialized[field] = normalizeScalar(field, changes[field]);
      }
    }

    const baseAssignments = canonicalIds(assignmentIds(database, master.id));
    const currentAssignments = existingFields.includes('assignments')
      ? canonicalIds(assignmentIds(database, existing.id))
      : baseAssignments;
    const effectiveAssignments = assignments === undefined
      ? currentAssignments
      : canonicalIds(assignments);

    const baseAttachment = attachmentValues(master);
    const currentAttachment = existingFields.includes('attachment')
      ? attachmentValues(existing)
      : baseAttachment;
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    const effectiveAttachment = createdAttachment === undefined
      ? currentAttachment
      : attachmentValues(createdAttachment);

    const baseReminderOffsets = reminderOffsets(database, master.id, actorId, master.start_datetime);
    const currentReminderOffsets = existingFields.includes('reminders')
      ? reminderOffsets(database, existing.id, actorId, current.start_datetime)
      : baseReminderOffsets;
    const effectiveReminderOffsets = requestedReminderOffsets === undefined
      ? currentReminderOffsets
      : canonicalOffsets(requestedReminderOffsets);

    const scalarDifferences = new Set(SCALAR_OVERRIDE_FIELDS.filter((field) =>
      !sameScalar(materialized[field], base[field])
    ));
    const assignmentsDiffer = !sameNumberSet(effectiveAssignments, baseAssignments);
    const attachmentDiffers = !sameAttachment(effectiveAttachment, baseAttachment);
    const remindersDiffer = !sameNumberSet(effectiveReminderOffsets, baseReminderOffsets);
    const fields = OVERRIDE_FIELDS.filter((field) =>
      scalarDifferences.has(field)
      || (field === 'assignments' && assignmentsDiffer)
      || (field === 'attachment' && attachmentDiffers)
      || (field === 'reminders' && remindersDiffer)
    );
    if (fields.length === 0) {
      if (existing) {
        deleteEventReminders(database, [existing.id]);
        database.prepare('DELETE FROM calendar_events WHERE id = ?').run(existing.id);
      }
      database.prepare(`
        DELETE FROM calendar_event_exceptions
        WHERE event_id = ? AND exception_date = ?
      `).run(master.id, recurrenceId);
      return { event: base, restored: true };
    }

    const overriddenFields = JSON.stringify(fields);
    let childId;
    if (existing) {
      database.prepare(`
        UPDATE calendar_events
        SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
            all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
            visibility = ?, countdown = ?, attachment_name = ?,
            attachment_mime = ?, attachment_size = ?, attachment_data = ?,
            attachment_document_id = ?, recurrence_parent_id = ?, recurrence_id = ?,
            overridden_fields = ?
        WHERE id = ?
      `).run(
        materialized.title,
        materialized.description ?? null,
        materialized.start_datetime,
        materialized.end_datetime ?? null,
        materialized.all_day ? 1 : 0,
        materialized.location ?? null,
        materialized.color ?? null,
        materialized.icon ?? 'calendar',
        assignmentsDiffer ? (effectiveAssignments[0] ?? null) : (materialized.assigned_to ?? null),
        materialized.visibility ?? 'all',
        materialized.countdown ? 1 : 0,
        effectiveAttachment.attachment_name,
        effectiveAttachment.attachment_mime,
        effectiveAttachment.attachment_size,
        effectiveAttachment.attachment_data,
        effectiveAttachment.attachment_document_id,
        master.id,
        recurrenceId,
        overriddenFields,
        existing.id,
      );
      childId = existing.id;
    } else {
      childId = database.prepare(`
        INSERT INTO calendar_events (
          title, description, start_datetime, end_datetime, all_day, location,
          color, icon, assigned_to, created_by, external_source, recurrence_rule,
          visibility, countdown, attachment_name, attachment_mime, attachment_size,
          attachment_data, attachment_document_id, recurrence_parent_id,
          recurrence_id, overridden_fields
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        materialized.title,
        materialized.description ?? null,
        materialized.start_datetime,
        materialized.end_datetime ?? null,
        materialized.all_day ? 1 : 0,
        materialized.location ?? null,
        materialized.color ?? null,
        materialized.icon ?? 'calendar',
        assignmentsDiffer ? (effectiveAssignments[0] ?? null) : (materialized.assigned_to ?? null),
        master.created_by,
        materialized.visibility ?? 'all',
        materialized.countdown ? 1 : 0,
        effectiveAttachment.attachment_name,
        effectiveAttachment.attachment_mime,
        effectiveAttachment.attachment_size,
        effectiveAttachment.attachment_data,
        effectiveAttachment.attachment_document_id,
        master.id,
        recurrenceId,
        overriddenFields,
      ).lastInsertRowid;
    }

    replaceAssignments(database, childId, effectiveAssignments);
    if (remindersDiffer) {
      replaceReminders(
        database,
        childId,
        actorId,
        materialized.start_datetime,
        effectiveReminderOffsets,
      );
    } else if (existingFields.includes('reminders')) {
      replaceReminders(database, childId, actorId, materialized.start_datetime, []);
    }
    if (actorId === master.created_by) fanOutEventReminders(database, childId, actorId);

    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `).run(master.id, recurrenceId);
    const child = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(childId);
    if (attachmentDiffers) {
      syncOwnedAttachmentAccess(
        database,
        child.attachment_document_id,
        child.visibility,
        effectiveAssignments,
      );
    }
    return { event: resolveOccurrence(database, child, master), restored: false };
  });
}

function deleteEventReminders(database, eventIds) {
  const ids = [...new Set(eventIds.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return;
  database.prepare(`
    DELETE FROM reminders
    WHERE entity_type = 'event' AND entity_id IN (${ids.map(() => '?').join(',')})
  `).run(...ids);
}

function previousDateKey(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function truncateRuleBefore(rule, recurrenceId) {
  const raw = String(rule ?? '').replace(/^RRULE:/, '');
  const kept = raw.split(';').filter((segment) =>
    !/^UNTIL=/i.test(segment) && !/^COUNT=/i.test(segment)
  );
  return [...kept, `UNTIL=${previousDateKey(recurrenceId).replaceAll('-', '')}`].join(';');
}

function linkedChildren(database, seriesId, fromRecurrenceId = null) {
  if (fromRecurrenceId) {
    return database.prepare(`
      SELECT * FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
      ORDER BY recurrence_id, id
    `).all(seriesId, fromRecurrenceId);
  }
  return database.prepare(`
    SELECT * FROM calendar_events
    WHERE recurrence_parent_id = ?
    ORDER BY recurrence_id, id
  `).all(seriesId);
}

/** Deletes one original slot while leaving the master's EXDATE in place. */
export function deleteOccurrence(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    baseOccurrenceFor(master, recurrenceId);
    const child = database.prepare(`
      SELECT id FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id = ?
    `).get(master.id, recurrenceId);
    if (child) {
      deleteEventReminders(database, [child.id]);
      database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
    }
    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      VALUES (?, ?)
    `).run(master.id, recurrenceId);
    return { eventId: Number(master.id), recurrenceId };
  });
}

/** Truncates immediately before an original slot, or deletes from the first slot. */
export function truncateSeries(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const selected = baseOccurrenceFor(master, recurrenceId);
    const futureChildren = linkedChildren(database, master.id, recurrenceId);
    if (selected.is_series_start) {
      const allChildren = linkedChildren(database, master.id);
      deleteEventReminders(database, [master.id, ...allChildren.map((row) => row.id)]);
      database.prepare('DELETE FROM calendar_events WHERE id = ?').run(master.id);
      return { wholeSeries: true, eventId: Number(master.id) };
    }

    deleteEventReminders(database, futureChildren.map((row) => row.id));
    database.prepare(`
      DELETE FROM calendar_events
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
    `).run(master.id, recurrenceId);
    database.prepare(`
      DELETE FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
    `).run(master.id, recurrenceId);
    const recurrenceRule = truncateRuleBefore(master.recurrence_rule, recurrenceId);
    database.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
      .run(recurrenceRule, master.id);
    return { wholeSeries: false, eventId: Number(master.id), recurrenceRule };
  });
}

function insertSeriesRow(database, source) {
  return Number(database.prepare(`
    INSERT INTO calendar_events (
      title, description, start_datetime, end_datetime, all_day, location,
      color, icon, assigned_to, created_by, external_source, recurrence_rule,
      visibility, countdown, attachment_name, attachment_mime, attachment_size,
      attachment_data, attachment_document_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.title,
    source.description ?? null,
    source.start_datetime,
    source.end_datetime ?? null,
    source.all_day ? 1 : 0,
    source.location ?? null,
    source.color ?? null,
    source.icon ?? 'calendar',
    source.assigned_to ?? null,
    source.created_by,
    source.recurrence_rule,
    source.visibility ?? 'all',
    source.countdown ? 1 : 0,
    source.attachment_name ?? null,
    source.attachment_mime ?? null,
    source.attachment_size ?? null,
    source.attachment_data ?? null,
    source.attachment_document_id ?? null,
  ).lastInsertRowid);
}

function scalarDifferencesFromBase(values, base, limitedTo = SCALAR_OVERRIDE_FIELDS) {
  return limitedTo.filter((field) => !sameScalar(values[field], base[field]));
}

function refreshReparentedChild(database, child, oldResolved, successor, successorAssignments) {
  let newBase;
  try {
    newBase = baseOccurrenceFor(successor, child.recurrence_id);
  } catch {
    return false;
  }
  const oldFields = parseOverrideFields(child.overridden_fields);
  const values = { ...newBase };
  for (const field of oldFields) {
    if (SCALAR_OVERRIDE_FIELDS.includes(field)) values[field] = oldResolved[field];
  }

  const fields = scalarDifferencesFromBase(values, newBase, oldFields.filter((field) =>
    SCALAR_OVERRIDE_FIELDS.includes(field)
  ));
  const effectiveAssignments = oldFields.includes('assignments')
    ? canonicalIds(assignmentIds(database, child.id))
    : successorAssignments;
  if (!sameNumberSet(effectiveAssignments, successorAssignments)) fields.push('assignments');
  const effectiveAttachment = oldFields.includes('attachment')
    ? attachmentValues(child)
    : attachmentValues(successor);
  if (!sameAttachment(effectiveAttachment, attachmentValues(successor))) fields.push('attachment');
  if (oldFields.includes('reminders')) {
    const childOffsets = reminderOffsets(
      database,
      child.id,
      successor.created_by,
      oldResolved.start_datetime,
    );
    const seriesOffsets = reminderOffsets(
      database,
      successor.id,
      successor.created_by,
      successor.start_datetime,
    );
    if (!sameNumberSet(childOffsets, seriesOffsets)) {
      fields.push('reminders');
      shiftOwnedReminders(database, child.id, oldResolved.start_datetime, values.start_datetime);
    } else {
      deleteEventReminders(database, [child.id]);
    }
  }
  const orderedFields = OVERRIDE_FIELDS.filter((field) => fields.includes(field));

  if (orderedFields.length === 0) {
    deleteEventReminders(database, [child.id]);
    database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
    database.prepare(`
      DELETE FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date = ?
    `).run(successor.id, child.recurrence_id);
    return true;
  }

  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?,
        recurrence_parent_id = ?, overridden_fields = ?
    WHERE id = ?
  `).run(
    values.title,
    values.description ?? null,
    values.start_datetime,
    values.end_datetime ?? null,
    values.all_day ? 1 : 0,
    values.location ?? null,
    values.color ?? null,
    values.icon ?? 'calendar',
    orderedFields.includes('assignments') ? child.assigned_to : successor.assigned_to,
    values.visibility ?? 'all',
    values.countdown ? 1 : 0,
    effectiveAttachment.attachment_name,
    effectiveAttachment.attachment_mime,
    effectiveAttachment.attachment_size,
    effectiveAttachment.attachment_data,
    effectiveAttachment.attachment_document_id,
    successor.id,
    JSON.stringify(orderedFields),
    child.id,
  );
  replaceAssignments(database, child.id, effectiveAssignments);
  if (orderedFields.includes('attachment')) {
    syncOwnedAttachmentAccess(
      database,
      effectiveAttachment.attachment_document_id,
      values.visibility,
      effectiveAssignments,
    );
  }
  return true;
}

/** Splits a series at one original slot and reparents all later override state. */
export function splitSeries(database, {
  seriesId,
  recurrenceId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  reminderOffsets: requestedReminderOffsets,
}) {
  const initialMaster = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
  const initialSelected = baseOccurrenceFor(initialMaster, recurrenceId);
  if (initialSelected.is_series_start) {
    const result = updateSeriesWithOverrides(database, {
      seriesId,
      actorId,
      isAdmin,
      changes,
      assignments,
      attachment,
      createAttachment,
      reminderOffsets: requestedReminderOffsets,
    });
    return { series: result.series, wholeSeries: true };
  }

  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const selectedBase = baseOccurrenceFor(master, recurrenceId);
    const children = linkedChildren(database, master.id, recurrenceId);
    const resolvedById = new Map(children.map((row) => [
      Number(row.id),
      resolveOccurrence(database, row, master),
    ]));
    const selectedChild = children.find((row) => row.recurrence_id === recurrenceId);
    const selectedResolved = selectedChild
      ? resolvedById.get(Number(selectedChild.id))
      : selectedBase;
    const successorValues = { ...selectedResolved };
    for (const field of SCALAR_OVERRIDE_FIELDS) {
      if (Object.hasOwn(changes, field)) successorValues[field] = normalizeScalar(field, changes[field]);
    }
    successorValues.recurrence_rule = Object.hasOwn(changes, 'recurrence_rule')
      ? changes.recurrence_rule
      : master.recurrence_rule;
    successorValues.recurrence_parent_id = null;
    successorValues.recurrence_id = null;
    successorValues.overridden_fields = null;
    successorValues.created_by = master.created_by;

    const selectedFields = selectedChild ? parseOverrideFields(selectedChild.overridden_fields) : [];
    const successorAssignments = assignments === undefined
      ? selectedFields.includes('assignments')
        ? canonicalIds(assignmentIds(database, selectedChild.id))
        : canonicalIds(assignmentIds(database, master.id))
      : canonicalIds(assignments);
    successorValues.assigned_to = successorAssignments[0] ?? null;
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    const successorAttachment = createdAttachment === undefined
      ? selectedFields.includes('attachment')
        ? attachmentValues(selectedChild)
        : attachmentValues(master)
      : attachmentValues(createdAttachment);
    Object.assign(successorValues, successorAttachment);

    const successorOffsets = requestedReminderOffsets === undefined
      ? selectedFields.includes('reminders')
        ? reminderOffsets(database, selectedChild.id, actorId, selectedResolved.start_datetime)
        : reminderOffsets(database, master.id, actorId, master.start_datetime)
      : canonicalOffsets(requestedReminderOffsets);

    database.prepare('UPDATE calendar_events SET recurrence_rule = ? WHERE id = ?')
      .run(truncateRuleBefore(master.recurrence_rule, recurrenceId), master.id);
    const successorId = insertSeriesRow(database, successorValues);
    replaceAssignments(database, successorId, successorAssignments);
    replaceReminders(database, successorId, actorId, successorValues.start_datetime, successorOffsets);
    if (actorId === master.created_by) fanOutEventReminders(database, successorId, actorId);
    database.prepare(`
      INSERT OR IGNORE INTO calendar_event_exceptions (event_id, exception_date)
      SELECT ?, exception_date FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
    `).run(successorId, master.id, recurrenceId);
    database.prepare(`
      DELETE FROM calendar_event_exceptions
      WHERE event_id = ? AND exception_date >= ?
    `).run(master.id, recurrenceId);
    database.prepare(`
      UPDATE calendar_events SET recurrence_parent_id = ?
      WHERE recurrence_parent_id = ? AND recurrence_id >= ?
    `).run(successorId, master.id, recurrenceId);

    const successor = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(successorId);
    syncOwnedAttachmentAccess(
      database,
      successor.attachment_document_id,
      successor.visibility,
      successorAssignments,
    );
    for (const child of children) {
      if (selectedChild && Number(child.id) === Number(selectedChild.id)) {
        deleteEventReminders(database, [child.id]);
        database.prepare('DELETE FROM calendar_events WHERE id = ?').run(child.id);
        database.prepare(`
          DELETE FROM calendar_event_exceptions
          WHERE event_id = ? AND exception_date = ?
        `).run(successorId, recurrenceId);
        continue;
      }
      refreshReparentedChild(
        database,
        { ...child, recurrence_parent_id: successorId },
        resolvedById.get(Number(child.id)),
        successor,
        successorAssignments,
      );
    }
    return {
      series: database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(successorId),
      wholeSeries: false,
    };
  });
}

const SERIES_UPDATE_FIELDS = Object.freeze([
  ...SCALAR_OVERRIDE_FIELDS,
  'recurrence_rule',
  'target_google_calendar_id',
  'target_caldav_account_id',
  'target_caldav_calendar_url',
  'target_outlook_account_id',
  'target_outlook_calendar_id',
]);

function hasOutboundTarget(row) {
  return row.target_google_calendar_id != null
    || row.target_caldav_account_id != null
    || row.target_caldav_calendar_url != null
    || row.target_outlook_account_id != null
    || row.target_outlook_calendar_id != null;
}

function orphanConflict(count) {
  return new CalendarOccurrenceError(
    'Edited occurrences no longer fit this recurrence rule.',
    {
      status: 409,
      code: 'calendar_override_orphans',
      conflict: 'calendar_override_orphans',
      orphanedOverrideCount: count,
    },
  );
}

function classifyOrphans(children, proposed, detachAll) {
  if (detachAll) return children;
  return children.filter((child) => {
    try {
      baseOccurrenceFor(proposed, child.recurrence_id);
      return false;
    } catch {
      return true;
    }
  });
}

function materializeDetachedChild(database, child, master) {
  const fields = parseOverrideFields(child.overridden_fields);
  const resolved = resolveOccurrence(database, child, master);
  if (!fields.includes('assignments')) {
    replaceAssignments(database, child.id, canonicalIds(assignmentIds(database, master.id)));
  }
  if (!fields.includes('reminders')) {
    const rows = database.prepare(`
      SELECT remind_at, dismissed, created_by, assigned_from
      FROM reminders
      WHERE entity_type = 'event' AND entity_id = ?
    `).all(master.id);
    deleteEventReminders(database, [child.id]);
    const shift = wallTimeMs(resolved.start_datetime) - wallTimeMs(master.start_datetime);
    const insert = database.prepare(`
      INSERT INTO reminders (
        entity_type, entity_id, remind_at, dismissed, created_by, assigned_from
      ) VALUES ('event', ?, ?, ?, ?, ?)
    `);
    for (const row of rows) {
      const shifted = new Date(wallTimeMs(row.remind_at) + shift).toISOString();
      insert.run(
        child.id,
        /Z$/.test(String(row.remind_at)) ? shifted : shifted.slice(0, 19),
        row.dismissed,
        row.created_by,
        row.assigned_from ?? null,
      );
    }
  }
  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?,
        recurrence_parent_id = NULL, recurrence_id = NULL, overridden_fields = NULL
    WHERE id = ?
  `).run(
    resolved.title,
    resolved.description ?? null,
    resolved.start_datetime,
    resolved.end_datetime ?? null,
    resolved.all_day ? 1 : 0,
    resolved.location ?? null,
    resolved.color ?? null,
    resolved.icon ?? 'calendar',
    resolved.assigned_to ?? null,
    resolved.visibility ?? 'all',
    resolved.countdown ? 1 : 0,
    resolved.attachment_name ?? null,
    resolved.attachment_mime ?? null,
    resolved.attachment_size ?? null,
    resolved.attachment_data ?? null,
    resolved.attachment_document_id ?? null,
    child.id,
  );
  database.prepare(`
    DELETE FROM calendar_event_exceptions
    WHERE event_id = ? AND exception_date = ?
  `).run(master.id, child.recurrence_id);
}

function applySeriesChanges(database, seriesId, changes) {
  const entries = SERIES_UPDATE_FIELDS
    .filter((field) => Object.hasOwn(changes, field))
    .map((field) => [field, normalizeScalar(field, changes[field])]);
  if (entries.length === 0) return;
  database.prepare(`
    UPDATE calendar_events
    SET ${entries.map(([field]) => `${field} = ?`).join(', ')}
    WHERE id = ?
  `).run(...entries.map(([, value]) => value), seriesId);
}

function shiftOwnedReminders(database, eventId, oldAnchor, newAnchor) {
  const shift = wallTimeMs(newAnchor) - wallTimeMs(oldAnchor);
  if (!Number.isFinite(shift) || shift === 0) return;
  const rows = database.prepare(`
    SELECT id, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
  `).all(eventId);
  const update = database.prepare('UPDATE reminders SET remind_at = ? WHERE id = ?');
  for (const row of rows) {
    const shifted = new Date(wallTimeMs(row.remind_at) + shift).toISOString();
    update.run(/Z$/.test(String(row.remind_at)) ? shifted : shifted.slice(0, 19), row.id);
  }
}

function refreshInheritedChild(database, child, oldResolved, updatedMaster) {
  const fields = parseOverrideFields(child.overridden_fields);
  const newBase = baseOccurrenceFor(updatedMaster, child.recurrence_id);
  const values = { ...newBase };
  for (const field of fields) {
    if (SCALAR_OVERRIDE_FIELDS.includes(field)) values[field] = oldResolved[field];
  }
  const ownsAssignments = fields.includes('assignments');
  const ownsAttachment = fields.includes('attachment');
  if (!ownsAssignments) {
    replaceAssignments(database, child.id, canonicalIds(assignmentIds(database, updatedMaster.id)));
  }
  if (fields.includes('reminders')) {
    shiftOwnedReminders(database, child.id, oldResolved.start_datetime, values.start_datetime);
  }
  const effectiveAttachment = ownsAttachment
    ? attachmentValues(child)
    : attachmentValues(updatedMaster);

  database.prepare(`
    UPDATE calendar_events
    SET title = ?, description = ?, start_datetime = ?, end_datetime = ?,
        all_day = ?, location = ?, color = ?, icon = ?, assigned_to = ?,
        visibility = ?, countdown = ?, attachment_name = ?, attachment_mime = ?,
        attachment_size = ?, attachment_data = ?, attachment_document_id = ?
    WHERE id = ?
  `).run(
    values.title,
    values.description ?? null,
    values.start_datetime,
    values.end_datetime ?? null,
    values.all_day ? 1 : 0,
    values.location ?? null,
    values.color ?? null,
    values.icon ?? 'calendar',
    ownsAssignments ? child.assigned_to : (updatedMaster.assigned_to ?? null),
    values.visibility ?? 'all',
    values.countdown ? 1 : 0,
    effectiveAttachment.attachment_name,
    effectiveAttachment.attachment_mime,
    effectiveAttachment.attachment_size,
    effectiveAttachment.attachment_data,
    effectiveAttachment.attachment_document_id,
    child.id,
  );
}

/** Applies a whole-series update with exact-count orphan confirmation. */
export function updateSeriesWithOverrides(database, {
  seriesId,
  actorId,
  isAdmin = false,
  changes = {},
  assignments,
  attachment,
  createAttachment,
  reminderOffsets: requestedReminderOffsets,
  confirmedOrphanCount,
  applyUpdate,
}) {
  return runTransaction(database, () => {
    const master = loadSeriesForMutation(database, seriesId, actorId, isAdmin);
    const current = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(master.id);
    const proposed = { ...current };
    for (const field of SERIES_UPDATE_FIELDS) {
      if (Object.hasOwn(changes, field)) proposed[field] = normalizeScalar(field, changes[field]);
    }
    const children = linkedChildren(database, master.id);
    const resolvedById = new Map(children.map((child) => [
      Number(child.id),
      resolveOccurrence(database, child, current),
    ]));
    const detachAll = !hasOutboundTarget(current) && hasOutboundTarget(proposed);
    const orphans = classifyOrphans(children, proposed, detachAll);
    if (orphans.length > 0 && Number(confirmedOrphanCount) !== orphans.length) {
      throw orphanConflict(orphans.length);
    }

    for (const child of orphans) materializeDetachedChild(database, child, current);
    if (typeof applyUpdate === 'function') applyUpdate(database, current);
    else applySeriesChanges(database, master.id, changes);
    if (assignments !== undefined) {
      const userIds = canonicalIds(assignments);
      database.prepare('UPDATE calendar_events SET assigned_to = ? WHERE id = ?')
        .run(userIds[0] ?? null, master.id);
      replaceAssignments(database, master.id, userIds);
    }
    const createdAttachment = typeof createAttachment === 'function'
      ? createAttachment()
      : attachment;
    if (createdAttachment !== undefined) {
      const values = attachmentValues(createdAttachment);
      database.prepare(`
        UPDATE calendar_events
        SET attachment_name = ?, attachment_mime = ?, attachment_size = ?,
            attachment_data = ?, attachment_document_id = ?
        WHERE id = ?
      `).run(
        values.attachment_name,
        values.attachment_mime,
        values.attachment_size,
        values.attachment_data,
        values.attachment_document_id,
        master.id,
      );
    }
    if (requestedReminderOffsets !== undefined) {
      const anchor = database.prepare('SELECT start_datetime FROM calendar_events WHERE id = ?')
        .get(master.id).start_datetime;
      replaceReminders(
        database,
        master.id,
        actorId,
        anchor,
        canonicalOffsets(requestedReminderOffsets),
      );
      if (actorId === master.created_by) fanOutEventReminders(database, master.id, actorId);
    }
    const updated = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(master.id);
    if (createdAttachment !== undefined) {
      syncOwnedAttachmentAccess(
        database,
        updated.attachment_document_id,
        updated.visibility,
        canonicalIds(assignmentIds(database, master.id)),
      );
    }
    const orphanIds = new Set(orphans.map((child) => Number(child.id)));
    for (const child of children) {
      if (!orphanIds.has(Number(child.id))) {
        refreshInheritedChild(database, child, resolvedById.get(Number(child.id)), updated);
      }
    }

    const exceptions = database.prepare(`
      SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ?
    `).all(master.id);
    for (const exception of exceptions) {
      try {
        baseOccurrenceFor(updated, exception.exception_date);
      } catch {
        database.prepare(`
          DELETE FROM calendar_event_exceptions
          WHERE event_id = ? AND exception_date = ?
        `).run(master.id, exception.exception_date);
      }
    }

    return {
      series: updated,
      orphanedOverrideCount: orphans.length,
    };
  });
}
