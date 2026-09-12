export const MYSQL_TYPE_BIT = 16;
export const MYSQL_BLOB_TYPES = new Set([249, 250, 251, 252]);

export interface DatabaseCellColumn {
  name?: string;
  dataType?: string;
  columnType?: string;
  type?: number;
}

function columnTypeText(column?: DatabaseCellColumn | null): string {
  return `${column?.dataType ?? ""} ${column?.columnType ?? ""}`.trim().toLowerCase();
}

export function bitLengthFromColumn(column?: DatabaseCellColumn | null): number | undefined {
  const match = column?.columnType?.match(/bit\s*\(\s*(\d+)\s*\)/i);
  if (match) return Number(match[1]);
  if (column?.dataType?.trim().toLowerCase() === "bit" || column?.columnType?.trim().toLowerCase() === "bit") return 1;
  if (column?.type === MYSQL_TYPE_BIT) return undefined;
  return undefined;
}

export function isBitColumn(column?: DatabaseCellColumn | null): boolean {
  if (!column) return false;
  if (column.type === MYSQL_TYPE_BIT) return true;
  return /(?:^|\s)bit(?:\s|\(|$)/i.test(columnTypeText(column));
}

export function isBitFlagColumn(column?: DatabaseCellColumn | null): boolean {
  if (!isBitColumn(column)) return false;
  return (bitLengthFromColumn(column) ?? 1) <= 1;
}

export function isBinaryColumn(column?: DatabaseCellColumn | null): boolean {
  if (!column) return false;
  if (MYSQL_BLOB_TYPES.has(column.type ?? -1)) return true;
  return /\b(?:binary|varbinary|blob|tinyblob|mediumblob|longblob)\b/.test(columnTypeText(column));
}

export function asNodeBuffer(value: unknown): Buffer | null {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value && typeof value === "object" && (value as { type?: unknown }).type === "Buffer" && Array.isArray((value as { data?: unknown }).data)) {
    return Buffer.from((value as { data: number[] }).data);
  }
  return null;
}

function bitStringFromBuffer(buffer: Buffer, bitLength = buffer.length * 8): string {
  let bits = "";
  for (const byte of buffer) bits += byte.toString(2).padStart(8, "0");
  return bits.slice(-Math.max(1, bitLength));
}

function bufferFromBitString(bits: string, bitLength: number): Buffer {
  const width = Math.max(1, Math.ceil(bitLength / 8) * 8);
  const padded = bits.replace(/[^01]/g, "").padStart(width, "0").slice(-width);
  const bytes = Buffer.alloc(width / 8);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(padded.slice(index * 8, index * 8 + 8) || "0", 2);
  }
  return bytes;
}

function serializeBitBuffer(buffer: Buffer, column?: DatabaseCellColumn | null): string | number {
  const bitLength = bitLengthFromColumn(column) ?? (buffer.length <= 1 && buffer[0] <= 1 ? 1 : buffer.length * 8);
  if (bitLength <= 1) return buffer.some((byte) => byte !== 0) ? 1 : 0;
  return `b'${bitStringFromBuffer(buffer, bitLength)}'`;
}

export function serializeDatabaseCellValue(value: unknown, column?: DatabaseCellColumn | null): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  const buffer = asNodeBuffer(value);
  if (buffer) {
    if (isBitColumn(column)) return serializeBitBuffer(buffer, column);
    return `0x${buffer.toString("hex")}`;
  }
  return value;
}

function parseBooleanish(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  if (["1", "true", "t", "yes", "on"].includes(normalized)) return 1;
  if (["0", "false", "f", "no", "off"].includes(normalized)) return 0;
  return null;
}

export function deserializeDatabaseCellValue(value: unknown, column?: DatabaseCellColumn | null): unknown {
  if (value === null || value === undefined || value === "") {
    if (value === "" && (isBitColumn(column) || isBinaryColumn(column))) return null;
    return value ?? null;
  }
  if (!isBitColumn(column) && !isBinaryColumn(column)) return value;

  const buffer = asNodeBuffer(value);
  if (buffer) return isBitColumn(column) || isBinaryColumn(column) ? buffer : value;

  if (isBitColumn(column)) {
    const bitLength = bitLengthFromColumn(column) ?? 1;
    if (typeof value === "boolean") return bufferFromBitString(value ? "1" : "0", bitLength);
    if (typeof value === "number" && Number.isFinite(value)) {
      return bufferFromBitString(bitLength <= 1 ? (value ? "1" : "0") : Math.trunc(value).toString(2), bitLength);
    }
    const text = String(value).trim();
    if (!text) return null;
    if (/^0x[0-9a-f]+$/i.test(text)) return Buffer.from(text.slice(2), "hex");
    const bitLiteral = text.match(/^b'([01]+)'$/i);
    if (bitLiteral) return bufferFromBitString(bitLiteral[1], bitLength);
    const flag = parseBooleanish(text);
    if (flag !== null) return bufferFromBitString(String(flag), bitLength);
    if (/^[01]+$/.test(text)) return bufferFromBitString(text, Math.max(bitLength, text.length));
    return value;
  }

  const text = String(value).trim();
  if (!text) return null;
  if (/^0x[0-9a-f]+$/i.test(text)) return Buffer.from(text.slice(2), "hex");

  return value;
}

export function normalizeCellColumns(columns: readonly unknown[] | undefined | null): DatabaseCellColumn[] {
  return (columns ?? []).flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const column = item as Record<string, unknown>;
    return [{
      name: typeof column.name === "string" ? column.name : undefined,
      dataType: typeof column.dataType === "string" ? column.dataType : undefined,
      columnType: typeof column.columnType === "string" ? column.columnType : undefined,
      type: typeof column.type === "number" ? column.type : undefined,
    }];
  });
}

export function serializeDatabaseRow(row: unknown, columns: DatabaseCellColumn[] = []): Record<string, unknown> {
  if (!row || typeof row !== "object") return { value: serializeDatabaseCellValue(row) };
  const byName = new Map(columns.flatMap((column) => column.name ? [[column.name, column] as const] : []));
  return Object.fromEntries(Object.entries(row as Record<string, unknown>).map(([key, value]) => [
    key,
    serializeDatabaseCellValue(value, byName.get(key)),
  ]));
}

export function deserializeDatabaseRecord(values: Record<string, unknown>, columns: DatabaseCellColumn[]): Record<string, unknown> {
  const byName = new Map(columns.flatMap((column) => column.name ? [[column.name, column] as const] : []));
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key,
    deserializeDatabaseCellValue(value, byName.get(key)),
  ]));
}
