/**
 * Tests: Live changelog parser/proxy.
 * Ausführen: node --test test/test-changelog.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import changelogRouter, { buildRouter, __test } from '../server/routes/changelog.js';
import { compareVersions, isNewerVersion, displayVersion, releasesNewForMe } from '../public/utils/version.js';

test('parseReleaseBody keeps release sections and removes GitHub noise', () => {
  const sections = __test.parseReleaseBody(`
## Added
- New dashboard changelog modal ([#455](https://github.com/ulsklyc/yuvomi/pull/455))
- Internal commit 9f4a12bc should not leak

## Fixed
- Better widget sizing

Full Changelog: https://github.com/ulsklyc/yuvomi/compare/v1.0.0...v1.1.0
Assets
`);

  // `items` ist unveraendert die eine-Zeile-je-Eintrag-Form: /api/v1 ist eine
  // zugesagte Oberflaeche, `entries` liegt additiv daneben (#496).
  assert.deepEqual(sections.map((s) => ({ title: s.title, items: s.items })), [
    {
      title: 'Added',
      items: [
        'New dashboard changelog modal (#455)',
        'Internal commit should not leak',
      ],
    },
    {
      title: 'Fixed',
      items: ['Better widget sizing'],
    },
  ]);
  // Ohne fettgedruckten Vorspann (alles vor 2.41.0) ist die ganze Zeile der
  // Vorspann - erfunden wird keiner.
  assert.deepEqual(sections[0].entries[0], {
    lead: 'New dashboard changelog modal (#455)', detail: '',
  });
});

test('parseReleaseBody trennt den fettgedruckten Vorspann von der Begruendung', () => {
  // DAS IST DIE LUECKE, UM DIE ES GEHT (#496): seit 2.41.0 oeffnet jeder
  // Eintrag mit einem Vorspann, und ein Guard setzt das durch (#850) - die
  // Ansicht bekam ihn bis hierher aber als Fliesstext, weil die Auszeichnung
  // vorher eingeebnet wurde. Wer scannen will, konnte nicht scannen.
  const sections = __test.parseReleaseBody(`
## Fixed
- **The weather forecast was off by a day** (#851). The server already keeps the
  running day out of \`forecast\` so it is not shown twice.
- **A second change** with its own reason.
`);

  assert.equal(sections.length, 1);
  const [first, second] = sections[0].entries;
  assert.equal(first.lead, 'The weather forecast was off by a day');
  assert.match(first.detail, /^\(#851\)\. The server already keeps/);
  // Die Fortsetzungszeile gehoert zur Begruendung, nicht zum Vorspann.
  assert.match(first.detail, /shown twice\.$/);
  assert.equal(second.lead, 'A second change');
  assert.equal(second.detail, 'with its own reason.');

  // Und `items` bleibt daneben die zusammengesetzte Zeile von frueher.
  assert.match(sections[0].items[0], /^The weather forecast was off by a day \(#851\)\./);
});

test('buildChangelogPayload marks current version when it appears in releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v1.2.2', body: '- Newest release', html_url: 'https://example.test/latest' },
    { tag_name: 'v1.2.1', body: '- Current release', html_url: 'https://example.test/current' },
  ], '1.2.1');

  assert.equal(payload.current_version, '1.2.1');
  assert.equal(payload.latest_version, 'v1.2.2');
  assert.equal(payload.current_in_releases, true);
  assert.equal(payload.releases.length, 2);
});

test('buildChangelogPayload reports current version missing from releases', () => {
  const payload = __test.buildChangelogPayload([
    { tag_name: 'v0.88.1', body: '- Public release notes' },
  ], '1.2.1');

  assert.equal(payload.latest_version, 'v0.88.1');
  assert.equal(payload.current_in_releases, false);
});

test('changelog router fetches and sanitizes GitHub release JSON', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async (url, options) => {
      assert.match(url, /api\.github\.com\/repos\/ulsklyc\/yuvomi\/releases/);
      assert.equal(options.headers.Accept, 'application/vnd.github+json');
      return {
        ok: true,
        json: async () => [
          {
            tag_name: 'v1.2.1',
            body: '## Added\n- Live changelog\n\nFull Changelog: https://example.test',
            html_url: 'https://github.com/ulsklyc/yuvomi/releases/tag/v1.2.1',
          },
        ],
      };
    },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.current_in_releases, true);
    assert.equal(body.data.releases[0].sections[0].items[0], 'Live changelog');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// --------------------------------------------------------
// „Neu in deiner App" - die Auswahl der Releases (#496)
// --------------------------------------------------------

const RELEASES = [
  { version: 'v2.61.0' }, { version: 'v2.60.0' }, { version: 'v2.59.0' },
  { version: 'v2.58.0' }, { version: 'v2.57.0' },
];

test('neu fuer mich sind die Releases zwischen letztem Blick und laufender Version', () => {
  const fresh = releasesNewForMe(RELEASES, '2.60.0', '2.58.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.60.0', 'v2.59.0']);
});

test('was hier noch nicht laeuft, steht nicht in der Liste', () => {
  // DAS ist die Grenze, die diese Ansicht von der Update-Meldung trennt: 2.61
  // ist veroeffentlicht, aber dieser Haushalt laeuft auf 2.60 - bei ihm hat
  // sich davon nichts geaendert.
  const fresh = releasesNewForMe(RELEASES, '2.60.0', '2.58.0');
  assert.equal(fresh.some((r) => r.version === 'v2.61.0'), false);
});

test('ohne frueheren Blick bleibt die Liste leer', () => {
  // Wer zum ersten Mal hinsieht, hat nichts verpasst, das wir wuessten.
  assert.deepEqual(releasesNewForMe(RELEASES, '2.60.0', ''), []);
  assert.deepEqual(releasesNewForMe(RELEASES, '', '2.58.0'), []);
});

test('ist der letzte Blick der laufende Stand, gibt es nichts zu zeigen', () => {
  assert.deepEqual(releasesNewForMe(RELEASES, '2.60.0', '2.60.0'), []);
});

test('das v-Praefix der GitHub-Tags stoert die Auswahl nicht', () => {
  const fresh = releasesNewForMe(RELEASES, 'v2.59.0', 'v2.57.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.59.0', 'v2.58.0']);
});

test('Releases ohne Version fallen heraus, statt die Liste zu vergiften', () => {
  const fresh = releasesNewForMe([{ version: '' }, { version: 'v2.59.0' }, {}], '2.60.0', '2.58.0');
  assert.deepEqual(fresh.map((r) => r.version), ['v2.59.0']);
});

test('default changelog router is an express router', () => {
  assert.equal(typeof changelogRouter, 'function');
});

// --------------------------------------------------------
// Rueckfall auf die mitgelieferte CHANGELOG.md (#838)
// --------------------------------------------------------

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

- Etwas, das noch nicht ausgeliefert ist

## [1.2.1] - 2026-01-02

### Fixed

- Ein Fehler weniger

## [1.2.0] - 2026-01-01

### Added

- Ein Modul mehr
`;

test('parseChangelogFile schneidet Versionsbloecke und laesst Unreleased weg', () => {
  const releases = __test.parseChangelogFile(SAMPLE_CHANGELOG);

  assert.deepEqual(releases.map((r) => r.version), ['1.2.1', '1.2.0']);
  assert.equal(releases[0].sections[0].title, 'Fixed');
  assert.equal(releases[0].sections[0].items[0], 'Ein Fehler weniger');
  // Der Eintrag unter [Unreleased] darf in keinem Block landen - er gehoert
  // keiner Version und beschreibt nichts, was der laufende Stand kann.
  const alleItems = releases.flatMap((r) => r.sections.flatMap((s) => s.items));
  assert.equal(alleItems.some((i) => i.includes('noch nicht ausgeliefert')), false);
});

test('buildLocalPayload meldet keine neueste Version', () => {
  const payload = __test.buildLocalPayload(() => SAMPLE_CHANGELOG, '1.2.1');

  assert.equal(payload.source, 'local');
  assert.equal(payload.current_in_releases, true);
  // Die Datei reicht nur bis zur eigenen Version. "Die neueste ist meine"
  // waere eine Zusicherung, die hier niemand pruefen konnte.
  assert.equal(payload.latest_version, null);
});

test('die mitgelieferte CHANGELOG.md laesst sich lesen und parsen', () => {
  const releases = __test.parseChangelogFile(readFileSync(__test.CHANGELOG_PATH, 'utf8'));

  // Reichweiten-Nachweis: ein Parser, dessen Muster nicht mehr auf das echte
  // Format passt, liefert sonst still eine leere Liste und der Rueckfall
  // faellt auf nichts zurueck.
  assert.ok(releases.length >= 10, `zu wenige Versionen geparst (${releases.length})`);
  assert.ok(releases.every((r) => /^\d+\.\d+\.\d+$/.test(r.version)),
    'ein Block traegt keine Versionsnummer');
  assert.ok(releases.every((r) => r.sections.length > 0),
    'ein Block hat keine Abschnitte');
});

test('faellt GitHub aus, kommt die mitgelieferte Datei statt 502', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async () => { throw new Error('getaddrinfo ENOTFOUND api.github.com'); },
    readChangelogFile: () => SAMPLE_CHANGELOG,
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.source, 'local');
    assert.equal(body.data.releases[0].version, '1.2.1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ohne mitgelieferte Datei bleibt es beim 502', async () => {
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => 1000,
    fetchFn: async () => { throw new Error('offline'); },
    readChangelogFile: () => { throw new Error('ENOENT'); },
  }));

  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(res.status, 502);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('nach einem Fehlschlag wird GitHub eine Weile nicht erneut gefragt', async () => {
  let versuche = 0;
  let jetzt = 1000;
  const app = express();
  app.use(buildRouter({
    appVersion: '1.2.1',
    now: () => jetzt,
    fetchFn: async () => { versuche++; throw new Error('offline'); },
    readChangelogFile: () => SAMPLE_CHANGELOG,
  }));

  const server = app.listen(0);
  const hole = async () => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
    return res.json();
  };
  try {
    await hole();
    assert.equal(versuche, 1);

    // Ohne Sperre liefe jede weitere Anfrage wieder hinaus - bei sechzig
    // unauthentifizierten Anfragen je Stunde und IP haelt das den Fehler
    // aufrecht, statt ihn abzuwarten.
    jetzt += 60 * 1000;
    const zweite = await hole();
    assert.equal(versuche, 1);
    assert.equal(zweite.data.source, 'local');

    // Nach Ablauf der Sperre wird es wieder versucht.
    jetzt += 5 * 60 * 1000;
    await hole();
    assert.equal(versuche, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('.dockerignore laesst CHANGELOG.md ins Image', () => {
  // Der Rueckfall lebt von der Datei IM IMAGE. `*.md` schliesst sie aus, die
  // Ausnahme holt sie zurueck - faellt die Ausnahme weg, bleibt der Rueckfall
  // still wirkungslos, und zwar nur im Container, nie beim Entwickeln.
  const raw = readFileSync(new URL('../.dockerignore', import.meta.url), 'utf8');
  const regeln = raw.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  // Docker wertet die Muster in Reihenfolge aus, der LETZTE Treffer gewinnt.
  let ausgeschlossen = false;
  for (const regel of regeln) {
    const negiert = regel.startsWith('!');
    const muster = negiert ? regel.slice(1) : regel;
    if (muster === 'CHANGELOG.md' || muster === '*.md') ausgeschlossen = !negiert;
  }

  assert.equal(ausgeschlossen, false,
    '.dockerignore schliesst CHANGELOG.md aus - der Rueckfall aus #838 waere im Image tot');
});

// --------------------------------------------------------
// Update-Hinweis (#490): der Vergleich hinter dem Punkt an der Navigation
// --------------------------------------------------------

test('isNewerVersion compares numeric segments, not strings', () => {
  // Der String-Vergleich, den diese Funktion ersetzt, hielte '1.9.0' für neuer.
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true);
  assert.equal(isNewerVersion('1.9.0', '1.10.0'), false);
  assert.equal(isNewerVersion('2.0.0', '1.99.99'), true);
});

test('isNewerVersion tolerates the v prefix of GitHub tags', () => {
  assert.equal(isNewerVersion('v1.84.0', '1.83.0'), true);
  assert.equal(isNewerVersion('v1.83.0', '1.83.0'), false);
  assert.equal(isNewerVersion('1.83.0', 'v1.83.0'), false);
});

test('isNewerVersion treats missing segments as zero', () => {
  assert.equal(compareVersions('1.84', '1.84.0'), 0);
  assert.equal(isNewerVersion('1.84.1', '1.84'), true);
});

test('isNewerVersion ranks a prerelease below its final release', () => {
  assert.equal(isNewerVersion('1.84.0-rc.1', '1.84.0'), false);
  assert.equal(isNewerVersion('1.84.0', '1.84.0-rc.1'), true);
  assert.equal(isNewerVersion('1.84.0-rc.2', '1.84.0-rc.1'), true);
});

test('displayVersion drops the tag prefix so the label reads once', () => {
  // "Version {{version}} ist verfügbar" mit einem GitHub-Tag ergäbe sonst
  // "Version v1.84.0".
  assert.equal(displayVersion('v1.84.0'), '1.84.0');
  assert.equal(displayVersion('1.84.0'), '1.84.0');
  assert.equal(displayVersion('  V1.84.0  '), '1.84.0');
  assert.equal(displayVersion(null), '');
});

test('unreadable versions never trigger the hint', () => {
  // Ein falscher Punkt an der Navigation wäre schlimmer als ein fehlender:
  // alles Unlesbare gilt als "unbekannt", nicht als "neuer".
  assert.equal(compareVersions('latest', '1.83.0'), null);
  assert.equal(isNewerVersion('latest', '1.83.0'), false);
  assert.equal(isNewerVersion('1.84.0', ''), false);
  assert.equal(isNewerVersion('', '1.83.0'), false);
  assert.equal(isNewerVersion(null, undefined), false);
});

/* JEDER EINTRAG NENNT SICH IN SEINER ERSTEN ZEILE (#850).
 *
 * Die Prosa unter einem Eintrag ist der Wert dieses Changelogs - sie sagt, WARUM
 * etwas so entschieden wurde, und das steht sonst nirgends. Aber wer nach einem
 * Update wissen will, was sich geaendert hat, will nicht drei Absaetze lesen, um
 * das herauszufinden. mariojg-dev hat das gemeldet, und er hat recht: bei
 * mehreren Releases pro Woche ist die Datei nicht mehr zu ueberfliegen.
 *
 * Die Regel loest beides, ohne der Erzaehlung etwas wegzunehmen: der Eintrag
 * BEGINNT mit einem fettgedruckten Satz, der die Aenderung benennt. Wer scannt,
 * liest die erste Zeile; wer das Warum will, liest weiter.
 *
 * ES IST FAST SCHON DIE PRAXIS: in den letzten sechs Releases trugen 23 von 28
 * Eintraegen bereits einen solchen Vorspann. Was fehlte, war die Regel - und
 * damit die Verlaesslichkeit, auf die sich ein Leser einstellen kann.
 *
 * DIE GRENZE HAT EINEN ANFANG UND KEIN ENDE, und das ist Absicht. Rueckwaerts
 * gilt sie nicht: 1740 der 2551 Eintraege stehen ohne Vorspann da, und ein
 * veroeffentlichter Changelog wird nicht umgeschrieben. Vorwaerts gilt sie
 * unbefristet, denn sie ist keine Ausnahme, sondern das Format. */
const TLDR_SINCE = '2.41.0';

test(`jeder Eintrag ab ${TLDR_SINCE} beginnt mit einem fettgedruckten Vorspann`, () => {
  const text = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  // Blockweise trennen: '## [x.y.z] - datum' bzw. '## [Unreleased]'.
  const blocks = text.split(/^## \[/m).slice(1);

  const offenders = [];
  let checked = 0;
  for (const block of blocks) {
    const version = block.slice(0, block.indexOf(']'));
    const isUnreleased = version.toLowerCase() === 'unreleased';
    if (!isUnreleased && compareVersions(version, TLDR_SINCE) < 0) continue;

    for (const m of block.matchAll(/^- (.*)$/gm)) {
      checked += 1;
      if (!/^\*\*[^*]/.test(m[1])) {
        offenders.push(`[${version}] - ${m[1].slice(0, 70)}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'ein Eintrag ohne fettgedruckten Vorspann - die erste Zeile muss die Aenderung benennen (#850)');
  // Ohne diese Zeile waere der Guard gruen, sobald die Blocktrennung bricht.
  void checked;
});

test('der Vorspann-Guard erkennt einen Eintrag ohne Vorspann', () => {
  // Gegenprobe auf das Muster selbst - der Guard oben ist erst dann gruen, wenn
  // wirklich nichts fehlt, und nicht schon, wenn er nichts findet.
  const hasTldr = (line) => /^\*\*[^*]/.test(line);
  assert.ok(hasTldr('**Weather forecast was off by a day** (#851). Der Server ...'));
  assert.equal(hasTldr('The two password-reset pages now say why ...'), false);
  assert.equal(hasTldr('Updated the dependencies: `googleapis` to 176'), false);
  // Eine leere Fettung ist keine Benennung.
  assert.equal(hasTldr('****'), false);
});

test('jeder getaggte Release hat einen CHANGELOG-Eintrag, keine Version doppelt', (t) => {
  // F-033-Guard: beim Docs-Audit 2026-08-05 fehlten 13 getaggten Releases die
  // Einträge - bei spaeteren Release-Läufen still verloren gegangen. Der Guard
  // beißt beim lokalen release-prep (voller Clone); in CI ohne Tags
  // (checkout mit depth 1, ohne fetch-tags) skippt er sichtbar statt leer zu
  // bestehen. Die Gegenrichtung (Eintrag ohne Tag) bleibt bewusst ungeprüft:
  // [0.71.9]/[0.76.0] sind dokumentierte Altfälle, und beim Release liegt der
  // neue Eintrag naturgemäß vor dem Tag.
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  let tags;
  try {
    tags = execSync('git tag', { cwd: repoRoot, encoding: 'utf8' })
      .split('\n')
      .filter((l) => /^v\d+\.\d+\.\d+$/.test(l))
      .map((l) => l.slice(1));
  } catch {
    return t.skip('git nicht verfügbar');
  }
  if (tags.length === 0) return t.skip('keine Tags im Checkout (shallow clone)');

  const md = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8');
  const headings = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  const headingSet = new Set(headings);

  const missing = tags.filter((v) => !headingSet.has(v));
  assert.deepEqual(missing, [],
    `Getaggte Releases ohne CHANGELOG-Eintrag: ${missing.join(', ')}`);

  const dupes = [...new Set(headings.filter((v, i) => headings.indexOf(v) !== i))];
  assert.deepEqual(dupes, [],
    `Versionen mit doppeltem CHANGELOG-Heading: ${dupes.join(', ')}`);
});
