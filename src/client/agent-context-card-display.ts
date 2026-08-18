import { translate as tr } from "./i18n";
import type { AgentContextCard, AgentContextKind } from "../shared/agent.js";

const contextTypeLabels: Record<AgentContextKind, string> = {
  scene: tr("页面"),
  ssh: "SSH",
  database: tr("数据库"),
  log: tr("日志"),
  redis: "Redis",
  web: "Web",
};

const contextTitlePrefixes: Partial<Record<AgentContextKind, RegExp>> = {
  ssh: /^SSH\s*·\s*/i,
  database: /^数据库\s*·\s*/,
};

const sceneNames: Record<string, string> = {
  overview: tr("环境总览"),
  environment: tr("环境详情"),
  connections: tr("连接资源池"),
  "ssh-keys": tr("SSH 密钥"),
  "connection-tools": tr("连接工具"),
  ssh: tr("SSH 工作台"),
  database: tr("数据库工作台"),
  redis: tr("Redis 工作台"),
  "active-connections": tr("当前连接"),
  audit: tr("操作审计"),
  settings: tr("设置"),
  organization: tr("组织与用户"),
  "organization-invitation": tr("组织邀请"),
};

export interface AgentContextCardDisplay {
  name: string;
  typeLabel: string;
}

export function agentSceneName(routeName: unknown): string {
  return sceneNames[String(routeName ?? "")] ?? tr("当前页面");
}

export function agentContextCardDisplay(card: AgentContextCard): AgentContextCardDisplay {
  const typeLabel = contextTypeLabels[card.kind];
  const prefix = contextTitlePrefixes[card.kind];
  const name = (prefix ? card.title.replace(prefix, "") : card.title).trim();
  return { name: name || typeLabel, typeLabel };
}
