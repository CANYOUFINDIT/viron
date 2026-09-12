import { describe, expect, it } from "vitest";
import {
  deserializeDatabaseCellValue,
  isBitFlagColumn,
  serializeDatabaseCellValue,
  serializeDatabaseRow,
} from "../src/shared/database-cell-value.js";

const bit1 = { name: "connectivity_available", dataType: "bit", columnType: "bit(1)" };
const bit8 = { name: "flags", dataType: "bit", columnType: "bit(8)" };
const blob = { name: "payload", dataType: "blob", columnType: "blob" };

describe("database cell value serialization", () => {
  it("renders BIT(1) buffers as 0/1 instead of 0x hex", () => {
    expect(serializeDatabaseCellValue(Buffer.from([1]), bit1)).toBe(1);
    expect(serializeDatabaseCellValue(Buffer.from([0]), bit1)).toBe(0);
    expect(serializeDatabaseCellValue({ type: "Buffer", data: [1] }, bit1)).toBe(1);
    expect(isBitFlagColumn(bit1)).toBe(true);
  });

  it("renders wider BIT values as MySQL bit literals", () => {
    expect(serializeDatabaseCellValue(Buffer.from([0b00001011]), bit8)).toBe("b'00001011'");
  });

  it("keeps non-bit binary values as hex", () => {
    expect(serializeDatabaseCellValue(Buffer.from([1]), blob)).toBe("0x01");
    expect(serializeDatabaseRow({ payload: Buffer.from([255]), note: "ok" }, [blob])).toEqual({
      payload: "0xff",
      note: "ok",
    });
  });
});

describe("database cell value deserialization", () => {
  it("converts displayed BIT(1) values back to a 1-byte buffer", () => {
    expect(deserializeDatabaseCellValue("0x01", bit1)).toEqual(Buffer.from([1]));
    expect(deserializeDatabaseCellValue("1", bit1)).toEqual(Buffer.from([1]));
    expect(deserializeDatabaseCellValue(1, bit1)).toEqual(Buffer.from([1]));
    expect(deserializeDatabaseCellValue(true, bit1)).toEqual(Buffer.from([1]));
    expect(deserializeDatabaseCellValue("0", bit1)).toEqual(Buffer.from([0]));
    expect(deserializeDatabaseCellValue("b'1'", bit1)).toEqual(Buffer.from([1]));
  });

  it("converts hex strings back to buffers for binary columns", () => {
    expect(deserializeDatabaseCellValue("0x01", blob)).toEqual(Buffer.from([1]));
  });

  it("leaves ordinary text columns unchanged", () => {
    expect(deserializeDatabaseCellValue("0x01", { name: "title", dataType: "varchar", columnType: "varchar(32)" })).toBe("0x01");
  });
});
