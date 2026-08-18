import { translate as tr } from "./i18n";
export const TABLE_FIELD_TYPES = [
  "BIGINT",
  "INT",
  "MEDIUMINT",
  "SMALLINT",
  "TINYINT",
  "DECIMAL",
  "DOUBLE",
  "FLOAT",
  "BOOLEAN",
  "BIT",
  "VARCHAR",
  "CHAR",
  "TINYTEXT",
  "TEXT",
  "MEDIUMTEXT",
  "LONGTEXT",
  "DATE",
  "DATETIME",
  "TIMESTAMP",
  "TIME",
  "YEAR",
  "ENUM",
  "SET",
  "JSON",
  "BLOB",
  "MEDIUMBLOB",
  "LONGBLOB",
  "BINARY",
  "VARBINARY",
  "GEOMETRY",
  "POINT",
  "LINESTRING",
  "POLYGON",
  "MULTIPOINT",
  "MULTILINESTRING",
  "MULTIPOLYGON",
  "GEOMETRYCOLLECTION",
] as const;

export type TableFieldType = (typeof TABLE_FIELD_TYPES)[number];
export type TableDefaultKind = "none" | "null" | "value" | "expression";
export type TableIndexType = "INDEX" | "UNIQUE" | "FULLTEXT";
export type ForeignKeyAction = "RESTRICT" | "CASCADE" | "SET NULL" | "NO ACTION";
export type TriggerTiming = "BEFORE" | "AFTER";
export type TriggerEvent = "INSERT" | "UPDATE" | "DELETE";
export type TableColumnFormat = "" | "DEFAULT" | "FIXED" | "DYNAMIC";
export type TableColumnStorage = "" | "DEFAULT" | "DISK" | "MEMORY";
export type TableTriState = "" | "DEFAULT" | "0" | "1";

export interface TableDesignerField {
  id: string;
  originalName?: string;
  name: string;
  type: TableFieldType;
  length: string;
  decimals: string;
  notNull: boolean;
  primaryKey: boolean;
  unsigned: boolean;
  zerofill?: boolean;
  charset?: string;
  collation?: string;
  binary?: boolean;
  columnFormat?: TableColumnFormat;
  storage?: TableColumnStorage;
  keyLength?: string;
  autoIncrement: boolean;
  defaultKind: TableDefaultKind;
  defaultValue: string;
  comment: string;
  generated?: boolean;
  generatedExpression?: string;
  generatedStored?: boolean;
  onUpdateExpression?: string;
}

export interface TableDesignerIndex {
  id: string;
  originalName?: string;
  name: string;
  type: TableIndexType;
  columns: string[];
  columnSettings?: Record<string, { length: string; order: "" | "ASC" | "DESC" }>;
  method?: "" | "BTREE" | "HASH";
  comment?: string;
  collation?: "" | "ASC" | "DESC";
  cardinality?: string;
  packed?: boolean;
  keyBlockSize?: number | null;
  parser?: string;
  invisible?: boolean;
}

export interface TableDesignerForeignKey {
  id: string;
  originalName?: string;
  name: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete: ForeignKeyAction;
  onUpdate: ForeignKeyAction;
}

export interface TableDesignerCheck {
  id: string;
  originalName?: string;
  name: string;
  expression: string;
}

export interface TableDesignerTrigger {
  id: string;
  originalName?: string;
  name: string;
  timing: TriggerTiming;
  event: TriggerEvent;
  statement: string;
}

export interface TableDesignerOptions {
  engine: string;
  charset: string;
  collation: string;
  rowFormat: string;
  autoIncrement: number | null;
  tablespace?: string;
  minRows?: number | null;
  averageRowLength?: number | null;
  keyBlockSize?: number | null;
  maxRows?: number | null;
  partition?: string;
  dataDirectory?: string;
  indexDirectory?: string;
  delayKeyWrite?: boolean | null;
  packKeys?: TableTriState;
  checksum?: boolean | null;
  pageChecksum?: boolean | null;
  connection?: string;
  encryption?: "" | "Y" | "N";
  unionTables?: string;
  insertMethod?: "" | "NO" | "FIRST" | "LAST";
  statsPersistent?: TableTriState;
  statsAutoRecalc?: TableTriState;
  statsSamplePages?: number | null;
  transactional?: boolean | null;
}

export interface TableDesignerState {
  database: string;
  tableName: string;
  fields: TableDesignerField[];
  indexes: TableDesignerIndex[];
  foreignKeys: TableDesignerForeignKey[];
  checks: TableDesignerCheck[];
  triggers: TableDesignerTrigger[];
  options: TableDesignerOptions;
  comment: string;
}

const identifierPattern = /^[^`\u0000-\u001f]{1,64}$/;
const integerTypes = new Set<TableFieldType>(["BIGINT", "INT", "MEDIUMINT", "SMALLINT", "TINYINT"]);
const numericTypes = new Set<TableFieldType>([...integerTypes, "DECIMAL", "DOUBLE", "FLOAT", "BOOLEAN"]);
const lengthTypes = new Set<TableFieldType>(["VARCHAR", "CHAR", "BINARY", "VARBINARY", "BIT"]);
const decimalTypes = new Set<TableFieldType>(["DECIMAL", "DOUBLE", "FLOAT"]);
const precisionTypes = new Set<TableFieldType>(["DATETIME", "TIMESTAMP", "TIME"]);
const valueListTypes = new Set<TableFieldType>(["ENUM", "SET"]);
const characterTypes = new Set<TableFieldType>(["VARCHAR", "CHAR", "TINYTEXT", "TEXT", "MEDIUMTEXT", "LONGTEXT", "ENUM", "SET"]);
const simpleOptionPattern = /^[A-Za-z0-9_$-]+$/;
const unionTablePattern = /^(?:(?:`(?:``|[^`])+`|[A-Za-z0-9_$-]+)\.)?(?:`(?:``|[^`])+`|[A-Za-z0-9_$-]+)$/;

export function quoteDatabaseIdentifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\0", "\\0")}'`;
}

function validIdentifier(value: string): boolean {
  return identifierPattern.test(value.trim());
}

function fieldTypeSql(field: TableDesignerField): string {
  const type = field.type;
  if (lengthTypes.has(type)) {
    const length = Number.parseInt(field.length, 10);
    return `${type}(${Number.isInteger(length) && length > 0 ? length : type === "VARCHAR" ? 255 : 1})`;
  }
  if (precisionTypes.has(type) && field.length.trim()) {
    const precision = Number.parseInt(field.length, 10);
    if (Number.isInteger(precision) && precision >= 0 && precision <= 6) return `${type}(${precision})`;
  }
  if (valueListTypes.has(type) && field.length.trim()) return `${type}(${field.length.trim()})`;
  if (decimalTypes.has(type) && field.length.trim()) {
    const precision = Number.parseInt(field.length, 10);
    const scale = Number.parseInt(field.decimals, 10);
    if (Number.isInteger(precision) && precision > 0) {
      return Number.isInteger(scale) && scale >= 0 ? `${type}(${precision},${scale})` : `${type}(${precision})`;
    }
  }
  return type;
}

function fieldDefaultSql(field: TableDesignerField): string {
  if (field.defaultKind === "none") return "";
  if (field.defaultKind === "null") return " DEFAULT NULL";
  if (field.defaultKind === "expression") return field.defaultValue.trim() ? ` DEFAULT ${field.defaultValue.trim()}` : "";
  if (numericTypes.has(field.type) && /^-?(?:\d+|\d*\.\d+)$/.test(field.defaultValue.trim())) {
    return ` DEFAULT ${field.defaultValue.trim()}`;
  }
  return ` DEFAULT ${quoteSqlString(field.defaultValue)}`;
}

export function columnSql(field: TableDesignerField): string {
  let sql = `${quoteDatabaseIdentifier(field.name.trim())} ${fieldTypeSql(field)}`;
  if (field.unsigned && numericTypes.has(field.type) && field.type !== "BOOLEAN") sql += " UNSIGNED";
  if (field.zerofill && numericTypes.has(field.type) && field.type !== "BOOLEAN") sql += " ZEROFILL";
  if (field.charset?.trim() && characterTypes.has(field.type)) sql += ` CHARACTER SET ${field.charset.trim()}`;
  if (field.collation?.trim() && characterTypes.has(field.type)) sql += ` COLLATE ${field.collation.trim()}`;
  if (field.binary && characterTypes.has(field.type)) sql += " BINARY";
  if (field.generated) {
    sql += ` GENERATED ALWAYS AS (${field.generatedExpression?.trim() || "NULL"}) ${field.generatedStored ? "STORED" : "VIRTUAL"}`;
    if (field.columnFormat) sql += ` COLUMN_FORMAT ${field.columnFormat}`;
    if (field.storage) sql += ` STORAGE ${field.storage}`;
    if (field.comment.trim()) sql += ` COMMENT ${quoteSqlString(field.comment.trim())}`;
    return sql;
  }
  sql += field.notNull ? " NOT NULL" : " NULL";
  sql += fieldDefaultSql(field);
  if (field.onUpdateExpression?.trim()) sql += ` ON UPDATE ${field.onUpdateExpression.trim()}`;
  if (field.autoIncrement) sql += " AUTO_INCREMENT";
  if (field.columnFormat) sql += ` COLUMN_FORMAT ${field.columnFormat}`;
  if (field.storage) sql += ` STORAGE ${field.storage}`;
  if (field.comment.trim()) sql += ` COMMENT ${quoteSqlString(field.comment.trim())}`;
  return sql;
}

function indexColumnSql(index: TableDesignerIndex, column: string): string {
  const setting = index.columnSettings?.[column];
  const length = Number.parseInt(setting?.length ?? "", 10);
  return `${quoteDatabaseIdentifier(column)}${Number.isInteger(length) && length > 0 ? `(${length})` : ""}${setting?.order ? ` ${setting.order}` : index.collation ? ` ${index.collation}` : ""}`;
}

function primaryColumnSql(field: TableDesignerField): string {
  const length = Number.parseInt(field.keyLength ?? "", 10);
  return `${quoteDatabaseIdentifier(field.name.trim())}${Number.isInteger(length) && length > 0 ? `(${length})` : ""}`;
}

function optionString(value: string): string {
  return quoteSqlString(value.trim());
}

function triStateSql(name: string, value: TableTriState | undefined): string {
  return value ? ` ${name}=${value}` : "";
}

function booleanOptionSql(name: string, value: boolean | null | undefined): string {
  return value === null || value === undefined ? "" : ` ${name}=${value ? 1 : 0}`;
}

function unionTablesSql(value: string): string {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const parts = entry.split(".").map((part) => part.trim().replace(/^`|`$/g, "").replaceAll("``", "`"));
    return parts.map(quoteDatabaseIdentifier).join(".");
  }).join(", ");
}

function tableOptionsSql(options: TableDesignerOptions): string {
  let sql = ` ENGINE=${options.engine}`;
  if (options.charset.trim()) sql += ` DEFAULT CHARSET=${options.charset.trim()}`;
  if (options.collation.trim()) sql += ` COLLATE=${options.collation.trim()}`;
  if (options.rowFormat) sql += ` ROW_FORMAT=${options.rowFormat}`;
  if (options.autoIncrement !== null) sql += ` AUTO_INCREMENT=${options.autoIncrement}`;
  if (options.tablespace?.trim()) sql += ` TABLESPACE ${quoteDatabaseIdentifier(options.tablespace.trim())}`;
  if (options.minRows !== undefined && options.minRows !== null) sql += ` MIN_ROWS=${options.minRows}`;
  if (options.averageRowLength !== undefined && options.averageRowLength !== null) sql += ` AVG_ROW_LENGTH=${options.averageRowLength}`;
  if (options.keyBlockSize !== undefined && options.keyBlockSize !== null) sql += ` KEY_BLOCK_SIZE=${options.keyBlockSize}`;
  if (options.maxRows !== undefined && options.maxRows !== null) sql += ` MAX_ROWS=${options.maxRows}`;
  if (options.dataDirectory?.trim()) sql += ` DATA DIRECTORY=${optionString(options.dataDirectory)}`;
  if (options.indexDirectory?.trim()) sql += ` INDEX DIRECTORY=${optionString(options.indexDirectory)}`;
  sql += booleanOptionSql("DELAY_KEY_WRITE", options.delayKeyWrite);
  sql += triStateSql("PACK_KEYS", options.packKeys);
  sql += booleanOptionSql("CHECKSUM", options.checksum);
  sql += booleanOptionSql("PAGE_CHECKSUM", options.pageChecksum);
  if (options.connection?.trim()) sql += ` CONNECTION=${optionString(options.connection)}`;
  if (options.encryption) sql += ` ENCRYPTION=${quoteSqlString(options.encryption)}`;
  if (options.unionTables?.trim()) sql += ` UNION=(${unionTablesSql(options.unionTables)})`;
  if (options.insertMethod) sql += ` INSERT_METHOD=${options.insertMethod}`;
  sql += triStateSql("STATS_PERSISTENT", options.statsPersistent);
  sql += triStateSql("STATS_AUTO_RECALC", options.statsAutoRecalc);
  if (options.statsSamplePages !== undefined && options.statsSamplePages !== null) sql += ` STATS_SAMPLE_PAGES=${options.statsSamplePages}`;
  sql += booleanOptionSql("TRANSACTIONAL", options.transactional);
  return sql;
}

function qualified(database: string, name: string): string {
  return `${quoteDatabaseIdentifier(database.trim())}.${quoteDatabaseIdentifier(name.trim())}`;
}

export function validateTableDesigner(state: TableDesignerState): string[] {
  const errors: string[] = [];
  if (!validIdentifier(state.database)) errors.push(tr("目标数据库名称无效"));
  if (!validIdentifier(state.tableName)) errors.push(tr("表名需为 1–64 个有效字符"));
  if (!state.fields.length) errors.push(tr("请至少添加一个字段"));

  const fieldNames = new Set<string>();
  for (const field of state.fields) {
    const name = field.name.trim();
    if (!validIdentifier(name)) errors.push(tr("每个字段都必须填写有效名称"));
    else if (fieldNames.has(name.toLowerCase())) errors.push(tr("字段名称重复：{{0}}", [name]));
    else fieldNames.add(name.toLowerCase());
    if (lengthTypes.has(field.type) && (!Number.isInteger(Number(field.length)) || Number(field.length) <= 0)) {
      errors.push(tr("字段 {{0}} 需要有效长度", [name || "未命名"]));
    }
    if (field.defaultKind === "expression" && !field.defaultValue.trim()) errors.push(tr("字段 {{0}} 的默认表达式不能为空", [name || "未命名"]));
    if (field.charset?.trim() && !simpleOptionPattern.test(field.charset.trim())) errors.push(tr("字段 {{0}} 的字符集无效", [name || "未命名"]));
    if (field.collation?.trim() && !simpleOptionPattern.test(field.collation.trim())) errors.push(tr("字段 {{0}} 的排序规则无效", [name || "未命名"]));
    if (field.keyLength?.trim() && (!Number.isInteger(Number(field.keyLength)) || Number(field.keyLength) <= 0)) errors.push(tr("字段 {{0}} 的键长度无效", [name || "未命名"]));
    if (field.generated && !field.generatedExpression?.trim()) errors.push(tr("字段 {{0}} 的虚拟列表达式不能为空", [name || "未命名"]));
    if (field.generated && (field.autoIncrement || field.defaultKind !== "none")) errors.push(tr("字段 {{0}} 的虚拟列不能设置默认值或自动递增", [name || "未命名"]));
    if (field.autoIncrement && (!integerTypes.has(field.type) || !field.primaryKey)) {
      errors.push(tr("字段 {{0}} 的自动递增仅支持整数主键", [name || "未命名"]));
    }
  }
  if (state.fields.filter((field) => field.autoIncrement).length > 1) errors.push(tr("一张表只能有一个自动递增字段"));

  for (const index of state.indexes) {
    if (!validIdentifier(index.name)) errors.push(tr("每个索引都必须填写有效名称"));
    if (!index.columns.length) errors.push(tr("索引 {{0}} 至少需要一个字段", [index.name || "未命名"]));
    if (index.columns.some((column) => !fieldNames.has(column.toLowerCase()))) errors.push(tr("索引 {{0}} 包含不存在的字段", [index.name || "未命名"]));
    for (const column of index.columns) {
      const length = index.columnSettings?.[column]?.length.trim();
      if (length && (!Number.isInteger(Number(length)) || Number(length) <= 0)) errors.push(tr("索引 {{0}} 的字段 {{1}} 键长度无效", [index.name || "未命名", column]));
    }
  }
  for (const foreignKey of state.foreignKeys) {
    if (!validIdentifier(foreignKey.name)) errors.push(tr("每个外键都必须填写有效名称"));
    if (!foreignKey.columns.length || foreignKey.columns.length !== foreignKey.referencedColumns.length) {
      errors.push(tr("外键 {{0}} 的本地字段和引用字段数量必须一致", [foreignKey.name || "未命名"]));
    }
    if (foreignKey.columns.some((column) => !fieldNames.has(column.toLowerCase()))) errors.push(tr("外键 {{0}} 包含不存在的本地字段", [foreignKey.name || "未命名"]));
    if (!validIdentifier(foreignKey.referencedDatabase || state.database) || !validIdentifier(foreignKey.referencedTable)) {
      errors.push(tr("外键 {{0}} 的引用目标无效", [foreignKey.name || "未命名"]));
    }
    if (foreignKey.referencedColumns.some((column) => !validIdentifier(column))) errors.push(tr("外键 {{0}} 的引用字段无效", [foreignKey.name || "未命名"]));
  }
  for (const check of state.checks) {
    if (!validIdentifier(check.name) || !check.expression.trim()) errors.push(tr("检查约束需要有效名称和表达式"));
  }
  for (const trigger of state.triggers) {
    if (!validIdentifier(trigger.name) || !trigger.statement.trim()) errors.push(tr("触发器需要有效名称和执行语句"));
  }
  for (const [label, value] of [
    [tr("存储引擎"), state.options.engine],
    [tr("默认字符集"), state.options.charset],
    [tr("排序规则"), state.options.collation],
    [tr("行格式"), state.options.rowFormat],
  ] as const) {
    if (value.trim() && !simpleOptionPattern.test(value.trim())) errors.push(tr("{{0}}无效", [label]));
  }
  if (state.options.tablespace?.trim() && !validIdentifier(state.options.tablespace)) errors.push(tr("表空间名称无效"));
  if (state.options.partition?.trim() && /;|--|\/\*/.test(state.options.partition)) errors.push(tr("分区表达式不能包含额外语句或注释"));
  if (state.options.unionTables?.trim()) {
    const invalidUnionTable = state.options.unionTables.split(",").map((item) => item.trim()).filter(Boolean).find((item) => !unionTablePattern.test(item));
    if (invalidUnionTable) errors.push(tr("并集表名称无效：{{0}}", [invalidUnionTable]));
  }
  for (const index of state.indexes) {
    if (index.parser?.trim() && !validIdentifier(index.parser)) errors.push(tr("索引 {{0}} 的解析器名称无效", [index.name || "未命名"]));
  }
  if (state.options.autoIncrement !== null && (!Number.isInteger(state.options.autoIncrement) || state.options.autoIncrement < 1)) {
    errors.push(tr("自动递增起始值必须是正整数"));
  }
  for (const [label, value] of [
    [tr("最小行数"), state.options.minRows],
    [tr("平均行长度"), state.options.averageRowLength],
    [tr("键块大小"), state.options.keyBlockSize],
    [tr("最大行数"), state.options.maxRows],
    [tr("统计样本页面"), state.options.statsSamplePages],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isInteger(value) || value < 0)) errors.push(tr("{{0}}必须是非负整数", [label]));
  }
  return [...new Set(errors)];
}

export function buildCreateTableSql(state: TableDesignerState): string {
  const definitions = state.fields.map(columnSql);
  const primaryColumns = state.fields.filter((field) => field.primaryKey).map(primaryColumnSql);
  if (primaryColumns.length) definitions.push(`PRIMARY KEY (${primaryColumns.join(", ")})`);
  for (const index of state.indexes) {
    const columns = index.columns.map((column) => indexColumnSql(index, column)).join(", ");
    const prefix = index.type === "UNIQUE" ? "UNIQUE KEY" : index.type === "FULLTEXT" ? "FULLTEXT KEY" : "KEY";
    let definition = `${prefix} ${quoteDatabaseIdentifier(index.name.trim())} (${columns})`;
    if (index.method) definition += ` USING ${index.method}`;
    if (index.keyBlockSize !== undefined && index.keyBlockSize !== null) definition += ` KEY_BLOCK_SIZE=${index.keyBlockSize}`;
    if (index.parser?.trim()) definition += ` WITH PARSER ${quoteDatabaseIdentifier(index.parser.trim())}`;
    if (index.comment?.trim()) definition += ` COMMENT ${quoteSqlString(index.comment.trim())}`;
    if (index.invisible) definition += " INVISIBLE";
    definitions.push(definition);
  }
  for (const foreignKey of state.foreignKeys) {
    const targetDatabase = foreignKey.referencedDatabase.trim() || state.database;
    definitions.push(
      `CONSTRAINT ${quoteDatabaseIdentifier(foreignKey.name.trim())} FOREIGN KEY (${foreignKey.columns.map(quoteDatabaseIdentifier).join(", ")})`
      + ` REFERENCES ${qualified(targetDatabase, foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quoteDatabaseIdentifier).join(", ")})`
      + ` ON DELETE ${foreignKey.onDelete} ON UPDATE ${foreignKey.onUpdate}`,
    );
  }
  for (const check of state.checks) {
    definitions.push(`CONSTRAINT ${quoteDatabaseIdentifier(check.name.trim())} CHECK (${check.expression.trim()})`);
  }

  let createSql = `CREATE TABLE ${qualified(state.database, state.tableName)} (\n  ${definitions.join(",\n  ")}\n)`;
  createSql += tableOptionsSql(state.options);
  if (state.comment.trim()) createSql += ` COMMENT=${quoteSqlString(state.comment.trim())}`;
  createSql += ";";
  if (state.options.partition?.trim()) createSql = createSql.replace(/;$/, ` PARTITION BY ${state.options.partition.trim().replace(/;+$/, "")};`);

  const triggerSql = state.triggers.map((trigger) => (
    `CREATE TRIGGER ${qualified(state.database, trigger.name)} ${trigger.timing} ${trigger.event}`
    + ` ON ${qualified(state.database, state.tableName)} FOR EACH ROW ${trigger.statement.trim().replace(/;+$/, "")};`
  ));
  return [createSql, ...triggerSql].join("\n\n");
}

function comparable<T extends { id: string; originalName?: string }>(value: T): Omit<T, "id" | "originalName"> {
  const { id: _id, originalName: _originalName, ...rest } = value;
  return rest;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function indexSql(index: TableDesignerIndex): string {
  const columns = index.columns.map((column) => indexColumnSql(index, column)).join(", ");
  const prefix = index.type === "UNIQUE" ? "UNIQUE KEY" : index.type === "FULLTEXT" ? "FULLTEXT KEY" : "KEY";
  let definition = `${prefix} ${quoteDatabaseIdentifier(index.name.trim())} (${columns})`;
  if (index.method) definition += ` USING ${index.method}`;
  if (index.keyBlockSize !== undefined && index.keyBlockSize !== null) definition += ` KEY_BLOCK_SIZE=${index.keyBlockSize}`;
  if (index.parser?.trim()) definition += ` WITH PARSER ${quoteDatabaseIdentifier(index.parser.trim())}`;
  if (index.comment?.trim()) definition += ` COMMENT ${quoteSqlString(index.comment.trim())}`;
  if (index.invisible) definition += " INVISIBLE";
  return definition;
}

function foreignKeySql(state: TableDesignerState, foreignKey: TableDesignerForeignKey): string {
  const targetDatabase = foreignKey.referencedDatabase.trim() || state.database;
  return `CONSTRAINT ${quoteDatabaseIdentifier(foreignKey.name.trim())} FOREIGN KEY (${foreignKey.columns.map(quoteDatabaseIdentifier).join(", ")})`
    + ` REFERENCES ${qualified(targetDatabase, foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(quoteDatabaseIdentifier).join(", ")})`
    + ` ON DELETE ${foreignKey.onDelete} ON UPDATE ${foreignKey.onUpdate}`;
}

function positionSql(fields: TableDesignerField[], index: number): string {
  if (index === 0) return " FIRST";
  return ` AFTER ${quoteDatabaseIdentifier(fields[index - 1].name.trim())}`;
}

export function buildAlterTableSql(original: TableDesignerState, current: TableDesignerState): string {
  const table = qualified(original.database, original.tableName);
  const before: string[] = [];
  const clauses: string[] = [];
  const after: string[] = [];

  const currentForeignKeys = new Map(current.foreignKeys.filter((item) => item.originalName).map((item) => [item.originalName!, item]));
  for (const item of original.foreignKeys) {
    const next = currentForeignKeys.get(item.name);
    if (!next || !sameValue(comparable(item), comparable(next))) clauses.push(`DROP FOREIGN KEY ${quoteDatabaseIdentifier(item.name)}`);
  }

  const currentChecks = new Map(current.checks.filter((item) => item.originalName).map((item) => [item.originalName!, item]));
  for (const item of original.checks) {
    const next = currentChecks.get(item.name);
    if (!next || !sameValue(comparable(item), comparable(next))) clauses.push(`DROP CHECK ${quoteDatabaseIdentifier(item.name)}`);
  }

  const currentIndexes = new Map(current.indexes.filter((item) => item.originalName).map((item) => [item.originalName!, item]));
  for (const item of original.indexes) {
    const next = currentIndexes.get(item.name);
    if (!next || !sameValue(comparable(item), comparable(next))) clauses.push(`DROP INDEX ${quoteDatabaseIdentifier(item.name)}`);
  }

  const originalPrimary = original.fields.filter((field) => field.primaryKey).map((field) => ({ name: field.name, keyLength: field.keyLength ?? "" }));
  const currentPrimary = current.fields.filter((field) => field.primaryKey).map((field) => ({ name: field.name, keyLength: field.keyLength ?? "" }));
  if (!sameValue(originalPrimary, currentPrimary) && originalPrimary.length) clauses.push("DROP PRIMARY KEY");

  const currentOriginalFields = new Set(current.fields.map((field) => field.originalName).filter(Boolean));
  for (const field of original.fields) {
    if (!currentOriginalFields.has(field.name)) clauses.push(`DROP COLUMN ${quoteDatabaseIdentifier(field.name)}`);
  }
  const originalFieldByName = new Map(original.fields.map((field, index) => [field.name, { field, index }]));
  current.fields.forEach((field, index) => {
    if (!field.originalName) {
      clauses.push(`ADD COLUMN ${columnSql(field)}${positionSql(current.fields, index)}`);
      return;
    }
    const previous = originalFieldByName.get(field.originalName);
    if (!previous) return;
    const changed = !sameValue(comparable(previous.field), comparable(field)) || previous.index !== index;
    if (!changed) return;
    const operation = field.name === field.originalName
      ? `MODIFY COLUMN ${columnSql(field)}`
      : `CHANGE COLUMN ${quoteDatabaseIdentifier(field.originalName)} ${columnSql(field)}`;
    clauses.push(`${operation}${positionSql(current.fields, index)}`);
  });

  if (!sameValue(originalPrimary, currentPrimary) && currentPrimary.length) {
    clauses.push(`ADD PRIMARY KEY (${current.fields.filter((field) => field.primaryKey).map(primaryColumnSql).join(", ")})`);
  }
  for (const item of current.indexes) {
    const previous = item.originalName ? original.indexes.find((candidate) => candidate.name === item.originalName) : undefined;
    if (!previous || !sameValue(comparable(previous), comparable(item))) clauses.push(`ADD ${indexSql(item)}`);
  }
  for (const item of current.checks) {
    const previous = item.originalName ? original.checks.find((candidate) => candidate.name === item.originalName) : undefined;
    if (!previous || !sameValue(comparable(previous), comparable(item))) {
      clauses.push(`ADD CONSTRAINT ${quoteDatabaseIdentifier(item.name.trim())} CHECK (${item.expression.trim()})`);
    }
  }
  for (const item of current.foreignKeys) {
    const previous = item.originalName ? original.foreignKeys.find((candidate) => candidate.name === item.originalName) : undefined;
    if (!previous || !sameValue(comparable(previous), comparable(item))) clauses.push(`ADD ${foreignKeySql(current, item)}`);
  }

  const changedOption = (key: keyof TableDesignerOptions) => !sameValue(original.options[key], current.options[key]);
  const appendValueOption = (key: keyof TableDesignerOptions, sql: string) => {
    const value = current.options[key];
    if (changedOption(key) && value !== "" && value !== null && value !== undefined) clauses.push(sql);
  };
  appendValueOption("engine", `ENGINE=${current.options.engine}`);
  appendValueOption("charset", `DEFAULT CHARSET=${current.options.charset}`);
  appendValueOption("collation", `COLLATE=${current.options.collation}`);
  appendValueOption("rowFormat", `ROW_FORMAT=${current.options.rowFormat}`);
  appendValueOption("autoIncrement", `AUTO_INCREMENT=${current.options.autoIncrement}`);
  appendValueOption("minRows", `MIN_ROWS=${current.options.minRows}`);
  appendValueOption("averageRowLength", `AVG_ROW_LENGTH=${current.options.averageRowLength}`);
  appendValueOption("keyBlockSize", `KEY_BLOCK_SIZE=${current.options.keyBlockSize}`);
  appendValueOption("maxRows", `MAX_ROWS=${current.options.maxRows}`);
  appendValueOption("dataDirectory", `DATA DIRECTORY=${optionString(current.options.dataDirectory ?? "")}`);
  appendValueOption("indexDirectory", `INDEX DIRECTORY=${optionString(current.options.indexDirectory ?? "")}`);
  if (changedOption("delayKeyWrite")) clauses.push(`DELAY_KEY_WRITE=${current.options.delayKeyWrite ? 1 : 0}`);
  if (changedOption("packKeys")) clauses.push(`PACK_KEYS=${current.options.packKeys || "DEFAULT"}`);
  if (changedOption("checksum")) clauses.push(`CHECKSUM=${current.options.checksum ? 1 : 0}`);
  if (changedOption("pageChecksum")) clauses.push(`PAGE_CHECKSUM=${current.options.pageChecksum ? 1 : 0}`);
  if (changedOption("connection")) clauses.push(`CONNECTION=${optionString(current.options.connection ?? "")}`);
  if (changedOption("encryption")) clauses.push(`ENCRYPTION=${quoteSqlString(current.options.encryption || "N")}`);
  if (changedOption("unionTables")) clauses.push(`UNION=(${unionTablesSql(current.options.unionTables ?? "")})`);
  if (changedOption("insertMethod")) clauses.push(`INSERT_METHOD=${current.options.insertMethod || "NO"}`);
  if (changedOption("statsPersistent")) clauses.push(`STATS_PERSISTENT=${current.options.statsPersistent || "DEFAULT"}`);
  if (changedOption("statsAutoRecalc")) clauses.push(`STATS_AUTO_RECALC=${current.options.statsAutoRecalc || "DEFAULT"}`);
  appendValueOption("statsSamplePages", `STATS_SAMPLE_PAGES=${current.options.statsSamplePages}`);
  if (changedOption("transactional")) clauses.push(`TRANSACTIONAL=${current.options.transactional ? 1 : 0}`);
  if (!sameValue(original.options.tablespace ?? "", current.options.tablespace ?? "") && current.options.tablespace?.trim()) {
    clauses.push(`TABLESPACE ${quoteDatabaseIdentifier(current.options.tablespace.trim())}`);
  }
  if (original.comment !== current.comment) clauses.push(`COMMENT=${quoteSqlString(current.comment.trim())}`);
  if ((original.options.partition ?? "") !== (current.options.partition ?? "")) {
    clauses.push(current.options.partition?.trim() ? `PARTITION BY ${current.options.partition.trim().replace(/;+$/, "")}` : "REMOVE PARTITIONING");
  }

  const currentTriggers = new Map(current.triggers.filter((item) => item.originalName).map((item) => [item.originalName!, item]));
  for (const item of original.triggers) {
    const next = currentTriggers.get(item.name);
    if (!next || !sameValue(comparable(item), comparable(next))) before.push(`DROP TRIGGER IF EXISTS ${qualified(original.database, item.name)};`);
  }
  for (const item of current.triggers) {
    const previous = item.originalName ? original.triggers.find((candidate) => candidate.name === item.originalName) : undefined;
    if (!previous || !sameValue(comparable(previous), comparable(item))) {
      after.push(`CREATE TRIGGER ${qualified(current.database, item.name)} ${item.timing} ${item.event} ON ${qualified(current.database, current.tableName)} FOR EACH ROW ${item.statement.trim().replace(/;+$/, "")};`);
    }
  }

  const alter = clauses.length ? `ALTER TABLE ${table}\n  ${clauses.join(",\n  ")};` : "";
  return [...before, alter, ...after].filter(Boolean).join("\n\n") || tr("-- 未检测到结构变更");
}
