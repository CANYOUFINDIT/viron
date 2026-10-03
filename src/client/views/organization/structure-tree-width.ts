export const STRUCTURE_TREE_WIDTH_KEY = "viron.organization.structure-tree-width";
export const STRUCTURE_TREE_DEFAULT = 330;
export const STRUCTURE_TREE_MIN = 220;
export const STRUCTURE_TREE_MAX = 560;
export const STRUCTURE_INSPECTOR_MIN = 480;

export function preferredStructureTreeWidth(stored: string | null): number {
  if (stored == null || stored.trim() === "") return STRUCTURE_TREE_DEFAULT;
  const value = Number(stored);
  if (!Number.isFinite(value)) return STRUCTURE_TREE_DEFAULT;
  return Math.round(Math.min(STRUCTURE_TREE_MAX, Math.max(STRUCTURE_TREE_MIN, value)));
}

export function clampStructureTreeWidth(preferred: number, containerWidth: number): number {
  const available = Number.isFinite(containerWidth) && containerWidth > 0
    ? containerWidth
    : STRUCTURE_TREE_DEFAULT + STRUCTURE_INSPECTOR_MIN;
  const max = Math.max(STRUCTURE_TREE_MIN, Math.min(STRUCTURE_TREE_MAX, Math.floor(available - STRUCTURE_INSPECTOR_MIN)));
  const next = Number.isFinite(preferred) ? preferred : STRUCTURE_TREE_DEFAULT;
  return Math.round(Math.min(max, Math.max(STRUCTURE_TREE_MIN, next)));
}
