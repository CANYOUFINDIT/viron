import { describe, expect, it } from "vitest";
import {
  detectRedisValueView,
  redisDatabaseOptions,
  redisDetailCursor,
  redisDetailRows,
  redisKeyGroupPaths,
  redisKeyTreeRows,
} from "../src/client/redis-workbench-format.js";
import { redisBinaryValue, redisReply } from "../src/shared/redis.js";

describe("Redis workbench presentation", () => {
  it("builds a familiar database selector with key counts", () => {
    const options = redisDatabaseOptions({ db2: "keys=665,expires=13", db20: "keys=4,expires=0" }, 2, 20);

    expect(options).toHaveLength(17);
    expect(options.find((item) => item.database === 2)).toEqual({ database: 2, keys: 665, expires: 13 });
    expect(options.find((item) => item.database === 20)).toEqual({ database: 20, keys: 4, expires: 0 });
  });

  it("automatically selects JSON, UTF-8 or Base64 without guessing encoded text", () => {
    expect(detectRedisValueView(redisReply('{"ok":true}'), "string")).toBe("json");
    expect(detectRedisValueView(redisReply("plain text"), "string")).toBe("utf8");
    expect(detectRedisValueView({ type: "binary", value: redisBinaryValue(Buffer.from([0, 0xff, 1])) }, "string")).toBe("base64");
    expect(detectRedisValueView(redisReply("SGVsbG8="), "string")).toBe("utf8");
  });

  it("removes the SSCAN cursor wrapper before numbering Set members", () => {
    const reply = redisReply(["0", ["aliyuncn-hangzhou-acdr-ut-3"]]);

    expect(redisDetailCursor("set", reply)).toBe("0");
    expect(redisDetailRows("set", reply, "utf8")).toEqual([
      { index: 1, primary: "aliyuncn-hangzhou-acdr-ut-3", secondary: "" },
    ]);
  });

  it("pairs Hash, Sorted Set and Stream values into semantic columns", () => {
    expect(redisDetailRows("hash", redisReply(["0", ["field", "value"]]), "utf8")).toEqual([
      { index: 1, primary: "field", secondary: "value" },
    ]);
    expect(redisDetailRows("zset", redisReply(["member", "42"]), "utf8")).toEqual([
      { index: 1, primary: "member", secondary: "42" },
    ]);
    expect(redisDetailRows("stream", redisReply([["1-0", ["event", "created"]]]), "utf8")).toEqual([
      { index: 1, primary: "1-0", secondary: "event = created" },
    ]);
  });

  it("builds a collapsible multi-level namespace tree", () => {
    const item = (key: string) => ({ key: redisBinaryValue(Buffer.from(key)), type: "string" as const, ttlMs: -1 });
    const keys = [
      item("plain-key"),
      item("gitea:131460338188087296"),
      item("token::access_token::05ee72cb"),
      item("token::refresh_token::0df5041e"),
    ];

    const collapsed = redisKeyTreeRows(keys, ":", new Set());
    expect(collapsed.map((row) => row.kind === "group" ? `${row.name}:${row.count}` : row.label)).toEqual([
      "gitea:1",
      "token:2",
      "plain-key",
    ]);

    const expanded = new Set(redisKeyGroupPaths(keys[2].key, ":"));
    const rows = redisKeyTreeRows(keys, ":", expanded);
    expect(rows.map((row) => row.kind === "group" ? `${row.depth}:${row.name}:${row.count}` : `${row.depth}:${row.label}`)).toEqual([
      "0:gitea:1",
      "0:token:2",
      "1:access_token:1",
      "2:05ee72cb",
      "1:refresh_token:1",
      "0:plain-key",
    ]);
  });
});
