import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(new URL(path, import.meta.url), "utf8");
}

describe("Redis product availability", () => {
  it("opens Redis from every shared workbench navigation surface", () => {
    const appShell = source("../src/client/components/AppShell.vue");
    const environmentNavigation = source("../src/client/components/EnvironmentImmersiveNavigation.vue");
    const desktopNavigation = source("../public/desktop-immersive-navigation.html");

    expect(appShell).toContain('routeNames: ["redis"], planned: false');
    expect(environmentNavigation).toContain('<span>Redis</span><small>{{ counts.redis }}</small>');
    expect(desktopNavigation).toContain('label: "Redis", count: state.counts.redis');
    expect(desktopNavigation).not.toContain('label: "Redis", count: "待开放"');
  });

  it("mounts the Redis workbench in standalone and environment views", () => {
    const redisView = source("../src/client/views/RedisWorkbenchView.vue");
    const environmentView = source("../src/client/views/EnvironmentDetailView.vue");

    expect(redisView).toContain('import RedisWorkbench from "../components/RedisWorkbench.vue"');
    expect(redisView).toContain("desktopExecutionTargets.value.redis");
    expect(redisView).toContain('<RedisWorkbench v-else-if="capabilityLoaded"');
    expect(environmentView).toContain('const loadRedisWorkbench = () => import("../components/RedisWorkbench.vue")');
    expect(environmentView).toContain("const RedisWorkbench = defineAsyncComponent(loadRedisWorkbench)");
    expect(environmentView).toContain("environment?.redisCount || 0");
    expect(environmentView).toContain('<RedisWorkbench v-else-if="activeTab === \'redis\'"');
  });

  it("enables Redis setup, inspection and execution target reporting", () => {
    const connectionPool = source("../src/client/views/ConnectionPoolView.vue");
    const connectionTools = source("../src/client/views/ConnectionToolsView.vue");
    const settings = source("../src/client/views/settings/use-settings-controller.ts");

    expect(connectionPool).toContain('<el-dropdown-item @click="resetForm(\'redis\')"><MemoryStick :size="15" />{{ $t(\'Redis 连接\') }}</el-dropdown-item>');
    expect(connectionPool).toContain('<el-radio-button value="redis"><MemoryStick :size="15" />Redis</el-radio-button>');
    expect(connectionPool).toContain('watch(() => route.query.create');
    expect(connectionPool).toContain('if (value === "redis") resetForm("redis")');
    expect(connectionTools).toContain("desktopExecutionTargets.value.inspectionRedis");
    expect(connectionTools).toContain(":redis-enabled=\"!desktop || inspectionRedisTarget !== 'unavailable'\"");
    expect(settings).toContain('{ label: "Redis", target: desktopExecutionTargets.value.redis, planned: false }');
  });

  it("keeps the reopened workbench explicit about read-only and recovery states", () => {
    const workbench = source("../src/client/components/RedisWorkbench.vue");

    expect(workbench).toContain('data-testid="redis-workbench"');
    expect(workbench).toContain("当前 Redis 连接为只读模式");
    expect(workbench).toContain('class="redis-workspace-error"');
    expect(workbench).toContain('query: { create: "redis" }');
    expect(workbench).toContain('const memoryValue = replyText(memory?.result)');
    expect(workbench).toContain('const quickCommands = ["PING", "DBSIZE", "INFO server", "INFO memory", "SLOWLOG GET 16"]');
    expect(workbench).toContain('class="redis-database-select"');
    expect(workbench).not.toContain("<el-input-number");
    expect(workbench).toContain("detectRedisValueView(detail.result, item.type)");
    expect(workbench).toContain('class="redis-value-table"');
    expect(workbench).toContain("detailRequestVersion");
    expect(workbench).toContain("redisKeyTreeRows");
    expect(workbench).toContain('const keyView = ref<"list" | "tree">("tree")');
    expect(workbench).toContain("} while (!scanComplete.value);");
    expect(workbench).not.toContain("继续下一批");
    expect(workbench).not.toContain("redis-load-more");
    expect(workbench).not.toContain("const treeGroups");
  });
});
