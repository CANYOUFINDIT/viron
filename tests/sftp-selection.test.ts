import { describe, expect, it } from "vitest";
import { updateSftpSelection } from "../src/client/sftp-selection";
import type { SftpItem } from "../src/client/sftp";

function item(name: string): SftpItem {
  return { name, path: `/${name}`, type: "file", size: 1, mode: "640", modifiedAt: "2026-08-09T00:00:00.000Z" };
}

describe("SFTP multi-selection", () => {
  const items = [item("a"), item("b"), item("c"), item("d")];

  it("uses Command or Control to toggle individual rows", () => {
    const first = updateSftpSelection(items, [], "", items[0]);
    const command = updateSftpSelection(items, first.selectedItems, first.anchorPath, items[2], { metaKey: true });
    expect(command.selectedItems.map((entry) => entry.name)).toEqual(["a", "c"]);
    const control = updateSftpSelection(items, command.selectedItems, command.anchorPath, items[0], { ctrlKey: true });
    expect(control.selectedItems.map((entry) => entry.name)).toEqual(["c"]);
  });

  it("uses Shift to select the visible contiguous range from the anchor", () => {
    const first = updateSftpSelection(items, [], "", items[1]);
    const range = updateSftpSelection(items, first.selectedItems, first.anchorPath, items[3], { shiftKey: true });
    expect(range.selectedItems.map((entry) => entry.name)).toEqual(["b", "c", "d"]);
    expect(range.anchorPath).toBe("/b");
  });
});
