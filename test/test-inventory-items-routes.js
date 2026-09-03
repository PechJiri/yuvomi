/**
 * Test: Inventar-Gegenstaende-Routen (Stufe 1)
 * Zweck: CRUD, volles Replace (kein Feld behaelt den Altwert), Kategorie muss in
 *        inventory_categories existieren (Ablehnung, keine Normalisierung - anders
 *        als in der ersten, einfacheren Version dieses Projekts, weil Kategorien
 *        hier eine echte verwaltbare Tabelle sind, kein fester Code-Vorrat), Ort muss
 *        existieren, Waehrung faellt auf die Haushaltswaehrung zurueck, Filter,
 *        Volltextsuche, Ortspfad-Anzeige.
 * Ausfuehren: node --experimental-sqlite --test test/test-inventory-items-routes.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const { lockDocumentDeletes, unlockDocumentDeletes } = await import('../server/services/document-deletion-lock.js');
const db = dbmod.get();

const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
// Gleiches Limit wie server/index.js: der Oversized-photo_data-Test muss den
// Validator (400) erreichen, nicht schon an body-parsers Default-Limit (100kb)
// mit 413 scheitern.
app.use(express.json({ limit: '7mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.session = { userId: USER };
  next();
});
app.use('/items', itemsRouter);
const server = app.listen(0);
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204/leer */ }
  return { status: res.status, body: json };
}

function makeLocation(name, parentId = null) {
  return db.prepare('INSERT INTO inventory_locations (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid;
}

test('POST /items: minimaler Body bekommt Defaults', async () => {
  const r = await call('POST', '/items', { name: 'Laptop' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.category, 'other');
  assert.equal(r.body.data.condition, 'good');
  assert.equal(r.body.data.status, 'active');
  assert.equal(r.body.data.currency, 'EUR');
  assert.equal(r.body.data.location_path, null);
});

test('POST /items: unbekannte Kategorie -> 400 (abgelehnt, nicht normalisiert)', async () => {
  const r = await call('POST', '/items', { name: 'X', category: 'not-a-real-category' });
  assert.equal(r.status, 400);
});

test('POST /items: gueltige Kategorie wird uebernommen und aufgeloest (Seed-Kategorie -> label_key, Migration 142)', async () => {
  const r = await call('POST', '/items', { name: 'Router', category: 'electronics' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.category, 'electronics');
  // 'electronics' ist eine Seed-Kategorie (label_key statt name) - category_name
  // faellt serverseitig bewusst auf den Key zurueck, die Uebersetzung passiert
  // clientseitig ueber category_label_key (siehe public/pages/inventory.js#itemCategoryLabel).
  assert.equal(r.body.data.category_name, 'electronics');
  assert.equal(r.body.data.category_label_key, 'inventory.categoryElectronics');
});

test('POST /items: nicht existenter Ort -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', location_id: 999999 });
  assert.equal(r.status, 400);
});

test('POST /items: gueltiger Ort wird uebernommen, Ortspfad fuer einen Unterort zeigt beide Ebenen', async () => {
  const parent = makeLocation('Keller');
  const child = makeLocation('Regal 2', parent);
  const r = await call('POST', '/items', { name: 'Werkzeugkiste', location_id: child });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.location_path, 'Keller · Regal 2');
});

test('POST /items: negativer Kaufpreis -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', purchase_price: -5 });
  assert.equal(r.status, 400);
});

test('POST /items: Garantiemonate ausserhalb 0-600 -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', warranty_months: 700 });
  assert.equal(r.status, 400);
});

test('POST /items: ungueltige Waehrung -> 400, gueltige wird gross geschrieben uebernommen', async () => {
  assert.equal((await call('POST', '/items', { name: 'X', currency: 'eur1' })).status, 400);
  const r = await call('POST', '/items', { name: 'Y', currency: 'chf' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.currency, 'CHF');
});

test('PUT /items/:id: volles Replace - weggelassene Felder werden NICHT beibehalten', async () => {
  const created = await call('POST', '/items', {
    name: 'Espressomaschine', category: 'household', vendor: 'DeLonghi',
  });
  const r = await call('PUT', `/items/${created.body.data.id}`, { name: 'Espressomaschine' });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.category, 'other'); // nicht mehr 'household'
  assert.equal(r.body.data.vendor, null);
});

test('PUT /items/:id: laufende Dokumentlöschung lässt Gegenstand und Termine unverändert', async () => {
  const created = await call('POST', '/items', { name: 'Vorher' });
  const itemId = created.body.data.id;
  const documentId = db.prepare(`
    INSERT INTO family_documents
      (name, original_name, mime_type, file_size, content_data, category, visibility, status, created_by)
    VALUES ('Beleg', 'beleg.txt', 'text/plain', 1, ?, 'other', 'family', 'active', ?)
  `).run(Buffer.from('x'), USER).lastInsertRowid;

  lockDocumentDeletes([documentId]);
  try {
    const r = await call('PUT', `/items/${itemId}`, {
      name: 'Nachher',
      tracked_dates: [{ label: 'Service', date: '2035-06-01', reminder_offset_days: 14 }],
      attachment_document_ids: [documentId],
    });
    assert.equal(r.status, 409);
    assert.equal(r.body.reason, 'DOCUMENT_DELETE_IN_PROGRESS');
    assert.equal(db.prepare('SELECT name FROM inventory_items WHERE id = ?').get(itemId).name, 'Vorher');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM inventory_item_dates WHERE item_id = ?').get(itemId).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE entity_type IN ('inventory_item', 'inventory_tracked_date') AND entity_id = ?").get(itemId).n, 0);
  } finally {
    unlockDocumentDeletes([documentId]);
  }
});

test('DELETE /items/:id: 204, danach 404', async () => {
  const created = await call('POST', '/items', { name: 'Temp' });
  const del = await call('DELETE', `/items/${created.body.data.id}`);
  assert.equal(del.status, 204);
  assert.equal((await call('GET', `/items/${created.body.data.id}`)).status, 404);
});

test('GET /items: Filter nach category, location_id, status', async () => {
  const loc = makeLocation('Filterort');
  await call('POST', '/items', { name: 'Gefiltert 1', category: 'sports', location_id: loc, status: 'sold' });
  await call('POST', '/items', { name: 'Gefiltert 2', category: 'sports' });

  const byCategory = await call('GET', '/items?category=sports');
  assert.ok(byCategory.body.data.length >= 2);
  assert.ok(byCategory.body.data.every((i) => i.category === 'sports'));

  const byLocation = await call('GET', `/items?location_id=${loc}`);
  assert.ok(byLocation.body.data.some((i) => i.name === 'Gefiltert 1'));

  const byStatus = await call('GET', '/items?status=sold');
  assert.ok(byStatus.body.data.some((i) => i.name === 'Gefiltert 1'));
});

test('GET /items: Volltextsuche ueber Name/Marke/Modell/Seriennummer', async () => {
  await call('POST', '/items', { name: 'Kaffeemuehle', brand: 'Eureka', model: 'Mignon', serial_number: 'ABC123' });
  assert.ok((await call('GET', '/items?q=Eureka')).body.data.some((i) => i.name === 'Kaffeemuehle'));
  assert.ok((await call('GET', '/items?q=ABC123')).body.data.some((i) => i.name === 'Kaffeemuehle'));
  assert.equal((await call('GET', '/items?q=NichtsPasstHier')).body.data.length, 0);
});

test('POST /items: gueltiges photo_data wird uebernommen und zurueckgegeben', async () => {
  const validPhoto = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const r = await call('POST', '/items', { name: 'Item With Photo', photo_data: validPhoto });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.photo_data, validPhoto);
});

test('POST /items: zu grosses photo_data -> 400', async () => {
  const oversized = `data:image/png;base64,${'A'.repeat(7_000_000)}`;
  const r = await call('POST', '/items', { name: 'Item With Oversized Photo', photo_data: oversized });
  assert.equal(r.status, 400);
});

test('POST /items: photo_data ohne gueltigen Bild-MIME-Typ -> 400', async () => {
  const r = await call('POST', '/items', { name: 'Item With Bad Photo', photo_data: 'data:text/plain;base64,aGVsbG8=' });
  assert.equal(r.status, 400);
});

test('PUT /items/:id: photo_data ist volles Replace - weglassen loescht es', async () => {
  const validPhoto = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';
  const created = await call('POST', '/items', { name: 'Item To Update', photo_data: validPhoto });
  const id = created.body.data.id;

  const withoutPhoto = await call('PUT', `/items/${id}`, { name: 'Item To Update' });
  assert.equal(withoutPhoto.status, 200);
  assert.equal(withoutPhoto.body.data.photo_data, null);
});
