/**
 * Model primitives for linked local recurrence overrides (#975).
 *
 * The route layer deliberately consumes these small, dependency-free helpers so
 * every occurrence mutation applies the same ownership and eligibility rules.
 */

import { visibilityWhere } from './visibility.js';
import { expandRecurringEvents } from './calendar-events.js';

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
  constructor(message, { status = 400, code = 'invalid_override_fields' } = {}) {
    super(message);
    this.name = 'CalendarOccurrenceError';
    this.status = status;
    this.code = code;
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
    { includeRecurrenceIdentity: true },
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

/**
 * Composes one linked replacement from its current series defaults and the
 * child's explicit override markers.
 */
export function resolveOccurrence(database, child, master = null) {
  if (!isLinkedOccurrence(child)) {
    throw invalidRecurrenceIdentity('The event is not a linked occurrence override.');
  }

  const parentId = Number(child.recurrence_parent_id);
  const parent = master ?? database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);
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

  const placeholders = parentIds.map(() => '?').join(',');
  const masters = database.prepare(
    `SELECT * FROM calendar_events WHERE id IN (${placeholders})`
  ).all(...parentIds);
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
