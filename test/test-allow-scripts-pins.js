/**
 * Modul: allowScripts-Pins gegen den Lockfile
 * Zweck: `allowScripts` in package.json nennt jedes Paket, das bei der
 *        Installation eigene Skripte ausfuehren darf - mit EXAKTER Version
 *        (`puppeteer@25.9.0`). Das ist Absicht: die Erlaubnis gilt der
 *        geprueften Fassung, nicht dem Namen.
 *
 *        DAS PROBLEM, GEGEN DAS DIESER TEST STEHT: Dependabot hebt die
 *        Abhaengigkeit und den Lockfile an, aber `allowScripts` fasst es nie
 *        an - es kennt das Feld nicht. Nach jedem Bump zeigt der Pin damit auf
 *        eine Version, die gar nicht mehr installiert wird. Das bricht nichts
 *        sichtbar (der Chrome-Download laeuft weiter), und genau deshalb faellt
 *        es niemandem auf: eine Erlaubnis, die ins Leere zeigt, sieht aus wie
 *        eine, die gilt.
 *
 *        Gemessen am 2026-09-01 nach dem Merge von #968: puppeteer stand im
 *        Lock auf 25.9.0 und im Pin auf 25.8.0.
 *
 * Ausfuehren: npm run test:allow-scripts-pins
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf-8'));

/** `puppeteer@25.9.0` -> { name: 'puppeteer', version: '25.9.0' }, auch fuer @scope/name. */
function splitPin(pin) {
  const at = pin.lastIndexOf('@');
  return { name: pin.slice(0, at), version: pin.slice(at + 1) };
}

test('jeder allowScripts-Pin nennt die Version, die auch installiert wird', () => {
  const pins = Object.keys(pkg.allowScripts || {});
  assert.ok(pins.length > 0, 'ohne Pins hat dieser Test nichts zu pruefen');

  const drift = [];
  for (const pin of pins) {
    const { name, version } = splitPin(pin);
    const installed = lock.packages?.[`node_modules/${name}`]?.version;
    if (installed !== version) drift.push(`${name}: Pin ${version}, Lock ${installed ?? 'fehlt'}`);
  }

  assert.deepEqual(drift, [],
    'diese allowScripts-Pins zeigen auf eine Version, die nicht installiert wird. '
    + 'Nach einem Dependabot-Bump ist das der Normalfall - das Feld wird nicht mitgezogen. '
    + `Pin in package.json nachziehen: ${drift.join(' | ')}`);
});

test('jedes gepinnte Paket steht ueberhaupt in den Abhaengigkeiten', () => {
  // Ein Pin auf ein Paket, das es nicht mehr gibt, ist kein Fehler mit Wirkung,
  // aber eine Erlaubnis ohne Empfaenger - und beim Lesen der Liste eine falsche
  // Auskunft darueber, was hier Skripte ausfuehren darf.
  const alle = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const verwaist = Object.keys(pkg.allowScripts || {})
    .map((pin) => splitPin(pin).name)
    .filter((name) => !(name in alle));

  assert.deepEqual(verwaist, [], `allowScripts nennt Pakete, die nicht mehr abhaengig sind: ${verwaist.join(', ')}`);
});
