import type { FieldPacket, QueryResult, RowDataPacket } from "mysql2/promise";

export type DatabaseSyncMode = "data" | "structure";
export type DatabaseSyncItemStatus = "ready" | "missing" | "different" | "extra" | "same" | "blocked";

export interface DatabaseSyncClient {
  query<T extends QueryResult = QueryResult>(sql: string, values?: unknown): Promise<[T, FieldPacket[]]>;
  beginTransaction(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  escape(value: unknown): string;
}

export interface DataSyncOptions {
  insert: boolean;
  update: boolean;
  delete: boolean;
}

export interface StructureSyncOptions {
  compareTables: boolean;
  comparePrimaryKeys: boolean;
  compareForeignKeys: boolean;
  compareIndexes: boolean;
  compareChecks: boolean;
  compareCharsets: boolean;
  compareAutoIncrement: boolean;
  compareTableOptions: boolean;
  compareViews: boolean;
  compareRoutines: boolean;
  compareTriggers: boolean;
  compareEvents: boolean;
  compareDefiners: boolean;
  dropExtra: boolean;
}

export interface DatabaseSyncOptions {
  mode: DatabaseSyncMode;
  sourceDatabase: string;
  targetDatabase: string;
  data: DataSyncOptions;
  structure: StructureSyncOptions;
}

export interface DatabaseSyncPreviewItem {
  id: string;
  category: "table" | "view" | "routine" | "trigger" | "event";
  name: string;
  subtype: string;
  status: DatabaseSyncItemStatus;
  action: "sync" | "create" | "alter" | "replace" | "drop" | "none";
  detail: string;
  destructive: boolean;
  selectedByDefault: boolean;
  sourceRows: number | null;
  targetRows: number | null;
  primaryKey: string[];
  sql: string[];
}

export interface DatabaseSyncPreview {
  mode: DatabaseSyncMode;
  sourceDatabase: string;
  targetDatabase: string;
  items: DatabaseSyncPreviewItem[];
  summary: {
    total: number;
    actionable: number;
    blocked: number;
    destructive: number;
    unchanged: number;
  };
}

export interface DatabaseSyncCallbacks {
  log(message: string): void;
  progress(value: number): void;
  cancelled(): boolean;
}

interface TableMeta {
  name: string;
  rowCount: number;
  engine: string;
  collation: string;
  comment: string;
  autoIncrement: number | null;
  rowFormat: string;
}

interface ColumnMeta {
  table: string;
  name: string;
  ordinal: number;
  columnType: string;
  nullable: boolean;
  defaultValue: unknown;
  extra: string;
  charset: string;
  collation: string;
  comment: string;
  generationExpression: string;
}

interface IndexColumn {
  name: string;
  subPart: number | null;
  direction: string;
}

interface IndexMeta {
  table: string;
  name: string;
  nonUnique: boolean;
  type: string;
  columns: IndexColumn[];
}

interface ForeignKeyMeta {
  table: string;
  name: string;
  columns: string[];
  referencedDatabase: string;
  referencedTable: string;
  referencedColumns: string[];
  updateRule: string;
  deleteRule: string;
}

interface CheckMeta {
  table: string;
  name: string;
  clause: string;
}

interface SchemaMetadata {
  tables: Map<string, TableMeta>;
  columns: Map<string, ColumnMeta[]>;
  indexes: Map<string, IndexMeta[]>;
  foreignKeys: Map<string, ForeignKeyMeta[]>;
  checks: Map<string, CheckMeta[]>;
}

interface SchemaObject {
  name: string;
  subtype: string;
  ddl: string;
}

const DATA_CHUNK_SIZE = 400;

export const defaultDataSyncOptions = (): DataSyncOptions => ({ insert: true, update: true, delete: true });

export const defaultStructureSyncOptions = (): StructureSyncOptions => ({
  compareTables: true,
  comparePrimaryKeys: true,
  compareForeignKeys: true,
  compareIndexes: true,
  compareChecks: true,
  compareCharsets: true,
  compareAutoIncrement: false,
  compareTableOptions: true,
  compareViews: true,
  compareRoutines: true,
  compareTriggers: true,
  compareEvents: true,
  compareDefiners: false,
  dropExtra: false,
});

function identifier(value: string): string {
  return `\`${value.replaceAll("`", "``")}\``;
}

function qualified(database: string, object: string): string {
  return `${identifier(database)}.${identifier(object)}`;
}

function literal(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\0", "\\0")}'`;
}

function numberValue(value: unknown): number {
  const result = Number(value ?? 0);
  return Number.isFinite(result) ? result : 0;
}

function mapByTable<T extends { table: string }>(items: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) result.set(item.table, [...(result.get(item.table) ?? []), item]);
  return result;
}

function canonicalDdl(sql: string, compareDefiners: boolean): string {
  let value = sql.trim().replace(/\s+/g, " ");
  if (!compareDefiners) value = value.replace(/\sDEFINER\s*=\s*(?:`[^`]*`@`[^`]*`|[^\s]+)\s*/gi, " ");
  return value.replace(/AUTO_INCREMENT=\d+\s*/gi, "").trim();
}

function rewriteDatabaseReferences(sql: string, sourceDatabase: string, targetDatabase: string): string {
  return sql
    .replaceAll(`${identifier(sourceDatabase)}.`, `${identifier(targetDatabase)}.`)
    .replace(/\sDEFINER\s*=\s*(?:`[^`]*`@`[^`]*`|[^\s]+)\s*/i, " ");
}

function extractCreate(row: RowDataPacket | undefined): string {
  if (!row) return "";
  const entries = Object.entries(row).filter(([, value]) => typeof value === "string");
  return String(entries.find(([key]) => key.toLowerCase().startsWith("create "))?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === "sql original statement")?.[1]
    ?? "");
}

function createTableForTarget(sql: string, table: string, sourceDatabase: string, targetDatabase: string): string {
  const rewritten = rewriteDatabaseReferences(sql, sourceDatabase, targetDatabase);
  return rewritten.replace(/^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:`[^`]+`\.)?`[^`]+`/i, `CREATE TABLE ${qualified(targetDatabase, table)}`);
}

function defaultClause(column: ColumnMeta): string {
  const value = column.defaultValue;
  if (value === null || value === undefined) return column.nullable && !column.generationExpression ? " DEFAULT NULL" : "";
  const text = String(value);
  if (/^(?:CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP)(?:\(\d+\))?$/i.test(text)) return ` DEFAULT ${text}`;
  if (/^(?:-?\d+(?:\.\d+)?|b'[01]+')$/i.test(text) && /(?:^|\b)(?:tinyint|smallint|mediumint|int|bigint|decimal|numeric|float|double|bit)(?:\b|\()/i.test(column.columnType)) return ` DEFAULT ${text}`;
  return ` DEFAULT ${literal(text)}`;
}

function columnDefinition(column: ColumnMeta): string {
  let sql = `${identifier(column.name)} ${column.columnType}`;
  if (column.charset) sql += ` CHARACTER SET ${column.charset}`;
  if (column.collation) sql += ` COLLATE ${column.collation}`;
  if (column.generationExpression) {
    sql += ` GENERATED ALWAYS AS (${column.generationExpression})`;
    sql += /STORED GENERATED/i.test(column.extra) ? " STORED" : " VIRTUAL";
  } else {
    sql += column.nullable ? " NULL" : " NOT NULL";
    sql += defaultClause(column);
  }
  if (/auto_increment/i.test(column.extra)) sql += " AUTO_INCREMENT";
  const onUpdate = column.extra.match(/on update\s+(.+?)(?:\s+DEFAULT_GENERATED|\s+INVISIBLE|$)/i)?.[1];
  if (onUpdate) sql += ` ON UPDATE ${onUpdate}`;
  if (/\bINVISIBLE\b/i.test(column.extra)) sql += " INVISIBLE";
  if (column.comment) sql += ` COMMENT ${literal(column.comment)}`;
  return sql;
}

function columnSignature(column: ColumnMeta, options: StructureSyncOptions): string {
  return JSON.stringify({
    type: column.columnType.toLowerCase(),
    nullable: column.nullable,
    defaultValue: column.defaultValue,
    extra: options.compareAutoIncrement ? column.extra : column.extra.replace(/auto_increment/gi, "").trim(),
    charset: options.compareCharsets ? column.charset : "",
    collation: options.compareCharsets ? column.collation : "",
    comment: column.comment,
    generationExpression: column.generationExpression,
  });
}

function indexColumnSql(column: IndexColumn): string {
  return `${identifier(column.name)}${column.subPart ? `(${column.subPart})` : ""}${column.direction.toUpperCase() === "D" ? " DESC" : ""}`;
}

function indexDefinition(index: IndexMeta): string {
  const columns = index.columns.map(indexColumnSql).join(", ");
  if (index.name === "PRIMARY") return `PRIMARY KEY (${columns})`;
  if (index.type.toUpperCase() === "FULLTEXT") return `FULLTEXT KEY ${identifier(index.name)} (${columns})`;
  if (index.type.toUpperCase() === "SPATIAL") return `SPATIAL KEY ${identifier(index.name)} (${columns})`;
  return `${index.nonUnique ? "KEY" : "UNIQUE KEY"} ${identifier(index.name)} (${columns})`;
}

function indexSignature(index: IndexMeta): string {
  return JSON.stringify({ nonUnique: index.nonUnique, type: index.type.toUpperCase(), columns: index.columns });
}

function foreignKeyDefinition(foreignKey: ForeignKeyMeta, sourceDatabase: string, targetDatabase: string): string {
  const referencedDatabase = foreignKey.referencedDatabase === sourceDatabase ? targetDatabase : foreignKey.referencedDatabase;
  return `CONSTRAINT ${identifier(foreignKey.name)} FOREIGN KEY (${foreignKey.columns.map(identifier).join(", ")}) REFERENCES ${qualified(referencedDatabase, foreignKey.referencedTable)} (${foreignKey.referencedColumns.map(identifier).join(", ")}) ON DELETE ${foreignKey.deleteRule} ON UPDATE ${foreignKey.updateRule}`;
}

function foreignKeySignature(foreignKey: ForeignKeyMeta, sourceDatabase: string, targetDatabase: string): string {
  return JSON.stringify({
    columns: foreignKey.columns,
    referencedDatabase: foreignKey.referencedDatabase === sourceDatabase ? targetDatabase : foreignKey.referencedDatabase,
    referencedTable: foreignKey.referencedTable,
    referencedColumns: foreignKey.referencedColumns,
    updateRule: foreignKey.updateRule,
    deleteRule: foreignKey.deleteRule,
  });
}

async function loadMetadata(connection: DatabaseSyncClient, database: string): Promise<SchemaMetadata> {
  const [tableRows] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS name, TABLE_ROWS AS rowCount, ENGINE AS engine, TABLE_COLLATION AS collation,
      TABLE_COMMENT AS comment, AUTO_INCREMENT AS autoIncrement, ROW_FORMAT AS rowFormat
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME
  `, [database]);
  const [columnRows] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, ORDINAL_POSITION AS ordinalPosition,
      COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue,
      EXTRA AS extra, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation,
      COLUMN_COMMENT AS comment, GENERATION_EXPRESSION AS generationExpression
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION
  `, [database]);
  const [indexRows] = await connection.query<RowDataPacket[]>(`
    SELECT TABLE_NAME AS tableName, INDEX_NAME AS indexName, NON_UNIQUE AS nonUnique,
      INDEX_TYPE AS indexType, SEQ_IN_INDEX AS sequence, COLUMN_NAME AS columnName,
      SUB_PART AS subPart, COLLATION AS direction
    FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX
  `, [database]);
  const [foreignKeyRows] = await connection.query<RowDataPacket[]>(`
    SELECT k.TABLE_NAME AS tableName, k.CONSTRAINT_NAME AS constraintName, k.COLUMN_NAME AS columnName,
      k.ORDINAL_POSITION AS ordinalPosition, k.REFERENCED_TABLE_SCHEMA AS referencedDatabase,
      k.REFERENCED_TABLE_NAME AS referencedTable, k.REFERENCED_COLUMN_NAME AS referencedColumn,
      r.UPDATE_RULE AS updateRule, r.DELETE_RULE AS deleteRule
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE k.TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
    ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION
  `, [database]);

  let checkRows: RowDataPacket[] = [];
  try {
    [checkRows] = await connection.query<RowDataPacket[]>(`
      SELECT tc.TABLE_NAME AS tableName, tc.CONSTRAINT_NAME AS constraintName, cc.CHECK_CLAUSE AS checkClause
      FROM information_schema.TABLE_CONSTRAINTS tc
      JOIN information_schema.CHECK_CONSTRAINTS cc
        ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
      WHERE tc.TABLE_SCHEMA = ? AND tc.CONSTRAINT_TYPE = 'CHECK'
      ORDER BY tc.TABLE_NAME, tc.CONSTRAINT_NAME
    `, [database]);
  } catch {
    checkRows = [];
  }

  const tables = new Map<string, TableMeta>();
  for (const row of tableRows) {
    const name = String(row.name);
    tables.set(name, {
      name,
      rowCount: numberValue(row.rowCount),
      engine: String(row.engine ?? ""),
      collation: String(row.collation ?? ""),
      comment: String(row.comment ?? ""),
      autoIncrement: row.autoIncrement === null || row.autoIncrement === undefined ? null : numberValue(row.autoIncrement),
      rowFormat: String(row.rowFormat ?? ""),
    });
  }

  const columns = mapByTable(columnRows.map((row) => ({
    table: String(row.tableName),
    name: String(row.name),
    ordinal: numberValue(row.ordinalPosition),
    columnType: String(row.columnType),
    nullable: String(row.nullable).toUpperCase() === "YES",
    defaultValue: row.defaultValue,
    extra: String(row.extra ?? ""),
    charset: String(row.charset ?? ""),
    collation: String(row.collation ?? ""),
    comment: String(row.comment ?? ""),
    generationExpression: String(row.generationExpression ?? ""),
  })));

  const indexGroups = new Map<string, IndexMeta>();
  for (const row of indexRows) {
    const table = String(row.tableName);
    const name = String(row.indexName);
    const key = `${table}\0${name}`;
    const current = indexGroups.get(key) ?? { table, name, nonUnique: Boolean(Number(row.nonUnique)), type: String(row.indexType ?? "BTREE"), columns: [] };
    current.columns.push({ name: String(row.columnName), subPart: row.subPart === null || row.subPart === undefined ? null : numberValue(row.subPart), direction: String(row.direction ?? "A") });
    indexGroups.set(key, current);
  }

  const foreignKeyGroups = new Map<string, ForeignKeyMeta>();
  for (const row of foreignKeyRows) {
    const table = String(row.tableName);
    const name = String(row.constraintName);
    const key = `${table}\0${name}`;
    const current = foreignKeyGroups.get(key) ?? {
      table,
      name,
      columns: [],
      referencedDatabase: String(row.referencedDatabase),
      referencedTable: String(row.referencedTable),
      referencedColumns: [],
      updateRule: String(row.updateRule ?? "RESTRICT"),
      deleteRule: String(row.deleteRule ?? "RESTRICT"),
    };
    current.columns.push(String(row.columnName));
    current.referencedColumns.push(String(row.referencedColumn));
    foreignKeyGroups.set(key, current);
  }

  const checks = mapByTable(checkRows.map((row) => ({ table: String(row.tableName), name: String(row.constraintName), clause: String(row.checkClause) })));
  return {
    tables,
    columns,
    indexes: mapByTable([...indexGroups.values()]),
    foreignKeys: mapByTable([...foreignKeyGroups.values()]),
    checks,
  };
}

function previousColumn(columns: ColumnMeta[], index: number): string {
  return index === 0 ? " FIRST" : ` AFTER ${identifier(columns[index - 1].name)}`;
}

function buildTableAlterSql(
  table: string,
  sourceDatabase: string,
  targetDatabase: string,
  source: SchemaMetadata,
  target: SchemaMetadata,
  options: StructureSyncOptions,
): string[] {
  const statements: string[] = [];
  const sourceColumns = source.columns.get(table) ?? [];
  const targetColumns = target.columns.get(table) ?? [];
  const sourceColumnMap = new Map(sourceColumns.map((column) => [column.name, column]));
  const targetColumnMap = new Map(targetColumns.map((column) => [column.name, column]));
  const sourceIndexes = source.indexes.get(table) ?? [];
  const targetIndexes = target.indexes.get(table) ?? [];
  const sourceIndexMap = new Map(sourceIndexes.map((index) => [index.name, index]));
  const targetIndexMap = new Map(targetIndexes.map((index) => [index.name, index]));
  const sourceForeignKeys = source.foreignKeys.get(table) ?? [];
  const targetForeignKeys = target.foreignKeys.get(table) ?? [];
  const sourceForeignKeyMap = new Map(sourceForeignKeys.map((key) => [key.name, key]));
  const targetForeignKeyMap = new Map(targetForeignKeys.map((key) => [key.name, key]));
  const sourceChecks = source.checks.get(table) ?? [];
  const targetChecks = target.checks.get(table) ?? [];
  const sourceCheckMap = new Map(sourceChecks.map((check) => [check.name, check]));
  const targetCheckMap = new Map(targetChecks.map((check) => [check.name, check]));
  const alter = (clause: string) => statements.push(`ALTER TABLE ${qualified(targetDatabase, table)} ${clause}`);

  if (options.compareForeignKeys) {
    for (const targetKey of targetForeignKeys) {
      const sourceKey = sourceForeignKeyMap.get(targetKey.name);
      if (!sourceKey || foreignKeySignature(sourceKey, sourceDatabase, targetDatabase) !== foreignKeySignature(targetKey, targetDatabase, targetDatabase)) {
        if (sourceKey || options.dropExtra) alter(`DROP FOREIGN KEY ${identifier(targetKey.name)}`);
      }
    }
  }

  if (options.compareChecks) {
    for (const targetCheck of targetChecks) {
      const sourceCheck = sourceCheckMap.get(targetCheck.name);
      if (!sourceCheck || sourceCheck.clause !== targetCheck.clause) {
        if (sourceCheck || options.dropExtra) alter(`DROP CONSTRAINT ${identifier(targetCheck.name)}`);
      }
    }
  }

  if (options.comparePrimaryKeys) {
    const sourcePrimary = sourceIndexMap.get("PRIMARY");
    const targetPrimary = targetIndexMap.get("PRIMARY");
    if (targetPrimary && (!sourcePrimary || indexSignature(sourcePrimary) !== indexSignature(targetPrimary))) alter("DROP PRIMARY KEY");
  }

  if (options.compareIndexes) {
    for (const targetIndex of targetIndexes.filter((index) => index.name !== "PRIMARY")) {
      const sourceIndex = sourceIndexMap.get(targetIndex.name);
      if (!sourceIndex || indexSignature(sourceIndex) !== indexSignature(targetIndex)) {
        if (sourceIndex || options.dropExtra) alter(`DROP INDEX ${identifier(targetIndex.name)}`);
      }
    }
  }

  sourceColumns.forEach((sourceColumn, index) => {
    const targetColumn = targetColumnMap.get(sourceColumn.name);
    if (!targetColumn) alter(`ADD COLUMN ${columnDefinition(sourceColumn)}${previousColumn(sourceColumns, index)}`);
    else if (columnSignature(sourceColumn, options) !== columnSignature(targetColumn, options) || targetColumn.ordinal !== sourceColumn.ordinal) {
      alter(`MODIFY COLUMN ${columnDefinition(sourceColumn)}${previousColumn(sourceColumns, index)}`);
    }
  });
  if (options.dropExtra) {
    for (const targetColumn of targetColumns) if (!sourceColumnMap.has(targetColumn.name)) alter(`DROP COLUMN ${identifier(targetColumn.name)}`);
  }

  if (options.comparePrimaryKeys) {
    const sourcePrimary = sourceIndexMap.get("PRIMARY");
    const targetPrimary = targetIndexMap.get("PRIMARY");
    if (sourcePrimary && (!targetPrimary || indexSignature(sourcePrimary) !== indexSignature(targetPrimary))) alter(`ADD ${indexDefinition(sourcePrimary)}`);
  }

  if (options.compareIndexes) {
    for (const sourceIndex of sourceIndexes.filter((index) => index.name !== "PRIMARY")) {
      const targetIndex = targetIndexMap.get(sourceIndex.name);
      if (!targetIndex || indexSignature(sourceIndex) !== indexSignature(targetIndex)) alter(`ADD ${indexDefinition(sourceIndex)}`);
    }
  }

  if (options.compareChecks) {
    for (const sourceCheck of sourceChecks) {
      const targetCheck = targetCheckMap.get(sourceCheck.name);
      if (!targetCheck || sourceCheck.clause !== targetCheck.clause) alter(`ADD CONSTRAINT ${identifier(sourceCheck.name)} CHECK (${sourceCheck.clause})`);
    }
  }

  if (options.compareForeignKeys) {
    for (const sourceKey of sourceForeignKeys) {
      const targetKey = targetForeignKeyMap.get(sourceKey.name);
      if (!targetKey || foreignKeySignature(sourceKey, sourceDatabase, targetDatabase) !== foreignKeySignature(targetKey, targetDatabase, targetDatabase)) {
        alter(`ADD ${foreignKeyDefinition(sourceKey, sourceDatabase, targetDatabase)}`);
      }
    }
  }

  if (options.compareTableOptions) {
    const sourceTable = source.tables.get(table)!;
    const targetTable = target.tables.get(table)!;
    const clauses: string[] = [];
    if (sourceTable.engine && sourceTable.engine.toLowerCase() !== targetTable.engine.toLowerCase()) clauses.push(`ENGINE = ${sourceTable.engine}`);
    if (options.compareCharsets && sourceTable.collation && sourceTable.collation !== targetTable.collation) {
      clauses.push(`DEFAULT CHARACTER SET = ${sourceTable.collation.split("_")[0]}`, `COLLATE = ${sourceTable.collation}`);
    }
    if (sourceTable.rowFormat && sourceTable.rowFormat.toLowerCase() !== targetTable.rowFormat.toLowerCase()) clauses.push(`ROW_FORMAT = ${sourceTable.rowFormat}`);
    if (sourceTable.comment !== targetTable.comment) clauses.push(`COMMENT = ${literal(sourceTable.comment)}`);
    if (options.compareAutoIncrement && sourceTable.autoIncrement && sourceTable.autoIncrement !== targetTable.autoIncrement) clauses.push(`AUTO_INCREMENT = ${sourceTable.autoIncrement}`);
    if (clauses.length) alter(clauses.join(" "));
  }
  return statements;
}

async function showCreateTable(connection: DatabaseSyncClient, database: string, table: string): Promise<string> {
  const [rows] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE ${qualified(database, table)}`);
  return extractCreate(rows[0]);
}

async function loadObjects(connection: DatabaseSyncClient, database: string, category: "view" | "routine" | "trigger" | "event"): Promise<SchemaObject[]> {
  let rows: RowDataPacket[] = [];
  if (category === "view") [rows] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME AS name FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME", [database]);
  else if (category === "routine") [rows] = await connection.query<RowDataPacket[]>("SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS subtype FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_TYPE, ROUTINE_NAME", [database]);
  else if (category === "trigger") [rows] = await connection.query<RowDataPacket[]>("SELECT TRIGGER_NAME AS name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME", [database]);
  else [rows] = await connection.query<RowDataPacket[]>("SELECT EVENT_NAME AS name FROM information_schema.EVENTS WHERE EVENT_SCHEMA = ? ORDER BY EVENT_NAME", [database]);
  const result: SchemaObject[] = [];
  for (const row of rows) {
    const name = String(row.name);
    const subtype = category === "routine" ? String(row.subtype).toUpperCase() : category.toUpperCase();
    const statementType = category === "routine" ? subtype : category.toUpperCase();
    const [createRows] = await connection.query<RowDataPacket[]>(`SHOW CREATE ${statementType} ${qualified(database, name)}`);
    result.push({ name, subtype, ddl: extractCreate(createRows[0]) });
  }
  return result;
}

function objectId(category: DatabaseSyncPreviewItem["category"], subtype: string, name: string): string {
  return `${category}:${subtype.toLowerCase()}:${name}`;
}

function objectDropSql(category: DatabaseSyncPreviewItem["category"], subtype: string, database: string, name: string): string {
  const type = category === "routine" ? subtype : category.toUpperCase();
  return `DROP ${type} IF EXISTS ${qualified(database, name)}`;
}

function objectPreviewItems(
  category: "view" | "routine" | "trigger" | "event",
  source: SchemaObject[],
  target: SchemaObject[],
  sourceDatabase: string,
  targetDatabase: string,
  options: StructureSyncOptions,
): DatabaseSyncPreviewItem[] {
  const sourceMap = new Map(source.map((item) => [`${item.subtype}\0${item.name}`, item]));
  const targetMap = new Map(target.map((item) => [`${item.subtype}\0${item.name}`, item]));
  const items: DatabaseSyncPreviewItem[] = [];
  for (const sourceObject of source) {
    const key = `${sourceObject.subtype}\0${sourceObject.name}`;
    const targetObject = targetMap.get(key);
    const id = objectId(category, sourceObject.subtype, sourceObject.name);
    const createSql = rewriteDatabaseReferences(sourceObject.ddl, sourceDatabase, targetDatabase);
    if (!targetObject) {
      items.push({ id, category, name: sourceObject.name, subtype: sourceObject.subtype, status: "missing", action: "create", detail: "目标中不存在，将创建", destructive: false, selectedByDefault: true, sourceRows: null, targetRows: null, primaryKey: [], sql: [createSql] });
    } else if (canonicalDdl(sourceObject.ddl, options.compareDefiners) !== canonicalDdl(targetObject.ddl, options.compareDefiners)) {
      items.push({ id, category, name: sourceObject.name, subtype: sourceObject.subtype, status: "different", action: "replace", detail: "定义不同，将替换目标对象", destructive: true, selectedByDefault: true, sourceRows: null, targetRows: null, primaryKey: [], sql: [objectDropSql(category, sourceObject.subtype, targetDatabase, sourceObject.name), createSql] });
    } else {
      items.push({ id, category, name: sourceObject.name, subtype: sourceObject.subtype, status: "same", action: "none", detail: "定义一致", destructive: false, selectedByDefault: false, sourceRows: null, targetRows: null, primaryKey: [], sql: [] });
    }
  }
  for (const targetObject of target) {
    const key = `${targetObject.subtype}\0${targetObject.name}`;
    if (sourceMap.has(key)) continue;
    items.push({
      id: objectId(category, targetObject.subtype, targetObject.name),
      category,
      name: targetObject.name,
      subtype: targetObject.subtype,
      status: "extra",
      action: options.dropExtra ? "drop" : "none",
      detail: options.dropExtra ? "仅目标存在，将删除" : "仅目标存在，当前保留",
      destructive: options.dropExtra,
      selectedByDefault: options.dropExtra,
      sourceRows: null,
      targetRows: null,
      primaryKey: [],
      sql: options.dropExtra ? [objectDropSql(category, targetObject.subtype, targetDatabase, targetObject.name)] : [],
    });
  }
  return items;
}

async function previewStructure(
  sourceConnection: DatabaseSyncClient,
  targetConnection: DatabaseSyncClient,
  sourceDatabase: string,
  targetDatabase: string,
  options: StructureSyncOptions,
): Promise<DatabaseSyncPreviewItem[]> {
  const [source, target] = await Promise.all([loadMetadata(sourceConnection, sourceDatabase), loadMetadata(targetConnection, targetDatabase)]);
  const items: DatabaseSyncPreviewItem[] = [];
  if (options.compareTables) {
    for (const [table, sourceTable] of source.tables) {
      const targetTable = target.tables.get(table);
      const id = `table:table:${table}`;
      if (!targetTable) {
        const ddl = await showCreateTable(sourceConnection, sourceDatabase, table);
        items.push({ id, category: "table", name: table, subtype: "TABLE", status: "missing", action: "create", detail: "目标中不存在，将创建表", destructive: false, selectedByDefault: true, sourceRows: sourceTable.rowCount, targetRows: null, primaryKey: (source.indexes.get(table) ?? []).find((index) => index.name === "PRIMARY")?.columns.map((column) => column.name) ?? [], sql: [createTableForTarget(ddl, table, sourceDatabase, targetDatabase)] });
        continue;
      }
      const sql = buildTableAlterSql(table, sourceDatabase, targetDatabase, source, target, options);
      if (sql.length) {
        items.push({ id, category: "table", name: table, subtype: "TABLE", status: "different", action: "alter", detail: `${sql.length} 项结构差异`, destructive: sql.some((statement) => /\bDROP\b/i.test(statement)), selectedByDefault: true, sourceRows: sourceTable.rowCount, targetRows: targetTable.rowCount, primaryKey: (source.indexes.get(table) ?? []).find((index) => index.name === "PRIMARY")?.columns.map((column) => column.name) ?? [], sql });
      } else {
        const [sourceDdl, targetDdl] = await Promise.all([showCreateTable(sourceConnection, sourceDatabase, table), showCreateTable(targetConnection, targetDatabase, table)]);
        const same = canonicalDdl(rewriteDatabaseReferences(sourceDdl, sourceDatabase, targetDatabase), options.compareDefiners) === canonicalDdl(targetDdl, options.compareDefiners);
        items.push({ id, category: "table", name: table, subtype: "TABLE", status: same ? "same" : "blocked", action: "none", detail: same ? "结构一致" : "存在分区或表达式索引等暂不能自动生成的差异", destructive: false, selectedByDefault: false, sourceRows: sourceTable.rowCount, targetRows: targetTable.rowCount, primaryKey: (source.indexes.get(table) ?? []).find((index) => index.name === "PRIMARY")?.columns.map((column) => column.name) ?? [], sql: [] });
      }
    }
    for (const [table, targetTable] of target.tables) {
      if (source.tables.has(table)) continue;
      items.push({ id: `table:table:${table}`, category: "table", name: table, subtype: "TABLE", status: "extra", action: options.dropExtra ? "drop" : "none", detail: options.dropExtra ? "仅目标存在，将删除表及其中数据" : "仅目标存在，当前保留", destructive: options.dropExtra, selectedByDefault: options.dropExtra, sourceRows: null, targetRows: targetTable.rowCount, primaryKey: [], sql: options.dropExtra ? [`DROP TABLE IF EXISTS ${qualified(targetDatabase, table)}`] : [] });
    }
  }

  const objectCategories: Array<{ category: "view" | "routine" | "trigger" | "event"; enabled: boolean }> = [
    { category: "routine", enabled: options.compareRoutines },
    { category: "view", enabled: options.compareViews },
    { category: "trigger", enabled: options.compareTriggers },
    { category: "event", enabled: options.compareEvents },
  ];
  for (const entry of objectCategories) {
    if (!entry.enabled) continue;
    const [sourceObjects, targetObjects] = await Promise.all([loadObjects(sourceConnection, sourceDatabase, entry.category), loadObjects(targetConnection, targetDatabase, entry.category)]);
    items.push(...objectPreviewItems(entry.category, sourceObjects, targetObjects, sourceDatabase, targetDatabase, options));
  }
  return items;
}

function generatedColumn(column: ColumnMeta): boolean {
  return Boolean(column.generationExpression) || /GENERATED/i.test(column.extra);
}

async function previewData(
  sourceConnection: DatabaseSyncClient,
  targetConnection: DatabaseSyncClient,
  sourceDatabase: string,
  targetDatabase: string,
  options: DataSyncOptions,
): Promise<DatabaseSyncPreviewItem[]> {
  const [source, target] = await Promise.all([loadMetadata(sourceConnection, sourceDatabase), loadMetadata(targetConnection, targetDatabase)]);
  const items: DatabaseSyncPreviewItem[] = [];
  for (const [table, sourceTable] of source.tables) {
    const targetTable = target.tables.get(table);
    const primaryKey = (source.indexes.get(table) ?? []).find((index) => index.name === "PRIMARY")?.columns.map((column) => column.name) ?? [];
    let status: DatabaseSyncItemStatus = "ready";
    let detail = "可按主键比较并同步记录";
    if (!targetTable) {
      status = "blocked";
      detail = "目标表不存在，请先执行结构同步";
    } else if (!primaryKey.length) {
      status = "blocked";
      detail = "源表没有主键，无法可靠识别记录";
    } else {
      const targetPrimary = (target.indexes.get(table) ?? []).find((index) => index.name === "PRIMARY")?.columns.map((column) => column.name) ?? [];
      if (JSON.stringify(primaryKey) !== JSON.stringify(targetPrimary)) {
        status = "blocked";
        detail = "源表与目标表主键不同，请先执行结构同步";
      } else {
        const sourceColumns = (source.columns.get(table) ?? []).filter((column) => !generatedColumn(column));
        const targetColumns = target.columns.get(table) ?? [];
        const targetColumnNames = new Set(targetColumns.map((column) => column.name));
        const missingColumns = sourceColumns.filter((column) => !targetColumnNames.has(column.name)).map((column) => column.name);
        const requiredTargetColumns = targetColumns.filter((column) => !sourceColumns.some((sourceColumn) => sourceColumn.name === column.name)
          && !column.nullable && column.defaultValue === null && !/auto_increment/i.test(column.extra) && !generatedColumn(column)).map((column) => column.name);
        if (missingColumns.length) {
          status = "blocked";
          detail = `目标缺少列：${missingColumns.join("、")}`;
        } else if (options.insert && requiredTargetColumns.length) {
          status = "blocked";
          detail = `目标存在无默认值的必填列：${requiredTargetColumns.join("、")}`;
        }
      }
    }
    items.push({ id: `table:data:${table}`, category: "table", name: table, subtype: "TABLE", status, action: status === "ready" ? "sync" : "none", detail, destructive: status === "ready" && options.delete, selectedByDefault: status === "ready", sourceRows: sourceTable.rowCount, targetRows: targetTable?.rowCount ?? null, primaryKey, sql: [] });
  }
  return items;
}

function previewSummary(items: DatabaseSyncPreviewItem[]) {
  return {
    total: items.length,
    actionable: items.filter((item) => item.action !== "none").length,
    blocked: items.filter((item) => item.status === "blocked").length,
    destructive: items.filter((item) => item.destructive && item.action !== "none").length,
    unchanged: items.filter((item) => item.status === "same").length,
  };
}

export async function previewDatabaseSync(
  sourceConnection: DatabaseSyncClient,
  targetConnection: DatabaseSyncClient,
  options: DatabaseSyncOptions,
): Promise<DatabaseSyncPreview> {
  const items = options.mode === "structure"
    ? await previewStructure(sourceConnection, targetConnection, options.sourceDatabase, options.targetDatabase, options.structure)
    : await previewData(sourceConnection, targetConnection, options.sourceDatabase, options.targetDatabase, options.data);
  return { mode: options.mode, sourceDatabase: options.sourceDatabase, targetDatabase: options.targetDatabase, items, summary: previewSummary(items) };
}

function normalizedValue(value: unknown): unknown {
  if (Buffer.isBuffer(value)) return `buffer:${value.toString("base64")}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `bigint:${value.toString()}`;
  if (value && typeof value === "object") return JSON.stringify(value);
  return value;
}

function rowKey(row: RowDataPacket, primaryKey: string[]): string {
  return JSON.stringify(primaryKey.map((column) => normalizedValue(row[column])));
}

function rowsEqual(left: RowDataPacket, right: RowDataPacket, columns: string[]): boolean {
  return columns.every((column) => normalizedValue(left[column]) === normalizedValue(right[column]));
}

function tupleExpression(columns: string[]): string {
  return columns.length === 1 ? identifier(columns[0]) : `(${columns.map(identifier).join(", ")})`;
}

function tuplePlaceholders(columns: string[], rows: number): string {
  if (columns.length === 1) return `(${Array.from({ length: rows }, () => "?").join(", ")})`;
  return `(${Array.from({ length: rows }, () => `(${Array.from({ length: columns.length }, () => "?").join(", ")})`).join(", ")})`;
}

async function lookupRows(
  connection: DatabaseSyncClient,
  database: string,
  table: string,
  columns: string[],
  primaryKey: string[],
  rows: RowDataPacket[],
): Promise<RowDataPacket[]> {
  if (!rows.length) return [];
  const keys = rows.flatMap((row) => primaryKey.map((column) => row[column]));
  const expression = tupleExpression(primaryKey);
  const placeholders = tuplePlaceholders(primaryKey, rows.length);
  const [found] = await connection.query<RowDataPacket[]>(`SELECT ${columns.map(identifier).join(", ")} FROM ${qualified(database, table)} WHERE ${expression} IN ${placeholders}`, keys);
  return found;
}

async function insertRows(connection: DatabaseSyncClient, database: string, table: string, columns: string[], rows: RowDataPacket[]): Promise<void> {
  for (let index = 0; index < rows.length; index += 200) {
    const chunk = rows.slice(index, index + 200);
    const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
    const values = chunk.flatMap((row) => columns.map((column) => row[column]));
    await connection.query(`INSERT INTO ${qualified(database, table)} (${columns.map(identifier).join(", ")}) VALUES ${placeholders}`, values);
  }
}

async function updateRows(connection: DatabaseSyncClient, database: string, table: string, columns: string[], primaryKey: string[], rows: RowDataPacket[]): Promise<void> {
  const updateColumns = columns.filter((column) => !primaryKey.includes(column));
  if (!updateColumns.length) return;
  for (const row of rows) {
    await connection.query(
      `UPDATE ${qualified(database, table)} SET ${updateColumns.map((column) => `${identifier(column)} = ?`).join(", ")} WHERE ${primaryKey.map((column) => `${identifier(column)} = ?`).join(" AND ")}`,
      [...updateColumns.map((column) => row[column]), ...primaryKey.map((column) => row[column])],
    );
  }
}

async function deleteRows(connection: DatabaseSyncClient, database: string, table: string, primaryKey: string[], rows: RowDataPacket[]): Promise<void> {
  if (!rows.length) return;
  const expression = tupleExpression(primaryKey);
  const placeholders = tuplePlaceholders(primaryKey, rows.length);
  const values = rows.flatMap((row) => primaryKey.map((column) => row[column]));
  await connection.query(`DELETE FROM ${qualified(database, table)} WHERE ${expression} IN ${placeholders}`, values);
}

async function readChunk(
  connection: DatabaseSyncClient,
  database: string,
  table: string,
  columns: string[],
  primaryKey: string[],
  lastKey: unknown[] | null,
): Promise<RowDataPacket[]> {
  const where = lastKey ? ` WHERE ${tupleExpression(primaryKey)} > ${primaryKey.length === 1 ? "?" : `(${primaryKey.map(() => "?").join(", ")})`}` : "";
  const [rows] = await connection.query<RowDataPacket[]>(`SELECT ${columns.map(identifier).join(", ")} FROM ${qualified(database, table)}${where} ORDER BY ${primaryKey.map(identifier).join(", ")} LIMIT ${DATA_CHUNK_SIZE}`, lastKey ?? []);
  return rows;
}

async function syncTableData(
  sourceConnection: DatabaseSyncClient,
  targetConnection: DatabaseSyncClient,
  sourceDatabase: string,
  targetDatabase: string,
  table: string,
  primaryKey: string[],
  columns: string[],
  options: DataSyncOptions,
  callbacks: DatabaseSyncCallbacks,
): Promise<{ inserted: number; updated: number; deleted: number }> {
  let inserted = 0;
  let updated = 0;
  let deleted = 0;
  await targetConnection.beginTransaction();
  try {
    let lastSourceKey: unknown[] | null = null;
    while (true) {
      if (callbacks.cancelled()) throw new Error("同步任务已取消");
      const sourceRows = await readChunk(sourceConnection, sourceDatabase, table, columns, primaryKey, lastSourceKey);
      if (!sourceRows.length) break;
      const targetRows = await lookupRows(targetConnection, targetDatabase, table, columns, primaryKey, sourceRows);
      const targetMap = new Map(targetRows.map((row) => [rowKey(row, primaryKey), row]));
      const missing = sourceRows.filter((row) => !targetMap.has(rowKey(row, primaryKey)));
      const changed = sourceRows.filter((row) => {
        const targetRow = targetMap.get(rowKey(row, primaryKey));
        return targetRow ? !rowsEqual(row, targetRow, columns) : false;
      });
      if (options.insert && missing.length) { await insertRows(targetConnection, targetDatabase, table, columns, missing); inserted += missing.length; }
      if (options.update && changed.length) { await updateRows(targetConnection, targetDatabase, table, columns, primaryKey, changed); updated += changed.length; }
      const last = sourceRows[sourceRows.length - 1];
      lastSourceKey = primaryKey.map((column) => last[column]);
      if (sourceRows.length < DATA_CHUNK_SIZE) break;
    }

    if (options.delete) {
      let lastTargetKey: unknown[] | null = null;
      while (true) {
        if (callbacks.cancelled()) throw new Error("同步任务已取消");
        const targetRows = await readChunk(targetConnection, targetDatabase, table, primaryKey, primaryKey, lastTargetKey);
        if (!targetRows.length) break;
        const sourceRows = await lookupRows(sourceConnection, sourceDatabase, table, primaryKey, primaryKey, targetRows);
        const sourceKeys = new Set(sourceRows.map((row) => rowKey(row, primaryKey)));
        const extra = targetRows.filter((row) => !sourceKeys.has(rowKey(row, primaryKey)));
        const last = targetRows[targetRows.length - 1];
        lastTargetKey = primaryKey.map((column) => last[column]);
        if (extra.length) { await deleteRows(targetConnection, targetDatabase, table, primaryKey, extra); deleted += extra.length; }
        if (targetRows.length < DATA_CHUNK_SIZE) break;
      }
    }
    await targetConnection.commit();
    return { inserted, updated, deleted };
  } catch (error) {
    await targetConnection.rollback();
    throw error;
  }
}

function executionOrder(item: DatabaseSyncPreviewItem): number {
  if (item.action === "drop" && item.category !== "table") return 0;
  if (item.category === "table") return 1;
  if (item.category === "routine") return 2;
  if (item.category === "view") return 3;
  if (item.category === "trigger") return 4;
  return 5;
}

export async function executeDatabaseSync(
  sourceConnection: DatabaseSyncClient,
  targetConnection: DatabaseSyncClient,
  options: DatabaseSyncOptions,
  selectedItemIds: string[],
  callbacks: DatabaseSyncCallbacks,
): Promise<void> {
  const preview = await previewDatabaseSync(sourceConnection, targetConnection, options);
  const selected = new Set(selectedItemIds);
  const items = preview.items.filter((item) => selected.has(item.id) && item.action !== "none").sort((left, right) => executionOrder(left) - executionOrder(right));
  if (!items.length) throw new Error("没有可执行的同步对象");
  await targetConnection.query(`CREATE DATABASE IF NOT EXISTS ${identifier(options.targetDatabase)}`);
  await targetConnection.query(`USE ${identifier(options.targetDatabase)}`);

  if (options.mode === "structure") {
    await targetConnection.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      for (let index = 0; index < items.length; index += 1) {
        if (callbacks.cancelled()) return;
        const item = items[index];
        callbacks.log(`${item.action === "drop" ? "删除" : "同步"}${item.category === "table" ? "表" : item.subtype.toLowerCase()} ${item.name}`);
        for (const statement of item.sql) {
          if (callbacks.cancelled()) return;
          await targetConnection.query(statement);
        }
        callbacks.progress(Math.round(((index + 1) / items.length) * 95));
      }
    } finally {
      await targetConnection.query("SET FOREIGN_KEY_CHECKS=1").catch(() => undefined);
    }
    return;
  }

  const [sourceMetadata, targetMetadata] = await Promise.all([loadMetadata(sourceConnection, options.sourceDatabase), loadMetadata(targetConnection, options.targetDatabase)]);
  for (let index = 0; index < items.length; index += 1) {
    if (callbacks.cancelled()) return;
    const item = items[index];
    const sourceColumns = (sourceMetadata.columns.get(item.name) ?? []).filter((column) => !generatedColumn(column));
    const targetColumnNames = new Set((targetMetadata.columns.get(item.name) ?? []).map((column) => column.name));
    const columns = sourceColumns.map((column) => column.name).filter((column) => targetColumnNames.has(column));
    callbacks.log(`比较表 ${item.name}，主键 ${item.primaryKey.join(", ")}`);
    const result = await syncTableData(sourceConnection, targetConnection, options.sourceDatabase, options.targetDatabase, item.name, item.primaryKey, columns, options.data, callbacks);
    callbacks.log(`${item.name}：插入 ${result.inserted}，更新 ${result.updated}，删除 ${result.deleted}`);
    callbacks.progress(Math.round(((index + 1) / items.length) * 95));
  }
}
