/**
 * Browser state transition for an undoable destructive folder deletion.
 * The server request is deliberately owned by the page and runs later.
 */

/**
 * Hide one folder subtree and its currently loaded documents immediately.
 * The returned function merges only those removed IDs back, preserving UI
 * changes that happened during the Undo window.
 *
 * @param {{folders: Array<{id:number}>, allDocuments: Array<{id:number,folder_id?:number|null}>, selected:Set<number>, expanded:Set<number>, folderId:string|number}} state
 * @param {Set<number>} folderIds
 * @returns {() => void}
 */
export function optimisticallyHideFolderSubtree(state, folderIds) {
  const ids = new Set([...folderIds].map(Number));
  const originalFolderOrder = state.folders.map(({ id }) => Number(id));
  const originalDocumentOrder = state.allDocuments.map(({ id }) => Number(id));
  const removedFolders = state.folders.filter(({ id }) => ids.has(Number(id)));
  const removedDocuments = state.allDocuments.filter(({ folder_id }) => ids.has(Number(folder_id)));
  const removedDocumentIds = new Set(removedDocuments.map(({ id }) => Number(id)));
  const removedSelected = [...state.selected].filter((id) => removedDocumentIds.has(Number(id)));
  const removedExpanded = [...state.expanded].filter((id) => ids.has(Number(id)));
  const previousFolderId = state.folderId;
  const activeFolderWasRemoved = ids.has(Number(previousFolderId));

  state.folders = state.folders.filter(({ id }) => !ids.has(Number(id)));
  state.allDocuments = state.allDocuments.filter(({ id }) => !removedDocumentIds.has(Number(id)));
  state.selected = new Set([...state.selected].filter((id) => !removedDocumentIds.has(Number(id))));
  state.expanded = new Set([...state.expanded].filter((id) => !ids.has(Number(id))));
  if (activeFolderWasRemoved) state.folderId = '';

  const mergeInOriginalOrder = (current, removed, originalOrder) => {
    const currentById = new Map(current.map((item) => [Number(item.id), item]));
    const removedById = new Map(removed.map((item) => [Number(item.id), item]));
    const merged = [];
    for (const id of originalOrder) {
      const item = currentById.get(id) ?? removedById.get(id);
      if (item) merged.push(item);
      currentById.delete(id);
    }
    merged.push(...currentById.values());
    return merged;
  };

  return () => {
    state.folders = mergeInOriginalOrder(state.folders, removedFolders, originalFolderOrder);
    state.allDocuments = mergeInOriginalOrder(
      state.allDocuments,
      removedDocuments,
      originalDocumentOrder,
    );
    state.selected = new Set([...state.selected, ...removedSelected]);
    state.expanded = new Set([...state.expanded, ...removedExpanded]);
    if (activeFolderWasRemoved && state.folderId === '') state.folderId = previousFolderId;
  };
}
