import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import type { AppConfig } from "../src/server/config.js";
import { ensureAdmin, openDatabase } from "../src/server/database.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function configFor(directory: string): AppConfig {
  return {
    nodeEnv: "test",
    host: "127.0.0.1",
    port: 0,
    dataDir: directory,
    databasePath: join(directory, "envman.db"),
    masterKey: Buffer.alloc(32, 22),
    adminUsername: "admin",
    adminPassword: "test-password-123",
    allowWeakPasswords: true,
    sessionTtlHours: 12,
    terminalIdleMinutes: 30,
    auditRetentionDays: 30,
  };
}

async function register(app: Awaited<ReturnType<typeof buildApp>>, username: string) {
  const response = await app.inject({ method: "POST", url: "/api/v1/auth/register", payload: { username, password: username } });
  expect(response.statusCode).toBe(201);
  return {
    id: response.json().user.id as string,
    cookies: { envman_session: response.cookies.find((item) => item.name === "envman_session")!.value },
  };
}

describe("database connection profiles", () => {
  it("adds profile columns before creating the profile index on an existing SQLite database", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-database-profile-migration-"));
    directories.push(directory);
    const config = configFor(directory);
    const legacy = await openDatabase(config);
    await legacy.exec("DROP INDEX database_connections_profile_idx");
    await legacy.exec("ALTER TABLE database_connections DROP COLUMN profile_parent_id");
    await legacy.exec("ALTER TABLE database_connections DROP COLUMN profile_name");
    await legacy.close();

    const migrated = await openDatabase(config);
    const columns = await migrated.prepare("PRAGMA table_info(database_connections)").all() as Array<{ name: string }>;
    const indexes = await migrated.prepare("PRAGMA index_list(database_connections)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining(["profile_parent_id", "profile_name"]));
    expect(indexes.map((index) => index.name)).toContain("database_connections_profile_idx");
    await migrated.close();
  });

  it("uses real encrypted connection records while inheriting root grants and isolating user preferences", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-database-profiles-"));
    directories.push(directory);
    const config = configFor(directory);
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    const alice = await register(app, "alice");
    const bob = await register(app, "bob");

    const organization = await app.inject({ method: "POST", url: "/api/v1/organizations", cookies: alice.cookies, payload: { name: "Database team", description: "" } });
    const organizationId = organization.json().id as string;
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: alice.cookies, payload: { type: "organization", id: organizationId } });
    const invitation = await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/invitations`, cookies: alice.cookies, payload: { expiresInHours: 24, maxUses: 1 } });
    expect((await app.inject({ method: "POST", url: `/api/v1/organization-invitations/${invitation.json().token}/accept`, cookies: bob.cookies })).statusCode).toBe(201);
    await app.inject({ method: "PUT", url: "/api/v1/auth/workspace", cookies: bob.cookies, payload: { type: "organization", id: organizationId } });

    const connection = await app.inject({
      method: "POST",
      url: "/api/v1/database-connections",
      cookies: alice.cookies,
      payload: { name: "Billing", engine: "mysql", host: "primary.internal", port: 3306, username: "root", credential: { password: "primary-secret" }, defaultDatabase: "billing" },
    });
    const connectionId = connection.json().id as string;
    const profile = await app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${connectionId}/profiles`,
      cookies: alice.cookies,
      payload: {
        profileName: "Read replica",
        name: "Read replica",
        engine: "mysql",
        host: "replica.internal",
        port: 3307,
        username: "reader",
        credential: { password: "replica-secret" },
        defaultDatabase: "billing_ro",
        connectionMode: "tcp",
      },
    });
    expect(profile.statusCode).toBe(201);
    const profileId = profile.json().id as string;

    const defaultList = await app.inject({ method: "GET", url: "/api/v1/connections?type=database", cookies: alice.cookies });
    expect(defaultList.json().items.map((item: { id: string }) => item.id)).toEqual([connectionId]);
    const fullList = await app.inject({ method: "GET", url: "/api/v1/connections?type=database&includeProfiles=true", cookies: alice.cookies });
    expect(fullList.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionId, profileParentId: null, profileName: "" }),
      expect.objectContaining({ id: profileId, profileParentId: connectionId, profileName: "Read replica", host: "replica.internal", port: 3307, username: "reader", defaultDatabase: "billing_ro" }),
    ]));
    const stored = await app.db.prepare("SELECT credential_ciphertext FROM database_connections WHERE id = ?").get(profileId) as { credential_ciphertext: string };
    expect(JSON.parse(app.secrets.decrypt(stored.credential_ciphertext))).toMatchObject({ password: "replica-secret" });

    const updated = await app.inject({
      method: "PUT",
      url: `/api/v1/database-connections/${connectionId}/profiles/${profileId}`,
      cookies: alice.cookies,
      payload: {
        profileName: "Read replica 2",
        name: "Read replica 2",
        engine: "mysql",
        host: "replica-2.internal",
        port: 3308,
        username: "reader2",
        defaultDatabase: "billing_ro_2",
        connectionMode: "tcp",
      },
    });
    expect(updated.statusCode).toBe(200);
    const duplicated = await app.inject({
      method: "POST",
      url: `/api/v1/database-connections/${connectionId}/profiles/${profileId}/duplicate`,
      cookies: alice.cookies,
      payload: { profileName: "Read replica copy" },
    });
    expect(duplicated.statusCode).toBe(201);
    const duplicateId = duplicated.json().id as string;
    expect((await app.inject({
      method: "PUT",
      url: `/api/v1/database-connections/${connectionId}/profiles/active`,
      cookies: alice.cookies,
      payload: { profileId: duplicateId },
    })).statusCode).toBe(200);
    const managedList = await app.inject({ method: "GET", url: "/api/v1/connections?type=database&includeProfiles=true", cookies: alice.cookies });
    expect(managedList.json().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: connectionId, options: expect.objectContaining({ activeProfileId: duplicateId }) }),
      expect.objectContaining({ id: profileId, profileName: "Read replica 2", host: "replica-2.internal", port: 3308 }),
      expect.objectContaining({ id: duplicateId, profileName: "Read replica copy", host: "replica-2.internal", port: 3308 }),
    ]));
    const activeConnection = await app.activeConnections.reserve({
      user: {
        id: alice.id,
        username: "alice",
        isPlatformAdmin: false,
        workspace: { type: "organization", id: organizationId, name: "Database team", role: "owner" },
      },
      type: "database",
      resourceId: duplicateId,
    });
    const blockedSwitch = await app.inject({
      method: "PUT",
      url: `/api/v1/database-connections/${connectionId}/profiles/active`,
      cookies: alice.cookies,
      payload: { profileId: null },
    });
    expect(blockedSwitch.statusCode).toBe(409);
    expect(blockedSwitch.json().error).toBe("CONNECTION_PROFILE_REQUIRES_CLOSED");
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-connections/${connectionId}/profiles/${duplicateId}`, cookies: alice.cookies })).statusCode).toBe(409);
    app.activeConnections.release(activeConnection.id);

    expect((await app.inject({ method: "POST", url: `/api/v1/organizations/${organizationId}/grants`, cookies: alice.cookies, payload: { granteeType: "user", granteeId: bob.id, resourceType: "database_connection", resourceId: connectionId } })).statusCode).toBe(201);
    const bobList = await app.inject({ method: "GET", url: "/api/v1/connections?type=database&includeProfiles=true", cookies: bob.cookies });
    expect(bobList.json().items.map((item: { id: string }) => item.id).sort()).toEqual([connectionId, profileId, duplicateId].sort());
    expect((await app.inject({ method: "POST", url: "/api/v1/database-sessions", cookies: bob.cookies, payload: { connectionId: profileId } })).statusCode).toBe(201);
    expect((await app.inject({ method: "POST", url: `/api/v1/database-connections/${connectionId}/profiles`, cookies: bob.cookies, payload: { profileName: "Forbidden", name: "Forbidden", engine: "mysql", host: "x", port: 3306, username: "x" } })).statusCode).toBe(403);

    expect((await app.inject({ method: "PUT", url: `/api/v1/database-connections/${connectionId}/preferences`, cookies: bob.cookies, payload: { starred: true, color: "#4d78a8" } })).statusCode).toBe(200);
    const bobPreferred = await app.inject({ method: "GET", url: "/api/v1/connections?type=database", cookies: bob.cookies });
    expect(bobPreferred.json().items[0]).toMatchObject({ starred: true, color: "#4d78a8" });
    const aliceUnchanged = await app.inject({ method: "GET", url: "/api/v1/connections?type=database", cookies: alice.cookies });
    expect(aliceUnchanged.json().items[0]).toMatchObject({ starred: false, color: "" });

    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-connections/${connectionId}/profiles/${duplicateId}`, cookies: alice.cookies })).statusCode).toBe(204);
    const afterActiveDelete = await app.inject({ method: "GET", url: "/api/v1/connections?type=database&includeProfiles=true", cookies: alice.cookies });
    expect(afterActiveDelete.json().items.find((item: { id: string }) => item.id === connectionId).options.activeProfileId).toBeNull();
    expect((await app.inject({ method: "DELETE", url: `/api/v1/database-connections/${connectionId}/profiles/${profileId}`, cookies: alice.cookies })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: "/api/v1/connections?type=database&includeProfiles=true", cookies: alice.cookies })).json().items).toHaveLength(1);
    await app.close();
  });
});
