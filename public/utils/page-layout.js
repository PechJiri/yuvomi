/**
 * Page Composition System helpers (PAGE-COMPOSITION.md).
 *
 * Modules provide content; core owns page geometry. Use these exports to build
 * Page → PageHeader + PageBody → Section markup without local width/padding hacks.
 *
 * Reference demo: public/pages/birthdays.js (mode reading, measured header rail).
 *
 * JEDER ATTRIBUT-WERT GEHT DURCH esc(), AUCH id UND className. Diese Helfer
 * sind die zugesagte Oberflaeche fuer Erweiterungen (MODULES.md), und eine id
 * aus einem Datensatz (`sec-${item.name}`) ist der erwartete Gebrauch der
 * Option. Die erste Fassung ersetzte nur das Anfuehrungszeichen in
 * Attribut-WERTEN; id, Klassenname und Attribut-Schluessel gingen roh in den
 * String - ein `"` darin verliess das Attribut.
 *
 * EIN ATTRIBUT-SCHLUESSEL WIRD GEPRUEFT, NICHT ESCAPED. Er steht ausserhalb
 * der Anfuehrungszeichen, und dort beenden Leerzeichen und `=` den Namen -
 * Zeichen, die esc() gar nicht kennt. `esc('x onclick=f() y')` kommt
 * unveraendert zurueck und wird zu drei Attributen, eines davon lebendig
 * (Codex + claude-review, vierte Runde an #995 - die zweite Fassung hatte
 * den Schluessel durch esc() gezogen und einen Test mit einem `"`-Payload
 * daneben, der genau deshalb gruen blieb). Ein Schluessel, der kein
 * Attributname ist, ist ein Programmierfehler des Aufrufers und wirft, wie
 * ein unbekannter Modus. Slot-Inhalte (title, body, content) bleiben
 * bewusst roh: sie sind Markup, das der Aufrufer schon escaped hat.
 */

import { esc } from './html-escape.js';

const ATTR_NAME = /^[A-Za-z][A-Za-z0-9:_.-]*$/;

function attrName(key) {
  if (!ATTR_NAME.test(key)) {
    throw new Error(`Invalid attribute name: ${JSON.stringify(key)}`);
  }
  return key;
}

export const COMPOSITION_MODES = Object.freeze([
  'reading',
  'data',
  'dashboard',
  'form',
  'split',
  'full',
]);

/**
 * @param {string} mode
 * @param {{ legacyAlias?: boolean }} [opts]
 * @returns {string}
 */
export function compositionModeClass(mode, { legacyAlias = true } = {}) {
  if (!COMPOSITION_MODES.includes(mode)) {
    throw new Error(`Invalid composition mode: ${mode}`);
  }
  // Compat: keep .page-measure--narrow for one release so row-carrier :is() lists
  // and older CSS still resolve. Reference / new pages may pass legacyAlias:false.
  const legacy = legacyAlias && mode === 'reading' ? ' page-measure--narrow' : '';
  return `app-page app-page--${mode}${legacy}`;
}

/**
 * @param {object} opts
 * @param {string} [opts.mode='reading']
 * @param {string} [opts.className='']
 * @param {string} [opts.id='']
 * @param {Record<string, string>} [opts.attrs={}]
 * @param {boolean} [opts.legacyAlias=true]
 * @param {string} [opts.header='']
 * @param {string} [opts.body='']
 * @param {string} [opts.trailing='']
 * @returns {string}
 */
export function renderAppPage({
  mode = 'reading',
  className = '',
  id = '',
  attrs = {},
  legacyAlias = true,
  header = '',
  body = '',
  trailing = '',
} = {}) {
  const classes = [compositionModeClass(mode, { legacyAlias }), esc(className)].filter(Boolean).join(' ');
  const attrParts = [];
  if (id) attrParts.push(`id="${esc(id)}"`);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === '') continue;
    attrParts.push(`${attrName(key)}="${esc(String(value))}"`);
  }
  const extra = attrParts.length ? ` ${attrParts.join(' ')}` : '';
  return `<div class="${classes}" data-composition="${mode}"${extra}>
${header}${body}${trailing}
</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.title='']
 * @param {string} [opts.center='']
 * @param {string} [opts.actions='']
 * @param {string} [opts.bar='']
 * @param {boolean} [opts.wrap=false]
 * @param {boolean} [opts.narrow=true] - ::after spacer pulls the row end to --page-measure;
 *   a no-op in `full`/`split` (their measure is 100%), so the default is safe there
 * @param {boolean} [opts.measured=false] - without narrow: wrap primary slots in .page-toolbar__rail
 * @param {boolean} [opts.inGroup=false]
 * @param {boolean} [opts.capped=false]
 * @param {boolean} [opts.stacked=false]
 * @returns {string}
 */
export function renderPageHeader({
  className = '',
  title = '',
  center = '',
  actions = '',
  bar = '',
  wrap = false,
  narrow = true,
  measured = false,
  inGroup = false,
  capped = false,
  stacked = false,
} = {}) {
  const classes = [
    'page-toolbar',
    wrap && 'page-toolbar--wrap',
    measured && 'page-toolbar--measured',
    narrow && 'page-toolbar--narrow',
    inGroup && 'page-toolbar--in-group',
    capped && 'page-toolbar--capped',
    stacked && 'page-toolbar--stacked',
    esc(className),
  ].filter(Boolean).join(' ');

  const railSlots = [title, center, actions].filter(Boolean).join('\n');
  // Der Rail ist nur dann ein Element, wenn er auch eine Box ist. Mit
  // `narrow` haelt der ::after-Slot die Kante, und ein Wrapper um die Slots
  // waere reine DOM-Tiefe - eine, die alles blind macht, was den Titel als
  // DIREKTES Kind der Leiste sucht: das Absender-Siegel und der Dock-Titel
  // (`:scope > .page-toolbar__title` in ux.js) und die Large-Title-Regeln
  // (`.page-toolbar > .page-toolbar__title` in typography.css). `display:
  // contents` hilft dort nicht, Selektoren sehen den DOM, nicht den Boxbaum.
  const rail = measured && !narrow && railSlots
    ? `<div class="page-toolbar__rail">\n${railSlots}\n</div>`
    : railSlots;
  const inner = [rail, bar].filter(Boolean).join('\n');
  return `<div class="${classes}">\n${inner}\n</div>`;
}

/**
 * @param {string} text
 * @param {object} [opts]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderPageTitle(text, { className = '' } = {}) {
  const cls = ['page-toolbar__title', esc(className)].filter(Boolean).join(' ');
  return `<h1 class="${cls}">${text}</h1>`;
}

/**
 * @param {string} content - inner buttons/controls (already escaped by caller)
 * @param {object} [opts]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderPageActions(content, { className = '' } = {}) {
  const cls = ['page-toolbar__actions', esc(className)].filter(Boolean).join(' ');
  return `<div class="${cls}">\n${content}\n</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderPageBody({ className = '', content = '', id = '' } = {}) {
  const cls = ['app-page__body', esc(className)].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<div class="${cls}"${idAttr}>\n${content}\n</div>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {boolean} [opts.bleed=false]
 * @param {boolean} [opts.measure=true]
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderPageSection({
  className = '',
  bleed = false,
  measure = true,
  content = '',
  id = '',
} = {}) {
  const cls = [
    'page-section',
    bleed && 'page-section--bleed',
    measure && !bleed && 'page-measure',
    esc(className),
  ].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${esc(id)}"` : '';
  return `<section class="${cls}"${idAttr}>\n${content}\n</section>`;
}

/**
 * @param {object} opts
 * @param {string} [opts.className='']
 * @param {string} [opts.content='']
 * @param {string} [opts.id='']
 * @returns {string}
 */
export function renderListSection({ className = '', content = '', id = '' } = {}) {
  return renderPageSection({
    className: ['page-section--list', className].filter(Boolean).join(' '),
    measure: true,
    content,
    id,
  });
}

/**
 * KPI / summary band capped to the page measure.
 * @param {object} opts
 * @param {string} opts.content
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderMetricBand({ content, className = '' } = {}) {
  const cls = ['metric-grid', 'page-measure', esc(className)].filter(Boolean).join(' ');
  return `<div class="${cls}">\n${content}\n</div>`;
}
