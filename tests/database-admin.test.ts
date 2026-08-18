import { describe, expect, it } from "vitest";
import {
  buildPrivilegeUpdateStatements,
  databasePrivilegeNames,
  parseManagedGrantScopes,
  userAuthenticationClause,
} from "../src/server/routes/database-admin.js";

describe("database user administration", () => {
  it("parses managed schema grants while preserving unsupported privileges", () => {
    const scopes = parseManagedGrantScopes([
      "GRANT SELECT, INSERT ON `billing`.* TO `reporter`@`%`",
      "GRANT SYSTEM_USER, SELECT ON *.* TO `reporter`@`%` WITH GRANT OPTION",
      "GRANT ALL PRIVILEGES ON `archive``2026`.* TO `reporter`@`%` WITH GRANT OPTION",
      "GRANT SELECT (`amount`) ON `billing`.`invoices` TO `reporter`@`%`",
    ]);

    expect(scopes).toEqual([
      { database: "billing", privileges: ["SELECT", "INSERT"], unmanagedPrivileges: [], grantOption: false },
      { database: "", privileges: ["SELECT"], unmanagedPrivileges: ["SYSTEM_USER"], grantOption: true },
      { database: "archive`2026", privileges: [...databasePrivilegeNames], unmanagedPrivileges: [], grantOption: true },
    ]);
  });

  it("updates only the selected scope and never revokes all grants", () => {
    const statements = buildPrivilegeUpdateStatements({
      identity: "'reporter'@'%'",
      database: "billing",
      current: { privileges: ["SELECT", "INSERT"], grantOption: true },
      privileges: ["SELECT", "UPDATE"],
      grantOption: false,
    });

    expect(statements).toEqual([
      "REVOKE INSERT ON `billing`.* FROM 'reporter'@'%'",
      "REVOKE GRANT OPTION ON `billing`.* FROM 'reporter'@'%'",
      "GRANT UPDATE ON `billing`.* TO 'reporter'@'%'",
    ]);
    expect(statements.join("\n")).not.toContain("REVOKE ALL");
  });

  it("adds grant option without dropping existing privileges", () => {
    expect(buildPrivilegeUpdateStatements({
      identity: "'reporter'@'%'",
      database: "",
      current: { privileges: ["SELECT"], grantOption: false },
      privileges: ["SELECT", "INSERT"],
      grantOption: true,
    })).toEqual([
      "GRANT SELECT, INSERT ON *.* TO 'reporter'@'%' WITH GRANT OPTION",
    ]);
  });

  it("uses engine-specific authentication syntax", () => {
    expect(userAuthenticationClause("mysql", "caching_sha2_password", "'secret'"))
      .toBe("IDENTIFIED WITH `caching_sha2_password` BY 'secret'");
    expect(userAuthenticationClause("mariadb", "ed25519", "'secret'"))
      .toBe("IDENTIFIED VIA `ed25519` USING PASSWORD('secret')");
    expect(userAuthenticationClause("mariadb", "", "'secret'"))
      .toBe("IDENTIFIED BY 'secret'");
  });
});
