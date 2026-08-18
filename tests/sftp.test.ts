import { describe, expect, it } from "vitest";
import { reactive } from "vue";
import type { Stats } from "ssh2";
import {
  createSftpOpenRequest,
  groupSftpConnections,
  isSftpDirectory,
  sftpTransferCreateSnapshot,
  sftpOpenPathForConnection,
  type SftpConnection,
} from "../src/client/sftp.js";
import {
  DESKTOP_LOCAL_SFTP_CONNECTION_ID,
  desktopSftpRemoteConnectionIds,
  sftpEntryTypeFromMetadata as desktopEntryType,
} from "../src/desktop/sftp-runtime.js";
import { sftpEntryTypeFromMetadata as serverEntryType } from "../src/server/routes/sftp.js";

function connection(id: string, environmentIds: string[]): SftpConnection {
  return {
    id,
    type: "ssh",
    name: id,
    host: `${id}.example.com`,
    port: 22,
    username: "root",
    environmentIds,
    connectionGroupPath: null,
  };
}

function attributes(mode: number, directory = false, symlink = false): Stats {
  return {
    mode,
    isDirectory: () => directory,
    isSymbolicLink: () => symlink,
  } as Stats;
}

describe("SFTP connection recommendations", () => {
  it("recommends the current environment without excluding other accessible connections", () => {
    const grouped = groupSftpConnections([
      connection("outside", ["environment-b"]),
      connection("current-idle", ["environment-a"]),
      connection("current-active", ["environment-a", "environment-b"]),
    ], "environment-a", new Set(["current-active", "outside"]));

    expect(grouped.recommended.map((item) => item.id)).toEqual(["current-active", "current-idle"]);
    expect(grouped.others.map((item) => item.id)).toEqual(["outside"]);
  });

  it("shows every accessible connection in a global SSH workbench", () => {
    const grouped = groupSftpConnections([
      connection("idle", []),
      connection("active", ["environment-a"]),
    ], undefined, new Set(["active"]));

    expect(grouped.recommended).toEqual([]);
    expect(grouped.others.map((item) => item.id)).toEqual(["active", "idle"]);
  });
});

describe("SFTP opening from an SSH terminal", () => {
  it("captures an absolute directory for the selected connection", () => {
    const request = createSftpOpenRequest(4, "connection-a", " /opt/app ");

    expect(request).toEqual({ requestId: 4, connectionId: "connection-a", path: "/opt/app" });
    expect(sftpOpenPathForConnection(request, "connection-a")).toBe("/opt/app");
    expect(sftpOpenPathForConnection(request, "connection-b")).toBe("/");
  });

  it("falls back to the default directory when the terminal path is unavailable or not absolute", () => {
    expect(createSftpOpenRequest(1, "connection-a", "路径未知").path).toBe("/");
    expect(createSftpOpenRequest(2, "connection-a", "~/project").path).toBe("/");
    expect(createSftpOpenRequest(3, undefined, "/srv/app")).toEqual({ requestId: 3, connectionId: undefined, path: "/srv/app" });
  });
});

describe("SFTP entry type detection", () => {
  it("keeps Web and desktop metadata classification aligned", () => {
    const cases: Array<[Stats, string, "directory" | "file" | "symlink" | null]> = [
      [attributes(0o040755), "folder", "directory"],
      [attributes(0o100640), "file.txt", "file"],
      [attributes(0o120777), "link", "symlink"],
      [attributes(0o755), "drwxr-xr-x 2 root root 4096 Jul 21 10:00 folder", "directory"],
      [attributes(0o644), "-rw-r--r-- 1 root root 12 Jul 21 10:00 file.txt", "file"],
      [attributes(0o755), "folder", null],
    ];
    for (const [attrs, longname, expected] of cases) {
      expect(serverEntryType(attrs, longname)).toBe(expected);
      expect(desktopEntryType(attrs, longname)).toBe(expected);
    }
  });

  it("treats a symbolic link to a directory as navigable without losing link semantics", () => {
    expect(isSftpDirectory({
      name: "current",
      path: "/current",
      type: "symlink",
      targetType: "directory",
      size: 7,
      mode: "777",
      modifiedAt: "2026-07-21T00:00:00.000Z",
    })).toBe(true);
  });
});

describe("desktop SFTP active connection registration", () => {
  const left = "11111111-1111-4111-8111-111111111111";
  const right = "22222222-2222-4222-8222-222222222222";

  it("registers only real SSH connections for local transfers", () => {
    expect(desktopSftpRemoteConnectionIds(DESKTOP_LOCAL_SFTP_CONNECTION_ID, right)).toEqual([right]);
    expect(desktopSftpRemoteConnectionIds(left, DESKTOP_LOCAL_SFTP_CONNECTION_ID)).toEqual([left]);
  });

  it("keeps both remote SSH connections and rejects local-only transfers", () => {
    expect(desktopSftpRemoteConnectionIds(left, right)).toEqual([left, right]);
    expect(() => desktopSftpRemoteConnectionIds(DESKTOP_LOCAL_SFTP_CONNECTION_ID, DESKTOP_LOCAL_SFTP_CONNECTION_ID))
      .toThrow("本机之间无需使用 SFTP 传输");
  });
});

describe("desktop SFTP transfer IPC payload", () => {
  it("snapshots reactive paths and conflict decisions into cloneable data", () => {
    const input = reactive({
      sourceConnectionId: "source",
      targetConnectionId: "target",
      sourcePaths: ["/release/app.tar.gz"],
      targetDirectory: "/opt/releases",
      conflict: "skip" as const,
      conflictDecisions: { "/opt/releases/app.tar.gz": "overwrite" as const },
      originEnvironmentId: "environment-a",
    });

    expect(() => structuredClone(input)).toThrow();
    const payload = sftpTransferCreateSnapshot(input);
    expect(() => structuredClone(payload)).not.toThrow();
    expect(payload).toEqual(input);
  });
});
