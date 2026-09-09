/**
 * Unicode-Normalisierung von Passwörtern (Issue #608).
 *
 * Firefox/macOS liefert Passwort-Eingaben in NFD (zerlegt), Safari/iOS in NFC
 * (komponiert). bcrypt arbeitet auf Bytes - dadurch schlug der Login mit
 * Umlauten je nach Browser fehl. Gehasht wird nun immer NFC; `verifyPassword`
 * akzeptiert zusätzlich Alt-Hashes aus nicht-normalisierten Eingaben und meldet
 * sie über `needsRehash` zur stillen Migration.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import bcrypt from 'bcrypt';
import { listenOnFreePort } from './server-ready.js';

import { hashPassword, normalizePassword, verifyPassword } from '../server/utils/password.js';

// „Bärenstark1" in beiden Normalformen - gleiche Zeichen, andere Bytes.
const NFC = 'Bärenstark1'.normalize('NFC');
const NFD = 'Bärenstark1'.normalize('NFD');
assert.notEqual(NFC, NFD, 'Testdaten müssen sich in der Byte-Form unterscheiden');

// --------------------------------------------------------
// Unit: server/utils/password.js
// --------------------------------------------------------

test('normalizePassword liefert NFC für beide Eingabeformen', () => {
  assert.equal(normalizePassword(NFD), NFC);
  assert.equal(normalizePassword(NFC), NFC);
  assert.equal(normalizePassword(undefined), '');
});

test('hashPassword hasht immer die NFC-Form', async () => {
  const hash = await hashPassword(NFD);
  assert.equal(await bcrypt.compare(NFC, hash), true);
  assert.equal(await bcrypt.compare(NFD, hash), false);
});

test('verifyPassword akzeptiert beide Normalformen gegen einen NFC-Hash', async () => {
  const hash = await hashPassword(NFC);
  assert.deepEqual(await verifyPassword(NFC, hash), { valid: true, needsRehash: false });
  assert.deepEqual(await verifyPassword(NFD, hash), { valid: true, needsRehash: false });
});

test('verifyPassword akzeptiert Legacy-Hashes aus NFD-Eingaben und meldet needsRehash', async () => {
  // So sah ein vor dem Fix in Firefox gesetztes Passwort in der DB aus.
  const legacyHash = await bcrypt.hash(NFD, 12);
  assert.deepEqual(await verifyPassword(NFD, legacyHash), { valid: true, needsRehash: true });
  assert.deepEqual(await verifyPassword(NFC, legacyHash), { valid: true, needsRehash: true });
});

test('verifyPassword lehnt falsche Passwörter ab', async () => {
  const hash = await hashPassword(NFC);
  assert.deepEqual(await verifyPassword('Bärenschwach1', hash), { valid: false, needsRehash: false });
  assert.deepEqual(await verifyPassword('', hash), { valid: false, needsRehash: false });
});

test('verifyPassword scheitert an einem Nicht-bcrypt-Hash statt zu werfen', async () => {
  // OIDC-Konten tragen den Platzhalter '$oidc$' als password_hash.
  assert.deepEqual(await verifyPassword(NFC, '$oidc$'), { valid: false, needsRehash: false });
});

// --------------------------------------------------------
// Integration: Login-, Setup- und Change-Password-Routen
// --------------------------------------------------------

const tmpDir = mkdtempSync(join(tmpdir(), 'yuvomi-password-nfc-test-'));

process.env.SESSION_SECRET = 'test-password-nfc-secret-minimum-32ch';
process.env.DB_PATH = join(tmpDir, 'test.db');
process.env.SESSION_SECURE = 'false';
// Der Test spricht ueber listenOnFreePort() mit einem eigenen Listener. PORT gilt
// nur noch dem Listener, den server/index.js beim Import selbst startet: ohne
// die Zuweisung waere das 3000, wo lokal gern schon ein Dev-Server sitzt.
process.env.PORT = '13100';
// Der Login-Limiter zählt Fehlversuche; die Suite prüft mehrere davon bewusst.
process.env.RATE_LIMIT_MAX_ATTEMPTS = '100';

const { default: app } = await import('../server/index.js');
const db = await import('../server/db.js');
const BASE = await listenOnFreePort(app);

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  // Verzögert beenden: der Server hält Scheduler-Timer offen, ein sofortiges
  // process.exit() würde die Meldung des letzten Tests abschneiden.
  setTimeout(() => process.exit(0), 50);
});

function cookieHeader(setCookie) {
  return String(setCookie || '')
    .split(/,(?=\s*[^;,]+=)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function login(username, password) {
  const res = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const cookie = cookieHeader(res.headers.get('set-cookie'));
  if (res.status !== 200) return { status: res.status, cookie: null, csrfToken: null };
  const meRes = await fetch(`${BASE}/api/v1/auth/me`, { headers: { Cookie: cookie } });
  const me = await meRes.json();
  return { status: res.status, cookie, csrfToken: me.csrfToken };
}

function passwordHashOf(username) {
  return db.get().prepare('SELECT password_hash FROM users WHERE username = ?').get(username).password_hash;
}

// Admin mit Umlaut-Passwort anlegen (Setup schickt die NFC-Form, wie Safari).
const setupRes = await fetch(`${BASE}/api/v1/auth/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', display_name: 'Admin', password: NFC }),
});
assert.equal(setupRes.status, 201);

test('POST /auth/login: NFD-Eingabe (Firefox) passt auf ein NFC-gesetztes Passwort', async () => {
  const nfd = await login('admin', NFD);
  assert.equal(nfd.status, 200);

  const nfc = await login('admin', NFC);
  assert.equal(nfc.status, 200);
});

test('POST /auth/login: falsches Passwort bleibt 401', async () => {
  const res = await login('admin', 'Bärenschwach1');
  assert.equal(res.status, 401);
});

test('POST /auth/login: Legacy-Hash aus NFD-Eingabe wird still auf NFC migriert', async () => {
  // Zustand vor dem Fix simulieren: Passwort in Firefox gesetzt -> NFD-Hash.
  const legacyHash = await bcrypt.hash(NFD, 12);
  db.get().prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(legacyHash, 'admin');

  // Safari (NFC) kam vorher nicht rein - jetzt schon.
  const nfc = await login('admin', NFC);
  assert.equal(nfc.status, 200);

  const migrated = passwordHashOf('admin');
  assert.notEqual(migrated, legacyHash, 'Hash muss neu geschrieben worden sein');
  assert.equal(await bcrypt.compare(NFC, migrated), true);
  assert.equal(await bcrypt.compare(NFD, migrated), false);

  // Nach der Migration funktionieren weiterhin beide Eingabeformen.
  assert.equal((await login('admin', NFD)).status, 200);
  assert.equal((await login('admin', NFC)).status, 200);
});

test('PATCH /auth/me/password: Mindestlänge zählt Codepoints der NFC-Form', async () => {
  const session = await login('admin', NFC);
  assert.equal(session.status, 200);

  // 'Bär1234' hat 7 Zeichen in NFC, aber 8 in NFD - die NFD-Form darf die
  // Mindestlänge nicht unterlaufen dürfen.
  const tooShort = 'Bär1234'.normalize('NFD');
  assert.equal(tooShort.length, 8);
  assert.equal(tooShort.normalize('NFC').length, 7);

  const res = await fetch(`${BASE}/api/v1/auth/me/password`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
    },
    body: JSON.stringify({ current_password: NFC, new_password: tooShort }),
  });
  assert.equal(res.status, 400);
});

test('PATCH /auth/me/password: current_password wird normalisiert, neues Passwort NFC gehasht', async () => {
  const session = await login('admin', NFC);
  assert.equal(session.status, 200);

  const NEW_NFC = 'Grüßgott42'.normalize('NFC');
  const NEW_NFD = 'Grüßgott42'.normalize('NFD');

  const res = await fetch(`${BASE}/api/v1/auth/me/password`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Cookie: session.cookie,
      'X-CSRF-Token': session.csrfToken,
    },
    // Firefox würde current_password als NFD senden.
    body: JSON.stringify({ current_password: NFD, new_password: NEW_NFD }),
  });
  assert.equal(res.status, 200);

  const stored = passwordHashOf('admin');
  assert.equal(await bcrypt.compare(NEW_NFC, stored), true);
  assert.equal(await bcrypt.compare(NEW_NFD, stored), false);

  assert.equal((await login('admin', NEW_NFC)).status, 200);
  assert.equal((await login('admin', NEW_NFD)).status, 200);
});
