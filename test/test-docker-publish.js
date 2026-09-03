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
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  assert.match(runtimeStage, /^ARG APP_BUILD_REVISION$/m);
  assert.match(runtimeStage, /^ENV APP_BUILD_REVISION=\$\{APP_BUILD_REVISION\}$/m);
  assert.ok(
    runtimeStage.indexOf('ARG APP_BUILD_REVISION') > runtimeStage.lastIndexOf('\nRUN ')
      && runtimeStage.indexOf('ARG APP_BUILD_REVISION') > runtimeStage.lastIndexOf('\nCOPY '),
    'The per-commit revision must not invalidate stable runtime filesystem layers',
  );

  const buildStepStart = workflow.indexOf('      - name: Build and push');
  assert.notEqual(buildStepStart, -1, 'The Docker build-and-push step must exist');
  const nextStep = workflow.indexOf('\n      - name:', buildStepStart + 1);
  const buildStep = workflow.slice(buildStepStart, nextStep === -1 ? undefined : nextStep);
  assert.match(buildStep, /uses: docker\/build-push-action@v7/);
  assert.match(
    buildStep,
    /build-args:\s*\|\s*APP_BUILD_REVISION=\$\{\{ github\.sha \}\}/,
  );
});
