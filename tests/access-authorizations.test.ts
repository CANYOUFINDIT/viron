import { describe, expect, it } from "vitest";
import { databaseSqlPermissions, expandActions, heavierActions, sqlRequiresWrite } from "../src/shared/access-permissions.js";
describe("access permission helpers", () => {
  it("expands heavier actions without treating service actions as one chain", () => {
    expect(expandActions("web", ["manage"])).toEqual(["view", "use", "manage"]);
    expect(expandActions("database", ["write"])).toEqual(["read", "write"]);
    expect(expandActions("maintenance", ["script", "install"])).toEqual(["view", "script", "install"]);
    expect(heavierActions("ssh", "view")).toEqual(["use", "manage"]);
    expect(heavierActions("maintenance", "control")).toEqual([]);
    expect(heavierActions("maintenance", "view")).toEqual(["control", "script", "manage", "install"]);
  });

  it("treats reads as queries and everything else as a change", () => {
    expect(sqlRequiresWrite("SELECT 1")).toBe(false);
    expect(sqlRequiresWrite("SHOW TABLES")).toBe(false);
    expect(sqlRequiresWrite("WITH rows AS (SELECT 1 AS id) SELECT * FROM rows")).toBe(false);
    expect(sqlRequiresWrite("SELECT * FROM t FOR UPDATE")).toBe(true);
    expect(sqlRequiresWrite("UPDATE t SET name = 'a'")).toBe(true);
    expect(sqlRequiresWrite("")).toBe(true);
  });

  it("maps each statement to the database operation it actually performs", () => {
    expect(databaseSqlPermissions("UPDATE example SET value = 1")).toEqual(["database.write"]);
    expect(databaseSqlPermissions("CREATE TABLE example(id int)")).toEqual(["database.ddl"]);
    expect(databaseSqlPermissions("SELECT 'FOR UPDATE' AS label")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("WITH x AS (SELECT 'DROP TABLE foo' AS label) SELECT * FROM x")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("UPDATE example SET label = 'create drop alter'")).toEqual(["database.write"]);
    expect(databaseSqlPermissions("SELECT 1 /* DROP TABLE hidden */")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("/* user's ordinary comment */ SELECT 1")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("/* user's ordinary comment */ CREATE TABLE quoted_comment_probe(id INT)")).toEqual(["database.ddl"]);
    expect(databaseSqlPermissions("/* user's ordinary comment SELECT 1")).toEqual(["database.write"]);
    expect(databaseSqlPermissions("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'")).toEqual([]);
    expect(databaseSqlPermissions("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'; SELECT 1")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("SET SESSION sql_mode=DEFAULT; SELECT 1")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("SELECT '\\'; CREATE TABLE hidden(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SELECT '\\'; CREATE TABLE initial_mode_probe(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SET SESSION sql_mode=DEFAULT; SELECT '\\'; CREATE TABLE default_mode_probe(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SET SESSION sql_mode=@mode; SELECT '\\'; CREATE TABLE expr_mode_probe(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("/*! SET SESSION sql_mode='NO_BACKSLASH_ESCAPES' */; SELECT '\\'; CREATE TABLE exec_mode_probe(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SET SESSION sql_mode='NO_BACKSLASH_ESCAPES'; SELECT '\\'; CREATE TABLE sqlmode_comment_probe(id INT); -- '")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("CREATE TABLE example(id int); UPDATE example SET id = 2")).toEqual(["database.write", "database.ddl"]);
    expect(databaseSqlPermissions("/*!50000 CREATE TABLE example(id int) */")).toEqual(["database.ddl"]);
    expect(databaseSqlPermissions("SELECT 1 /*!50000 ; DROP TABLE example */")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SELECT * FROM example INTO OUTFILE '/tmp/example.txt'")).toEqual(["database.read", "database.export"]);
    expect(databaseSqlPermissions("SELECT * FROM example FOR UPDATE")).toEqual(["database.read", "database.write"]);
    expect(databaseSqlPermissions("SELECT 1--1")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("SELECT 1--1; DROP TABLE sql_comment_probe")).toEqual(["database.read", "database.ddl"]);
    expect(databaseSqlPermissions("SELECT 1 -- 1; DROP TABLE hidden")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("/*M! CREATE TABLE mariadb_comment_probe(id INT) */")).toEqual(["database.ddl"]);
    expect(databaseSqlPermissions("SELECT '/*M! CREATE TABLE hidden(id INT) */'")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("CREATE TABLE selected_rows AS SELECT * FROM example")).toEqual(["database.read", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("SET @acceptance_sql='CREATE TABLE dynamic_sql_probe(id INT)'")).toEqual([]);
    expect(databaseSqlPermissions("PREPARE acceptance_stmt FROM @acceptance_sql")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("EXECUTE acceptance_stmt")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("CALL copy_rows()")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("DO SLEEP(0)")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("HANDLER example OPEN")).toEqual(["database.read"]);
    expect(databaseSqlPermissions("GRANT SELECT ON example.* TO fictional")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("REVOKE SELECT ON example.* FROM fictional")).toEqual(["database.read", "database.export", "database.write", "database.ddl"]);
    expect(databaseSqlPermissions("USE example")).toEqual([]);
  });
});

