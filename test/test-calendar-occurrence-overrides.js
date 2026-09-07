/**
 * Linked local recurrence overrides: schema and model primitive contract (#975).
 *
 * This suite intentionally builds the narrow migration fixture that downstream
 * occurrence-route tests will use, rather than importing the app database.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS_SQL } from '../server/db-schema-test.js';
import {
  baseOccurrenceFor,
  CalendarOccurrenceError,
  isEligibleLocalSeries,
  isLinkedOccurrence,
  loadLinkedOverrides,
  OVERRIDE_FIELDS,
  parseOverrideFields,
  recurrenceIdFor,
  resolveEventRows,
  resolveOccurrence,
  seriesIdFor,
} from '../server/services/calendar-occurrence-overrides.js';
import { expandRecurringEvents } from '../server/services/calendar-events.js';
import { serializeEvent } from '../server/routes/calendar/helpers.js';

function createDatabase() {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec(MIGRATIONS_SQL[1]);
  database.exec(MIGRATIONS_SQL[85]); // calendar_event_exceptions
  database.exec(MIGRATIONS_SQL[174]); // generated name-day event owner
  database.exec(`
    CREATE TABLE housekeeping_work_sessions (
      id INTEGER PRIMARY KEY,
      calendar_event_id INTEGER REFERENCES calendar_events(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS event_assignments (
      event_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      PRIMARY KEY (event_id, user_id)
    );
    CREATE TABLE outlook_accounts (
      id INTEGER PRIMARY KEY,
      needs_reauth INTEGER NOT NULL DEFAULT 0,
      auto_sync_calendar_id TEXT,
      owner_user_id INTEGER
    );
    CREATE TABLE outlook_event_links (
      event_id INTEGER NOT NULL,
      account_id INTEGER NOT NULL,
      outlook_calendar_id TEXT NOT NULL,
      outlook_event_id TEXT NOT NULL,
      PRIMARY KEY (event_id, account_id)
    );
  `);
  database.exec(MIGRATIONS_SQL[190]);
  database.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role)
    VALUES (1, 'admin', 'Admin', 'x', 'admin'), (2, 'member', 'Member', 'x', 'member')
  `).run();
  return database;
}

function insertEvent(database, values = {}) {
  return database.prepare(`
    INSERT INTO calendar_events (
      title, start_datetime, end_datetime, created_by, recurrence_rule,
      recurrence_parent_id, recurrence_id, overridden_fields, external_source,
      external_calendar_id, visibility
    ) VALUES (
      @title, @start_datetime, @end_datetime, @created_by, @recurrence_rule,
      @recurrence_parent_id, @recurrence_id, @overridden_fields, @external_source,
      @external_calendar_id, @visibility
    )
  `).run({
    title: 'Event',
    start_datetime: '2026-10-31T09:00:00',
    end_datetime: null,
    created_by: 1,
    recurrence_rule: null,
    recurrence_parent_id: null,
    recurrence_id: null,
    overridden_fields: null,
    external_source: 'local',
    external_calendar_id: null,
    visibility: 'all',
    ...values,
  }).lastInsertRowid;
}

function insertSeries(database, values = {}) {
  return insertEvent(database, { recurrence_rule: 'FREQ=MONTHLY', ...values });
}

function series(values = {}) {
  return {
    id: 10,
    title: 'Series title',
    description: 'Series description',
    start_datetime: '2026-10-01T09:00',
    end_datetime: '2026-10-01T10:00',
    all_day: 0,
    location: 'Series location',
    color: '#123456',
    icon: 'calendar',
    assigned_to: 1,
    assigned_name: 'Admin',
    assigned_color: '#007AFF',
    assigned_users_json: '[{"id":1,"display_name":"Admin","color":"#007AFF","avatar_data":null}]',
    created_by: 1,
    external_calendar_id: null,
    external_source: 'local',
    recurrence_rule: 'FREQ=DAILY',
    subscription_id: null,
    calendar_ref_id: null,
    external_object_url: null,
    target_google_calendar_id: null,
    target_caldav_account_id: null,
    target_caldav_calendar_url: null,
    target_outlook_account_id: null,
    target_outlook_calendar_id: null,
    visibility: 'all',
    countdown: 0,
    attachment_name: 'series.txt',
    attachment_mime: 'text/plain',
    attachment_size: 12,
    attachment_data: null,
    attachment_document_id: 100,
    tzid: null,
    ...values,
  };
}

function child(values = {}) {
  return {
    id: 20,
    title: 'Child title',
    description: 'Stale child description',
    start_datetime: '2026-10-02T09:00',
    end_datetime: '2026-10-02T10:00',
    all_day: 0,
    location: 'Stale child location',
    color: '#abcdef',
    icon: 'tooth',
    assigned_to: 2,
    assigned_name: 'Member',
    assigned_color: '#ff0000',
    assigned_users_json: '[{"id":2,"display_name":"Member","color":"#ff0000","avatar_data":null}]',
    visibility: 'private',
    countdown: 1,
    attachment_name: 'child.txt',
    attachment_mime: 'text/plain',
    attachment_size: 5,
    attachment_data: null,
    attachment_document_id: 200,
    recurrence_parent_id: 10,
    recurrence_id: '2026-10-02',
    overridden_fields: '["title"]',
    ...values,
  };
}

function assertInvalidIdentity(master, recurrenceId) {
  assert.throws(() => baseOccurrenceFor(master, recurrenceId), (error) =>
    error instanceof CalendarOccurrenceError
    && error.status === 400
    && error.code === 'invalid_recurrence_id'
  );
}

test('migration 190 links one replacement to one original series slot', () => {
  const database = createDatabase();
  const parent = insertSeries(database);
  const child = insertEvent(database, {
    recurrence_parent_id: parent,
    recurrence_id: '2026-10-31',
    overridden_fields: '["title"]',
  });

  assert.throws(() => insertEvent(database, {
    recurrence_parent_id: parent,
    recurrence_id: '2026-10-31',
    overridden_fields: '["location"]',
  }), /UNIQUE/);
  database.prepare('DELETE FROM calendar_events WHERE id = ?').run(parent);
  assert.equal(database.prepare('SELECT id FROM calendar_events WHERE id = ?').get(child), undefined);
});

test('migration 190 adds nullable metadata and the parent/start lookup index', () => {
  const database = createDatabase();
  const columns = new Map(database.prepare('PRAGMA table_info(calendar_events)').all().map((column) => [column.name, column]));

  for (const name of ['recurrence_parent_id', 'recurrence_id', 'overridden_fields']) {
    assert.equal(columns.get(name)?.notnull, 0, `${name} must leave legacy events nullable`);
  }
  assert.equal(columns.get('recurrence_parent_id')?.type, 'INTEGER');
  assert.equal(columns.get('recurrence_id')?.type, 'TEXT');
  assert.equal(columns.get('overridden_fields')?.type, 'TEXT');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_list(calendar_events)').all()
    .filter((foreignKey) => foreignKey.from === 'recurrence_parent_id')
    .map((foreignKey) => ({ table: foreignKey.table, to: foreignKey.to, on_delete: foreignKey.on_delete })),
  [{ table: 'calendar_events', to: 'id', on_delete: 'CASCADE' }]);
  assert.equal(database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_calendar_occurrence_override_range'")
    .get()?.sql.replace(/\s+/g, ' '),
  'CREATE INDEX idx_calendar_occurrence_override_range ON calendar_events(recurrence_parent_id, start_datetime) WHERE recurrence_parent_id IS NOT NULL');

  const legacy = insertEvent(database);
  const legacyMetadata = database.prepare(`
    SELECT recurrence_parent_id, recurrence_id, overridden_fields FROM calendar_events WHERE id = ?
  `).get(legacy);
  assert.equal(legacyMetadata.recurrence_parent_id, null);
  assert.equal(legacyMetadata.recurrence_id, null);
  assert.equal(legacyMetadata.overridden_fields, null);
});

test('override fields use the closed canonical vocabulary and reject malformed metadata', () => {
  assert.deepEqual(OVERRIDE_FIELDS, [
    'title', 'description', 'start_datetime', 'end_datetime', 'all_day', 'location', 'color', 'icon',
    'assignments', 'visibility', 'countdown', 'attachment', 'reminders',
  ]);
  assert.deepEqual(parseOverrideFields('["location", "title", "location"]'), ['location', 'title']);

  for (const value of [null, '', 'not json', '{}', '[]', '["unknown"]', '[1]']) {
    assert.throws(() => parseOverrideFields(value), (error) =>
      error instanceof CalendarOccurrenceError
      && error.status === 400
      && error.code === 'invalid_override_fields'
    );
  }
});

test('linked occurrence helpers preserve the original series and expansion identities', () => {
  const linked = {
    id: 22,
    recurrence_parent_id: 11,
    recurrence_id: '2026-10-31',
    overridden_fields: '["title"]',
    start_datetime: '2026-11-02T09:00:00',
  };
  assert.equal(isLinkedOccurrence(linked), true);
  assert.equal(seriesIdFor(linked), 11);
  assert.equal(recurrenceIdFor(linked), '2026-10-31');
  assert.equal(seriesIdFor({ id: 7, recurrence_rule: 'FREQ=DAILY' }), 7);
  assert.equal(recurrenceIdFor({ recurrence_rule: 'FREQ=DAILY', recurrence_identity: '2026-11-05', start_datetime: '2026-11-04T09:00:00' }), '2026-11-05');
  assert.equal(recurrenceIdFor({ recurrence_rule: 'FREQ=DAILY', start_datetime: '2026-11-04T09:00:00' }), '2026-11-04');
  assert.equal(recurrenceIdFor({ start_datetime: '2026-11-04T09:00:00' }), null);
  assert.equal(isLinkedOccurrence({ ...linked, overridden_fields: null }), false);
  assert.equal(isLinkedOccurrence({ ...linked, recurrence_id: null }), false);
  assert.equal(isLinkedOccurrence({ ...linked, recurrence_parent_id: null }), false);
  assert.equal(isLinkedOccurrence({ ...linked, overridden_fields: '["unknown"]' }), false);
});

test('local-series eligibility separates authorization from classification', () => {
  const database = createDatabase();
  const eligible = database.prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(insertSeries(database));
  assert.deepEqual(isEligibleLocalSeries(database, eligible, 1, false), { eligible: true, reason: null });
  assert.deepEqual(isEligibleLocalSeries(database, eligible, 2, false), { eligible: false, reason: 'not_authorized' });
  assert.deepEqual(isEligibleLocalSeries(database, eligible, 2, true), { eligible: true, reason: null });

  for (const invalid of [
    { recurrence_rule: null },
    { external_source: 'google' },
    { external_calendar_id: 'remote-id' },
    { calendar_ref_id: 8 },
    { subscription_id: 9 },
    { external_object_url: 'https://calendar.example.test/event.ics' },
    { target_google_calendar_id: 'family@example.test' },
    { target_caldav_account_id: 4 },
    { target_caldav_calendar_url: 'https://caldav.example.test/family/' },
    { target_outlook_account_id: 5 },
    { target_outlook_calendar_id: 'AAMkAG...' },
    { recurrence_parent_id: 99 },
  ]) {
    assert.deepEqual(isEligibleLocalSeries(database, { ...eligible, ...invalid }, 1, true), {
      eligible: false,
      reason: 'ineligible_series',
    });
  }

  const generatedId = insertSeries(database);
  database.prepare('INSERT INTO birthdays (name, birth_date, calendar_event_id, created_by) VALUES (?, ?, ?, ?)')
    .run('Generated', '2000-01-01', generatedId, 1);
  const generated = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(generatedId);
  assert.deepEqual(isEligibleLocalSeries(database, generated, 1, true), { eligible: false, reason: 'ineligible_series' });
});

test('local recurring series with an Outlook push link is ineligible without an explicit target', () => {
  const database = createDatabase();
  const eventId = insertSeries(database);
  const event = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(eventId);

  database.prepare(`
    INSERT INTO outlook_event_links (event_id, account_id, outlook_calendar_id, outlook_event_id)
    VALUES (?, ?, ?, ?)
  `).run(eventId, 77, 'calendar-77', 'outlook-event-77');

  assert.deepEqual(isEligibleLocalSeries(database, event, 1, true), {
    eligible: false,
    reason: 'ineligible_series',
  });
});

test('Outlook auto-sync eligibility follows visible event ownership and assignments', () => {
  const database = createDatabase();
  database.prepare(`
    INSERT INTO outlook_accounts (id, needs_reauth, auto_sync_calendar_id, owner_user_id)
    VALUES (20, 0, 'family-calendar', 2)
  `).run();

  const publicEvent = database.prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(insertSeries(database));
  assert.deepEqual(isEligibleLocalSeries(database, publicEvent, 1, true), {
    eligible: false,
    reason: 'ineligible_series',
  });

  const assignedId = insertSeries(database, { visibility: 'assignees' });
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(assignedId, 2);
  const assignedEvent = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(assignedId);
  assert.deepEqual(isEligibleLocalSeries(database, assignedEvent, 1, true), {
    eligible: false,
    reason: 'ineligible_series',
  });

  const privateEvent = database.prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(insertSeries(database, { visibility: 'private' }));
  assert.deepEqual(isEligibleLocalSeries(database, privateEvent, 1, true), { eligible: true, reason: null });

  database.prepare('UPDATE outlook_accounts SET needs_reauth = 1 WHERE id = 20').run();
  assert.deepEqual(isEligibleLocalSeries(database, publicEvent, 1, true), { eligible: true, reason: null });
});

test('daily recurrence identity resolves the exact timed occurrence', () => {
  const base = baseOccurrenceFor(series(), '2026-10-04');

  assert.equal(base.recurrence_identity, '2026-10-04');
  assert.equal(base.start_datetime, '2026-10-04T09:00');
  assert.equal(base.end_datetime, '2026-10-04T10:00');
});

test('weekly BYDAY recurrence identity rejects a weekday outside the rule', () => {
  const master = series({
    start_datetime: '2026-10-01T09:00',
    end_datetime: '2026-10-01T10:00',
    recurrence_rule: 'FREQ=WEEKLY;BYDAY=MO,WE',
  });

  assert.equal(baseOccurrenceFor(master, '2026-10-05').start_datetime, '2026-10-05T09:00');
  assertInvalidIdentity(master, '2026-10-06');
});

test('monthly fixed-day recurrence identity follows the anchored day', () => {
  const master = series({
    start_datetime: '2026-01-31T09:00',
    end_datetime: '2026-01-31T10:00',
    recurrence_rule: 'FREQ=MONTHLY',
  });

  assert.equal(baseOccurrenceFor(master, '2026-02-28').start_datetime, '2026-02-28T09:00');
});

test('monthly last-day recurrence identity resolves the calendar month end', () => {
  const master = series({
    start_datetime: '2026-09-30T09:00',
    end_datetime: '2026-09-30T10:00',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
  });

  assert.equal(baseOccurrenceFor(master, '2026-10-31').start_datetime, '2026-10-31T09:00');
  assertInvalidIdentity(master, '2026-10-30');
});

test('yearly recurrence identity retains its leap-day anchor', () => {
  const master = series({
    start_datetime: '2024-02-29T09:00',
    end_datetime: '2024-02-29T10:00',
    recurrence_rule: 'FREQ=YEARLY',
  });

  assert.equal(baseOccurrenceFor(master, '2025-02-28').start_datetime, '2025-02-28T09:00');
  assert.equal(baseOccurrenceFor(master, '2028-02-29').start_datetime, '2028-02-29T09:00');
});

test('COUNT recurrence identity rejects a slot after the final occurrence', () => {
  const master = series({ recurrence_rule: 'FREQ=DAILY;COUNT=2' });

  assert.equal(baseOccurrenceFor(master, '2026-10-02').start_datetime, '2026-10-02T09:00');
  assertInvalidIdentity(master, '2026-10-03');
});

test('UNTIL recurrence identity includes its boundary and rejects later slots', () => {
  const master = series({ recurrence_rule: 'FREQ=DAILY;UNTIL=20261003' });

  assert.equal(baseOccurrenceFor(master, '2026-10-03').start_datetime, '2026-10-03T09:00');
  assertInvalidIdentity(master, '2026-10-04');
});

test('all-day recurrence identity preserves the date-only duration', () => {
  const master = series({
    start_datetime: '2026-10-01',
    end_datetime: '2026-10-03',
    all_day: 1,
  });
  const base = baseOccurrenceFor(master, '2026-10-04');

  assert.equal(base.start_datetime, '2026-10-04');
  assert.equal(base.end_datetime, '2026-10-06');
});

test('TZID recurrence identity preserves wall time across DST', () => {
  const master = series({
    start_datetime: '2026-03-28T08:00:00Z',
    end_datetime: '2026-03-28T09:00:00Z',
    recurrence_rule: 'FREQ=DAILY',
    tzid: 'Europe/Berlin',
  });
  const base = baseOccurrenceFor(master, '2026-03-29');

  assert.equal(base.start_datetime, '2026-03-29T07:00:00Z');
  assert.equal(base.end_datetime, '2026-03-29T08:00:00Z');
});

test('recurrence identity rejects malformed, pre-series, and non-series slots', () => {
  assertInvalidIdentity(series(), '2026-02-30');
  assertInvalidIdentity(series(), '2026-09-30');
  assertInvalidIdentity(series({ recurrence_rule: null }), '2026-10-01');
});

test('a moved replacement resolves from its original recurrence identity', () => {
  const database = createDatabase();
  const master = series({
    start_datetime: '2026-09-30T09:00',
    end_datetime: '2026-09-30T10:00',
    recurrence_rule: 'FREQ=MONTHLY;BYMONTHDAY=-1',
  });
  const resolved = resolveOccurrence(database, child({
    recurrence_id: '2026-10-31',
    start_datetime: '2026-11-02T11:00',
    overridden_fields: '["start_datetime"]',
  }), master);

  assert.equal(resolved.id, 20);
  assert.equal(resolved.series_id, 10);
  assert.equal(resolved.recurrence_id, '2026-10-31');
  assert.equal(resolved.start_datetime, '2026-11-02T11:00');
  assert.equal(resolved.end_datetime, '2026-10-31T10:00');
  assert.equal(resolved.recurrence_rule, 'FREQ=MONTHLY;BYMONTHDAY=-1');
  assert.equal(resolved.external_source, 'local');
  assert.equal(resolved.is_occurrence_override, true);
  assert.equal(resolved.is_recurring_instance, 1);
});

test('resolved occurrence fields inherit unless their closed marker overrides them', () => {
  const database = createDatabase();
  const master = series({
    title: 'Current series title',
    description: 'Current series description',
    start_datetime: '2026-10-01T09:00',
    end_datetime: '2026-10-01T10:00',
    location: 'Current series location',
    visibility: 'all',
    countdown: 0,
  });
  const resolved = resolveOccurrence(database, child({
    title: 'Occurrence title',
    description: 'Old child description',
    start_datetime: '2026-10-02T11:00',
    end_datetime: '2026-10-02T12:00',
    location: 'Old child location',
    visibility: 'private',
    countdown: 1,
    overridden_fields: '["title","start_datetime","assignments","attachment","reminders"]',
  }), master);

  assert.equal(resolved.title, 'Occurrence title');
  assert.equal(resolved.description, 'Current series description');
  assert.equal(resolved.start_datetime, '2026-10-02T11:00');
  assert.equal(resolved.end_datetime, '2026-10-02T10:00');
  assert.equal(resolved.location, 'Current series location');
  assert.equal(resolved.visibility, 'all');
  assert.equal(resolved.countdown, 0);
  assert.equal(resolved.assigned_to, 2);
  assert.equal(resolved.assigned_users_json, child().assigned_users_json);
  assert.equal(resolved.attachment_document_id, 200);
  assert.equal(resolved.assignment_owner_id, 20);
  assert.equal(resolved.attachment_owner_id, 20);
  assert.equal(resolved.reminder_owner_id, 20);
  assert.equal(resolved.reminder_anchor_start, '2026-10-02T11:00');
});

test('resolved occurrence owners and temporal fields inherit from the series', () => {
  const database = createDatabase();
  const master = series();
  const resolved = resolveOccurrence(database, child({ overridden_fields: '["title"]' }), master);

  assert.equal(resolved.start_datetime, '2026-10-02T09:00');
  assert.equal(resolved.end_datetime, '2026-10-02T10:00');
  assert.equal(resolved.assigned_to, 1);
  assert.equal(resolved.assigned_users_json, master.assigned_users_json);
  assert.equal(resolved.attachment_document_id, 100);
  assert.equal(resolved.assignment_owner_id, 10);
  assert.equal(resolved.attachment_owner_id, 10);
  assert.equal(resolved.reminder_owner_id, 10);
  assert.equal(resolved.reminder_anchor_start, '2026-10-01T09:00');
});

test('resolveOccurrence loads its master and resolveEventRows handles multiple parents', () => {
  const database = createDatabase();
  const firstParent = Number(insertSeries(database, {
    title: 'First series',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const secondParent = Number(insertSeries(database, {
    title: 'Second series',
    start_datetime: '2026-10-05T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const firstChild = Number(insertEvent(database, {
    title: 'First override',
    start_datetime: '2026-10-02T09:00:00',
    recurrence_parent_id: firstParent,
    recurrence_id: '2026-10-02',
    overridden_fields: '["title"]',
  }));
  const secondChild = Number(insertEvent(database, {
    title: 'Second override',
    start_datetime: '2026-10-06T09:00:00',
    recurrence_parent_id: secondParent,
    recurrence_id: '2026-10-06',
    overridden_fields: '["title"]',
  }));
  const rows = database.prepare('SELECT * FROM calendar_events WHERE id IN (?, ?) ORDER BY id').all(firstChild, secondChild);
  const legacy = { id: 999, title: 'Unrelated row' };
  const resolved = resolveEventRows(database, [...rows, legacy]);

  assert.deepEqual(resolved.map((row) => row.series_id ?? row.id), [firstParent, secondParent, 999]);
  assert.deepEqual(resolved.map((row) => row.title), ['First override', 'Second override', 'Unrelated row']);
  assert.strictEqual(resolved[2], legacy);
  assert.equal(resolveOccurrence(database, rows[0]).series_id, firstParent);
});

test('loadLinkedOverrides loads multiple parents by displayed overlap range', () => {
  const database = createDatabase();
  const firstParent = Number(insertSeries(database));
  const secondParent = Number(insertSeries(database, { start_datetime: '2026-10-05T09:00:00' }));
  const moved = Number(insertEvent(database, {
    start_datetime: '2026-11-02T11:00:00',
    recurrence_parent_id: firstParent,
    recurrence_id: '2026-10-31',
    overridden_fields: '["start_datetime"]',
  }));
  const overlapping = Number(insertEvent(database, {
    start_datetime: '2026-10-31',
    end_datetime: '2026-11-02',
    recurrence_parent_id: secondParent,
    recurrence_id: '2026-10-31',
    overridden_fields: '["end_datetime"]',
  }));
  insertEvent(database, {
    start_datetime: '2026-12-01T09:00:00',
    recurrence_parent_id: firstParent,
    recurrence_id: '2026-12-01',
    overridden_fields: '["title"]',
  });

  assert.deepEqual(
    loadLinkedOverrides(database, [firstParent, secondParent], '2026-11-01', '2026-11-30').map((row) => Number(row.id)),
    [overlapping, moved],
  );
  assert.deepEqual(
    loadLinkedOverrides(database, [firstParent], '2026-11-01', '2026-11-30').map((row) => Number(row.id)),
    [moved],
  );
  assert.equal(loadLinkedOverrides(database, []).length, 0);
  assert.equal(loadLinkedOverrides(database, [firstParent]).length, 2);
});

test('serializeEvent appends recurrence metadata and owner identities', () => {
  const database = createDatabase();
  const parentId = Number(insertSeries(database, { title: 'Serialized series' }));
  const master = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);
  const childRow = child({ recurrence_parent_id: parentId, recurrence_id: '2026-10-31' });
  const resolved = resolveOccurrence(database, childRow, master);
  const serialized = serializeEvent(resolved, { database, actorId: 1, isAdmin: false });

  assert.equal(serialized.series_id, parentId);
  assert.equal(serialized.recurrence_id, '2026-10-31');
  assert.equal(serialized.is_occurrence_override, true);
  assert.equal(serialized.can_override_occurrence, true);
  assert.equal(serialized.assignment_owner_id, parentId);
  assert.equal(serialized.attachment_owner_id, parentId);
  assert.equal(serialized.reminder_owner_id, parentId);
  assert.equal(serialized.reminder_anchor_start, master.start_datetime);
  for (const internal of ['recurrence_parent_id', 'recurrence_identity', 'overridden_fields']) {
    assert.equal(Object.hasOwn(serialized, internal), false, `${internal} must stay internal`);
  }
});

test('serializeEvent exposes capability for a series without changing legacy row shape', () => {
  const database = createDatabase();
  const masterId = Number(insertSeries(database));
  const master = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(masterId);
  const serializedMaster = serializeEvent(master, { database, actorId: 1, isAdmin: false });
  const serializedUnauthorized = serializeEvent(master, { database, actorId: 2, isAdmin: false });
  const legacy = {
    id: 99,
    title: 'Standalone',
    recurrence_parent_id: null,
    recurrence_id: null,
    overridden_fields: null,
  };
  const serializedLegacy = serializeEvent(legacy, { database, actorId: 1, isAdmin: false });

  assert.deepEqual({
    series_id: serializedMaster.series_id,
    recurrence_id: serializedMaster.recurrence_id,
    is_occurrence_override: serializedMaster.is_occurrence_override,
    can_override_occurrence: serializedMaster.can_override_occurrence,
    assignment_owner_id: serializedMaster.assignment_owner_id,
    attachment_owner_id: serializedMaster.attachment_owner_id,
    reminder_owner_id: serializedMaster.reminder_owner_id,
    reminder_anchor_start: serializedMaster.reminder_anchor_start,
  }, {
    series_id: masterId,
    recurrence_id: '2026-10-31',
    is_occurrence_override: false,
    can_override_occurrence: true,
    assignment_owner_id: masterId,
    attachment_owner_id: masterId,
    reminder_owner_id: masterId,
    reminder_anchor_start: '2026-10-31T09:00:00',
  });
  assert.equal(serializedUnauthorized.can_override_occurrence, false);
  for (const key of [
    'recurrence_parent_id', 'recurrence_id', 'overridden_fields', 'series_id',
    'is_occurrence_override', 'can_override_occurrence', 'assignment_owner_id',
    'attachment_owner_id', 'reminder_owner_id', 'reminder_anchor_start',
  ]) {
    assert.equal(Object.hasOwn(serializedLegacy, key), false, `${key} must not change a standalone event shape`);
  }
});

test('base occurrence identity opt-in does not change legacy expansion rows', () => {
  const master = series();
  const legacyExpanded = expandRecurringEvents([master], '2026-10-02', '2026-10-02');

  assert.equal(Object.hasOwn(legacyExpanded[0], 'recurrence_identity'), false);
});
