# Viron 文档

- [脚本资源同步](./SCRIPT-SYNC.md)：隔离执行、JSON 输出契约、名称匹配、自动处理和审阅报告。

本目录只维护能够回答“系统现在是什么、如何使用、接下来做什么、当前有哪些已知缺陷”的长期文档，不保存按日期展开的任务执行流水。

## 文档入口

- 项目概览与使用方式：[README](../README.md)
- Codex 与 Viron MCP 接入：[README - Codex 与 MCP 接入](../README.md#codex-与-mcp-接入)
- Viron MCP 架构、能力、当前完成度与续接验收：[MCP](./MCP.md)
- 0.1.6 全功能介绍与操作手册：[USER-GUIDE](./USER-GUIDE.md)
- 当前产品与技术实现：[TECHNICAL-DESIGN](../TECHNICAL-DESIGN.md)
- Viron Agent 设计方案：[AI-AGENT-DESIGN](./AI-AGENT-DESIGN.md)
- 通用联邦登录与外部系统接入方案：[FEDERATED-ACCESS-DESIGN](./FEDERATED-ACCESS-DESIGN.md)
- 数据库工作台 Navicat 对齐基准：[DATABASE-NAVICAT-PARITY](./DATABASE-NAVICAT-PARITY.md)
- 产品定位与设计原则：[PRODUCT](../PRODUCT.md)
- 后续能力规划：[ROADMAP](./ROADMAP.md)
- 当前已知缺陷：[DEFECTS](./DEFECTS.md)

## 维护规则

- 记录当前有效事实、已确认决策、操作方式和仍然存在的边界。
- 未交付需求和候选增强记录在 `ROADMAP.md`；已确认且尚未修复的产品缺陷记录在 `DEFECTS.md`。
- 功能变化时直接更新对应长期文档，不为每次任务创建独立 Markdown。
- 验证命令、提交信息和执行过程由 Git 历史承载，不写入长期文档。
- 临时排查笔记和任务草稿不得提交；完成后应删除。
- 已失效的信息直接修正或删除；缺陷修复并完成验证后从 `DEFECTS.md` 删除，不在正文累计“追加任务”和历史状态。
