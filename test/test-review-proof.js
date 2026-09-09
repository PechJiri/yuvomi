/**
 * Modul: Review-Nachweis
 * Zweck: haelt fest, dass ein gruener `claude-review`-Haken den AKTUELLEN Stand
 *        meint. Der alte Nachweis zaehlte ueber die ganze Lebensdauer des PR und
 *        war gruen, sobald irgendein claude-Kommentar existierte - und weil das
 *        Plugin genau dann abbricht, wenn schon einer existiert, faerbte
 *        derselbe Kommentar jeden weiteren Abbruch gruen. Beide Seiten der Zange
 *        hingen am selben Nagel.
 * Gegenprobe: die Nutzdaten unten sind ECHT (PR #1066 und #1029, 09.09.2026),
 *        nicht auf null gezwungen. Die entscheidende Probe ist das Paar
 *        "derselbe PR, zwei Laeufe": der Lauf, der wirklich geprueft hat, wird
 *        gruen, der Abbruch danach rot - und im roten Fall stehen die alten
 *        claude-Kommentare weiter in der Liste, so wie sie es damals taten.
 *        Jede Probe sieht nur, was ihr Lauf damals sehen konnte; die ganze
 *        PR-Geschichte auf einmal waere eine Lage, die es nie gab.
 * Ausfuehren: npm run test:review-proof
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { beurteile, zaehleSeit } from '../.github/scripts/review-verdict.mjs';

const fixture = JSON.parse(
  readFileSync(new URL('./review-proof-fixture.json', import.meta.url), 'utf8')
);

/** Alle drei Stroeme, so wie der Workflow sie hintereinander in das Urteil kippt. */
const alleAeusserungen = [
  ...fixture.aeusserungen.zusammenfassungen,
  ...fixture.aeusserungen.reviews,
  ...fixture.aeusserungen.inline
];

/**
 * Was ein Lauf wirklich gesehen hat.
 *
 * Der Nachweis laeuft unmittelbar nach seiner Review, also bevor der naechste
 * Push existiert. Wuerde eine Probe ihm die ganze PR-Geschichte auf einmal
 * vorlegen, pruefte sie eine Lage, die es nie gab - und ausgerechnet in die
 * Richtung, die gruen macht.
 */
const wieGesehen = (lauf) =>
  alleAeusserungen.filter((a) => a.zeit !== '' && a.zeit <= fixture.laeufe[lauf].ende);

const ECHTE_REVIEW = '34315259346';
const ABBRUCH_LAUF = '34320151190';
const seit = (lauf) => fixture.laeufe[lauf].beginn;
const kopf = (lauf) => fixture.laeufe[lauf].head;
const ABBRUCH = fixture.ergebnisse['abbruch-schon-kommentiert'];

test('DER FALL AUS #1066: alter Kommentar plus neuer Push wird rot', () => {
  // Der Ablauf, wie er wirklich war: claude sprach dreimal (05:41:30Z,
  // 05:57:53Z, 06:04:45Z), danach kam Push 8a87a5cd. Der Lauf dazu dauerte
  // 1m18s und hinterliess nichts - der Haken stand trotzdem gruen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm', 'dieser Stand ist ungeprueft und muss rot sein');
  assert.equal(urteil.grund, 'schon-kommentiert');
  assert.match(urteil.meldung, /UNGEPRUEFT/);
});

test('und genau diese Lage haette der alte Nachweis gruen genannt', () => {
  // Die halbe Gegenprobe waere, den Zaehler auf null zu zwingen. Das hier ist
  // die ganze: an DENSELBEN Daten war die alte Regel ("irgendwo am PR steht ein
  // claude-Kommentar") erfuellt - dreifach sogar.
  const gesehen = wieGesehen(ABBRUCH_LAUF);
  const ueberDieGanzeLebensdauer = gesehen.filter((a) =>
    a.login.toLowerCase().includes('claude')
  ).length;
  // Fuenf Zeilen aus drei Gelegenheiten: eine Review steht sowohl in der
  // Review- als auch in der Inline-Liste. Genau diese Zeilen hat der alte
  // Nachweis addiert, und schon eine haette ihm gereicht.
  assert.equal(
    ueberDieGanzeLebensdauer,
    5,
    'ohne alte claude-Zeilen stellt diese Probe den Fehlerfall gar nicht nach'
  );
  assert.equal(zaehleSeit(gesehen, seit(ABBRUCH_LAUF), kopf(ABBRUCH_LAUF)).gesamt, 0);
});

test('derselbe PR, der Lauf, der wirklich geprueft hat: gruen', () => {
  // Dasselbe Fixture, ein Lauf frueher: 9m41s auf b1ce599e, Befund um 05:41:30Z
  // gepostet. Ohne diese Probe waere der neue Nachweis nur ein anderer blinder
  // Fleck - einer, der immer rot ist.
  const urteil = beurteile({
    seit: seit(ECHTE_REVIEW),
    kopf: kopf(ECHTE_REVIEW),
    ergebnis: fixture.ergebnisse['echte-review'],
    aeusserungen: wieGesehen(ECHTE_REVIEW)
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'gebunden', 'Review und Inline nennen genau diesen Commit');
  // Zwei und nicht eine: derselbe Befund steht in beiden Listen, einmal als
  // Review und einmal als ihre Inline-Anmerkung. Der Nachweis zaehlt
  // Aeusserungen und keine Befunde - fuer die Frage "hat sie gesprochen?"
  // reicht das, und die Zahl in der Log-Zeile ist keine Befundzahl.
  assert.equal(urteil.neu, 2, 'Review und Inline-Anmerkung von 05:41:30Z');
});

test('fremde Stimmen zaehlen nicht, auch wenn sie fleissig sind', () => {
  // An #1066 hat codex JEDEN Push kommentiert - waehrend claude schwieg. Ein
  // Nachweis, der nur "es steht etwas Neues am PR" prueft, waere dadurch die
  // ganze Zeit gruen gewesen.
  const waehrendDesLaufs = alleAeusserungen.filter(
    (a) => a.zeit > seit(ABBRUCH_LAUF) && a.zeit <= '2026-09-09T06:55:00Z'
  );
  assert.ok(waehrendDesLaufs.length > 0, 'nach diesem Push wurde sehr wohl geredet');
  assert.ok(
    waehrendDesLaufs.some((a) => a.login.includes('codex')),
    'und zwar unter anderem von codex'
  );
  assert.equal(zaehleSeit(waehrendDesLaufs, seit(ABBRUCH_LAUF), kopf(ABBRUCH_LAUF)).gesamt, 0);
});

test('der triviale Abbruch bleibt gruen, sagt aber, dass er nichts geprueft hat', () => {
  // #1029: zwei Zeilen `{ timeout: 5000 }`. Das Plugin steigt zugesichert aus,
  // und rot waere hier ein Fehlalarm. Der Unterschied zum Fall oben steht nur
  // im result-Text, sonst ist alles gleich: 4 Turns, keine Verweigerungen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['abbruch-trivial'],
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'ausgesetzt');
  assert.equal(urteil.grund, 'trivial');
  assert.match(urteil.meldung, /nicht "geprueft"/);
});

test('nennt ein Text beides, gilt die gefaehrlichere Lesart', () => {
  // Modellprosa ist kein Protokoll. Sagt sie "trivial" UND "schon kommentiert",
  // darf nicht die Lesart gewinnen, die gruen macht.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 3,
      subtype: 'success',
      is_error: false,
      permission_denials: [],
      result:
        'Claude has already commented on this PR, and the new commit is a ' +
        'trivial change that is obviously correct, so this matches the step 1 ' +
        'stop condition. Stopping here.'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('"has not previously commented" ist kein Abbruch aus diesem Grund', () => {
  // Der echte #1029-Text enthaelt genau diesen Satz. Ein zu gieriges Muster
  // haette den trivialen Fall in den gefaehrlichen umgedeutet.
  assert.match(fixture.ergebnisse['abbruch-trivial'].result, /has not previously commented/);
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['abbruch-trivial'],
      aeusserungen: wieGesehen(ABBRUCH_LAUF)
    }).grund,
    'trivial'
  );
});

test('ohne Stand wird rot, nicht gruen', () => {
  // Der leere Fallback waere hier der gefaehrlichste: ein leerer Vergleichswert
  // laesst JEDE Aeusserung als "neu" durchgehen.
  for (const kaputt of ['', undefined, '2026-09-09', '2026-09-09T06:40:30+00:00']) {
    const urteil = beurteile({ seit: kaputt, ergebnis: ABBRUCH, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
    assert.equal(urteil.ausgang, 'stumm', `Stand ${JSON.stringify(kaputt)} muss rot werden`);
    assert.equal(urteil.grund, 'kein-stand');
  }
});

test('ein unlesbares result-Objekt wird rot und nennt seinen eigenen Grund', () => {
  const urteil = beurteile({ seit: seit(ABBRUCH_LAUF), ergebnis: null, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'kein-ergebnis');
});

test('unlesbare Kommentar-Zeilen werden nicht als Schweigen gelesen', () => {
  // Sonst waere der Haken rot aus dem falschen Grund - und die naechste Runde
  // suchte den Fehler im Prompt statt in der Datenbeschaffung.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: wieGesehen(ABBRUCH_LAUF),
    kaputt: 1
  });
  assert.equal(urteil.grund, 'daten-kaputt');
});

test('die bekannten Fehlschlaege behalten ihre eigene Diagnose', () => {
  const faelle = [
    [{ permission_denials: [{ tool_name: 'Bash' }], result: 'ready to post' }, 'werkzeugsperre'],
    [
      { permission_denials: [], result: "I'll wait for both background agents to complete." },
      'agenten'
    ],
    [{ permission_denials: [], result: 'Done.' }, 'unbekannt'],
    [{ permission_denials: [], is_error: true, result: 'boom' }, 'lauf-fehler'],
    [{ permission_denials: [], subtype: 'error_max_turns', result: 'boom' }, 'lauf-fehler']
  ];
  for (const [ergebnis, grund] of faelle) {
    const urteil = beurteile({ seit: seit(ABBRUCH_LAUF), ergebnis, aeusserungen: wieGesehen(ABBRUCH_LAUF) });
    assert.equal(urteil.ausgang, 'stumm');
    assert.equal(urteil.grund, grund);
  }
});

test('zaehleSeit vergleicht die Zeitstempel und nicht die Reihenfolge', () => {
  const liste = [
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:29Z' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:30Z' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:40:31Z' },
    { login: 'Claude[BOT]', zeit: '2026-09-09T07:00:00Z' },
    { login: 'claude[bot]', zeit: '' }
  ];
  // Die Sekunde des Laufbeginns selbst zaehlt nicht mit: strikt spaeter.
  assert.equal(zaehleSeit(liste, '2026-09-09T06:40:30Z').gesamt, 2);
});

test('gebunden und ungebunden werden getrennt gezaehlt', () => {
  // Die Commit-SHA ist der Unterschied zwischen "jemand hat geredet" und "zu
  // DIESEM Commit wurde geredet". An #1066 traegt die Zusammenfassung keine.
  const liste = [
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: 'aaa' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: 'bbb' },
    { login: 'claude[bot]', zeit: '2026-09-09T06:00:00Z', commit: null }
  ];
  const zahl = zaehleSeit(liste, '2026-09-09T05:00:00Z', 'aaa');
  assert.deepEqual(zahl, { gebunden: 1, frei: 2, gesamt: 3 });
});

// ---------------------------------------------------------------------------
// Vier Befunde aus der Codex-Runde zu PR #1073. Jede Probe faellt ohne ihren
// Fix - nachgeprueft, indem die alte Fassung wieder eingesetzt wurde.
// ---------------------------------------------------------------------------

test('eine FREMDE claude-Aeusserung faerbt einen Abbruch nicht gruen', () => {
  // Ein Zeitstempel allein belegt nicht, dass eine Aeusserung aus DIESEM Lauf
  // stammt: der Mention-Pfad (.github/workflows/claude.yml) antwortet als
  // derselbe Bot, und ein per cancel-in-progress abgebrochener Vorgaenger kann
  // noch posten, nachdem der Nachfolger seinen Laufbeginn notiert hat. Vorher
  // schloss "irgendwer hat nach dem Laufbeginn geredet" kurz, bevor das
  // result-Objekt ueberhaupt gelesen wurde.
  const fremd = [
    ...wieGesehen(ABBRUCH_LAUF),
    { login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }
  ];
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: ABBRUCH,
    aeusserungen: fremd
  });
  assert.equal(urteil.ausgang, 'stumm', 'das Protokoll des Laufs schlaegt die Zaehlung');
  assert.equal(urteil.grund, 'schon-kommentiert');
});

test('eine VERNEINTE Tor-Bedingung ist keine Ausnahme', () => {
  // "the stop condition does not apply because this is not trivial" trug beide
  // Woerter und haette die einzige stille Gruen-Ausnahme ausgeloest.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 6,
      subtype: 'success',
      is_error: false,
      permission_denials: [],
      result:
        'The step 1 stop condition does not apply because this is not a trivial ' +
        'change, so I continued.'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'unbekannt');
});

test('eine Werkzeugsperre schlaegt die Tor-Ausnahme', () => {
  // Die Reihenfolge war umgekehrt: ein Lauf, der an einer Sperre gescheitert
  // war, wurde gruen, wenn sein Text zufaellig nach dem trivialen Tor klang.
  // Die einzige stille Gruen-Ausnahme darf nicht vor der Fehlerpruefung liegen.
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: {
      num_turns: 12,
      subtype: 'success',
      is_error: false,
      permission_denials: [{ tool_name: 'Bash' }],
      result: 'This matches the step 1 stop condition (trivial change).'
    },
    aeusserungen: wieGesehen(ABBRUCH_LAUF)
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'werkzeugsperre');
});

test('der echte #1029-Wortlaut bleibt die Ausnahme', () => {
  // Das geschaerfte Muster darf den Fall, fuer den es gebaut ist, nicht
  // verlieren. Der Wortlaut steht als Beleg im Fixture.
  assert.match(fixture.ergebnisse['abbruch-trivial'].result, /matches the step 1 stop condition/);
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['abbruch-trivial'],
      aeusserungen: wieGesehen(ABBRUCH_LAUF)
    }).ausgang,
    'ausgesetzt'
  );
});

test('eine Zusammenfassung ohne SHA braucht die Zusage DIESES Laufs', () => {
  // Sie ist der einzige Beleg, den das Plugin bei einem sauberen PR
  // hinterlaesst ("## Code review / No issues found") und traegt keine SHA. Der
  // echte Wortlaut des Laufs, der sie gepostet hat, steht im Fixture.
  const nur_frei = [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }];
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['saubere-review'],
    aeusserungen: nur_frei
  });
  assert.equal(urteil.ausgang, 'geprueft');
  assert.equal(urteil.grund, 'ungebunden');
});

test('ZUORDNUNG AUS ABWESENHEIT TRAEGT NICHT: "Done." bleibt rot', () => {
  // Der Befund aus der zweiten Codex-Runde zu #1073. Vorher genuegte es, dass
  // KEINES der bekannten Fehlermuster passte - dann galt jede ungebundene
  // Aeusserung als Antwort dieses Laufs. Ein Lauf, der still mit "Done." endet,
  // faellt in kein Muster, und eine fremde Zusammenfassung (Mention-Pfad oder
  // Nachzuegler eines abgebrochenen Vorgaengers) haette ihn gruen gefaerbt.
  const fremd = [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }];
  const urteil = beurteile({
    seit: seit(ABBRUCH_LAUF),
    kopf: kopf(ABBRUCH_LAUF),
    ergebnis: fixture.ergebnisse['stumm-unbekannt'],
    aeusserungen: fremd
  });
  assert.equal(urteil.ausgang, 'stumm');
  assert.equal(urteil.grund, 'nicht-zuzuordnen');
  assert.match(urteil.meldung, /nicht zuzuordnen/);
});

test('ohne jede Aeusserung bleibt der stille Lauf schlicht unbekannt', () => {
  // Die beiden Gruende sind verschieden und sollen es bleiben: "es steht etwas
  // da, das ich dir nicht zuschreiben kann" ist eine andere Lage als "es steht
  // nichts da".
  assert.equal(
    beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: fixture.ergebnisse['stumm-unbekannt'],
      aeusserungen: []
    }).grund,
    'unbekannt'
  );
});

test('die drei gemessenen Wortlaute eines fertigen Laufs zaehlen alle', () => {
  // Alle drei stammen aus echten Laeufen an #1066. Faellt einer heraus, wird ein
  // sauberer PR grundlos rot - deshalb stehen sie hier namentlich.
  const nur_frei = [{ login: 'claude[bot]', zeit: '2026-09-09T06:41:00Z', commit: null }];
  const wortlaute = [
    'Review complete for ulsklyc/yuvomi#1066.',
    'The review is posted. Summary: ...',
    'Review posted. Summary: ...'
  ];
  for (const result of wortlaute) {
    const urteil = beurteile({
      seit: seit(ABBRUCH_LAUF),
      kopf: kopf(ABBRUCH_LAUF),
      ergebnis: { num_turns: 9, subtype: 'success', is_error: false, permission_denials: [], result },
      aeusserungen: nur_frei
    });
    assert.equal(urteil.ausgang, 'geprueft', `nicht erkannt: ${result}`);
  }
});
