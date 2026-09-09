/**
 * Modul: Bereitschaft eines echten Servers in Tests
 * Zweck: Die eine Regel, wie eine Suite an eine Basis-URL kommt, ueber die sie
 *        per fetch mit der App spricht - ohne feste Portnummer und ohne Warten.
 * Abhaengigkeiten: keine
 *
 * WAS DAS HIER SOLL, IST EIN GEMESSENER FEHLER UND KEINE VORSICHTSMASSNAHME.
 *
 * Drei Suiten banden einen festen Port und warteten danach fest ab:
 * test-admin-password-reset.js (13098), test-setup.js (13099) und
 * test-password-normalization.js (13100), jeweils mit
 * `await new Promise((r) => setTimeout(r, 400))`. Das ist kein
 * Bereitschaftssignal, sondern eine Wette - und sie ist nach BEIDEN Seiten
 * falsch:
 *
 *   - Sie wartet auf nichts. Gemessen am 2026-09-09: app.listen() bindet den
 *     Socket SYNCHRON. Direkt nach dem listen()-Aufruf ist `server.listening`
 *     bereits true, und das geschieht 1 ms VOR dem Ende des Modul-Imports.
 *     Wenn `await import('../server/index.js')` zurueckkehrt, nimmt der Port
 *     also laengst Verbindungen an; eine Sonde ohne jedes Warten verband sich
 *     auf Anhieb. Die 400 ms warteten pro Suite auf nichts.
 *
 *   - Sie prueft nichts. Antwortet der Port doch nicht, laeuft der erste
 *     Top-Level-fetch in `[TypeError: fetch failed]`, und der Prozess endet mit
 *     Node-Code 7 ("Internal Exception Handler Run-Time Failure") - mit einem
 *     AggregateError, der nur die abgewiesenen Adressen nennt (`::1:13098`,
 *     `127.0.0.1:13098`), aber nicht, dass niemand lauschte.
 *
 * Beim Lesen solcher Laeufe fuehrt die Zeile "[Yuvomi] Server running on port
 * ..." zusaetzlich in die Irre. Sie steht im Log VOR dem Fehler, auch wenn der
 * Server durchgehend oben war - nachgestellt am 2026-09-09 mit einem laufenden
 * Server auf 13990, abgefragt gegen den toten Port 13991: identisches
 * Fehlerbild, exit=7, Logzeile davor. Sie sagt sogar noch weniger: belegt ein
 * fremder Prozess den Port auf `::`, faellt Node beim Bind still auf 0.0.0.0
 * zurueck und meldet trotzdem "Server running" - der Server lauscht dann nur
 * auf IPv4, waehrend fetch() `localhost` per Happy Eyeballs aufloest und
 * zuerst auf ::1 landet, also beim fremden Prozess. Gemessen mit einem Blocker
 * auf 13998: Logzeile da, Server oben, fetch trotzdem tot.
 *
 * Beides faellt weg, wenn eine Suite gar keine feste Portnummer waehlt.
 * listenOnFreePort() nimmt darum den Weg, den 13 andere Suiten hier bereits
 * gehen (test-idempotency.js, test-invites.js, test-sso-only.js und weitere):
 * einen eigenen Listener auf Port 0 - die Nummer vergibt das Betriebssystem,
 * sie kann also nicht belegt sein - und das `listening`-Ereignis als das, was
 * es ist: das Bereitschaftssignal. Gebunden wird explizit auf 127.0.0.1, und
 * die Basis-URL nennt dieselbe Adresse; damit gibt es fuer fetch() nichts
 * aufzuloesen und keine zweite Adressfamilie, auf die es ausweichen koennte.
 */

/**
 * Startet einen eigenen Listener fuer `app` auf einem freien Port und liefert
 * die Basis-URL zurueck, sobald er wirklich lauscht.
 *
 * @param {import('express').Express} app Die App aus `server/index.js`.
 * @returns {Promise<string>} z.B. 'http://127.0.0.1:52341'
 */
export function listenOnFreePort(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1');
    // Ohne error-Handler wuerde ein fehlgeschlagener Bind als uncaughtException
    // enden - also genau als der nichtssagende Abbruch, den dieser Helfer
    // vermeiden soll.
    server.once('error', reject);
    server.once('listening', () => {
      server.removeListener('error', reject);
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

export default listenOnFreePort;
