import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingDateKey, fastingDateKeyFactory, parseFastingDateRange } from '../server/services/fasting-dates.js';

test('date-only range parsing and formatting reject implausible years', () => {
  assert.deepEqual(parseFastingDateRange('1900-01-01', '2099-12-31', assert.fail), {
    from: '1900-01-01',
    to: '2099-12-31',
  });
  assert.equal(fastingDateKey('1900-01-01T00:00:00.000Z', 'UTC'), '1900-01-01');
  assert.throws(() => fastingDateKey('1900-01-01T00:00:00.000Z'), /timeZone/);
  assert.equal(fastingDateKey('2026-09-13T06:30:00.000Z', 'America/Los_Angeles'), '2026-09-12');
  const losAngelesDateKey = fastingDateKeyFactory('America/Los_Angeles');
  assert.equal(losAngelesDateKey('2026-09-13T06:30:00.000Z'), '2026-09-12');
  assert.equal(losAngelesDateKey('invalid'), null);
  assert.throws(() => parseFastingDateRange('1899-12-31', null, () => { throw new Error('invalid'); }), /invalid/);
  assert.throws(() => parseFastingDateRange('2026-02-29', null, () => { throw new Error('invalid'); }), /invalid/);
});
