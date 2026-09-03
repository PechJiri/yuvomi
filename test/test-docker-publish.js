import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/docker-publish.yml', import.meta.url),
  'utf8'
);
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');

test('Docker publish treats the remote build cache as an optional optimization', () => {
  assert.match(
    workflow,
    /cache-to:\s*type=gha,mode=max,ignore-error=true/,
    'A failed GitHub Actions cache export must not fail an otherwise successful image push'
  );
});

test('Docker publishing injects the immutable Git revision into the image', () => {
  assert.match(dockerfile, /^ARG APP_BUILD_REVISION$/m);
  assert.match(dockerfile, /^ENV APP_BUILD_REVISION=\$\{APP_BUILD_REVISION\}$/m);
  assert.match(
    workflow,
    /build-args:\s*\|\s*APP_BUILD_REVISION=\$\{\{ github\.sha \}\}/,
  );
});
