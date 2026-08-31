/**
 * Der Wand-Modus: der WACHE Zustand des Dashboards.
 *
 * PRODUCT.md nennt das Wandtablet als Kernszene, und gebaut waren dafuer bisher
 * drei Einzelteile, die sie nur einzeln bedienen: die Uhr-Kachel (#651), die
 * Wetterkarte als Opt-in und der Immich-Screensaver nach fuenf Minuten Ruhe
 * (#693). Zusammen ergaben sie keinen Zustand, sondern drei Haekchen im
 * Anpassen-Panel. Dieser Modus ist der Zustand: eine Anzeige fuer zwei bis drei
 * Sekunden aus zwei Metern Entfernung, ohne dass jemand das Geraet beruehrt.
 *
 * Er ist der WACHE Zustand - der Screensaver bleibt der ruhende und legt sich
 * nach seiner Leerlaufzeit unveraendert darueber.
 *
 * ── VIER ENTSCHEIDUNGEN, DIE HIER WOHNEN ──────────────────────────────────
 *
 * 1. EIN ZUSTAND, KEINE ROUTE. Der Modus lebt auf `/`. Ein zweiter Ort, an dem
 *    „Heute" gebaut wird, waere eine zweite Wahrheit, die auseinanderlaeuft -
 *    dieselbe Falle, die bei Modulnamen und Kachelgroessen schon zweimal
 *    zugeschlagen hat. Deshalb steht hier eine Routen-Bedingung und kein
 *    eigener Eintrag in der Routen-Tabelle.
 *
 * 2. GERAETELOKAL UND MANUELL. `localStorage`, wie Theme und Locale - und aus
 *    demselben Grund: das Wandtablet laeuft in der Praxis auf einem geteilten
 *    Konto, eine servergespeicherte Einstellung schaltete allen
 *    Familienmitgliedern das Handy-Dashboard um. Keine Automatik nach
 *    Geraeteform: eine Fehlerkennung auf dem Laptop erzeugte einen Zustand, den
 *    niemand angefordert hat und den man dann erst wieder loswerden muss.
 *
 * 3. NACHTABSENKUNG NACH UHRZEIT. Das Tablet haengt im Flur und leuchtet um
 *    drei. Das Problem ist die Leuchtdichte, nicht der Farbmodus: ein dunkles
 *    Theme leuchtet immer noch. Zwischen 22 und 6 Uhr traegt die Wurzel deshalb
 *    `data-wall-night`, und der dunkle Grund wird ERZWUNGEN, auch wenn das
 *    Theme hell steht. Erzwungen heisst hier nicht gespeichert: die Wahl des
 *    Nutzers in `yuvomi-theme` bleibt unberuehrt, sie ist die Quelle, aus der
 *    `restoreUserTheme()` am Morgen zurueckstellt.
 *
 * 4. REINE ANZEIGE. Der Modus ist ein Read-Zustand: die Programmzeilen sind
 *    Text, keine Links. Das steht nicht hier, sondern in den Renderern - hier
 *    steht nur, warum es keinen Kiosk-Lockdown gibt: der Modus ist eine
 *    Darstellung, keine Sicherheitsgrenze.
 *
 * ── WARUM DIE ATTRIBUTE AN DER WURZEL HAENGEN ─────────────────────────────
 *
 * Der Modus blendet Sidebar und Tab-Leiste aus, und beide sind Shell-Elemente
 * ausserhalb des Seiten-Containers. Ein Zustand, den nur das Dashboard-Markup
 * traegt, erreichte sie nicht. `data-wall-mode` an `<html>` ist derselbe
 * Mechanismus, mit dem `household-solo` reines Layout erreicht: eine Quelle,
 * zwei Wege.
 */

import { nowFields } from './timezone.js';

const WALL_KEY = 'yuvomi-wall-mode';
const THEME_KEY = 'yuvomi-theme';

/** Ab dieser Stunde (einschliesslich) ist Nacht. */
export const WALL_NIGHT_FROM = 22;
/** Ab dieser Stunde (einschliesslich) ist wieder Tag. */
export const WALL_NIGHT_TO = 6;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Privatmodus/Quota: der Modus gilt dann fuer diese Sitzung nicht.
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Siehe safeGet - ein nicht schreibbarer Storage darf nichts abbrechen.
  }
}

function safeRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Siehe safeGet.
  }
}

/** Ist der Modus auf DIESEM Geraet eingeschaltet? */
export function isWallModeEnabled() {
  return safeGet(WALL_KEY) === '1';
}

/** Schaltet den Modus auf diesem Geraet ein oder aus. */
export function setWallModeEnabled(enabled) {
  if (enabled) safeSet(WALL_KEY, '1');
  else safeRemove(WALL_KEY);
}

/**
 * Die eine Stelle, an der steht, wo der Modus gilt.
 *
 * Er ist ein Zustand des Dashboards, also genau dessen Route. Ein Vergleich
 * ohne diesen Namen waere die Sorte Bedingung, die beim naechsten Routen-Umbau
 * still stehen bleibt.
 */
export function isWallRoute(path) {
  return path === '/';
}

/**
 * Nachtfenster. Ueber Mitternacht hinweg, deshalb ODER statt UND - dieselbe
 * Falle, die das Tagesprogramm beim Mitternachts-Ausblick schon einmal hatte.
 */
export function isWallNight(now = new Date()) {
  // Die Uhr des Haushalts, nicht die des Geraets: ein Wandbildschirm, dessen
  // Browser in einer anderen Zone steht, ginge sonst zur falschen Stunde in den
  // Nachtmodus (#829 Teil 3).
  const hour = nowFields(now).hour;
  return hour >= WALL_NIGHT_FROM || hour < WALL_NIGHT_TO;
}

/** Laeuft die Flaeche gerade als Wand? Liest den Zustand, den `syncWallMode` setzt. */
export function isWallActive() {
  return document.documentElement.hasAttribute('data-wall-mode');
}

/**
 * Stellt das Theme auf die WAHL DES NUTZERS zurueck.
 *
 * Dieselbe Drei-Wege-Logik steht in `theme-init.js` (Erstzustand vor dem
 * Rendern) und in `router.js` (`applyTheme`, mit Persistenz). Hier steht sie
 * ein drittes Mal, weil dieser Pfad genau das NICHT tun darf, was die anderen
 * beiden tun: `applyTheme` schriebe den erzwungenen Nachtwert nach
 * `yuvomi-theme` und loeschte damit die Wahl, die wir gerade
 * wiederherstellen wollen.
 */
function restoreUserTheme() {
  const stored = safeGet(THEME_KEY);
  if (stored === 'dark' || stored === 'light') {
    document.documentElement.setAttribute('data-theme', stored);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

/**
 * Bringt die Wurzel-Attribute auf den Stand von Route, Schalter und Uhrzeit.
 *
 * Idempotent und billig: der Minutentakt der Uhr ruft sie mit, damit der
 * Wechsel um 22:00 und um 06:00 passiert, wenn er passiert - und nicht erst
 * beim naechsten Laden. Sie ist die EINZIGE Stelle, die diese Attribute setzt.
 *
 * @param {string} path Der aktive Pfad.
 * @returns {boolean} Ob die Wand danach laeuft.
 */
export function syncWallMode(path = location.pathname) {
  const root = document.documentElement;
  const active = isWallModeEnabled() && isWallRoute(path);
  const night = active && isWallNight();
  const wasNight = root.hasAttribute('data-wall-night');

  root.toggleAttribute('data-wall-mode', active);
  root.toggleAttribute('data-wall-night', night);

  if (night && !wasNight) {
    // Erzwungen, nicht gespeichert: `yuvomi-theme` bleibt, wie der Nutzer es
    // gewaehlt hat.
    root.setAttribute('data-theme', 'dark');
  } else if (!night && wasNight) {
    restoreUserTheme();
  }

  // Die Statusbar der installierten PWA haengt am `data-theme` der Wurzel
  // (router.js: setThemeColor liest es). Ohne dieses Nachziehen stuende ueber
  // der abgedunkelten Nachtflaeche eine helle Leiste.
  if (night !== wasNight) window.yuvomi?.restoreThemeColor?.();

  return active;
}

/** Schaltet den Modus aus und raeumt die Wurzel sofort auf. */
export function exitWallMode() {
  setWallModeEnabled(false);
  syncWallMode(location.pathname);
}

/**
 * Gegenstueck zu `exitWallMode`, und erst seit #915 ueberhaupt vorhanden.
 *
 * Der Modus liess sich nur unter Einstellungen -> Persoenlich -> Darstellung
 * einschalten, verlassen aber auf der Uebersicht: man ging dort hinaus, wo man
 * nicht hineinkam. Der Weg ueber die Einstellungen bleibt - er ist der
 * ausfuehrliche, mit Erklaerung daneben; dies ist der kurze am Ort der Wirkung.
 */
export function enterWallMode() {
  setWallModeEnabled(true);
  syncWallMode(location.pathname);
}
