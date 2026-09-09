/**
 * Fixture fuer test/test-suite-exit-code.js - eine Suite in genau der Bauart,
 * um die es geht: sie startet `server/index.js` ueber `test/server-ready.js`
 * als echtes Programm und prueft in einem `test()`-Block eine Antwort.
 *
 * Sie traegt bewusst KEIN `test-`-Praefix: sie soll nicht als eigene Suite in
 * der npm-Kette landen, sondern nur von aussen als Kindprozess gefahren
 * werden - zweimal, mit erwartetem Erfolg und mit erwartetem Fehlschlag.
 *
 * `FIXTURE_EXPECT_STATUS` dreht die Assertion um. Ein zweites, absichtlich
 * rotes Abbild der Datei waere die Alternative gewesen - und die zweite
 * Buchfuehrung, die beim naechsten Umbau auseinanderlaeuft.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { startTestServer } from './server-ready.js';

const { baseUrl } = await startTestServer({
  name: 'exit-code-fixture',
  env: { SESSION_SECRET: 'exit-code-fixture-secret-minimum-32c' },
});

// Ohne Sitzung antwortet /auth/me mit 401 - eine Zusicherung, die keine
// Vorbereitung braucht und trotzdem beweist, dass der Server wirklich laeuft.
const expected = Number(process.env.FIXTURE_EXPECT_STATUS || 401);

test('die Fixture erreicht den laufenden Server', async () => {
  const res = await fetch(`${baseUrl}/api/v1/auth/me`);
  assert.equal(res.status, expected);
});
