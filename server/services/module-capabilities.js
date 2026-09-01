/**
 * Module: Extension module capabilities (manifest v2)
 * Purpose: Validate and normalize widgets, permissions, and API declarations in module.json.
 */

import path from 'node:path';

const WIDGET_SHORT_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const OPTION_KEY_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL_KEY_RE = /^[a-z][a-z0-9._-]{0,79}$/;
const VALID_WIDGET_SIZES = new Set([
  '1x1', '1x2', '1x3', '1x4', '2x1', '2x2', '2x3', '2x4',
  '3x1', '3x2', '3x3', '3x4', '4x1', '4x2', '4x3', '4x4',
]);
const VALID_OPTION_TYPES = new Set(['boolean', 'number', 'string', 'array']);

export function extensionPermissionKey(moduleId) {
  return `ext:${moduleId}`;
}

export function fullWidgetId(moduleId, widgetId) {
  return `${moduleId}:${widgetId}`;
}

function parseWidgetShortId(value, label) {
  const id = String(value || '').trim();
  if (!WIDGET_SHORT_ID_RE.test(id)) {
    throw new Error(`${label} must use lowercase letters, numbers and hyphens (max 32 chars).`);
  }
  return id;
}

function parseLabelKey(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const key = String(value).trim();
  if (!LABEL_KEY_RE.test(key)) {
    throw new Error(`${label} must use lowercase letters, numbers, dots, hyphens and underscores.`);
  }
  return key;
}

function normalizeOptionsSchema(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('optionsSchema must be an object.');
  }
  const keys = Object.keys(raw);
  if (keys.length > 8) throw new Error('optionsSchema allows at most 8 keys.');
  const out = {};
  for (const key of keys) {
    if (!OPTION_KEY_RE.test(key)) {
      throw new Error(`optionsSchema key "${key}" is invalid.`);
    }
    const field = raw[key];
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      throw new Error(`optionsSchema.${key} must be an object.`);
    }
    const type = String(field.type || 'string').trim();
    if (!VALID_OPTION_TYPES.has(type)) {
      throw new Error(`optionsSchema.${key}.type must be boolean, number, string, or array.`);
    }
    out[key] = {
      type,
      title: String(field.title || field.titleKey || key).trim().slice(0, 80),
      ...(field.titleKey ? { titleKey: parseLabelKey(field.titleKey, `optionsSchema.${key}.titleKey`) } : {}),
      ...(field.format ? { format: String(field.format).trim().slice(0, 40) } : {}),
      ...(Array.isArray(field.enum) ? { enum: field.enum.map((v) => String(v)).slice(0, 20) } : {}),
      ...(field.default !== undefined ? { default: field.default } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

function normalizePermissionModule(raw, fallbackName, fallbackIcon) {
  const mod = raw && typeof raw === 'object' ? raw : {};
  const labelKey = mod.labelKey ? parseLabelKey(mod.labelKey, 'capabilities.permissions.module.labelKey') : null;
  const label = String(mod.label || fallbackName || '').trim().slice(0, 80);
  const icon = String(mod.icon || fallbackIcon || 'box').trim().slice(0, 40);
  if (!label && !labelKey) throw new Error('capabilities.permissions.module.label or labelKey is required.');
  return {
    label: label || fallbackName || 'Extension',
    icon,
    ...(labelKey ? { labelKey } : {}),
  };
}

/**
 * @param {object} raw manifest root
 * @param {string} moduleId
 * @param {string} basePath absolute module folder
 * @param {(id: string, rel: string) => string} publicUrl
 * @param {(filePath: string) => Promise<boolean>} pathExists
 * @param {(value: string) => boolean} isSafeRelativeFile
 */
export async function normalizeCapabilities(raw, moduleId, basePath, publicUrl, pathExists, isSafeRelativeFile) {
  const caps = raw?.capabilities;
  if (!caps || typeof caps !== 'object') return null;

  const permissionsBlock = caps.permissions && typeof caps.permissions === 'object' ? caps.permissions : {};
  const widgetDecls = Array.isArray(caps.widgets) ? caps.widgets : [];
  const apiBlock = caps.api && typeof caps.api === 'object' ? caps.api : null;

  const needsPermissionModule = widgetDecls.length > 0 || Boolean(apiBlock?.prefix);
  let permissionModule = null;
  if (permissionsBlock.module || needsPermissionModule) {
    permissionModule = normalizePermissionModule(
      permissionsBlock.module,
      raw?.name || moduleId,
      raw?.icon || 'box',
    );
  } else if (Object.keys(permissionsBlock).length > 0) {
    throw new Error('capabilities.permissions.module is required when declaring permissions.');
  }

  const permissionModuleKey = permissionModule ? extensionPermissionKey(moduleId) : null;
  const permWidgetDecls = Array.isArray(permissionsBlock.widgets) ? permissionsBlock.widgets : [];

  const widgets = [];
  const widgetIdSet = new Set();

  for (const decl of widgetDecls) {
    if (!decl || typeof decl !== 'object') throw new Error('Each capabilities.widgets entry must be an object.');
    const shortId = parseWidgetShortId(decl.id, 'Widget id');
    if (widgetIdSet.has(shortId)) throw new Error(`Duplicate widget id "${shortId}".`);
    widgetIdSet.add(shortId);

    const entry = String(decl.entry || '').trim();
    if (!isSafeRelativeFile(entry) || !entry.endsWith('.js')) {
      throw new Error(`Widget "${shortId}" entry must be a safe relative JavaScript file path.`);
    }
    const resolvedEntry = path.resolve(basePath, entry);
    if (!resolvedEntry.startsWith(`${basePath}${path.sep}`) || !(await pathExists(resolvedEntry))) {
      throw new Error(`Widget "${shortId}" entry file does not exist.`);
    }

    const size = String(decl.defaultSize || '1x2').trim();
    if (!VALID_WIDGET_SIZES.has(size)) throw new Error(`Widget "${shortId}" defaultSize is invalid.`);

    const id = fullWidgetId(moduleId, shortId);
    widgets.push({
      id,
      shortId,
      entry: publicUrl(moduleId, entry),
      label: String(decl.label || shortId).trim().slice(0, 80),
      ...(decl.labelKey ? { labelKey: parseLabelKey(decl.labelKey, `Widget "${shortId}" labelKey`) } : {}),
      icon: String(decl.icon || raw?.icon || 'box').trim().slice(0, 40),
      defaultSize: size,
      defaultVisible: decl.defaultVisible === true,
      optionsSchema: normalizeOptionsSchema(decl.optionsSchema),
      moduleKey: permissionModuleKey,
    });
  }

  for (const decl of permWidgetDecls) {
    if (!decl || typeof decl !== 'object') continue;
    const shortId = parseWidgetShortId(decl.id, 'Permission widget id');
    if (!widgetIdSet.has(shortId)) {
      throw new Error(`capabilities.permissions.widgets references unknown widget "${shortId}".`);
    }
  }

  if (widgetDecls.length > 0 && !permissionModule) {
    throw new Error('capabilities.permissions.module is required when declaring widgets.');
  }

  let apiPrefix = null;
  let scopeKey = permissionModuleKey;
  if (apiBlock) {
    // Anchored to this module's id so an extension cannot claim a core
    // prefix (e.g. /api/tasks) and overwrite PREFIX_TO_MODULE. Trailing
    // slashes are stripped; anything other than the exact path is rejected.
    const expected = `/api/extensions/${moduleId}`;
    const prefix = String(apiBlock.prefix || '').trim().replace(/\/+$/, '');
    if (prefix !== expected) {
      throw new Error(`capabilities.api.prefix must be ${expected}.`);
    }
    apiPrefix = prefix;
    if (apiBlock.scopeKey) {
      const custom = String(apiBlock.scopeKey).trim();
      if (custom !== extensionPermissionKey(moduleId)) {
        throw new Error('capabilities.api.scopeKey must be ext:{moduleId}.');
      }
      scopeKey = custom;
    }
    if (!permissionModule) {
      throw new Error('capabilities.permissions.module is required when declaring api.prefix.');
    }
  }

  if (!widgets.length && !permissionModule && !apiPrefix) return null;

  return {
    permissionModuleKey,
    permissionModule,
    widgets,
    apiPrefix,
    scopeKey,
  };
}

/** Build permission/scope catalog entries from normalized module list. */
export function buildExtensionCatalog(modules) {
  const permissionModules = [];
  const permissionWidgets = [];
  const scopeModules = [];

  for (const mod of modules) {
    if (!mod?.capabilities || mod.status !== 'enabled' || !mod.enabled) continue;
    const caps = mod.capabilities;
    if (caps.permissionModule) {
      permissionModules.push({
        key: caps.permissionModuleKey,
        label: caps.permissionModule.label,
        labelKey: caps.permissionModule.labelKey || null,
        icon: caps.permissionModule.icon,
        navIds: [`third-party-${mod.id}`],
        extensionModuleId: mod.id,
      });
    }
    for (const w of caps.widgets || []) {
      permissionWidgets.push({
        id: w.id,
        module: caps.permissionModuleKey || null,
        label: w.label,
        labelKey: w.labelKey || null,
      });
    }
    if (caps.apiPrefix && caps.scopeKey) {
      const segment = caps.apiPrefix.replace(/^\/api\//, '').replace(/\/+$/, '');
      scopeModules.push({ key: caps.scopeKey, prefixes: [segment] });
    }
  }

  return { permissionModules, permissionWidgets, scopeModules };
}
