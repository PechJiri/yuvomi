/**
 * Modul: Zyklus-Erinnerungen (Health)
 * Zweck: Soll-Zustand der `cycle_period`/`cycle_log_nudge`-Erinnerungen für
 *        EINEN Nutzer herstellen - höchstens eine Zeile je Art, nicht ein
 *        rollierendes Fenster wie beim Schichtplan: der Zyklus hat je Nutzer
 *        immer nur EINEN nächsten vorhergesagten Periodenbeginn und EIN
 *        "heute", nicht viele Tage mit je eigenem Inhalt.
 * Abhängigkeiten: server/utils/reminder-schedule.js, public/utils/health-cycle.js
 *                 (dieselbe Vorhersage-Mathematik wie der Zyklus-Tab selbst -
 *                 ein zweites Rechenmodell hier wäre eine zweite Wahrheit).
 *
 * WARUM EIN ANKER NÖTIG IST: weder der vorhergesagte nächste Periodenbeginn
 * (predictCycle(), rein berechnet) noch "heute noch nicht geloggt" (die
 * Abwesenheit einer cycle_day_logs-Zeile) ist eine gespeicherte Zeile mit
 * eigener Id. `cycle_reminder_anchors` (Migration 174) gibt beiden einen
 * stabilen Ankerpunkt je (Nutzer, Datum, Art), an den reminders.entity_id
 * zeigen kann - gleicher Grund wie schedule_reminder_entries für
 * Musterzyklus-Tage (Schedule v3).
 *
 * GLEICHE GRUNDFORM WIE server/services/pantry-reminders.js: löschen, was
 * gegenstandslos wurde, ergänzen, was fehlt, bestehende Zeilen mit gleichem
 * Zeitpunkt unangetastet lassen (kein Zurücksetzen von pushed_at/dismissed
 * bei jedem Lauf). remind_at nutzt reminder-schedule.js (09:00, dieselbe
 * Tageszeit wie jede andere datumsbasierte Erinnerung in dieser App) und
 * denselben "Datums-, nicht Uhrzeit-Schnitt" wie Pantrys Voll-Sync: ein
 * Zieltag, der heute noch nicht vorbei ist, bekommt seine Erinnerung auch
 * dann, wenn 09:00 UTC schon verstrichen ist - sie geht dann in diesem
 * Durchgang sofort raus, statt bis morgen zu warten.
 */

import { reminderDateBefore } from '../utils/reminder-schedule.js';
import { todayKey } from '../utils/timezone.js';
import { resolvePermissions } from '../permissions.js';
import { createLogger } from '../logger.js';
import { predictCycle } from '../../public/utils/health-cycle.js';

const log = createLogger('CycleReminders');

/**
 * Zyklus-Tab freigeschaltet? Drei Sichten wie in server/routes/preferences.js
 * (#760): Haushalts-Default, persönliches Opt-out, beides kombiniert. Nicht
 * von dort importiert - die Helfer sind modulintern und der Gedanke ist vier
 * Zeilen, keine eigene Abhängigkeit wert.
 */
function cycleTabEnabled(database, userId) {
  const household = database.prepare("SELECT value FROM sync_config WHERE key = 'health_cycle_enabled'").get()?.value;
  if (household === '0') return false;
  const personal = database.prepare('SELECT value FROM sync_config WHERE key = ?').get(`health_cycle_enabled:user:${userId}`)?.value;
  return personal !== '0';
}

/** Fehlt diesem Nutzer der Zugriff auf das Health-Modul überhaupt? */
function lacksHealth(database, userId) {
  const user = database.prepare('SELECT id, role, family_role FROM users WHERE id = ?').get(userId);
  if (!user) return true;
  return resolvePermissions(database, user).modules.health === 'none';
}

/** Anker + zugehörige Erinnerung einer Art abräumen, falls vorhanden. */
function dropAnchorAndReminder(database, userId, kind, entityType) {
  const anchor = database.prepare('SELECT id FROM cycle_reminder_anchors WHERE user_id = ? AND kind = ?').get(userId, kind);
  if (!anchor) return;
  database.prepare('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ?').run(entityType, anchor.id);
  database.prepare('DELETE FROM cycle_reminder_anchors WHERE id = ?').run(anchor.id);
}

/**
 * Soll-Zustand für EINE Erinnerungsart herstellen: Anker auf `targetDate`
 * bringen (alten abräumen, wenn sich das Zieldatum verschoben hat) und die
 * `reminders`-Zeile nachziehen.
 */
function upsertCycleReminder(database, userId, kind, entityType, targetDate, offsetDays, today) {
  const remindAt = reminderDateBefore(targetDate, offsetDays);

  const existingAnchor = database.prepare(
    'SELECT id, anchor_date FROM cycle_reminder_anchors WHERE user_id = ? AND kind = ?'
  ).get(userId, kind);
  if (existingAnchor && existingAnchor.anchor_date !== targetDate) {
    database.prepare('DELETE FROM reminders WHERE entity_type = ? AND entity_id = ?').run(entityType, existingAnchor.id);
    database.prepare('DELETE FROM cycle_reminder_anchors WHERE id = ?').run(existingAnchor.id);
  }

  // DATUMS-, NICHT UHRZEIT-SCHNITT (siehe Modulkommentar): ein Zieltag vor
  // heute ist wirklich vorbei, ein Zieltag von heute bekommt seine Erinnerung
  // auch nach 09:00 noch, nur eben sofort in diesem Durchgang.
  if (targetDate < today) return;

  const anchorId = database.prepare(`
    INSERT INTO cycle_reminder_anchors (user_id, anchor_date, kind) VALUES (?, ?, ?)
    ON CONFLICT(user_id, anchor_date, kind) DO UPDATE SET anchor_date = excluded.anchor_date
    RETURNING id
  `).get(userId, targetDate, kind).id;

  const existingReminder = database.prepare(
    'SELECT id, remind_at FROM reminders WHERE entity_type = ? AND entity_id = ?'
  ).get(entityType, anchorId);
  if (existingReminder) {
    // UNANGETASTET, wenn der Zeitpunkt gleich bleibt - sonst risse ein Lauf
    // alle paar Minuten pushed_at/dismissed zurück und dieselbe Meldung ginge
    // immer wieder raus.
    if (existingReminder.remind_at === remindAt) return;
    database.prepare('DELETE FROM reminders WHERE id = ?').run(existingReminder.id);
  }
  database.prepare(`
    INSERT INTO reminders (entity_type, entity_id, remind_at, created_by) VALUES (?, ?, ?, ?)
  `).run(entityType, anchorId, remindAt, userId);
}

/**
 * Vorhergesagter nächster Periodenbeginn, `remind_period_days_before` Tage
 * vorher. Rechnet mit derselben predictCycle()-Mathematik wie der Zyklus-Tab
 * selbst (inklusive der Vertrauensschwelle aus Phase 0 -
 * MIN_HISTORY_GAPS - und dem Schwangerschafts-Stopp).
 */
function syncPeriodReminder(database, userId, settings, today) {
  const daysBefore = settings?.remind_period_days_before;
  if (daysBefore == null) {
    dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
    return;
  }

  const periods = database.prepare('SELECT * FROM cycle_periods WHERE user_id = ? ORDER BY start_date ASC').all(userId);
  const prediction = predictCycle(periods, settings, today);
  if (!prediction.hasData || prediction.isPregnant || !prediction.nextStart) {
    dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
    return;
  }

  upsertCycleReminder(database, userId, 'period_predicted', 'cycle_period', prediction.nextStart, daysBefore, today);
}

/**
 * Täglicher Hinweis, den heutigen Tag einzutragen - entfällt, sobald für
 * heute schon ein Log vorliegt (gleich, ob mit oder ohne Inhalt: die Zeile
 * existiert, die Frage ist beantwortet).
 */
function syncLogNudgeReminder(database, userId, settings, today) {
  if (!settings?.remind_log_daily) {
    dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
    return;
  }

  const hasLogToday = database.prepare('SELECT 1 FROM cycle_day_logs WHERE user_id = ? AND log_date = ?').get(userId, today);
  if (hasLogToday) {
    dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
    return;
  }

  upsertCycleReminder(database, userId, 'log_nudge', 'cycle_log_nudge', today, 0, today);
}

/**
 * Soll-Zustand für EINEN Nutzer herstellen. Aufgerufen sowohl vom
 * periodischen Voll-Sync als auch sofort nach einer Einstellungsänderung
 * (server/routes/health/cycle.js), gleiche Erwartung wie überall sonst: eine
 * Änderung wirkt sofort, nicht erst beim nächsten Durchgang.
 *
 * @param {object} database
 * @param {number} userId
 * @param {Date} [now]
 */
export function syncCycleRemindersForUser(database, userId, now = new Date()) {
  if (lacksHealth(database, userId) || !cycleTabEnabled(database, userId)) {
    dropAnchorAndReminder(database, userId, 'period_predicted', 'cycle_period');
    dropAnchorAndReminder(database, userId, 'log_nudge', 'cycle_log_nudge');
    return;
  }

  const today = todayKey(database, now);
  const settings = database.prepare('SELECT * FROM cycle_settings WHERE user_id = ?').get(userId) || {};
  syncPeriodReminder(database, userId, settings, today);
  syncLogNudgeReminder(database, userId, settings, today);
}

/**
 * Für jeden Nutzer mit einer aktivierten Zyklus-Erinnerung (oder noch
 * bestehenden Ankern einer inzwischen abgeschalteten) den Soll-Zustand
 * herstellen. Läuft periodisch, gleiche Stelle wie der Vorrats- und
 * Geburtstags-Sync (server/services/notifications.js#processDueNotifications).
 *
 * @param {object} database
 * @param {Date} [now]
 */
export function syncAllCycleReminders(database, now = new Date()) {
  const withSettings = database.prepare(`
    SELECT user_id FROM cycle_settings WHERE remind_period_days_before IS NOT NULL OR remind_log_daily = 1
  `).all();
  // Bereits abgeschaltete Konten können trotzdem noch Anker/Erinnerungen von
  // einer früheren Einstellung tragen (Zyklus-Tab zwischenzeitlich gesperrt,
  // Berechtigung entzogen) - die Gates in syncCycleRemindersForUser() räumen
  // sie ab, auch wenn diese Auswahl sie nicht träfe.
  const withAnchors = database.prepare('SELECT user_id FROM cycle_reminder_anchors GROUP BY user_id').all();
  const candidateIds = new Set([...withSettings.map((r) => r.user_id), ...withAnchors.map((r) => r.user_id)]);
  for (const userId of candidateIds) {
    try {
      syncCycleRemindersForUser(database, userId, now);
    } catch (err) {
      log.error(`Cycle reminder sync failed for user ${userId}:`, err?.message || err);
    }
  }
}
