/**
 * Browser state and orchestration for undoable destructive folder deletion.
 * The module keeps pending removals as an overlay over freshly loaded server
 * data, so leaving and re-entering Documents cannot resurrect a pending row.
 */

const pendingByState = new WeakMap();

/**
 * Build an async loader that applies only its newest response. A request that
 * started before a later reconciliation may still resolve last; accepting it
 * would resurrect the older server snapshot in the UI.
 */
export function createLatestResponseApplier() {
  let generation = 0;
  return async (request, apply) => {
    const current = ++generation;
    let result;
    try {
      result = await request();
    } catch (err) {
      if (current !== generation) return false;
      throw err;
    }
    if (current !== generation) return false;
    await apply(result);
    return true;
  };
}

/** Map delayed folder-delete conflicts to view-independent UI feedback. */
export function delayedFolderDeleteErrorToast(err) {
  if (err?.status === 409 && err.data?.reason === 'FOLDER_CONTENT_CHANGED') {
    return {
      key: 'documents.folderDeleteContentsChangedBeforeCommitToast',
      type: 'warning',
    };
  }
  return null;
}

function pendingState(state) {
  let pending = pendingByState.get(state);
  if (!pending) {
    pending = {
      folderOrder: state.folders.map(({ id }) => Number(id)),
      documentOrder: state.allDocuments.map(({ id }) => Number(id)),
      operations: new Set(),
    };
    pendingByState.set(state, pending);
  }
  return pending;
}

function mergeInCanonicalOrder(current, restored, originalOrder) {
  const currentById = new Map(current.map((item) => [Number(item.id), item]));
  const restoredById = new Map(restored.map((item) => [Number(item.id), item]));
  const merged = [];
  for (const id of originalOrder) {
    const item = currentById.get(id) ?? restoredById.get(id);
    if (item) merged.push(item);
    currentById.delete(id);
  }
  merged.push(...currentById.values());
  return merged;
}

function activeFolderIds(pending) {
  const ids = new Set();
  for (const operation of pending?.operations || []) {
    for (const id of operation.folderIds) ids.add(id);
  }
  return ids;
}

/** Apply all pending folder tombstones after an optimistic change or server load. */
export function applyPendingFolderDeleteOverlay(
  state,
  { freshFolders = false, freshDocuments = false } = {},
) {
  const pending = pendingByState.get(state);
  if (freshFolders && pending) {
    pending.folderOrder = state.folders.map(({ id }) => Number(id));
    for (const operation of pending.operations) {
      operation.removedFolders = state.folders
        .filter(({ id }) => operation.folderIds.has(Number(id)));
    }
  }
  if (freshDocuments && pending) {
    pending.documentOrder = state.allDocuments.map(({ id }) => Number(id));
    for (const operation of pending.operations) {
      operation.removedDocuments = state.allDocuments
        .filter(({ folder_id }) => operation.folderIds.has(Number(folder_id)));
    }
  }

  const ids = activeFolderIds(pending);
  if (!ids.size) return;
  const hiddenDocuments = new Set(
    state.allDocuments
      .filter(({ folder_id }) => ids.has(Number(folder_id)))
      .map(({ id }) => Number(id)),
  );
  state.folders = state.folders.filter(({ id }) => !ids.has(Number(id)));
  state.allDocuments = state.allDocuments.filter(({ id }) => !hiddenDocuments.has(Number(id)));
  state.selected = new Set([...state.selected].filter((id) => !hiddenDocuments.has(Number(id))));
  if (ids.has(Number(state.folderId))) state.folderId = '';
}

/**
 * Start an optimistic state transition. Undo restores data, but deliberately
 * does not restore selection or navigation: those are user intent and may
 * have changed while the toast was visible.
 */
export function beginOptimisticFolderDelete(state, folderIds) {
  const pending = pendingState(state);
  const ids = new Set([...folderIds].map(Number));
  const operation = {
    folderIds: ids,
    removedFolders: state.folders.filter(({ id }) => ids.has(Number(id))),
    removedDocuments: state.allDocuments.filter(({ folder_id }) => ids.has(Number(folder_id))),
  };
  pending.operations.add(operation);
  applyPendingFolderDeleteOverlay(state);

  let settled = false;
  const finish = () => {
    if (settled) return false;
    settled = true;
    pending.operations.delete(operation);
    return true;
  };

  return {
    restore() {
      if (!finish()) return false;
      state.folders = mergeInCanonicalOrder(
        state.folders,
        operation.removedFolders,
        pending.folderOrder,
      );
      state.allDocuments = mergeInCanonicalOrder(
        state.allDocuments,
        operation.removedDocuments,
        pending.documentOrder,
      );
      applyPendingFolderDeleteOverlay(state);
      if (!pending.operations.size) pendingByState.delete(state);
      return true;
    },
    commit() {
      if (!finish()) return false;
      applyPendingFolderDeleteOverlay(state);
      if (!pending.operations.size) pendingByState.delete(state);
      return true;
    },
  };
}

/**
 * Connect the optimistic state transition to the shared Undo scheduler.
 * Dependencies are arguments so lifecycle, failure and keepalive behavior can
 * be verified without a DOM or network.
 */
export function scheduleFolderDeleteWithUndo({
  state,
  folderIds,
  message,
  schedule,
  requestDelete,
  isViewActive,
  applyResult,
  handleError,
  handleApplyError = handleError,
  render,
}) {
  const transition = beginOptimisticFolderDelete(state, folderIds);
  render();
  schedule({
    message,
    commit: async ({ keepalive }) => {
      const result = await requestDelete({ keepalive });
      transition.commit();
      if (keepalive || !isViewActive()) return;
      try {
        await applyResult(result);
      } catch (err) {
        await handleApplyError(err);
      }
    },
    restore: (err) => {
      if (!transition.restore()) return;
      if (isViewActive()) render();
      if (err) void handleError(err);
    },
  });
  return transition;
}
