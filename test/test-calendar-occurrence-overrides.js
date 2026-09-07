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
  deleteOccurrence,
  isEligibleLocalSeries,
  isLinkedOccurrence,
  loadLinkedOverrides,
  OVERRIDE_FIELDS,
  parseOverrideFields,
  recurrenceIdFor,
  resolveEventRows,
  resolveOccurrence,
  seriesIdFor,
  splitSeries,
  truncateSeries,
  upsertOccurrenceOverride,
  updateSeriesWithOverrides,
} from '../server/services/calendar-occurrence-overrides.js';
import {
  expandAndResolveEventRows, expandRecurringEvents, MAX_EXPANSION_ITERATIONS,
} from '../server/services/calendar-events.js';
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
  database.exec(`
    ALTER TABLE calendar_events ADD COLUMN countdown INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE calendar_events ADD COLUMN attachment_name TEXT;
    ALTER TABLE calendar_events ADD COLUMN attachment_mime TEXT;
    ALTER TABLE calendar_events ADD COLUMN attachment_size INTEGER;
    ALTER TABLE calendar_events ADD COLUMN attachment_data TEXT;
    ALTER TABLE calendar_events ADD COLUMN attachment_document_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN calendar_ref_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN subscription_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN external_object_url TEXT;
    ALTER TABLE calendar_events ADD COLUMN target_google_calendar_id TEXT;
    ALTER TABLE calendar_events ADD COLUMN target_caldav_account_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN target_caldav_calendar_url TEXT;
    ALTER TABLE calendar_events ADD COLUMN target_outlook_account_id INTEGER;
    ALTER TABLE calendar_events ADD COLUMN target_outlook_calendar_id TEXT;
    ALTER TABLE calendar_events ADD COLUMN tzid TEXT;
    CREATE TABLE reminders (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id INTEGER NOT NULL,
      remind_at TEXT NOT NULL,
      dismissed INTEGER NOT NULL DEFAULT 0,
      created_by INTEGER NOT NULL,
      assigned_from INTEGER
    );
  `);
  database.prepare(`
    INSERT INTO users (id, username, display_name, password_hash, role)
    VALUES (1, 'admin', 'Admin', 'x', 'admin'),
           (2, 'member', 'Member', 'x', 'member'),
           (3, 'other', 'Other', 'x', 'member')
  `).run();
  return database;
}

function insertEvent(database, values = {}) {
  return database.prepare(`
    INSERT INTO calendar_events (
      title, description, start_datetime, end_datetime, assigned_to, created_by, recurrence_rule,
      recurrence_parent_id, recurrence_id, overridden_fields, external_source,
      external_calendar_id, visibility
    ) VALUES (
      @title, @description, @start_datetime, @end_datetime, @assigned_to, @created_by, @recurrence_rule,
      @recurrence_parent_id, @recurrence_id, @overridden_fields, @external_source,
      @external_calendar_id, @visibility
    )
  `).run({
    title: 'Event',
    description: null,
    start_datetime: '2026-10-31T09:00:00',
    end_datetime: null,
    assigned_to: null,
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

test('daily recurrence identity reaches a valid slot after one thousand occurrences', () => {
  const master = series({
    start_datetime: '2026-01-01T09:00',
    end_datetime: '2026-01-01T10:00',
  });
  assert.equal(expandRecurringEvents([master], '2028-09-28', '2028-09-28').length, 0);
  const base = baseOccurrenceFor(master, '2028-09-28');

  assert.equal(base.recurrence_identity, '2028-09-28');
  assert.equal(base.start_datetime, '2028-09-28T09:00');
  assert.equal(base.end_datetime, '2028-09-28T10:00');
});

test('weekly BYDAY interval identity reaches a bounded long-running slot', () => {
  const master = series({
    start_datetime: '2020-01-06T09:00',
    end_datetime: '2020-01-06T10:00',
    recurrence_rule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE',
  });
  const base = baseOccurrenceFor(master, '2039-12-12');

  assert.equal(base.recurrence_identity, '2039-12-12');
  assert.equal(base.start_datetime, '2039-12-12T09:00');
  assert.equal(base.end_datetime, '2039-12-12T10:00');
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

test('single and batch resolution inherit real parent assignment presentation', () => {
  const database = createDatabase();
  const parentId = Number(insertSeries(database, {
    assigned_to: 2,
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(parentId, 2);
  const childId = Number(insertEvent(database, {
    assigned_to: 1,
    recurrence_parent_id: parentId,
    recurrence_id: '2026-10-02',
    overridden_fields: '["title"]',
  }));
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(childId, 1);
  const childRow = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(childId);
  const unprojectedParent = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(parentId);

  for (const resolved of [
    resolveOccurrence(database, childRow),
    resolveOccurrence(database, childRow, unprojectedParent),
    resolveEventRows(database, [childRow])[0],
  ]) {
    const serialized = serializeEvent(resolved, { database, actorId: 1, isAdmin: false });
    assert.equal(serialized.assigned_to, 2);
    assert.equal(serialized.assigned_name, 'Member');
    assert.equal(serialized.assigned_color, '#007AFF');
    assert.deepEqual(serialized.assigned_users, [{
      id: 2,
      display_name: 'Member',
      color: '#007AFF',
      avatar_data: null,
    }]);
    assert.equal(serialized.assignment_owner_id, parentId);
  }
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

test('shared range reader replaces an EXDATE slot with its moved linked occurrence', () => {
  const database = createDatabase();
  const parentId = Number(insertSeries(database, {
    title: 'Current series title',
    description: 'Current inherited description',
    start_datetime: '2026-10-31T09:00:00',
    end_datetime: '2026-10-31T10:00:00',
    recurrence_rule: 'FREQ=DAILY;COUNT=3',
  }));
  const childId = Number(insertEvent(database, {
    title: 'Moved override',
    description: 'Stale materialized description',
    start_datetime: '2026-11-04T11:00:00',
    end_datetime: '2026-11-04T12:00:00',
    recurrence_parent_id: parentId,
    recurrence_id: '2026-10-31',
    overridden_fields: '["title","start_datetime","end_datetime","attachment","reminders"]',
  }));
  database.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date)
    VALUES (?, '2026-10-31')
  `).run(parentId);

  const masters = database.prepare(`
    SELECT * FROM calendar_events
    WHERE recurrence_rule IS NOT NULL AND DATE(start_datetime) <= '2026-11-05'
  `).all();
  const movedChildren = loadLinkedOverrides(database, [parentId], '2026-11-01', '2026-11-05');
  const rows = expandAndResolveEventRows(
    database,
    [...masters, ...movedChildren],
    '2026-11-01',
    '2026-11-05',
  );
  const moved = rows.find((row) => Number(row.id) === childId);

  assert.ok(moved, 'the displayed-range child must be present');
  assert.equal(moved.title, 'Moved override');
  assert.equal(moved.description, 'Current inherited description');
  assert.equal(moved.start_datetime, '2026-11-04T11:00:00');
  assert.equal(moved.series_id, parentId);
  assert.equal(moved.recurrence_id, '2026-10-31');
  assert.equal(moved.attachment_owner_id, childId);
  assert.equal(moved.reminder_owner_id, childId);
  assert.equal(rows.some((row) => Number(row.id) === parentId
    && row.recurrence_identity === '2026-10-31'), false,
  'the master EXDATE must suppress the original slot');
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

test('occurrence upsert is idempotent and stores one child with one EXDATE', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Daily standup',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const options = {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    isAdmin: false,
    changes: { title: 'Delayed standup' },
  };

  upsertOccurrenceOverride(database, options);
  upsertOccurrenceOverride(database, options);

  const children = database.prepare(`
    SELECT recurrence_id, overridden_fields, title
    FROM calendar_events
    WHERE recurrence_parent_id = ?
  `).all(seriesId).map((row) => ({ ...row }));
  assert.deepEqual(children, [{
    recurrence_id: '2026-10-02',
    overridden_fields: '["title"]',
    title: 'Delayed standup',
  }]);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM calendar_event_exceptions
    WHERE event_id = ? AND exception_date = ?
  `).get(seriesId, '2026-10-02').count, 1);
});

test('occurrence child and EXDATE roll back together', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.exec(`
    CREATE TRIGGER fail_occurrence_exception
    BEFORE INSERT ON calendar_event_exceptions
    BEGIN SELECT RAISE(ABORT, 'probe'); END;
  `);

  assert.throws(() => upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    isAdmin: false,
    changes: { title: 'Must roll back' },
  }), /probe/);

  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(seriesId).count, 0);
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(seriesId).count, 0);
});

test('saving no actual difference restores the expanded master occurrence', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Inherited title',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const options = {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    isAdmin: false,
  };

  upsertOccurrenceOverride(database, {
    ...options,
    changes: { title: 'Temporary title' },
  });
  const restored = upsertOccurrenceOverride(database, {
    ...options,
    changes: { title: 'Inherited title' },
  });

  assert.equal(restored.restored, true);
  assert.equal(restored.event.title, 'Inherited title');
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(seriesId).count, 0);
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM calendar_event_exceptions WHERE event_id = ?'
  ).get(seriesId).count, 0);
});

test('occurrence ownership markers control assignments reminders and attachments', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Owned fields',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    assigned_to: 1,
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('UPDATE calendar_events SET attachment_document_id = 100 WHERE id = ?').run(seriesId);
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)').run(seriesId, 1);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2026-09-30T09:00:00', 1)
  `).run(seriesId);

  const result = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    isAdmin: false,
    changes: {},
    assignments: [2],
    attachment: {
      attachment_name: 'occurrence.txt',
      attachment_mime: 'text/plain',
      attachment_size: 10,
      attachment_data: null,
      attachment_document_id: 200,
    },
    reminderOffsets: [60],
  });
  const childId = Number(result.event.id);
  const child = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(childId);

  assert.equal(child.overridden_fields, '["assignments","attachment","reminders"]');
  assert.equal(child.assigned_to, 2);
  assert.deepEqual(database.prepare(
    'SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id'
  ).all(childId).map((row) => row.user_id), [2]);
  assert.equal(child.attachment_document_id, 200);
  assert.deepEqual(database.prepare(`
    SELECT remind_at, created_by FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
  `).all(childId).map((row) => ({ ...row })), [{
    remind_at: '2026-10-02T08:00:00',
    created_by: 1,
  }, {
    remind_at: '2026-10-02T08:00:00',
    created_by: 2,
  }]);
  assert.equal(result.event.assignment_owner_id, childId);
  assert.equal(result.event.attachment_owner_id, childId);
  assert.equal(result.event.reminder_owner_id, childId);
});

test('restoring owned fields to series defaults removes child reminder rows', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Restored owned fields',
    start_datetime: '2026-10-01T09:00:00',
    assigned_to: 1,
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('UPDATE calendar_events SET attachment_document_id = 100 WHERE id = ?')
    .run(seriesId);
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1)')
    .run(seriesId);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2026-09-30T09:00:00', 1)
  `).run(seriesId);
  const options = {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
  };
  const childId = Number(upsertOccurrenceOverride(database, {
    ...options,
    assignments: [2],
    attachment: { attachment_document_id: 200 },
    reminderOffsets: [60],
  }).event.id);

  const restored = upsertOccurrenceOverride(database, {
    ...options,
    assignments: [1],
    attachment: { attachment_document_id: 100 },
    reminderOffsets: [1440],
  });

  assert.equal(restored.restored, true);
  assert.equal(database.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(childId), undefined);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
  `).get(childId).count, 0);
});

test('occurrence reminder ownership keeps inherited assignment projection and fanout', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Occurrence fanout',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1), (?, 2)')
    .run(seriesId, seriesId);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2026-10-01T08:30:00', 1)
  `).run(seriesId);

  const childId = Number(upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    reminderOffsets: [60],
  }).event.id);

  assert.deepEqual(database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(childId).map((row) => row.user_id), [1, 2]);
  assert.deepEqual(database.prepare(`
    SELECT created_by, assigned_from, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? ORDER BY created_by
  `).all(childId).map((row) => ({ ...row })), [
    { created_by: 1, assigned_from: null, remind_at: '2026-10-02T08:00:00' },
    { created_by: 2, assigned_from: 1, remind_at: '2026-10-02T08:00:00' },
  ]);
});

test('only-this deletion removes a replacement but preserves its EXDATE', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  for (const recurrenceId of ['2026-10-02', '2026-10-03']) {
    upsertOccurrenceOverride(database, {
      seriesId,
      recurrenceId,
      actorId: 1,
      changes: { title: `Override ${recurrenceId}` },
    });
  }

  deleteOccurrence(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
  });

  assert.deepEqual(database.prepare(`
    SELECT recurrence_id FROM calendar_events
    WHERE recurrence_parent_id = ? ORDER BY recurrence_id
  `).all(seriesId).map((row) => row.recurrence_id), ['2026-10-03']);
  assert.deepEqual(database.prepare(`
    SELECT exception_date FROM calendar_event_exceptions
    WHERE event_id = ? ORDER BY exception_date
  `).all(seriesId).map((row) => row.exception_date), ['2026-10-02', '2026-10-03']);
});

test('following deletion truncates later state and delegates the first slot to whole deletion', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  for (const recurrenceId of ['2026-10-02', '2026-10-03']) {
    upsertOccurrenceOverride(database, {
      seriesId,
      recurrenceId,
      actorId: 1,
      changes: { title: `Override ${recurrenceId}` },
    });
  }
  database.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)
  `).run(seriesId, '2026-10-04');

  const truncated = truncateSeries(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
  });

  assert.equal(truncated.wholeSeries, false);
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY;UNTIL=20261002');
  assert.deepEqual(database.prepare(`
    SELECT recurrence_id FROM calendar_events
    WHERE recurrence_parent_id = ? ORDER BY recurrence_id
  `).all(seriesId).map((row) => row.recurrence_id), ['2026-10-02']);
  assert.deepEqual(database.prepare(`
    SELECT exception_date FROM calendar_event_exceptions
    WHERE event_id = ? ORDER BY exception_date
  `).all(seriesId).map((row) => row.exception_date), ['2026-10-02']);

  const wholeId = Number(insertSeries(database, {
    start_datetime: '2026-11-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  upsertOccurrenceOverride(database, {
    seriesId: wholeId,
    recurrenceId: '2026-11-02',
    actorId: 1,
    changes: { title: 'Cascades with parent' },
  });
  const whole = truncateSeries(database, {
    seriesId: wholeId,
    recurrenceId: '2026-11-01',
    actorId: 1,
  });
  assert.equal(whole.wholeSeries, true);
  assert.equal(database.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(wholeId), undefined);
});

test('following edit splits, reparents and recomputes replacement markers', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Old title',
    description: 'Old description',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'New title' },
  });
  upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    changes: { description: 'Third-day note' },
  });
  database.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)
  `).run(seriesId, '2026-10-04');

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: {
      title: 'New title',
      start_datetime: '2026-10-02T09:00:00',
      end_datetime: '2026-10-02T10:00:00',
      recurrence_rule: 'FREQ=DAILY',
    },
  });
  const successorId = Number(result.series.id);

  assert.notEqual(successorId, seriesId);
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY;UNTIL=20261001');
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events
    WHERE recurrence_parent_id = ? AND recurrence_id = '2026-10-02'
  `).get(successorId).count, 0, 'the selected replacement became successor defaults');
  const future = database.prepare(`
    SELECT title, description, overridden_fields, recurrence_parent_id
    FROM calendar_events WHERE recurrence_id = '2026-10-03'
  `).get();
  assert.equal(Number(future.recurrence_parent_id), successorId);
  assert.equal(future.title, 'New title');
  assert.equal(future.description, 'Third-day note');
  assert.equal(future.overridden_fields, '["description"]');
  for (const child of database.prepare(`
    SELECT * FROM calendar_events WHERE recurrence_parent_id = ?
  `).all(successorId)) {
    assert.doesNotThrow(() => resolveOccurrence(database, child, result.series));
  }
  assert.deepEqual(database.prepare(`
    SELECT exception_date FROM calendar_event_exceptions
    WHERE event_id = ? ORDER BY exception_date
  `).all(successorId).map((row) => row.exception_date), ['2026-10-03', '2026-10-04']);
});

test('following edit absorbs the selected replacement even when its new defaults differ', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Original default',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const selected = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'Selected old value' },
    reminderOffsets: [15],
  }).event;

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: {
      title: 'Successor new default',
      recurrence_rule: 'FREQ=DAILY',
    },
    reminderOffsets: [30],
  });
  const successorId = Number(result.series.id);

  assert.equal(database.prepare('SELECT title FROM calendar_events WHERE id = ?')
    .get(successorId).title, 'Successor new default');
  assert.equal(database.prepare('SELECT 1 FROM calendar_events WHERE id = ?')
    .get(selected.id), undefined);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events
    WHERE recurrence_parent_id = ? AND recurrence_id = '2026-10-02'
  `).get(successorId).count, 0);
  assert.deepEqual(database.prepare(`
    SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
  `).all(successorId).map((row) => row.remind_at), ['2026-10-02T08:30:00']);
});

test('following edit rolls back when a moved anchor invalidates a future child', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Moved split anchor',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'Selected child' },
  });
  const future = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    changes: { description: 'Future child' },
  }).event;

  assert.throws(() => splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: {
      start_datetime: '2026-11-02T09:00:00',
      recurrence_rule: 'FREQ=DAILY',
    },
  }), (error) => error instanceof CalendarOccurrenceError
    && error.code === 'invalid_successor_override');
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY');
  assert.equal(database.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(future.id).recurrence_parent_id, seriesId);
  assert.doesNotThrow(() => resolveOccurrence(
    database,
    database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(future.id),
    database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(seriesId),
  ));
});

test('following edit rolls back when a changed rule excludes a future child', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Changed split rule',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const future = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    changes: { title: 'Saturday child' },
  }).event;

  assert.throws(() => splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=FR' },
  }), (error) => error instanceof CalendarOccurrenceError
    && error.code === 'invalid_successor_override');
  assert.equal(database.prepare('SELECT recurrence_parent_id FROM calendar_events WHERE id = ?')
    .get(future.id).recurrence_parent_id, seriesId);
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY');
});

test('following edit preserves timezone and the remaining unchanged COUNT', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Finite Prague series',
    start_datetime: '2026-10-24T07:00:00Z',
    recurrence_rule: 'FREQ=DAILY;COUNT=5',
  }));
  database.prepare('UPDATE calendar_events SET tzid = ? WHERE id = ?')
    .run('Europe/Prague', seriesId);

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-26',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=DAILY;COUNT=5' },
  });
  const successor = database.prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(result.series.id);
  assert.equal(successor.tzid, 'Europe/Prague');
  assert.equal(successor.recurrence_rule, 'FREQ=DAILY;COUNT=3');
  const oldMaster = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(seriesId);
  const oldRows = expandRecurringEvents([oldMaster], '2026-10-01', '2026-11-10', new Map());
  const newRows = expandRecurringEvents([successor], '2026-10-01', '2026-11-10', new Map());
  assert.equal(oldRows.length + newRows.length, 5);
});

test('following edit preserves COUNT beyond the default expansion limit', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Long finite series',
    start_datetime: '2026-01-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY;COUNT=1500',
  }));

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2028-09-27',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=DAILY;COUNT=1500' },
  });
  const oldMaster = database.prepare('SELECT * FROM calendar_events WHERE id = ?').get(seriesId);
  const successor = database.prepare('SELECT * FROM calendar_events WHERE id = ?')
    .get(result.series.id);

  assert.equal(successor.recurrence_rule, 'FREQ=DAILY;COUNT=500');
  const expansionOptions = { maxIterations: MAX_EXPANSION_ITERATIONS };
  const oldRows = expandRecurringEvents(
    [oldMaster], '2026-01-01', '2030-12-31', new Map(), expansionOptions,
  );
  const newRows = expandRecurringEvents(
    [successor], '2026-01-01', '2030-12-31', new Map(), expansionOptions,
  );
  assert.equal(oldRows.length, 1000);
  assert.equal(newRows.length, 500);
  assert.equal(oldRows.length + newRows.length, 1500);
});

test('following edit honors an explicitly changed successor COUNT', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY;COUNT=5',
  }));
  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=DAILY;COUNT=4' },
  });
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(result.series.id).recurrence_rule, 'FREQ=DAILY;COUNT=4');
});

test('following edit drops deletion-only exceptions excluded by the successor rule', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)
  `).run(seriesId, '2026-10-03');
  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=FR' },
  });
  assert.deepEqual(database.prepare(`
    SELECT exception_date FROM calendar_event_exceptions WHERE event_id = ?
  `).all(result.series.id), []);
});

test('following edit preserves selected and future occurrence-owned attachments and reminders', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Owned split state',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  const selected = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    attachment: {
      attachment_name: 'selected.txt',
      attachment_mime: 'text/plain',
      attachment_size: 8,
      attachment_data: null,
      attachment_document_id: 100,
    },
    reminderOffsets: [30],
  }).event;
  const future = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    attachment: {
      attachment_name: 'future.txt',
      attachment_mime: 'text/plain',
      attachment_size: 6,
      attachment_data: null,
      attachment_document_id: 200,
    },
    reminderOffsets: [15],
  }).event;

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=DAILY' },
  });
  const successorId = Number(result.series.id);

  assert.equal(database.prepare('SELECT 1 FROM calendar_events WHERE id = ?').get(selected.id), undefined);
  assert.deepEqual({ ...database.prepare(`
    SELECT attachment_document_id, attachment_name FROM calendar_events WHERE id = ?
  `).get(successorId) }, {
    attachment_document_id: 100,
    attachment_name: 'selected.txt',
  });
  assert.deepEqual(database.prepare(`
    SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
  `).all(successorId).map((row) => row.remind_at), ['2026-10-02T08:30:00']);
  assert.deepEqual({ ...database.prepare(`
    SELECT recurrence_parent_id, attachment_document_id, overridden_fields
    FROM calendar_events WHERE id = ?
  `).get(future.id) }, {
    recurrence_parent_id: successorId,
    attachment_document_id: 200,
    overridden_fields: '["attachment","reminders"]',
  });
  assert.deepEqual(database.prepare(`
    SELECT remind_at FROM reminders WHERE entity_type = 'event' AND entity_id = ?
  `).all(future.id).map((row) => row.remind_at), ['2026-10-03T08:45:00']);
});

test('following edit refreshes future inherited projections and shifts owned reminders', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Projected split state',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    assigned_to: 1,
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('UPDATE calendar_events SET attachment_document_id = 100 WHERE id = ?')
    .run(seriesId);
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1)')
    .run(seriesId);
  const future = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-03',
    actorId: 1,
    changes: { description: 'Future owned note' },
    reminderOffsets: [30],
  }).event;

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: {
      start_datetime: '2026-10-02T10:00:00',
      end_datetime: '2026-10-02T11:00:00',
      recurrence_rule: 'FREQ=DAILY',
    },
    assignments: [2],
    attachment: { attachment_document_id: 200 },
  });
  const successorId = Number(result.series.id);

  assert.deepEqual({ ...database.prepare(`
    SELECT recurrence_parent_id, description, start_datetime, assigned_to,
           attachment_document_id, overridden_fields
    FROM calendar_events WHERE id = ?
  `).get(future.id) }, {
    recurrence_parent_id: successorId,
    description: 'Future owned note',
    start_datetime: '2026-10-03T10:00:00',
    assigned_to: 2,
    attachment_document_id: 200,
    overridden_fields: '["description","reminders"]',
  });
  assert.deepEqual(database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(future.id).map((row) => row.user_id), [2]);
  assert.deepEqual(database.prepare(`
    SELECT remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? AND assigned_from IS NULL
  `).all(future.id).map((row) => row.remind_at), ['2026-10-03T09:30:00']);
});

test('following edit from the first slot applies whole-series owned fields', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'First-slot split',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1)')
    .run(seriesId);

  const result = splitSeries(database, {
    seriesId,
    recurrenceId: '2026-10-01',
    actorId: 1,
    changes: { title: 'Updated whole series' },
    assignments: [2],
    attachment: { attachment_document_id: 200 },
    reminderOffsets: [30],
  });

  assert.equal(result.wholeSeries, true);
  assert.equal(Number(result.series.id), seriesId);
  assert.deepEqual({ ...database.prepare(`
    SELECT title, assigned_to, attachment_document_id FROM calendar_events WHERE id = ?
  `).get(seriesId) }, {
    title: 'Updated whole series',
    assigned_to: 2,
    attachment_document_id: 200,
  });
  assert.deepEqual(database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(seriesId).map((row) => row.user_id), [2]);
  assert.deepEqual(database.prepare(`
    SELECT created_by, assigned_from, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? ORDER BY created_by
  `).all(seriesId).map((row) => ({ ...row })), [
    { created_by: 1, assigned_from: null, remind_at: '2026-10-01T08:30:00' },
    { created_by: 2, assigned_from: 1, remind_at: '2026-10-01T08:30:00' },
  ]);
});

test('rule changes require an exact orphan count and clean deletion-only exceptions', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  for (const recurrenceId of ['2026-10-02', '2026-10-08']) {
    upsertOccurrenceOverride(database, {
      seriesId,
      recurrenceId,
      actorId: 1,
      changes: { title: `Override ${recurrenceId}` },
    });
  }
  database.prepare(`
    INSERT INTO calendar_event_exceptions (event_id, exception_date) VALUES (?, ?)
  `).run(seriesId, '2026-10-04');

  const options = {
    seriesId,
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' },
  };
  for (const confirmedOrphanCount of [undefined, 0]) {
    assert.throws(() => updateSeriesWithOverrides(database, {
      ...options,
      confirmedOrphanCount,
    }), (error) => error instanceof CalendarOccurrenceError
      && error.status === 409
      && error.code === 'calendar_override_orphans'
      && error.orphanedOverrideCount === 1);
  }

  const updated = updateSeriesWithOverrides(database, {
    ...options,
    confirmedOrphanCount: 1,
  });
  assert.equal(updated.orphanedOverrideCount, 1);
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=WEEKLY;BYDAY=TH');
  const detached = database.prepare(`
    SELECT recurrence_parent_id, recurrence_id, overridden_fields
    FROM calendar_events WHERE title = 'Override 2026-10-02'
  `).get();
  assert.deepEqual({ ...detached }, {
    recurrence_parent_id: null,
    recurrence_id: null,
    overridden_fields: null,
  });
  assert.equal(database.prepare(`
    SELECT recurrence_parent_id FROM calendar_events WHERE title = 'Override 2026-10-08'
  `).get().recurrence_parent_id, seriesId);
  assert.deepEqual(database.prepare(`
    SELECT exception_date FROM calendar_event_exceptions
    WHERE event_id = ? ORDER BY exception_date
  `).all(seriesId).map((row) => row.exception_date), ['2026-10-08']);
});

test('a supplied orphan confirmation must equal a recomputed zero count', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Restored before confirmation',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'Temporary difference' },
  });
  upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'Restored before confirmation' },
  });

  assert.throws(() => updateSeriesWithOverrides(database, {
    seriesId,
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' },
    confirmedOrphanCount: 1,
  }), (error) => error instanceof CalendarOccurrenceError
    && error.status === 409
    && error.orphanedOverrideCount === 0);
  assert.equal(database.prepare('SELECT recurrence_rule FROM calendar_events WHERE id = ?')
    .get(seriesId).recurrence_rule, 'FREQ=DAILY');

  const accepted = updateSeriesWithOverrides(database, {
    seriesId,
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' },
    confirmedOrphanCount: 0,
  });
  assert.equal(accepted.orphanedOverrideCount, 0);
});

test('outbound target detachment uses the same exact-count confirmation', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  for (const recurrenceId of ['2026-10-02', '2026-10-03']) {
    upsertOccurrenceOverride(database, {
      seriesId,
      recurrenceId,
      actorId: 1,
      changes: { title: `Target override ${recurrenceId}` },
    });
  }
  const options = {
    seriesId,
    actorId: 1,
    changes: { target_google_calendar_id: 'family@test' },
  };

  assert.throws(() => updateSeriesWithOverrides(database, options), (error) =>
    error instanceof CalendarOccurrenceError
    && error.status === 409
    && error.orphanedOverrideCount === 2
  );
  assert.equal(database.prepare('SELECT target_google_calendar_id FROM calendar_events WHERE id = ?')
    .get(seriesId).target_google_calendar_id, null);

  updateSeriesWithOverrides(database, { ...options, confirmedOrphanCount: 2 });
  assert.equal(database.prepare('SELECT target_google_calendar_id FROM calendar_events WHERE id = ?')
    .get(seriesId).target_google_calendar_id, 'family@test');
  assert.equal(database.prepare(
    'SELECT COUNT(*) AS count FROM calendar_events WHERE recurrence_parent_id = ?'
  ).get(seriesId).count, 0);
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM calendar_events
    WHERE title LIKE 'Target override %' AND recurrence_parent_id IS NULL
  `).get().count, 2);
});

test('orphan detachment reconciles inherited reminder fan-out with owned assignments', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Reminder detach source',
    start_datetime: '2026-10-01T09:00:00',
    recurrence_rule: 'FREQ=DAILY',
    assigned_to: 1,
  }));
  database.prepare(`
    INSERT INTO event_assignments (event_id, user_id) VALUES (?, 1), (?, 2)
  `).run(seriesId, seriesId);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, '2026-10-01T08:00:00', 1, NULL),
           ('event', ?, '2026-10-01T08:00:00', 2, 1)
  `).run(seriesId, seriesId);
  const child = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { title: 'Detached occurrence' },
    assignments: [1, 3],
  }).event;
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by, assigned_from)
    VALUES ('event', ?, '2026-10-02T07:30:00', 3, NULL)
  `).run(child.id);

  updateSeriesWithOverrides(database, {
    seriesId,
    actorId: 1,
    changes: { recurrence_rule: 'FREQ=WEEKLY;BYDAY=TH' },
    confirmedOrphanCount: 1,
  });

  assert.deepEqual(database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(child.id).map((row) => row.user_id), [1, 3]);
  assert.deepEqual(database.prepare(`
    SELECT created_by, assigned_from, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ?
    ORDER BY created_by, remind_at
  `).all(child.id).map((row) => ({ ...row })), [
    { created_by: 1, assigned_from: null, remind_at: '2026-10-02T08:00:00' },
    { created_by: 3, assigned_from: null, remind_at: '2026-10-02T07:30:00' },
  ]);
});

test('whole-series updates refresh inherited child projections and assignments atomically', () => {
  const database = createDatabase();
  const seriesId = Number(insertSeries(database, {
    title: 'Old projected title',
    start_datetime: '2026-10-01T09:00:00',
    end_datetime: '2026-10-01T10:00:00',
    recurrence_rule: 'FREQ=DAILY',
  }));
  database.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, ?)')
    .run(seriesId, 1);
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by)
    VALUES ('event', ?, '2026-10-01T08:00:00', 1)
  `).run(seriesId);
  const child = upsertOccurrenceOverride(database, {
    seriesId,
    recurrenceId: '2026-10-02',
    actorId: 1,
    changes: { description: 'Owned note' },
    reminderOffsets: [30],
  }).event;

  updateSeriesWithOverrides(database, {
    seriesId,
    actorId: 1,
    changes: {
      title: 'New projected title',
      start_datetime: '2026-10-01T10:00:00',
      end_datetime: '2026-10-01T11:00:00',
    },
    applyUpdate(db) {
      db.prepare(`
        UPDATE calendar_events
        SET title = 'New projected title',
            start_datetime = '2026-10-01T10:00:00',
            end_datetime = '2026-10-01T11:00:00',
            assigned_to = 2
        WHERE id = ?
      `).run(seriesId);
      db.prepare('DELETE FROM event_assignments WHERE event_id = ?').run(seriesId);
      db.prepare('INSERT INTO event_assignments (event_id, user_id) VALUES (?, 2)').run(seriesId);
    },
  });

  const projected = database.prepare(`
    SELECT title, description, start_datetime, end_datetime, assigned_to, overridden_fields
    FROM calendar_events WHERE id = ?
  `).get(child.id);
  assert.deepEqual({ ...projected }, {
    title: 'New projected title',
    description: 'Owned note',
    start_datetime: '2026-10-02T10:00:00',
    end_datetime: '2026-10-02T11:00',
    assigned_to: 2,
    overridden_fields: '["description","reminders"]',
  });
  assert.deepEqual(database.prepare(`
    SELECT user_id FROM event_assignments WHERE event_id = ? ORDER BY user_id
  `).all(child.id).map((row) => row.user_id), [2]);
  assert.deepEqual(database.prepare(`
    SELECT created_by, assigned_from, remind_at FROM reminders
    WHERE entity_type = 'event' AND entity_id = ? ORDER BY created_by
  `).all(child.id).map((row) => ({ ...row })), [
    { created_by: 1, assigned_from: null, remind_at: '2026-10-02T09:30:00' },
    { created_by: 2, assigned_from: 1, remind_at: '2026-10-02T09:30:00' },
  ]);
});
