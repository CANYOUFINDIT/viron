import { describe, expect, it } from "vitest";
import { copyTableRows, parseTableClipboard } from "../src/client/database-table-row-actions";

const selection = {
  database: "sample`db",
  table: "items",
  fields: ["id", "name", "note"],
  primaryKey: ["id"],
  rows: [
    { id: "900000000000000001", name: "O'Reilly", note: null },
    { id: "900000000000000002", name: "line\tbreak", note: "a\nb" },
  ],
};

describe("database row context menu copy formats", () => {
  it("creates INSERT and UPDATE statements with escaped values and original key predicates", () => {
    expect(copyTableRows("insert", selection)).toBe([
      "INSERT INTO `sample``db`.`items` (`id`, `name`, `note`) VALUES ('900000000000000001', 'O''Reilly', NULL);",
      "INSERT INTO `sample``db`.`items` (`id`, `name`, `note`) VALUES ('900000000000000002', 'line\\tbreak', 'a\\nb');",
    ].join("\n"));
    expect(copyTableRows("update", selection)).toBe([
      "UPDATE `sample``db`.`items` SET `name` = 'O''Reilly', `note` = NULL WHERE `id` = '900000000000000001';",
      "UPDATE `sample``db`.`items` SET `name` = 'line\\tbreak', `note` = 'a\\nb' WHERE `id` = '900000000000000002';",
    ].join("\n"));
  });

  it("copies tab separated data and names and parses quoted cells for pasting", () => {
    expect(copyTableRows("names", selection)).toBe("id\tname\tnote");
    const copied = copyTableRows("names-and-values", selection);
    expect(copied).toBe('id\tname\tnote\n900000000000000001\tO\'Reilly\t\n900000000000000002\t"line\tbreak"\t"a\nb"');
    expect(parseTableClipboard(copied)).toEqual([
      ["id", "name", "note"],
      ["900000000000000001", "O'Reilly", ""],
      ["900000000000000002", "line\tbreak", "a\nb"],
    ]);
    expect(parseTableClipboard("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]]);
  });
});
