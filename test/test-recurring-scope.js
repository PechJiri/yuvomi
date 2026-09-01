/**
 * Tests: Serientermin-Scope-Logik (public/utils/recurrence-scope.js, #532)
 * Fokus:
 *  - truncateRuleBefore kürzt Serien per UNTIL (Vortag, inklusiv) und wirft
 *    bestehendes UNTIL/COUNT ab; Reihenfolge FREQ;INTERVAL;BYDAY;UNTIL.
 *  - Die gekürzte Regel entfernt in der echten Expansion genau die Vorkommen
 *    ab dem Grenzdatum (End-to-End gegen server/services/calendar-events.js).
 *  - shiftSeriesStart / shiftEndForStart erhalten die Verschiebung bzw. Dauer.
 *  - isLocalRecurringSeries / isExternalRecurringSeries trennen, WELCHE Serie
 *    sich überhaupt zerlegen lässt - daran hängt der Löschumfang (#880).
 * Rein im Node-Kontext (keine DOM-/i18n-Abhängigkeiten).
 * Ausführen: node test/test-recurring-scope.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { withoutBlockComments } = await import('./source-text.js');

const { truncateRuleBefore, shiftSeriesStart, shiftEndForStart,
        isLocalRecurringSeries, isExternalRecurringSeries } =
  await import('../public/utils/recurrence-scope.js');
const { expandRecurringEvents } = await import('../server/services/calendar-events.js');

// Der Server-Validator, gegen den gekürzte Regeln bestehen müssen.
const RRULE_RE = /^(FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=\d{1,2})?(;BYDAY=[A-Z,]{2,}(,[A-Z]{2})*)?(;(UNTIL=\d{8}(T\d{6}Z)?|COUNT=\d{1,4}))?)?$/;

// --- truncateRuleBefore ---

test('truncateRuleBefore: setzt UNTIL auf den Vortag (inklusive Grenze)', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY', '2026-07-19'),
    'FREQ=WEEKLY;UNTIL=20260718'
  );
});

test('truncateRuleBefore: erhält INTERVAL und BYDAY in kanonischer Reihenfolge', () => {
  assert.equal(
    truncateRuleBefore('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH', '2026-07-20'),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20260719'
  );
});

test('truncateRuleBefore: wirft bestehendes UNTIL/COUNT ab', () => {
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;UNTIL=20261231T235959Z', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
  assert.equal(
    truncateRuleBefore('FREQ=DAILY;COUNT=10', '2026-07-10'),
    'FREQ=DAILY;UNTIL=20260709'
  );
});

test('truncateRuleBefore: INTERVAL=1 wird weggelassen (wie beim UI-Builder)', () => {
  assert.equal(truncateRuleBefore('FREQ=DAILY;INTERVAL=1', '2026-07-10'), 'FREQ=DAILY;UNTIL=20260709');
});

test('truncateRuleBefore: Ergebnis besteht den Server-RRULE-Validator', () => {
  for (const rule of ['FREQ=DAILY', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', 'FREQ=MONTHLY;COUNT=5']) {
    const out = truncateRuleBefore(rule, '2026-08-15');
    assert.ok(RRULE_RE.test(out), `ungültige Regel: ${out}`);
  }
});

test('truncateRuleBefore: null bei fehlender Regel oder ungültigem Datum', () => {
  assert.equal(truncateRuleBefore('', '2026-07-19'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', 'kaputt'), null);
  assert.equal(truncateRuleBefore('FREQ=DAILY', ''), null);
});

// --- End-to-End: gekürzte Regel entfernt Vorkommen ab Grenzdatum ---

test('gekürzte Serie: Vorkommen ab Grenzdatum entfallen, davor bleiben', () => {
  const base = {
    id: 1,
    title: 'Standup',
    start_datetime: '2026-07-06T09:00',
    end_datetime: '2026-07-06T09:15',
    all_day: 0,
  };
  // Wöchentlich montags ab 06.07.; „dieser und folgende" ab dem 20.07. löschen.
  const truncated = truncateRuleBefore('FREQ=WEEKLY', '2026-07-20');
  const dates = expandRecurringEvents(
    [{ ...base, recurrence_rule: truncated }],
    '2026-07-01', '2026-08-31'
  ).map((e) => e.start_datetime.slice(0, 10));
  assert.deepEqual(dates, ['2026-07-06', '2026-07-13']); // 20.07. und später entfallen
});

// --- shiftSeriesStart: Delta auf den Master anwenden ---

test('shiftSeriesStart: nur Titel geändert (kein Zeitversatz) → Master-Start unverändert', () => {
  // Instanz #3 geöffnet, Zeit unverändert → Master behält seinen DTSTART.
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T09:00', false),
    '2026-07-06T09:00'
  );
});

test('shiftSeriesStart: Uhrzeit verschoben → gleiche Verschiebung am Master', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06T09:00', '2026-07-20T09:00', '2026-07-20T10:30', false),
    '2026-07-06T10:30'
  );
});

test('shiftSeriesStart: ganztägig, um zwei Tage verschoben', () => {
  assert.equal(
    shiftSeriesStart('2026-07-06', '2026-07-20', '2026-07-22', true),
    '2026-07-08'
  );
});

// --- shiftEndForStart: Dauer erhalten ---

test('shiftEndForStart: Dauer bleibt am neuen Start erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', '2026-07-20T11:00', false),
    '2026-07-06T11:00'
  );
});

test('shiftEndForStart: ohne Ende → null', () => {
  assert.equal(shiftEndForStart('2026-07-06T10:30', '2026-07-20T10:30', null, false), null);
});

test('shiftEndForStart: ganztägig mehrtägig, Dauer in Tagen erhalten', () => {
  assert.equal(
    shiftEndForStart('2026-07-08', '2026-07-22', '2026-07-24', true),
    '2026-07-10'
  );
});

// --------------------------------------------------------
// Welche Serie lässt sich zerlegen? (#880)
//
// Die Trennung entscheidet den Löschumfang: eine lokale Serie bekommt die
// Scope-Auswahl, eine fremde wird immer ganz gelöscht - und muss das vorher
// sagen. Beide Funktionen sind hier zusammen geprüft, weil sie zusammen eine
// vollständige Fallunterscheidung ergeben sollen: was weder lokal noch extern
// wiederkehrend ist, ist ein Einzeltermin, und für den gilt keine der beiden.
// --------------------------------------------------------

const RULE = 'FREQ=WEEKLY';

test('isLocalRecurringSeries: eine rein lokale Serie', () => {
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE, external_source: 'local' }), true);
});

test('isLocalRecurringSeries: fehlendes external_source zählt als lokal', () => {
  // Der Server führt die Spalte NOT NULL DEFAULT 'local'; das Fallback fängt
  // eine Antwort ab, die sie gar nicht mitliefert.
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE }), true);
});

test('isLocalRecurringSeries: ein Einzeltermin ist keine Serie', () => {
  assert.equal(isLocalRecurringSeries({ external_source: 'local' }), false);
  assert.equal(isLocalRecurringSeries({ recurrence_rule: '', external_source: 'local' }), false);
});

test('isLocalRecurringSeries: jede fremde Quelle schließt aus', () => {
  for (const source of ['google', 'apple', 'caldav', 'ics', 'outlook']) {
    assert.equal(
      isLocalRecurringSeries({ recurrence_rule: RULE, external_source: source }),
      false,
      `external_source=${source} gilt fälschlich als lokal`,
    );
  }
});

test('isLocalRecurringSeries: ein Kalenderbezug schließt aus, auch bei source=local', () => {
  // Beide Achsen zählen einzeln - eine Zeile kann ihren Ursprung noch als
  // 'local' führen und trotzdem an einem fremden Kalender hängen.
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE, external_source: 'local', calendar_ref_id: 7 }), false);
  assert.equal(isLocalRecurringSeries({ recurrence_rule: RULE, external_source: 'local', subscription_id: 3 }), false);
});

test('isExternalRecurringSeries ist das Gegenstück, nicht die Verneinung', () => {
  // Der Unterschied ist der Einzeltermin: er ist nicht lokal-wiederkehrend,
  // aber auch nicht extern-wiederkehrend - er darf keine Rückfrage auslösen.
  const single   = { external_source: 'caldav', calendar_ref_id: 7 };
  const external = { recurrence_rule: RULE, external_source: 'caldav', calendar_ref_id: 7 };
  const local    = { recurrence_rule: RULE, external_source: 'local' };

  assert.equal(isExternalRecurringSeries(single),   false, 'Einzeltermin würde nachfragen');
  assert.equal(isExternalRecurringSeries(external), true,  'fremde Serie fragt nicht nach');
  assert.equal(isExternalRecurringSeries(local),    false, 'lokale Serie bekäme die Rückfrage statt der Auswahl');
});

test('Die beiden Fälle überschneiden sich nie', () => {
  const cases = [
    {},
    { recurrence_rule: RULE },
    { recurrence_rule: RULE, external_source: 'google' },
    { recurrence_rule: RULE, external_source: 'local', calendar_ref_id: 1 },
    { recurrence_rule: RULE, external_source: 'local', subscription_id: 1 },
    { external_source: 'google', calendar_ref_id: 1 },
  ];
  for (const ev of cases) {
    assert.ok(
      !(isLocalRecurringSeries(ev) && isExternalRecurringSeries(ev)),
      `beide zugleich wahr für ${JSON.stringify(ev)}`,
    );
  }
});

test('Jede Serie fällt in genau einen der beiden Fälle', () => {
  // Sonst gäbe es eine Serie, die weder die Auswahl noch die Rückfrage bekommt
  // und damit wortlos ganz gelöscht würde - genau der Zustand aus #880.
  const series = [
    { recurrence_rule: RULE, external_source: 'local' },
    { recurrence_rule: RULE, external_source: 'caldav', calendar_ref_id: 4 },
    { recurrence_rule: RULE, subscription_id: 9 },
    { recurrence_rule: RULE },
  ];
  for (const ev of series) {
    assert.ok(
      isLocalRecurringSeries(ev) !== isExternalRecurringSeries(ev),
      `keiner der beiden Fälle greift für ${JSON.stringify(ev)}`,
    );
  }
});

// --------------------------------------------------------
// Der Löschpfad selbst (#880)
//
// Die Klassifikation oben ist nur die halbe Zusicherung: sie kann richtig sein,
// während `requestDeleteEvent` sie gar nicht benutzt - genau so stand es vor
// #880 da, wo eine fremde Serie wortlos komplett gelöscht wurde. Geprüft wird
// deshalb die QUELLE der Seite; der Löschpfad hängt an Modal, i18n und Toast
// und ist ohne halben Browser nicht zu fahren.
//
// Kommentare werden vorher geschnitten: der Kommentar über der Funktion nennt
// beide gesuchten Namen, und ein Guard, der Prosa liest, wäre auch dann grün,
// wenn der Code sie nicht mehr enthält.
// --------------------------------------------------------

const calendarSrc = withoutBlockComments(
  readFileSync(new URL('../public/pages/calendar.js', import.meta.url), 'utf-8'),
);

function requestDeleteEventBody() {
  const start = calendarSrc.indexOf('async function requestDeleteEvent(');
  assert.ok(start > 0, 'requestDeleteEvent nicht auffindbar - Guard greift ins Leere');
  const end = calendarSrc.indexOf('\n}', start);
  assert.ok(end > start, 'Funktionsende nicht auffindbar');
  return calendarSrc.slice(start, end);
}

test('requestDeleteEvent prüft zuerst auf eine fremde Serie', () => {
  const body = requestDeleteEventBody();
  const guard  = body.indexOf('isExternalRecurringSeries(');
  const delete_ = body.indexOf('deleteEvent(');
  assert.ok(guard > 0, 'der Löschpfad fragt nicht nach einer fremden Serie');
  assert.ok(guard < delete_, 'gelöscht wird, bevor die fremde Serie erkannt ist');
});

test('Eine fremde Serie wird nur gelöscht, wenn sie bestätigt wurde', () => {
  // Nicht die Reihenfolge zweier Aufrufe, sondern die ABHAENGIGKEIT: `await`
  // vor der Rueckfrage und das Loeschen in ihrem Ergebnis. Ohne das `await`
  // waere die Zusage ein Promise, immer wahr, und der Dialog reine Zierde -
  // gelöscht wuerde trotzdem.
  const body = requestDeleteEventBody();
  const branch = body.slice(body.indexOf('isExternalRecurringSeries('));
  const confirm = branch.indexOf('confirmExternalSeriesDelete(');
  const del     = branch.indexOf('deleteEvent(');
  assert.ok(confirm > 0, 'keine Rueckfrage im Zweig der fremden Serie - sie verschwindet wortlos');
  assert.ok(confirm < del, 'gelöscht wird vor der Bestätigung');
  assert.match(
    branch.slice(0, del),
    /if\s*\(\s*await\s+confirmExternalSeriesDelete\(/,
    'das Löschen haengt nicht am ERGEBNIS der Rueckfrage',
  );
});

test('Jede fremde Serie bekommt die Auskunft, die auf sie zutrifft', () => {
  // Drei Faelle, drei verschiedene Wahrheiten. Nur bei Google, CalDAV und Apple
  // greift die Loeschung bis zur Quelle durch. Ein Geburtstagstermin ist das
  // Abbild seines Geburtstags und wird neu angelegt; ein Termin aus einem
  // ICS-Abo ist doppelt unloeschbar - `OUTBOUND_SOURCES` kennt kein `ics`, und
  // der naechste Aboabruf legt ihn wieder an. Eine Zusage, die nicht haelt, ist
  // schlimmer als gar keine: sie ist der einzige Grund, ueberhaupt zu fragen.
  const src = calendarSrc.slice(calendarSrc.indexOf('function confirmExternalSeriesDelete'));
  const chooser = src.slice(0, src.indexOf('\n}'));
  assert.ok(chooser.includes('birthday_name'),
    'der Loeschpfad erkennt keinen Geburtstagstermin');
  assert.ok(chooser.includes('subscription_id'),
    'der Loeschpfad erkennt keinen Termin aus einem ICS-Abo - er verspricht ihm dann eine '
    + 'Loeschung an der Quelle, die es dort gar nicht gibt');
  for (const n of ['BirthdayEvent', 'SubscribedSeries', 'ExternalSeries']) {
    assert.ok(chooser.includes(`calendar.delete${n}Detail`), `der Fall ${n} hat keinen eigenen Text`);
  }

  // Und der Loeschpfad muss den Waehler auch BENUTZEN.
  const body = requestDeleteEventBody();
  assert.ok(body.includes('confirmExternalSeriesDelete('),
    'requestDeleteEvent waehlt den Text nicht nach dem Fall aus');
});

test('Jede Rückfrage ist als zerstörend ausgewiesen', () => {
  const src = calendarSrc.slice(calendarSrc.indexOf('function confirmExternalSeriesDelete'));
  const chooser = src.slice(0, src.indexOf('\n}'));
  assert.equal((chooser.match(/danger:\s*true/g) || []).length, 3,
    'nicht alle drei Rückfragen sind als zerstörend ausgewiesen');
});

test('Die Schlüssel beider Rückfragen stehen in allen Locales', () => {
  const dir = new URL('../public/locales/', import.meta.url);
  // Die Schlüssel werden im Code aus einem Präfix ZUSAMMENGESETZT
  // (`${prompt}Title`), tauchen also nirgends vollständig auf. Ein fehlender
  // fiele erst im Dialog auf - deshalb hier vollständig aufgeführt.
  const keys = ['External Series', 'Birthday Event', 'Subscribed Series']
    .flatMap((n) => ['Title', 'Detail', 'Confirm']
      .map((part) => `delete${n.replace(/ /g, '')}${part}`));
  const locales = ['de', 'en', 'fr', 'es', 'uk', 'zh', 'ar', 'ja'];
  for (const loc of locales) {
    const cal = JSON.parse(readFileSync(new URL(`${loc}.json`, dir), 'utf-8')).calendar;
    for (const k of keys) {
      assert.ok(typeof cal?.[k] === 'string' && cal[k].trim(), `${loc}.json: calendar.${k} fehlt oder ist leer`);
    }
    for (const k of ['deleteExternalSeriesDetail', 'deleteBirthdayEventDetail', 'deleteSubscribedSeriesDetail']) {
      assert.ok(cal[k].includes('{{title}}'), `${loc}.json: ${k} nennt den Termin nicht`);
    }
  }
});

test('truncateRuleBefore behaelt "am letzten Tag des Monats" (#960)', async () => {
  // Der Schnitt baut die Regel aus ihren Teilen NEU. Was er dabei nicht kennt,
  // faellt weg - und der zurueckbleibende Teil der Serie lief danach auf dem
  // Tag seines Startdatums statt am Monatsende. Dieselbe stille Umschreibung,
  // die die Wortlaut-Regel aus #756 an anderer Stelle verhindert.
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-05-31'),
    'FREQ=MONTHLY;BYMONTHDAY=-1;UNTIL=20260530');
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1;COUNT=9', '2026-05-31'),
    'FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=-1;UNTIL=20260530');

  // Nur bei MONTHLY, und nur `-1` - der Validator nimmt nichts anderes an.
  assert.equal(truncateRuleBefore('FREQ=YEARLY;BYMONTHDAY=-1', '2026-05-31'),
    'FREQ=YEARLY;UNTIL=20260530');
  assert.equal(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=15', '2026-05-31'),
    'FREQ=MONTHLY;UNTIL=20260530');

  // Und das Ergebnis muss der Server annehmen, sonst scheitert das Speichern
  // des zurueckbleibenden Teils.
  const { RRULE_RE } = await import('../server/middleware/validate.js');
  assert.ok(RRULE_RE.test(truncateRuleBefore('FREQ=MONTHLY;BYMONTHDAY=-1', '2026-05-31')));
});
