/**
 * Test: Extension dashboard widgets (client utils)
 * Run: node --test test/test-extension-widgets.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { withoutBlockComments } from './source-text.js';

const ext = await import('../public/utils/extension-widgets.js');

const savedExtWidget = {
  id: 'akahu:balance',
  visible: true,
  order: 1,
  size: '2x2',
  options: { account: 'savings' },
};

const sampleModules = [{
  id: 'demo-ext',
  enabled: true,
  status: 'enabled',
  capabilities: {
    permissionModuleKey: 'ext:demo-ext',
    widgets: [{
      id: 'demo-ext:summary',
      shortId: 'summary',
      entry: '/api/v1/modules/assets/demo-ext/widgets/summary.js',
      label: 'Summary',
      icon: 'box',
      defaultSize: '1x2',
      defaultVisible: false,
      moduleKey: 'ext:demo-ext',
    }],
  },
}];

test('extension widget ids merge with core widgets', () => {
  ext.setExtensionModules(sampleModules);
  const ids = ext.allWidgetIds();
  assert.ok(ids.includes('tasks'));
  assert.ok(ids.includes('demo-ext:summary'));
});

test('normalizeDashboardConfigWithExtensions keeps extension widget ids', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.normalizeDashboardConfigWithExtensions([
    { id: 'demo-ext:summary', visible: true, order: 0, size: '1x2' },
  ]);
  assert.ok(cfg.some((w) => w.id === 'demo-ext:summary'));
});

test('isExtensionWidget detects namespaced ids', () => {
  assert.equal(ext.isExtensionWidget('demo-ext:summary'), true);
  assert.equal(ext.isExtensionWidget('budget'), false);
});

test('buildDefaultWidgetConfig inserts extension widgets before weather', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.buildDefaultWidgetConfig();
  const summaryIdx = cfg.findIndex((w) => w.id === 'demo-ext:summary');
  const weatherIdx = cfg.findIndex((w) => w.id === 'weather');
  assert.ok(summaryIdx >= 0);
  assert.ok(weatherIdx >= 0);
  assert.ok(summaryIdx < weatherIdx);
});

test('normalizeDashboardConfigWithExtensions inserts a missing first id at 0, not the end', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.normalizeDashboardConfigWithExtensions([
    { id: 'calendar', visible: true, order: 0, size: '1x2' },
  ]);
  assert.equal(cfg[0].id, 'tasks');
  assert.notEqual(cfg[cfg.length - 1].id, 'tasks');
});

test('selectThirdPartyModuleList keeps the previous list when the request fails', () => {
  const previous = [{ id: 'akahu', enabled: true, status: 'enabled' }];
  assert.deepEqual(
    ext.selectThirdPartyModuleList(previous, { ok: false }),
    previous,
  );
  assert.deepEqual(
    ext.selectThirdPartyModuleList(previous, { ok: false, data: [] }),
    previous,
  );
});

test('selectThirdPartyModuleList treats a successful empty array as "no modules exist"', () => {
  const previous = [{ id: 'akahu', enabled: true, status: 'enabled' }];
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: [] }), []);
});

test('selectThirdPartyModuleList keeps previous when a successful body is not an array', () => {
  const previous = [{ id: 'akahu' }];
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: null }), previous);
  assert.deepEqual(ext.selectThirdPartyModuleList(previous, { ok: true, data: { id: 'x' } }), previous);
});

test('syncThirdPartyModules uses selectThirdPartyModuleList instead of clearing on error', () => {
  const raw = readFileSync(new URL('../public/router.js', import.meta.url), 'utf8');
  const start = raw.indexOf('async function syncThirdPartyModules');
  const end = raw.indexOf('function moduleSnapshot', start);
  assert.ok(start >= 0 && end > start, 'syncThirdPartyModules must precede moduleSnapshot');
  const body = raw.slice(start, end).replace(/^\s*\/\/.*$/gm, '');
  assert.equal(body.includes('selectThirdPartyModuleList'), true);
  assert.equal(/catch\s*\{[^}]*_thirdPartyModules\s*=\s*\[\]/.test(body), false);
});

test('normalizeDashboardConfigWithExtensions keeps unknown ext widgets when the catalog is empty', () => {
  ext.setExtensionModules([]);
  const cfg = ext.normalizeDashboardConfigWithExtensions([savedExtWidget]);
  const kept = cfg.find((w) => w.id === 'akahu:balance');
  assert.ok(kept, 'akahu:balance must survive an empty catalog');
  assert.equal(kept.visible, true);
  assert.equal(kept.size, '2x2');
  assert.deepEqual(kept.options, { account: 'savings' });
});

test('normalizeDashboardConfigWithExtensions keeps ext widgets of a disabled module', () => {
  ext.setExtensionModules([{
    id: 'akahu',
    enabled: false,
    status: 'disabled',
    capabilities: {
      widgets: [{ id: 'akahu:balance', defaultSize: '1x2' }],
    },
  }]);
  const cfg = ext.normalizeDashboardConfigWithExtensions([savedExtWidget]);
  const kept = cfg.find((w) => w.id === 'akahu:balance');
  assert.ok(kept, 'disabled-module layout must come back on re-enable');
  assert.deepEqual(kept.options, { account: 'savings' });
  assert.equal(kept.size, '2x2');
});

test('normalizeDashboardConfigWithExtensions still drops unknown core widget ids', () => {
  ext.setExtensionModules(sampleModules);
  const cfg = ext.normalizeDashboardConfigWithExtensions([
    { id: 'not-a-widget', visible: true, order: 0, size: '1x2' },
  ]);
  assert.equal(cfg.some((w) => w.id === 'not-a-widget'), false);
});

test('openExtensionWidgetOptions uses its own empty-schema copy, not the task-categories one', () => {
  const src = withoutBlockComments(
    readFileSync(new URL('../public/pages/dashboard.js', import.meta.url), 'utf8'),
  ).replace(/^\s*\/\/.*$/gm, '');
  const start = src.indexOf('async function openExtensionWidgetOptions');
  const end = src.indexOf('async function openWidgetOptions', start);
  assert.ok(start >= 0 && end > start, 'openExtensionWidgetOptions must precede openWidgetOptions');
  const body = src.slice(start, end);
  assert.equal(body.includes('optionTaskCategoriesEmpty'), false);
  assert.equal(body.includes('optionExtensionEmpty'), true);
  assert.equal(src.includes('optionTaskCategoriesEmpty'), true);
});
