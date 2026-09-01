import { api } from '/api.js';
import { t, formatDate } from '/i18n.js';
import { esc } from '/utils/html.js';
import { todayKey } from '/utils/date.js';
import { openModal, closeModal, confirmModal } from '/components/modal.js';
import { createPageFab, setPageFabAction } from '/utils/fab.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { wireScrollFade } from '/utils/ux.js';

// ZWEISPALTIG: Schedule is a full-width responsive library and statistics view;
// constraining its row lists to the narrow reading measure would recreate the
// unused desktop column this module intentionally avoids.

let root;
let scheduleFab = null;
let currentUserId = null;
let canManageOthers = false;
let activeView = 'patterns';
let state = { users: [], types: [], patterns: [], overrides: [], entries: [], warnings: [] };
let statistics = { userId: null, range: 'current', monthFrom: '', monthTo: '', from: '', to: '', entries: [], bounds: null, loading: false };
// Schichtfarben sind NUTZERFARBEN (freier Waehler im Formular); die Presets
// sind nur Startwerte. Eine Grenze gilt trotzdem: keine davon darf die STIMME
// imitieren. „Spaet" trug #7C3AED - eine Ziffer neben der Marke #6C3AED - und
// der Waehler-Default war die Marke selbst: eine Schicht im Quasi-Markenviolett
// liest sich im Kalender als Systemzustand statt als Inhalt (Eine-Stimme-Regel;
// Critique 2026-08-27 + Detektor design-system-color). Jetzt Magenta fuer die
// Abendschicht, und neue Typen starten auf dem Fruehschicht-Cyan.
const SHIFT_PRESETS = Object.freeze([
  { key: 'early', shortCode: 'E', startTime: '06:00', endTime: '14:00', color: '#0E7490' },
  { key: 'late', shortCode: 'L', startTime: '14:00', endTime: '22:00', color: '#A21CAF' },
  { key: 'night', shortCode: 'N', startTime: '22:00', endTime: '06:00', color: '#4338CA' },
  { key: 'day', shortCode: 'D', startTime: '08:00', endTime: '16:00', color: '#15803D' },
  { key: 'fullDay', shortCode: '24', startTime: '10:00', endTime: '10:00', color: '#A16207' },
]);
const SHIFT_COLOR_FALLBACK = SHIFT_PRESETS[0].color;

const option = (value, label, selected = false) => `<option value="${esc(String(value ?? ''))}"${selected ? ' selected' : ''}>${esc(label)}</option>`;
const userName = (id) => state.users.find((user) => Number(user.id) === Number(id))?.display_name
  || state.users.find((user) => Number(user.id) === Number(id))?.username
  || String(id);
const selectedOwner = () => currentUserId ?? state.users[0]?.id ?? '';
const canWrite = (userId) => canManageOthers || Number(userId) === Number(currentUserId);

// Ein Schichttyp gehoert dem Haushalt und nicht einer Person: jeder darf einen
// anlegen, aendern und loeschen nur der Ersteller oder ein Admin. Ein Typ, dessen
// Ersteller nicht mehr da ist, traegt `created_by = null` und liegt bei den Admins.
// Ohne diese Pruefung stuenden Formular und Loeschknopf bei jedem - und endeten
// verlaesslich in 403.
const canEditType = (type) => canManageOthers
  || (type?.created_by != null && Number(type.created_by) === Number(currentUserId));
const clockLabel = (shiftType) => {
  if (!shiftType?.start_time || !shiftType?.end_time) return t('schedule.allDay');
  const crossesDay = shiftType.end_time <= shiftType.start_time;
  const fullDay = shiftType.end_time === shiftType.start_time;
  return `${shiftType.start_time}–${shiftType.end_time}${crossesDay ? ' +1' : ''}${fullDay ? ' · 24 h' : ''}`;
};

async function load() {
  const day = todayKey();
  const [users, types, patternResult, overrides, entries] = await Promise.all([
    api.get('/auth/users'),
    api.get('/schedule/shift-types'),
    api.get('/schedule/patterns'),
    api.get('/schedule/overrides'),
    api.get(`/schedule/entries?from=${day}&to=${day}`),
  ]);
  const patterns = patternResult.data ?? [];
  const days = await Promise.all(patterns.map((pattern) => api.get(`/schedule/patterns/${pattern.id}/days`)));
  state = {
    users: users.data ?? [],
    types: types.data ?? [],
    patterns: patterns.map((pattern, index) => ({ ...pattern, days: days[index].data ?? [] })),
    overrides: overrides.data ?? [],
    entries: entries.data?.entries ?? [],
    warnings: entries.data?.warnings ?? [],
  };
}

function monthKey(dateKey = todayKey()) { return dateKey.slice(0, 7); }

function monthBounds(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [year, value] = month.split('-').map(Number);
  if (value < 1 || value > 12) return null;
  const lastDay = new Date(Date.UTC(year, value, 0)).getUTCDate();
  return { from: month + '-01', to: month + '-' + String(lastDay).padStart(2, '0') };
}

function statisticBounds() {
  const current = monthBounds(monthKey());
  if (statistics.range === 'current') return current;
  if (statistics.range === 'months') {
    const first = monthBounds(statistics.monthFrom);
    const last = monthBounds(statistics.monthTo);
    if (!first || !last || first.from > last.from) return null;
    return { from: first.from, to: last.to };
  }
  if (!statistics.from || !statistics.to || statistics.from > statistics.to) return null;
  return { from: statistics.from, to: statistics.to };
}

function shiftMinutes(shiftType) {
  if (!shiftType?.start_time || !shiftType?.end_time) return null;
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(':').map(Number);
    return hours * 60 + minutes;
  };
  const start = toMinutes(shiftType.start_time);
  let end = toMinutes(shiftType.end_time);
  if (end <= start) end += 24 * 60;
  return end - start;
}

function formatHours(minutes) {
  const hours = minutes / 60;
  const value = Number.isInteger(hours) ? String(hours) : hours.toFixed(1).replace(/\.0$/, '');
  return t('schedule.hoursValue', { value });
}

function statisticsSummary() {
  const types = new Map();
  let freeDays = 0;
  for (const entry of statistics.entries) {
    if (!entry.shift_type) { freeDays += 1; continue; }
    const id = Number(entry.shift_type.id);
    const item = types.get(id) || { type: entry.shift_type, count: 0, minutes: 0, hasHours: false };
    const minutes = shiftMinutes(entry.shift_type);
    item.count += 1;
    if (minutes != null) { item.minutes += minutes; item.hasHours = true; }
    types.set(id, item);
  }
  const values = [...types.values()].sort((a, b) => b.count - a.count || a.type.name.localeCompare(b.type.name));
  return { values, freeDays, totalCount: values.reduce((total, item) => total + item.count, 0), totalMinutes: values.reduce((total, item) => total + item.minutes, 0) };
}

/**
 * `magnitudeOf` gives the raw number the bar length compares (count or
 * minutes); `valueFor` gives its display string ("9" vs "9 h"). The bar
 * scales relative to the largest item in THIS list, not a fixed axis - a
 * floor keeps the smallest bar visible instead of collapsing to a hairline.
 */
function statisticsRows(items, valueFor, magnitudeOf, emptyLabel) {
  if (!items.length) return '<p class="schedule-stat-empty">' + esc(emptyLabel) + '</p>';
  const max = Math.max(...items.map(magnitudeOf), 1);
  return '<div class="schedule-stat-list">' + items.map((item) => {
    const scale = Math.max(0.03, magnitudeOf(item) / max).toFixed(3);
    const color = esc(item.type.color);
    const name = esc(item.type.short_code ? item.type.short_code + ' · ' + item.type.name : item.type.name);
    return '<div class="schedule-stat-row">'
      + '<div class="schedule-stat-row__head">'
      + '<span class="schedule-swatch" style="--schedule-color:' + color + '"></span>'
      + '<span class="schedule-stat-row__name">' + name + '</span>'
      + '<strong>' + esc(valueFor(item)) + '</strong>'
      + '</div>'
      + '<div class="schedule-stat-row__track"><div class="schedule-stat-row__fill" style="--schedule-color:' + color + '; --bar-scale:' + scale + '"></div></div>'
      + '</div>';
  }).join('') + '</div>';
}

async function refreshStatistics() {
  const bounds = statisticBounds();
  if (!bounds) throw new Error(t('schedule.invalidRange'));
  const userId = statistics.userId || currentUserId;
  const result = await api.get('/schedule/entries?from=' + encodeURIComponent(bounds.from) + '&to=' + encodeURIComponent(bounds.to) + '&user_id=' + encodeURIComponent(userId));
  statistics = { ...statistics, userId: Number(userId), entries: result.data?.entries ?? [], bounds, loading: false };
}

async function activateView(view) {
  activeView = view;
  if (view !== 'statistics') { renderPage(); return; }
  statistics = { ...statistics, entries: [], bounds: null, loading: true };
  renderPage();
  try { await refreshStatistics(); }
  catch (error) {
    statistics = { ...statistics, loading: false };
    window.yuvomi?.showToast(error.data?.error ?? error.message ?? t('common.errorGeneric'), 'danger');
  }
  renderPage();
}

function typeOptions(selected, includeFree = true) {
  const free = includeFree ? option('', t('schedule.freeDay'), selected == null || selected === '') : '';
  return `${free}${state.types.map((type) => option(type.id, type.short_code ? `${type.short_code} · ${type.name}` : type.name, Number(selected) === Number(type.id))).join('')}`;
}

function shiftPresetLabel(key) {
  const labels = {
    early: t('schedule.presets.early'),
    late: t('schedule.presets.late'),
    night: t('schedule.presets.night'),
    day: t('schedule.presets.day'),
    fullDay: t('schedule.presets.fullDay'),
  };
  return labels[key] ?? '';
}

function shiftPresetOptions() {
  return option('', t('schedule.presetCustom'), true)
    + SHIFT_PRESETS.map((preset) => option(preset.key, shiftPresetLabel(preset.key))).join('');
}

function applyShiftPreset(form) {
  const selected = SHIFT_PRESETS.find((preset) => preset.key === form.elements.shift_preset?.value);
  if (!selected) return;
  form.elements.name.value = shiftPresetLabel(selected.key);
  form.elements.short_code.value = selected.shortCode;
  form.elements.start_time.value = selected.startTime;
  form.elements.end_time.value = selected.endTime;
  form.elements.color.value = selected.color;
}
function userOptions(selected) {
  return state.users.filter((user) => canManageOthers || Number(user.id) === Number(currentUserId)).map((user) => option(user.id, user.display_name || user.username, Number(selected) === Number(user.id))).join('');
}

function formField(label, control, className = '') {
  return '<div class="form-field ' + className + '"><label class="label">' + esc(label) + '</label>' + control + '</div>';
}

function shiftFields(type = {}) {
  return [
    formField(t('schedule.name'), '<input class="input" required name="name" maxlength="200" value="' + esc(type.name ?? '') + '">'),
    formField(t('schedule.shortCode'), '<input class="input" name="short_code" maxlength="12" value="' + esc(type.short_code ?? '') + '">'),
    formField(t('schedule.color'), '<input class="input form-input--color" required name="color" type="color" value="' + esc(type.color ?? SHIFT_COLOR_FALLBACK) + '">', 'schedule-color-field'),
    formField(t('schedule.startTime'), '<yuvomi-datepicker name="start_time" type="time" label="' + esc(t('schedule.startTime')) + '" value="' + esc(type.start_time ?? '') + '"></yuvomi-datepicker>'),
    formField(t('schedule.endTime'), '<yuvomi-datepicker name="end_time" type="time" label="' + esc(t('schedule.endTime')) + '" value="' + esc(type.end_time ?? '') + '"></yuvomi-datepicker>'),
  ].join('');
}

function patternFields(pattern = {}) {
  const active = pattern.is_active === false || pattern.is_active === 0 ? '' : ' checked';
  return [
    formField(t('schedule.name'), '<input class="input" required name="name" maxlength="200" value="' + esc(pattern.name ?? '') + '">'),
    formField(t('schedule.anchorDate'), '<yuvomi-datepicker required name="anchor_date" type="date" label="' + esc(t('schedule.anchorDate')) + '" value="' + esc(pattern.anchor_date ?? todayKey()) + '"></yuvomi-datepicker>'),
    formField(t('schedule.cycleLength'), '<input class="input" required name="cycle_length" type="number" min="1" max="366" value="' + esc(String(pattern.cycle_length ?? 7)) + '">'),
    formField(t('schedule.validFrom'), '<yuvomi-datepicker name="valid_from" type="date" label="' + esc(t('schedule.validFrom')) + '" value="' + esc(pattern.valid_from ?? '') + '"></yuvomi-datepicker>'),
    formField(t('schedule.validUntil'), '<yuvomi-datepicker name="valid_until" type="date" label="' + esc(t('schedule.validUntil')) + '" value="' + esc(pattern.valid_until ?? '') + '"></yuvomi-datepicker>'),
    '<div class="form-field schedule-active-field"><span class="label">' + esc(t('schedule.active')) + '</span><label class="toggle"><input name="is_active" type="checkbox"' + active + '><span class="toggle__track"></span></label></div>',
  ].join('');
}

function shiftTypeCard(type) {
  const editable = canEditType(type);
  const body = editable
    ? `<form class="schedule-form" data-form="shift-update" data-id="${type.id}">${shiftFields(type)}<div class="schedule-actions"><button class="btn btn--secondary">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger" data-action="delete-shift" data-id="${type.id}">${esc(t('schedule.delete'))}</button></div></form>`
    : `<p class="schedule-readonly">${esc(type?.created_by == null
        ? t('schedule.typeOrphaned')
        : t('schedule.typeOwnedBy', { user: userName(type.created_by) }))}</p>`;
  return `<details class="card schedule-details"><summary><span class="schedule-swatch" style="--schedule-color:${esc(type.color)}"></span><span class="u-card-title u-compact">${esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name)}</span> <small>${esc(clockLabel(type))}</small></summary>
    ${body}
  </details>`;
}

function patternCard(pattern) {
  const writable = canWrite(pattern.user_id);
  const assigned = new Map(pattern.days.map((day) => [Number(day.position), day.shift_type_id]));
  const days = Array.from({ length: pattern.cycle_length }, (_, position) => '<div class="form-field"><label class="label">' + (position + 1) + '</label><select class="input" data-day="' + position + '">' + typeOptions(assigned.get(position)) + '</select></div>').join('');
  return `<details class="card schedule-details" data-pattern="${pattern.id}"><summary><span class="u-card-title u-compact">${esc(pattern.name)}</span> <small>· ${esc(userName(pattern.user_id))}</small></summary>
    ${writable ? `<form class="schedule-form" data-form="pattern-update" data-id="${pattern.id}">${patternFields(pattern)}<button class="btn btn--secondary">${esc(t('schedule.save'))}</button></form>` : ''}
    <h3 class="u-card-title">${esc(t('schedule.cycleDays'))}</h3><div class="schedule-days">${days}</div>
    ${writable ? `<div class="schedule-actions"><button type="button" class="btn btn--secondary" data-action="save-days" data-id="${pattern.id}">${esc(t('schedule.save'))}</button><button type="button" class="btn btn--danger" data-action="delete-pattern" data-id="${pattern.id}">${esc(t('schedule.delete'))}</button></div>` : ''}
  </details>`;
}

function overrideRows() {
  if (!state.overrides.length) return '<p>' + esc(t('schedule.empty')) + '</p>';
  return '<div class="list-rows">' + state.overrides.map((override) => {
    const type = state.types.find((item) => Number(item.id) === Number(override.shift_type_id));
    const swatchColor = type ? type.color : 'var(--color-border)';
    const typeLabel = type ? (type.short_code ? `${type.short_code} · ${type.name}` : type.name) : t('schedule.freeDay');
    const meta = [userName(override.user_id), typeLabel, override.note].filter(Boolean).join(' · ');
    const actions = canWrite(override.user_id)
      ? '<span class="schedule-override-actions"><button type="button" class="btn btn--secondary" data-action="edit-override" data-date="' + esc(override.date_key) + '" data-user-id="' + override.user_id + '">' + esc(t('common.edit')) + '</button><button type="button" class="btn btn--danger" data-action="delete-override" data-date="' + esc(override.date_key) + '" data-user-id="' + override.user_id + '">' + esc(t('schedule.delete')) + '</button></span>'
      : '';
    return '<div class="list-row schedule-override"><span class="schedule-swatch" style="--schedule-color:' + esc(swatchColor) + '"></span><div class="list-row__main"><span class="list-row__name">' + esc(formatDate(override.date_key)) + '</span><span class="list-row__meta">' + esc(meta) + '</span></div>' + actions + '</div>';
  }).join('') + '</div>';
}

function renderStatistics() {
  const bounds = statistics.bounds || statisticBounds();
  const summary = statisticsSummary();
  const selectedUser = statistics.userId || currentUserId;
  const range = statistics.range;
  const countItems = [...summary.values];
  if (summary.freeDays) countItems.push({ type: { name: t('schedule.freeDays'), short_code: '', color: 'var(--color-text-secondary)' }, count: summary.freeDays, minutes: 0, hasHours: false });
  const hourItems = summary.values.filter((item) => item.hasHours);
  const controls = range === 'months'
    ? formField(t('schedule.monthFrom'), '<input class="input" required type="month" name="month_from" value="' + esc(statistics.monthFrom || monthKey()) + '">')
      + formField(t('schedule.monthTo'), '<input class="input" required type="month" name="month_to" value="' + esc(statistics.monthTo || monthKey()) + '">')
    : range === 'custom'
      ? formField(t('schedule.validFrom'), '<yuvomi-datepicker required name="from" type="date" label="' + esc(t('schedule.validFrom')) + '" value="' + esc(statistics.from || bounds?.from || todayKey()) + '"></yuvomi-datepicker>')
        + formField(t('schedule.validUntil'), '<yuvomi-datepicker required name="to" type="date" label="' + esc(t('schedule.validUntil')) + '" value="' + esc(statistics.to || bounds?.to || todayKey()) + '"></yuvomi-datepicker>')
      : '';
  // Ohne `bounds` gibt es keine Auswertung, sondern einen ungueltigen Zeitraum:
  // `statisticBounds()` antwortet mit null, `refreshStatistics()` wirft, und der
  // catch-Zweig rendert genau hierher zurueck. Vorher stand da `bounds.from` -
  // ein TypeError, noch bevor der Fehler-Toast lief. Die Seite blieb auf dem
  // vorigen Ergebnis stehen und sagte nichts.
  const results = statistics.loading
    ? '<div class="card card--padded schedule-stat-loading" role="status" aria-live="polite">' + esc(t('common.loading')) + '</div>'
    : !bounds
      ? '<p class="card card--padded schedule-stat-empty" role="status">' + esc(t('schedule.invalidRange')) + '</p>'
      : '<p class="schedule-stat-period u-meta">' + esc(t('schedule.statisticsFor', { user: userName(selectedUser), from: formatDate(bounds.from), to: formatDate(bounds.to) })) + '</p>'
      + '<div class="metric-grid schedule-stat-metrics">'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.shiftCounts')) + '</div><div class="metric-card__value">' + esc(String(summary.totalCount)) + '</div><div class="metric-card__note">' + esc(t('schedule.shifts')) + '</div></article>'
      + '<article class="metric-card"><div class="metric-card__label">' + esc(t('schedule.workedHours')) + '</div><div class="metric-card__value">' + esc(formatHours(summary.totalMinutes)) + '</div><div class="metric-card__note">' + esc(t('schedule.total')) + '</div></article>'
      + '</div>'
      + '<div class="schedule-stat-sections">'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.shiftCounts')) + '</h2><p class="u-meta">' + esc(t('schedule.shiftCountsDescription')) + '</p></div>' + statisticsRows(countItems, (item) => String(item.count), (item) => item.count, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(String(summary.totalCount)) + '</strong></div></section>'
      + '<section class="card card--padded schedule-stat-card"><div><h2 class="u-section-title">' + esc(t('schedule.workedHours')) + '</h2><p class="u-meta">' + esc(t('schedule.workedHoursDescription')) + '</p></div>' + statisticsRows(hourItems, (item) => formatHours(item.minutes), (item) => item.minutes, t('schedule.noStatistics')) + '<div class="schedule-stat-total"><span>' + esc(t('schedule.total')) + '</span><strong>' + esc(formatHours(summary.totalMinutes)) + '</strong></div></section>'
      + '</div>';
  return '<section class="schedule-statistics">'
    + '<form class="card card--padded schedule-stat-filters" data-form="statistics">'
    + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + state.users.map((user) => option(user.id, user.display_name || user.username, Number(selectedUser) === Number(user.id))).join('') + '</select>')
    + '<div class="form-field schedule-stat-range"><span class="label">' + esc(t('schedule.statisticsRange')) + '</span><div class="segmented schedule-stat-range__choices" role="group" aria-label="' + esc(t('schedule.statisticsRange')) + '">'
    + [['current', 'schedule.currentMonth'], ['months', 'schedule.selectedMonths'], ['custom', 'schedule.customRange']].map(([value, label]) => '<button type="button" class="segmented__item' + (range === value ? ' is-active' : '') + '" data-action="statistics-range" data-range="' + value + '" aria-pressed="' + (range === value ? 'true' : 'false') + '">' + esc(t(label)) + '</button>').join('')
    + '</div></div>' + (controls ? '<div class="schedule-stat-dates">' + controls + '</div>' : '')
    + '<div class="schedule-stat-filter-actions"><button class="btn btn--primary">' + esc(t('schedule.applyStatistics')) + '</button></div></form>'
    + results + '</section>';
}
function emptyPatternState() {
  return emptyStateHTML({
    icon: 'calendar-clock',
    title: t('schedule.emptyPatternsTitle'),
    description: t('schedule.emptyPatternsDescription'),
    action: { label: t('schedule.addPattern'), icon: 'plus', attrs: { 'data-action': 'open-create', 'data-view': 'patterns' } },
  });
}

function renderToday() {
  if (!state.entries.length) return `<p>${esc(t('schedule.empty'))}</p>`;
  return `<div class="list-rows">${state.entries.map((entry) => {
    const type = entry.shift_type;
    const swatchColor = type ? type.color : 'var(--color-border)';
    const name = type ? esc(type.short_code ? `${type.short_code} · ${type.name}` : type.name) : esc(t('schedule.freeDay'));
    const meta = type ? `${esc(userName(entry.user_id))} · ${esc(clockLabel(type))}` : esc(userName(entry.user_id));
    return `<div class="list-row schedule-entry-row"><span class="schedule-swatch" style="--schedule-color:${esc(swatchColor)}"></span><div class="list-row__main"><span class="list-row__name">${name}</span><span class="list-row__meta">${meta}</span></div></div>`;
  }).join('')}</div>`;
}

function renderScheduleWarnings() {
  if (!state.warnings.length) return '';
  return '<div class="schedule-warnings" role="status">' + state.warnings.map((warning) => '<p>' + esc(t('schedule.overlapWarning', { date: warning.date_key, user: userName(warning.user_id) })) + '</p>').join('') + '</div>';
}

/**
 * Builds the toolbar and tab rail ONCE. `renderPage()` below only touches
 * `.schedule-body` on a tab switch, so a FAB the router docks into
 * `.page-toolbar__actions` survives every subsequent tab change instead of
 * being destroyed along with a full-page reset.
 */
function renderShell() {
  const tabs = [
    ['shifts', t('schedule.shiftTypes')],
    ['patterns', t('schedule.patterns')],
    ['overrides', t('schedule.overrides')],
    ['statistics', t('schedule.statistics')],
  ];
  root.replaceChildren();
  root.insertAdjacentHTML('beforeend', `<div class="schedule-page app-page app-page--data" data-composition="data">
    <header class="page-toolbar schedule-toolbar">
      <h1 class="page-toolbar__title">${esc(t('schedule.title'))}</h1>
      <div class="page-toolbar__actions"></div>
      <div class="sub-tabs-bar schedule-tabs page-toolbar__bar" role="tablist" aria-label="${esc(t('schedule.title'))}">
        ${tabs.map(([id, label]) => `<button class="sub-tab" type="button" role="tab" data-tab="${id}">${esc(label)}</button>`).join('')}
      </div>
    </header>
    <div class="schedule-body"></div>
  </div>`);
  // Scroll-Affordanz der Bar-Zeile (geteilter Peek-Fade, .page-toolbar__bar).
  wireScrollFade(root.querySelector('.schedule-tabs'));
  root.addEventListener('submit', submitForm);
  root.addEventListener('click', (event) => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { activateView(tabButton.dataset.tab); return; }
    const actionButton = event.target.closest('[data-action]');
    if (actionButton) action({ currentTarget: actionButton });
  });
}

function renderPage() {
  root.querySelectorAll('[data-tab]').forEach((button) => {
    const isActive = button.dataset.tab === activeView;
    button.classList.toggle('sub-tab--active', isActive);
    button.setAttribute('aria-selected', String(isActive));
  });
  const panel = activeView === 'shifts'
    ? '<section class="schedule-library schedule-library--shifts"><h2 class="u-section-title">' + esc(t('schedule.shiftTypes')) + '</h2>' + (state.types.length ? state.types.map(shiftTypeCard).join('') : '<p>' + esc(t('schedule.empty')) + '</p>') + '</section>'
    : activeView === 'patterns'
      ? '<section class="schedule-library schedule-library--patterns"><h2 class="u-section-title">' + esc(t('schedule.patterns')) + '</h2>' + (state.patterns.length ? state.patterns.map(patternCard).join('') : emptyPatternState()) + '</section>'
      : activeView === 'overrides'
        ? '<section class="schedule-library schedule-library--overrides"><h2 class="u-section-title">' + esc(t('schedule.overrides')) + '</h2>' + overrideRows() + '</section>'
        : renderStatistics();
  const body = root.querySelector('.schedule-body');
  body.replaceChildren();
  // Die Heute-Karte erst, wenn das Modul in Betrieb ist: ein frischer Haushalt
  // sah sonst ZWEI Leerzustaende uebereinander („Noch keine Schichteintraege."
  // + „Noch kein Schichtplan") - zwei Meldungen fuer eine Tatsache, und die
  // Onboarding-Anleitung des Panels stand erst an zweiter Stelle
  // (Critique 2026-08-27, P2).
  const inUse = state.types.length || state.patterns.length
    || state.overrides.length || state.entries.length;
  body.insertAdjacentHTML('beforeend',
    (activeView === 'statistics' || !inUse ? '' : '<section class="card card--padded schedule-today"><h2 class="u-section-title">' + esc(t('schedule.today')) + '</h2>' + renderToday() + renderScheduleWarnings() + '</section>')
    + `<div class="schedule-content">${panel}</div>`);
  updateScheduleFab();
  window.lucide?.createIcons({ el: body });
}
function updateScheduleFab() {
  if (!scheduleFab) return;
  const labels = {
    shifts: t('schedule.createShiftType'),
    patterns: t('schedule.addPattern'),
    overrides: t('schedule.createOverride'),
  };
  const dockLabels = {
    shifts: t('schedule.shiftType'),
    patterns: t('schedule.pattern'),
    overrides: t('schedule.override'),
  };
  setPageFabAction(scheduleFab, {
    label: labels[activeView],
    dockLabel: dockLabels[activeView],
    hidden: activeView === 'statistics',
    onClick: () => openScheduleCreateModal(activeView),
  });
}

function openOverrideEditModal(override) {
  const type = state.types.find((item) => Number(item.id) === Number(override.shift_type_id));
  const content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="override-create">'
    + '<input type="hidden" name="user_id" value="' + esc(String(override.user_id)) + '">'
    + '<input type="hidden" name="date_key" value="' + esc(override.date_key) + '">'
    + formField(t('schedule.owner'), '<input class="input" readonly value="' + esc(userName(override.user_id)) + '">')
    + formField(t('schedule.date'), '<input class="input" readonly value="' + esc(override.date_key) + '">')
    + formField(t('schedule.shiftTypes'), '<select class="input" name="shift_type_id">' + typeOptions(type?.id ?? null) + '</select>')
    + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000" value="' + esc(override.note ?? '') + '">')
    + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  openModal({
    title: t('schedule.editOverride'),
    size: 'md',
    content,
    onSave: (modal) => modal.querySelector('#schedule-create-form')?.addEventListener('submit', saveCreatedSchedule),
  });
}

function openScheduleCreateModal(view) {
  let title;
  let content;
  if (view === 'shifts') {
    title = t('schedule.createShiftType');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="shift-create">'
      + formField(t('schedule.preset'), '<select class="input" name="shift_preset">' + shiftPresetOptions() + '</select>')
      + shiftFields()
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('common.create')) + '</button></div></form>';
  } else if (view === 'patterns') {
    title = t('schedule.addPattern');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="pattern-create">'
      + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(selectedOwner()) + '</select>')
      + patternFields()
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('common.create')) + '</button></div></form>';
  } else {
    title = t('schedule.createOverride');
    content = '<form id="schedule-create-form" class="form-stack schedule-modal-form" data-form="override-create">'
      + formField(t('schedule.owner'), '<select class="input" required name="user_id">' + userOptions(selectedOwner()) + '</select>')
      + formField(t('schedule.date'), '<yuvomi-datepicker required name="date_key" type="date" label="' + esc(t('schedule.date')) + '" value="' + esc(todayKey()) + '"></yuvomi-datepicker>')
      + formField(t('schedule.shiftTypes'), '<select class="input" name="shift_type_id">' + typeOptions(null) + '</select>')
      + formField(t('schedule.note'), '<input class="input" name="note" maxlength="5000">')
      + '<div class="modal-actions"><button type="submit" class="btn btn--primary">' + esc(t('schedule.save')) + '</button></div></form>';
  }
  openModal({
    title,
    size: 'md',
    content,
    onSave: (modal) => {
      const form = modal.querySelector('#schedule-create-form');
      form?.querySelector('[name="shift_preset"]')?.addEventListener('change', () => applyShiftPreset(form));
      form?.addEventListener('submit', saveCreatedSchedule);
    },
  });
}

async function saveCreatedSchedule(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = formData(form);
  try {
    if (form.dataset.form === 'shift-create') await api.post('/schedule/shift-types', data);
    if (form.dataset.form === 'pattern-create') {
      data.user_id = Number(data.user_id);
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.post('/schedule/patterns', data);
    }
    if (form.dataset.form === 'override-create') {
      const dateKey = data.date_key;
      delete data.date_key;
      data.user_id = Number(data.user_id);
      data.shift_type_id = data.shift_type_id ? Number(data.shift_type_id) : null;
      await api.put('/schedule/overrides/' + encodeURIComponent(dateKey), data);
    }
    await load();
    renderPage();
    await closeModal({ force: true });
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

function formData(form) {
  return Object.fromEntries(new FormData(form));
}

function formValue(form, name, fallback = '') {
  return form.elements?.namedItem(name)?.value || form.querySelector('[name="' + name + '"]')?.value || fallback;
}

async function submitForm(event) {
  event.preventDefault();
  const form = event.target;
  const data = formData(form);
  try {
    if (form.dataset.form === 'statistics') {
      statistics = {
        ...statistics,
        userId: Number(formValue(form, 'user_id', data.user_id)),
        monthFrom: formValue(form, 'month_from', data.month_from || statistics.monthFrom).slice(0, 7),
        monthTo: formValue(form, 'month_to', data.month_to || statistics.monthTo).slice(0, 7),
        from: formValue(form, 'from', data.from || statistics.from),
        to: formValue(form, 'to', data.to || statistics.to),
        entries: [],
        bounds: null,
        loading: true,
      };
      renderPage();
      await refreshStatistics();
      renderPage();
      return;
    }
    if (form.dataset.form === 'shift-create') await api.post('/schedule/shift-types', data);
    if (form.dataset.form === 'shift-update') await api.put(`/schedule/shift-types/${form.dataset.id}`, data);
    if (form.dataset.form === 'pattern-create') {
      data.user_id = Number(data.user_id);
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.post('/schedule/patterns', data);
    }
    if (form.dataset.form === 'pattern-update') {
      data.cycle_length = Number(data.cycle_length);
      data.is_active = form.elements.is_active.checked;
      await api.put(`/schedule/patterns/${form.dataset.id}`, data);
    }
    if (form.dataset.form === 'override-create') {
      const dateKey = data.date_key;
      delete data.date_key;
      data.user_id = Number(data.user_id);
      data.shift_type_id = data.shift_type_id ? Number(data.shift_type_id) : null;
      await api.put(`/schedule/overrides/${dateKey}`, data);
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(t('schedule.saved'), 'success');
  } catch (error) {
    if (form.dataset.form === 'statistics') {
      statistics = { ...statistics, loading: false };
      renderPage();
    }
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

async function action(event) {
  const button = event.currentTarget;
  try {
    if (button.dataset.action === 'open-create') {
      openScheduleCreateModal(button.dataset.view || activeView);
      return;
    }
    if (button.dataset.action === 'statistics-range') {
      statistics = { ...statistics, range: button.dataset.range, entries: [], bounds: null, loading: false };
      renderPage();
      return;
    }
    if (button.dataset.action === 'edit-override') {
      const override = state.overrides.find((item) => item.date_key === button.dataset.date && Number(item.user_id) === Number(button.dataset.userId));
      if (override) openOverrideEditModal(override);
      return;
    }
    if (button.dataset.action === 'delete-shift') await api.delete(`/schedule/shift-types/${button.dataset.id}`);
    // Ein Muster loeschen nimmt seine Zyklustage mit (ON DELETE CASCADE): eine
    // Achttage-Rotation ist mit einem Fingertipp weg, und es gibt keinen Weg
    // zurueck. Deshalb fragt genau DIESE Loeschung nach und nennt dabei, was
    // dranhaengt - die anderen beiden sind je eine Zeile und ohne Nachfrage.
    if (button.dataset.action === 'delete-pattern') {
      const pattern = state.patterns.find((item) => Number(item.id) === Number(button.dataset.id));
      const confirmed = await confirmModal(
        t('schedule.deletePatternTitle', { name: pattern?.name ?? '' }),
        {
          danger: true,
          confirmLabel: t('schedule.delete'),
          detail: t('schedule.deletePatternDetail', { count: pattern?.cycle_length ?? 0 }),
        },
      );
      if (!confirmed) return;
      await api.delete(`/schedule/patterns/${button.dataset.id}`);
    }
    if (button.dataset.action === 'delete-override') await api.delete(`/schedule/overrides/${button.dataset.date}?user_id=${button.dataset.userId}`);
    if (button.dataset.action === 'save-days') {
      const details = button.closest('[data-pattern]');
      const days = [...details.querySelectorAll('[data-day]')].map((select) => ({
        position: Number(select.dataset.day),
        shift_type_id: select.value ? Number(select.value) : null,
      }));
      await api.put(`/schedule/patterns/${button.dataset.id}/days`, { days });
    }
    await load();
    renderPage();
    window.yuvomi?.showToast(button.dataset.action.startsWith('delete') ? t('schedule.deleted') : t('schedule.saved'), 'success');
  } catch (error) {
    window.yuvomi?.showToast(error.data?.error ?? t('common.errorGeneric'), 'danger');
  }
}

export async function render(container, { user } = {}) {
  root = container;
  currentUserId = user?.id ?? null;
  canManageOthers = user?.role === 'admin';
  await load();
  statistics = { ...statistics, userId: currentUserId, monthFrom: monthKey(), monthTo: monthKey(), from: todayKey(), to: todayKey() };
  renderShell();
  scheduleFab = createPageFab({ id: 'schedule-fab' });
  root.querySelector('.schedule-page')?.appendChild(scheduleFab);
  renderPage();
  window.lucide?.createIcons({ el: root });
}
