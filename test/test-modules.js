/**
 * Test: Third-party-Modul-Registry (Härtung)
 * Zweck: End-to-End über den echten Router (server/routes/modules.js) plus direkte
 *        Service-Assertions (server/services/modules.js) - beide zuvor ohne
 *        datei-importierenden Test. Substanz:
 *          - Manifest-Validierung/-Normalisierung (ID/entry/style/accent/menu-Defaults)
 *          - Path-Traversal-Schutz (isSafeRelativeFile + resolve-Confinement) an
 *            entry/style/asset - sicherheitskritisch
 *          - error-Modul-Fallback bei kaputtem/ungültigem module.json
 *          - listModules admin- vs. non-admin-Filter + Sortierung (order, dann name)
 *          - setModuleEnabled-Gates (400 id / 404 / 400 error-enable) + disabled-
 *            Persistenz in sync_config (idempotenter Toggle)
 *          - resolveAssetPath-Fehlerpfade (404 unbekannt/disabled, 400 unsafe, 404 fehlt)
 *          - Route-Auth (requireAdmin auf PATCH, admin-Query-Gate auf GET, KEIN Bypass),
 *            Asset-MIME + Cache-Header
 *
 *        Abweichung vom :memory:-DB-Standard nur beim Dateisystem: MODULES_DIR zeigt
 *        auf einen isolierten Temp-Ordner (der Service liest echte Ordner/Manifeste),
 *        die DB bleibt In-Memory (sync_config genügt). Kein Netz, keine Mocks.
 * Ausführen: node --experimental-sqlite --test test/test-modules.js
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// ── Isolierte Temp-Modul-Umgebung VOR den dynamischen Imports einrichten ─────────
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yuvomi-modules-'));
const MODULES_DIR = path.join(TMP_ROOT, 'modules');
fs.mkdirSync(MODULES_DIR, { recursive: true });

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';
process.env.MODULES_DIR = MODULES_DIR; // wird beim Modul-Load als const gelesen

// Fake-Module schreiben, bevor der Service geladen wird.
function writeModule(folder, manifest, files = {}) {
  const dir = path.join(MODULES_DIR, folder);
  fs.mkdirSync(dir, { recursive: true });
  if (manifest !== null) {
    const body = typeof manifest === 'string' ? manifest : JSON.stringify(manifest);
    fs.writeFileSync(path.join(dir, 'module.json'), body);
  }
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
}

// Drei valide Module (unterschiedliche menu.order für die Sortier-Assertion).
writeModule('alpha-mod', {
  id: 'alpha-mod', name: 'Alpha', version: '1.0.0', description: 'Alpha module',
  entry: 'index.js', style: 'style.css', icon: 'star', accent: '#112233',
  menu: { order: 10, label: 'Alpha Menu', icon: 'sparkles', show: true },
}, { 'index.js': 'export default {};\n', 'style.css': '.alpha{}\n' });

// Minimal-Manifest: prüft die Default-Ableitungen (accent-Fallback, menu-Defaults,
// style=null). menu.show=false ist reine UI-Sichtbarkeit, NICHT enabled.
writeModule('beta-mod', {
  id: 'beta-mod', entry: 'app.js', menu: { order: 5, show: false },
}, { 'app.js': 'export default {};\n' });

// Ohne menu-Objekt → order-Default 1000, sortiert zuletzt.
writeModule('omega-mod', {
  id: 'omega-mod', name: 'Omega', entry: 'main.js',
}, { 'main.js': 'export default {};\n' });

// Vier fehlerhafte Module (jeweils anderer Fehlerpfad).
writeModule('broken-json-mod', '{ das ist kein json', { 'index.js': '' });
writeModule('mismatch-mod', { id: 'other-id', entry: 'index.js' }, { 'index.js': '' });
writeModule('no-entry-mod', { id: 'no-entry-mod', entry: 'missing.js' }); // Datei fehlt
writeModule('bad-entry-mod', { id: 'bad-entry-mod', entry: '../evil.js' }); // unsafe entry
// style vorhanden, aber weder sicher noch .css → normalizeManifest lehnt ab.
writeModule('bad-style-mod', { id: 'bad-style-mod', entry: 'index.js', style: 'theme.txt' },
  { 'index.js': '' });
// style ist ein sicherer .css-Pfad, aber die Datei fehlt → readModule wirft.
writeModule('no-style-file-mod', { id: 'no-style-file-mod', entry: 'index.js', style: 'theme.css' },
  { 'index.js': '' });

// Loser Nicht-Ordner-Eintrag im MODULES_DIR → muss weggefiltert werden.
fs.writeFileSync(path.join(MODULES_DIR, 'loose.txt'), 'not a module');

writeModule('cap-mod', {
  id: 'cap-mod',
  name: 'Capabilities Module',
  entry: 'index.js',
  capabilities: {
    permissions: {
      module: { label: 'Cap Module', icon: 'star' },
      widgets: [{ id: 'tile', label: 'Tile' }],
    },
    widgets: [{
      id: 'tile',
      entry: 'widgets/tile.js',
      label: 'Tile',
      defaultSize: '2x1',
      optionsSchema: {
        show_title: { type: 'boolean', title: 'Show title', default: true },
      },
    }],
    api: { prefix: '/api/extensions/cap-mod' },
  },
}, {
  'index.js': 'export async function render() {}\n',
  'widgets/tile.js': 'export async function renderWidget(c) { c.textContent = "ok"; }\n',
});

writeModule('bad-cap-mod', {
  id: 'bad-cap-mod',
  entry: 'index.js',
  capabilities: {
    permissions: { module: { label: 'Bad', icon: 'box' } },
    widgets: [{ id: 'tile', entry: 'widgets/missing.js', label: 'Tile' }],
  },
}, { 'index.js': 'export async function render() {}\n' });

writeModule('i18n-mod', {
  id: 'i18n-mod',
  name: 'I18n Module',
  entry: 'index.js',
  i18n: { defaultLocale: 'en' },
  menu: { label: 'I18n', labelKey: 'menu', show: false },
}, {
  'index.js': 'export async function render() {}\n',
  'locales/en.json': JSON.stringify({ menu: 'Menu EN' }),
  'locales/de.json': JSON.stringify({ menu: 'Menu DE' }),
  'locales/xx.json': JSON.stringify({ menu: 'Invalid' }),
});

const VALID_IDS = ['alpha-mod', 'beta-mod', 'omega-mod', 'cap-mod', 'i18n-mod'];
const ERROR_IDS = ['broken-json-mod', 'mismatch-mod', 'no-entry-mod', 'bad-entry-mod',
  'bad-style-mod', 'no-style-file-mod', 'bad-cap-mod'];

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const svc = await import('../server/services/modules.js');
const { default: modulesRouter } = await import('../server/routes/modules.js');
const db = dbmod.get();

// ── App mit injizierter Auth (actor zur Request-Zeit gelesen) ────────────────────
let actor = { id: 1, role: 'admin' };
const app = express();
app.use((req, _res, next) => {
  req.authUserId = actor.id;
  req.authRole = actor.role;
  req.session = { userId: actor.id, role: actor.role };
  next();
});
app.use(express.json());
app.use('/', modulesRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));

const ADM = { id: 1, role: 'admin' };
const MEM = { id: 2, role: 'member' };

async function call(method, route, { actor: a, body } = {}) {
  if (a) actor = a;
  const headers = {};
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get('content-type') || '';
  let json = null;
  if (ct.includes('application/json')) { try { json = JSON.parse(buf.toString('utf8')); } catch { /* leer */ } }
  return { status: res.status, body: json, buf, contentType: ct, cacheControl: res.headers.get('cache-control') || '' };
}

function disabledConfig() {
  const row = db.prepare("SELECT value FROM sync_config WHERE key = 'third_party_disabled_modules'").get();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

test.after(() => {
  server.close();
  try { fs.rmSync(TMP_ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ── Service: Manifest-Normalisierung + Default-Ableitung ─────────────────────────
test('listModules(admin): valide Manifeste werden vollständig normalisiert', async () => {
  const mods = await svc.listModules({ admin: true });
  const byId = Object.fromEntries(mods.map((m) => [m.id, m]));

  const alpha = byId['alpha-mod'];
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.version, '1.0.0');
  assert.equal(alpha.accent, '#112233');
  assert.equal(alpha.status, 'enabled');
  assert.equal(alpha.enabled, true);
  // Öffentliche Asset-URLs werden aus id + relativem Pfad gebaut.
  assert.equal(alpha.route.path, '/m/alpha-mod');
  assert.equal(alpha.route.entry, '/api/v1/modules/assets/alpha-mod/index.js');
  assert.equal(alpha.route.style, '/api/v1/modules/assets/alpha-mod/style.css');
  assert.equal(alpha.menu.label, 'Alpha Menu');
  assert.equal(alpha.menu.icon, 'sparkles');
  assert.equal(alpha.menu.order, 10);

  const beta = byId['beta-mod'];
  assert.equal(beta.name, 'beta-mod', 'name fällt auf id zurück');
  assert.equal(beta.accent, '#6366F1', 'accent-Fallback greift');
  assert.equal(beta.style, null, 'ohne style bleibt style null');
  assert.equal(beta.route.style, null);
  assert.equal(beta.menu.show, false, 'menu.show wird übernommen');
  assert.equal(beta.menu.label, 'beta-mod', 'menu.label fällt auf name zurück');
  assert.equal(beta.enabled, true, 'menu.show=false lässt das Modul dennoch enabled');
});

// ── Service: error-Fallback bei ungültigem Manifest ──────────────────────────────
test('listModules(admin): jedes kaputte Modul wird zum error-Eintrag (kein Wurf)', async () => {
  const mods = await svc.listModules({ admin: true });
  const byId = Object.fromEntries(mods.map((m) => [m.id, m]));
  for (const id of ERROR_IDS) {
    const m = byId[id];
    assert.ok(m, `error-Modul ${id} taucht in der Admin-Liste auf`);
    assert.equal(m.status, 'error');
    assert.equal(m.enabled, false);
    assert.equal(m.route, null);
    assert.ok(typeof m.error === 'string' && m.error.length > 0, `${id} trägt eine Fehlermeldung`);
  }
  // Der lose Nicht-Ordner-Eintrag ist kein Modul.
  assert.equal(byId['loose.txt'], undefined, 'lose Datei wird gefiltert');
  // Insgesamt exakt valide + error, nichts sonst.
  assert.equal(mods.length, VALID_IDS.length + ERROR_IDS.length);
});

// ── Service: non-admin filtert + Sortierung ──────────────────────────────────────
test('listModules(): non-admin zeigt nur enabled+ok, sortiert nach order dann name', async () => {
  const mods = await svc.listModules({ admin: false });
  assert.deepEqual(mods.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod'],
    'order 5 < 10 < 1000, dann name');
  assert.ok(mods.every((m) => m.status === 'enabled'), 'keine error-Module für Nutzer');
});

test('listModules(): korrupter disabled-Eintrag in sync_config → als leer behandelt', async () => {
  // parseDisabledModules fängt ungültiges JSON ab und liefert [] (kein Wurf).
  db.prepare("INSERT INTO sync_config (key, value) VALUES ('third_party_disabled_modules', '{kaputt')").run();
  const mods = await svc.listModules({ admin: false });
  assert.deepEqual(mods.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod'],
    'nichts gilt als deaktiviert, wenn der Eintrag unlesbar ist');
  // Wieder entfernen: die folgenden PATCH-Tests erwarten einen jungfräulichen Zustand.
  db.prepare("DELETE FROM sync_config WHERE key = 'third_party_disabled_modules'").run();
});

// ── Route GET /: non-admin sieht nur nutzbare Module ─────────────────────────────
test('GET /: member erhält nur enabled Module', async () => {
  const r = await call('GET', '/', { actor: MEM });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.map((m) => m.id), ['beta-mod', 'alpha-mod', 'cap-mod', 'i18n-mod', 'omega-mod']);
});

test('GET /?admin=1: member wird NICHT als admin behandelt (kein Bypass)', async () => {
  const r = await call('GET', '/?admin=1', { actor: MEM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length, 'admin-Query von Nicht-Admin ignoriert');
  assert.ok(!r.body.data.some((m) => m.status === 'error'));
});

test('GET /?admin=1: admin sieht alle Module inkl. error/disabled', async () => {
  const r = await call('GET', '/?admin=1', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length + ERROR_IDS.length);
  assert.ok(r.body.data.some((m) => m.status === 'error'), 'error-Module sichtbar');
});

test('GET / ohne admin-Query: admin erhält dennoch nur die Nutzer-Liste', async () => {
  const r = await call('GET', '/', { actor: ADM });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.length, VALID_IDS.length, 'admin=1 muss explizit gesetzt sein');
});

// ── Route GET /assets: Auslieferung + MIME + Cache-Header ─────────────────────────
test('GET /assets/:id/*: liefert JS mit korrektem MIME und no-cache', async () => {
  const r = await call('GET', '/assets/alpha-mod/index.js', { actor: MEM });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/javascript/);
  assert.match(r.cacheControl, /no-cache/, 'Modul-Assets werden nicht dauerhaft gecacht');
  assert.equal(r.buf.toString('utf8'), 'export default {};\n');
});

test('GET /assets/:id/*: liefert CSS mit korrektem MIME', async () => {
  const r = await call('GET', '/assets/alpha-mod/style.css', { actor: MEM });
  assert.equal(r.status, 200);
  assert.match(r.contentType, /text\/css/);
  assert.equal(r.buf.toString('utf8'), '.alpha{}\n');
});

test('GET /assets/:id/*: fehlende Datei → 404', async () => {
  const r = await call('GET', '/assets/alpha-mod/nope.js', { actor: MEM });
  assert.equal(r.status, 404);
});

test('GET /assets/:id/*: unbekanntes Modul → 404', async () => {
  const r = await call('GET', '/assets/ghost-mod/index.js', { actor: MEM });
  assert.equal(r.status, 404);
});

// ── Service resolveAssetPath: Traversal-/Fehlerpfade (deterministisch) ───────────
test('resolveAssetPath: gültiger Pfad zeigt in den Modul-Ordner', async () => {
  const p = await svc.resolveAssetPath('alpha-mod', 'index.js');
  assert.equal(p, path.join(MODULES_DIR, 'alpha-mod', 'index.js'));
});

test('resolveAssetPath: Path-Traversal wird mit 400 abgewiesen', async () => {
  for (const rel of ['../evil.js', '../../etc/passwd', '/etc/passwd', 'a\\b.js', 'sub/../../x']) {
    await assert.rejects(
      () => svc.resolveAssetPath('alpha-mod', rel),
      (err) => err.status === 400,
      `unsafe path ${rel} muss 400 werfen`,
    );
  }
});

test('resolveAssetPath: unbekanntes Modul → 404', async () => {
  await assert.rejects(() => svc.resolveAssetPath('ghost-mod', 'index.js'), (e) => e.status === 404);
});

test('resolveAssetPath: existierendes Modul, fehlende Datei → 404', async () => {
  await assert.rejects(() => svc.resolveAssetPath('alpha-mod', 'nope.js'), (e) => e.status === 404);
});

// ── Service setModuleEnabled: Gates ──────────────────────────────────────────────
test('setModuleEnabled: ungültige id → 400', async () => {
  await assert.rejects(() => svc.setModuleEnabled('Bad_ID!', false), (e) => e.status === 400);
});

test('setModuleEnabled: unbekanntes Modul → 404', async () => {
  await assert.rejects(() => svc.setModuleEnabled('ghost-mod', false), (e) => e.status === 404);
});

test('setModuleEnabled: error-Modul aktivieren → 400 (bleibt fehlerhaft)', async () => {
  await assert.rejects(() => svc.setModuleEnabled('broken-json-mod', true), (e) => e.status === 400);
});

// ── Route PATCH /:id: Auth + Validierung ─────────────────────────────────────────
test('PATCH /:id: member → 403 (requireAdmin, kein Bypass), sync_config unverändert', async () => {
  assert.equal(disabledConfig(), null, 'Vorbedingung: noch nichts deaktiviert');
  const r = await call('PATCH', '/alpha-mod', { actor: MEM, body: { enabled: false } });
  assert.equal(r.status, 403);
  assert.equal(disabledConfig(), null, 'kein Schreib-Durchschlag durch das Auth-Gate');
});

test('PATCH /:id: enabled kein boolean → 400', async () => {
  for (const bad of [{ enabled: 'yes' }, { enabled: 1 }, {}]) {
    const r = await call('PATCH', '/alpha-mod', { actor: ADM, body: bad });
    assert.equal(r.status, 400, `Body ${JSON.stringify(bad)} muss 400 liefern`);
  }
});

test('PATCH /:id: unbekanntes Modul → 404', async () => {
  const r = await call('PATCH', '/ghost-mod', { actor: ADM, body: { enabled: false } });
  assert.equal(r.status, 404);
});

// ── Route PATCH /:id: Toggle + Persistenz (mutierend → gegen Ende) ────────────────
test('PATCH /:id: deaktivieren persistiert und verbirgt das Modul für Nutzer', async () => {
  const r = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: false } });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'disabled');
  assert.equal(r.body.data.enabled, false);
  assert.deepEqual(disabledConfig(), ['alpha-mod'], 'in sync_config gespeichert');

  // Nutzer-Liste zeigt alpha-mod nicht mehr, resolveAssetPath verweigert Assets.
  const list = await call('GET', '/', { actor: MEM });
  assert.ok(!list.body.data.some((m) => m.id === 'alpha-mod'));
  const asset = await call('GET', '/assets/alpha-mod/index.js', { actor: MEM });
  assert.equal(asset.status, 404, 'Assets deaktivierter Module sind nicht abrufbar');
});

test('PATCH /:id: reaktivieren ist idempotent und stellt das Modul wieder her', async () => {
  const r1 = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(r1.status, 200);
  assert.equal(r1.body.data.status, 'enabled');
  assert.deepEqual(disabledConfig(), [], 'aus der disabled-Liste entfernt');

  // Erneutes enable=true ändert nichts (idempotent).
  const r2 = await call('PATCH', '/alpha-mod', { actor: ADM, body: { enabled: true } });
  assert.equal(r2.status, 200);
  assert.deepEqual(disabledConfig(), []);

  const list = await call('GET', '/', { actor: MEM });
  assert.ok(list.body.data.some((m) => m.id === 'alpha-mod'), 'wieder sichtbar');
});

test('listModules: capabilities werden normalisiert und exponiert', async () => {
  const mods = await svc.listModules({ admin: true });
  const cap = mods.find((m) => m.id === 'cap-mod');
  assert.ok(cap, 'cap-mod vorhanden');
  assert.equal(cap.capabilities.permissionModuleKey, 'ext:cap-mod');
  assert.equal(cap.capabilities.widgets[0].id, 'cap-mod:tile');
  assert.equal(cap.capabilities.apiPrefix, '/api/extensions/cap-mod');
  assert.equal(cap.capabilities.widgets[0].optionsSchema.show_title.type, 'boolean');
});

test('listModules: i18n metadata scans locales/ and filters unsupported codes', async () => {
  const mods = await svc.listModules({ admin: true });
  const i18nMod = mods.find((m) => m.id === 'i18n-mod');
  assert.ok(i18nMod, 'i18n-mod vorhanden');
  assert.equal(i18nMod.i18n.defaultLocale, 'en');
  assert.deepEqual(i18nMod.i18n.availableLocales, ['de', 'en']);
  assert.ok(Array.isArray(i18nMod.i18n.coreLocales) && i18nMod.i18n.coreLocales.includes('de'));
});

test('listModules: fehlende widget entry datei → error status', async () => {
  const mods = await svc.listModules({ admin: true });
  const bad = mods.find((m) => m.id === 'bad-cap-mod');
  assert.equal(bad.status, 'error');
  assert.match(bad.error, /does not exist/i);
});
