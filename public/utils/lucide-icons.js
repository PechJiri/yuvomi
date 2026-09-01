/**
 * Modul: Die Brücke zum Symbolvorrat (#873)
 * Zweck: Lucide nach Namen fragen - welche gibt es, und wie sieht eines aus.
 * Abhängigkeiten: lucide.min.js (global, per <script defer> aus index.html)
 *
 * WOFUER DAS HIER IST UND WOFUER NICHT. Die App zeichnet ihre Symbole seit je
 * über `data-lucide` im Markup und einen Aufruf von `createIcons()` danach -
 * über zweihundert Stellen tun das, und die bleiben, wie sie sind. Diese Datei
 * beantwortet die andere Frage, die es vorher nicht gab: ein Symbol, dessen
 * Name erst zur Laufzeit feststeht, weil ihn jemand ausgesucht hat.
 *
 * DESHALB `createElement` UND NICHT `createIcons`. Der zweite Weg ersetzt
 * Platzhalter: erst muss ein `<i data-lucide>` im Baum stehen, dann läuft
 * `createIcons` darüber. Wer ein einzelnes Zeichen braucht, dessen Name gerade
 * erst feststeht, will diesen Umweg nicht - `createElement` liefert das fertige
 * `<svg>` direkt und fasst nichts an, was nicht danach gefragt hat.
 *
 * DER AUSSCHNITT IST INZWISCHEN ECHT, UND DAS ÄNDERT DIE WAHL NICHT. Bis zum
 * Audit 2026-08-31 durchsuchte `createIcons({ el })` das ganze Dokument, egal
 * was man ihm übergab - für ein Raster mit 120 Kacheln wären das 120 volle
 * Dokumentläufe gewesen. `lucide-scope.js` (lädt direkt nach dem Bundle) hält
 * den Lauf seither unter `el`. Der Größenvorteil ist damit weg, der Grund
 * oben bleibt: ein Platzhalter, den niemand sehen soll, ist ein Umweg und
 * keine Ersparnis.
 *
 * DIE NAMENSFORM IST GEPRUEFT, NICHT GERATEN. Lucide führt seine Symbole in
 * PascalCase (`AlarmClock`), die App schreibt sie mit Bindestrich
 * (`alarm-clock`). `pascalize()` ist bewusst dieselbe Zeile wie im
 * Vendor-Build: was hier auflöst, löst dort auch auf. Über alle 1743 Namen
 * findet jeder den Weg hin und zurück - und weil das eine Aussage über den
 * heutigen Lucide-Stand ist und nicht über den nächsten, prüft `iconNames()`
 * jeden Namen einzeln nach, statt sich darauf zu verlassen.
 */

/** PascalCase → Bindestrich-Form. `AlarmClock` → `alarm-clock`. */
function kebab(pascal) {
  return pascal
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2')
    .toLowerCase();
}

/**
 * Bindestrich-Form → PascalCase, mit Lucides eigener Regel.
 * `alarm-clock` → `AlarmClock`, `grid2x2` → `Grid2x2`.
 */
function pascalize(name) {
  return String(name).replace(/(\w)(\w*)(_|-|\s*)/g, (_all, head, tail) => head.toUpperCase() + tail.toLowerCase());
}

let cachedNames = null;

/**
 * Alle Symbolnamen in Bindestrich-Form, alphabetisch.
 *
 * DAS ERGEBNIS WIRD NUR GEMERKT, WENN ETWAS DARIN STEHT. Lucide kommt per
 * `<script defer>`; wer früher fragt, bekäme eine leere Liste - und die als
 * Antwort zu merken hiesse, sie für den Rest der Sitzung zu behalten.
 *
 * @returns {string[]}
 */
export function iconNames() {
  if (cachedNames) return cachedNames;

  const icons = window.lucide?.icons;
  if (!icons) return [];

  const names = Object.keys(icons)
    .map(kebab)
    // Die Gegenprobe: nur Namen, die über Lucides eigene Auflösung auf ein
    // vorhandenes Symbol zurückführen. Ohne sie stünden im Raster Kacheln,
    // die leer bleiben.
    .filter((name) => Boolean(icons[pascalize(name)]));

  // Doppelte entstehen, wo Lucide zwei Schreibweisen auf dieselbe Zeichnung
  // führt (Aliase wie `ActivitySquare` neben `SquareActivity`).
  const unique = [...new Set(names)].sort();
  if (unique.length) cachedNames = unique;
  return unique;
}

/** Kennt Lucide dieses Symbol? */
export function hasIcon(name) {
  const icons = window.lucide?.icons;
  return Boolean(name && icons?.[pascalize(name)]);
}

/**
 * Ein Symbol als fertiges `<svg>`.
 *
 * GIBT `null` STATT ZU WERFEN, wenn der Name unbekannt ist. Ein Symbolname
 * kommt aus der Datenbank und kann ein Lucide-Update überleben, das ihn
 * umbenennt - der Aufrufer soll dann sein Ersatzgesicht zeigen können
 * (Buchstabe, Standardsymbol) und nicht abbrechen.
 *
 * @param {string} name  Bindestrich-Form, z. B. `alarm-clock`
 * @param {{class?: string, size?: number}} [opts]
 * @returns {SVGElement|null}
 */
export function iconElement(name, { class: className, size } = {}) {
  const icons = window.lucide?.icons;
  const node = icons?.[pascalize(name)];
  if (!node || typeof window.lucide?.createElement !== 'function') return null;

  const svg = window.lucide.createElement(node);
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  if (size) {
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
  }
  return svg;
}
