/**
 * Modul: Mahlzeiten-Slots
 * Zweck: Die vier Slots an EINER Stelle - Schluessel, Symbol und der Name, den
 *        der Haushalt ihnen gibt (#1058).
 * Abhaengigkeiten: i18n.js, api.js
 *
 * WARUM DIESE DATEI ENTSTANDEN IST: dieselben vier Zeilen standen fuenfmal
 * unter public/ - zweimal in meals.js, je einmal in dashboard.js, recipes.js
 * und (als nackte Schluesselliste) in den Einstellungen. Solange sie nur
 * `t('meals.typeBreakfast')` sagten, war das Doppelung ohne Folgen. Sobald ein
 * Haushalt sie umbenennen darf, ist jede Kopie eine Stelle, an der der alte
 * Name stehen bleibt - und der Nutzer sieht sein Wort im Planer, aber nicht in
 * der Rezept-Eignung.
 *
 * DER NAME IST KEINE UEBERSETZUNG. Er steht in jeder Sprache so da, wie der
 * Haushalt ihn getippt hat. Genau das ist der Punkt: `fr`, `fr-CA` und `fr-BE`
 * nennen die Abendmahlzeit verschieden, und eine Locale-Datei kann das nicht je
 * Haushalt aufloesen. Wo niemand umbenannt hat, gilt weiter das eingebaute
 * Wort - deshalb faellt `mealTypeLabel()` auf `t()` zurueck und nicht auf den
 * Schluessel.
 */

import { t } from '/i18n.js';
import { api } from '/api.js';

/** Die vier Slots in Anzeige-Reihenfolge. Der SCHLUESSEL ist stabil (er steht
 *  in `meals.meal_type` unter einer CHECK-Constraint und in der Rezept-
 *  Eignung); nur die Beschriftung darueber ist beweglich. */
export const MEAL_TYPE_KEYS = ['breakfast', 'lunch', 'dinner', 'snack'];

const BUILT_IN = {
  breakfast: { labelKey: 'meals.typeBreakfast', icon: 'sunrise' },
  lunch:     { labelKey: 'meals.typeLunch',     icon: 'sun'     },
  dinner:    { labelKey: 'meals.typeDinner',    icon: 'moon'    },
  snack:     { labelKey: 'meals.typeSnack',     icon: 'cookie'  },
};

/** Haushaltsnamen, sobald sie einmal gelesen wurden. Leer heisst "noch nicht
 *  gelesen ODER nichts umbenannt" - beides fuehrt zum eingebauten Wort, und
 *  genau deshalb braucht der Unterschied hier keinen dritten Zustand. */
let householdNames = {};
let pending = null;

/**
 * Namen aus einer bereits geladenen `/preferences`-Antwort uebernehmen.
 *
 * Fuer jede Seite, die die Praeferenzen ohnehin holt (Planer, Uebersicht,
 * Einstellungen): sie spart den zweiten Request und haelt den Cache aktuell,
 * wenn jemand die Namen gerade geaendert hat.
 */
export function primeMealTypeNames(prefsData) {
  const names = prefsData?.meal_type_names;
  if (!names || typeof names !== 'object') return;
  const next = {};
  for (const key of MEAL_TYPE_KEYS) {
    const value = typeof names[key] === 'string' ? names[key].trim() : '';
    if (value) next[key] = value;
  }
  householdNames = next;
}

/**
 * Sicherstellen, dass die Namen da sind - fuer Seiten ohne eigenen
 * Praeferenz-Aufruf (Rezepte).
 *
 * Ein FEHLSCHLAG IST KEIN LEERER NAME, sondern der eingebaute: die Slots
 * behalten ihre Woerter, statt dass die Oberflaeche in Schluessel zerfaellt.
 * Deshalb faengt das `catch` still - der Aufrufer bekommt nichts zu entscheiden,
 * weil es nichts zu entscheiden gibt.
 */
export async function ensureMealTypeNames() {
  if (pending) return pending;
  pending = api.get('/preferences')
    .then((res) => { primeMealTypeNames(res?.data); })
    .catch(() => {})
    .finally(() => { pending = null; });
  return pending;
}

/** Der Name eines Slots: das Wort des Haushalts, sonst das eingebaute. */
export function mealTypeLabel(key) {
  return householdNames[key] || t(BUILT_IN[key]?.labelKey ?? '');
}

/** Alle vier Slots als `{ key, label, icon }` - die Form, die die Seiten schon
 *  benutzt haben, damit die Aufrufstellen sich nicht aendern muessen. */
export function mealTypeList() {
  return MEAL_TYPE_KEYS.map((key) => ({
    key,
    label: mealTypeLabel(key),
    icon: BUILT_IN[key].icon,
  }));
}
