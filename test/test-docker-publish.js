import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(
  new URL('../.github/workflows/docker-publish.yml', import.meta.url),
  'utf8'
);
const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
const installation = readFileSync(new URL('../docs/installation.md', import.meta.url), 'utf8');

function namedWorkflowStep(source, name) {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === `      - name: ${name}`);
  assert.notEqual(start, -1, `The ${name} workflow step must exist`);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() && /^ {0,6}\S/.test(line)) break;
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('Docker publish treats the remote build cache as an optional optimization', () => {
  assert.match(
    workflow,
    /cache-to:\s*type=gha,mode=max,ignore-error=true/,
    'A failed GitHub Actions cache export must not fail an otherwise successful image push'
  );
});

test('Docker publishing injects the immutable Git revision into the image', () => {
  const runtimeStage = dockerfile.slice(dockerfile.lastIndexOf('\nFROM ') + 1);
  const revisionArg = runtimeStage.indexOf('\nARG APP_BUILD_REVISION\n');
  const revisionEnv = runtimeStage.indexOf('\nENV APP_BUILD_REVISION=${APP_BUILD_REVISION}\n');
  assert.notEqual(revisionArg, -1, 'The runtime stage must declare APP_BUILD_REVISION');
  assert.ok(revisionEnv > revisionArg, 'ARG APP_BUILD_REVISION must precede the ENV that expands it');
  assert.ok(
    revisionArg > runtimeStage.lastIndexOf('\nRUN ')
      && revisionArg > runtimeStage.lastIndexOf('\nCOPY '),
    'The per-commit revision must not invalidate stable runtime filesystem layers',
  );

  const buildStep = namedWorkflowStep(workflow, 'Build and push');
  assert.match(buildStep, /uses: docker\/build-push-action@/);
  assert.match(
    buildStep,
    /build-args:\s*\|\s*APP_BUILD_REVISION=\$\{\{ github\.sha \}\}/,
  );
});

test('every base image is pinned to a digest, and both stages share it', () => {
  // Ein Tag wie node:24-slim ist eine Behauptung ueber das Image, der Digest ist
  // das Image. Dependabot (docker) hebt Digest und Tag zusammen; ein FROM ohne
  // Digest wuerde beim naechsten Bump lautlos zurueckfallen.
  const froms = dockerfile.split('\n').filter((l) => /^FROM /.test(l));
  assert.ok(froms.length >= 2, 'expected a build and a runtime stage');
  const digests = froms.map((l) => l.match(/^FROM node:(\d+)-slim@(sha256:[0-9a-f]{64})(?:\s+AS\s+\w+)?$/));
  digests.forEach((m, i) => assert.ok(m, `FROM line ${i + 1} must be node:<major>-slim@sha256:<digest>: ${froms[i]}`));
  assert.equal(new Set(digests.map((m) => m[2])).size, 1, 'build and runtime stage must pin the same digest');
});

test('CI tests the Node major the image runs on', () => {
  // Bis zum 4.9.2026 lief die CI auf 22.x, das Image auf 24: kein Test hatte je
  // die Version gesehen, die bei den Nutzern laeuft. Die Matrix muss den Major
  // des Dockerfiles enthalten; die Entwicklungs-Baseline aus package.json engines
  // bleibt daneben stehen.
  const imageMajor = dockerfile.match(/^FROM node:(\d+)-slim@/m)?.[1];
  assert.ok(imageMajor, 'Dockerfile must name a Node major');
  const matrix = ci.match(/node-version:\s*\[([^\]]+)\]/)?.[1];
  assert.ok(matrix, 'ci.yml must have a node-version matrix');
  const majors = matrix.split(',').map((v) => v.trim().replace(/\.x$/, ''));
  assert.ok(majors.includes(imageMajor), `CI matrix [${matrix}] must include the image's Node ${imageMajor}`);
});

test('the image carries provenance and an SBOM, and is signed by digest under both names', () => {
  // Eine Signatur per TAG waere wertlos: das Tag kann nachtraeglich verschoben
  // werden, der Digest nennt genau den Index, der eben gepusht wurde. Beide
  // Bildnamen (yuvomi und der oikos-Spiegel) teilen ihn, also brauchen beide
  // die Signatur - ein Legacy-Setup prueft sonst gegen ein unsigniertes Bild.
  const buildStep = namedWorkflowStep(workflow, 'Build and push');
  assert.match(buildStep, /^\s+id: build$/m, 'the build step must expose its digest under a stable id');
  assert.match(buildStep, /^\s+provenance: true$/m);
  assert.match(buildStep, /^\s+sbom: true$/m);

  const signStep = namedWorkflowStep(workflow, 'Sign the image');
  assert.match(signStep, /DIGEST: \$\{\{ steps\.build\.outputs\.digest \}\}/);
  const signs = signStep.match(/cosign sign --yes "[^"]*@\$\{DIGEST\}"/g) || [];
  assert.equal(signs.length, 2, 'both image names must be signed by digest');
  assert.ok(signs.some((l) => l.includes('${REGISTRY}/${IMAGE_NAME}@')), 'primary image signed');
  assert.ok(signs.some((l) => l.includes('${MIRROR}@')), 'oikos mirror signed');
  assert.match(signStep, /oikos|MIRROR/);
  assert.doesNotMatch(signStep, /cosign sign --yes "[^"]*:\$\{\{/, 'never sign by tag');

  const permissions = workflow.slice(workflow.indexOf('\npermissions:'), workflow.indexOf('\nenv:'));
  assert.match(permissions, /^\s+id-token: write$/m, 'keyless signing needs the OIDC token');
  assert.match(workflow, /uses: sigstore\/cosign-installer@[0-9a-f]{40} # v/);
});

test('the installation guide verifies against this workflow identity', () => {
  // Der Verify-Befehl ist die Zusage nach aussen. Er muss den OIDC-Issuer von
  // GitHub und den Pfad DIESER Workflow-Datei an einem Release-Tag nennen; ein
  // umbenannter Workflow liesse jeden Betreiber ins Leere pruefen, und ein
  // Muster ohne "refs/tags/v" wuerde auch den beweglichen main-Build annehmen.
  const block = installation.match(/cosign verify[\s\S]*?refs\/tags\/v'/);
  assert.ok(block, 'installation.md must show a cosign verify command');
  assert.match(block[0], /--certificate-oidc-issuer https:\/\/token\.actions\.githubusercontent\.com/);
  assert.match(block[0], /--certificate-identity-regexp '\^https:\/\/github\.com\/ulsklyc\/yuvomi\/\.github\/workflows\/docker-publish\.yml@refs\/tags\/v'/);
  assert.match(workflow, /^name: Docker Publish$/m);
});
