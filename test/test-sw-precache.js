/**
 * Precache-Vollständigkeits-Guard für public/sw.js (#616).
 *
 * Hintergrund: der Browser führt pro Dokument genau eine Modul-Map. Ist ein
 * geteiltes Modul einmal geladen, wird jeder spätere Import dagegen gebunden -
 * auch der eines Seitenmoduls, das der neue Service Worker gerade frisch vom
 * Netz geholt hat. Precacht der SW also ein Seitenmodul, nicht aber dessen
 * Abhängigkeiten, kann nach einem Update im laufenden Tab ein neues Seitenmodul
 * auf eine alte Abhängigkeit treffen. Ein in der neuen Version hinzugekommener
 * Export fliegt dann als SyntaxError auf ("does not provide an export named"),
 * und die Seite landet im Fehlerbildschirm.
 *
 * Genau so ist v1.63.0 beim Öffnen des Rezepte-Moduls gescheitert: recipes.js
 * war precacht und neu, das darunter liegende utils/empty-state.js war es nicht
 * und blieb alt. Der Router verhindert den Mischzustand inzwischen zur Laufzeit
 * (shellStale in public/router.js); dieser Guard hält die Precache-Liste
 * vollständig, damit er gar nicht erst entstehen kann.
 *
 * Geprüft wird die Regel, nicht eine Allowlist bekannter Dateien: jede Datei,
 * die vom Modulgraph erreicht wird, muss precacht sein - sonst ist die nächste
 * neu hinzugefügte Utility wieder ein Loch.
 *
 * Abgedeckt:
 *   - jeder gelistete Pfad existiert (c.addAll() ist All-or-Nothing: eine
 *     fehlende Datei lässt den kompletten SW-Install scheitern)
 *   - der transitive Import-Graph aller precachten Module ist selbst precacht
 *   - jedes von index.html eager geladene Stylesheet ist precacht. Der
 *     Modulgraph oben sieht nur JS; CSS hängt an keinem `import`, und so lagen
 *     11 der 18 eager geladenen Stylesheets außerhalb des Precache, ohne dass
 *     eine Zeile dieser Datei das bemerken konnte
 *   - jedes von index.html geladene Skript ist precacht. Der Modulgraph oben
 *     beginnt erst bei den Einträgen der Precache-Liste; ein Skript, das dort
 *     fehlt, wird von keinem `import` erreicht und fällt deshalb durch beide
 *     Netze
 *   - Precache-Bucket und fetch-Routing stimmen überein (ein im SHELL_CACHE
 *     abgelegtes Modul darf nicht aus dem PAGES_CACHE bedient werden)
 *   - keine Doppeleinträge zwischen den Listen
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import { posix } from 'node:path';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const SRC = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');

/**
 * Führt sw.js in einer Sandbox aus und liest die Precache-Listen als echte
 * Arrays aus. Bewusst kein Regex-Parsing: die Listen sollen so geprüft werden,
 * wie der Service Worker sie zur Laufzeit sieht.
 */
function loadSwLists() {
  const noop = () => {};
  const cacheStub = {
    match: async () => undefined,
    put: async () => {},
    delete: async () => {},
    addAll: async () => {},
    keys: async () => [],
  };
  const sandbox = {
    self: { addEventListener: noop, skipWaiting: noop, clients: { claim: noop, matchAll: async () => [] }, location: { origin: 'https://app.test' } },
    caches: { open: async () => cacheStub, keys: async () => [], match: async () => undefined, delete: async () => {} },
    fetch: async () => ({ ok: false }),
    Request: class { constructor(url) { this.url = url; } },
    Response: class { constructor(body, init) { this.body = body; Object.assign(this, init); } },
    Headers: class { get() { return null; } set() {} },
    console,
    Date,
    Promise,
    parseInt,
  };
  sandbox.self.self = sandbox.self;
  const ctx = createContext(sandbox);
  const lists = runInContext(
    `${SRC}\n;({ APP_SHELL, PAGE_MODULES, APP_LOCALES, PAGE_MODULE_SET })`,
    ctx,
  );
  // In Host-Collections umkopieren: Arrays aus der Sandbox tragen deren
  // Array.prototype, woran assert.deepEqual scheitern würde.
  return {
    APP_SHELL: Array.from(lists.APP_SHELL),
    PAGE_MODULES: Array.from(lists.PAGE_MODULES),
    APP_LOCALES: Array.from(lists.APP_LOCALES),
    PAGE_MODULE_SET: new Set(Array.from(lists.PAGE_MODULE_SET)),
  };
}

const { APP_SHELL, PAGE_MODULES, APP_LOCALES, PAGE_MODULE_SET } = loadSwLists();

/**
 * Statische Importe einer Datei, als absolute Pfade.
 *
 * JEDE SCHREIBWEISE ZAEHLT, NICHT NUR DIE HAEUFIGSTE. Der Ausdruck sah lange
 * `from '/pfad'` und sonst nichts. Unsichtbar blieben damit zwei Formen, die
 * der Browser genauso laedt:
 *
 *   - relative Specifier - `from './nachbar.js'`
 *   - Seiteneffekt-Importe ohne Bindung - `import '/components/datepicker.js'`
 *
 * Beide Luecken haben je einen echten Fehler getragen, der jahrelang gruen war:
 * `settings/dirty-guard.js` (relativ, aus der Settings-Shell) und
 * `components/datepicker.js` (Seiteneffekt, aus dem Router). Online faellt so
 * etwas nie auf, weil das Netz die Luecke fuellt; offline scheitert der Import
 * und nimmt alles mit, was von der Datei abhaengt.
 *
 * Dynamische Importe stehen weiter bewusst aussen vor: sie sind zur Laufzeit
 * aufloesbar und blockieren keinen Modulgraph.
 */
function staticImports(pathname) {
  const file = PUBLIC_DIR + pathname.replace(/^\//, '');
  if (!existsSync(file)) return [];
  const code = readFileSync(file, 'utf8');
  const dir = posix.dirname(pathname);
  const specs = [
    ...[...code.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]),
    // `import 'x';` am Zeilenanfang - ohne `from`, ohne Klammer (das waere ein
    // dynamischer Import und bleibt draussen).
    ...[...code.matchAll(/^\s*import\s+'([^']+)'/gm)].map((m) => m[1]),
  ];
  return specs
    .filter((spec) => spec.startsWith('/') || spec.startsWith('.'))
    .map((spec) => (spec.startsWith('/') ? spec : posix.resolve(dir, spec)));
}

const precached = new Set([...APP_SHELL, ...PAGE_MODULES, ...APP_LOCALES]);

test('jeder precachte Pfad existiert (addAll ist All-or-Nothing)', () => {
  const missing = [...precached].filter((p) => p !== '/' && !existsSync(PUBLIC_DIR + p.replace(/^\//, '')));
  assert.deepEqual(missing, [], `Precache verweist auf nicht existierende Dateien: ${missing.join(', ')}`);
});

test('der transitive Modulgraph ist vollständig precacht (#616)', () => {
  const roots = [...APP_SHELL, ...PAGE_MODULES].filter((p) => p.endsWith('.js') || p.endsWith('.mjs'));
  const seen = new Set(roots);
  const queue = [...roots];
  const gaps = [];

  while (queue.length) {
    const current = queue.shift();
    for (const dep of staticImports(current)) {
      if (!precached.has(dep)) gaps.push(`${dep}  <- importiert von ${current}`);
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }

  assert.deepEqual(
    gaps, [],
    'Diese Module werden von precachten Modulen importiert, sind aber selbst nicht precacht. '
    + 'Nach einem Update können sie in ihrer alten Fassung gegen ein neues Seitenmodul gebunden '
    + `werden:\n  ${gaps.join('\n  ')}`,
  );
});

test('jedes eager geladene Stylesheet aus index.html ist precacht', () => {
  const html = readFileSync(PUBLIC_DIR + 'index.html', 'utf8');
  // Nur `rel="stylesheet"` ohne `media`/`onload`-Umweg: das sind die, die den
  // ersten Render blockieren. Ein per Router nachgeladenes Seiten-CSS zählt
  // nicht - es kommt erst, wenn die Shell schon steht.
  const eager = [...html.matchAll(/<link\b[^>]*\brel=["']stylesheet["'][^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => !/\bmedia=/.test(tag) && !/\bonload=/.test(tag))
    .map((tag) => tag.match(/\bhref=["']([^"']+)["']/)?.[1])
    .filter(Boolean);

  // Reichweiten-Nachweis: findet das Muster nichts, prüft die Assertion nichts.
  assert.ok(eager.length >= 10, `Nur ${eager.length} eager geladene Stylesheets gefunden - das Muster greift nicht mehr`);

  const shell = new Set(APP_SHELL);
  const missing = eager.filter((href) => !shell.has(href));
  assert.deepEqual(
    missing, [],
    'Diese Stylesheets lädt index.html eager, der Service Worker precacht sie aber nicht. '
    + `Der allererste Offline-Start rendert damit ungestylt:\n  ${missing.join('\n  ')}`,
  );
});

// Dieselbe Lücke wie oben, nur für JS: der Modulgraph-Test folgt `import`-Kanten
// ab der Precache-Liste und sieht deshalb nie, was index.html per <script> lädt
// und die Liste vergisst. `lucide-scope.js` ist genau so ein Fall - es hängt an
// keinem Import, sondern gibt `createIcons({ el })` an über zweihundert
// Aufrufstellen seinen Ausschnitt (siehe Dateikopf). Offline fehlte es, und die
// App liefe sichtbar unverändert weiter, nur langsamer.
test('jedes von index.html geladene Skript ist precacht', () => {
  const html = readFileSync(PUBLIC_DIR + 'index.html', 'utf8');
  // `i`, weil Tagname und Attribute in HTML schreibungsegal sind: eine
  // grossgeschriebene Fassung faende der Guard sonst nicht und meldete gruen,
  // obwohl er nichts gesehen hat (CodeQL js/bad-tag-filter).
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((m) => m[1])
    .filter((src) => src.startsWith('/')); // fremde Herkunft precacht der SW nicht

  // Reichweiten-Nachweis: findet das Muster nichts, prüft die Assertion nichts.
  assert.ok(scripts.length >= 5, `Nur ${scripts.length} Skripte gefunden - das Muster greift nicht mehr`);

  const shell = new Set(APP_SHELL);
  const missing = scripts.filter((src) => !shell.has(src));
  assert.deepEqual(
    missing, [],
    'Diese Skripte lädt index.html, der Service Worker precacht sie aber nicht. '
    + `Offline fehlen sie ersatzlos:\n  ${missing.join('\n  ')}`,
  );
});

test('Precache-Bucket und fetch-Routing stimmen überein', () => {
  // Der fetch-Handler leitet /pages/, /settings/ und alles in PAGE_MODULE_SET in
  // den PAGES_CACHE, den Rest über isMutableAppResource() in den SHELL_CACHE.
  // Ein APP_SHELL-Eintrag, auf den die PAGES-Bedingung zutrifft, läge im
  // SHELL_CACHE, würde aber aus dem PAGES_CACHE gesucht - offline ein Miss.
  const routedToPages = (p) => p.startsWith('/pages/') || p.startsWith('/settings/') || PAGE_MODULE_SET.has(p);

  const shellInPages = APP_SHELL.filter(routedToPages);
  assert.deepEqual(shellInPages, [], `In APP_SHELL precacht, aber aus PAGES_CACHE bedient: ${shellInPages.join(', ')}`);

  const pagesInShell = PAGE_MODULES.filter((p) => !routedToPages(p));
  assert.deepEqual(pagesInShell, [], `In PAGE_MODULES precacht, aber aus SHELL_CACHE bedient: ${pagesInShell.join(', ')}`);
});

test('keine Doppeleinträge zwischen den Precache-Listen', () => {
  const all = [...APP_SHELL, ...PAGE_MODULES, ...APP_LOCALES];
  const dupes = all.filter((p, i) => all.indexOf(p) !== i);
  assert.deepEqual([...new Set(dupes)], [], `Mehrfach precacht: ${dupes.join(', ')}`);
});

test('jedes Settings-Blatt der Registry ist precacht', () => {
  // Schwesterregel zum Modulgraph-Guard oben, und die Lücke, die er offen
  // lässt: er folgt Importen ab den precachten Modulen, ein Blatt aber wird
  // per dynamischem `loader: () => import(...)` geladen und steht damit in
  // keinem statischen Importbaum. Ein nicht precachtes Blatt ist deshalb kein
  // Mischzustand, sondern schlicht offline nicht erreichbar - stumm, weil es
  // online immer geht. Gemessen am 2026-08-15 fehlten sechs von 28, vier davon
  // seit längerem: admin-email, admin-permissions, personal-health und
  // personal-weather.
  //
  // Kanonische Quelle ist die Registry, nicht das Verzeichnis: ein Blatt, das
  // dort nicht steht, ist tot und muss nicht precacht sein.
  const registry = readFileSync(new URL('../public/settings/registry.js', import.meta.url), 'utf8');
  const leaves = [...registry.matchAll(/loader:\s*\(\)\s*=>\s*import\('([^']+)'\)/g)].map((m) => m[1]);

  assert.ok(leaves.length >= 20,
    `Nur ${leaves.length} Blätter in der Registry gefunden - das Muster greift nicht mehr`);

  const precached = new Set([...APP_SHELL, ...PAGE_MODULES]);
  const missing = leaves.filter((path) => !precached.has(path));
  assert.deepEqual(
    missing, [],
    'Diese Settings-Blätter stehen in der Registry, werden aber nicht precacht '
    + `und sind damit offline nicht erreichbar:\n  ${missing.join('\n  ')}`,
  );
});
