import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { openDatabase, ensureAdmin } from "../src/server/database.js";
import { recordAccessEvent } from "../src/server/access-governance-events.js";
import type { AppConfig } from "../src/server/config.js";

describe("legacy governance after role migration", () => {
  it("preserves named history and pending requests while freezing approvals, submissions and workflow writes", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viron-governance-history-"));
    const config: AppConfig = {
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 0,
      dataDir: directory,
      databasePath: join(directory, "db.sqlite"),
      masterKey: Buffer.alloc(32, 19),
      adminUsername: "admin",
      adminPassword: "test-password-123",
      allowWeakPasswords: true,
      sessionTtlHours: 12,
      terminalIdleMinutes: 30,
      auditRetentionDays: 30,
    };
    const db = await openDatabase(config);
    await ensureAdmin(db, config);
    const app = await buildApp({ config, db, logger: false });
    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/v1/auth/login",
        payload: { username: "admin", password: config.adminPassword },
      });
      const userId = login.json().user.id as string;
      const cookies = { envman_session: login.cookies[0].value };
      const organization = await app.inject({
        method: "POST",
        url: "/api/v1/organizations",
        cookies,
        payload: { name: "历史组织" },
      });
      const org = organization.json().id as string,
        base = `/api/v1/organizations/${org}`;
      await app.inject({
        method: "PUT",
        url: "/api/v1/auth/workspace",
        cookies,
        payload: { type: "organization", id: org },
      });
      const id = randomUUID(),
        now = new Date().toISOString();
      const workflow = {
        name: "旧审批",
        stages: [{ name: "审核", mode: "any", approverIds: [userId] }],
      };
      const snapshot = {
        granteeType: "user",
        granteeId: userId,
        granteeName: "admin",
        scopeKind: "environment",
        wholeGroup: false,
        groupId: null,
        targetIds: [],
        permissions: { web: ["view"] },
        items: {},
        startsAt: null,
        expiresAt: null,
        label: "已删除的历史环境",
      };
      await db
        .prepare(
          "INSERT INTO access_requests (id,organization_id,requester_id,requester_name,reason,status,authorization_json,snapshot_json,workflow_json,approver_names_json,stage_index,stage_approvals_json,version,pending_key,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?,?,0,'[]',0,?,?,?)",
        )
        .run(
          id,
          org,
          userId,
          "admin",
          "历史原因",
          JSON.stringify(snapshot),
          JSON.stringify(snapshot),
          JSON.stringify(workflow),
          JSON.stringify({ [userId]: "admin" }),
          randomUUID(),
          now,
          now,
        );
      await recordAccessEvent(db, org, {
        action: "requested",
        requestId: id,
        reason: "历史原因",
        after: { ...snapshot, permissionText: "查看 Web" } as never,
        details: { workflow },
        actorId: userId,
        actorName: "admin",
      });
      for (const [method, path, payload] of [
        ["POST", "/access-requests", {}],
        ["PUT", "/approval-workflow", workflow],
        [
          "POST",
          `/access-requests/${id}/decisions`,
          { decision: "approve", reason: "旧审批" },
        ],
        ["POST", "/grants", {}],
        ["PUT", "/grants/" + randomUUID(), {}],
        ["DELETE", "/grants/" + randomUUID(), { reason: "旧撤销" }],
      ] as const) {
        const r = await app.inject({
          method,
          url: base + path,
          cookies,
          payload,
        });
        expect(r.statusCode, r.body).toBe(410);
      }
      const detail = await app.inject({
        method: "GET",
        url: base + `/access-requests/${id}`,
        cookies,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().item).toMatchObject({
        status: "pending",
        canApprove: false,
        canWithdraw: true,
      });
      const history = await app.inject({
        method: "GET",
        url: base + "/access-history",
        cookies,
      });
      expect(history.statusCode, history.body).toBe(200);
      expect(history.json().items[0]).toMatchObject({
        reason: "历史原因",
        after: { label: "已删除的历史环境" },
      });
      const withdrawn = await app.inject({
        method: "POST",
        url: base + `/access-requests/${id}/withdraw`,
        cookies,
        payload: { reason: "迁移后撤回" },
      });
      expect(withdrawn.statusCode, withdrawn.body).toBe(200);
      expect(
        (await db
          .prepare("SELECT status FROM access_requests WHERE id=?")
          .get(id))!.status,
      ).toBe("withdrawn");
      expect(
        (await db
          .prepare(
            "SELECT COUNT(*) AS count FROM organization_role_data_grants WHERE organization_id=?",
          )
          .get(org))!.count,
      ).toBe(0);
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
