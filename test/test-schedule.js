process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { get } from '../server/db.js';
import scheduleRouter, { isStillReferenced } from '../server/routes/schedule.js';
import { cyclePosition, resolveEntries } from '../server/services/schedule.js';

const database = get();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('schedule-alice', 'Alice', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('schedule-bob', 'Bob', 'x', 'member')").run();
database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('schedule-admin', 'Admin', 'x', 'admin')").run();

const ALICE = { id: 1, role: 'member' };
const BOB = { id: 2, role: 'member' };
const ADMIN = { id: 3, role: 'admin' };
const typeId = database.prepare("INSERT INTO schedule_shift_types (name, start_time, end_time, color) VALUES ('Early', '06:00', '14:00', '#6C3AED')").run().lastInsertRowid;
const patternId = database.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length) VALUES (1, 'Eight day', '2026-09-01', 8)").run().lastInsertRowid;
database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, ?, ?)').run(patternId, 7, typeId);

const patterns = () => database.prepare('SELECT * FROM schedule_patterns WHERE user_id = 1').all();
const days = () => new Map(database.prepare('SELECT * FROM schedule_pattern_days').all().map((row) => [`${row.pattern_id}:${row.position}`, row]));
function resolve(from, to, overrides = database.prepare('SELECT * FROM schedule_overrides WHERE user_id = 1').all()) {
  return resolveEntries({ from, to, userId: 1, patterns: patterns(), patternDays: days(), overrides });
}

test('cycle position handles dates before the anchor', () => {
  assert.equal(cyclePosition('2026-09-01', 8, '2026-08-31'), 7);
  assert.equal(resolve('2026-08-31', '2026-08-31').entries[0].shift_type_id, typeId);
});

test('a NULL override explicitly makes a scheduled day free and deleting it restores the pattern', () => {
  database.prepare('INSERT INTO schedule_overrides (user_id, date_key, shift_type_id) VALUES (1, ?, NULL)').run('2026-09-01');
  assert.equal(resolve('2026-09-01', '2026-09-01').entries[0].is_free, true);
  database.prepare('DELETE FROM schedule_overrides WHERE user_id = 1 AND date_key = ?').run('2026-09-01');
  assert.equal(resolve('2026-09-01', '2026-09-01').entries[0].source, 'pattern');
});

test('override beats pattern, and a pattern beats nothing', () => {
  const result = resolveEntries({
    from: '2026-10-01', to: '2026-10-01', userId: 1,
    patterns: [{ id: 44, anchor_date: '2026-10-01', cycle_length: 1, valid_from: null, valid_until: null }],
    patternDays: new Map([['44:0', { shift_type_id: typeId }]]),
    overrides: [{ id: 55, date_key: '2026-10-01', shift_type_id: null, note: 'Vacation' }],
  });
  assert.equal(result.entries[0].source, 'override');
  assert.equal(result.entries[0].is_free, true);
  const noPattern = resolveEntries({ from: '2026-10-01', to: '2026-10-01', userId: 1, patterns: [], patternDays: new Map(), overrides: [] });
  assert.deepEqual(noPattern.entries, []);
});

test('a referenced shift type cannot be deleted', () => {
  assert.throws(() => database.prepare('DELETE FROM schedule_shift_types WHERE id = ?').run(typeId));
});

test('calendar day arithmetic remains stable across DST', () => {
  assert.equal(cyclePosition('2026-03-27', 8, '2026-03-30'), 3);
});

let actor = ALICE;
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', scheduleRouter);
const server = app.listen(0);
const baseUrl = await new Promise((resolveServer) => server.on('listening', () => resolveServer(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, { as = ALICE, body } = {}) {
  actor = as;
  const headers = body === undefined ? {} : { 'Content-Type': 'application/json' };
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, body: contentType.includes('application/json') ? await response.json() : null };
}

test('entries are household-readable, include type data, and never materialize calendar events', async () => {
  const nightType = database.prepare("INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color) VALUES ('Night', 'N', '22:00', '06:00', '#123456')").run().lastInsertRowid;
  const bobPattern = database.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length) VALUES (2, 'Nights', '2026-10-01', 1)").run().lastInsertRowid;
  database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)').run(bobPattern, nightType);
  const before = database.prepare('SELECT count(*) AS count FROM calendar_events').get().count;
  const response = await call('GET', '/entries?from=2026-10-01&to=2026-10-01', { as: ALICE });
  assert.equal(response.status, 200);
  const entry = response.body.data.entries.find((item) => item.user_id === BOB.id);
  assert.equal(entry.date_key, '2026-10-01', 'overnight shift remains on its start day');
  assert.equal(entry.shift_type.short_code, 'N');
  assert.equal(entry.crosses_midnight, true);
  const fullDayType = database.prepare("INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color) VALUES ('Full day', '24', '10:00', '10:00', '#654321')").run().lastInsertRowid;
  const fullDayPattern = database.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length) VALUES (2, 'Full day', '2026-10-02', 1)").run().lastInsertRowid;
  database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)').run(fullDayPattern, fullDayType);
  const fullDay = await call('GET', '/entries?from=2026-10-02&to=2026-10-02&user_id=2', { as: ALICE });
  assert.equal(fullDay.body.data.entries[0].crosses_midnight, true, 'equal start/end is a 24-hour shift');
  assert.equal(database.prepare('SELECT count(*) AS count FROM calendar_events').get().count, before);
});

test('members may write only themselves while admins may write any household schedule', async () => {
  const body = { user_id: BOB.id, name: 'Blocked', anchor_date: '2026-11-01', cycle_length: 7, is_active: true };
  const denied = await call('POST', '/patterns', { as: ALICE, body });
  assert.equal(denied.status, 403);
  const allowed = await call('POST', '/patterns', { as: ADMIN, body: { ...body, name: 'Admin pattern', is_active: false } });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.body.data.is_active, 0);
  const self = await call('PUT', '/overrides/2026-11-03', { as: ALICE, body: { user_id: ALICE.id, shift_type_id: null, note: 'Vacation' } });
  assert.equal(self.status, 200);
  const foreign = await call('PUT', '/overrides/2026-11-03', { as: ALICE, body: { user_id: BOB.id, shift_type_id: null } });
  assert.equal(foreign.status, 403);
});

// A shift type belongs to the household, not to a person: it shows up in every
// member's pattern. Anyone may add one - that takes nothing away from anybody -
// but renaming or deleting one is the owner's call, or an admin's. Without this
// any member could rename the family's early shift, and the delete went through
// on nothing but a valid id.
// `dateKeysInRange()` builds one string per day and `resolveEntries()` walks it
// once per household member, synchronously. `from=1000-01-01&to=9999-12-31` is
// roughly 3.3 million days - any signed-in member, or a token scoped to
// schedule:read, could have stalled the server with a single GET.
test('the entries range is capped, and the cap names itself', async () => {
  const huge = await call('GET', '/entries?from=1000-01-01&to=9999-12-31', { as: ALICE });
  assert.equal(huge.status, 400);
  assert.match(huge.body.error, /731 days/);

  // The boundary itself is inclusive on both ends: 731 keys, not 732.
  const atCap = await call('GET', '/entries?from=2026-01-01&to=2028-01-01', { as: ALICE });
  assert.equal(atCap.status, 200, '731 days must still be allowed');

  const overCap = await call('GET', '/entries?from=2026-01-01&to=2028-01-02', { as: ALICE });
  assert.equal(overCap.status, 400, '732 days must not');
});

test('a shift type may be added by anyone but only changed by its creator or an admin', async () => {
  const created = await call('POST', '/shift-types', { as: ALICE, body: { name: 'Standby', start_time: '18:00', end_time: '20:00' } });
  assert.equal(created.status, 201, 'every member may add a shift type');
  const shiftId = created.body.data.id;
  assert.equal(created.body.data.created_by, ALICE.id, 'the creator is recorded');

  const foreignRename = await call('PUT', `/shift-types/${shiftId}`, { as: BOB, body: { name: 'Renamed by Bob' } });
  assert.equal(foreignRename.status, 403, 'a member does not rename the household shift type');

  const foreignDelete = await call('DELETE', `/shift-types/${shiftId}`, { as: BOB });
  assert.equal(foreignDelete.status, 403, 'nor delete it');

  const ownRename = await call('PUT', `/shift-types/${shiftId}`, { as: ALICE, body: { name: 'Standby late' } });
  assert.equal(ownRename.status, 200);
  assert.equal(ownRename.body.data.name, 'Standby late');

  const adminDelete = await call('DELETE', `/shift-types/${shiftId}`, { as: ADMIN });
  assert.equal(adminDelete.status, 204, 'an admin may clean up any shift type');
});

// A type still referenced by a pattern day is held by the foreign key. The 409
// has to come from THAT and not from any error at all - the branch used to
// catch everything and blame the same cause, so a broken statement would have
// told the caller the type was still in use.
// `color()` in validate.js answers a falsy input with {value: null, error: null},
// so an empty string passes validation and reaches the UPDATE - where the column
// is NOT NULL. The default does not apply to an explicitly bound NULL, so this
// used to surface as an unhandled constraint error and a bare 500. The POST
// handler sidesteps it with a default; PUT had no equivalent.
test('an empty color on PUT keeps the stored one instead of writing NULL', async () => {
  const created = await call('POST', '/shift-types', { as: ALICE, body: { name: 'Late', color: '#123456' } });
  const shiftId = created.body.data.id;

  for (const value of ['', null]) {
    const res = await call('PUT', `/shift-types/${shiftId}`, { as: ALICE, body: { color: value } });
    assert.equal(res.status, 200, `color: ${JSON.stringify(value)} must not blow up`);
    assert.equal(res.body.data.color, '#123456', 'the stored colour survives');
  }

  const bad = await call('PUT', `/shift-types/${shiftId}`, { as: ALICE, body: { color: 'rebeccapurple' } });
  assert.equal(bad.status, 400, 'a malformed colour is still rejected');

  await call('DELETE', `/shift-types/${shiftId}`, { as: ADMIN });
});

test('deleting a shift type that is still in use answers 409, and 404 stays 404', async () => {
  const inUse = await call('DELETE', `/shift-types/${typeId}`, { as: ADMIN });
  assert.equal(inUse.status, 409);
  assert.match(inUse.body.error, /in use/);
  assert.equal(database.prepare('SELECT count(*) AS count FROM schedule_pattern_days WHERE shift_type_id = ?').get(typeId).count, 1,
    'the refusal left the pattern day alone');

  const missing = await call('DELETE', '/shift-types/999999', { as: ADMIN });
  assert.equal(missing.status, 404, 'an unknown id is not "in use"');
});

// The status-code test above stays green either way - it measures the outcome,
// not the reason. This one asks the rule directly, so a catch-all can't pass
// itself off as a foreign-key check.
test('only a foreign-key refusal counts as "still in use"', () => {
  // Measured, not guessed: a refused ON DELETE RESTRICT arrives as
  // SQLITE_CONSTRAINT_TRIGGER even though its message says "FOREIGN KEY
  // constraint failed". A check for _FOREIGNKEY alone would miss every one.
  assert.equal(isStillReferenced({ code: 'SQLITE_CONSTRAINT_TRIGGER' }), true);
  assert.equal(isStillReferenced({ code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }), true);
  assert.equal(isStillReferenced({ code: 'SQLITE_CONSTRAINT' }), true);
  assert.equal(isStillReferenced({ code: 'SQLITE_ERROR' }), false, 'a broken statement is not a reference');
  assert.equal(isStillReferenced(new TypeError('undefined is not a function')), false);
  assert.equal(isStillReferenced(undefined), false);
});

test('schedule routes reject invalid shift times and return data envelopes', async () => {
  const invalid = await call('POST', '/shift-types', { as: ALICE, body: { name: 'Invalid', color: '#abcdef', start_time: '25:61', end_time: '26:00' } });
  assert.equal(invalid.status, 400);
  const listed = await call('GET', '/shift-types', { as: ALICE });
  assert.equal(listed.status, 200);
  assert.ok(Array.isArray(listed.body.data));
});


test('overlapping patterns return a warning and the newer valid_from pattern wins', async () => {
  const carol = database.prepare("INSERT INTO users (username, display_name, password_hash, role) VALUES ('schedule-carol', 'Carol', 'x', 'member')").run().lastInsertRowid;
  const newerType = database.prepare("INSERT INTO schedule_shift_types (name, short_code, start_time, end_time, color) VALUES ('Late audit', 'L', '14:00', '22:00', '#123abc')").run().lastInsertRowid;
  const oldPattern = database.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from) VALUES (?, 'Old audit', '2027-01-01', 1, '2027-01-01')").run(carol).lastInsertRowid;
  const newPattern = database.prepare("INSERT INTO schedule_patterns (user_id, name, anchor_date, cycle_length, valid_from) VALUES (?, 'New audit', '2027-01-15', 1, '2027-01-15')").run(carol).lastInsertRowid;
  database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)').run(oldPattern, typeId);
  database.prepare('INSERT INTO schedule_pattern_days (pattern_id, position, shift_type_id) VALUES (?, 0, ?)').run(newPattern, newerType);

  const response = await call('GET', '/entries?from=2027-01-20&to=2027-01-20&user_id=' + carol, { as: ALICE });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.entries[0].shift_type_id, Number(newerType));
  assert.deepEqual(response.body.data.warnings, [{ user_id: Number(carol), date_key: '2027-01-20', pattern_ids: [Number(newPattern), Number(oldPattern)] }]);
});

test('calendar defaults to compact Schedule strips, includes their start time, and keeps 24-hour shifts in their start-day strip', () => {
  const calendarPage = readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf8');
  assert.match(calendarPage, /scheduleDisplay: 'compact'/);
  assert.match(calendarPage, /schedule-entry__start/);
  assert.match(calendarPage, /function scheduleIsFullDayShift\(entry\)/);
  assert.match(calendarPage, /scheduleHasTimes\(entry\) && !scheduleIsFullDayShift\(entry\)/);
  assert.match(calendarPage, /!scheduleHasTimes\(entry\) \|\| scheduleIsFullDayShift\(entry\)/);
});


test('schedule statistics tab uses the computed entries API and includes overnight and 24-hour durations', () => {
  const schedulePage = readFileSync(new URL('../public/pages/schedule.js', import.meta.url), 'utf8');
  assert.match(schedulePage, /\['statistics', t\('schedule\.statistics'\)\]/);
  assert.match(schedulePage, /\/schedule\/entries\?from=/);
  assert.match(schedulePage, /if \(end <= start\) end \+= 24 \* 60/);
  assert.match(schedulePage, /monthBounds\(statistics\.monthFrom\)/);
  assert.match(schedulePage, /yuvomi-datepicker required name="from" type="date"/);
  const submitHandler = schedulePage.slice(schedulePage.indexOf('async function submitForm'), schedulePage.indexOf('async function action'));
  assert.match(submitHandler, /form\.dataset\.form === 'statistics'/);
  assert.match(submitHandler, /formValue\(form, 'from'/);
  assert.match(submitHandler, /await refreshStatistics\(\)/);
  assert.match(schedulePage, /schedule-stat-loading/);
  assert.match(schedulePage, /class="segmented schedule-stat-range__choices"/);
});


test('Schedule uses the full desktop module shell and responsive library/statistics grids', () => {
  const schedulePage = readFileSync(new URL('../public/pages/schedule.js', import.meta.url), 'utf8');
  const scheduleCss = readFileSync(new URL('../public/styles/schedule.css', import.meta.url), 'utf8');
  assert.doesNotMatch(schedulePage, /page-measure--narrow schedule-page/);
  // Die Wurzel traegt die Modulklasse; seit dem Kompositionssystem stehen die
  // Layout-Primitives daneben (app-page app-page--full). Geprueft wird die Sache -
  // die Seite ist als schedule-page ausgezeichnet -, nicht die Schreibweise, sonst
  // wird dieser Guard bei jeder korrekten Erweiterung des Wurzelmarkups rot.
  assert.match(schedulePage, /<div class=\"schedule-page(?:\s[^\"]*)?\"/);
  assert.match(schedulePage, /schedule-library--shifts/);
  assert.match(scheduleCss, /container: schedule-page \/ inline-size/);
  assert.match(scheduleCss, /@container schedule-page \(min-width: 720px\)/);
  assert.match(scheduleCss, /@container schedule-page \(min-width: 900px\)/);
  assert.match(scheduleCss, /schedule-stat-dates/);
});
