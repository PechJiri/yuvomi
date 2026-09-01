import test from 'node:test';
import assert from 'node:assert/strict';

const birthdays = await import('../public/pages/birthdays.js');
const { localizeBirthdayEvent } = await import('../public/utils/birthday-event.js');

test('detail osoby předvybere měsíc a den uloženého svátku', () => {
  assert.equal(typeof birthdays.renderNameDayField, 'function');
  const html = birthdays.renderNameDayField({ name_day: '05-24' });
  assert.match(html, /id="bd-name-day-month"/);
  assert.match(html, /id="bd-name-day-day"/);
  assert.match(html, /value="05" selected/);
  assert.match(html, /value="24" selected/);
  assert.match(html, /id="bd-name-day-clear"/);
});

test('výběr svátku vytváří kanonické MM-DD nebo prázdnou hodnotu', () => {
  assert.equal(typeof birthdays.normalizeNameDaySelection, 'function');
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('5', '3'),
    { value: '05-03', complete: true },
  );
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('', ''),
    { value: null, complete: true },
  );
  assert.deepEqual(
    birthdays.normalizeNameDaySelection('05', ''),
    { value: null, complete: false },
  );
});

test('únor nabízí 29 dní, duben 30 a leden 31', () => {
  assert.equal(typeof birthdays.daysInNameDayMonth, 'function');
  assert.equal(birthdays.daysInNameDayMonth('02'), 29);
  assert.equal(birthdays.daysInNameDayMonth('04'), 30);
  assert.equal(birthdays.daysInNameDayMonth('01'), 31);
});

test('odznak počítá blízké narozeniny i svátky jako samostatné události', () => {
  assert.equal(typeof birthdays.countBirthdaysSoon, 'function');
  assert.equal(birthdays.countBirthdaysSoon([
    { days_until: 2, name_day_days_until: 1 },
    { days_until: 10, name_day_days_until: 3 },
    { days_until: 20, name_day_days_until: null },
  ]), 3);
});

test('kalendář lokalizuje svátek jinými texty než narozeniny', () => {
  const localized = localizeBirthdayEvent({
    id: 17,
    birthday_name: 'Jiří',
    birthday_event_kind: 'name_day',
    title: 'stored title',
    description: 'stored description',
  });

  assert.match(localized.title, /^birthdays\.nameDayCalendarEventTitle/);
  assert.match(localized.description, /^birthdays\.nameDayCalendarEventDescription/);
  assert.doesNotMatch(localized.title, /^birthdays\.calendarEventTitle/);
});
