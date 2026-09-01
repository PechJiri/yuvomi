/**
 * Folder-directory upload planning and execution.
 *
 * Run: node --test test/test-folder-upload.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFolderUploadPlan,
  executeFolderUploadPlan,
  formatFolderUploadTimestamp,
} from '../public/utils/folder-upload.js';

function file(path, {
  size = 128,
  type = 'application/pdf',
  name = path.split('/').at(-1),
} = {}) {
  return { name, size, type, webkitRelativePath: path };
}

const baseOptions = {
  folders: [
    { id: 10, name: 'Projects', parent_id: null },
  ],
  documents: [],
  targetFolderId: 10,
  maxFileSize: 5 * 1024 * 1024,
  allowedMimeTypes: ['application/pdf'],
  timestamp: '2026-08-31 22-30',
};

test('formats the duplicate suffix without locale-dependent punctuation', () => {
  assert.equal(
    formatFolderUploadTimestamp(new Date(2026, 7, 31, 22, 30, 45)),
    '2026-08-31 22-30',
  );
});

test('creates the selected root and nests its files and child folders below it', () => {
  const plan = buildFolderUploadPlan([
    file('House/permit.pdf'),
    file('House/Drawings/floor.pdf'),
    file('House/Drawings/Electrical/wiring.pdf'),
  ], baseOptions);

  assert.equal(plan.rootName, 'House');
  assert.deepEqual(
    plan.folders.map(({ key, parentRef, action }) => ({ key, parentRef, action })),
    [
      { key: 'House', parentRef: 'id:10', action: 'create' },
      { key: 'House/Drawings', parentRef: 'plan:House', action: 'create' },
      { key: 'House/Drawings/Electrical', parentRef: 'plan:House/Drawings', action: 'create' },
    ],
  );
  assert.deepEqual(
    plan.files.map(({ relativePath, targetRef, action }) => ({ relativePath, targetRef, action })),
    [
      { relativePath: 'House/permit.pdf', targetRef: 'plan:House', action: 'upload' },
      { relativePath: 'House/Drawings/floor.pdf', targetRef: 'plan:House/Drawings', action: 'upload' },
      { relativePath: 'House/Drawings/Electrical/wiring.pdf', targetRef: 'plan:House/Drawings/Electrical', action: 'upload' },
    ],
  );
});

test('rejects entries without a directory-relative path', () => {
  const orphan = file('', { name: 'orphan.pdf' });
  const plan = buildFolderUploadPlan([orphan], baseOptions);

  assert.equal(plan.files[0].action, 'reject');
  assert.equal(plan.files[0].reason, 'missing-relative-path');
  assert.equal(plan.counts.rejected, 1);
  assert.deepEqual(plan.folders, []);
});

test('rejects traversal and empty path segments before planning folders', () => {
  const plan = buildFolderUploadPlan([
    file('House/../secret.pdf'),
    file('House//blank.pdf'),
  ], baseOptions);

  assert.deepEqual(plan.files.map((entry) => entry.reason), ['unsafe-path', 'unsafe-path']);
  assert.deepEqual(plan.folders, []);
});

test('rejects empty files but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Empty/zero.pdf', { size: 0 }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'empty-file');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Empty']);
});

test('rejects MIME types outside the server-provided allowlist but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Source/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'unsupported-type');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Source']);
});

test('rejects files above the effective server byte limit but preserves their safe folder path', () => {
  const plan = buildFolderUploadPlan([
    file('House/Large/scan.pdf', { size: baseOptions.maxFileSize + 1 }),
  ], baseOptions);

  assert.equal(plan.files[0].reason, 'too-large');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/Large']);
});

test('recreates a subfolder whose only file is rejected when a sibling is uploadable', () => {
  const plan = buildFolderUploadPlan([
    file('House/Accepted/ok.pdf'),
    file('House/RejectedOnly/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);

  assert.deepEqual(
    plan.folders.map((folder) => folder.key),
    ['House', 'House/Accepted', 'House/RejectedOnly'],
  );
  assert.equal(plan.counts.upload, 1);
  assert.equal(plan.counts.rejected, 1);
});

test('executes a safe folder tree even when every selected file is rejected', async () => {
  const plan = buildFolderUploadPlan([
    file('House/RejectedOnly/model.dwg', { type: 'image/vnd.dwg' }),
  ], baseOptions);
  const created = [];

  const result = await executeFolderUploadPlan(plan, {
    createFolder: async ({ name, parentId }) => {
      created.push([name, parentId]);
      return { id: 500 + created.length };
    },
    uploadFile: async () => {
      throw new Error('a rejected file must never reach uploadFile');
    },
  });

  assert.deepEqual(created, [['House', 10], ['RejectedOnly', 501]]);
  assert.equal(result.uploaded.length, 0);
  assert.equal(result.rejected.length, 1);
});

test('rejects overlong names but still preserves safe parent folders', () => {
  const longName = `${'a'.repeat(201)}.pdf`;
  const plan = buildFolderUploadPlan([
    file(`House/${longName}`),
    file(`House/${'b'.repeat(201)}/ok.pdf`),
  ], baseOptions);

  assert.deepEqual(plan.files.map((entry) => entry.reason), ['name-too-long', 'name-too-long']);
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House']);
});

test('counts the selected target depth against the five-level folder limit', () => {
  const plan = buildFolderUploadPlan([
    file('House/A/B/ok.pdf'),
    file('House/A/B/C/too-deep.pdf'),
  ], {
    ...baseOptions,
    folders: [
      { id: 10, name: 'Projects', parent_id: null },
      { id: 11, name: 'House', parent_id: 10 },
    ],
    targetFolderId: 11,
  });

  assert.equal(plan.files[0].action, 'upload');
  assert.equal(plan.files[1].reason, 'too-deep');
  assert.deepEqual(plan.folders.map((folder) => folder.key), ['House', 'House/A', 'House/A/B']);
});

test('merges case-insensitive sibling folder conflicts and follows reused descendants', () => {
  const plan = buildFolderUploadPlan([
    file('House/drawings/electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'HOUSE', parent_id: 10 },
      { id: 20, name: 'Drawings', parent_id: 19 },
      { id: 21, name: 'Electrical', parent_id: 20 },
    ],
    folderDefault: 'merge',
  });

  assert.deepEqual(
    plan.folders.map(({ key, action, targetId, conflict, resolution }) => ({
      key, action, targetId, conflict, resolution,
    })),
    [
      { key: 'House', action: 'reuse', targetId: 19, conflict: true, resolution: 'merge' },
      { key: 'House/drawings', action: 'reuse', targetId: 20, conflict: true, resolution: 'merge' },
      { key: 'House/drawings/electrical', action: 'reuse', targetId: 21, conflict: true, resolution: 'merge' },
    ],
  );
  assert.equal(plan.files[0].targetRef, 'id:21');
  assert.equal(plan.folderConflicts.length, 3);
});

test('duplicates a conflicting folder with one fixed timestamp and numeric fallback', () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/Electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 20, name: 'House', parent_id: 10 },
      { id: 22, name: 'House - 2026-08-31 22-30', parent_id: 10 },
    ],
    folderDefault: 'duplicate',
  });

  assert.equal(plan.folders[0].name, 'House - 2026-08-31 22-30 (2)');
  assert.equal(plan.folders[0].resolution, 'duplicate');
  assert.equal(plan.folders[0].action, 'create');
  assert.equal(plan.folders[1].parentRef, 'plan:House');
  assert.equal(plan.folders[1].conflict, false);
});

test('a per-folder duplicate override replans descendants below the new parent', () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/Electrical/wiring.pdf'),
  ], {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 20, name: 'House', parent_id: 10 },
      { id: 21, name: 'Drawings', parent_id: 20 },
    ],
    folderDefault: 'merge',
    folderOverrides: { House: 'duplicate' },
  });

  assert.equal(plan.folders[0].resolution, 'duplicate');
  assert.equal(plan.folders[0].action, 'create');
  assert.equal(plan.folders[1].conflict, false);
  assert.equal(plan.folders[1].action, 'create');
  assert.equal(plan.folderConflicts.length, 1);
});

test('applies one global resolution to every file conflict', () => {
  const files = [
    file('House/permit.pdf'),
    file('House/Drawings/wire.pdf'),
    file('House/Drawings/new.pdf'),
  ];
  const options = {
    ...baseOptions,
    folders: [
      ...baseOptions.folders,
      { id: 19, name: 'House', parent_id: 10 },
      { id: 20, name: 'Drawings', parent_id: 19 },
    ],
    documents: [
      { id: 101, original_name: 'PERMIT.PDF', folder_id: 19 },
      { id: 102, original_name: 'wire.pdf', folder_id: 20 },
    ],
    folderDefault: 'merge',
    fileDefault: 'skip',
  };
  const skippedPlan = buildFolderUploadPlan(files, options);

  assert.deepEqual(
    skippedPlan.files.map(({ relativePath, action, resolution, uploadOriginalName }) => ({
      relativePath, action, resolution, uploadOriginalName,
    })),
    [
      { relativePath: 'House/permit.pdf', action: 'skip', resolution: 'skip', uploadOriginalName: 'permit.pdf' },
      { relativePath: 'House/Drawings/wire.pdf', action: 'skip', resolution: 'skip', uploadOriginalName: 'wire.pdf' },
      { relativePath: 'House/Drawings/new.pdf', action: 'upload', resolution: null, uploadOriginalName: 'new.pdf' },
    ],
  );
  assert.equal(skippedPlan.fileConflicts.length, 2);
  assert.equal(skippedPlan.counts.skipped, 2);

  const duplicatePlan = buildFolderUploadPlan(files, { ...options, fileDefault: 'duplicate' });
  assert.deepEqual(
    duplicatePlan.fileConflicts.map(({ action, resolution, uploadOriginalName }) => ({
      action, resolution, uploadOriginalName,
    })),
    [
      { action: 'upload', resolution: 'duplicate', uploadOriginalName: 'permit - 2026-08-31 22-30.pdf' },
      { action: 'upload', resolution: 'duplicate', uploadOriginalName: 'wire - 2026-08-31 22-30.pdf' },
    ],
  );
});

test('executes folders parent-first and never overlaps folder or file writes', async () => {
  const plan = buildFolderUploadPlan([
    file('House/Drawings/floor.pdf'),
    file('House/Drawings/Electrical/wiring.pdf'),
  ], baseOptions);
  const calls = [];
  let active = 0;
  let maxActive = 0;
  let nextFolderId = 100;
  const operation = async (label, result) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    calls.push(label);
    await Promise.resolve();
    active -= 1;
    return result;
  };

  const result = await executeFolderUploadPlan(plan, {
    createFolder: ({ name, parentId }) => operation(`folder:${name}:${parentId}`, { id: nextFolderId++ }),
    uploadFile: ({ originalName, folderId }) => operation(`file:${originalName}:${folderId}`, { id: 200 }),
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(calls, [
    'folder:House:10',
    'folder:Drawings:100',
    'folder:Electrical:101',
    'file:floor.pdf:101',
    'file:wiring.pdf:102',
  ]);
  assert.equal(result.createdFolders.length, 3);
  assert.equal(result.uploaded.length, 2);
  assert.equal(result.failed.length, 0);
});

test('a failed folder blocks only its branch while a sibling still uploads', async () => {
  const plan = buildFolderUploadPlan([
    file('House/Broken/Child/no.pdf'),
    file('House/Working/yes.pdf'),
  ], baseOptions);
  let nextId = 300;
  const uploaded = [];

  const result = await executeFolderUploadPlan(plan, {
    createFolder: async ({ name }) => {
      if (name === 'Broken') throw new Error('storage unavailable');
      return { id: nextId++ };
    },
    uploadFile: async ({ originalName }) => {
      uploaded.push(originalName);
      return { id: 400 };
    },
  });

  assert.deepEqual(uploaded, ['yes.pdf']);
  assert.deepEqual(
    result.failed.map(({ kind, item, reason }) => [kind, item.key || item.relativePath, reason]),
    [
      ['folder', 'House/Broken', 'storage unavailable'],
      ['folder', 'House/Broken/Child', 'parent-failed'],
      ['file', 'House/Broken/Child/no.pdf', 'parent-failed'],
    ],
  );
  assert.equal(result.uploaded.length, 1);
});
