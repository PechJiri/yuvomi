/**
 * Modul: Kalender-Events (geteilte Abfrage-Logik)
 * Zweck: Wiederholungs-Expansion als unabhängige Kalender-Grundlage bereitstellen.
 * Abhängigkeiten: server/services/recurrence.js
 */

import { nextOccurrence, parseRRule, matchesRRuleByday } from './recurrence.js';
import { localToUTC, utcToWall } from '../utils/timezone.js';

const DEFAULT_EXPANSION_ITERATIONS = 1000;
export const MAX_EXPANSION_ITERATIONS = 100000;

// Zugewiesene Personen eines Events als JSON-Array (Multi-Assignment).
export const ASSIGNED_USERS_SQL = `(
  SELECT json_group_array(json_object(
    'id', u.id, 'display_name', u.display_name, 'color', u.avatar_color,
    'avatar_data', u.avatar_data
  ))
  FROM event_assignments ea JOIN users u ON u.id = ea.user_id
  WHERE ea.event_id = e.id
) AS assigned_users_json`;

/**
 * Lädt die Instanz-Ausnahmen (EXDATE, #489) für die gegebenen Event-IDs als Map.
 * @param {import('node:sqlite').DatabaseSync} d  Geöffnete DB-Verbindung
 * @param {Array<number>} eventIds  IDs wiederkehrender Events
 * @returns {Map<number, Set<string>>}  event.id → Set ausgenommener Daten (YYYY-MM-DD)
 */
export function loadEventExceptions(d, eventIds) {
  const map = new Map();
  if (!eventIds || eventIds.length === 0) return map;
  const placeholders = eventIds.map(() => '?').join(',');
  const rows = d.prepare(
    `SELECT event_id, exception_date FROM calendar_event_exceptions WHERE event_id IN (${placeholders})`
  ).all(...eventIds);
  for (const row of rows) {
    if (!map.has(row.event_id)) map.set(row.event_id, new Set());
    map.get(row.event_id).add(row.exception_date);
  }
  return map;
}

// --------------------------------------------------------
// RRULE-Expansion: alle Vorkommen eines wiederkehrenden Events
// innerhalb [from, to] generieren (inklusive beider Grenzen).
// --------------------------------------------------------

/**
 * @param {object[]} events  Rohe DB-Events (können recurrence_rule haben)
 * @param {string}   from    YYYY-MM-DD
 * @param {string}   to      YYYY-MM-DD
 * @param {Map<number, Set<string>>?} exceptionsByEvent  event.id → Set ausgenommener
 *        Instanz-Daten (YYYY-MM-DD); diese Vorkommen werden übersprungen (EXDATE, #489)
 * @param {{includeRecurrenceIdentity?: boolean, maxIterations?: number,
 *   maxOccurrencesPerSeries?: number, occurrenceFilter?: function}} [options]
 * @returns {object[]}  Expandiertes, sortiertes Array
 */
export function expandRecurringEvents(
  events,
  from,
  to,
  exceptionsByEvent = null,
  {
    includeRecurrenceIdentity = false, maxIterations = DEFAULT_EXPANSION_ITERATIONS,
    maxOccurrencesPerSeries = null, occurrenceFilter = null,
  } = {},
) {
  const result = [];
  const iterationLimit = Number.isInteger(maxIterations) && maxIterations > 0
    ? Math.min(maxIterations, MAX_EXPANSION_ITERATIONS)
    : DEFAULT_EXPANSION_ITERATIONS;
  const occurrenceLimit = Number.isInteger(maxOccurrencesPerSeries) && maxOccurrencesPerSeries > 0
    ? Math.min(maxOccurrencesPerSeries, iterationLimit)
    : Infinity;

  for (const event of events) {
    if (!event.recurrence_rule) {
      result.push(event);
      continue;
    }

    // Dauer des Events in ms (für End-Zeit-Berechnung der Instanzen)
    const startMs    = new Date(event.start_datetime).getTime();
    const endMs      = event.end_datetime ? new Date(event.end_datetime).getTime() : null;
    const durationMs = endMs !== null ? endMs - startMs : null;
    // Duration in days for all-day events (for date-only end calculation)
    const isAllDay     = !!event.all_day;
    const durationDays = isAllDay && durationMs !== null ? Math.round(durationMs / 86400000) : 0;

    // Original-Zeit-Teil erhalten (z.B. 'T14:30:00' oder '' bei All-Day)
    const timeSuffix = event.start_datetime.slice(10);

    // DST-korrekte Expansion: bei bekannter TZID (CalDAV/Apple-Serie) pro Vorkommen
    // die lokale Wanduhrzeit des Masters neu nach UTC rechnen, statt den festen
    // UTC-Suffix zu wiederholen (sonst driftet die Uhrzeit über die Sommer-/
    // Winterzeit-Grenze, #549). Nur für Tagtermine, deren lokales Datum == UTC-Datum
    // ist (kein Mitternachts-Überlauf) - sonst alte Fixe-Suffix-Logik.
    const wall = (event.tzid && !isAllDay) ? utcToWall(event.start_datetime, event.tzid) : null;
    const tzAware = wall && wall.date === event.start_datetime.slice(0, 10);
    // Einmal bestimmt, an beide Stellen gereicht: Filter UND Berechnung muessen
    // dieselbe Antwort bekommen, sonst ist der Schutz halb.
    const zonenUnsicher = !!event.tzid && !tzAware;

    // DTSTART ist zugleich Startpunkt und ANKER: ohne ihn leitet nextOccurrence
    // den gemeinten Tag aus dem vorigen Vorkommen ab, und eine Klemmung in einem
    // kurzen Monat wuerde damit festgeschrieben (#978).
    const seriesStart = event.start_datetime.slice(0, 10);
    let currentDate = seriesStart; // YYYY-MM-DD
    let iterations  = 0;
    const exceptions = exceptionsByEvent?.get(event.id) ?? null; // ausgenommene Instanz-Daten (#489)
    // COUNT=N begrenzt die Serie auf N Vorkommen ab DTSTART. Gezählt wird über
    // die Instanzen der Serie (nicht das Anzeigefenster) und VOR EXDATE-Entfernung
    // (RFC 5545): ausgenommene Vorkommen zählen mit, erzeugen aber keine Instanz (#513).
    const maxCount   = parseRRule(event.recurrence_rule)?.count ?? null;
    let   occurrence = 0;
    let accepted = 0;

    while (currentDate <= to && iterations < iterationLimit) {
      iterations++;

      // BYDAY-FILTER VOR DEM ZAEHLEN, EXDATE DANACH - die beiden sehen gleich
      // aus und sind es nicht. Ein Tag ausserhalb des BYDAY-Musters ist GAR KEIN
      // Vorkommen der Serie (#549: DTSTART am Wochenende bei BYDAY=MO..FR), also
      // darf er auch nicht gegen COUNT zaehlen. Ein ausgenommenes Vorkommen
      // dagegen ist eines und zaehlt mit, erzeugt aber keine Instanz (RFC 5545,
      // #513).
      //
      // Beide standen bis hierher in EINER Bedingung nach `occurrence++`, und
      // damit verbrauchte jeder uebersprungene Wochentag ein Vorkommen:
      // `FREQ=MONTHLY;BYDAY=MO;COUNT=2` lieferte genau einen Termin, weil der
      // zweite Zaehler an einen Mittwoch ging, den niemand je zu sehen bekam.
      // Ein Termin mit eigener Zone kann in UTC an einem anderen Kalendertag
      // liegen als vor Ort (#549 nutzt dieselbe Unterscheidung fuer die
      // Uhrzeit). Die Monatsletzten-Pruefung wird dort ausgesetzt, statt ein
      // Vorkommen still zu verlieren.
      if (!matchesRRuleByday(currentDate, event.recurrence_rule, { utcDiffersFromLocal: zonenUnsicher })) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: zonenUnsicher });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      if (maxCount !== null && occurrence >= maxCount) break;
      occurrence++;

      if (exceptions?.has(currentDate)) {
        const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: zonenUnsicher });
        if (!next || next <= currentDate) break;
        currentDate = next;
        continue;
      }

      // For multi-day events, check if the instance end reaches into [from, to]
      let instanceEnd = currentDate;
      if (isAllDay && durationDays > 0) {
        const d = new Date(currentDate + 'T00:00:00');
        d.setDate(d.getDate() + durationDays);
        instanceEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }

      if (currentDate >= from || instanceEnd >= from) {
        const newStart = tzAware ? localToUTC(`${currentDate}T${wall.time}`, event.tzid) : currentDate + timeSuffix;
        let newEnd = event.end_datetime;
        if (durationMs !== null) {
          if (isAllDay) {
            // Keep date-only format for all-day events
            const d = new Date(currentDate + 'T00:00:00');
            d.setDate(d.getDate() + durationDays);
            newEnd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          } else {
            const endDate = new Date(new Date(newStart).getTime() + durationMs);
            if (timeSuffix.includes('Z')) {
              newEnd = endDate.toISOString().replace('.000Z', 'Z');
            } else {
              const p = n => String(n).padStart(2, '0');
              newEnd = `${endDate.getFullYear()}-${p(endDate.getMonth() + 1)}-${p(endDate.getDate())}T${p(endDate.getHours())}:${p(endDate.getMinutes())}`;
            }
          }
        }

        const instance = {
          ...event,
          start_datetime:       newStart,
          end_datetime:         newEnd,
          ...(includeRecurrenceIdentity ? { recurrence_identity: currentDate } : {}),
          is_recurring_instance: currentDate !== event.start_datetime.slice(0, 10) ? 1 : 0,
          // "IST DAS DER ERSTE TERMIN DER SERIE?" IST NICHT "WEICHT ER VOM
          // GESPEICHERTEN DATUM AB?" - seit ein Start auf der Regel liegen darf,
          // ohne ihr Raster zu treffen (#960), sind das zwei Fragen. Ein Termin
          // am 15. mit "am Monatsletzten" hat sein erstes Vorkommen am 31.:
          // eine Instanz, die vom Master abweicht, und trotzdem der Anfang.
          //
          // Das Frontend haengt "diesen und alle folgenden" daran: am Anfang
          // der Serie meint das die ganze Serie, sonst einen Schnitt. Ohne diese
          // Unterscheidung kuerzte es die Regel auf den Tag VOR dem ersten
          // Vorkommen - eine leere Serie, die der Server zu Recht abwies. Der
          // Zaehler steht hier ohnehin, weil COUNT ihn braucht.
          is_series_start: occurrence === 1 ? 1 : 0,
        };
        // Upcoming readers count only eligible results. Historical instances,
        // EXDATEs and instances rejected by the reader must not fill the cap.
        if (!occurrenceFilter || occurrenceFilter(instance)) {
          result.push(instance);
          accepted++;
          if (accepted >= occurrenceLimit) break;
        }
      }

      const next = nextOccurrence(currentDate, event.recurrence_rule, { anchor: seriesStart, utcDiffersFromLocal: zonenUnsicher });
      if (!next || next <= currentDate) break;
      currentDate = next;
    }
  }

  return result.sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
}
