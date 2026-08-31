/**
 * Modul: Guard - Kuechentimer der Wandflaeche (#844)
 * Zweck: Der Timer ist das erste Bedienelement auf einer Flaeche, die als
 *        "reine Anzeige" angelegt wurde. Er bricht die Zusage nicht, aber er
 *        markiert ihren Rand - und der Kopfkommentar von `utils/wall-mode.js`
 *        haelt seit #844 eine AUFNAHMEREGEL statt einer Ausnahme fest. Diese
 *        Suite prueft die vier Bedingungen dieser Regel am gebauten Markup und
 *        am Modul, nicht am Vorsatz:
 *          (a) navigiert nicht, (b) aendert nichts am Haushalt,
 *          (c) bleibt auf diesem Geraet, (d) ist aus zwei Metern bedienbar.
 *        Dazu die Zustandsableitung, die den ganzen Timer traegt: aus EINER
 *        gespeicherten Zahl - was die Flaeche ueberleben laesst, dass sie beim
 *        stillen Refresh neu gebaut wird.
 * Ausfuehren: npm run test:wall-timer
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Ein localStorage, das sich wie eines verhaelt - der Timer liest und schreibt
// nichts anderes. Muss VOR dem Import stehen: das Modul greift beim ersten
// Aufruf darauf zu.
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const {
  readWallTimer, startWallTimer, clearWallTimer, formatWallTimer,
  renderWallTimer, WALL_TIMER_PRESETS,
} = await import('../public/components/wall-timer.js');

const SOURCE = readFileSync(new URL('../public/components/wall-timer.js', import.meta.url), 'utf8');
const WALL_MODE = readFileSync(new URL('../public/utils/wall-mode.js', import.meta.url), 'utf8');

test.beforeEach(() => store.clear());

// --------------------------------------------------------
// Der Zustand ist eine Zahl
// --------------------------------------------------------

test('ohne Eintrag laeuft keiner', () => {
  assert.equal(readWallTimer().state, 'idle');
});

test('ein Zeitpunkt in der Zukunft laeuft, einer in der Vergangenheit ist fertig', () => {
  const now = 1_700_000_000_000;
  startWallTimer(5, now);
  assert.equal(readWallTimer(now).state, 'running');
  assert.equal(readWallTimer(now + 4 * 60_000).state, 'running', 'eine Minute vor Schluss laeuft er noch');
  assert.equal(readWallTimer(now + 5 * 60_000).state, 'done', 'auf die Sekunde genau ist er fertig');
  assert.equal(readWallTimer(now + 60 * 60_000).state, 'done', 'und bleibt es, bis jemand quittiert');
});

test('Abbrechen und Quittieren gehen denselben Weg', () => {
  startWallTimer(5);
  clearWallTimer();
  assert.equal(readWallTimer().state, 'idle');
});

test('ein unlesbarer Eintrag ist kein Timer, kein NaN in der Anzeige', () => {
  // Ein fremder Wert im Storage (Handarbeit, alte Version, halber Schreibvorgang)
  // darf nicht als "00:NaN" ueber die Wand laufen.
  global.localStorage.setItem('yuvomi-wall-timer', 'gestern');
  assert.equal(readWallTimer().state, 'idle');
});

test('der laufende Timer ueberlebt einen Neuaufbau der Flaeche', () => {
  // Die eigentliche Eigenschaft: der stille Refresh baut die Wand regelmaessig
  // neu. Ein Zustand im DOM oder im Modul waere dabei jedes Mal weg - deshalb
  // liest jede Ableitung aus dem Storage, nicht aus einer Variablen.
  const now = 1_700_000_000_000;
  startWallTimer(10, now);
  const ersteAnzeige = renderWallTimer(readWallTimer(now)).display;
  const zweiteAnzeige = renderWallTimer(readWallTimer(now + 1000)).display;
  assert.match(ersteAnzeige, /10:00/, 'frisch gestartet');
  assert.match(zweiteAnzeige, /09:59/, 'eine Sekunde spaeter, ohne dass etwas im DOM ueberlebt haette');
});

test('mm:ss rundet auf: ein angebrochener Rest ist fuer den Lesenden noch da', () => {
  assert.equal(formatWallTimer(0), '00:00');
  assert.equal(formatWallTimer(400), '00:01', 'vier Zehntel sind noch eine Sekunde');
  assert.equal(formatWallTimer(59_000), '00:59');
  assert.equal(formatWallTimer(60_000), '01:00');
  assert.equal(formatWallTimer(30 * 60_000), '30:00', 'die laengste Voreinstellung bleibt zweistellig');
  assert.equal(formatWallTimer(-5000), '00:00', 'ein negativer Rest ist keine negative Zeit');
});

// --------------------------------------------------------
// Die Aufnahmeregel aus wall-mode.js, am Markup geprueft
// --------------------------------------------------------

test('(a) der Timer navigiert nicht - kein Link, keine Route, kein Modal', () => {
  const now = 1_700_000_000_000;
  const stuecke = [
    renderWallTimer({ state: 'idle', remainingMs: 0 }),
    (startWallTimer(5, now), renderWallTimer(readWallTimer(now))),
    renderWallTimer({ state: 'done', remainingMs: 0 }),
  ];
  // Reichweite zuerst: ein Pruefer, der auf leeres Markup schaut, meldet sonst
  // fehlerfrei "keine Verstoesse".
  const markup = stuecke.map((s) => s.display + s.controls);
  assert.equal(markup.filter((m) => m.trim().length > 0).length, 3, 'drei Zustaende haben Markup');
  for (const m of markup) {
    assert.ok(!/<a\b|href=|data-route=|data-modal|openModal/.test(m),
      `ein Zustand des Timers fuehrt von der Wand weg: ${m.slice(0, 120)}`);
  }
});

test('(b) er aendert nichts am Haushalt - das Modul kennt die API gar nicht', () => {
  assert.ok(!/from '.*\/api\.js'|api\.(get|post|put|patch|delete)\(|fetch\(/.test(SOURCE),
    'ein Server-Aufruf im Timer waere ein Zustand, der auf einem zweiten Geraet ankommt');
});

test('(c) er bleibt auf diesem Geraet - localStorage, wie der Modus selbst', () => {
  assert.match(SOURCE, /localStorage/, 'der Zustand liegt geraetelokal');
  // Dieselbe Begruendung wie beim Modus (geteiltes Konto): eine servergespeicherte
  // Einstellung startete allen Familienmitgliedern den Timer.
  assert.ok(!/sessionStorage|document\.cookie/.test(SOURCE), 'und nirgends sonst');
});

test('(d) er ist aus zwei Metern bedienbar - wenige grosse Ziele, kein Eingabefeld', () => {
  const { controls } = renderWallTimer({ state: 'idle', remainingMs: 0 });
  const knoepfe = controls.match(/<button/g) ?? [];
  assert.equal(knoepfe.length, WALL_TIMER_PRESETS.length, 'ein Knopf je Voreinstellung');
  assert.ok(WALL_TIMER_PRESETS.length <= 6, 'mehr als eine Handvoll trifft aus zwei Metern niemand');
  assert.ok(!/<input|<select|contenteditable/.test(controls),
    'ein Tastenfeld ist aus zwei Metern nicht bedienbar');
  // Und ohne Auswahl-Ebene davor: ein Tipp startet, nicht zwei.
  assert.ok(!/<details|aria-expanded|data-popover/.test(controls),
    'ein Menue waere ein zweiter Tipp - und sein offener Zustand ueberlebte den stillen Refresh nicht');
});

test('die Aufnahmeregel steht dort, wo die anderen Entscheidungen des Modus stehen', () => {
  // Ein Timer, dessen Begruendung nur im Commit steht, ist beim naechsten
  // Wunsch wieder eine Einzelfallentscheidung.
  assert.match(WALL_MODE, /AUFNAHMEREGEL/, 'die Regel steht im Kopf von wall-mode.js');
  assert.match(WALL_MODE, /#844/, 'und nennt den Fall, der sie ausgeloest hat');
});

// --------------------------------------------------------
// Screensaver: der Timer verschwindet nicht hinter einem Foto
// --------------------------------------------------------

test('der Screensaver liest dasselbe Attribut, das der Timer setzt', () => {
  const screensaver = readFileSync(new URL('../public/components/photo-screensaver.js', import.meta.url), 'utf8');
  // EINE Quelle, zwei Leser - wie `data-wall-mode`. Zwei Namen fuer denselben
  // Zustand liefen beim ersten Umbenennen auseinander, und der Fehler waere ein
  // Timer, der still hinter einem Bild ablaeuft.
  assert.match(SOURCE, /data-wall-timer/, 'der Timer setzt das Attribut');
  assert.match(screensaver, /data-wall-timer/, 'der Screensaver liest es');
  assert.match(screensaver, /hasAttribute\('data-wall-timer'\)[\s\S]{0,40}return false/,
    'und legt sich nicht darueber, solange es steht');
});
