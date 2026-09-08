/**
 * Modul: Seiten-Lebenszyklus (#976, #977)
 * Zweck: createPageController() bindet zwei Achsen an einen Controller - das
 *        Router-Signal (Seite verlassen) und den eigenen Neuaufbau einer Seite.
 *        Reine Logik, ohne DOM: genau das Stueck, an dem vorher beides fehlte.
 *        Der Router-Vertrag selbst (Signal je Seitenaufbau, Abbruch beim
 *        Routenwechsel) und die Verdrahtung im Dashboard sind browser-gekoppelt
 *        und stehen als Guards in test-frontend-audit.js.
 * Ausfuehren: node --test test/test-page-lifecycle.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageController } from '../public/utils/page-lifecycle.js';

test('ohne Router-Signal entsteht ein gewoehnlicher, lebender Controller', () => {
  const controller = createPageController();
  assert.equal(controller.signal.aborted, false);
  controller.abort();
  assert.equal(controller.signal.aborted, true);
});

test('das Router-Signal reisst den Seiten-Controller mit (#976: Seite verlassen)', () => {
  const route = new AbortController();
  const page = createPageController(route.signal);
  let timerCleared = false;
  page.signal.addEventListener('abort', () => { timerCleared = true; });

  assert.equal(page.signal.aborted, false, 'vor dem Verlassen lebt der Aufbau');
  route.abort();
  assert.equal(page.signal.aborted, true, 'der Router bricht ab - der Seiten-Controller faellt mit');
  assert.equal(timerCleared, true, 'ein an den Controller gehaengter Timer-Abbau laeuft');
});

test('ein schon abgebrochenes Router-Signal liefert einen abgebrochenen Controller (#977: verspaeteter Neuaufbau)', () => {
  const route = new AbortController();
  route.abort();
  const page = createPageController(route.signal);
  assert.equal(page.signal.aborted, true,
    'wer nach dem Verlassen noch einmal render() ruft, bekommt "aborted" und zeichnet nichts');
});

test('der eigene Abbruch eines Aufbaus laesst das Router-Signal stehen und nimmt seinen Listener mit', () => {
  const route = new AbortController();
  const first = createPageController(route.signal);
  first.abort(); // naechster eigener Aufbau derselben Seite
  assert.equal(route.signal.aborted, false, 'die Route bleibt - nur der Aufbau ist ueberholt');

  const second = createPageController(route.signal);
  assert.equal(second.signal.aborted, false, 'der zweite Aufbau lebt unabhaengig vom ersten');

  // Gegenrichtung der Bruecke: der Router bricht ab, NUR der lebende Aufbau
  // reagiert noch - der erste hat seinen Listener beim eigenen Abbruch abgegeben.
  let firstFiredAgain = 0;
  first.signal.addEventListener('abort', () => { firstFiredAgain += 1; });
  route.abort();
  assert.equal(second.signal.aborted, true);
  assert.equal(firstFiredAgain, 0, 'ein bereits abgebrochener Controller feuert nicht ein zweites Mal');
});

test('viele Neuaufbauten hinterlassen keine toten Listener am Router-Signal', () => {
  // Ein toter Listener ist von aussen nicht zu sehen: ein abgebrochener
  // Controller laesst sich nicht ein zweites Mal abbrechen. Was sich messen
  // laesst, ist die Registrierung selbst - die Bruecke muss mit `once` und dem
  // EIGENEN Signal ans Router-Signal gehen, sonst sammelt das Router-Signal je
  // Neuaufbau einen Listener auf einen laengst toten Controller.
  const route = new AbortController();
  const registrations = [];
  const original = route.signal.addEventListener.bind(route.signal);
  route.signal.addEventListener = (type, listener, options) => {
    registrations.push({ type, options });
    return original(type, listener, options);
  };
  const first = createPageController(route.signal);
  assert.equal(registrations.length, 1, 'genau eine Registrierung je Aufbau');
  assert.equal(registrations[0].type, 'abort');
  assert.equal(registrations[0].options?.once, true, 'once: ein Router-Signal bricht nur einmal ab');
  assert.equal(registrations[0].options?.signal, first.signal,
    'der Listener geht mit dem Seiten-Controller, nicht erst mit der Route');

  // Und das Verhalten dazu: nach 25 Neuaufbauten reagiert auf das Verlassen
  // genau der letzte. Die eigenen Abbrueche der Schleife feuern ebenfalls ein
  // abort-Ereignis und werden vor der Messung verworfen.
  const seen = [];
  let last = first;
  for (let i = 0; i < 25; i += 1) {
    last.abort();
    last = createPageController(route.signal);
    const index = i;
    last.signal.addEventListener('abort', () => seen.push(index));
  }
  seen.length = 0;
  route.abort();
  assert.deepEqual(seen, [24], 'genau der letzte Aufbau reagiert auf das Verlassen der Seite');
  assert.equal(registrations.length, 26, 'je Aufbau eine Registrierung, keine zweite fuer einen toten');
});
