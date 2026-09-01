/**
 * Module: Service worker build revision
 * Purpose: Keep same-version acceptance images from reusing an older PWA shell.
 * Run: node --test test/test-service-worker-build-revision.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const serviceWorkerModule = await import('../server/utils/service-worker.js').catch(() => ({}));

test('renders a distinct service worker response for each same-version build revision', () => {
  assert.equal(typeof serviceWorkerModule.renderServiceWorkerSource, 'function');

  const template = "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';";
  const first = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-a');
  const second = serviceWorkerModule.renderServiceWorkerSource(template, 'acceptance-b');

  assert.equal(first, "globalThis.cacheRevision = 'acceptance-a';");
  assert.equal(second, "globalThis.cacheRevision = 'acceptance-b';");
  assert.notEqual(first, second);
});

test('the shipped service worker gives same-version builds different cache namespaces', () => {
  const source = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
  const first = serviceWorkerModule.renderServiceWorkerSource(source, 'acceptance-a');
  const second = serviceWorkerModule.renderServiceWorkerSource(source, 'acceptance-b');

  assert.notEqual(first, second);
  assert.match(first, /const APP_BUILD_REVISION\s*=\s*'acceptance-a'/);
  assert.match(first, /yuvomi-shell-\$\{CACHE_RELEASE\}/);
  assert.doesNotMatch(first, /__YUVOMI_BUILD_REVISION__/);
});

test('builds a non-cacheable service worker response and falls back to the app version', () => {
  assert.equal(typeof serviceWorkerModule.buildServiceWorkerResponse, 'function');

  const response = serviceWorkerModule.buildServiceWorkerResponse(
    "globalThis.cacheRevision = '__YUVOMI_BUILD_REVISION__';",
    { appVersion: '2.59.0', buildRevision: '' },
  );

  assert.deepEqual(response, {
    body: "globalThis.cacheRevision = '2.59.0';",
    contentType: 'text/javascript; charset=utf-8',
    cacheControl: 'no-store, max-age=0',
    cdnCacheControl: 'no-store',
    cloudflareCdnCacheControl: 'no-store',
  });
});
