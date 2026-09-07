/**
 * Model primitives for linked local recurrence overrides (#975).
 *
 * The route layer deliberately consumes these small, dependency-free helpers so
 * every occurrence mutation applies the same ownership and eligibility rules.
 */

import { visibilityWhere } from './visibility.js';

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
