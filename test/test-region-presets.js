import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import {
  CUSTOM_REGION,
  REGION_CODES,
  REGION_PRESETS,
  detectRegion,
  resolveRegion,
  numberLocaleFor,
} from '../public/settings/region-presets.js';
import { CURRENCY_CODES } from '../public/utils/currency-codes.js';

// Spiegelt die Formprüfung aus getFormatLocale() in public/i18n.js. Zwei- oder
// dreibuchstabiger Sprachcode, damit fil-PH (Filipino) durchkommt.
const BCP47_TAG = /^[a-z]{2,3}-[A-Z]{2}$/;

async function backendList(name) {
  const src = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  const match = src.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  assert.ok(match, `${name} must be declared in preferences route`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every region preset maps to backend-valid currency, date and time values', async () => {
  const currencies = CURRENCY_CODES;
  const dateFormats = await backendList('VALID_DATE_FORMATS');
  const timeFormats = await backendList('VALID_TIME_FORMATS');

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(currencies.includes(preset.currency), `${code}: invalid currency ${preset.currency}`);
    assert.ok(dateFormats.includes(preset.date_format), `${code}: invalid date_format ${preset.date_format}`);
    assert.ok(timeFormats.includes(preset.time_format), `${code}: invalid time_format ${preset.time_format}`);
  }
});

test('every preset date_format is selectable in the appearance UI', async () => {
  const src = await readFile(
    new URL('../public/settings/pages/personal-appearance.js', import.meta.url),
    'utf8',
  );
  const block = src.match(/const DATE_FORMATS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'personal-appearance must declare DATE_FORMATS');
  const uiFormats = [...block[1].matchAll(/\['([^']+)'/g)].map((m) => m[1]);

  for (const [code, preset] of Object.entries(REGION_PRESETS)) {
    assert.ok(uiFormats.includes(preset.date_format), `${code}: ${preset.date_format} missing from UI DATE_FORMATS`);
  }
});

test('detectRegion resolves every preset to a code with identical format values', () => {
  // Several regions intentionally share the same currency/date/time triple
  // (e.g. de-DE and de-AT). Since no `region` is persisted, detectRegion only
  // guarantees a representative code whose preset equals the input values.
  for (const code of REGION_CODES) {
    const resolved = detectRegion(REGION_PRESETS[code]);
    assert.ok(REGION_PRESETS[resolved], `${code}: resolved to unknown code ${resolved}`);
    assert.deepEqual(REGION_PRESETS[resolved], REGION_PRESETS[code], `${code}: resolved preset differs`);
  }
});

test('detectRegion falls back to custom for unknown or partial combinations', () => {
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'mdy', time_format: '12h' }), CUSTOM_REGION);
  assert.equal(detectRegion({ currency: 'EUR', date_format: 'dmy' }), CUSTOM_REGION);
  assert.equal(detectRegion({}), CUSTOM_REGION);
  assert.equal(detectRegion(), CUSTOM_REGION);
});

test('resolveRegion keeps the stored region when its preset still matches (#486)', () => {
  // fr-FR and es-ES share the exact same currency/date/time triple. detectRegion
  // alone always returns the first match (es-ES) — the bug behind #486. With a
  // persisted region, resolveRegion must honour the actual selection.
  assert.deepEqual(REGION_PRESETS['fr-FR'], REGION_PRESETS['es-ES']);
  assert.equal(detectRegion(REGION_PRESETS['fr-FR']), 'es-ES');
  assert.equal(resolveRegion({ region: 'fr-FR', ...REGION_PRESETS['fr-FR'] }), 'fr-FR');
  assert.equal(resolveRegion({ region: 'es-ES', ...REGION_PRESETS['es-ES'] }), 'es-ES');
});

test('resolveRegion falls back to detectRegion for stale, empty or unknown region', () => {
  // Stored region no longer matches the persisted formats (manual format change):
  assert.equal(
    resolveRegion({ region: 'fr-FR', currency: 'EUR', date_format: 'dmy', time_format: '24h' }),
    detectRegion({ currency: 'EUR', date_format: 'dmy', time_format: '24h' }),
  );
  // No / empty / unknown region → pure detection:
  assert.equal(resolveRegion({ ...REGION_PRESETS['de-DE'] }), detectRegion(REGION_PRESETS['de-DE']));
  assert.equal(resolveRegion({ region: '', ...REGION_PRESETS['fr-FR'] }), 'es-ES');
  assert.equal(resolveRegion({ region: 'zz-ZZ', ...REGION_PRESETS['fr-FR'] }), 'es-ES');
  assert.equal(resolveRegion(), CUSTOM_REGION);
});

test('numberLocaleFor yields a region tag that drives Intl number grouping (#521)', () => {
  // Kernfall des Issues: Schweizer Region → Tausender-Apostroph + Punkt-Dezimal.
  const chLocale = numberLocaleFor({ region: 'de-CH', ...REGION_PRESETS['de-CH'] });
  assert.equal(chLocale, 'de-CH');
  assert.equal(new Intl.NumberFormat(chLocale).format(123456.78), "123'456.78");
  // Währung: nur die Gruppierung prüfen; das Leerzeichen vor dem Betrag ist je
  // nach ICU-Version ein schmales geschütztes Leerzeichen (U+202F/U+00A0).
  assert.ok(
    new Intl.NumberFormat(chLocale, { style: 'currency', currency: 'CHF' })
      .format(123456.78)
      .includes("123'456.78"),
  );
  // Deutsche Region bleibt beim gewohnten Format (kein Regressionswechsel).
  assert.equal(
    new Intl.NumberFormat(numberLocaleFor({ region: 'de-DE', ...REGION_PRESETS['de-DE'] })).format(123456.78),
    '123.456,78',
  );
});

test('Malaysia preset formats MYR amounts with the local currency symbol', () => {
  const locale = numberLocaleFor({ region: 'ms-MY', ...REGION_PRESETS['ms-MY'] });
  const formatted = new Intl.NumberFormat(locale, { style: 'currency', currency: 'MYR' })
    .format(1234.56);

  assert.equal(locale, 'ms-MY');
  assert.ok(formatted.includes('RM'));
  assert.ok(formatted.includes('1,234.56'));
});

test('New Zealand preset uses NZD and local number formatting', () => {
  const locale = numberLocaleFor({ region: 'en-NZ', ...REGION_PRESETS['en-NZ'] });
  const formatted = new Intl.NumberFormat(locale, { style: 'currency', currency: 'NZD' })
    .format(1234.56);

  assert.equal(locale, 'en-NZ');
  assert.ok(formatted.includes('$'));
  assert.ok(formatted.includes('1,234.56'));
});

test('numberLocaleFor derives the tag even without a stored region, and empties for custom', () => {
  // Region nicht gesetzt, aber Formate entsprechen einem Preset → abgeleiteter Tag.
  assert.equal(numberLocaleFor({ ...REGION_PRESETS['de-CH'] }), 'de-CH');
  // Kein passendes Preset → leerer String (App fällt auf die UI-Sprache zurück).
  assert.equal(numberLocaleFor({ currency: 'EUR', date_format: 'mdy', time_format: '12h' }), '');
  assert.equal(numberLocaleFor({}), '');
  assert.equal(numberLocaleFor(), '');
  // Jeder gelieferte Tag muss ein gültiger BCP-47-Regionscode sein (getFormatLocale-Regex).
  for (const code of REGION_CODES) {
    const tag = numberLocaleFor({ region: code, ...REGION_PRESETS[code] });
    assert.match(tag, BCP47_TAG, `${code}: numberLocaleFor tag not BCP-47`);
  }
});

// Die Tag-Form wird an fünf Stellen geprüft (getFormatLocale, VALID_REGION,
// resolveHouseholdLocale, formatMoney, householdRegion). Eine Region mit
// dreibuchstabigem Sprachcode wie fil-PH fiel durch jede Stelle, die noch auf
// {2} stand - deshalb liest der Guard die Regexe aus dem Code, statt sie zu
// doppeln, und schlägt an, sobald eine davon zurückfällt.
test('jede Tag-Formprüfung akzeptiert zwei- UND dreibuchstabige Sprachcodes', async () => {
  const sources = [
    ['public/i18n.js', 'getFormatLocale'],
    ['server/routes/preferences.js', 'VALID_REGION'],
    ['server/utils/i18n.js', 'resolveHouseholdLocale/formatMoney/householdRegion'],
  ];
  for (const [file, label] of sources) {
    const src = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    const tagChecks = [...src.matchAll(/\[a-z\]\{([^}]+)\}-\[A-Z\]\{2\}/g)].map((m) => m[1]);
    assert.ok(tagChecks.length > 0, `${file}: keine BCP-47-Formprüfung gefunden (${label})`);
    for (const quantifier of tagChecks) {
      assert.equal(quantifier, '2,3', `${file}: Formprüfung auf {${quantifier}} weist fil-PH ab (${label})`);
    }
  }
});

test('money/number formatting uses getFormatLocale, never getLocale (#521 regression guard)', async () => {
  // Zahlen/Währungen MÜSSEN über getFormatLocale() (region-abhängig, z. B. de-CH
  // → 123'456.78) formatiert werden, nicht über getLocale() (nur UI-Sprache).
  // Ein Intl.NumberFormat(getLocale()) irgendwo unter public/ ist ein Rückfall
  // in den #521-Bug. (Intl.DateTimeFormat(getLocale()) für Monats-/Wochentags-
  // namen bleibt korrekt sprachgebunden und wird hier nicht erfasst.)
  const dir = new URL('../public/', import.meta.url);
  const files = [];
  async function walk(url) {
    for (const ent of await readdir(url, { withFileTypes: true })) {
      if (ent.name === 'lucide.min.js') continue;
      const child = new URL(ent.name + (ent.isDirectory() ? '/' : ''), url);
      if (ent.isDirectory()) await walk(child);
      else if (ent.name.endsWith('.js')) files.push(child);
    }
  }
  await walk(dir);

  const offenders = [];
  for (const file of files) {
    const src = await readFile(file, 'utf8');
    if (/NumberFormat\(\s*getLocale\(\)/.test(src)) {
      offenders.push(file.pathname.replace(/.*\/public\//, 'public/'));
    }
  }
  assert.deepEqual(offenders, [], `Intl.NumberFormat(getLocale()) muss getFormatLocale() sein: ${offenders.join(', ')}`);
});

test('i18n.js exports getFormatLocale + gecachten getNumberFormat als Zahl-Formatier-Quelle', async () => {
  const src = await readFile(new URL('../public/i18n.js', import.meta.url), 'utf8');
  assert.match(src, /export function getFormatLocale\(/, 'getFormatLocale muss existieren');
  assert.match(src, /export function getNumberFormat\(/, 'gecachter getNumberFormat muss existieren');
  assert.match(src, /NUMBER_LOCALE_KEY\s*=\s*'yuvomi-number-locale'/, 'localStorage-Schlüssel gepinnt');
});

test('preferences route validates the region field shape', async () => {
  const src = await readFile(
    new URL('../server/routes/preferences.js', import.meta.url),
    'utf8',
  );
  const match = src.match(/const VALID_REGION = (\/.*\/);/);
  assert.ok(match, 'preferences route must declare VALID_REGION');
  const pattern = new RegExp(match[1].slice(1, -1));
  for (const code of REGION_CODES) {
    assert.ok(pattern.test(code), `${code} must pass VALID_REGION`);
  }
  assert.ok(pattern.test('custom'));
  assert.ok(!pattern.test('french'));
  assert.ok(!pattern.test('fr_FR'));
  assert.ok(!pattern.test(''));
});

// --------------------------------------------------------------------------
// #297: Der Melder fand VND nicht mehr in der Auswahl, obwohl `vi.json`
// ausgeliefert wird. Der Code war beim Vereinheitlichen der vier
// Waehrungskopien (#340) verschwunden und zwei Monate lang niemandem
// aufgefallen - weil ihn nichts geprueft hat.
//
// DER GUARD IST EINE REGEL UEBER DEN BESTAND, KEINE LISTE VON DATEIEN. Eine
// Allowlist deckt genau die Faelle, die schon richtig sind; die drei Locales
// ohne Region (el, hu, vi) standen in keiner. Er liest `public/locales/` und
// erfaehrt so von einer neuen Sprache, ohne dass jemand ihn nachtraegt.
//
// Die Gegenrichtung - jedes Preset nennt eine waehlbare Waehrung - steht schon
// im ersten Test dieser Datei. Zusammen schliessen die beiden den Kreis, der
// bei #297 offen war: eine Sprache ohne Region konnte keine Waehrung fordern,
// und so fiel niemandem auf, dass ihre fehlte.
// --------------------------------------------------------------------------

test('jede ausgelieferte Sprache hat mindestens ein Region-Preset (#297)', async () => {
  const dir = new URL('../public/locales/', import.meta.url);
  const locales = (await readdir(dir))
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.replace(/\.json$/, ''));

  assert.ok(locales.length > 0, 'public/locales/ muss Sprachdateien enthalten');

  const languagesWithRegion = new Set(REGION_CODES.map((code) => code.split('-')[0]));
  const orphans = locales.filter((locale) => !languagesWithRegion.has(locale));

  assert.deepEqual(
    orphans,
    [],
    'Ohne Region landet diese Sprache zwangslaeufig auf "Benutzerdefiniert" und muss '
    + `Waehrung, Datum und Zeit einzeln raten: ${orphans.join(', ')}`,
  );
});
