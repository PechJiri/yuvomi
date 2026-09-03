/**
 * Modul: Zyklus-Logik-Test
 * Zweck: Reine Funktionen aus public/utils/health-cycle.js — Presets, Kennzahlen
 *        (cycleStats), Vorhersage (predictCycle: Zyklustag/Phase/nächste Periode/
 *        Eisprung/fruchtbares Fenster), Monatskalender (buildCycleCalendar) und
 *        Ring-Segmente (cycleRing). DOM-frei.
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-health-cycle.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';

const {
  FLOW_LEVELS, FLOW_VALUES, flowLevel,
  SYMPTOM_TYPES, SYMPTOM_VALUES, symptomType,
  INTENSITY_LEVELS, symptomIntensityLabelKey, normalizeSymptomEntries,
  MOOD_TYPES, MOOD_VALUES, moodType,
  PHASE,
  daysBetween, sortPeriodsAsc, cycleGaps, periodLengths,
  cycleStats, predictCycle, buildCycleCalendar, cycleRing, pregnancyInfo,
  detectTemperatureShift,
  cycleLengthTrend, symptomFrequencyByPhase, bbtSeries, symptomIntensityTrend,
  symptomCyclePattern, TYPICAL_CYCLE_RANGE, isTypicalCycleLength,
} = await import('../public/utils/health-cycle.js');

const de = JSON.parse(readFileSync(new URL('../public/locales/de.json', import.meta.url), 'utf8'));
const translate = (key) => key.split('.').reduce((value, segment) => value?.[segment], de);

// Baut eine Historie aus Startdaten mit fester Periodenlänge (Tage).
function periods(starts, periodLen = 5) {
  return starts.map((start, i) => {
    const d = new Date(`${start}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + periodLen - 1);
    return { id: i + 1, start_date: start, end_date: d.toISOString().slice(0, 10) };
  });
}

// Baut Tages-Logs mit Basaltemperatur aus [datum, wert, einheit?]-Tripeln
// (einheit default 'c'). Nur die fuer detectTemperatureShift() relevanten
// Felder.
function tempLogs(entries) {
  return entries.map(([log_date, basal_temp, basal_temp_unit = 'c']) => ({ log_date, basal_temp, basal_temp_unit }));
}

// --------------------------------------------------------
// Presets
// --------------------------------------------------------

test('FLOW_LEVELS: value + labelKey + aufsteigender rank', () => {
  assert.equal(FLOW_LEVELS.length, 4);
  FLOW_LEVELS.forEach((f, i) => {
    assert.equal(typeof f.value, 'string');
    assert.ok(f.labelKey.startsWith('health.cycle.flow.'));
    assert.equal(f.rank, i + 1);
  });
  assert.deepEqual(FLOW_VALUES, ['spotting', 'light', 'medium', 'heavy']);
  assert.equal(flowLevel('heavy').rank, 4);
  assert.equal(flowLevel('nope'), null);
});

test('SYMPTOM_TYPES / MOOD_TYPES: vollständige labelKeys + icons', () => {
  assert.ok(SYMPTOM_TYPES.length >= 6);
  for (const s of SYMPTOM_TYPES) {
    assert.ok(s.labelKey.startsWith('health.cycle.symptom.'));
    assert.equal(typeof s.icon, 'string');
    assert.equal(s.hasIntensity, true);
  }
  assert.ok(SYMPTOM_VALUES.includes('cramps'));
  assert.equal(symptomType('cramps').value, 'cramps');
  assert.equal(symptomType('unknown'), null);
  // Jeder Wert kommt genau einmal vor - eine versehentliche Dopplung beim
  // Erweitern der Liste würde SYMPTOM_VALUES sonst still verkürzt lassen.
  assert.equal(new Set(SYMPTOM_VALUES).size, SYMPTOM_VALUES.length);
  for (const m of MOOD_TYPES) {
    assert.ok(m.labelKey.startsWith('health.cycle.mood.'));
    assert.equal(typeof m.icon, 'string');
  }
  assert.equal(moodType('great').value, 'great');
  assert.equal(moodType('unknown'), null);
});

test('INTENSITY_LEVELS: drei Stufen, symptomIntensityLabelKey löst sie auf', () => {
  assert.deepEqual(INTENSITY_LEVELS.map((l) => l.value), [1, 2, 3]);
  for (const l of INTENSITY_LEVELS) assert.ok(l.labelKey.startsWith('health.cycle.intensity.'));
  assert.equal(symptomIntensityLabelKey(1), 'health.cycle.intensity.mild');
  assert.equal(symptomIntensityLabelKey(2), 'health.cycle.intensity.moderate');
  assert.equal(symptomIntensityLabelKey(3), 'health.cycle.intensity.severe');
  assert.equal(symptomIntensityLabelKey(0), null);
  assert.equal(symptomIntensityLabelKey(4), null);
  assert.equal(symptomIntensityLabelKey(undefined), null);
});

test('normalizeSymptomEntries: aktuelles Array-Format mit Intensität', () => {
  const entries = normalizeSymptomEntries([{ key: 'Cramps', intensity: 2 }, { key: 'headache', intensity: '3' }]);
  assert.deepEqual(entries, [{ key: 'cramps', intensity: 2 }, { key: 'headache', intensity: 3 }]);
});

test('normalizeSymptomEntries: dedupliziert nach key, letzter Eintrag gewinnt', () => {
  const entries = normalizeSymptomEntries([{ key: 'cramps', intensity: 1 }, { key: 'cramps', intensity: 3 }]);
  assert.deepEqual(entries, [{ key: 'cramps', intensity: 3 }]);
});

test('normalizeSymptomEntries: ungültige Intensität wird zu null, nicht verworfen', () => {
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 9 }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 0 }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps' }]), [{ key: 'cramps', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries([{ key: 'cramps', intensity: 'nope' }]), [{ key: 'cramps', intensity: null }]);
});

test('normalizeSymptomEntries: unlesbare/ungültige Schlüssel fallen still raus', () => {
  assert.deepEqual(normalizeSymptomEntries([{ key: 'bad key!' }, { key: '' }, { key: 'a'.repeat(33) }]), []);
});

// Abwärtskompatibilität: vor Phase 2 gespeicherte Werte kamen als Komma-String
// oder reines String-Array, beide ohne Intensität.
test('normalizeSymptomEntries: Komma-String und String-Array (Vor-Phase-2-Format)', () => {
  assert.deepEqual(normalizeSymptomEntries('cramps,headache,cramps'),
    [{ key: 'cramps', intensity: null }, { key: 'headache', intensity: null }]);
  assert.deepEqual(normalizeSymptomEntries(['cramps', 'headache']),
    [{ key: 'cramps', intensity: null }, { key: 'headache', intensity: null }]);
});

test('normalizeSymptomEntries: leer/null/undefined ergibt ein leeres Array', () => {
  assert.deepEqual(normalizeSymptomEntries(undefined), []);
  assert.deepEqual(normalizeSymptomEntries(null), []);
  assert.deepEqual(normalizeSymptomEntries(''), []);
  assert.deepEqual(normalizeSymptomEntries([]), []);
});

// MOOD_VALUES ist die Auswahl-Reihenfolge der Stimmungs-Chips, nicht nur eine
// Menge: von "great" nach "anxious". Wie bei FLOW_VALUES/SYMPTOM_VALUES hält der
// Guard die abgeleitete Liste an ihre Presets gebunden.
test('MOOD_VALUES: aus MOOD_TYPES abgeleitet, feste Reihenfolge', () => {
  assert.deepEqual(MOOD_VALUES, MOOD_TYPES.map((m) => m.value));
  assert.deepEqual(MOOD_VALUES, ['great', 'good', 'neutral', 'sensitive', 'sad', 'irritable', 'anxious']);
  assert.equal(new Set(MOOD_VALUES).size, MOOD_VALUES.length);
  assert.ok(Object.isFrozen(MOOD_VALUES));
});

// Die startsWith-Prüfungen oben belegen nur das Präfix. Ein Preset ohne
// Übersetzung würde dort durchrutschen und erst in der UI als roher Key auffallen.
test('jeder Zyklus-Preset-labelKey ist in de.json übersetzt', () => {
  const presets = [...FLOW_LEVELS, ...SYMPTOM_TYPES, ...MOOD_TYPES];
  for (const p of presets) {
    assert.equal(typeof translate(p.labelKey), 'string', `${p.labelKey} fehlt in de.json`);
  }
});

// --------------------------------------------------------
// Datums-/Historie-Helfer
// --------------------------------------------------------

test('daysBetween: ganzzahlige Differenz, NaN bei Müll', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-08'), 7);
  assert.equal(daysBetween('2026-01-08', '2026-01-01'), -7);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1); // 2026 kein Schaltjahr
  assert.ok(Number.isNaN(daysBetween('', '2026-01-01')));
});

test('sortPeriodsAsc: aufsteigend, filtert kaputte Zeilen', () => {
  const asc = sortPeriodsAsc([
    { start_date: '2026-03-01' }, { start_date: null }, { start_date: '2026-01-01' },
  ]);
  assert.deepEqual(asc.map((p) => p.start_date), ['2026-01-01', '2026-03-01']);
});

test('cycleGaps / periodLengths', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-02-26'], 5); // Abstände 28/28
  assert.deepEqual(cycleGaps(hist), [28, 28]);
  assert.deepEqual(periodLengths(hist), [5, 5, 5]);
});

// --------------------------------------------------------
// cycleStats
// --------------------------------------------------------

test('cycleStats: Mittelwerte aus Historie + Regelmäßigkeit', () => {
  // 4 Perioden -> 3 Lücken, erreicht MIN_HISTORY_GAPS.
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5));
  assert.equal(s.count, 4);
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.regular, true);
  assert.equal(s.source, 'history');
});

test('cycleStats: unter MIN_HISTORY_GAPS bleibt es beim Default, aber mit source "insufficient_history"', () => {
  const noHistory = cycleStats([]);
  assert.equal(noHistory.avgCycle, 28);
  assert.equal(noHistory.source, 'default');

  const oneGap = cycleStats(periods(['2026-01-01', '2026-01-29'], 5)); // 1 Lücke
  assert.equal(oneGap.avgCycle, 28); // Default-Fallback, NICHT der (zufällig gleiche) Ein-Punkt-Mittelwert
  assert.equal(oneGap.source, 'insufficient_history');

  const twoGaps = cycleStats(periods(['2026-01-01', '2026-01-31', '2026-03-01'], 5)); // 30/29, noch unter der Schwelle
  assert.equal(twoGaps.avgCycle, 28); // weiterhin Default, nicht der abgeleitete ~29.5-Mittelwert
  assert.equal(twoGaps.source, 'insufficient_history');

  const threeGaps = cycleStats(periods(['2026-01-01', '2026-01-31', '2026-03-01', '2026-04-01'], 5)); // 30/29/31
  assert.equal(threeGaps.avgCycle, 30); // jetzt greift der abgeleitete Mittelwert
  assert.equal(threeGaps.source, 'history');
});

test('cycleStats: manuelle Einstellung gewinnt unabhängig von der Lücken-Anzahl', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-29'], 5), { cycle_length_avg: 35 }); // nur 1 Lücke
  assert.equal(s.avgCycle, 35);
  assert.equal(s.source, 'settings');
});

test('cycleStats: unregelmäßig, wenn Schwankung > 7 Tage', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-25', '2026-03-05'], 4)); // 24 / 39
  assert.equal(s.regular, false);
  assert.equal(s.variation, 15);
});

test('cycleStats: Einstellungen überschreiben Historie, Defaults ohne Daten', () => {
  const s = cycleStats(periods(['2026-01-01', '2026-01-29']), { cycle_length_avg: 30, period_length_avg: 6, luteal_length: 13 });
  assert.equal(s.avgCycle, 30);
  assert.equal(s.avgPeriod, 6);
  assert.equal(s.lutealLength, 13);
  assert.equal(s.source, 'settings');

  const empty = cycleStats([]);
  assert.equal(empty.avgCycle, 28);
  assert.equal(empty.avgPeriod, 5);
  assert.equal(empty.source, 'default');
});

test('cycleStats: explizite NULL-Einstellungen fallen auf Historie zurück (Number(null)≠0-Falle)', () => {
  // GET /cycle/settings liefert cycle_length_avg=null etc. — darf NICHT auf die
  // Clamp-Untergrenze (15/1) fallen, sondern die abgeleiteten Werte nutzen.
  const s = cycleStats(periods(['2026-01-01', '2026-01-29', '2026-02-26', '2026-03-26'], 5),
    { cycle_length_avg: null, period_length_avg: null, luteal_length: null, track_fertility: 1 });
  assert.equal(s.avgCycle, 28);
  assert.equal(s.avgPeriod, 5);
  assert.equal(s.lutealLength, 14);
  assert.equal(s.source, 'history');
});

// --------------------------------------------------------
// predictCycle
// --------------------------------------------------------

test('predictCycle: ohne Historie → hasData=false', () => {
  const p = predictCycle([], {}, '2026-06-01');
  assert.equal(p.hasData, false);
});

test('predictCycle: Zyklustag, nächste Periode, Eisprung, fruchtbares Fenster', () => {
  // Letzter Start 2026-06-01, Ø-Zyklus 28, Lutealphase 14 → Eisprung 2026-06-15.
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const p = predictCycle(hist, {}, '2026-06-10');
  assert.equal(p.hasData, true);
  assert.equal(p.lastStart, '2026-06-01');
  assert.equal(p.cycleDay, 10);         // 9 Tage nach Start + 1
  assert.equal(p.avgCycle, 28);
  assert.equal(p.nextStart, '2026-06-29');
  assert.equal(p.daysUntilNext, 19);
  assert.equal(p.ovulationDate, '2026-06-15');
  assert.equal(p.fertileStart, '2026-06-10'); // Eisprung − 5
  assert.equal(p.fertileEnd, '2026-06-15');
  assert.equal(p.phase, PHASE.FERTILE);       // 2026-06-10 liegt im Fenster
});

test('predictCycle: Phase Menstruation an Tag 2', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-06-02');
  assert.equal(p.phase, PHASE.MENSTRUATION);
  assert.equal(p.cycleDay, 2);
});

test('predictCycle: Eisprungtag + Lutealphase', () => {
  const hist = periods(['2026-06-01'], 5);
  const ov = predictCycle(hist, {}, '2026-06-15');
  assert.equal(ov.phase, PHASE.OVULATION);
  assert.equal(ov.daysUntilOvulation, 0);
  const lut = predictCycle(hist, {}, '2026-06-20');
  assert.equal(lut.phase, PHASE.LUTEAL);
});

test('predictCycle: track_fertility=0 blendet Fruchtbarkeit aus', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), { track_fertility: 0 }, '2026-06-12');
  assert.equal(p.ovulationDate, null);
  assert.equal(p.fertileStart, null);
  assert.notEqual(p.phase, PHASE.FERTILE);
});

test('predictCycle: überfällig, wenn heute nach vorhergesagtem Start', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-07-05'); // nextStart 06-29
  assert.equal(p.isPredictedOverdue, true);
  assert.ok(p.daysUntilNext < 0);
});

// --------------------------------------------------------
// detectTemperatureShift (BBT, Phase 3)
// --------------------------------------------------------

test('detectTemperatureShift: klarer Anstieg nach 6 niedrigen Werten wird erkannt', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: zu wenig Messwerte (< 6 Basislinie + 3 Anstieg) → null', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

test('detectTemperatureShift: kein Anstieg (flache Reihe) → null', () => {
  const logs = tempLogs(Array.from({ length: 9 }, (_, i) => [`2026-06-${String(i + 1).padStart(2, '0')}`, 36.30]));
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

// Ein einzelner Ausreisser-Tag unter der Schwelle laesst BEIDE benachbarten
// Kandidaten-Fenster scheitern - bewusst keine Ausnahme-Regel (siehe
// Modulkommentar bei detectTemperatureShift).
test('detectTemperatureShift: ein Ausreisser-Tag verhindert die Erkennung (keine Rauschtoleranz)', () => {
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.15], ['2026-06-09', 36.60], ['2026-06-10', 36.65],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), null);
});

test('detectTemperatureShift: rechnet Fahrenheit korrekt in Celsius um, auch gemischt mit Celsius-Werten', () => {
  // 97.5°F ≈ 36.39°C (Basislinie), 98.0°F ≈ 36.67°C (Anstieg, Δ ≈ 0.28°C ≥ 0,2).
  const allFahrenheit = tempLogs([
    ['2026-06-01', 97.5, 'f'], ['2026-06-02', 97.5, 'f'], ['2026-06-03', 97.5, 'f'],
    ['2026-06-04', 97.5, 'f'], ['2026-06-05', 97.5, 'f'], ['2026-06-06', 97.5, 'f'],
    ['2026-06-07', 98.0, 'f'], ['2026-06-08', 98.0, 'f'], ['2026-06-09', 98.0, 'f'],
  ]);
  assert.equal(detectTemperatureShift(allFahrenheit, '2026-06-01'), '2026-06-07');

  // Basislinie in Celsius, Anstieg in Fahrenheit (97.9°F ≈ 36.61°C, Δ ≈ 0.31°C).
  const mixedUnits = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 97.9, 'f'], ['2026-06-08', 97.9, 'f'], ['2026-06-09', 97.9, 'f'],
  ]);
  assert.equal(detectTemperatureShift(mixedUnits, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: Messwerte vor cycleStart zählen nicht zur Basislinie', () => {
  const logs = tempLogs([
    ['2026-05-20', 40.00], // extremer Wert vor Zyklusbeginn - darf die Basislinie nicht verzerren
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  assert.equal(detectTemperatureShift(logs, '2026-06-01'), '2026-06-07');
});

test('detectTemperatureShift: Tage ohne basal_temp werden übersprungen, kein Absturz', () => {
  const logs = [
    ...tempLogs([['2026-05-30', 36.30], ['2026-05-31', 36.30], ['2026-06-01', 36.30], ['2026-06-02', 36.30]]),
    { log_date: '2026-06-03', basal_temp: null, basal_temp_unit: null },
    { log_date: '2026-06-04', flow: 'light' }, // basal_temp fehlt ganz
    ...tempLogs([['2026-06-05', 36.30], ['2026-06-06', 36.30],
      ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58]]),
  ];
  // 6 gültige Basislinien-Werte (05-30, 05-31, 06-01, 06-02, 06-05, 06-06),
  // die beiden Lücken (null, fehlendes Feld) übersprungen, dann der Anstieg.
  assert.equal(detectTemperatureShift(logs, '2026-05-30'), '2026-06-07');
});

test('detectTemperatureShift: leere/fehlende Eingabe → null, kein Absturz', () => {
  assert.equal(detectTemperatureShift([], '2026-06-01'), null);
  assert.equal(detectTemperatureShift(null, '2026-06-01'), null);
  assert.equal(detectTemperatureShift(undefined, '2026-06-01'), null);
});

test('predictCycle: bestätigter Temperaturanstieg ersetzt das kalendarische Eisprungdatum', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5); // Ø-Zyklus 28, Lutealphase 14 → kalendarisch 06-15
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const withoutTemps = predictCycle(hist, {}, '2026-06-10');
  assert.equal(withoutTemps.ovulationDate, '2026-06-15');
  assert.equal(withoutTemps.ovulationConfirmed, false);

  const withTemps = predictCycle(hist, {}, '2026-06-10', logs);
  assert.equal(withTemps.ovulationDate, '2026-06-07');
  assert.equal(withTemps.ovulationConfirmed, true);
  // Fruchtbares Fenster folgt dem BESTÄTIGTEN Datum, nicht mehr dem kalendarischen.
  assert.equal(withTemps.fertileEnd, '2026-06-07');
});

test('predictCycle: track_fertility=0 ruft erst gar keine Temperatur-Erkennung auf', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const p = predictCycle(hist, { track_fertility: 0 }, '2026-06-10', logs);
  assert.equal(p.ovulationDate, null);
  assert.equal(p.ovulationConfirmed, false);
});

test('cycleRing: bestätigter Eisprung positioniert den Marker am tatsächlichen Zyklustag, nicht am kalendarischen', () => {
  const hist = periods(['2026-04-06', '2026-05-04', '2026-06-01'], 5);
  const logs = tempLogs([
    ['2026-06-01', 36.30], ['2026-06-02', 36.30], ['2026-06-03', 36.30],
    ['2026-06-04', 36.30], ['2026-06-05', 36.30], ['2026-06-06', 36.30],
    ['2026-06-07', 36.55], ['2026-06-08', 36.60], ['2026-06-09', 36.58],
  ]);
  const prediction = predictCycle(hist, {}, '2026-06-10', logs);
  const ring = cycleRing(prediction);
  assert.equal(ring.ovulationConfirmed, true);
  // Zyklustag 7 (06-07 ist der 7. Tag ab 06-01) von 28 Tagen Gesamtlaenge.
  assert.equal(ring.ovulationFrac, (7 - 0.5) / 28);
});

// --------------------------------------------------------
// Trend-Aggregationen (Phase 4)
// --------------------------------------------------------

test('cycleLengthTrend: eine Lücke je Folgeperiode, mit deren Datum, über die GESAMTE Historie', () => {
  const hist = periods(['2026-01-01', '2026-01-29', '2026-03-05', '2026-04-02'], 5); // 28/35/28
  assert.deepEqual(cycleLengthTrend(hist), [
    { date: '2026-01-29', days: 28 },
    { date: '2026-03-05', days: 35 },
    { date: '2026-04-02', days: 28 },
  ]);
});

test('cycleLengthTrend: unter 2 Perioden gibt es keine Lücke', () => {
  assert.deepEqual(cycleLengthTrend([]), []);
  assert.deepEqual(cycleLengthTrend(periods(['2026-01-01'])), []);
});

// --------------------------------------------------------
// isTypicalCycleLength (Phase 4d)
// --------------------------------------------------------

test('isTypicalCycleLength: Grenzfälle bei 24 und 38 Tagen (jeweils inklusive)', () => {
  assert.equal(TYPICAL_CYCLE_RANGE.min, 24);
  assert.equal(TYPICAL_CYCLE_RANGE.max, 38);
  assert.equal(isTypicalCycleLength(23), false);
  assert.equal(isTypicalCycleLength(24), true);
  assert.equal(isTypicalCycleLength(38), true);
  assert.equal(isTypicalCycleLength(39), false);
});

test('isTypicalCycleLength: nicht-endliche Werte sind nie typisch', () => {
  assert.equal(isTypicalCycleLength(NaN), false);
  assert.equal(isTypicalCycleLength(undefined), false);
  assert.equal(isTypicalCycleLength(null), false);
});

test('bbtSeries: alle Messungen chronologisch, unabhängig vom Zyklus (anders als detectTemperatureShift)', () => {
  const logs = tempLogs([['2026-06-02', 36.40], ['2026-06-01', 36.30], ['2026-05-15', 37.00, 'f']]);
  // 37.00°F ≈ 2.78°C
  assert.deepEqual(bbtSeries(logs), [
    { date: '2026-05-15', celsius: (37.00 - 32) * 5 / 9 },
    { date: '2026-06-01', celsius: 36.30 },
    { date: '2026-06-02', celsius: 36.40 },
  ]);
});

test('bbtSeries: leer ohne Messungen, überspringt Logs ohne basal_temp', () => {
  assert.deepEqual(bbtSeries([]), []);
  assert.deepEqual(bbtSeries([{ log_date: '2026-06-01', flow: 'light' }]), []);
});

test('symptomFrequencyByPhase: klassifiziert Menstruation/Luteal/Sonstige je nach TATSÄCHLICHEM Zyklus, sortiert nach Gesamthäufigkeit', () => {
  // Zyklus 1: 2026-05-01..05-05 Periode, nächste Periode 2026-05-29 → Luteal
  // (Lutealphase 14, Standard) ab 2026-05-15.
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 2 }] }, // Menstruation
    { log_date: '2026-05-20', symptoms: [{ key: 'headache' }] }, // Luteal
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps' }, { key: 'fatigue' }] }, // Sonstige (follikulär)
    { log_date: '2026-04-15', symptoms: [{ key: 'nausea' }] }, // vor der ersten Periode -> kein bekannter Zyklus, übersprungen
  ];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.deepEqual(freq, [
    { key: 'cramps', menstruation: 1, luteal: 0, other: 1, total: 2, avgIntensity: 2 },
    { key: 'headache', menstruation: 0, luteal: 1, other: 0, total: 1, avgIntensity: null },
    { key: 'fatigue', menstruation: 0, luteal: 0, other: 1, total: 1, avgIntensity: null },
  ]);
});

test('symptomFrequencyByPhase: der letzte (offene) Zyklus fällt auf die Ø-Zykluslänge zurück', () => {
  // Nur EINE Periode - keine "nächste", also nextStart = start + avgCycle (Default 28,
  // da keine Historie für einen abgeleiteten Wert reicht).
  const hist = periods(['2026-06-01'], 5);
  const logs = [{ log_date: '2026-06-20', symptoms: [{ key: 'fatigue' }] }]; // Luteal: ab 06-01+28-14=06-15
  assert.deepEqual(symptomFrequencyByPhase(logs, hist, {}), [
    { key: 'fatigue', menstruation: 0, luteal: 1, other: 0, total: 1, avgIntensity: null },
  ]);
});

test('symptomFrequencyByPhase: ohne jede Periode gibt es keine Klassifikation', () => {
  assert.deepEqual(symptomFrequencyByPhase([{ log_date: '2026-06-01', symptoms: [{ key: 'cramps' }] }], [], {}), []);
});

test('symptomFrequencyByPhase: avgIntensity mittelt nur gradierte Vorkommen, ignoriert ungradierte', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps' }] }, // ungradiert - zählt nicht ins Mittel
    { log_date: '2026-05-20', symptoms: [{ key: 'cramps', intensity: 3 }] },
  ];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.equal(freq[0].key, 'cramps');
  assert.equal(freq[0].total, 3);
  assert.equal(freq[0].avgIntensity, 2); // Mittel aus [1, 3], die ungradierte Auswahl bleibt aussen vor.
});

test('symptomFrequencyByPhase: avgIntensity ist null, wenn KEINE Auswahl gradiert wurde', () => {
  const hist = periods(['2026-05-01'], 5);
  const logs = [{ log_date: '2026-05-02', symptoms: [{ key: 'bloating' }] }];
  const freq = symptomFrequencyByPhase(logs, hist, {});
  assert.equal(freq[0].avgIntensity, null);
});

// --------------------------------------------------------
// symptomIntensityTrend (Phase 4b)
// --------------------------------------------------------

test('symptomIntensityTrend: nur gradierte Vorkommen DIESES Symptoms, chronologisch', () => {
  const logs = [
    { log_date: '2026-05-10', symptoms: [{ key: 'cramps', intensity: 3 }] },
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 1 }] },
    { log_date: '2026-05-05', symptoms: [{ key: 'cramps' }] },              // ungradiert -> ausgeschlossen
    { log_date: '2026-05-06', symptoms: [{ key: 'headache', intensity: 2 }] }, // anderes Symptom -> ausgeschlossen
  ];
  assert.deepEqual(symptomIntensityTrend(logs, 'cramps'), [
    { date: '2026-05-02', intensity: 1 },
    { date: '2026-05-10', intensity: 3 },
  ]);
});

test('symptomIntensityTrend: leer ohne Logs oder ohne Treffer für das Symptom', () => {
  assert.deepEqual(symptomIntensityTrend([], 'cramps'), []);
  assert.deepEqual(symptomIntensityTrend([{ log_date: '2026-05-01', symptoms: [{ key: 'headache', intensity: 2 }] }], 'cramps'), []);
});

// --------------------------------------------------------
// symptomCyclePattern (Phase 4c)
// --------------------------------------------------------

test('symptomCyclePattern: Zyklustag-Nummerierung, juengster Zyklus zuerst, mostCommonPhase', () => {
  const hist = periods(['2026-05-01', '2026-05-29', '2026-06-26'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] }, // Zyklus 1, Tag 2, Menstruation
    { log_date: '2026-05-31', symptoms: [{ key: 'cramps' }] }, // Zyklus 2, Tag 3, Menstruation
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.totalCount, 3);
  assert.equal(pattern.occurredCount, 2);
  assert.equal(pattern.mostCommonPhase, PHASE.MENSTRUATION);
  // Juengster Zyklus (2026-06-26, keine Periode danach geloggt) zuerst.
  assert.deepEqual(pattern.cycles.map((c) => c.cycleStart), ['2026-06-26', '2026-05-29', '2026-05-01']);
  assert.deepEqual(pattern.cycles[0].occurredOnDays, []);
  assert.deepEqual(pattern.cycles[1].occurredOnDays, [3]);
  assert.deepEqual(pattern.cycles[2].occurredOnDays, [2]);
});

test('symptomCyclePattern: mehrere Vorkommen im selben Zyklus zaehlen den Zyklus trotzdem nur einmal', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-04', symptoms: [{ key: 'cramps' }] },
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] },
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.occurredCount, 1);
  assert.equal(pattern.totalCount, 2);
  assert.deepEqual(pattern.cycles[1].occurredOnDays, [2, 4]); // sortiert, nicht Log-Reihenfolge
});

test('symptomCyclePattern: Gleichstand zwischen Phasen loest sich per fester Prioritaet Menstruation > Luteal > Sonstige', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [
    { log_date: '2026-05-02', symptoms: [{ key: 'cramps' }] }, // Menstruation
    { log_date: '2026-05-20', symptoms: [{ key: 'cramps' }] }, // Luteal (ab 2026-05-15)
  ];
  const pattern = symptomCyclePattern(logs, hist, {}, 'cramps');
  assert.equal(pattern.mostCommonPhase, PHASE.MENSTRUATION);
});

test('symptomCyclePattern: maxCycles deckelt die Anzahl zurueckgegebener Zyklen', () => {
  const hist = periods(['2026-03-01', '2026-03-29', '2026-04-26', '2026-05-24'], 5);
  const pattern = symptomCyclePattern([], hist, {}, 'cramps', 2);
  assert.equal(pattern.cycles.length, 2);
  assert.equal(pattern.totalCount, 2);
  assert.deepEqual(pattern.cycles.map((c) => c.cycleStart), ['2026-05-24', '2026-04-26']);
});

test('symptomCyclePattern: nie geloggtes Symptom - occurredCount 0, Zyklen bleiben konsistent geformt (kein undefined)', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const pattern = symptomCyclePattern([{ log_date: '2026-05-02', symptoms: [{ key: 'headache' }] }], hist, {}, 'cramps');
  assert.equal(pattern.occurredCount, 0);
  assert.equal(pattern.mostCommonPhase, null);
  pattern.cycles.forEach((c) => assert.deepEqual(c.occurredOnDays, []));
});

test('symptomCyclePattern: phaseByDay klassifiziert jeden Zyklustag - Menstruation, Luteal, Sonstige', () => {
  // Zyklus 2026-05-01..05-05 Periode (Tag 1-5 Menstruation), naechste Periode
  // 2026-05-29 -> Luteal (14 Tage Standard) ab Tag 15 (2026-05-15).
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const pattern = symptomCyclePattern([], hist, {}, 'cramps');
  const cyc = pattern.cycles.find((c) => c.cycleStart === '2026-05-01');
  assert.equal(cyc.cycleLength, 28);
  assert.equal(cyc.phaseByDay.length, 28);
  assert.deepEqual(cyc.phaseByDay.slice(0, 5), Array(5).fill(PHASE.MENSTRUATION));
  assert.equal(cyc.phaseByDay[5], 'other');  // Tag 6, follikulär
  assert.equal(cyc.phaseByDay[13], 'other'); // Tag 14, letzter Tag vor Luteal
  assert.equal(cyc.phaseByDay[14], PHASE.LUTEAL); // Tag 15
  assert.equal(cyc.phaseByDay[27], PHASE.LUTEAL); // Tag 28, letzter Tag des Zyklus
});

test('symptomCyclePattern: zwei Perioden mit identischem Startdatum teilen sich NICHT dieselbe occurredOnDays-Liste (Regression)', () => {
  // Entartete, aber vom Schema nicht ausgeschlossene Eingabe: zwei Perioden
  // mit demselben start_date wuerden bei einem String-Schluessel (cycleStart)
  // dieselbe Map-Zelle treffen und ihre Vorkommen teilen.
  const hist = [
    { id: 1, start_date: '2026-05-27', end_date: '2026-06-01' },
    { id: 2, start_date: '2026-08-13', end_date: '2026-08-18' },
    { id: 3, start_date: '2026-08-13', end_date: '2026-08-18' }, // identisches Startdatum wie id 2
  ];
  const logs = [{ log_date: '2026-08-30', symptoms: [{ key: 'headache' }] }]; // faellt in den Zyklus von id 3 (der letzte, echte Folgezyklus)
  const pattern = symptomCyclePattern(logs, hist, {}, 'headache');
  assert.equal(pattern.occurredCount, 1);
  const [mostRecent, degenerate] = pattern.cycles;
  assert.equal(mostRecent.cycleStart, '2026-08-13');
  assert.equal(degenerate.cycleStart, '2026-08-13');
  assert.deepEqual(mostRecent.occurredOnDays, [18]);
  assert.deepEqual(degenerate.occurredOnDays, []); // die entartete (0 Tage lange) Periode bleibt unberuehrt
});

test('symptomCyclePattern: ohne jede Periode gibt es nichts zu rekonstruieren', () => {
  assert.deepEqual(symptomCyclePattern([], [], {}, 'cramps'), { cycles: [], occurredCount: 0, totalCount: 0, mostCommonPhase: null });
});

test('symptomCyclePattern/symptomFrequencyByPhase: reconstructCycles()-Refactor liefert unveraendertes Ergebnis (Regression)', () => {
  const hist = periods(['2026-05-01', '2026-05-29'], 5);
  const logs = [{ log_date: '2026-05-02', symptoms: [{ key: 'cramps', intensity: 2 }] }];
  assert.deepEqual(symptomFrequencyByPhase(logs, hist, {}), [
    { key: 'cramps', menstruation: 1, luteal: 0, other: 0, total: 1, avgIntensity: 2 },
  ]);
});

// --------------------------------------------------------
// buildCycleCalendar
// --------------------------------------------------------

test('buildCycleCalendar: 6×7-Raster mit korrektem Monat', () => {
  const cal = buildCycleCalendar('2026-06-15', { periods: periods(['2026-06-01'], 5), weekStartsOn: 1 });
  assert.equal(cal.month, '2026-06');
  assert.equal(cal.weeks.length, 6);
  cal.weeks.forEach((w) => assert.equal(w.length, 7));
  // 1. Juni 2026 ist ein Montag → erste Zelle bei weekStartsOn=1.
  assert.equal(cal.weeks[0][0].dateKey, '2026-06-01');
  assert.equal(cal.weeks[0][0].inMonth, true);
});

test('buildCycleCalendar: geloggte + vorhergesagte Periode, Eisprung, Flow, heute', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [{ log_date: '2026-06-02', flow: 'heavy' }],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const flat = cal.weeks.flat();
  const at = (k) => flat.find((c) => c.dateKey === k);

  assert.equal(at('2026-06-01').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-06-01').predicted, false);
  assert.equal(at('2026-06-02').flow, 'heavy');
  assert.equal(at('2026-06-02').hasLog, true);
  assert.equal(at('2026-06-15').isToday, true);
  // Eisprung des Folgezyklus: nextStart 06-29 − 14 = 06-15.
  assert.equal(at('2026-06-15').phase, PHASE.OVULATION);
  assert.equal(at('2026-06-15').predicted, true);
  // Vorhergesagte Periode ab 06-29.
  assert.equal(at('2026-06-29').phase, PHASE.MENSTRUATION);
  assert.equal(at('2026-06-29').predicted, true);
  // Fruchtbares Fenster (06-10..06-15) enthält 06-11.
  assert.equal(at('2026-06-11').phase, PHASE.FERTILE);
});

// symptoms ist seit Phase 2 ein Array ({key, intensity}[]) statt eines
// Komma-Strings - ein LEERES Array ist in JS wahr, ein reines `!!log.symptoms`
// würde einen Tag ohne jeden Eintrag fälschlich als geloggt zählen.
test('buildCycleCalendar: hasLog zählt ein leeres symptoms-Array nicht als Log', () => {
  const cal = buildCycleCalendar('2026-06-15', {
    periods: periods(['2026-06-01'], 5),
    logs: [
      { log_date: '2026-06-05', symptoms: [] },
      { log_date: '2026-06-06', symptoms: [{ key: 'cramps', intensity: 2 }] },
    ],
    todayKey: '2026-06-15',
    weekStartsOn: 1,
  });
  const at = (k) => cal.weeks.flat().find((c) => c.dateKey === k);
  assert.equal(at('2026-06-05').hasLog, false);
  assert.equal(at('2026-06-06').hasLog, true);
});

// --------------------------------------------------------
// cycleRing
// --------------------------------------------------------

test('cycleRing: Segmente als Brüche 0..1 + Marker', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), {}, '2026-06-08'); // avgCycle 28, avgPeriod 5, luteal 14
  const ring = cycleRing(p);
  assert.equal(ring.total, 28);

  const mens = ring.segments.find((s) => s.phase === PHASE.MENSTRUATION);
  assert.equal(mens.start, 0);
  assert.ok(Math.abs(mens.end - 5 / 28) < 1e-9);

  // Eisprung an Zyklustag 14 (28 − 14).
  const ov = ring.segments.find((s) => s.phase === PHASE.OVULATION);
  assert.ok(Math.abs(ov.start - 13 / 28) < 1e-9);
  assert.ok(Math.abs(ring.ovulationFrac - 13.5 / 28) < 1e-9);

  // Aktueller Tag 8 → Marker bei (8-0.5)/28.
  assert.ok(Math.abs(ring.currentFrac - 7.5 / 28) < 1e-9);
});

test('cycleRing: ohne Fruchtbarkeit nur Menstruations-Segment', () => {
  const p = predictCycle(periods(['2026-06-01'], 5), { track_fertility: 0 }, '2026-06-08');
  const ring = cycleRing(p);
  assert.ok(ring.segments.every((s) => s.phase === PHASE.MENSTRUATION));
  assert.equal(ring.ovulationFrac, null);
});

test('cycleRing: null bei fehlender Vorhersage', () => {
  assert.equal(cycleRing(predictCycle([], {}, '2026-06-01')), null);
  assert.equal(cycleRing(null), null);
});

// --------------------------------------------------------
// Schwangerschafts-Modus (#450): Vorhersagen pausiert
// --------------------------------------------------------

test('pregnancyInfo: aus → active=false, keine Ableitungen', () => {
  const info = pregnancyInfo({ pregnancy_mode: 0, pregnancy_due_date: '2026-12-01' }, '2026-06-01');
  assert.equal(info.active, false);
});

test('pregnancyInfo: aktiv ohne Termin → active=true, hasDue=false', () => {
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: null }, '2026-06-01');
  assert.equal(info.active, true);
  assert.equal(info.hasDue, false);
  assert.equal(info.dueDate, null);
});

test('pregnancyInfo: SSW/Trimester/Countdown aus Termin (Naegele, 280 Tage)', () => {
  // ET 2026-12-01; „heute" 2026-06-01 → 183 Tage bis Termin, 97 Tage schwanger.
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: '2026-12-01' }, '2026-06-01');
  assert.equal(info.active, true);
  assert.equal(info.hasDue, true);
  assert.equal(info.daysUntilDue, 183);
  assert.equal(info.gestationalDays, 97);   // 280 − 183
  assert.equal(info.gestWeeks, 13);         // floor(97/7)
  assert.equal(info.gestDays, 6);           // 97 % 7
  assert.equal(info.trimester, 1);          // < 14 Wochen
  assert.equal(info.overdue, false);
  assert.ok(Math.abs(info.progress - 97 / 280) < 1e-9);
});

test('pregnancyInfo: Trimester-Grenzen (2. ab SSW 14, 3. ab SSW 28)', () => {
  const at = (weeks) => pregnancyInfo(
    { pregnancy_mode: 1, pregnancy_due_date: '2026-12-01' },
    // heute = ET − (280 − weeks*7) Tage
    new Date(Date.parse('2026-12-01T00:00:00Z') - (280 - weeks * 7) * 86400000).toISOString().slice(0, 10),
  );
  assert.equal(at(13).trimester, 1);
  assert.equal(at(14).trimester, 2);
  assert.equal(at(27).trimester, 2);
  assert.equal(at(28).trimester, 3);
});

test('pregnancyInfo: über Termin → overdue, gestationalDays gekappt bei 280', () => {
  const info = pregnancyInfo({ pregnancy_mode: 1, pregnancy_due_date: '2026-06-01' }, '2026-06-10');
  assert.equal(info.overdue, true);
  assert.equal(info.daysUntilDue, -9);
  assert.equal(info.gestationalDays, 280);  // geklemmt
  assert.equal(info.progress, 1);
});

test('predictCycle: Schwangerschaft pausiert Vorhersagen (isPregnant, keine Prognose)', () => {
  const hist = periods(['2026-05-01'], 5);
  const p = predictCycle(hist, { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(p.isPregnant, true);
  assert.equal(p.trackFertility, false);
  assert.equal(p.hasData, true);            // Historie bleibt erhalten
  assert.equal(p.nextStart, undefined);     // keine Vorhersage-Felder
  assert.equal(p.ovulationDate, undefined);
  assert.ok(p.pregnancy.active);
});

test('predictCycle: Schwangerschaft aktiv auch ohne Historie', () => {
  const p = predictCycle([], { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(p.isPregnant, true);
  assert.equal(p.hasData, false);
  assert.ok(p.pregnancy.active);
});

test('buildCycleCalendar: keine Projektion im Schwangerschafts-Modus', () => {
  const hist = periods(['2026-05-01'], 5);
  const settings = { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' };
  const cal = buildCycleCalendar('2026-07-15', { periods: hist, settings, todayKey: '2026-06-01' });
  // Juli liegt nach der geloggten Periode → ohne Projektion darf keine Zelle
  // eine (vorhergesagte) Phase tragen.
  const anyPredicted = cal.weeks.flat().some((c) => c.predicted);
  assert.equal(anyPredicted, false);
});

test('cycleRing: null im Schwangerschafts-Modus', () => {
  const p = predictCycle(periods(['2026-05-01'], 5), { pregnancy_mode: 1, pregnancy_due_date: '2027-01-01' }, '2026-06-01');
  assert.equal(cycleRing(p), null);
});

// Der Kalenderkopf steht in `grid-template-columns: repeat(7, 1fr)`
// (.cycle-cal__weekdays in styles/health.css): sieben feste Spalten, die nicht
// mitwachsen. Ein langer Tagesname laeuft dort in die Nachbarspalte, statt den
// Kopf breiter zu machen - auf schmalen Telefonen wird die Zeile unlesbar.
//
// Deshalb hier eine Obergrenze statt einer Sichtpruefung: Arabisch stand nach
// der Uebersetzungsrunde auf den vollen Namen (الثلاثاء, acht Zeichen), weil
// die Werte aus health.meds.weekday uebernommen wurden. Deren Schalter ist ein
// flex-wrap-Element mit Innenabstand und darf lang sein - derselbe Text an zwei
// Orten heisst eben nicht, dass beide Orte gleich viel Platz haben.
test('die Wochentage im Zyklus-Kalender passen in sieben feste Spalten', () => {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = (value) => [...segmenter.segment(value)].length;
  const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const LIMIT = 4;

  const dir = new URL('../public/locales/', import.meta.url);
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.ok(files.length >= 20, 'Locale-Dateien nicht gefunden');

  for (const file of files) {
    const locale = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
    const weekday = locale.health?.cycle?.weekday;
    assert.ok(weekday, `${file}: health.cycle.weekday fehlt`);
    for (const day of DAYS) {
      const label = weekday[day];
      assert.ok(
        graphemes(label) <= LIMIT,
        `${file}: "${label}" (${day}) ist ${graphemes(label)} Zeichen lang, erlaubt sind ${LIMIT} - der Kalenderkopf hat feste Spalten`,
      );
    }
  }
});
