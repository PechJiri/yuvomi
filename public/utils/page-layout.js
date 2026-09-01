/**
 * Page Composition System helpers (PAGE-COMPOSITION.md).
 *
 * Modules provide content; core owns page geometry. Use these exports to build
 * Page → PageHeader + PageBody → Section markup without local width/padding hacks.
 *
 * Reference demo: public/pages/birthdays.js (mode reading, measured header rail).
 */

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
  const classes = [compositionModeClass(mode, { legacyAlias }), className].filter(Boolean).join(' ');
  const attrParts = [];
  if (id) attrParts.push(`id="${id}"`);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === '') continue;
    attrParts.push(`${key}="${String(value).replace(/"/g, '&quot;')}"`);
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
 * @param {boolean} [opts.narrow=false] — legacy ::after spacer; prefer measured
 * @param {boolean} [opts.measured=true] — wrap primary slots in .page-toolbar__rail
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
    className,
  ].filter(Boolean).join(' ');

  const railSlots = [title, center, actions].filter(Boolean).join('\n');
  const rail = measured && railSlots
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
  const cls = ['page-toolbar__title', className].filter(Boolean).join(' ');
  return `<h1 class="${cls}">${text}</h1>`;
}

/**
 * @param {string} content — inner buttons/controls (already escaped by caller)
 * @param {object} [opts]
 * @param {string} [opts.className='']
 * @returns {string}
 */
export function renderPageActions(content, { className = '' } = {}) {
  const cls = ['page-toolbar__actions', className].filter(Boolean).join(' ');
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
  const cls = ['app-page__body', className].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${id}"` : '';
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
    className,
  ].filter(Boolean).join(' ');
  const idAttr = id ? ` id="${id}"` : '';
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
  const cls = ['metric-grid', 'page-measure', className].filter(Boolean).join(' ');
  return `<div class="${cls}">\n${content}\n</div>`;
}
