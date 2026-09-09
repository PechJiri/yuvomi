/**
 * Modul: DTSTART fuer ausgehende Kalender
 * Zweck: Das Startdatum, das Yuvomi nach draussen schreibt, mit seiner eigenen
 *        Wiederholungsregel in Einklang bringen (#986).
 * Abhaengigkeiten: services/recurrence.js, utils/timezone.js
 *
 * DAS PROBLEM. Eine Serie "am letzten Tag des Monats", angelegt aus einem Datum
 * in der Monatsmitte, speichert `DTSTART` so, wie es eingegeben wurde - sagen
 * wir den 15. Januar - zusammen mit `RRULE:FREQ=MONTHLY;BYMONTHDAY=-1`. Intern
 * ist das eindeutig: die Expansion liefert den 31. Januar als erstes Vorkommen
 * und zeigt den 15. nie. Nach draussen ist es das nicht. RFC 5545 3.8.5.3 nennt
 * die Wiederholungsmenge bei einem unsynchronisierten DTSTART ausdruecklich
 * "undefined" - ein fremder Client darf daraus den 15. Januar UND jeden
 * Monatsletzten machen, also ein Vorkommen mehr, als Yuvomi zeigt.
 *
 * WARUM NICHT BEIM SCHREIBEN. Genau das wurde in #984 versucht und
 * zurueckgenommen. `start_datetime` beim Speichern zu begradigen heisst, dass
 * jeder Leser der Spalte wissen muss, dass sich der Wert nach seiner Eingabe
 * noch aendert; sechs Reviewrunden fanden drei Stellen, die das nicht wussten
 * (Erinnerungszeitpunkt aus dem eingegebenen Datum, PUT normalisierte bei jeder
 * Bearbeitung, Vorlauf/Folgeinstanz/optimistisches Rendern lasen dieselbe
 * Spalte). Hier, an der Serialisierung, ist die Umformung rein lesend und kann
 * keine Erinnerung verschieben.
 *
 * WAS UNANGETASTET BLEIBT. Eine importierte Serie geht Wort fuer Wort zurueck
 * (#756): fremde Kalender duerfen ein unsynchronisiertes DTSTART absichtlich
 * fuehren, und Yuvomi ist beim Round-Trip nicht der Schiedsrichter darueber.
 * Diese Datei gilt allein fuer das, was Yuvomi SELBST erzeugt.
 */

import { seriesStartFor } from './recurrence.js';
import { utcToWall } from '../utils/timezone.js';

/**
 * Traegt der Termin ein DTSTART, das Yuvomi selbst gesetzt hat?
 *
 * `external_source` ist die Herkunftsspalte: 'local' (oder leer, bei aelteren
 * Zeilen) heisst hier angelegt, alles andere kam ueber einen Sync herein.
 */
function istEigen(event) {
  const quelle = event?.external_source;
  return !quelle || quelle === 'local';
}

/**
 * Dasselbe `zonenUnsicher` wie in services/countdowns.js - und aus demselben
 * Grund woertlich gleich: die Expansion nimmt die BYDAY-Pruefung fuer Termine
 * zurueck, deren UTC-Tag vom lokalen abweicht, und wenn zwei Stellen diese
 * Frage verschieden beantworten, liefern sie verschiedene erste Vorkommen.
 */
function zonenUnsicher(event) {
  if (!event?.tzid) return false;
  const roh = String(event.start_datetime ?? '');
  const wandUhr = utcToWall(roh, event.tzid);
  return !(wandUhr && wandUhr.date === roh.slice(0, 10));
}

/**
 * Das Startdatum, das nach draussen gehoert.
 *
 * @param {object} event  Zeile aus `calendar_events` (start_datetime,
 *   recurrence_rule, tzid, external_source)
 * @returns {string} `event.start_datetime`, wenn nichts zu begradigen ist -
 *   sonst derselbe Wert mit dem ersten Tag, den die Regel wirklich trifft.
 *   Uhrzeit und Format bleiben, `seriesStartFor` tauscht nur den Datumsteil.
 */
export function outboundStartDatetime(event) {
  const roh = event?.start_datetime;
  if (!roh || !event?.recurrence_rule) return roh;
  if (!istEigen(event)) return roh;
  return seriesStartFor(roh, event.recurrence_rule, { utcDiffersFromLocal: zonenUnsicher(event) });
}

/** Tage zwischen zwei YYYY-MM-DD-Werten (b - a). */
function tagesDifferenz(a, b) {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Math.round(ms / 86400000);
}

/** Denselben Datumsteil um `tage` verschieben, Uhrzeit und Format unberuehrt. */
function verschiebe(wert, tage) {
  const roh = String(wert);
  const tag = roh.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tag) || !tage) return wert;
  const d = new Date(`${tag}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + tage);
  const p = (n) => String(n).padStart(2, '0');
  const neu = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return roh.replace(tag, neu);
}

/**
 * Start UND Ende fuer den ausgehenden Weg (#986).
 *
 * DAS ENDE MUSS MITWANDERN, und das ist keine Feinheit: `end_datetime` ist ein
 * absoluter Zeitstempel, kein Abstand. Rueckt DTSTART vom 15. auf den 31. und
 * bleibt DTEND am 15., steht ein Termin im fremden Kalender, der endet, bevor er
 * beginnt - und wo `end_datetime` fehlt, faellt DTEND ohnehin auf den Start
 * zurueck und wuerde dieselbe Verschiebung brauchen.
 *
 * VERSCHOBEN WIRD UM TAGE, nicht um Millisekunden: `seriesStartFor` tauscht nur
 * den Datumsteil und laesst die Uhrzeit stehen, also tut das Ende dasselbe. So
 * bleibt die Dauer erhalten, auch ueber eine Sommerzeitgrenze hinweg, und das
 * gespeicherte Format (naiv, `Z`, Offset) bleibt, wie es war. Dieselbe Zusage
 * wie in der Expansion: die DAUER gehoert dem Termin, das Datum der Regel.
 *
 * @returns {{ start_datetime: string, end_datetime: string|null }}
 */
export function outboundDateRange(event) {
  const start = outboundStartDatetime(event);
  const ende = event?.end_datetime ?? null;
  if (!start || start === event?.start_datetime) return { start_datetime: event?.start_datetime, end_datetime: ende };
  const tage = tagesDifferenz(String(event.start_datetime).slice(0, 10), String(start).slice(0, 10));
  return { start_datetime: start, end_datetime: ende ? verschiebe(ende, tage) : ende };
}

/**
 * Der Termin, wie er nach draussen geht - Start und Ende schon begradigt.
 *
 * Fuer Aufrufer, die das ganze Objekt weiterreichen (`eventDateTimeFields` und
 * die drei ICS-Bauer darum). ABSICHTLICH HIER UND NICHT IN `utils/ics-datetime.js`:
 * die Umformung ist eine Regel dieses Moduls, und ein `utils`, das ein `services`
 * importiert, dreht die Schichtung um. So sagt jeder ausgehende Pfad an seiner
 * eigenen Zeile, dass er sie anwendet.
 */
export function outboundEvent(event) {
  if (!event) return event;
  return { ...event, ...outboundDateRange(event) };
}

