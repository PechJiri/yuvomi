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
  CalendarOccurrenceError,
  isEligibleLocalSeries,
  isLinkedOccurrence,
  OVERRIDE_FIELDS,
  parseOverrideFields,
  recurrenceIdFor,
  seriesIdFor,
} from '../server/services/calendar-occurrence-overrides.js';

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
      external_calendar_id
    ) VALUES (
      @title, @start_datetime, @end_datetime, @created_by, @recurrence_rule,
      @recurrence_parent_id, @recurrence_id, @overridden_fields, @external_source,
      @external_calendar_id
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
    ...values,
  }).lastInsertRowid;
}

function insertSeries(database, values = {}) {
  return insertEvent(database, { recurrence_rule: 'FREQ=MONTHLY', ...values });
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
