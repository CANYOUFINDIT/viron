import type { SftpItem } from "./sftp";

export interface SftpSelectionModifiers {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
}

export interface SftpSelectionResult {
  selectedItems: SftpItem[];
  anchorPath: string;
}

export function updateSftpSelection(
  visibleItems: SftpItem[],
  selectedItems: SftpItem[],
  anchorPath: string,
  item: SftpItem,
  modifiers: SftpSelectionModifiers = {},
): SftpSelectionResult {
  if (modifiers.shiftKey && anchorPath) {
    const anchorIndex = visibleItems.findIndex((candidate) => candidate.path === anchorPath);
    const currentIndex = visibleItems.findIndex((candidate) => candidate.path === item.path);
    if (anchorIndex >= 0 && currentIndex >= 0) {
      const [start, end] = anchorIndex <= currentIndex ? [anchorIndex, currentIndex] : [currentIndex, anchorIndex];
      return { selectedItems: visibleItems.slice(start, end + 1), anchorPath };
    }
  }
  if (modifiers.metaKey || modifiers.ctrlKey) {
    const selected = selectedItems.some((candidate) => candidate.path === item.path);
    return {
      selectedItems: selected ? selectedItems.filter((candidate) => candidate.path !== item.path) : [...selectedItems, item],
      anchorPath: item.path,
    };
  }
  return { selectedItems: [item], anchorPath: item.path };
}
