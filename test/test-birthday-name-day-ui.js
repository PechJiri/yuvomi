import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

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

test('seznam za narozeninami zobrazí odpočet, datum a popis svátku', () => {
  assert.equal(typeof birthdays.birthdayItemHtml, 'function');
  const html = birthdays.birthdayItemHtml({
    id: 7,
    name: 'Jiří Pech',
    birth_date: '1989-12-18',
    next_birthday: '2026-12-18',
    next_age: 37,
    days_until: 108,
    name_day: '04-24',
    next_name_day: '2027-04-24',
    name_day_days_until: 235,
  });

  assert.match(html, /birthday-item__meta--with-name-day/);
  assert.match(html, /birthdays\.inDays\{&quot;days&quot;:235\}/);
  assert.match(html, /2027-04-24/);
  assert.match(html, /birthdays\.celebratesNameDay/);
});

test('popis svátku v seznamu mají všechny podporované jazyky', () => {
  const localeDir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(localeDir).filter((file) => file.endsWith('.json'));
  assert.equal(files.length, 24);
  for (const file of files) {
    const locale = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'));
    assert.equal(typeof locale.birthdays.celebratesNameDay, 'string', file);
    assert.ok(locale.birthdays.celebratesNameDay.trim(), file);
  }
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
