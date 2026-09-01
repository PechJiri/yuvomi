/**
 * Modul: Extension dashboard widgets
 * Zweck: Merge third-party widget metadata from GET /api/v1/modules with core widgets.
 */

import {
  WIDGET_IDS as CORE_WIDGET_IDS,
  WIDGET_SIZE_OPTIONS,
  nearestPreset,
  defaultWidgetSize,
  defaultWidgetVisible,
  DEFAULT_HIDDEN_WIDGETS,
} from './dashboard-widgets.js';

let _extensionModules = [];

export function setExtensionModules(modules) {
  _extensionModules = Array.isArray(modules) ? modules : [];
}

export function getExtensionModules() {
  return _extensionModules;
}

/** A failed /modules fetch is not a claim that no modules exist. */
export function selectThirdPartyModuleList(previous, { ok, data } = {}) {
  const prev = Array.isArray(previous) ? previous : [];
  if (!ok) return prev;
  return Array.isArray(data) ? data : prev;
}

export function isExtensionWidget(id) {
  return typeof id === 'string' && id.includes(':');
}

export function extensionWidgetCatalog() {
  const out = [];
  for (const mod of _extensionModules) {
    if (!mod?.enabled || mod.status !== 'enabled') continue;
    for (const w of mod.capabilities?.widgets || []) {
      out.push({
        ...w,
        moduleId: mod.id,
        navModule: `third-party-${mod.id}`,
        permissionModuleKey: mod.capabilities?.permissionModuleKey || null,
      });
    }
  }
  return out;
}

export function extensionWidgetIds() {
  return extensionWidgetCatalog().map((w) => w.id);
}

export function allWidgetIds() {
  return [...CORE_WIDGET_IDS, ...extensionWidgetIds()];
}

export function getExtensionWidgetMeta(id) {
  return extensionWidgetCatalog().find((w) => w.id === id) || null;
}

export function extensionModuleForWidget(id) {
  const meta = getExtensionWidgetMeta(id);
  return meta?.permissionModuleKey || null;
}

// Same rule as dashboard-widgets.js defaultInsertIndex: follow the predecessor
// in widgetIdOrder; if none is present, insert at 0 — never append. Appending
// made every stored layout read as user-ordered and dropped the grid out of
// dense (audit A1-03). Returning ordered.length here would disagree with core
// the day a visible widget sits first in the merged list.
function defaultInsertIndex(ordered, missingId, widgetIdOrder) {
  for (let i = widgetIdOrder.indexOf(missingId) - 1; i >= 0; i--) {
    const at = ordered.findIndex((w) => w.id === widgetIdOrder[i]);
    if (at !== -1) return at + 1;
  }
  return 0;
}

export function defaultExtensionWidgetVisible(id) {
  const meta = getExtensionWidgetMeta(id);
  if (meta) return meta.defaultVisible === true;
  return !DEFAULT_HIDDEN_WIDGETS.has(id);
}

export function buildDefaultWidgetConfig() {
  const core = CORE_WIDGET_IDS.map((id, i) => ({
    id,
    visible: defaultWidgetVisible(id),
    order: i,
    size: defaultWidgetSize(id),
  }));
  const extIds = extensionWidgetIds();
  const weatherIdx = core.findIndex((w) => w.id === 'weather');
  const insertAt = weatherIdx >= 0 ? weatherIdx : core.length;
  const ext = extIds.map((id, i) => ({
    id,
    visible: defaultExtensionWidgetVisible(id),
    order: insertAt + i,
    size: getExtensionWidgetMeta(id)?.defaultSize || '1x2',
  }));
  const merged = [...core.slice(0, insertAt), ...ext, ...core.slice(insertAt)];
  return merged.map((w, i) => ({ ...w, order: i }));
}

export function normalizeDashboardConfigWithExtensions(input) {
  const widgetIdOrder = allWidgetIds();
  const knownIds = new Set(widgetIdOrder);

  const valid = Array.isArray(input)
    ? input
      .filter((w) => w && typeof w === 'object' && (knownIds.has(w.id) || isExtensionWidget(w.id)))
      .map((w, i) => ({
        id: w.id,
        visible: w.visible !== false,
        order: Number.isFinite(Number(w.order)) ? Number(w.order) : i,
        size: WIDGET_SIZE_OPTIONS.includes(w.size)
          ? nearestPreset(w.size)
          : (getExtensionWidgetMeta(w.id)?.defaultSize || defaultWidgetSize(w.id)),
        ...(w.options && typeof w.options === 'object' && !Array.isArray(w.options) && Object.keys(w.options).length
          ? { options: { ...w.options } }
          : {}),
      }))
    : [];

  const ordered = valid.sort((a, b) => a.order - b.order);
  const presentIds = new Set(ordered.map((w) => w.id));

  for (const id of widgetIdOrder) {
    if (presentIds.has(id)) continue;
    const visible = isExtensionWidget(id) ? defaultExtensionWidgetVisible(id) : defaultWidgetVisible(id);
    const size = isExtensionWidget(id)
      ? (getExtensionWidgetMeta(id)?.defaultSize || '1x2')
      : defaultWidgetSize(id);
    ordered.splice(defaultInsertIndex(ordered, id, widgetIdOrder), 0, {
      id,
      visible,
      order: 0,
      size,
    });
    presentIds.add(id);
  }

  return ordered.map((w, i) => ({ ...w, order: i }));
}

export { CORE_WIDGET_IDS as WIDGET_IDS };
