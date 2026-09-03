/**
 * Modul: Zyklus-Logik (Health)
 * Zweck: Reine, DOM-freie Logik für den Zyklus-Tab — Preset-Definitionen
 *        (Blutungsstärke, Symptome, Stimmung) plus die testbaren Kernfunktionen:
 *        - cycleStats():  Ø Zykluslänge/Periodenlänge + Regelmäßigkeit aus der
 *                         Perioden-Historie.
 *        - predictCycle(): aktueller Zyklustag, Phase, Vorhersage der nächsten
 *                          Periode, des Eisprungs und des fruchtbaren Fensters
 *                          (Kalendermethode: Eisprung ≈ Lutealphase vor der
 *                          nächsten Periode, fruchtbares Fenster = 6 Tage).
 *        - buildCycleCalendar(): Monatsraster mit farbcodierten Phasen je Tag.
 *        - cycleRing(): Segment-Brüche (0..1) für das SVG-Ring-Widget.
 *        - normalizeSymptomEntries() (Phase 2): Symptom-Auswahl eines Tages zu
 *                          `{key, intensity}[]`, Intensität 1-3 optional.
 *        Bewusst KEINE i18n/DOM — in Node ohne Browser testbar (labelKeys liefern
 *        die Übersetzung erst im UI).
 * Abhängigkeiten: ./date.js (ebenfalls DOM-frei; relativer Import, siehe
 *                 Kommentar dort - server/services/cycle-reminders.js
 *                 importiert diese Datei direkt).
 */

// `todayKey` heisst hier schon ein Parameter (bzw. eine lokale Bindung), der den
// Bezugstag traegt - der Import kommt deshalb unter eigenem Namen herein.
//
// RELATIV, NICHT '/utils/date.js': anders als der Rest der App (die feste
// Wurzel-Pfade fuer browser-weite Eindeutigkeit nutzt) muss DIESE Datei auch
// ausserhalb des Browsers ohne Loader-Trick importierbar bleiben - Node
// kennt '/utils/date.js' nicht als Web-Root-Pfad, sondern als absoluten
// Dateisystempfad, der nicht existiert. server/services/cycle-reminders.js
// importiert diese Datei direkt (Single Source of Truth fuer die
// Vorhersage-Mathematik, server und Client rechnen dasselbe), und date.js
// liegt im selben Verzeichnis - ein relativer Import loest in beiden Welten
// identisch auf.
import { addLocalDays, startOfLocalWeekKey, todayKey as householdToday } from './date.js';

// --------------------------------------------------------
// Preset-Definitionen
// --------------------------------------------------------
// `value` ist der stabile DB-Schlüssel (kein lokalisierter Text). `rank` ordnet
// die Blutungsstärke für die Farb-/Höhenabstufung im UI.
export const FLOW_LEVELS = Object.freeze([
  { value: 'spotting', labelKey: 'health.cycle.flow.spotting', rank: 1 },
  { value: 'light',    labelKey: 'health.cycle.flow.light',    rank: 2 },
  { value: 'medium',   labelKey: 'health.cycle.flow.medium',   rank: 3 },
  { value: 'heavy',    labelKey: 'health.cycle.flow.heavy',    rank: 4 },
]);

export const FLOW_VALUES = Object.freeze(FLOW_LEVELS.map((f) => f.value));

/** Preset-Definition zu einem Flow-Wert oder null. */
export function flowLevel(value) {
  return FLOW_LEVELS.find((f) => f.value === value) || null;
}

// Symptome (Mehrfachauswahl je Tag, seit Phase 2 mit optionaler 1-3-
// Intensitaet je Auswahl). Icon = Lucide-Name. `hasIntensity` steht an jedem
// Eintrag (nicht als globale Regel), damit ein Preset ohne sinnvolle Abstufung
// (kaeme eines dazu) sie auslassen koennte, ohne die Form der Liste zu aendern.
export const SYMPTOM_TYPES = Object.freeze([
  { value: 'cramps',        labelKey: 'health.cycle.symptom.cramps',        icon: 'zap',            hasIntensity: true },
  { value: 'headache',      labelKey: 'health.cycle.symptom.headache',      icon: 'brain',           hasIntensity: true },
  { value: 'backache',      labelKey: 'health.cycle.symptom.backache',      icon: 'move-vertical',   hasIntensity: true },
  { value: 'bloating',      labelKey: 'health.cycle.symptom.bloating',      icon: 'circle-dot',      hasIntensity: true },
  { value: 'tender_breasts', labelKey: 'health.cycle.symptom.tenderBreasts', icon: 'heart',          hasIntensity: true },
  { value: 'acne',          labelKey: 'health.cycle.symptom.acne',          icon: 'sparkle',         hasIntensity: true },
  { value: 'fatigue',       labelKey: 'health.cycle.symptom.fatigue',       icon: 'battery-low',     hasIntensity: true },
  { value: 'nausea',        labelKey: 'health.cycle.symptom.nausea',        icon: 'thermometer',     hasIntensity: true },
  { value: 'cravings',      labelKey: 'health.cycle.symptom.cravings',      icon: 'cookie',          hasIntensity: true },
  { value: 'insomnia',      labelKey: 'health.cycle.symptom.insomnia',      icon: 'moon',            hasIntensity: true },
  { value: 'constipation',  labelKey: 'health.cycle.symptom.constipation',  icon: 'circle-dashed',   hasIntensity: true },
  { value: 'diarrhea',      labelKey: 'health.cycle.symptom.diarrhea',      icon: 'droplets',        hasIntensity: true },
  { value: 'joint_pain',    labelKey: 'health.cycle.symptom.jointPain',     icon: 'bone',             hasIntensity: true },
  { value: 'dizziness',     labelKey: 'health.cycle.symptom.dizziness',     icon: 'waves',            hasIntensity: true },
  { value: 'hot_flashes',   labelKey: 'health.cycle.symptom.hotFlashes',    icon: 'thermometer-sun',  hasIntensity: true },
  { value: 'swelling',      labelKey: 'health.cycle.symptom.swelling',      icon: 'glass-water',      hasIntensity: true },
  { value: 'libido_change', labelKey: 'health.cycle.symptom.libidoChange',  icon: 'flame',            hasIntensity: true },
  { value: 'discharge_change', labelKey: 'health.cycle.symptom.dischargeChange', icon: 'droplet',     hasIntensity: true },
  { value: 'appetite_change', labelKey: 'health.cycle.symptom.appetiteChange', icon: 'utensils',      hasIntensity: true },
  { value: 'concentration_difficulty', labelKey: 'health.cycle.symptom.concentrationDifficulty', icon: 'brain-circuit', hasIntensity: true },
]);

export const SYMPTOM_VALUES = Object.freeze(SYMPTOM_TYPES.map((s) => s.value));

// Abstufung einer Symptom-Auswahl (1-3, optional). Kein 4./5. Grad - drei
// Stufen sind schnell antippbar und decken, was ein Tagesprotokoll braucht;
// mehr waere eine klinische Skala, die dieses Modul nicht sein will (siehe
// "kein Medizinprodukt" in docs/SPEC.md).
export const INTENSITY_LEVELS = Object.freeze([
  { value: 1, labelKey: 'health.cycle.intensity.mild' },
  { value: 2, labelKey: 'health.cycle.intensity.moderate' },
  { value: 3, labelKey: 'health.cycle.intensity.severe' },
]);

/** labelKey zu einer Intensitaet (1-3) oder null, wenn keine gueltige Stufe. */
export function symptomIntensityLabelKey(intensity) {
  const level = INTENSITY_LEVELS.find((l) => l.value === Number(intensity));
  return level ? level.labelKey : null;
}

const SYMPTOM_KEY_RE = /^[a-z0-9_]{1,32}$/;

/**
 * Normalisiert eine Symptom-Auswahl zu `{ key, intensity }[]`, dedupliziert
 * nach `key` (letzter Eintrag gewinnt) und klemmt `intensity` auf 1-3 oder
 * `null`. Nimmt sowohl das aktuelle Array-Format
 * (`[{ key, intensity }, ...]`) als auch, für Abwärtskompatibilität mit vor
 * Phase 2 gespeicherten Werten, einen Komma-String oder ein reines
 * String-Array ohne Intensität entgegen - beide ergeben `intensity: null`.
 * Unbekannte/unlesbare Einträge werden still verworfen, nicht als Fehler
 * gemeldet: dieselbe Haltung wie die frühere `normalizeSymptoms()`.
 *
 * @param {Array<string|{key: string, intensity?: number}>|string} raw
 * @returns {Array<{key: string, intensity: number|null}>}
 */
export function normalizeSymptomEntries(raw) {
  if (raw === undefined || raw === null || raw === '') return [];
  const list = typeof raw === 'string' ? raw.split(',') : (Array.isArray(raw) ? raw : []);
  const byKey = new Map();
  for (const item of list) {
    const isObj = item !== null && typeof item === 'object';
    const key = String(isObj ? (item.key ?? '') : item).trim().toLowerCase();
    if (!SYMPTOM_KEY_RE.test(key)) continue;
    const n = isObj ? Number(item.intensity) : NaN;
    const intensity = Number.isInteger(n) && n >= 1 && n <= 3 ? n : null;
    byKey.set(key, { key, intensity });
  }
  return [...byKey.values()];
}

/** Preset-Definition zu einem Symptom-Wert oder null (unbekannt/entfernt). */
export function symptomType(value) {
  return SYMPTOM_TYPES.find((s) => s.value === value) || null;
}

// Stimmung (Einfachauswahl je Tag).
export const MOOD_TYPES = Object.freeze([
  { value: 'great',     labelKey: 'health.cycle.mood.great',     icon: 'smile' },
  { value: 'good',      labelKey: 'health.cycle.mood.good',      icon: 'smile-plus' },
  { value: 'neutral',   labelKey: 'health.cycle.mood.neutral',   icon: 'meh' },
  { value: 'sensitive', labelKey: 'health.cycle.mood.sensitive', icon: 'cloud-drizzle' },
  { value: 'sad',       labelKey: 'health.cycle.mood.sad',       icon: 'frown' },
  { value: 'irritable', labelKey: 'health.cycle.mood.irritable', icon: 'flame' },
  { value: 'anxious',   labelKey: 'health.cycle.mood.anxious',   icon: 'wind' },
]);

export const MOOD_VALUES = Object.freeze(MOOD_TYPES.map((m) => m.value));

/** Preset-Definition zu einem Mood-Wert oder null. */
export function moodType(value) {
  return MOOD_TYPES.find((m) => m.value === value) || null;
}

// Phasen-Schlüssel (auch als Teil von i18n-Keys: health.cycle.phase.<key>).
export const PHASE = Object.freeze({
  MENSTRUATION: 'menstruation',
  FOLLICULAR: 'follicular',
  FERTILE: 'fertile',
  OVULATION: 'ovulation',
  LUTEAL: 'luteal',
});

// Voreinstellungen, wenn (noch) keine Historie/Einstellung vorliegt.
const DEFAULT_CYCLE = 28;
const DEFAULT_PERIOD = 5;
const DEFAULT_LUTEAL = 14;
const FERTILE_WINDOW_DAYS = 6; // Eisprungtag + 5 Tage davor
const MAX_HISTORY = 6;         // gleitender Mittelwert über bis zu 6 Zyklen
// erst ab 3 Lücken (4 geloggte Perioden) gilt der Mittelwert als belastbar; exportiert,
// damit die UI dieselbe Schwelle für die "noch X Perioden"-Hinweise nutzen kann.
export const MIN_HISTORY_GAPS = 3;
const GESTATION_DAYS = 280;    // Naegele-Regel: 40 Wochen von der letzten Periode

// --------------------------------------------------------
// Datums-Helfer (YYYY-MM-DD, ohne UTC-Shift-Fallen)
// --------------------------------------------------------

function dayKey(value) {
  return String(value ?? '').slice(0, 10);
}

/** Ganzzahlige Tagesdifferenz b − a (beide YYYY-MM-DD). */
export function daysBetween(aKey, bKey) {
  const a = Date.parse(`${dayKey(aKey)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(bKey)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return NaN;
  return Math.round((b - a) / 86400000);
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

/** Zahl oder null — behandelt null/undefined/'' als „nicht gesetzt" (nicht als 0). */
function numOrNull(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function mean(nums) {
  const list = nums.filter((n) => Number.isFinite(n));
  if (!list.length) return null;
  return list.reduce((s, n) => s + n, 0) / list.length;
}

// --------------------------------------------------------
// Historie: Sortierung & Kennzahlen
// --------------------------------------------------------

/** Perioden aufsteigend nach Startdatum (älteste zuerst); tolerant ggü. Rohdaten. */
export function sortPeriodsAsc(periods) {
  return [...(periods || [])]
    .filter((p) => p && p.start_date)
    .sort((a, b) => {
      const ka = dayKey(a.start_date);
      const kb = dayKey(b.start_date);
      if (ka === kb) return (a.id || 0) - (b.id || 0);
      return ka < kb ? -1 : 1;
    });
}

/** Abstände (in Tagen) zwischen aufeinanderfolgenden Periodenstarts. */
export function cycleGaps(periods) {
  const asc = sortPeriodsAsc(periods);
  const gaps = [];
  for (let i = 1; i < asc.length; i += 1) {
    const gap = daysBetween(asc[i - 1].start_date, asc[i].start_date);
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  return gaps;
}

/**
 * Zykluslängen-Verlauf für die Trend-Ansicht (Phase 4) - dieselben Abstände
 * wie cycleGaps(), aber mit dem Datum des jeweils NEUEN Zyklus statt einer
 * nackten Zahl, und über die GESAMTE Historie statt der letzten MAX_HISTORY:
 * cycleStats() begrenzt den gleitenden Mittelwert bewusst, ein Trend-Chart
 * soll dagegen genau zeigen, ob/wie sich der Rhythmus über die Zeit verändert.
 * @param {Array<Object>} periods
 * @returns {Array<{date: string, days: number}>}
 */
export function cycleLengthTrend(periods) {
  const asc = sortPeriodsAsc(periods);
  const trend = [];
  for (let i = 1; i < asc.length; i += 1) {
    const days = daysBetween(asc[i - 1].start_date, asc[i].start_date);
    if (Number.isFinite(days) && days > 0) trend.push({ date: dayKey(asc[i].start_date), days });
  }
  return trend;
}

/** Periodenlängen (Ende − Start + 1) abgeschlossener Episoden. */
export function periodLengths(periods) {
  return sortPeriodsAsc(periods)
    .filter((p) => p.end_date)
    .map((p) => daysBetween(p.start_date, p.end_date) + 1)
    .filter((n) => Number.isFinite(n) && n > 0 && n <= 15);
}

/**
 * Kennzahlen aus der Perioden-Historie. Nutzer-Einstellungen (settings) haben
 * Vorrang vor den abgeleiteten Mittelwerten; der abgeleitete Mittelwert greift
 * erst ab MIN_HISTORY_GAPS Lücken, sonst (und ganz ohne Historie) greift der
 * Default. `source` unterscheidet die vier Fälle: 'settings' | 'history' |
 * 'insufficient_history' (Historie vorhanden, aber noch unter der Schwelle) |
 * 'default'.
 * @returns {{ count, avgCycle, avgPeriod, lutealLength, minCycle, maxCycle,
 *             variation, regular, trackFertility, source }}
 */
export function cycleStats(periods, settings = {}) {
  const asc = sortPeriodsAsc(periods);
  const gaps = cycleGaps(asc).slice(-MAX_HISTORY);
  const lengths = periodLengths(asc).slice(-MAX_HISTORY);

  // Ein einzelner (oder zweiter) Zyklus kann ein Ausreißer sein - der abgeleitete
  // Mittelwert gilt erst ab MIN_HISTORY_GAPS Lücken als belastbar genug, um den
  // DEFAULT_CYCLE-Fallback zu ersetzen. Darunter bleibt es beim Default, auch wenn
  // schon (wenige) Perioden geloggt sind - das unterscheidet 'insufficient_history'
  // von einem echten Kaltstart ohne jede Historie.
  const derivedCycle = gaps.length >= MIN_HISTORY_GAPS ? clampInt(mean(gaps), 15, 60) : null;
  const derivedPeriod = lengths.length >= MIN_HISTORY_GAPS ? clampInt(mean(lengths), 1, 15) : null;

  // Achtung: Number(null) === 0 (nicht NaN) — NULL/'' erst zu null normalisieren,
  // sonst würde eine leere Einstellung fälschlich auf die Clamp-Untergrenze fallen.
  const settingCycle = clampInt(numOrNull(settings.cycle_length_avg), 15, 60);
  const settingPeriod = clampInt(numOrNull(settings.period_length_avg), 1, 15);
  const luteal = clampInt(numOrNull(settings.luteal_length), 8, 18) ?? DEFAULT_LUTEAL;

  const avgCycle = settingCycle ?? derivedCycle ?? DEFAULT_CYCLE;
  const avgPeriod = settingPeriod ?? derivedPeriod ?? DEFAULT_PERIOD;

  const minCycle = gaps.length ? Math.min(...gaps) : null;
  const maxCycle = gaps.length ? Math.max(...gaps) : null;
  const variation = minCycle != null ? maxCycle - minCycle : null;
  // „Regelmäßig", wenn die Schwankung der letzten Zyklen ≤ 7 Tage liegt.
  const regular = gaps.length >= 2 ? variation <= 7 : null;

  return {
    count: asc.length,
    avgCycle,
    avgPeriod,
    lutealLength: luteal,
    minCycle,
    maxCycle,
    variation,
    regular,
    trackFertility: settings.track_fertility === undefined ? true : !!settings.track_fertility,
    source: settingCycle ? 'settings' : (derivedCycle ? 'history' : (gaps.length > 0 ? 'insufficient_history' : 'default')),
  };
}

// --------------------------------------------------------
// Schwangerschaft
// --------------------------------------------------------

/**
 * Schwangerschafts-Status aus den Einstellungen. Ist der Schwangerschafts-Modus
 * aktiv, werden alle Zyklus-Vorhersagen angehalten und stattdessen dieser Status
 * angezeigt. Bei gesetztem Entbindungstermin (errechneter Termin, ET) werden SSW
 * (Schwangerschaftswoche), Trimester und Countdown per Naegele-Regel abgeleitet:
 * die letzte Periode (LMP) liegt 280 Tage vor dem ET.
 *
 * @param {Object} settings   - cycle_settings-Zeile.
 * @param {string} [todayKey] - Referenz-„heute" (YYYY-MM-DD).
 * @returns {{ active, dueDate, hasDue, ... }}
 */
export function pregnancyInfo(settings = {}, todayKey = householdToday()) {
  const active = !!(settings.pregnancy_mode === 1 || settings.pregnancy_mode === true);
  const dueRaw = settings.pregnancy_due_date ? dayKey(settings.pregnancy_due_date) : null;
  const hasDue = !!dueRaw && !Number.isNaN(Date.parse(`${dueRaw}T00:00:00Z`));
  const today = dayKey(todayKey);

  if (!active || !hasDue) {
    return { active, dueDate: hasDue ? dueRaw : null, hasDue };
  }

  const lmpDate = addLocalDays(dueRaw, -GESTATION_DAYS);
  const daysUntilDue = daysBetween(today, dueRaw);
  // Gestationsalter: Tage seit LMP (auf [0, GESTATION_DAYS] geklemmt für die Anzeige).
  const gestationalDays = Math.max(0, Math.min(GESTATION_DAYS, GESTATION_DAYS - daysUntilDue));
  const gestWeeks = Math.floor(gestationalDays / 7);
  const gestDays = gestationalDays % 7;
  // Trimester: 1 = SSW 0–13, 2 = SSW 14–27, 3 = ab SSW 28.
  const trimester = gestWeeks < 14 ? 1 : (gestWeeks < 28 ? 2 : 3);
  const overdue = daysUntilDue < 0;

  return {
    active,
    dueDate: dueRaw,
    hasDue,
    lmpDate,
    daysUntilDue,
    gestationalDays,
    gestWeeks,
    gestDays,
    trimester,
    overdue,
    progress: Math.max(0, Math.min(1, gestationalDays / GESTATION_DAYS)),
  };
}

// --------------------------------------------------------
// Basaltemperatur (BBT) — Eisprung-Bestätigung per Temperaturanstieg
// --------------------------------------------------------

// 0,2 °C ist die uebliche Schwelle der "3-ueber-6"-Coverline-Methode
// (Fruchtbarkeitsbewusstsein-Praxis, nicht klinisch normiert - siehe
// "kein Medizinprodukt" in docs/SPEC.md). Sechs Tage Basislinie, drei Tage
// ueber der Schwelle in Folge.
const TEMP_SHIFT_THRESHOLD_C = 0.2;
const TEMP_BASELINE_READINGS = 6;
const TEMP_SUSTAINED_DAYS = 3;

/** Celsius aus einem Wert + Einheit ('c'|'f'), oder null bei unbrauchbarer Eingabe. */
function toCelsius(value, unit) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return unit === 'f' ? (n - 32) * 5 / 9 : n;
}

/**
 * Basaltemperatur-Messungen aus Tages-Logs, nach Celsius vereinheitlicht,
 * chronologisch sortiert. Geteilte Grundlage für detectTemperatureShift() und
 * bbtSeries() - beide brauchen dieselbe Extraktion, nur mit/ohne Zyklus-Filter.
 * @param {Array<Object>} dayLogs
 * @param {string} [sinceKey] - nur Messungen ab diesem Datum (YYYY-MM-DD).
 */
function temperatureReadings(dayLogs, sinceKey = null) {
  const since = sinceKey ? dayKey(sinceKey) : null;
  return (dayLogs || [])
    .filter((l) => l && l.basal_temp != null && (!since || dayKey(l.log_date) >= since))
    .map((l) => ({ date: dayKey(l.log_date), celsius: toCelsius(l.basal_temp, l.basal_temp_unit) }))
    .filter((r) => r.celsius != null)
    .sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
}

/**
 * Basaltemperatur-Reihe für die Trend-Ansicht (Phase 4) - alle geloggten
 * Messungen, nicht nur die des laufenden Zyklus (anders als
 * detectTemperatureShift(), das bewusst nur den AKTUELLEN Zyklus bewertet).
 * @param {Array<Object>} dayLogs
 * @returns {Array<{date: string, celsius: number}>}
 */
export function bbtSeries(dayLogs) {
  return temperatureReadings(dayLogs);
}

/**
 * Zyklus-Grenzen je geloggter Periode - die gemeinsame Basis von
 * symptomFrequencyByPhase() (Phase 4) und symptomCyclePattern() (Phase 4c),
 * herausgezogen statt zweimal dieselbe Rekonstruktion zu pflegen. Aufsteigend
 * sortiert (ältester Zyklus zuerst), wie sortPeriodsAsc() es liefert.
 *
 * Der letzte (ggf. noch laufende) Zyklus hat keinen "nächsten" Periodenstart -
 * er fällt auf Ø-Zykluslänge (cycleStats()) zurück, dieselbe Regel wie
 * predictCycle().
 *
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {Array<{cycleStart: string, nextStart: string, mensEnd: string, lutealStart: string}>}
 */
function reconstructCycles(periods, settings = {}) {
  const asc = sortPeriodsAsc(periods);
  if (!asc.length) return [];
  const stats = cycleStats(asc, settings);
  return asc.map((p, i) => {
    const cycleStart = dayKey(p.start_date);
    const nextStart = i + 1 < asc.length ? dayKey(asc[i + 1].start_date) : addLocalDays(cycleStart, stats.avgCycle);
    const mensEnd = p.end_date ? dayKey(p.end_date) : addLocalDays(cycleStart, stats.avgPeriod - 1);
    const lutealStart = addLocalDays(nextStart, -stats.lutealLength);
    return { cycleStart, nextStart, mensEnd, lutealStart };
  });
}

/**
 * Ordnet EINEN Tag innerhalb EINES bekannten Zyklus einer von drei Phasen zu.
 *
 * DREI EIMER STATT FÜNF, UND DAS IST ABSICHT: predictCycle()/buildCycleCalendar()
 * kennen fünf Phasen, aber immer nur für EINEN (den aktuellen) Zyklus relativ zu
 * "heute". Für JEDEN historischen Tag dieselben fünf Grenzen (insbesondere
 * follikulär vs. fruchtbar) nachzubilden bräuchte eine zweite, über alle
 * vergangenen Zyklen laufende Kopie dieser Logik - fehleranfällig für einen
 * Nutzen, den ein grobes Raster schon trägt. Menstruation (geloggter Zeitraum)
 * und Luteal (Eisprung-Tag bis zum nächsten Periodenbeginn, aus dem TATSÄCHLICHEN
 * Abstand der jeweiligen Perioden - nicht aus einem Haushalts-Durchschnitt)
 * beantworten die eigentlich gefragten Muster ("PMS-Symptome", "Periodenschmerz");
 * alles andere fällt in eine dritte "other"-Sammelkategorie - kein eigener
 * PHASE-Wert, weil sie bewusst KEIN fruchtbares Fenster behauptet.
 *
 * @param {{cycleStart: string, mensEnd: string, lutealStart: string}} cyc - ein Eintrag aus reconstructCycles().
 * @param {string} dateKey
 * @returns {string} PHASE.MENSTRUATION | PHASE.LUTEAL | 'other'
 */
function classifyDayPhase(cyc, dateKey) {
  if (daysBetween(cyc.cycleStart, dateKey) >= 0 && daysBetween(dateKey, cyc.mensEnd) >= 0) return PHASE.MENSTRUATION;
  if (daysBetween(cyc.lutealStart, dateKey) >= 0) return PHASE.LUTEAL;
  return 'other';
}

/**
 * Symptom-Häufigkeit je Zyklus-Phase, für die Trend-Ansicht (Phase 4) -
 * beantwortet "häufen sich meine Symptome vor der Periode" statt nur "wie oft
 * kam Symptom X überhaupt vor". Tage vor der ersten geloggten Periode gehören
 * zu keinem bekannten Zyklus und werden übersprungen, nicht geraten.
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} [settings] - cycle_settings-Zeile (für luteal_length).
 * @returns {Array<{key: string, menstruation: number, luteal: number, other: number, total: number}>}
 *          absteigend nach total sortiert.
 */
export function symptomFrequencyByPhase(dayLogs, periods, settings = {}) {
  const cycles = reconstructCycles(periods, settings);
  if (!cycles.length) return [];

  function phaseFor(dateKey) {
    const cyc = cycles.find((c) => daysBetween(c.cycleStart, dateKey) >= 0 && daysBetween(dateKey, c.nextStart) > 0);
    return cyc ? classifyDayPhase(cyc, dateKey) : null;
  }

  const counts = new Map();
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const phase = phaseFor(dayKey(log.log_date));
    if (!phase) continue;
    for (const entry of normalizeSymptomEntries(log.symptoms)) {
      const c = counts.get(entry.key) || { key: entry.key, [PHASE.MENSTRUATION]: 0, [PHASE.LUTEAL]: 0, other: 0, total: 0, _intensities: [] };
      c[phase] += 1;
      c.total += 1;
      if (entry.intensity != null) c._intensities.push(entry.intensity);
      counts.set(entry.key, c);
    }
  }
  // avgIntensity (Phase 4b): Mittel der gradierten Vorkommen dieses Symptoms,
  // oder null, wenn keine einzige Auswahl gradiert wurde - "nicht gradiert"
  // bleibt von "mild" unterscheidbar.
  return [...counts.values()]
    .map(({ _intensities, ...c }) => ({ ...c, avgIntensity: mean(_intensities) }))
    .sort((a, b) => b.total - a.total);
}

/**
 * Schweregrad-Verlauf EINES Symptoms über die Zeit (Phase 4b) - anders als
 * symptomFrequencyByPhase() (wie oft/wo im Zyklus) beantwortet das "wird es
 * schlimmer oder besser". Nur gradierte Vorkommen dieses einen Symptoms,
 * chronologisch; ungradierte Auswahl hat keinen Schweregrad zu plotten.
 * @param {Array<Object>} dayLogs
 * @param {string} symptomKey
 * @returns {Array<{date: string, intensity: number}>}
 */
export function symptomIntensityTrend(dayLogs, symptomKey) {
  const out = [];
  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    for (const entry of normalizeSymptomEntries(log.symptoms)) {
      if (entry.key === symptomKey && entry.intensity != null) {
        out.push({ date: dayKey(log.log_date), intensity: entry.intensity });
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : (a.date > b.date ? 1 : 0)));
}

/**
 * Zyklustag-Muster EINES Symptoms über die letzten `maxCycles` Zyklen
 * (Phase 4c) - beantwortet "an welchem Zyklustag taucht das typischerweise
 * auf", eine dritte Frage neben "wie oft" (symptomFrequencyByPhase) und "wie
 * stark" (symptomIntensityTrend). Zyklustage sind 1-indiziert ab dem
 * jeweiligen cycleStart, nicht Kalendertage - erst dadurch lassen sich Zyklen
 * unterschiedlicher Länge im selben Raster vergleichen.
 *
 * `occurredCount`/`totalCount` zählen ZYKLEN (nicht Einzel-Vorkommen): "in 2
 * von 3 Zyklen" - ein Symptom, das innerhalb eines Zyklus mehrfach auftaucht,
 * zählt für diesen einen Zyklus trotzdem nur einmal. `mostCommonPhase` zählt
 * dagegen jedes Einzel-Vorkommen; bei Gleichstand gewinnt Menstruation vor
 * Luteal vor Sonstige (die Sammelkategorie gewinnt einen Gleichstand nie) -
 * eine feste, dokumentierte Regel statt eines unklaren "irgendeine".
 *
 * Jeder Zyklus traegt zusaetzlich `phaseByDay` (ein Eintrag je Zyklustag,
 * 'menstruation' | 'luteal' | 'other') - eine Erweiterung ueber die im Plan
 * skizzierte `{cycleStart, cycleLength, occurredOnDays}`-Form hinaus: die
 * geplante UI (ein Raster mit phasengefaerbten Tageszellen) braucht genau
 * diese Klassifikation, und sie hier einmal mitzuliefern ist die einzige
 * Alternative zu einer dritten, im UI-Code laufenden Kopie derselben
 * Grenzen-Rekonstruktion (siehe classifyDayPhase()-Dokblock).
 *
 * @param {Array<Object>} dayLogs
 * @param {Array<Object>} periods
 * @param {Object} settings - cycle_settings-Zeile (für luteal_length).
 * @param {string} symptomKey
 * @param {number} [maxCycles=6]
 * @returns {{cycles: Array<{cycleStart: string, cycleLength: number, occurredOnDays: number[], phaseByDay: string[]}>,
 *            occurredCount: number, totalCount: number, mostCommonPhase: string|null}}
 */
export function symptomCyclePattern(dayLogs, periods, settings = {}, symptomKey, maxCycles = 6) {
  const allCycles = reconstructCycles(periods, settings);
  if (!allCycles.length) return { cycles: [], occurredCount: 0, totalCount: 0, mostCommonPhase: null };

  // Juengster Zyklus zuerst, auf maxCycles gedeckelt.
  const recent = [...allCycles].reverse().slice(0, maxCycles);
  // Nach dem CYKLUS-OBJEKT selbst indiziert, nicht nach cycleStart: zwei
  // Perioden mit identischem Startdatum (entartete, aber vom Schema nicht
  // ausgeschlossene Eingabe) haetten sonst denselben String-Schluessel und
  // teilten sich dieselbe occurredOnDays-Liste.
  const occByCycle = new Map(recent.map((c) => [c, []]));
  const phaseCounts = { [PHASE.MENSTRUATION]: 0, [PHASE.LUTEAL]: 0, other: 0 };

  for (const log of (dayLogs || [])) {
    if (!log?.log_date) continue;
    const dateKey = dayKey(log.log_date);
    const cyc = recent.find((c) => daysBetween(c.cycleStart, dateKey) >= 0 && daysBetween(dateKey, c.nextStart) > 0);
    if (!cyc) continue;
    const hasSymptom = normalizeSymptomEntries(log.symptoms).some((e) => e.key === symptomKey);
    if (!hasSymptom) continue;
    occByCycle.get(cyc).push(daysBetween(cyc.cycleStart, dateKey) + 1);
    phaseCounts[classifyDayPhase(cyc, dateKey)] += 1;
  }

  const cycles = recent.map((c) => {
    const cycleLength = daysBetween(c.cycleStart, c.nextStart);
    const phaseByDay = Array.from({ length: cycleLength }, (_, i) => classifyDayPhase(c, addLocalDays(c.cycleStart, i)));
    return {
      cycleStart: c.cycleStart,
      cycleLength,
      occurredOnDays: occByCycle.get(c).sort((a, b) => a - b),
      phaseByDay,
    };
  });

  const occurredCount = cycles.filter((c) => c.occurredOnDays.length > 0).length;
  const maxPhaseCount = Math.max(...Object.values(phaseCounts));
  const mostCommonPhase = maxPhaseCount > 0
    ? [PHASE.MENSTRUATION, PHASE.LUTEAL, 'other'].find((k) => phaseCounts[k] === maxPhaseCount)
    : null;

  return { cycles, occurredCount, totalCount: cycles.length, mostCommonPhase };
}

/**
 * Erkennt den Temperaturanstieg, der einen Eisprung bestätigt (Coverline-
 * Methode): der erste Tag, dessen Wert mindestens TEMP_SHIFT_THRESHOLD_C ueber
 * dem Mittel der TEMP_BASELINE_READINGS vorangehenden (niedrigeren) Messungen
 * liegt, sofern die naechsten TEMP_SUSTAINED_DAYS − 1 Tage denselben Schwellwert
 * halten. Arbeitet auf der REIHENFOLGE der tatsaechlich geloggten Messungen,
 * nicht auf Kalendertagen - fehlende Tage sind damit kein Sonderfall.
 *
 * Bewusst KEINE Ausnahme-Regel fuer einen einzelnen Ausreisser-Tag (wie echte
 * Fruchtbarkeitsbewusstsein-Methoden sie kennen) - eine einfache, nachvoll-
 * ziehbare Regel statt einer zweiten, die niemand ohne Anleitung nachrechnen
 * kann. Rauschen (ein Tag unter der Schwelle innerhalb der drei) lässt diesen
 * Kandidaten scheitern; die Schleife prüft den nächsten möglichen Starttag.
 *
 * @param {Array<Object>} dayLogs  - cycle_day_logs-Zeilen (log_date, basal_temp, basal_temp_unit).
 * @param {string} cycleStart      - Beginn des aktuellen Zyklus (YYYY-MM-DD); Messungen davor zählen nicht.
 * @returns {string|null} Datum (YYYY-MM-DD) des ersten Tages im Anstieg, oder null ohne hinreichenden Befund.
 */
export function detectTemperatureShift(dayLogs, cycleStart) {
  const readings = temperatureReadings(dayLogs, cycleStart);

  if (readings.length < TEMP_BASELINE_READINGS + TEMP_SUSTAINED_DAYS) return null;

  for (let i = TEMP_BASELINE_READINGS; i <= readings.length - TEMP_SUSTAINED_DAYS; i += 1) {
    const baseline = mean(readings.slice(i - TEMP_BASELINE_READINGS, i).map((r) => r.celsius));
    if (baseline == null) continue;
    const threshold = baseline + TEMP_SHIFT_THRESHOLD_C;
    const sustained = readings.slice(i, i + TEMP_SUSTAINED_DAYS).every((r) => r.celsius >= threshold);
    if (sustained) return readings[i].date;
  }
  return null;
}

// --------------------------------------------------------
// Vorhersage
// --------------------------------------------------------

/**
 * Leitet den aktuellen Zyklusstand + die Vorhersagen ab.
 * Kalendermethode: Eisprung = nächster Periodenstart − Lutealphase; fruchtbares
 * Fenster = Eisprungtag und die 5 Tage davor. Rein statistische Schätzung -
 * bestätigt ein Temperaturanstieg (detectTemperatureShift()) den Eisprung des
 * LAUFENDEN Zyklus, ersetzt dessen Datum das kalendarische (`ovulationConfirmed:
 * true`); künftige Zyklen bleiben Kalendermethode, da es für sie noch keine
 * Messwerte geben kann.
 *
 * @param {Array<Object>} periods - Perioden-Historie (start_date/end_date).
 * @param {Object} settings       - cycle_settings-Zeile (kann leer sein).
 * @param {string} [todayKey]     - Referenz-„heute" (YYYY-MM-DD), Default: heute.
 * @param {Array<Object>} [dayLogs] - Tages-Logs (fuer die BBT-Bestätigung; ohne sie bleibt es Kalendermethode).
 * @returns {Object} { hasData, ... }
 */
export function predictCycle(periods, settings = {}, todayKey = householdToday(), dayLogs = []) {
  const asc = sortPeriodsAsc(periods);
  const stats = cycleStats(asc, settings);
  const today = dayKey(todayKey);
  const pregnancy = pregnancyInfo(settings, today);

  // Schwangerschafts-Modus hält alle Vorhersagen an — es gibt keinen „nächsten
  // Periodenstart", keinen Eisprung und kein fruchtbares Fenster. Die Historie
  // bleibt erhalten (hasData spiegelt vorhandene Perioden), damit das UI nach
  // der Schwangerschaft nahtlos weiterrechnet.
  if (pregnancy.active) {
    return { hasData: !!asc.length, isPregnant: true, pregnancy, stats, trackFertility: false };
  }

  if (!asc.length) {
    return { hasData: false, isPregnant: false, pregnancy, stats, trackFertility: stats.trackFertility };
  }

  // Jüngster Periodenstart, der nicht in der Zukunft liegt (sonst der jüngste).
  const past = asc.filter((p) => daysBetween(p.start_date, today) >= 0);
  const anchor = (past.length ? past[past.length - 1] : asc[asc.length - 1]);
  const lastStart = dayKey(anchor.start_date);

  const { avgCycle, avgPeriod, lutealLength } = stats;
  const cycleDay = daysBetween(lastStart, today) + 1; // Tag 1 = Starttag

  const nextStart = addLocalDays(lastStart, avgCycle);
  const daysUntilNext = daysBetween(today, nextStart);

  // Aktuelle Blutungsphase: laufende (end offen → avgPeriod) oder abgeschlossene
  // Episode, die „heute" abdeckt.
  const inLoggedPeriod = asc.some((p) => {
    const s = dayKey(p.start_date);
    const e = p.end_date ? dayKey(p.end_date) : addLocalDays(s, avgPeriod - 1);
    return daysBetween(s, today) >= 0 && daysBetween(today, e) >= 0;
  });

  const trackFertility = stats.trackFertility;
  let ovulationDate = addLocalDays(nextStart, -lutealLength);
  let ovulationConfirmed = false;
  if (trackFertility) {
    const confirmed = detectTemperatureShift(dayLogs, lastStart);
    if (confirmed) { ovulationDate = confirmed; ovulationConfirmed = true; }
  }
  const fertileStart = addLocalDays(ovulationDate, -(FERTILE_WINDOW_DAYS - 1));
  const fertileEnd = ovulationDate;

  // Phasen-Bestimmung für „heute".
  let phase = PHASE.FOLLICULAR;
  if (inLoggedPeriod || (cycleDay >= 1 && cycleDay <= avgPeriod)) {
    phase = PHASE.MENSTRUATION;
  } else if (trackFertility && daysBetween(today, ovulationDate) === 0) {
    phase = PHASE.OVULATION;
  } else if (trackFertility && daysBetween(fertileStart, today) >= 0 && daysBetween(today, fertileEnd) >= 0) {
    phase = PHASE.FERTILE;
  } else if (daysBetween(ovulationDate, today) > 0) {
    phase = PHASE.LUTEAL;
  } else {
    phase = PHASE.FOLLICULAR;
  }

  return {
    hasData: true,
    isPregnant: false,
    pregnancy,
    stats,
    trackFertility,
    lastStart,
    cycleDay,
    avgCycle,
    avgPeriod,
    lutealLength,
    nextStart,
    daysUntilNext,
    ovulationDate: trackFertility ? ovulationDate : null,
    ovulationConfirmed: trackFertility ? ovulationConfirmed : false,
    fertileStart: trackFertility ? fertileStart : null,
    fertileEnd: trackFertility ? fertileEnd : null,
    daysUntilOvulation: trackFertility ? daysBetween(today, ovulationDate) : null,
    phase,
    inLoggedPeriod,
    isPredictedOverdue: daysUntilNext < 0,
  };
}

// --------------------------------------------------------
// Monatskalender
// --------------------------------------------------------

/** Deckt ein Datum eine geloggte Periode ab? (offene Episode → avgPeriod Tage). */
function loggedPeriodPhase(dateKey, periodsAsc, avgPeriod) {
  return periodsAsc.some((p) => {
    const s = dayKey(p.start_date);
    const e = p.end_date ? dayKey(p.end_date) : addLocalDays(s, avgPeriod - 1);
    return daysBetween(s, dateKey) >= 0 && daysBetween(dateKey, e) >= 0;
  });
}

/**
 * Baut das Monatsraster (6 Wochen) für den Monat um `anchorKey`. Jede Zelle trägt
 * ihre Phase (farbcodiert) und – sofern vorhanden – den Tages-Log (Flow).
 * Vorhergesagte Perioden/Eisprünge werden über bis zu drei Folgezyklen projiziert,
 * damit ein Monat vollständig eingefärbt ist.
 *
 * @param {string} anchorKey - Datum im Zielmonat (YYYY-MM-DD).
 * @param {Object} opts
 * @param {Array}  opts.periods
 * @param {Array}  opts.logs      - cycle_day_logs (für Flow-Punkte).
 * @param {Object} opts.settings
 * @param {string} [opts.todayKey]
 * @param {number} [opts.weekStartsOn=1]
 * @returns {{ month, weeks: Array<Array<Object>> }}
 */
export function buildCycleCalendar(anchorKey, { periods = [], logs = [], settings = {}, todayKey = householdToday(), weekStartsOn = 1 } = {}) {
  const asc = sortPeriodsAsc(periods);
  const stats = cycleStats(asc, settings);
  const { avgCycle, avgPeriod, lutealLength, trackFertility } = stats;
  const today = dayKey(todayKey);

  const logByDate = new Map();
  for (const l of (logs || [])) {
    if (l && l.log_date) logByDate.set(dayKey(l.log_date), l);
  }

  // Projizierte Zyklen (nur zukünftige, ab dem letzten geloggten Start).
  // Im Schwangerschafts-Modus entfällt jede Projektion — geloggte Perioden
  // bleiben sichtbar, aber es werden keine künftigen Phasen vorhergesagt.
  const pregnant = pregnancyInfo(settings, today).active;
  const projected = [];
  if (asc.length && !pregnant) {
    const lastStart = dayKey(asc[asc.length - 1].start_date);
    for (let k = 1; k <= 3; k += 1) {
      const start = addLocalDays(lastStart, avgCycle * k);
      const ovul = addLocalDays(start, -lutealLength);
      projected.push({
        start,
        end: addLocalDays(start, avgPeriod - 1),
        ovulation: ovul,
        fertileStart: addLocalDays(ovul, -(FERTILE_WINDOW_DAYS - 1)),
        fertileEnd: ovul,
      });
    }
  }

  const anchor = dayKey(anchorKey);
  const monthStr = anchor.slice(0, 7); // YYYY-MM
  const firstOfMonth = `${monthStr}-01`;
  const gridStart = startOfLocalWeekKey(firstOfMonth, weekStartsOn);

  const cell = (dateKey) => {
    const inMonth = dateKey.slice(0, 7) === monthStr;
    const log = logByDate.get(dateKey) || null;

    let phase = null;
    let predicted = false;
    if (loggedPeriodPhase(dateKey, asc, avgPeriod)) {
      phase = PHASE.MENSTRUATION;
    } else {
      for (const c of projected) {
        if (daysBetween(c.start, dateKey) >= 0 && daysBetween(dateKey, c.end) >= 0) { phase = PHASE.MENSTRUATION; predicted = true; break; }
        if (trackFertility && daysBetween(c.ovulation, dateKey) === 0) { phase = PHASE.OVULATION; predicted = true; break; }
        if (trackFertility && daysBetween(c.fertileStart, dateKey) >= 0 && daysBetween(dateKey, c.fertileEnd) >= 0) { phase = PHASE.FERTILE; predicted = true; break; }
      }
    }

    return {
      dateKey,
      day: Number(dateKey.slice(8, 10)),
      inMonth,
      isToday: dateKey === today,
      isFuture: daysBetween(today, dateKey) > 0,
      phase,
      predicted,
      flow: log?.flow || null,
      // symptoms ist seit Phase 2 ein Array ({key, intensity}[], vom Server
      // aus cycle_day_log_symptoms zusammengesetzt) - ein LEERES Array ist in
      // JS wahr, `.length` ist die eigentliche Frage "gibt es welche".
      hasLog: !!log && !!(log.flow || log.symptoms?.length || log.mood || log.note),
    };
  };

  const weeks = [];
  for (let w = 0; w < 6; w += 1) {
    const row = [];
    for (let d = 0; d < 7; d += 1) {
      row.push(cell(addLocalDays(gridStart, w * 7 + d)));
    }
    weeks.push(row);
  }
  return { month: monthStr, weeks };
}

// --------------------------------------------------------
// Ring-Widget (Segment-Brüche 0..1 des Zyklus)
// --------------------------------------------------------

/**
 * Wandelt die Vorhersage in Segment-Brüche (0..1 des Zyklus) für das SVG-Ring-
 * Widget. Tag 1 des Zyklus liegt bei Bruch 0; ein voller Zyklus füllt den Kreis.
 * Das UI mappt Bruch → Winkel (frac × 360°, Start oben).
 *
 * @param {Object} prediction - Rückgabe von predictCycle (hasData=true).
 * @returns {null|{ total, segments:Array<{phase,start,end}>, ovulationFrac,
 *                  currentFrac }}
 */
export function cycleRing(prediction) {
  if (!prediction || !prediction.hasData) return null;
  // Kein Zyklus-Ring während der Schwangerschaft (keine avgCycle-Basis).
  if (prediction.isPregnant) return null;
  const total = prediction.avgCycle;
  const seg = (fromDay, toDay) => ({
    start: Math.max(0, (fromDay - 1) / total),
    end: Math.min(1, toDay / total),
  });

  const segments = [];
  // Menstruation: Tag 1..avgPeriod.
  const m = seg(1, prediction.avgPeriod);
  segments.push({ phase: PHASE.MENSTRUATION, start: m.start, end: m.end });

  let ovulationFrac = null;
  if (prediction.trackFertility) {
    // Kalendermethode: Zyklustag des Eisprungs = Zykluslänge − Lutealphase.
    // Bei bestätigtem Anstieg (Phase 3) zählt stattdessen der TATSÄCHLICHE
    // Zyklustag des bestätigten Datums - sonst zeigte der Ring weiter die
    // kalendarische Position, obwohl ein Messwert etwas anderes belegt.
    let ovDay = total - prediction.lutealLength;
    if (prediction.ovulationConfirmed && prediction.lastStart && prediction.ovulationDate) {
      ovDay = daysBetween(prediction.lastStart, prediction.ovulationDate) + 1;
    }
    const fStart = ovDay - (FERTILE_WINDOW_DAYS - 1);
    const f = seg(fStart, ovDay);
    if (f.end > f.start) segments.push({ phase: PHASE.FERTILE, start: f.start, end: f.end });
    const o = seg(ovDay, ovDay);
    segments.push({ phase: PHASE.OVULATION, start: o.start, end: o.end });
    ovulationFrac = (ovDay - 0.5) / total;
  }

  const clampedDay = Math.min(Math.max(prediction.cycleDay, 1), total);
  const currentFrac = (clampedDay - 0.5) / total;

  return { total, segments, ovulationFrac, currentFrac, ovulationConfirmed: !!prediction.ovulationConfirmed };
}
