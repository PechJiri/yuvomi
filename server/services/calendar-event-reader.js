/**
 * Calendar read orchestration.
 *
 * Recurrence expansion remains a dependency-free calendar primitive, while
 * linked occurrence resolution owns the merge model. This module composes the
 * two in one direction so neither foundational service imports the other.
 */

import {
  ASSIGNED_USERS_SQL, expandRecurringEvents, loadEventExceptions,
} from './calendar-events.js';
import { resolveEventRows } from './calendar-occurrence-overrides.js';
import { visibilityWhere } from './visibility.js';
import {
  householdTimeZone, localToUTC, shiftDateKey, storedToInstantMs, todayKey,
} from '../utils/timezone.js';

// Explicit read projections keep legacy inline attachment bodies out of compact
// paths. The schema filter keeps focused test fixtures and older upgrade states
// readable without falling back to SELECT e.*.
export const RESOLVER_EVENT_COLUMNS = Object.freeze([
  'id', 'title', 'description', 'start_datetime', 'end_datetime', 'all_day',
  'location', 'color', 'icon', 'assigned_to', 'created_by', 'external_source',
  'recurrence_rule', 'visibility', 'countdown', 'attachment_name',
  'attachment_mime', 'attachment_size', 'attachment_document_id', 'tzid',
  'recurrence_parent_id', 'recurrence_id', 'overridden_fields',
]);

export const BODY_FREE_EVENT_COLUMNS = Object.freeze([
  ...RESOLVER_EVENT_COLUMNS,
  'external_calendar_id', 'subscription_id', 'user_modified', 'calendar_ref_id',
  'target_caldav_account_id', 'target_caldav_calendar_url', 'created_at',
  'updated_at', 'target_google_calendar_id', 'outbound_dirty',
  'outbound_attempts', 'outbound_move_to', 'external_object_url',
  'target_outlook_account_id', 'target_outlook_calendar_id', 'color_modified',
]);

export function eventProjectionSql(database, alias = 'e', columns = RESOLVER_EVENT_COLUMNS) {
  const available = new Set(database.prepare('PRAGMA table_info(calendar_events)').all()
    .map((column) => column.name));
  const selected = columns.filter((column) => available.has(column));
  if (selected.length === 0) throw new Error('calendar_events has no readable projection columns');
  return selected.map((column) => `${alias}.${column}`).join(',\n           ');
}

function loadResolverMasters(database, parentIds) {
  if (parentIds.length === 0) return [];
  const placeholders = parentIds.map(() => '?').join(',');
  return database.prepare(`
    SELECT ${eventProjectionSql(database)},
           u_assigned.display_name AS assigned_name,
           u_assigned.avatar_color AS assigned_color,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    WHERE e.id IN (${placeholders})
  `).all(...parentIds);
}

/**
 * Hydrates legacy inline attachment bodies only for an already limited result
 * set whose public response still promises them. Compact dashboard/MCP/search
 * readers never call this function.
 */
export function hydrateEventAttachmentBodies(database, rows) {
  const ownerIds = [...new Set(rows
    .filter((event) => !event.attachment_document_id)
    .map((event) => Number(event.attachment_owner_id ?? event.id))
    .filter((id) => Number.isInteger(id) && id > 0))];
  if (ownerIds.length === 0) return rows;

  const bodies = database.prepare(`
    SELECT id, attachment_data
    FROM calendar_events
    WHERE id IN (${ownerIds.map(() => '?').join(',')})
  `).all(...ownerIds);
  const bodyByOwner = new Map(bodies.map((row) => [Number(row.id), row.attachment_data]));
  return rows.map((event) => ({
    ...event,
    attachment_data: bodyByOwner.get(Number(event.attachment_owner_id ?? event.id)) ?? null,
  }));
}

/**
 * Applies authoritative linked resolution while retaining reader-specific
 * projection columns (creator/calendar labels, birthday metadata, and similar)
 * that are not part of the persisted occurrence merge model. Resolved model
 * fields always win over the raw row, so stale materialized values cannot leak.
 */
export function resolveProjectedEventRows(database, rows, { lightweight = false } = {}) {
  const sourceById = new Map(rows.map((row) => [Number(row.id), row]));
  const resolutionOptions = lightweight ? { loadMasters: loadResolverMasters } : {};
  return resolveEventRows(database, rows, resolutionOptions).map((resolved) => {
    if (!resolved.is_occurrence_override) return resolved;
    const source = sourceById.get(Number(resolved.id));
    return source ? { ...source, ...resolved } : resolved;
  });
}

/**
 * Expands series rows once, suppresses their original EXDATE slots, and then
 * composes persisted linked replacements from the current master defaults.
 * Callers remain responsible for applying their own SQL visibility/source
 * filters before handing rows to this shared read contract.
 */
export function expandAndResolveEventRows(database, rows, from, to, options = {}) {
  const recurringIds = rows.filter((event) => event.recurrence_rule).map((event) => event.id);
  const exceptions = loadEventExceptions(database, recurringIds);
  const expanded = expandRecurringEvents(
    rows,
    from,
    to,
    exceptions,
    { includeRecurrenceIdentity: true },
  );
  return resolveProjectedEventRows(database, expanded, options)
    .sort((a, b) => String(a.start_datetime).localeCompare(String(b.start_datetime)));
}

/**
 * Loads upcoming calendar rows for the dashboard, calendar route, and MCP.
 * A null windowDays value preserves MCP's unbounded "from today" contract.
 */
export function getUpcomingEvents(d, {
  userId = null, limit = 5, windowDays = 90, fromToday = false, assignedTo = null,
  includeBirthdays = true, now = new Date(),
} = {}) {
  const tz = householdTimeZone(d);
  const nowDate = todayKey(d, now);
  const filterFromMs = fromToday
    ? new Date(localToUTC(`${nowDate}T00:00:00`, tz)).getTime()
    : now.getTime();
  const future = windowDays === null ? '9999-12-31' : shiftDateKey(nowDate, windowDays);
  const sqlFrom = shiftDateKey(nowDate, -1);

  const rawEvents = d.prepare(`
    SELECT ${eventProjectionSql(d, 'e', BODY_FREE_EVENT_COLUMNS)},
           u_assigned.display_name AS assigned_name,
           u_assigned.avatar_color AS assigned_color,
           ec.name  AS cal_name,
           COALESCE(ec.color, isub.color) AS cal_color,
           COALESCE(bd.name, nd.name) AS birthday_name,
           bd.birth_date AS birthday_date,
           nd.name_day   AS name_day,
           CASE WHEN nd.id IS NOT NULL THEN 'name_day'
                WHEN bd.id IS NOT NULL THEN 'birthday' END AS birthday_event_kind,
           ${ASSIGNED_USERS_SQL}
    FROM calendar_events e
    LEFT JOIN users u_assigned ON u_assigned.id = e.assigned_to
    LEFT JOIN external_calendars ec ON ec.id = e.calendar_ref_id
    LEFT JOIN ics_subscriptions isub ON isub.id = e.subscription_id
    LEFT JOIN birthdays bd ON bd.calendar_event_id = e.id
    LEFT JOIN birthdays nd ON nd.name_day_calendar_event_id = e.id
    WHERE (
      (e.recurrence_rule IS NULL AND DATE(e.start_datetime) BETWEEN ? AND ?)
      OR
      (e.recurrence_rule IS NOT NULL AND DATE(e.start_datetime) <= ?)
    )
    AND (
      e.external_source <> 'ics'
      OR e.subscription_id IN (
        SELECT id FROM ics_subscriptions WHERE shared = 1 OR created_by = ?
      )
    )
    AND ${visibilityWhere('e', 'event_assignments', 'event_id')}
    ORDER BY e.start_datetime ASC
  `).all(sqlFrom, future, future, userId, userId, userId);

  return expandAndResolveEventRows(d, rawEvents, sqlFrom, future, { lightweight: true })
    .filter((event) => {
      const startMs = storedToInstantMs(
        event.all_day ? event.start_datetime.slice(0, 10) : event.start_datetime,
        tz,
      );
      return startMs !== null && startMs >= filterFromMs;
    })
    .filter((event) => {
      if (!assignedTo) return true;
      const assigned = event.assigned_users_json
        ? JSON.parse(event.assigned_users_json)
        : [];
      return assigned.some((user) => Number(user.id) === Number(assignedTo));
    })
    .filter((event) => includeBirthdays || !event.birthday_name)
    .slice(0, limit);
}
