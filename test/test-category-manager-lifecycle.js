/**
 * Verifies that a page refresh survives the category manager modal closing
 * before its asynchronous DELETE request completes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.HTMLElement = class HTMLElement extends EventTarget {};
globalThis.CustomEvent = class CustomEvent extends Event {
  constructor(type, init = {}) {
    super(type, init);
    this.detail = init.detail;
  }
};
globalThis.window = { yuvomi: { showToast() {} } };
globalThis.CSS = { escape: String };

let CategoryManager;
globalThis.customElements = {
  define(name, constructor) {
    if (name === 'yuvomi-category-manager') CategoryManager = constructor;
  },
};

const { api } = await import('/api.js');
await import('../public/components/category-manager.js');

function managerWithCategory(onChanged, options = {}) {
  const manager = new CategoryManager();
  manager._renderShell = () => {};
  manager._load = () => {};
  manager.configure({ basePath: '/notes/categories', onChanged, ...options });
  manager._cats = [{ id: 7, name: 'Old', scope: 'personal' }];
  manager._renderGroup = () => {};
  return manager;
}

test('configured row icon resolver controls the rendered category glyph', () => {
  const manager = managerWithCategory(() => {}, {
    rowIconResolver: (category) => category.scope === 'personal' ? 'user-round' : 'house',
  });

  const markup = manager._markHtml({ id: 7, name: 'Old', scope: 'personal', icon: 'fallback' });

  assert.match(markup, /data-lucide="user-round"/);
  assert.doesNotMatch(markup, /data-lucide="fallback"/);
});

test('configured scope label key labels the unified scope selector', () => {
  const manager = managerWithCategory(() => {}, {
    unifiedAdd: true,
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
    addScopeLabelKey: 'custom.scope.label',
  });

  assert.match(manager._unifiedAddFormHtml(), /aria-label="custom\.scope\.label"/);
});

test('configured group field renders categories returned with a scope', () => {
  const manager = managerWithCategory(() => {}, {
    groupField: 'scope',
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
  });
  manager._cats = [
    { id: 7, name: 'Mine', scope: 'personal' },
    { id: 8, name: 'Family', scope: 'household' },
  ];

  const markup = manager._groupSectionHtml(manager._groups[1]);

  assert.match(markup, />Family</);
  assert.doesNotMatch(markup, />Mine</);
});

test('configured group field submits a household category with the API scope contract', async () => {
  let posted;
  api.post = async (path, body) => {
    posted = { path, body };
    return { data: { id: 8, ...body } };
  };
  const manager = managerWithCategory(() => {}, {
    groupField: 'scope',
    groups: [
      { key: 'personal', labelKey: 'personal.label' },
      { key: 'household', labelKey: 'household.label' },
    ],
    unifiedAdd: true,
  });
  const input = { value: 'Family' };
  const form = {
    dataset: { group: 'personal' },
    querySelector(selector) {
      return selector === 'input' ? input : { value: 'household' };
    },
  };

  await manager._onSubmit({
    preventDefault() {},
    target: { closest: (selector) => selector === '.cat-add-form' ? form : null },
  });

  assert.deepEqual(posted, {
    path: '/notes/categories',
    body: { name: 'Family', scope: 'household' },
  });
  assert.equal(manager._cats.at(-1).scope, 'household');
});

test('successful delayed delete refreshes the page after the modal listener is gone', async () => {
  let finishDelete;
  let signalDeleteStarted;
  const deleteStarted = new Promise((resolve) => { signalDeleteStarted = resolve; });
  api.delete = () => {
    signalDeleteStarted();
    return new Promise((resolve) => { finishDelete = resolve; });
  };

  const callbackDetails = [];
  let eventCount = 0;
  const manager = managerWithCategory((detail) => { callbackDetails.push(detail); });
  const listener = () => { eventCount += 1; };
  manager.addEventListener('category-manager-changed', listener);

  // test-browser-loader.mjs already resolves confirmOverModal() to true. Wait
  // for the request itself instead of assuming the dynamic import and confirm
  // have both completed after one event-loop turn.
  const deletion = manager._delete('7');
  await deleteStarted;

  // openNoteCategoryManager used to do this synchronously from modal onClose.
  manager.removeEventListener('category-manager-changed', listener);
  finishDelete({ data: null });
  await deletion;

  assert.deepEqual(callbackDetails.map(({ action, key }) => ({ action, key })), [{ action: 'delete', key: '7' }]);
  assert.equal(eventCount, 0);
  assert.deepEqual(manager._cats, []);
});

test('failed delete keeps the category and does not report a successful change', async () => {
  api.delete = async () => { throw new Error('offline'); };
  let callbackCount = 0;
  let eventCount = 0;
  const manager = managerWithCategory(() => { callbackCount += 1; });
  manager.addEventListener('category-manager-changed', () => { eventCount += 1; });

  await manager._delete('7');

  assert.equal(callbackCount, 0);
  assert.equal(eventCount, 0);
  assert.equal(manager._cats.length, 1);
});

test('a failing page refresh does not suppress the successful legacy event', () => {
  let eventCount = 0;
  const originalError = console.error;
  console.error = () => {};
  try {
    const manager = managerWithCategory(() => { throw new Error('render failed'); });
    manager.addEventListener('category-manager-changed', () => { eventCount += 1; });
    assert.doesNotThrow(() => manager._notifyChanged());
    assert.equal(eventCount, 1);
  } finally {
    console.error = originalError;
  }
});
