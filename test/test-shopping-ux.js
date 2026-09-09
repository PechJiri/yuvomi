/**
 * Tests: Kategorie-Einklappen und Sammelaktions-Automat des Einkaufs (#1039)
 * Modul: /public/pages/shopping.js
 *
 * WARUM ALS VERHALTENSTEST: eine Textprobe auf `localStorage.setItem` oder
 * `setTimeout` bliebe gruen, auch wenn die Speicherung falsch scopt oder die
 * Frist bei jedem weiteren Treffer neu startet - genau die Fehlerklasse, die
 * dieses Ticket beheben soll. Getrieben werden deshalb die echten exportierten
 * Funktionen (`__test`), mit dem kleinstmoeglichen DOM-Stub: shopping.js
 * importiert am Modulkopf mehrere echte Browser-Module (u.a.
 * category-manager.js, ein Custom Element), die ohne `customElements`/
 * `HTMLElement`/`document` beim Laden selbst schon werfen - der Stub unten
 * deckt genau das ab, nichts, was das Modul beim Rendern einer Seite bräuchte.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-shopping-ux.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };

/** Sammelaktions-Schicht: zeichnet nichts, merkt aber ihre Listener - genug,
 *  um Hover/Fokus-Ende so auszuloesen, wie es der echte Browser täte.
 *  `replaceChildren` zaehlt ihre Aufrufe: Pantry und Kontakte teilen sich
 *  dieselbe Schicht, und ein Test unten prueft, dass eine fremde (oder
 *  laengst verlassene) Sammelaktion sie nicht versehentlich leert. */
function makeBulkPillLayer() {
  const handlers = {};
  return {
    dataset: {},
    contains: () => false,
    addEventListener(type, handler) { handlers[type] = handler; },
    replaceChildren() { this.replaceChildrenCalls = (this.replaceChildrenCalls ?? 0) + 1; },
    replaceChildrenCalls: 0,
    querySelector: () => null,
    fire(type, evt = {}) { handlers[type]?.(evt); },
  };
}
const bulkPillLayer = makeBulkPillLayer();

global.window = {
  matchMedia: () => ({ matches: false }),
  addEventListener() {},
  yuvomi: {},
};
global.document = {
  getElementById: (id) => (id === 'bulk-pill-layer' ? bulkPillLayer : null),
  createElement: () => Object.assign(new global.HTMLElement(), {
    style: {}, setAttribute() {}, appendChild() {}, addEventListener() {},
    classList: { add() {}, remove() {}, toggle() {} },
  }),
  addEventListener() {},
  documentElement: { lang: 'de' },
};

// In-Memory-`localStorage`, wie es der Browser-Loader fuer keine der beiden
// Funktionen mitbringt - shopping.js ruft sie direkt aus dem globalen Scope.
function makeMemoryStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    clear: () => data.clear(),
  };
}
global.localStorage = makeMemoryStorage();

const { __test } = await import('../public/pages/shopping.js');

function resetShoppingState() {
  __test.state.items = [];
  __test.state.categories = [];
  __test.state.activeListId = 1;
  __test.state.currentUserId = 7;
  __test.state.collapsedCategories = new Set();
  __test.resetPillMachine();
  __test.setPillInteractingForTest(false);
  __test.setBulkPillHoldMsForTest(null);
  bulkPillLayer.replaceChildrenCalls = 0;
  global.localStorage.clear();
}

/** Kleinstes DOM, das toggleCategoryCollapse bedient: closest + ein Kind je Selektor. */
function makeCategoryGroup(key, { collapsed = false } = {}) {
  const rowsEl = { hidden: collapsed };
  const chevron = {
    _collapsed: collapsed,
    classList: {
      toggle(cls, on) { if (cls === 'list-group__chevron--collapsed') chevron._collapsed = on; },
    },
  };
  const groupEl = {
    _sel: '.list-group',
    querySelector(sel) {
      if (sel === '.list-rows') return rowsEl;
      return null;
    },
  };
  const button = {
    dataset: { categoryToggle: key },
    _attrs: { 'aria-expanded': String(!collapsed) },
    setAttribute(k, v) { button._attrs[k] = v; },
    getAttribute(k) { return button._attrs[k] ?? null; },
    closest(sel) { return sel === '.list-group' ? groupEl : null; },
    querySelector(sel) { return sel === '.list-group__chevron' ? chevron : null; },
  };
  return { button, rowsEl, chevron };
}

// --------------------------------------------------------
// Kategorie-Einklappen: stabiler Schluessel
// --------------------------------------------------------

test('categoryStorageKey: bekannte Kategorie traegt ihre ID, nicht ihren Namen', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 42, name: 'Obst & Gemüse', icon: 'apple' }];
  assert.equal(__test.categoryStorageKey('Obst & Gemüse'), 'id:42');

  // Rename-sicher: der Name aendert sich, die ID nicht - derselbe Schluessel.
  __test.state.categories[0].name = 'Frisches Obst & Gemüse';
  assert.equal(__test.categoryStorageKey('Frisches Obst & Gemüse'), 'id:42');
});

test('categoryStorageKey: unbekannte/geloeschte Kategorie faellt auf den normalisierten Namen zurueck', () => {
  resetShoppingState();
  __test.state.categories = [];
  assert.equal(__test.categoryStorageKey('Sonstiges'), 'name:sonstiges');
  assert.equal(__test.categoryStorageKey('  SONSTIGES  '), 'name:sonstiges');
});

// --------------------------------------------------------
// Kategorie-Einklappen: Speicherung, Scoping, Validierung
// --------------------------------------------------------

test('loadCollapsedCategories/saveCollapsedCategories: Rundreise ueber localStorage', () => {
  resetShoppingState();
  __test.saveCollapsedCategories(7, 1, new Set(['id:1', 'id:2']));
  const loaded = __test.loadCollapsedCategories(7, 1);
  assert.deepEqual([...loaded].sort(), ['id:1', 'id:2']);
});

test('loadCollapsedCategories: scoped je Nutzer UND je Liste - keine Ueberdeckung', () => {
  resetShoppingState();
  __test.saveCollapsedCategories(7, 1, new Set(['id:1']));

  // Anderer Nutzer, gleiche Liste: sieht nichts vom ersten.
  assert.deepEqual([...__test.loadCollapsedCategories(9, 1)], []);
  // Gleicher Nutzer, andere Liste: sieht ebenfalls nichts.
  assert.deepEqual([...__test.loadCollapsedCategories(7, 2)], []);
  // Genau dieselbe Kombination: sieht den gespeicherten Zustand.
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1']);
});

test('loadCollapsedCategories: kaputte/fremde Werte fallen sicher auf eine leere Menge zurueck', () => {
  resetShoppingState();
  const key = __test.collapsedCategoriesStorageKey(7, 1);

  global.localStorage.setItem(key, 'kein-json{{{');
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'kaputtes JSON darf nicht werfen');

  global.localStorage.setItem(key, JSON.stringify({ version: 999, collapsed: ['id:1'] }));
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'eine fremde Version darf nicht blind uebernommen werden');

  global.localStorage.setItem(key, JSON.stringify({ version: 1, collapsed: 'id:1' }));
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], [], 'collapsed muss ein Array sein');
});

test('pruneCollapsedCategories: entfernt Schluessel geloeschter Kategorien, behaelt gueltige', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 1, name: 'Obst', icon: 'apple' }];
  __test.state.collapsedCategories = new Set(['id:1', 'id:99', 'name:veraltet']);

  // Nur "Obst" (id:1) ist in der aktuell gerenderten Gruppierung noch da.
  __test.pruneCollapsedCategories([['Obst', [{ id: 100 }]]]);

  assert.deepEqual([...__test.state.collapsedCategories], ['id:1'],
    'id:99 (geloeschte Kategorie) und name:veraltet (verschwundene Unbekannt-Gruppe) muessen weg sein');
  // Und persistiert, nicht nur im Speicher veraendert:
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1']);
});

test('pruneCollapsedCategories: ruehrt nichts an, wenn alles noch gueltig ist (kein unnoetiger Schreibzugriff)', () => {
  resetShoppingState();
  __test.state.categories = [{ id: 1, name: 'Obst', icon: 'apple' }];
  __test.state.collapsedCategories = new Set(['id:1']);
  __test.saveCollapsedCategories(7, 1, new Set(['id:1']));

  __test.pruneCollapsedCategories([['Obst', [{ id: 100 }]]]);
  assert.deepEqual([...__test.state.collapsedCategories], ['id:1']);
});

// --------------------------------------------------------
// Kategorie-Einklappen: der Umschalter selbst
// --------------------------------------------------------

test('toggleCategoryCollapse: klappt zu, meldet aria-expanded/hidden/Chevron und speichert', () => {
  resetShoppingState();
  const { button, rowsEl, chevron } = makeCategoryGroup('id:1', { collapsed: false });

  __test.toggleCategoryCollapse(button);

  assert.equal(rowsEl.hidden, true, 'die Zeilen bleiben im DOM, werden aber ausgeblendet');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(chevron._collapsed, true);
  assert.deepEqual([...__test.state.collapsedCategories], ['id:1']);
  assert.deepEqual([...__test.loadCollapsedCategories(7, 1)], ['id:1'], 'persistiert sofort');
});

test('toggleCategoryCollapse: klappt wieder auf (Gegenprobe der Umkehrung)', () => {
  resetShoppingState();
  __test.state.collapsedCategories = new Set(['id:1']);
  const { button, rowsEl, chevron } = makeCategoryGroup('id:1', { collapsed: true });

  __test.toggleCategoryCollapse(button);

  assert.equal(rowsEl.hidden, false);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  assert.equal(chevron._collapsed, false);
  assert.deepEqual([...__test.state.collapsedCategories], []);
});

test('toggleCategoryCollapse: eine neue Kategorie ist ohne Zutun aufgeklappt', () => {
  // Gespeichert wird nur, was EINGEKLAPPT ist (dieselbe Regel wie bei den
  // Aufgaben-Gruppen, #812) - eine frisch angelegte Kategorie taucht in keiner
  // gespeicherten Menge auf und ist damit automatisch offen.
  resetShoppingState();
  assert.equal(__test.state.collapsedCategories.has('id:123'), false);
});

// --------------------------------------------------------
// Sammelaktions-Pille: Zustandsautomat
// --------------------------------------------------------

const fakeContainer = () => ({ isConnected: true });

test('updateCheckedActions: vorbelegte (geladene) Artikel zeigen KEINE Pille', () => {
  // Das Kernversprechen von #1039: "pre-checked data does not create a
  // permanent pill" gilt nicht nur beim allerersten Seitenaufruf, sondern bei
  // jedem Nachladen (Listenwechsel) - deshalb hier ohne userChecked.
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');
});

test('updateCheckedActions: ein echter Abhak-Treffer aus dem Ruhezustand oeffnet die Pille', () => {
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');
});

test('updateCheckedActions: zurueck auf 0 setzt den Automaten in den Ruhezustand', () => {
  resetShoppingState();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  __test.state.items = [{ id: 1, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');
});

test('updateCheckedActions: die Frist startet NICHT bei jedem weiteren Treffer neu', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(50);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true }); // t=0, Frist bis ~50ms

  await new Promise((r) => setTimeout(r, 30));
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 1 }];
  // Ein zweiter Treffer bei bereits sichtbarer Pille - userChecked waere hier
  // ohnehin wirkungslos, weil die Pille nicht mehr im Ruhezustand ist.
  __test.updateCheckedActions(fakeContainer(), { userChecked: true }); // t=30ms
  assert.equal(__test.getPillPhaseForTest(), 'visible', 'Zahl/Aktionen aktualisiert, Frist unangetastet');

  // Haette der zweite Treffer die Frist verlaengert, stuende die Pille bei
  // t=60ms noch (30ms nach dem zweiten Treffer waeren erst 30/50 verstrichen).
  // Ohne Verlaengerung ist die ORIGINALE Frist (t=50ms ab dem ERSTEN Treffer)
  // laengst abgelaufen.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(__test.getPillPhaseForTest(), 'suppressed',
    'die Frist muss ab dem ERSTEN Treffer laufen, nicht ab dem letzten');
});

test('updateCheckedActions: derselbe Batch zeigt sich nach dem Ausblenden nicht erneut', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');

  // Ein weiterer Artikel desselben (noch nicht auf 0 gefallenen) Batches darf
  // die Pille nicht zurueckholen.
  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');

  // Erst der Fall auf 0 und ein NEUER Treffer eroeffnen einen neuen Batch.
  __test.state.items = [{ id: 1, is_checked: 0 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer());
  assert.equal(__test.getPillPhaseForTest(), 'idle');

  __test.state.items = [{ id: 1, is_checked: 1 }, { id: 2, is_checked: 0 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');
});

test('updateCheckedActions: Hover/Fokus auf der Pille schiebt das Ausblenden auf, bis die Interaktion endet', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  __test.setPillInteractingForTest(true);

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'deferred',
    'die Frist ist um, aber die Interaktion haelt die Pille noch offen');

  // Interaktion endet (mouseleave/focusout auf der geteilten Schicht):
  bulkPillLayer.fire('mouseleave');
  assert.equal(__test.getPillPhaseForTest(), 'suppressed');
});

test('das Ende einer Interaktion loescht die geteilte Schicht nicht mehr, wenn die Seite laengst verlassen ist', async () => {
  // Die Hover/Fokus-Listener haengen EINMALIG, app-weit an der Schicht (Pantry
  // und Kontakte zeigen dort ihre eigene Pille). Ohne Eigentums-Pruefung
  // wuerde ein Maus-Verlassen auf einer FREMDEN, gerade sichtbaren Pille sie
  // loeschen, nur weil `pillPhase` hier zufaellig noch 'deferred' vom letzten
  // Einkaufsbesuch war.
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  const container = fakeContainer();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(container, { userChecked: true });
  __test.setPillInteractingForTest(true);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'deferred');

  // Seite verlassen, BEVOR die Interaktion endet.
  container.isConnected = false;
  const callsBefore = bulkPillLayer.replaceChildrenCalls;

  bulkPillLayer.fire('mouseleave');
  assert.equal(__test.getPillPhaseForTest(), 'suppressed', 'der interne Zustand darf trotzdem aufraeumen');
  assert.equal(bulkPillLayer.replaceChildrenCalls, callsBefore,
    'eine verlassene Seite darf die geteilte Schicht (moeglicherweise mit einer fremden Pille) nicht anfassen');
});

test('updateCheckedActions: eine veraltete Frist nach einem Listenwechsel bleibt folgenlos', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(fakeContainer(), { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  // Ein Listenwechsel (resetPillMachine) waehrend die Frist noch laeuft.
  __test.resetPillMachine();
  assert.equal(__test.getPillPhaseForTest(), 'idle');

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'idle',
    'die alte Frist darf den frischen Ruhezustand der neuen Liste nicht ueberschreiben');
});

test('updateCheckedActions: eine veraltete Frist nach dem Verlassen der Seite bleibt folgenlos (isConnected)', async () => {
  resetShoppingState();
  __test.setBulkPillHoldMsForTest(20);

  const container = fakeContainer();
  __test.state.items = [{ id: 1, is_checked: 1 }];
  __test.updateCheckedActions(container, { userChecked: true });
  assert.equal(__test.getPillPhaseForTest(), 'visible');

  // Die Seite wurde verlassen: der Router ersetzt den Inhalt, diese Wurzel
  // haengt nicht mehr im Dokument.
  container.isConnected = false;

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(__test.getPillPhaseForTest(), 'visible',
    'eine Frist ohne lebende Wurzel darf weder den Zustand noch die geteilte Schicht anfassen');
});

// --------------------------------------------------------
// Laden-Verwaltung (#1003)
// --------------------------------------------------------

test('der Laden-Manager meldet sich beim Schliessen NICHT vom Aenderungs-Ereignis ab', () => {
  // Gemessen am 08.09.2026 im laufenden Browser: beim Loeschen raeumt
  // `confirmOverModal` das Modal darunter mit ab, und `api.delete` laeuft
  // danach weiter - `category-manager-changed` kommt also erst, wenn das
  // Element schon aus dem Dokument ist (imDom: false in der Sonde). Wer beim
  // Schliessen abmeldet, verpasst genau diese Aenderung: `state.stores` boete
  // danach einen Laden an, den der Server nicht mehr kennt, und das naechste
  // Speichern liefe in dessen 400-Antwort.
  //
  // Als Textprobe und nicht als Verhaltenstest, weil der Ablauf am echten
  // Modal-Stack haengt (Suspend/Resume ueber zwei Overlays) - der Stub dieser
  // Suite bildet ihn nicht ab. Der Nachweis liegt in der Messung, hier steht
  // nur die Sperre gegen den Rueckfall.
  const src = readFileSync(new URL('../public/pages/shopping.js', import.meta.url), 'utf8');
  const fn = src.match(/function openStoreManager\(container\)[\s\S]*?\n\}/);
  assert.ok(fn, 'openStoreManager nicht gefunden');
  assert.doesNotMatch(fn[0], /removeEventListener\(\s*'category-manager-changed'/,
    'openStoreManager meldet sich wieder ab und verpasst damit das Loeschen');
  // Die Auffrischung muss im Ereignis stehen, nicht in onClose: onClose laeuft,
  // bevor der Server ueberhaupt geantwortet hat.
  assert.match(fn[0], /const onChanged = async \(\) => \{[\s\S]*?loadStores\(\)/,
    'die Auffrischung gehoert in den Ereignis-Handler');
});

// --------------------------------------------------------
// Mengenangabe -> Vorrats-Uebertrag (#1003, Nachzug zur Preis-Umschrift)
// --------------------------------------------------------

/**
 * Fuehrt `fn` unter einer anderen Format-Locale aus. Die Locale ist im Browser
 * eine Haushalts-Einstellung; der Loader dieser Suite liest sie aus
 * `globalThis.__formatLocale` (Standard 'de'), damit hier genau die Faelle
 * messbar sind, an denen die alte Umschrift still falsch lag.
 */
function withFormatLocale(locale, fn) {
  const vorher = globalThis.__formatLocale;
  globalThis.__formatLocale = locale;
  try { fn(); } finally { globalThis.__formatLocale = vorher; }
}

test('parseShoppingQuantity: die Schreibweisen aus dem Seed bleiben, wie sie waren', () => {
  // Gegen echte Werte aus scripts/seed-demo.js gemessen, nicht gegen erfundene:
  // die Freitext-Menge ist meistens gar keine reine Zahl, und ein Test nur auf
  // "250 g" haette die Rueckfaelle darunter nicht bemerkt.
  const p = __test.parseShoppingQuantity;
  assert.deepEqual(p('250 g'), { quantity: 250, unit: 'g' });
  assert.deepEqual(p('1 kg'), { quantity: 1, unit: 'kg' });
  assert.deepEqual(p('2 l'), { quantity: 2, unit: 'l' });
  assert.deepEqual(p('12'), { quantity: 12, unit: 'pcs' });
  // '1 Laib' faengt mit 'l' an: die Einheit braucht die Wortgrenze, sonst waere
  // ein Laib Brot ein Liter.
  assert.deepEqual(p('1 Laib'), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p('1 Kopf'), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p('6 × 1 l'), { quantity: 6, unit: 'pcs' });
  assert.deepEqual(p('4er-Pack'), { quantity: 4, unit: 'pcs' });
  assert.deepEqual(p(''), { quantity: 1, unit: 'pcs' });
  assert.deepEqual(p(null), { quantity: 1, unit: 'pcs' });
});

test('parseShoppingQuantity: der Dezimaltrenner kommt aus der Region, nicht aus dem Quelltext', () => {
  // In de trennt das Komma. Das konnte die alte Fassung auch - sie hatte den
  // Trenner nur fest verdrahtet und lag damit ueberall sonst falsch.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,5 kg'), { quantity: 1.5, unit: 'kg' });
  });
  // In en-US und de-CH trennt der Punkt.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.5 kg'), { quantity: 1.5, unit: 'kg' });
  });
  withFormatLocale('de-CH', () => {
    assert.deepEqual(__test.parseShoppingQuantity('0.5 l'), { quantity: 0.5, unit: 'l' });
  });
});

test('parseShoppingQuantity: eine gruppierte Menge wird abgewiesen, nicht geraten', () => {
  // Der Kern des Fehlers: das Gruppierungszeichen ist regionsabhaengig, und
  // beide Deutungen sind vertretbar. "1,000 g" heisst in en-US tausend Gramm,
  // als Dezimalzahl aber ein Gramm - die falsche liegt um den Faktor 1000
  // daneben, und die alte Fassung nahm sie stillschweigend (Menge 1, Einheit g).
  //
  // Abgewiesen wird auf den Standard, nicht auf "1 g": ein Wert mit Einheit
  // sieht nach einer verstandenen Angabe aus. "1 Stueck" sagt sichtbar, dass
  // nichts erkannt wurde, und der Uebernahme-Dialog zeigt beides in einem Feld,
  // das sich korrigieren laesst.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,000 g'), { quantity: 1, unit: 'pcs' });
  });
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'pcs' });
  });
  // Zwei Stellen hinter dem Trenner sind nicht mehrdeutig und bleiben Dezimalangabe.
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.25 kg'), { quantity: 1.25, unit: 'kg' });
  });
});

test('parseShoppingQuantity: oestliche Ziffern kommen ueberhaupt an', () => {
  // `\d` ist in JavaScript ASCII. Unter fa oder ar-EG zeigt die Oberflaeche
  // ihre eigenen Ziffern, und wer sie eintippt, traf die alte Regex nicht -
  // die Menge fiel wortlos auf 1 Stueck zurueck, egal was dastand.
  withFormatLocale('fa', () => {
    assert.deepEqual(__test.parseShoppingQuantity('۲۵۰ g'), { quantity: 250, unit: 'g' });
    assert.deepEqual(__test.parseShoppingQuantity('۱٫۵ kg'), { quantity: 1.5, unit: 'kg' });
    // Das Einheitenwort bleibt bewusst unuebersetzt (siehe Kopf der Funktion):
    // erkannt wird die ZAHL, das Wort landet bei 'Stueck'.
    assert.deepEqual(__test.parseShoppingQuantity('۲۵۰ گرم'), { quantity: 250, unit: 'pcs' });
  });
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٢٥٠ g'), { quantity: 250, unit: 'g' });
    // Auch hier gilt die Gruppierung der Region (٬), nicht die von en-US. Die
    // fuehrende Ziffer ist bewusst NICHT die 1: mit „١٬٠٠٠ g" war dieser Test
    // gruen, obwohl die Umschrift die Gruppierung gar nicht erkannte - der
    // abgeschnittene Anfang „1" traf zufaellig denselben Wert wie der Standard.
    // Ein Guard, dessen Erwartung auf zwei Wegen erreichbar ist, misst nichts.
    assert.deepEqual(__test.parseShoppingQuantity('٢٬٠٠٠ g'), { quantity: 1, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: eine mitten im Trenner abgeschnittene Menge wird abgewiesen', () => {
  // Die Gruppierungspruefung greift am MUSTER: drei Ziffern hinter dem Trenner.
  // „٢٬٥٠" hat zwei, ist also keine erkannte Gruppierung - und ein Zeichen, das
  // die Region ueberhaupt nicht als Trenner kennt, steht sowieso einfach da.
  // Diese Regex liest nur den ANFANG und naehme daraus wortlos die 2.
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٢٬٥٠ g'), { quantity: 1, unit: 'pcs' });
  });
  // Unter fa trennt das ASCII-Komma nichts.
  withFormatLocale('fa', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,5 kg'), { quantity: 1, unit: 'pcs' });
  });
  // Der Schweizer Gruppierungsapostroph, den weder de noch en-US kennt.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity("1'000 g"), { quantity: 1, unit: 'pcs' });
  });
  // Ein Leerzeichen trennt dagegen zwei Angaben und schneidet nichts ab.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1 l'), { quantity: 6, unit: 'pcs' });
  });
  // Und ein `x` ist kein Trenner: nach ihm ist die Zahl vollstaendig gelesen. Die
  // Pruefung war erst „irgendein Zeichen zwischen zwei Ziffern" und traf damit
  // die Multiplikator-Schreibweise mit, die der Kommentar an der Regex
  // ausdruecklich lesbar halten will.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('2x500 g'), { quantity: 2, unit: 'pcs' });
    assert.deepEqual(__test.parseShoppingQuantity('3x'), { quantity: 3, unit: 'pcs' });
    assert.deepEqual(__test.parseShoppingQuantity('4er-Pack'), { quantity: 4, unit: 'pcs' });
    // Die kompakte Form auch mit dem typografischen Kreuz.
    assert.deepEqual(__test.parseShoppingQuantity('2×500 ml'), { quantity: 2, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: eine Gruppierung im REST laesst die fuehrende Menge stehen', () => {
  // „6 × 1.000 ml" ist eine ganz gewoehnliche Einkaufszeile: sechs Flaschen zu
  // je einem Liter. Gelesen wird nur die 6, die 1.000 wird gar nicht angefasst -
  // sie darf die Zeile deshalb auch nicht abweisen. Vorher fiel sie auf 1 Stueck.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1.000 ml'), { quantity: 6, unit: 'pcs' });
  });
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('6 × 1,000 ml'), { quantity: 6, unit: 'pcs' });
  });
  withFormatLocale('ar-EG', () => {
    assert.deepEqual(__test.parseShoppingQuantity('٦ × ١٬٠٠٠ ml'), { quantity: 6, unit: 'pcs' });
  });
  // Im fuehrenden Token wird weiter abgewiesen - die Eingrenzung ist kein Freibrief.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'pcs' });
  });
});

test('parseShoppingQuantity: der Trenner der Region bleibt der Trenner, auch nach der Gruppierungspruefung', () => {
  // Gegenprobe zur REIHENFOLGE in toDecimalString. Wuerde die Gruppierung erst
  // nach dem Ersetzen des Dezimaltrenners geprueft, waere „1,000" in de schon ein
  // „1.000" - und der Punkt IST dort das Gruppierungszeichen. Eine gueltige
  // Menge von einem Gramm floege dann als vermeintlich gruppiert raus.
  withFormatLocale('de', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1,000 g'), { quantity: 1, unit: 'g' });
  });
  withFormatLocale('en-US', () => {
    assert.deepEqual(__test.parseShoppingQuantity('1.000 g'), { quantity: 1, unit: 'g' });
  });
});

// --------------------------------------------------------
// Abhaken gegen eine ueberholende Auffrischung
//
// WARUM ALS REIHENFOLGE-TEST: der Fehler ist nicht „es fehlt eine Wache",
// sondern „die Antwort trifft NACH der Bearbeitung ein". Eine Textprobe auf das
// Vorhandensein von `pendingChecks` bliebe gruen, auch wenn der Merker zum
// falschen Zeitpunkt geraeumt wird - und genau daran ist die erste Fassung
// dieses Fixes gescheitert (Loeschen beim PATCH-Erfolg kam zu frueh). Die Tests
// unten stellen die Reihenfolge deshalb wirklich: der GET wird von Hand
// aufgeloest, nachdem der PATCH durch ist.
// --------------------------------------------------------

/** Container ohne DOM: alle Render-Helfer steigen an ihrem Null-Guard aus. */
function makeNullContainer() {
  return { querySelector: () => null, querySelectorAll: () => [] };
}

/** Ein von Hand aufloesbares Versprechen - damit steht die Reihenfolge fest. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function milk(isChecked) {
  return { id: 10, name: 'Milch', is_checked: isChecked, category: 'Sonstiges', sort_order: 0 };
}

test('Abhaken ueberlebt eine Auffrischung, deren GET aelter ist als der PATCH', async () => {
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const gate = deferred();
  globalThis.__apiStub = {
    // Der Schnappschuss dieser Auffrischung ist VOR dem Abhaken entstanden.
    get: () => gate.promise,
    patch: async () => ({ data: null }),
  };

  // 1. Eine Auffrischung geht los (Kategorie-Manager, Ladenverwaltung, Import).
  const loading = __test.loadItems(1);
  // 2. Die Liste ist bedienbar: der Nutzer hakt ab, der PATCH ist durch.
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.items[0].is_checked, 1, 'optimistisch abgehakt');
  // 3. ERST JETZT trifft die alte Antwort ein.
  gate.resolve({ data: [milk(0)] });
  await loading;

  assert.equal(__test.state.items[0].is_checked, 1,
    'die alte Antwort darf die Bearbeitung nicht zurueckdrehen');
  delete globalThis.__apiStub;
});

test('ein spaeter begonnenes Laden raeumt den Merker - fremde Aenderungen kommen durch', async () => {
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  globalThis.__apiStub = { get: async () => ({ data: [milk(0)] }), patch: async () => ({ data: null }) };
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.items[0].is_checked, 1);

  // Dieses Laden beginnt NACH der Bestaetigung: sein Schnappschuss kennt den
  // Wert, seine Antwort ist die frischere Wahrheit. Haelt der Merker hier noch,
  // koennte niemand im Haushalt den Artikel je wieder zurueckholen.
  await __test.loadItems(1);
  assert.equal(__test.state.items[0].is_checked, 0,
    'ein Merker, der nie geraeumt wird, macht den Server unwirksam');
  assert.equal(__test.pendingChecks.size, 0, 'kein Rest im Merker');
  delete globalThis.__apiStub;
});

test('scheitert der PATCH, bleibt kein Merker stehen', async () => {
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const toasts = [];
  global.window.yuvomi.showToast = (msg, tone) => toasts.push([msg, tone]);
  globalThis.__apiStub = {
    get: async () => ({ data: [milk(0)] }),
    patch: async () => { throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } }); },
  };

  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.items[0].is_checked, 0, 'zurueckgedreht');
  assert.equal(__test.pendingChecks.size, 0, 'ein gescheiterter Wunsch darf nichts auftragen');
  assert.equal(toasts.length, 1);

  // Und die naechste Auffrischung traegt nichts nach.
  await __test.loadItems(1);
  assert.equal(__test.state.items[0].is_checked, 0);
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('eine aeltere Antwort, die NACH einer juengeren landet, fasst den Stand nicht mehr an', async () => {
  // Der Fall, den `settledAt` allein nicht deckt (Codex-Befund P1 zu PR #1072):
  // die juengere Antwort raeumt den Merker zu Recht - sie kennt den Wert -, und
  // die aeltere schrieb danach den Stand von vor der Bearbeitung zurueck.
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const alt = deferred();   // Schnappschuss VOR dem Abhaken
  const neu = deferred();   // Schnappschuss NACH der Bestaetigung
  const gates = [alt, neu];
  globalThis.__apiStub = { get: () => gates.shift().promise, patch: async () => ({ data: null }) };

  const ladenAlt = __test.loadItems(1);            // beginnt zuerst
  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  const ladenNeu = __test.loadItems(1);            // beginnt danach

  // Die JUENGERE landet zuerst und raeumt den Merker.
  neu.resolve({ data: [milk(1)] });
  await ladenNeu;
  assert.equal(__test.state.items[0].is_checked, 1);
  assert.equal(__test.pendingChecks.size, 0, 'die juengere Antwort kennt den Wert, der Merker darf gehen');

  // Und jetzt trifft die AELTERE ein.
  alt.resolve({ data: [milk(0)] });
  await ladenAlt;
  assert.equal(__test.state.items[0].is_checked, 1,
    'eine ueberholte Antwort darf den bereits angewandten Stand nicht mehr ueberschreiben');
  delete globalThis.__apiStub;
});

test('scheitert der PATCH, springt die Zeile auf den FRISCHEN Serverstand zurueck', async () => {
  // Ohne diesen Weg naehme der Ruecksprung den Wert von vor dem Antippen - eine
  // Angabe, die der Server nie hatte, wenn jemand anderes die Zeile inzwischen
  // umgestellt hat. Die Auffrischung ist die letzte Stelle, die davon weiss.
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  const patchGate = deferred();
  globalThis.__apiStub = {
    // Jemand anderes im Haushalt hat den Artikel ebenfalls abgehakt.
    get: async () => ({ data: [milk(1)] }),
    patch: () => patchGate.promise,
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  await __test.loadItems(1);
  assert.equal(__test.state.items[0].is_checked, 1);

  patchGate.promise.catch(() => {});
  patchGate.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.state.items[0].is_checked, 1,
    'der Ruecksprung muss den frischen Serverstand treffen, nicht den Stand von vor dem Antippen');
  assert.equal(__test.state.lists[0].item_checked, 1, 'und der Zaehler muss dazu passen');
  assert.equal(toasts.length, 1);
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

// --------------------------------------------------------
// Eine Antwort aus dem Offline-Cache ist kein Beweis
//
// `/shopping` steht in `API_CACHE_WHITELIST` (sw.js). Faellt das Netz aus,
// liefert `networkFirstApi` die zuletzt gecachte Antwort mit ihrem
// urspruenglichen Status 200 - vom Aufrufer sonst nicht von einer frischen zu
// unterscheiden, und eine Mutation leert diesen Cache nicht. Genau der Fall im
// Laden bei wackligem Netz (Codex-Befund P1 zu PR #1072).
// --------------------------------------------------------

test('eine gecachte Antwort raeumt den Merker NICHT', async () => {
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  globalThis.__apiStub = {
    // Der Cache-Stand ist von VOR dem Abhaken - und traegt trotzdem 200.
    getWithSource: async () => ({ data: { data: [milk(0)] }, fromCache: true }),
    patch: async () => ({ data: null }),
  };

  await __test.toggleShoppingItem(10, 0, makeNullContainer());
  assert.equal(__test.state.items[0].is_checked, 1);

  // Ein spaeter begonnenes Laden - aber offline. Es beweist nichts.
  await __test.loadItems(1);
  assert.equal(__test.state.items[0].is_checked, 1,
    'offline darf die Zeile nicht auf den Cache-Stand zurueckspringen');
  assert.equal(__test.pendingChecks.size, 1, 'der Merker muss stehen bleiben');

  // Sobald das Netz wieder da ist, raeumt eine echte Antwort auf.
  globalThis.__apiStub.getWithSource = async () => ({ data: { data: [milk(1)] }, fromCache: false });
  await __test.loadItems(1);
  assert.equal(__test.pendingChecks.size, 0, 'die netzfrische Antwort raeumt');
  delete globalThis.__apiStub;
});

test('eine gecachte Antwort setzt die Ruecksprung-Grundlage nicht neu', async () => {
  // Sonst haette der Cache-Stand das letzte Wort darueber, was „der Server
  // zuletzt sagte" - und er ist beliebig alt.
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const patchGate = deferred();
  globalThis.__apiStub = {
    // Erst frisch: jemand anderes hat den Artikel ebenfalls abgehakt.
    getWithSource: async () => ({ data: { data: [milk(1)] }, fromCache: false }),
    patch: () => patchGate.promise,
  };

  const abhaken = __test.toggleShoppingItem(10, 0, makeNullContainer());
  await __test.loadItems(1);

  // Dann faellt das Netz aus, und der Cache traegt noch den Stand von vorher.
  globalThis.__apiStub.getWithSource = async () => ({ data: { data: [milk(0)] }, fromCache: true });
  await __test.loadItems(1);

  patchGate.promise.catch(() => {});
  patchGate.resolve(Promise.reject(Object.assign(new Error('nope'), { data: { error: 'kaputt' } })));
  await abhaken;

  assert.equal(__test.state.items[0].is_checked, 1,
    'die Grundlage bleibt die frische 1, nicht die gecachte 0');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});

test('eine gecachte Antwort verdraengt keine echte, die spaeter eintrifft', async () => {
  // Bei wackligem Netz scheitert die SPAETER begonnene Anfrage oft zuerst und
  // wird aus dem Cache bedient. Zoege sie die Wasserstandsmarke hoch, waere die
  // frueher begonnene, aber ECHTE Antwort danach „veraltet" - der Cache haette
  // den frischen Stand verdraengt (Codex-Befund P2 zu PR #1072).
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  const frisch = deferred();
  const antworten = [
    () => frisch.promise,                                             // beginnt zuerst, antwortet spaet
    async () => ({ data: { data: [milk(0)] }, fromCache: true }),     // beginnt spaeter, aus dem Cache
  ];
  globalThis.__apiStub = { getWithSource: () => antworten.shift()(), patch: async () => ({ data: null }) };

  const ladenFrisch = __test.loadItems(1);   // startedAt 1
  await __test.loadItems(1);                 // startedAt 2, aus dem Cache

  frisch.resolve({ data: { data: [milk(1)] }, fromCache: false });
  await ladenFrisch;

  assert.equal(__test.state.items[0].is_checked, 1,
    'die echte Antwort muss ankommen, auch wenn eine gecachte spaeter begann');
  delete globalThis.__apiStub;
});

test('ein zweites Antippen springt nicht am ersten, erfolgreichen vorbei zurueck', async () => {
  // Auffrischung startet bei is_checked 0, das erste Antippen (0->1) wird
  // BESTAETIGT, das zweite (1->0) laeuft noch, dann trifft die alte Antwort
  // ein. Setzte sie die Ruecksprung-Grundlage auf ihre 0, landete ein
  // Fehlschlag des zweiten Antippens bei 0 - obwohl der Server 1 bestaetigt hat.
  resetShoppingState();
  __test.pendingChecks.clear();
  __test.state.lists = [{ id: 1, name: 'Einkauf', item_total: 1, item_checked: 0 }];
  __test.state.items = [milk(0)];

  global.window.yuvomi.showToast = () => {};
  const alt = deferred();
  let patchZaehler = 0;
  globalThis.__apiStub = {
    getWithSource: () => alt.promise,
    patch: async () => {
      patchZaehler += 1;
      if (patchZaehler === 1) return { data: null };                  // erstes Antippen: Erfolg
      throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } });
    },
  };

  const laden = __test.loadItems(1);                                   // Schnappschuss: 0
  await __test.toggleShoppingItem(10, 0, makeNullContainer());         // 0 -> 1, bestaetigt
  assert.equal(__test.state.items[0].is_checked, 1);

  const zweites = __test.toggleShoppingItem(10, 1, makeNullContainer()); // 1 -> 0, ausstehend
  alt.resolve({ data: { data: [milk(0)] }, fromCache: false });
  await laden;
  await zweites;

  assert.equal(__test.state.items[0].is_checked, 1,
    'der Ruecksprung gehoert auf die bestaetigte 1, nicht auf die 0 des alten Schnappschusses');
  delete globalThis.__apiStub;
  delete global.window.yuvomi.showToast;
});
