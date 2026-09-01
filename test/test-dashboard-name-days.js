import test from 'node:test';
import assert from 'node:assert/strict';

const dashboard = await import('../public/pages/dashboard.js');

test('Geburtstagswidget zeigt den Namenstag als eigenen beschrifteten Eintrag', () => {
  assert.equal(typeof dashboard.renderUpcomingBirthdays, 'function');
  const html = dashboard.renderUpcomingBirthdays([{
    id: 7,
    kind: 'name_day',
    name: 'Jiří',
    next_date: '2026-04-24',
    days_until: 2,
    next_age: null,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.match(html, />Jiří</);
  assert.match(html, /birthdays\.nameDay/);
  assert.doesNotMatch(html, /birthdays\.turnsAge/);
  assert.match(html, /2026-04-24/);
});

test('Narozeninový řádek dál zobrazuje věk', () => {
  assert.equal(typeof dashboard.renderUpcomingBirthdays, 'function');
  const html = dashboard.renderUpcomingBirthdays([{
    id: 8,
    kind: 'birthday',
    name: 'Mila',
    next_date: '2026-05-03',
    days_until: 4,
    next_age: 36,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.match(html, /birthdays\.turnsAge/);
  assert.doesNotMatch(html, /birthdays\.nameDay/);
});

test('starší narozeninová data bez věku nevypíší prázdný věk', () => {
  const html = dashboard.renderUpcomingBirthdays([{
    id: 9,
    name: 'Bez věku',
    next_birthday: '2026-05-03',
    days_until: 4,
    next_age: null,
    photo_data: null,
    family_user_color: null,
  }], '1x1');

  assert.doesNotMatch(html, /birthdays\.turnsAge/);
  assert.doesNotMatch(html, />null</);
});
