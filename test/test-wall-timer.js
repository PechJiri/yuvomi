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

  // Die REGEL, nicht die Schreibweise: im Attribut-Zweig wird nicht gestartet.
  // Die erste Fassung verlangte `return false` unmittelbar dahinter und wurde
  // rot, als genau dort die Neuplanung dazukam - ein Guard, der beim
  // Richtigstellen bricht, prueft den Wortlaut statt die Sache.
  const zweig = screensaver.slice(screensaver.indexOf("hasAttribute('data-wall-timer')"));
  const block = zweig.slice(0, zweig.indexOf('\n  }') + 4);
  assert.match(block, /return false/, 'solange das Attribut steht, startet er nicht');
  assert.ok(!/overlay\s*=|appendChild/.test(block), 'und baut auch kein Overlay');

  // UND ER VERBRAUCHT NICHT SEINEN EINZIGEN VERSUCH (Review zu #844). `start()`
  // haengt an einem einmaligen Idle-Timeout; ein blosses `return false` liesse
  // den Screensaver bis zur naechsten Geste aus - auf einem Wandtablet koennen
  // das Stunden sein. Der Timer darf ihn verschieben, nicht abschalten.
  assert.match(block, /idleTimer\s*=\s*setTimeout\(\s*start/,
    'der Attribut-Zweig plant einen neuen Versuch, statt den letzten zu verbrauchen');
});

// --------------------------------------------------------
// Was der Review zu #844 gefunden hat
// --------------------------------------------------------

test('der Audiokontext lebt ausserhalb des Renders - sonst klingelt es nie', () => {
  // Er stand in der Closure von wireWallTimer. Der Startknopf legt ihn an und
  // ruft sofort rerender(), das die Flaeche neu baut: der neue Aufruf besitzt
  // den Sekundentakt und beginnt mit null, der alte hatte den Knopf und nie
  // einen Takt. Der Wecker lief jedes Mal auf chime(null).
  //
  // Geprueft wird die Modulebene an der Einrueckung: eine Deklaration in einer
  // Funktion steht eingerueckt.
  assert.match(SOURCE, /^let audioCtx = null;$/m,
    'audioCtx wird auf Modulebene gehalten, nicht je Render');
  assert.ok(!/^\s+let audio(Ctx)? =/m.test(SOURCE),
    'keine zweite, render-lokale Fassung daneben');
  assert.match(SOURCE, /chime\(audioCtx\)/, 'und genau der wird beim Ablauf gelaeutet');
});

test('das Attribut wird auch beim Verlassen der Wand zurueckgenommen', () => {
  // Wer den Wandmodus mit laufendem Timer verlaesst, bricht das Verdrahten ab -
  // und ausserhalb der Wand verdrahtet niemand mehr, der das Attribut
  // zuruecknehmen koennte. Es waere fuer den Rest der Sitzung an <html>
  // haengengeblieben und haette den Screensaver auf JEDER Seite unterdrueckt.
  const at = SOURCE.indexOf("signal.addEventListener('abort'");
  assert.ok(at > 0, 'Reichweite: der Abbruch-Pfad wurde gefunden');
  const abort = SOURCE.slice(at, at + 260);
  assert.match(abort, /setRunningAttr\(false\)/,
    'der Abbruch raeumt das Attribut, nicht nur den Takt');
  // Wie das Beenden heisst, ist gleichgueltig - dass es passiert, nicht.
  assert.match(abort, /stopTick\(\)|clearInterval/, 'und den Takt weiterhin auch');
});

test('ein Aufruf raeumt den vorigen Takt ab - sonst laeuten zwei (Review zu #844)', () => {
  // wireWallTimer wird auf einer Seite MEHRFACH gerufen: einmal auf der
  // Ladeflaeche und noch einmal, wenn die Daten da sind. Ein Intervall in der
  // Aufruf-Closure ergaebe zwei Takte, die beim Ablauf beide laeuten und beide
  // neu zeichnen.
  assert.match(SOURCE, /^let tick = null;$/m, 'der Takt liegt auf Modulebene');
  const at = SOURCE.indexOf('export function wireWallTimer');
  const kopf = SOURCE.slice(at, at + 400);
  assert.match(kopf, /stopTick\(\)/, 'und wird zu Beginn jedes Aufrufs abgeraeumt');
  // Vor dem `if (!wall) return`: ein Takt aus einem frueheren Aufruf schriebe
  // sonst weiter in ein DOM, das es nicht mehr gibt.
  assert.ok(kopf.indexOf('stopTick()') < kopf.indexOf('if (!wall) return'),
    'auch dann, wenn diesmal gar keine Flaeche da ist');
});

test('der Timer wird verdrahtet, bevor auf die Dashboard-Daten gewartet wird', () => {
  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  // Der Timer haengt an nichts, was geladen werden koennte. Stuende seine
  // Verdrahtung nur hinter dem Laden, waeren Takt und Attribut weg, solange
  // eine haengende Anfrage laeuft - die Anzeige stuende still und der
  // Screensaver duerfte sich darueberlegen.
  // NUR IN render() SELBST, und dort vor dem ersten await. Ein blosses
  // indexOf ueber die ganze Datei fand den Aufruf in `wireWallSurface`, das
  // weiter oben im Text steht - und blieb gruen, als die fruehe Verdrahtung
  // wieder entfernt wurde. Textstelle ist nicht Ausfuehrungsreihenfolge.
  const renderAt = dash.indexOf('export async function render(');
  assert.ok(renderAt > 0, 'Reichweite: render() gefunden');
  const bisAwait = dash.slice(renderAt, dash.indexOf('await ', renderAt));
  assert.ok(bisAwait.length > 0 && bisAwait.length < dash.length, 'Reichweite: das erste await liegt in render()');
  assert.match(bisAwait, /wireWallTimer\(/,
    'die Wandflaeche bekommt ihren Takt, sobald sie im DOM steht - nicht erst, wenn die Daten da sind');
});

test('auch der Ausstieg wird verdrahtet, bevor auf die Daten gewartet wird', () => {
  const dash = readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8');
  // Auf der Ladeflaeche ist der Knopf sichtbar. War er dort nicht verdrahtet,
  // kam bei einer haengenden Anfrage niemand mehr aus dem Wandmodus heraus - in
  // der installierten PWA ohne Browserleiste heisst das: gar nicht mehr.
  const renderAt = dash.indexOf('export async function render(');
  const bisAwait = dash.slice(renderAt, dash.indexOf('await ', renderAt));
  assert.match(bisAwait, /wireWallExit\(/, 'der Ausstieg haengt nicht am Datenladen');

  // Und er haengt am Container, nicht am Knopf: `setHtml` tauscht dessen Inhalt
  // aus, der Container bleibt. Eine Verdrahtung am Knopf waere nach dem zweiten
  // Rendern wieder tot.
  const at = dash.indexOf('function wireWallExit');
  const fn = dash.slice(at, dash.indexOf('\n}', at));
  assert.match(fn, /container\.addEventListener\(\s*'click'/,
    'delegiert am Container, damit die eine Verdrahtung beide Renders ueberlebt');
  assert.ok(!/container\.querySelector\('#wall-exit'\)\?\.addEventListener/.test(fn),
    'nicht am Knopf selbst');
});
