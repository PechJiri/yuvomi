/**
 * Modul: Zugriffsrechte (Rollen & Rechte)
 * Zweck: Geteiltes Berechtigungsmodell für interaktive Nutzer. Legt fest, welche
 *        Module ein Familienmitglied sehen/bearbeiten darf und welche Dashboard-
 *        Widgets ihm zur Verfügung stehen — konfigurierbar pro Familienrolle
 *        (Standard) und pro einzelnem Mitglied (Override). Siehe Discussion #467.
 *
 * Vertrag / Invarianten:
 *   - SPARSE-Speicherung: nur Abweichungen vom Standard landen in
 *     `access_permissions`. Fehlt eine Zeile → Modul 'write', Widget 'allow'.
 *     Dadurch verhalten sich Bestands-Installationen nach Migration v74
 *     unverändert (kein Zwangs-Lockout).
 *   - Dieser Standard ist für die MIGRATION entschieden, nicht für die
 *     EINLADUNG. Dass ein Konto ohne Zeilen alles sieht, ist für einen
 *     bestehenden Haushalt richtig und für ein neu eingeladenes Mitglied nur
 *     geerbt (#869). Die Antwort dort liegt bewusst NICHT hier: wer den
 *     Standard umdreht, um sie zu geben, sperrt beim nächsten Update genau die
 *     Haushalte aus, die v74 schützen sollte. Sie liegt in der Vorauswahl des
 *     Einladungsformulars (settings/pages/admin-family.js), die eng startet
 *     und zeigt, was die gewählte Rolle darf - eine Formular-Voreinstellung,
 *     kein gespeicherter Standard.
 *   - Admins (users.role = 'admin') umgehen das System vollständig: immer
 *     Vollzugriff, kein Scoping. So kann sich niemand selbst aussperren.
 *   - Auflösungsreihenfolge für ein Mitglied: Mitglied-Override ?? Rollen-Profil
 *     ?? Standard.
 *   - Widgets erben die Modulsperre: Modul 'none' → zugehörige Widgets gesperrt.
 *
 * Die Modulschlüssel sind IDENTISCH mit den Scope-Modulschlüsseln aus scopes.js,
 * damit die Backend-Durchsetzung dieselbe Prüf-Infrastruktur nutzt (ein
 * eingeschränktes Mitglied bekommt eine Modul→Access-Map, die die /api/v1-
 * Middleware wie ein gescoptes Token auswertet).
 *
 * Bewusst nur Abhängigkeit zu scopes.js (kein express) — nutzbar in Middleware,
 * Routen und Tests.
 */

import { MODULE_KEYS } from './scopes.js';

// Familienrollen (Subjekt-Achse „role"). Spiegelt den CHECK-Constraint der
// users.family_role-Spalte (Migration, db.js).
export const FAMILY_ROLES = Object.freeze([
  'dad', 'mom', 'parent', 'child', 'grandparent', 'relative', 'other',
]);

// Gateable, nutzer-sichtbare Module. `key` === Scope-Modulschlüssel (scopes.js),
// `navIds` = zugehörige Navigations-/Kitchen-IDs im Frontend (für die Nav-Filterung;
// mehrere Nav-Einträge können sich ein Modul teilen, z. B. calendar+birthdays).
export const PERMISSION_MODULES = Object.freeze([
  { key: 'calendar',     labelKey: 'nav.calendar',     icon: 'calendar',      navIds: ['calendar', 'birthdays'] },
  { key: 'tasks',        labelKey: 'nav.tasks',        icon: 'check-square',  navIds: ['tasks'] },
  { key: 'notes',        labelKey: 'nav.notes',        icon: 'sticky-note',   navIds: ['notes'] },
  { key: 'contacts',     labelKey: 'nav.contacts',     icon: 'book-user',     navIds: ['contacts'] },
  { key: 'meals',        labelKey: 'nav.kitchen',      icon: 'utensils',      navIds: ['meals', 'recipes'] },
  { key: 'shopping',     labelKey: 'nav.shopping',     icon: 'shopping-cart', navIds: ['shopping'] },
  { key: 'pantry',       labelKey: 'nav.pantry',       icon: 'archive',       navIds: ['pantry'] },
  { key: 'inventory',    labelKey: 'nav.inventory',    icon: 'package',       navIds: ['inventory'] },
  { key: 'budget',       labelKey: 'nav.budget',       icon: 'wallet',        navIds: ['budget'] },
  { key: 'documents',    labelKey: 'nav.documents',    icon: 'folder-lock',   navIds: ['documents'] },
  { key: 'housekeeping', labelKey: 'nav.housekeeping', icon: 'paintbrush',    navIds: ['housekeeping'] },
  { key: 'rewards',      labelKey: 'nav.rewards',      icon: 'award',         navIds: ['rewards'] },
  { key: 'health',       labelKey: 'nav.health',       icon: 'heart-pulse',   navIds: ['health'] },
  { key: 'schedule',     labelKey: 'nav.schedule',     icon: 'calendar-clock', navIds: ['schedule'] },
]);

// Dashboard-Widgets mit ihrem Trägermodul (aus dashboard.js MODULE_FOR_WIDGET).
// `module: null` → kein Modul-Gate (family/weather sind infrastrukturell).
// Das cycle-Widget hängt am Modul health, ist aber separat sperrbar — so lässt
// es sich z. B. für einzelne Mitglieder ausblenden, ohne Gesundheit ganz zu
// sperren (#467).
export const PERMISSION_WIDGETS = Object.freeze([
  { id: 'tasks',        module: 'tasks' },
  { id: 'calendar',     module: 'calendar' },
  { id: 'meals',        module: 'meals' },
  { id: 'shopping',     module: 'shopping' },
  { id: 'birthdays',    module: 'calendar' },
  { id: 'budget',       module: 'budget' },
  { id: 'rewards',      module: 'rewards' },
  { id: 'health',       module: 'health' },
  { id: 'cycle',        module: 'health' },
  { id: 'housekeeping', module: 'housekeeping' },
  { id: 'notes',        module: 'notes' },
  { id: 'family',       module: null },
  { id: 'weather',      module: null },
  { id: 'clock',        module: null },
  // `module: null` wie Familie, Wetter und Uhr, und hier aus einem eigenen
  // Grund: die Kennzahlreihe gehoert keinem Modul, sie zeigt vier davon. Eine
  // Zuordnung zu einem einzelnen waere falsch, und sie wird auch nicht
  // gebraucht - jede EINZELNE Kachel prueft ihr Modul schon selbst
  // (`renderMetricTiles` filtert ueber `isWidgetModuleEnabled`), ein gesperrtes
  // Budget hat also nie eine Budget-Kachel. Was hier fehlte, ist die Sperre auf
  // die REIHE als solche.
  { id: 'metrics',      module: null },
  // `module: null` aus demselben Grund wie die Kennzahlreihe: der Countdown
  // (#647) sammelt aus Kalender UND Aufgaben ein, gehört also keinem der
  // beiden. Was aus einem gesperrten Modul stammt, filtert die Kachel schon
  // selbst - hier steht die Sperre auf das Widget als solches.
  { id: 'countdown',    module: null },
  // `module: null` wie Familie, Wetter und Uhr: eine Reihe Haushaltslinks
  // (#469) gehoert keinem Modul. Die private Achse setzt die Route selbst
  // durch; hier steht die Sperre auf die REIHE - ein Haushalt, der seinen
  // Kindern die Startseite nicht zur Startrampe machen will, hat damit einen
  // Schalter.
  { id: 'quicklinks',    module: null },
]);

export const MODULE_ACCESS_LEVELS = Object.freeze(['none', 'read', 'write']);
export const WIDGET_ACCESS_LEVELS = Object.freeze(['none', 'allow']);
const MODULE_DEFAULT = 'write';
const WIDGET_DEFAULT = 'allow';

const MODULE_KEY_SET = new Set(PERMISSION_MODULES.map((m) => m.key));
const WIDGET_ID_SET = new Set(PERMISSION_WIDGETS.map((w) => w.id));
const MODULE_ACCESS_SET = new Set(MODULE_ACCESS_LEVELS);
const WIDGET_ACCESS_SET = new Set(WIDGET_ACCESS_LEVELS);
const FAMILY_ROLE_SET = new Set(FAMILY_ROLES);

// Sicherheitsnetz: jeder Permissions-Modulschlüssel muss ein echtes Scope-Modul
// sein, sonst greift die Backend-Durchsetzung ins Leere.
for (const m of PERMISSION_MODULES) {
  if (!MODULE_KEYS.includes(m.key)) {
    throw new Error(`[permissions] Unknown scope module: ${m.key}`);
  }
}

/** Liest die gespeicherten (abweichenden) Rechte-Zeilen eines Subjekts. */
function loadSubjectRows(database, subjectType, subjectId) {
  return database
    .prepare('SELECT resource_type, resource_key, access FROM access_permissions WHERE subject_type = ? AND subject_id = ?')
    .all(subjectType, String(subjectId));
}

/**
 * Löst die effektiven Rechte eines konkreten Nutzers auf.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 * @param {{ id: number, role: string, family_role?: string }} user
 * @returns {{ admin: boolean, modules: Record<string,'none'|'read'|'write'>, widgets: Record<string,'none'|'allow'> }}
 */
export function resolvePermissions(database, user) {
  const isAdmin = user?.role === 'admin';
  const modules = {};
  const widgets = {};
  for (const m of PERMISSION_MODULES) modules[m.key] = isAdmin ? 'write' : MODULE_DEFAULT;
  for (const w of PERMISSION_WIDGETS) widgets[w.id] = isAdmin ? 'allow' : WIDGET_DEFAULT;
  if (isAdmin) return { admin: true, modules, widgets };

  const apply = (rows) => {
    for (const r of rows) {
      if (r.resource_type === 'module' && MODULE_KEY_SET.has(r.resource_key) && MODULE_ACCESS_SET.has(r.access)) {
        modules[r.resource_key] = r.access;
      } else if (r.resource_type === 'widget' && WIDGET_ID_SET.has(r.resource_key) && WIDGET_ACCESS_SET.has(r.access)) {
        widgets[r.resource_key] = r.access;
      }
    }
  };

  // 1. Rollen-Profil, 2. Mitglied-Override (gewinnt).
  if (user?.family_role && FAMILY_ROLE_SET.has(user.family_role)) {
    apply(loadSubjectRows(database, 'role', user.family_role));
  }
  if (user?.id != null) {
    apply(loadSubjectRows(database, 'user', user.id));
  }

  // Widgets erben die Modulsperre.
  for (const w of PERMISSION_WIDGETS) {
    if (w.module && modules[w.module] === 'none') widgets[w.id] = 'none';
  }
  return { admin: false, modules, widgets };
}

/**
 * Baut die Modul→Access-Map für die /api/v1-Session-Durchsetzung.
 * Nur abweichende (eingeschränkte) Module werden gelistet; fehlt ein Modul,
 * gilt Vollzugriff. Gibt `null` zurück, wenn nichts eingeschränkt ist
 * (Fast-Path: Middleware ohne Arbeit) oder der Nutzer Admin ist.
 * @returns {Record<string,'none'|'read'>|null}
 */
export function buildSessionModuleAccess(resolved) {
  if (!resolved || resolved.admin) return null;
  const map = {};
  let restricted = false;
  for (const [key, access] of Object.entries(resolved.modules)) {
    if (access !== 'write') {
      map[key] = access;
      restricted = true;
    }
  }
  return restricted ? map : null;
}

/**
 * Die Module, die einem Betrachter GANZ entzogen sind — als Set.
 *
 * Eingabe ist `req.sessionModuleAccess`, also genau das, was die Middleware in
 * server/index.js schon aufgelöst hat: null (Admin oder unbeschränkt) oder eine
 * Karte der abweichenden Module. Kein zweiter DB-Zugriff, keine zweite
 * Auflösung — eine zweite Wahrheit über Rechte wäre die teuerste Sorte Fehler.
 *
 * NUR 'none' ZÄHLT, NICHT 'read'. Wer nur lesen darf, darf lesen; ein Filter,
 * der ihm die Daten wegnimmt, hätte aus der Leseberechtigung eine Sperre
 * gemacht.
 *
 * Gedacht für aggregierende Endpunkte, die die Pfad-Middleware nicht abdeckt:
 * /dashboard trägt Inhalte aus einem Dutzend Modulen, sein eigener Pfad löst
 * aber auf das Scope-Modul `dashboard` auf, das gar kein Permissions-Modul ist.
 * Der Guard lässt die Anfrage deshalb immer durch, und das Aussortieren muss in
 * der Route passieren.
 *
 * @param {Record<string,'none'|'read'>|null|undefined} sessionModuleAccess
 * @returns {Set<string>}
 */
export function deniedModules(sessionModuleAccess) {
  const out = new Set();
  for (const [key, level] of Object.entries(sessionModuleAccess || {})) {
    if (level === 'none') out.add(key);
  }
  return out;
}

// Urteil der Modulrechte-Prüfung. 'allow' = durchlassen, 'none' = Modul ganz
// gesperrt, 'read-only' = nur Lesen erlaubt, Schreibversuch abgewiesen.
export const MODULE_ACCESS_ALLOW = 'allow';
export const MODULE_ACCESS_DENIED = 'none';
export const MODULE_ACCESS_READ_ONLY = 'read-only';

/**
 * Erlaubt die aufgelöste Modulrechte-Karte diesen Zugriff?
 *
 * DIE Prüfung für jede Oberfläche, die Haushaltsdaten herausgibt — REST wie
 * MCP. Sie stand vorher nur inline in der /api/v1-Middleware, und genau das war
 * der Fehler aus #823: die MCP-Kern-Tools laufen in-process an express vorbei,
 * hatten damit keine Modulprüfung und gaben einem Mitglied mit `tasks: none`
 * die Aufgaben trotzdem heraus. Eine zweite Schreibweise derselben Regel wäre
 * dieselbe Falle noch einmal — deshalb ein Aufruf, kein Nachbau.
 *
 * DENY-Liste, keine Allow-Liste: `null` (Admin/unbeschränkt) und jedes nicht
 * gelistete Modul sind erlaubt. Nur was ausdrücklich eingeschränkt wurde, wird
 * abgewiesen.
 *
 * @param {Record<string,'none'|'read'>|null|undefined} sessionModuleAccess
 * @param {string|null} moduleKey - Scope-Modulschlüssel (scopes.js)
 * @param {'read'|'write'} access
 * @returns {'allow'|'none'|'read-only'}
 */
export function moduleAccessVerdict(sessionModuleAccess, moduleKey, access) {
  if (!sessionModuleAccess) return MODULE_ACCESS_ALLOW;
  if (!moduleKey || !(moduleKey in sessionModuleAccess)) return MODULE_ACCESS_ALLOW;
  const level = sessionModuleAccess[moduleKey];
  if (level === 'none') return MODULE_ACCESS_DENIED;
  if (level === 'read' && access === 'write') return MODULE_ACCESS_READ_ONLY;
  return MODULE_ACCESS_ALLOW;
}

/**
 * Nur-Lese-Payload für Clients (/auth/me, /login): die aufgelösten Maps plus
 * Admin-Flag. Der Client blendet damit Nav-Einträge, Settings-Ziele und
 * Dashboard-Widgets aus — die verbindliche Durchsetzung bleibt serverseitig.
 */
export function clientPermissions(database, user) {
  const { admin, modules, widgets } = resolvePermissions(database, user);
  return { admin, modules, widgets };
}

/** Voller Katalog für die Admin-UI (Module, Widgets, Rollen). */
export function permissionCatalog() {
  return {
    modules: PERMISSION_MODULES.map((m) => ({ key: m.key, labelKey: m.labelKey, icon: m.icon })),
    widgets: PERMISSION_WIDGETS.map((w) => ({ id: w.id, module: w.module })),
    roles: [...FAMILY_ROLES],
    moduleAccessLevels: [...MODULE_ACCESS_LEVELS],
    widgetAccessLevels: [...WIDGET_ACCESS_LEVELS],
    defaults: { module: MODULE_DEFAULT, widget: WIDGET_DEFAULT },
  };
}

/**
 * Liefert die GESPEICHERTEN (abweichenden) Rechte eines Subjekts als Maps —
 * für die Admin-UI, die den Ist-Zustand editiert. Nicht gelistete Ressourcen
 * stehen implizit auf Standard.
 * @param {'role'|'user'} subjectType
 * @param {string|number} subjectId
 */
export function getSubjectPermissions(database, subjectType, subjectId) {
  const rows = loadSubjectRows(database, subjectType, subjectId);
  const modules = {};
  const widgets = {};
  for (const r of rows) {
    if (r.resource_type === 'module' && MODULE_KEY_SET.has(r.resource_key)) modules[r.resource_key] = r.access;
    else if (r.resource_type === 'widget' && WIDGET_ID_SET.has(r.resource_key)) widgets[r.resource_key] = r.access;
  }
  return { modules, widgets };
}

/**
 * Validiert und normalisiert eine eingehende Rechte-Map (aus dem PUT-Body) zu
 * einer flachen Zeilen-Liste. Nur bekannte Schlüssel/Access-Werte werden
 * übernommen; Standard-Werte werden verworfen (Sparse-Prinzip). Wirft bei
 * ungültigen Werten.
 * @returns {{ resource_type: string, resource_key: string, access: string }[]}
 */
export function normalizePermissionInput({ modules = {}, widgets = {} } = {}) {
  const rows = [];
  for (const [key, access] of Object.entries(modules || {})) {
    if (!MODULE_KEY_SET.has(key)) throw new Error(`Unknown module: ${key}`);
    if (!MODULE_ACCESS_SET.has(access)) throw new Error(`Invalid module access: ${access}`);
    if (access === MODULE_DEFAULT) continue; // Standard nicht speichern
    rows.push({ resource_type: 'module', resource_key: key, access });
  }
  for (const [id, access] of Object.entries(widgets || {})) {
    if (!WIDGET_ID_SET.has(id)) throw new Error(`Unknown widget: ${id}`);
    if (!WIDGET_ACCESS_SET.has(access)) throw new Error(`Invalid widget access: ${access}`);
    if (access === WIDGET_DEFAULT) continue;
    rows.push({ resource_type: 'widget', resource_key: id, access });
  }
  return rows;
}

/**
 * Ersetzt die komplette Rechte-Zeile eines Subjekts atomar (delete + insert der
 * abweichenden Einträge). Transaktion vom Aufrufer bereitgestellt oder hier
 * gekapselt.
 * @param {import('better-sqlite3-multiple-ciphers').Database} database
 */
export function replaceSubjectPermissions(database, subjectType, subjectId, input) {
  const rows = normalizePermissionInput(input);
  const del = database.prepare('DELETE FROM access_permissions WHERE subject_type = ? AND subject_id = ?');
  const ins = database.prepare(`
    INSERT INTO access_permissions (subject_type, subject_id, resource_type, resource_key, access)
    VALUES (?, ?, ?, ?, ?)
  `);
  // Portable Transaktion (BEGIN/COMMIT/ROLLBACK): funktioniert sowohl mit
  // better-sqlite3 (Produktion) als auch node:sqlite (Tests). Kein
  // database.transaction()-Helfer, den node:sqlite nicht kennt.
  database.exec('BEGIN');
  try {
    del.run(subjectType, String(subjectId));
    for (const r of rows) ins.run(subjectType, String(subjectId), r.resource_type, r.resource_key, r.access);
    database.exec('COMMIT');
  } catch (err) {
    database.exec('ROLLBACK');
    throw err;
  }
  return getSubjectPermissions(database, subjectType, subjectId);
}

export function isValidFamilyRole(role) {
  return FAMILY_ROLE_SET.has(role);
}
