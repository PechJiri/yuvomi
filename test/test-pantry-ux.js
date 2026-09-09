/**
 * Tests: Mengen-Stepper des Vorrats gegen eine ueberholende Auffrischung
 * Modul: /public/pages/pantry.js
 *
 * WARUM ALS REIHENFOLGE-TEST: der Fehler ist nicht „es fehlt eine Wache",
 * sondern „die Auffrischung faellt MITTEN in das Entprell-Fenster". Eine
 * Textprobe auf `pendingQuantity` waere seit jeher gruen gewesen - die Map gab
 * es, sie wurde nach dem Laden nur nie wieder aufgetragen, und der Timer hielt
 * danach ein Objekt, das an keinem Bestand mehr haengt. Die Tests unten stellen
 * die Reihenfolge deshalb wirklich: erst der Schritt, dann die Antwort mit dem
 * ALTEN Stand, dann der PATCH.
 *
 * Ausführen: node --loader ./test/test-browser-loader.mjs --test test/test-pantry-ux.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

global.HTMLElement = class HTMLElement {};
global.customElements = { define() {}, get() { return undefined; } };

/** Generischer Knoten: genug fuer `rowEl`, das die Zeile wirklich neu baut. */
function makeNode() {
  const node = {
    style: {}, dataset: {}, children: [],
    className: '', textContent: '', type: '', hidden: false, disabled: false,
    isConnected: true,
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
    appendChild(child) { node.children.push(child); return child; },
    append(...kids) { node.children.push(...kids); },
    replaceChildren() { node.children = []; },
    replaceWith() {},
    insertAdjacentHTML() {},
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    focus() {},
  };
  return node;
}

global.window = { matchMedia: () => ({ matches: false }), addEventListener() {}, yuvomi: {} };
global.document = {
  createElement: () => makeNode(),
  getElementById: () => null,
  querySelector: () => null,
  addEventListener() {},
  documentElement: { lang: 'de' },
  activeElement: null,
};

const { __test } = await import('../public/pages/pantry.js');

/** Zeile mit genau den zwei Stellen, die `refreshRowQuantity` wirklich anfasst. */
function makeRow(step = 1) {
  const quantityEl = makeNode();
  const minus = makeNode();
  const stepper = makeNode();
  stepper.dataset.step = String(step);
  const row = makeNode();
  row.querySelector = (sel) => {
    if (sel === '.pantry-row__quantity') return quantityEl;
    if (sel === '[data-action="decrease"]') return minus;
    if (sel === '.pantry-stepper') return stepper;
    return null;
  };
  return { row, quantityEl, minus };
}

function rice(quantity, extra = {}) {
  return {
    id: 5, name: 'Reis', quantity, unit: 'pcs',
    min_quantity: null, expires_on: null, category: 'Sonstiges', location_id: null,
    ...extra,
  };
}

function resetPantry() {
  __test.pendingQuantity.clear();
  __test.state.items = [];
  __test.state.locations = [];
  __test.state.categories = [];
  __test.state.filter = 'all';
  __test.state.query = '';
  __test.setContainerForTest(null);
  __test.setQuantityDebounceMsForTest(null);
  delete globalThis.__apiStub;
}

/** Wartet, bis der entprellte PATCH gefeuert und abgearbeitet ist. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 25));

test('ein Schritt ueberlebt eine Auffrischung mitten im Entprell-Fenster', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  let patched = null;
  globalThis.__apiStub = {
    // Der Schnappschuss dieser Auffrischung ist VOR dem Schritt entstanden.
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    patch: async (_path, body) => { patched = body; return { data: rice(body.quantity) }; },
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  assert.equal(__test.state.items[0].quantity, 3, 'optimistisch erhoeht');

  // Die Auffrischung faellt in das Fenster - vor dem PATCH.
  await __test.loadPantry();
  assert.equal(__test.state.items[0].quantity, 3,
    'die alte Antwort darf den Schritt nicht zuruecknehmen');

  await settled();
  assert.deepEqual(patched, { quantity: 3 }, 'der Server bekommt den gewollten Wert');
});

test('die Antwort landet im NEUEN Artikelobjekt, nicht im abgehaengten', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  globalThis.__apiStub = {
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    // Der Server liefert ein Feld mit, das der Client nicht selbst kennt -
    // daran laesst sich ablesen, WO die Antwort gelandet ist.
    patch: async (_p, body) => ({ data: rice(body.quantity, { notes: 'vom Server' }) }),
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await __test.loadPantry();   // tauscht `state.items` gegen neue Objekte aus
  await settled();

  assert.equal(__test.state.items[0].quantity, 3);
  assert.equal(__test.state.items[0].notes, 'vom Server',
    'ohne frische Aufloesung schreibt Object.assign in ein Objekt, das an nichts mehr haengt');
});

/** Ein von Hand aufloesbares Versprechen - damit steht die Reihenfolge fest. */
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

test('eine Antwort, die den PATCH ueberholt hat, dreht den Schritt nicht zurueck', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const gate = deferred();
  globalThis.__apiStub = {
    get: () => gate.promise,
    patch: async (_p, body) => ({ data: rice(body.quantity) }),
  };

  // 1. Die Auffrischung geht los, ihr Schnappschuss zeigt noch die 2.
  const loading = __test.loadPantry();
  // 2. Der Schritt und sein PATCH laufen komplett durch.
  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();
  assert.equal(__test.state.items[0].quantity, 3);
  // 3. ERST JETZT trifft die alte Antwort ein - ein Merker, der beim
  //    PATCH-Erfolg verschwaende, waere hier schon weg.
  gate.resolve({ data: [rice(2)], locations: [], categories: [] });
  await loading;

  assert.equal(__test.state.items[0].quantity, 3,
    'die bestaetigte Menge muss die aeltere Antwort ueberstehen');
});

test('ein spaeter begonnenes Laden raeumt den Merker - fremde Aenderungen kommen durch', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  globalThis.__apiStub = {
    get: async () => ({ data: [rice(9)], locations: [], categories: [] }),
    patch: async (_p, body) => ({ data: rice(body.quantity) }),
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();
  assert.equal(__test.state.items[0].quantity, 3);

  // Dieses Laden beginnt NACH der Bestaetigung: jemand anderes hat den Vorrat
  // aufgefuellt. Haelt der Merker hier noch, waere der Server unwirksam.
  await __test.loadPantry();
  assert.equal(__test.state.items[0].quantity, 9);
  assert.equal(__test.pendingQuantity.size, 0, 'kein Rest im Merker');
});

test('scheitert der PATCH, bleibt kein Merker stehen', async () => {
  resetPantry();
  __test.state.items = [rice(2)];
  __test.setQuantityDebounceMsForTest(5);

  const toasts = [];
  global.window.yuvomi.showToast = (msg) => toasts.push(msg);
  globalThis.__apiStub = {
    get: async () => ({ data: [rice(2)], locations: [], categories: [] }),
    patch: async () => { throw Object.assign(new Error('nope'), { data: { error: 'kaputt' } }); },
  };

  const { row } = makeRow();
  __test.adjustQuantity(__test.state.items[0], +1, row);
  await settled();

  assert.equal(__test.state.items[0].quantity, 2, 'zurueckgedreht');
  assert.equal(__test.pendingQuantity.size, 0, 'ein gescheiterter Wunsch darf nichts auftragen');
  assert.equal(toasts.length, 1);
  delete global.window.yuvomi.showToast;
});
