/**
 * Modul: Seiten-Lebenszyklus (#976, #977)
 * Zweck: Die Bruecke zwischen dem Signal, das der Router je Seitenaufbau
 *        vergibt, und dem Controller, an den eine Seite ihre Timer und
 *        Listener haengt.
 *
 *        Der Router besitzt EIN AbortController je render() und bricht ihn ab,
 *        sobald die Route ersetzt wird (`context.signal`). Eine Seite, die sich
 *        selbst neu zeichnet (Retry-Knopf, Anpassen-Umschalter, Wetter-Refresh,
 *        Wandtimer), braucht daneben einen Controller je EIGENEM Aufbau: der
 *        vorige Aufbau muss beim naechsten sterben, auch wenn die Route bleibt.
 *        Genau diese zwei Achsen bindet createPageController() zusammen - der
 *        Seiten-Controller faellt mit dem Router-Signal UND laesst sich
 *        einzeln abbrechen, ohne das Router-Signal anzufassen.
 *
 *        Bis #976 kannte der Router keinen Teardown-Vertrag: das Dashboard
 *        brach seinen Controller nur zu Beginn des NAECHSTEN eigenen render()
 *        ab, also nie beim Verlassen der Seite. Uhr, stiller Refresh,
 *        Wetter- und Wandtimer liefen gegen einen abgehaengten Container
 *        weiter und starteten Anfragen hinter einer anderen Seite.
 * Abhaengigkeiten: keine
 */

/**
 * Baut den Controller eines Seitenaufbaus und haengt ihn an das Router-Signal.
 *
 * - Ist das Router-Signal schon abgebrochen (die Seite wurde verlassen, bevor
 *   ein verspaeteter Neuaufbau anlief), kommt der Controller bereits abgebrochen
 *   zurueck: der Aufrufer prueft `signal.aborted` und zeichnet nichts.
 * - Bricht der Router spaeter ab, faellt der Controller mit.
 * - Bricht die Seite den Controller selbst ab (naechster eigener Aufbau), bleibt
 *   das Router-Signal unberuehrt, und der Bruecken-Listener geht mit ihm weg -
 *   sonst sammelte das Router-Signal je Neuaufbau einen toten Listener.
 *
 * @param {AbortSignal|null|undefined} routeSignal  `context.signal` aus dem Router
 * @returns {AbortController}
 */
export function createPageController(routeSignal = null) {
  const controller = new AbortController();
  if (!routeSignal) return controller;
  if (routeSignal.aborted) {
    controller.abort();
    return controller;
  }
  routeSignal.addEventListener('abort', () => controller.abort(), {
    once: true,
    signal: controller.signal,
  });
  return controller;
}
