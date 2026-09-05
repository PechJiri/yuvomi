/**
 * Test: Die geteilten Ordnerbaum-Regeln (#785)
 * Zweck: `public/utils/folder-tree.js` ist die EINE Formulierung dessen, was
 *        ein Ordnerbaum bedeutet - die Seitenleiste zaehlt damit, die Route
 *        filtert damit. Genau deshalb muss sie allein geprueft werden: ein
 *        Fehler hier ist in beiden Haelften derselbe und faellt in keiner auf.
 *
 *        Ohne DOM und ohne Datenbank, weil die Funktionen nichts davon
 *        brauchen - sie rechnen auf einer Liste.
 * Ausfuehren: npm run test:folder-tree
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  MAX_FOLDER_DEPTH, subtreeIds, folderPath, subtreeHeight,
  folderMoveIssue, buildFolderTree, flattenFolderTree,
} = await import('../public/utils/folder-tree.js');

/** Kurzschreibweise: `f(1, 'Wohnung')`, `f(2, 'Miete', 1)`. */
const f = (id, name, parent_id = null) => ({ id, name, parent_id });

/**
 * Wohnung
 *   Miete
 *     2025
 *   Versicherung
 * Auto
 */
const BAUM = [
  f(1, 'Wohnung'),
  f(2, 'Miete', 1),
  f(3, '2025', 2),
  f(4, 'Versicherung', 1),
  f(5, 'Auto'),
];

// --------------------------------------------------------
// Was liegt darunter
// --------------------------------------------------------

test('subtreeIds nimmt den ganzen Zweig, nicht nur die direkten Kinder', () => {
  // Das Enkelkind ist der Punkt: eine Fassung, die nur eine Ebene tief geht,
  // waere bei diesem Baum in drei von vier Faellen richtig.
  assert.deepEqual([...subtreeIds(BAUM, 1)].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...subtreeIds(BAUM, 2)].sort(), [2, 3]);
  assert.deepEqual([...subtreeIds(BAUM, 5)], [5]);
});

test('subtreeIds gibt auch fuer einen unbekannten Ordner eine Menge zurueck', () => {
  // Sie darf nur nicht LEER sein: eine leere Menge wuerde beim Aufrufer zu
  // "kein Filter" und zeigte dann ALLE Dokumente statt keiner.
  assert.deepEqual([...subtreeIds(BAUM, 999)], [999]);
});

test('subtreeIds haelt an, wenn die Daten einen Ring enthalten', () => {
  // Der Server schliesst Zyklen aus. Diese Funktion laeuft trotzdem ueber
  // Daten, die sie nicht selbst geschrieben hat - ein Fehler in den Daten darf
  // kein stehender Server werden.
  const ring = [f(1, 'A', 2), f(2, 'B', 1)];
  const ids = subtreeIds(ring, 1);
  assert.deepEqual([...ids].sort(), [1, 2]);
});

// --------------------------------------------------------
// Wo liegt er
// --------------------------------------------------------

test('folderPath liest die Kette von der Wurzel her', () => {
  assert.deepEqual(folderPath(BAUM, 3).map((x) => x.name), ['Wohnung', 'Miete', '2025']);
  assert.deepEqual(folderPath(BAUM, 5).map((x) => x.name), ['Auto']);
});

test('folderPath gibt fuer einen unbekannten Ordner nichts zurueck', () => {
  assert.deepEqual(folderPath(BAUM, 999), []);
});

test('folderPath haelt an, wenn die Daten einen Ring enthalten', () => {
  const ring = [f(1, 'A', 2), f(2, 'B', 1)];
  const chain = folderPath(ring, 1);
  assert.ok(chain.length > 0 && chain.length < 100, `Kette lief auf ${chain.length} Glieder`);
});

test('subtreeHeight zaehlt Ebenen, nicht Ordner', () => {
  assert.equal(subtreeHeight(BAUM, 1), 3, 'Wohnung > Miete > 2025');
  assert.equal(subtreeHeight(BAUM, 2), 2);
  assert.equal(subtreeHeight(BAUM, 5), 1, 'ein Ordner ohne Kinder ist eine Ebene, nicht null');
  assert.equal(subtreeHeight(BAUM, 999), 1);
});

// --------------------------------------------------------
// Darf er dorthin
// --------------------------------------------------------

test('an die Wurzel darf immer', () => {
  assert.equal(folderMoveIssue(BAUM, 3, null), null);
  assert.equal(folderMoveIssue(BAUM, null, null), null);
});

test('ein Ordner kann nicht in sich selbst', () => {
  assert.equal(folderMoveIssue(BAUM, 1, 1), 'self');
});

test('ein Ordner kann nicht in seinen eigenen Nachfahren - auch nicht in den Enkel', () => {
  assert.equal(folderMoveIssue(BAUM, 1, 2), 'descendant');
  assert.equal(folderMoveIssue(BAUM, 1, 3), 'descendant',
    'der Enkel ist ein eigener Nachfahre - eine Pruefung nur auf das direkte Kind reicht nicht');
});

test('nach oben und zur Seite bleibt erlaubt', () => {
  assert.equal(folderMoveIssue(BAUM, 3, 1), null, 'Enkel unter den Grossvater');
  assert.equal(folderMoveIssue(BAUM, 2, 5), null, 'in einen anderen Zweig');
});

test('ein Elternteil, den es nicht gibt, ist eine eigene Absage', () => {
  assert.equal(folderMoveIssue(BAUM, 1, 999), 'missing-parent');
});

test('die Tiefe zaehlt die HOEHE des verschobenen Zweigs mit', () => {
  // Eine Kette bis genau an die Grenze ...
  const kette = Array.from({ length: MAX_FOLDER_DEPTH }, (_v, i) => f(i + 1, `E${i}`, i === 0 ? null : i));
  assert.equal(folderMoveIssue(kette, null, MAX_FOLDER_DEPTH), 'too-deep',
    'ein neuer Ordner unter der letzten erlaubten Ebene waere einer zu viel');
  assert.equal(folderMoveIssue(kette, null, MAX_FOLDER_DEPTH - 1), null);

  // ... und ein dreistufiger Zweig, der nicht mehr unter Ebene 3 passt.
  const mitZweig = [
    ...kette,
    f(100, 'Zweig'), f(101, 'ZweigMitte', 100), f(102, 'ZweigBlatt', 101),
  ];
  assert.equal(folderMoveIssue(mitZweig, 100, 3), 'too-deep',
    'drei Ebenen unter Ebene 3 waeren sechs');
  assert.equal(folderMoveIssue(mitZweig, 102, 3), null,
    'das Blatt allein passt dorthin - gezaehlt wird der Zweig, nicht die id');
});

// --------------------------------------------------------
// Aufbau und Anzeigereihenfolge
// --------------------------------------------------------

test('buildFolderTree haengt jeden Ordner unter seinen Elternteil', () => {
  const roots = buildFolderTree(BAUM);
  assert.deepEqual(roots.map((r) => r.folder.name), ['Wohnung', 'Auto']);
  assert.deepEqual(roots[0].children.map((c) => c.folder.name), ['Miete', 'Versicherung']);
  assert.deepEqual(roots[0].children[0].children.map((c) => c.folder.name), ['2025']);
});

test('ein Ordner, dessen Elternteil fehlt, wird zur Wurzel statt zu verschwinden', () => {
  // Eine Antwort zwischen zwei Ladevorgaengen, eine Zeile an der API vorbei:
  // ein sichtbarer Ordner an der falschen Stelle ist besser als ein
  // unsichtbarer an der richtigen.
  const verwaist = [f(1, 'Wohnung'), f(7, 'Waise', 42)];
  const roots = buildFolderTree(verwaist);
  assert.deepEqual(roots.map((r) => r.folder.name).sort(), ['Waise', 'Wohnung']);
});

test('flattenFolderTree gibt die Anzeigereihenfolge samt Tiefe', () => {
  const rows = flattenFolderTree(BAUM);
  assert.deepEqual(rows.map((r) => `${r.depth}:${r.folder.name}`),
    ['0:Wohnung', '1:Miete', '2:2025', '1:Versicherung', '0:Auto']);
});

test('zugeklappte Zweige fallen aus der Liste, ihre Wurzel bleibt', () => {
  const nurWohnungOffen = flattenFolderTree(BAUM, { expanded: new Set([1]) });
  assert.deepEqual(nurWohnungOffen.map((r) => r.folder.name),
    ['Wohnung', 'Miete', 'Versicherung', 'Auto'],
    '2025 haengt unter dem zugeklappten Miete - Auto ist Wurzel und bleibt');

  const allesZu = flattenFolderTree(BAUM, { expanded: new Set() });
  assert.deepEqual(allesZu.map((r) => r.folder.name), ['Wohnung', 'Auto']);
});

test('ein Ring bringt die Anzeigereihenfolge nicht zum Stehen', () => {
  // buildFolderTree haengt bei einem Ring keinen der beiden unter den anderen
  // (beide finden ihren Elternteil), sie landen also als Wurzeln - Hauptsache,
  // das Abflachen kehrt zurueck.
  const ring = [f(1, 'A', 2), f(2, 'B', 1)];
  const rows = flattenFolderTree(ring);
  assert.ok(rows.length < 100, `Abflachen lief auf ${rows.length} Zeilen`);
});
