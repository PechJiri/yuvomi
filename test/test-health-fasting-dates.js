import test from 'node:test';
import assert from 'node:assert/strict';
import { fastingDateKey, parseFastingDateRange } from '../server/services/fasting-dates.js';

test('date-only range parsing and formatting reject implausible years', () => {
  assert.deepEqual(parseFastingDateRange('1900-01-01', '2099-12-31', assert.fail), {
    from: '1900-01-01',
    to: '2099-12-31',
  });
  assert.equal(fastingDateKey('1900-01-01T00:00:00.000Z'), '1900-01-01');
  assert.throws(() => parseFastingDateRange('1899-12-31', null, () => { throw new Error('invalid'); }), /invalid/);
  assert.throws(() => parseFastingDateRange('2026-02-29', null, () => { throw new Error('invalid'); }), /invalid/);
});
