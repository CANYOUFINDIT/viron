import { describe, expect, it } from "vitest";
import { parseSqlStatements, splitSqlStatements, sqlStatementAtOffset } from "../src/shared/sql-statements.js";

describe("SQL statement parsing", () => {
  it("keeps delimiters inside strings and comments out of statement boundaries", () => {
    expect(splitSqlStatements("SELECT ';' AS value; -- ;\nSELECT 2; /* ; */ SELECT 3;")).toEqual([
      "SELECT ';' AS value",
      "-- ;\nSELECT 2",
      "/* ; */ SELECT 3",
    ]);
  });

  it("supports Navicat-style DELIMITER scripts", () => {
    const sql = "DELIMITER //\nCREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND //\nDELIMITER ;\nCALL p();";
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND",
      "CALL p()",
    ]);
  });

  it("returns the statement under the editor cursor", () => {
    const sql = "SELECT 1;\n\nSELECT 2;\nSELECT 3;";
    const statements = parseSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(sqlStatementAtOffset(sql, sql.indexOf("2"))).toBe("SELECT 2");
    expect(sqlStatementAtOffset(sql, sql.indexOf("3"))).toBe("SELECT 3");
  });
});
