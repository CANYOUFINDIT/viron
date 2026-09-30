export function reorderIds(
  ids: readonly string[],
  draggedId: string,
  targetId: string,
  insertAfter: boolean,
): string[] {
  if (!draggedId || !targetId || draggedId === targetId) return [...ids];
  if (!ids.includes(draggedId) || !ids.includes(targetId)) return [...ids];
  const reordered = ids.filter((id) => id !== draggedId);
  const targetIndex = reordered.indexOf(targetId);
  reordered.splice(targetIndex + (insertAfter ? 1 : 0), 0, draggedId);
  return reordered;
}

export function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

/** Places `subsetIds` into the positions those ids already occupy, leaving every other id in place. */
export function applySubsetOrder(fullIds: readonly string[], subsetIds: readonly string[]): string[] | null {
  if (!subsetIds.length || new Set(subsetIds).size !== subsetIds.length) return null;
  const positions = new Map(fullIds.map((id, index) => [id, index]));
  if (subsetIds.some((id) => !positions.has(id))) return null;
  const slots = subsetIds.map((id) => positions.get(id)!).sort((left, right) => left - right);
  const next = [...fullIds];
  slots.forEach((slot, index) => { next[slot] = subsetIds[index]!; });
  return next;
}

/** Keeps an untouched list on one shared rank so newest updates stay first. A list with distinct ranks appends after the last rank. */
export function nextManualSortOrder(existing: readonly number[]): number {
  if (!existing.length) return 0;
  const first = existing[0]!;
  if (existing.every((value) => value === first)) return first;
  return Math.max(...existing) + 1;
}

export function hasExactIds(orderedIds: readonly string[], currentIds: readonly string[]): boolean {
  if (orderedIds.length !== currentIds.length) return false;
  const current = new Set(currentIds);
  const ordered = new Set(orderedIds);
  return current.size === currentIds.length && ordered.size === orderedIds.length && orderedIds.every((id) => current.has(id));
}

export function reorderMap<T>(items: Map<string, T>, orderedIds: readonly string[]): Map<string, T> | null {
  const currentIds = [...items.keys()];
  if (!hasExactIds(orderedIds, currentIds)) return null;
  return new Map(orderedIds.map((id) => [id, items.get(id)!]));
}

export function idAfterClose(pageIds: readonly string[], activePageId: string, closedPageId: string): string | null {
  const closedIndex = pageIds.indexOf(closedPageId);
  const remaining = pageIds.filter((id) => id !== closedPageId);
  if (activePageId !== closedPageId && remaining.includes(activePageId)) return activePageId;
  if (!remaining.length) return null;
  return remaining[Math.min(Math.max(closedIndex, 0), remaining.length - 1)] ?? null;
}
