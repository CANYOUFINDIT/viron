import { translate as tr } from "./i18n";
export type DatabaseNavigatorCategory = "tables" | "views" | "functions" | "events" | "queries" | "backups";
export type DatabaseObjectSource = "tables" | "views" | "procedures" | "functions" | "triggers" | "events";

export interface DatabaseNavigatorTarget {
  kind: "database" | "category" | "object";
  database: string;
  category?: DatabaseNavigatorCategory;
  objectId?: string;
  objectName?: string;
  objectStatus?: string;
  objectSource?: DatabaseObjectSource;
}

export interface DatabaseNavigatorMenuItem {
  key: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  reason?: string;
  separated?: boolean;
  children?: DatabaseNavigatorMenuItem[];
}

export interface ConnectionNavigatorMenuContext {
  starred?: boolean;
  canManage?: boolean;
  canShare?: boolean;
  connectionGroupId?: string | null;
  groups?: Array<{ id: string; path: string }>;
  profiles?: Array<{ id: string; name: string }>;
  activeProfileId?: string;
}

function manageGroup(hasObject: boolean): DatabaseNavigatorMenuItem {
  return {
    key: "manage-group",
    label: tr("管理组"),
    separated: true,
    children: [
      { key: "new-group", label: tr("新建组") },
      { key: "add-to-group", label: tr("添加到组"), disabled: !hasObject, reason: tr("请先右键具体数据库对象") },
      { key: "exclude-from-group", label: tr("从组中排除"), disabled: !hasObject, reason: tr("请先右键具体数据库对象") },
    ],
  };
}

export function buildConnectionNavigatorMenu(connected: boolean, context: ConnectionNavigatorMenuContext = { canManage: true, canShare: true }): DatabaseNavigatorMenuItem[] {
  const groups = context.groups ?? [];
  const profiles = context.profiles ?? [];
  const canManage = context.canManage !== false;
  return [
    { key: "close-connection", label: tr("关闭连接"), disabled: !connected, reason: tr("当前连接尚未打开") },
    {
      key: "switch-profile",
      label: tr("切换连接配置文件"),
      children: [
        { key: "main-profile", label: tr("{{0}}主要配置文件", [context.activeProfileId ? "" : "✓ "]), disabled: connected, reason: tr("要切换连接配置文件，必须关闭连接") },
        ...profiles.map((profile) => ({
          key: `connection-profile:${profile.id}`,
          label: `${context.activeProfileId === profile.id ? "✓ " : ""}${profile.name}`,
          disabled: connected,
          reason: tr("要切换连接配置文件，必须关闭连接"),
        })),
      ],
    },
    { key: "edit-connection", label: tr("编辑连接…"), separated: true },
    { key: "new-connection", label: tr("新建连接") },
    { key: "delete-connection", label: tr("删除连接"), danger: true },
    { key: "duplicate-connection", label: tr("复制连接…") },
    { key: "new-database", label: tr("新建数据库…"), separated: true, disabled: !connected, reason: tr("请先打开连接") },
    { key: "new-query", label: tr("新建查询"), disabled: !connected, reason: tr("请先打开连接") },
    { key: "command-line", label: tr("命令列界面"), disabled: !connected, reason: tr("请先打开连接") },
    { key: "run-sql-file", label: tr("运行 SQL 文件…"), disabled: !connected, reason: tr("请先打开连接") },
    {
      key: "reload-connection",
      label: tr("重载"),
      children: [
        { key: "reload-privileges", label: tr("权限"), disabled: !connected, reason: tr("请先打开连接") },
        { key: "reload-hosts", label: tr("主机"), disabled: !connected, reason: tr("请先打开连接") },
        { key: "reload-log-files", label: tr("日志文件"), disabled: !connected, reason: tr("请先打开连接") },
        { key: "reload-status", label: tr("状态"), disabled: !connected, reason: tr("请先打开连接") },
        { key: "reload-tables", label: tr("表"), disabled: !connected, reason: tr("请先打开连接") },
      ],
    },
    { key: "star-connection", label: context.starred ? tr("移除星标") : tr("添加星标"), separated: true },
    {
      key: "connection-color",
      label: tr("颜色"),
      children: [
        { key: "connection-color:#4f8f7d", label: tr("绿色") },
        { key: "connection-color:#4d78a8", label: tr("蓝色") },
        { key: "connection-color:#9b6b9e", label: tr("紫色") },
        { key: "connection-color:#b47a3c", label: tr("橙色") },
        { key: "connection-color:#a85151", label: tr("红色") },
        { key: "connection-color:", label: tr("无颜色"), separated: true },
      ],
    },
    {
      key: "manage-connection-group",
      label: tr("管理组"),
      children: [
        { key: "new-connection-group", label: tr("新建组"), disabled: !canManage, reason: tr("只有工作空间管理员可以新建连接组") },
        {
          key: "add-connection-to-group",
          label: tr("添加到组"),
          disabled: !canManage || !groups.length,
          reason: !canManage ? tr("只有工作空间管理员可以移动连接") : tr("当前没有可用连接组"),
          children: groups.map((group) => ({ key: `connection-group:${group.id}`, label: group.path })),
        },
        { key: "exclude-connection-from-group", label: tr("从组中排除"), disabled: !canManage || !context.connectionGroupId, reason: !canManage ? tr("只有工作空间管理员可以移动连接") : tr("当前连接不在组中") },
      ],
    },
    { key: "share-connection", label: tr("共享…"), disabled: !context.canShare, reason: tr("请切换到具有管理权限的组织工作空间") },
    { key: "refresh-connections", label: tr("刷新"), separated: true },
  ];
}

function tableMenu(hasObject: boolean, canShare: boolean, canPaste: boolean, profiles: Array<{ id: string; name: string }>): DatabaseNavigatorMenuItem[] {
  const selectionReason = tr("请先右键具体数据表");
  return [
    { key: "open-object", label: tr("打开表"), disabled: !hasObject, reason: selectionReason },
    { key: "open-object-quick", label: tr("打开表（快速）"), disabled: !hasObject, reason: selectionReason },
    {
      key: "open-through-profile",
      label: tr("通过配置文件打开表"),
      disabled: !hasObject,
      reason: selectionReason,
      children: [
        { key: "open-through-profile:main", label: tr("主要配置文件") },
        ...profiles.map((profile) => ({ key: `open-through-profile:${profile.id}`, label: profile.name })),
      ],
    },
    { key: "design-object", label: tr("设计表"), disabled: !hasObject, reason: selectionReason, separated: true },
    { key: "new-object", label: tr("新建表") },
    { key: "delete-object", label: tr("删除表"), danger: true, disabled: !hasObject, reason: selectionReason },
    { key: "empty-table", label: tr("清空表"), danger: true, disabled: !hasObject, reason: selectionReason, separated: true },
    { key: "truncate-table", label: tr("截断表"), danger: true, disabled: !hasObject, reason: selectionReason },
    {
      key: "duplicate-table",
      label: tr("复制表"),
      disabled: !hasObject,
      reason: selectionReason,
      children: [
        { key: "duplicate-table-data", label: tr("结构和数据") },
        { key: "duplicate-table-structure", label: tr("仅结构") },
      ],
    },
    { key: "table-permissions", label: tr("设置权限"), disabled: !hasObject, reason: selectionReason },
    { key: "import-table", label: tr("导入向导…"), separated: true },
    { key: "export-table", label: tr("导出向导…") },
    { key: "generate-data", label: tr("数据生成…"), disabled: !hasObject, reason: selectionReason },
    { key: "table-dictionary", label: tr("数据字典…"), disabled: !hasObject, reason: selectionReason },
    {
      key: "dump-table",
      label: tr("转储 SQL 文件"),
      children: [
        { key: "dump-table-data", label: tr("结构和数据…"), disabled: !hasObject, reason: selectionReason },
        { key: "dump-table-structure", label: tr("仅结构…"), disabled: !hasObject, reason: selectionReason },
      ],
    },
    {
      key: "maintain-table",
      label: tr("维护"),
      separated: true,
      children: [
        { key: "analyze-table", label: tr("分析表"), disabled: !hasObject, reason: selectionReason },
        {
          key: "check-table",
          label: tr("检查表"),
          children: [
            { key: "check-table-normal", label: tr("常规"), disabled: !hasObject, reason: selectionReason },
            { key: "check-table-quick", label: tr("快速（Quick）"), disabled: !hasObject, reason: selectionReason },
            { key: "check-table-fast", label: tr("快（Fast）"), disabled: !hasObject, reason: selectionReason },
            { key: "check-table-changed", label: tr("已更改"), disabled: !hasObject, reason: selectionReason },
            { key: "check-table-extended", label: tr("扩展"), disabled: !hasObject, reason: selectionReason },
          ],
        },
        { key: "optimize-table", label: tr("优化表"), disabled: !hasObject, reason: selectionReason },
        {
          key: "repair-table",
          label: tr("修复表"),
          children: [
            { key: "repair-table-quick", label: tr("快速（Quick）"), disabled: !hasObject, reason: selectionReason },
            { key: "repair-table-extended", label: tr("扩展"), disabled: !hasObject, reason: selectionReason },
          ],
        },
        { key: "get-row-count", label: tr("获取行的总数"), disabled: !hasObject, reason: selectionReason },
      ],
    },
    manageGroup(hasObject),
    { key: "copy-object", label: tr("复制"), disabled: !hasObject, reason: selectionReason },
    { key: "paste-object", label: tr("粘贴"), disabled: !canPaste, reason: tr("请先复制同类数据库对象") },
    ...(hasObject ? [{ key: "share-object", label: tr("共享…"), disabled: !canShare, reason: tr("请切换到具有管理权限的组织工作空间") }] : []),
    { key: "rename-object", label: tr("重命名"), disabled: !hasObject, reason: selectionReason },
    { key: "refresh-category", label: tr("刷新"), separated: true },
  ];
}

function viewMenu(hasObject: boolean, canShare: boolean, canPaste: boolean): DatabaseNavigatorMenuItem[] {
  const selectionReason = tr("请先右键具体视图");
  return [
    { key: "open-object", label: tr("打开视图"), disabled: !hasObject, reason: selectionReason },
    { key: "design-object", label: tr("设计视图"), disabled: !hasObject, reason: selectionReason },
    { key: "new-object", label: tr("新建视图") },
    { key: "delete-object", label: tr("删除视图"), danger: true, disabled: !hasObject, reason: selectionReason },
    { key: "duplicate-object", label: tr("复制视图"), disabled: !hasObject, reason: selectionReason },
    { key: "view-permissions", label: tr("设置权限"), disabled: !hasObject, reason: selectionReason },
    { key: "export-table", label: tr("导出向导…"), separated: true },
    { key: "table-dictionary", label: tr("数据字典…"), disabled: !hasObject, reason: selectionReason },
    manageGroup(hasObject),
    { key: "copy-object", label: tr("复制"), disabled: !hasObject, reason: selectionReason },
    { key: "paste-object", label: tr("粘贴"), disabled: !canPaste, reason: tr("请先复制同类数据库对象") },
    ...(hasObject ? [{ key: "share-object", label: tr("共享…"), disabled: !canShare, reason: tr("请切换到具有管理权限的组织工作空间") }] : []),
    { key: "rename-object", label: tr("重命名"), disabled: !hasObject, reason: selectionReason },
    { key: "refresh-category", label: tr("刷新"), separated: true },
  ];
}

function routineMenu(hasObject: boolean, canShare: boolean, canPaste: boolean, objectSource?: DatabaseObjectSource): DatabaseNavigatorMenuItem[] {
  const label = objectSource === "procedures" ? tr("存储过程") : tr("函数");
  const selectionReason = tr("请先右键具体{{0}}", [label]);
  return [
    { key: "design-object", label: tr("设计{{0}}", [label]), disabled: !hasObject, reason: selectionReason },
    { key: "new-object", label: tr("新建函数") },
    { key: "delete-object", label: tr("删除{{0}}", [label]), danger: true, disabled: !hasObject, reason: selectionReason },
    { key: "duplicate-object", label: tr("复制{{0}}", [label]), disabled: !hasObject, reason: selectionReason },
    { key: "run-object", label: tr("运行{{0}}", [label]), disabled: !hasObject, reason: selectionReason },
    { key: "routine-permissions", label: tr("设置权限"), disabled: !hasObject, reason: selectionReason },
    manageGroup(hasObject),
    { key: "copy-object", label: tr("复制"), disabled: !hasObject, reason: selectionReason },
    { key: "paste-object", label: tr("粘贴"), disabled: !canPaste, reason: tr("请先复制同类数据库对象") },
    ...(hasObject ? [{ key: "share-object", label: tr("共享…"), disabled: !canShare, reason: tr("请切换到具有管理权限的组织工作空间") }] : []),
    { key: "rename-object", label: tr("重命名"), disabled: !hasObject, reason: selectionReason },
    { key: "refresh-category", label: tr("刷新"), separated: true },
  ];
}

function eventMenu(hasObject: boolean, canShare: boolean, canPaste: boolean): DatabaseNavigatorMenuItem[] {
  const selectionReason = tr("请先右键具体事件");
  return [
    { key: "design-object", label: tr("设计事件"), disabled: !hasObject, reason: selectionReason },
    { key: "new-object", label: tr("新建事件") },
    { key: "delete-object", label: tr("删除事件"), danger: true, disabled: !hasObject, reason: selectionReason },
    { key: "duplicate-object", label: tr("复制事件"), disabled: !hasObject, reason: selectionReason },
    manageGroup(hasObject),
    { key: "copy-object", label: tr("复制"), disabled: !hasObject, reason: selectionReason },
    { key: "paste-object", label: tr("粘贴"), disabled: !canPaste, reason: tr("请先复制同类数据库对象") },
    ...(hasObject ? [{ key: "share-object", label: tr("共享…"), disabled: !canShare, reason: tr("请切换到具有管理权限的组织工作空间") }] : []),
    { key: "rename-object", label: tr("重命名"), disabled: !hasObject, reason: selectionReason },
    { key: "refresh-category", label: tr("刷新"), separated: true },
  ];
}

function queryMenu(hasObject: boolean): DatabaseNavigatorMenuItem[] {
  const selectionReason = tr("请先右键具体查询");
  return [
    { key: "design-query", label: tr("设计查询"), disabled: !hasObject, reason: selectionReason },
    { key: "new-query", label: tr("新建查询") },
    { key: "delete-query", label: tr("删除查询"), danger: true, disabled: !hasObject, reason: selectionReason },
    { key: "duplicate-query", label: tr("复制查询"), disabled: !hasObject, reason: selectionReason },
    { key: "export-query", label: tr("导出向导…"), disabled: !hasObject, reason: selectionReason, separated: true },
    manageGroup(false),
    { key: "rename-query", label: tr("重命名"), disabled: !hasObject, reason: selectionReason },
    { key: "external-editor", label: tr("使用外部编辑器打开"), disabled: !hasObject, reason: selectionReason, separated: true },
    { key: "show-query-finder", label: tr("在 Finder 中显示"), disabled: !hasObject, reason: selectionReason },
    { key: "open-external-query", label: tr("打开外部查询…") },
    { key: "refresh-queries", label: tr("刷新"), separated: true },
  ];
}

function backupMenu(hasObject: boolean, status?: string): DatabaseNavigatorMenuItem[] {
  const selectionReason = tr("请先右键具体备份");
  const ready = hasObject && status === "success";
  const running = status === "pending" || status === "running";
  return [
    { key: "restore-selected-backup", label: tr("还原备份"), disabled: !ready, reason: ready ? undefined : tr("请先选择已完成的备份") },
    { key: "new-backup", label: tr("新建备份") },
    { key: "delete-backup", label: tr("删除备份"), danger: true, disabled: !hasObject || running, reason: running ? tr("请先取消运行中的备份") : selectionReason },
    { key: "duplicate-backup", label: tr("复制备份"), disabled: !ready, reason: ready ? undefined : tr("请先选择已完成的备份") },
    { key: "restore-backup-from", label: tr("还原备份从…"), separated: true },
    { key: "extract-sql-from", label: tr("提取 SQL 从…") },
    { key: "extract-selected-sql", label: tr("提取 SQL…"), disabled: !ready, reason: ready ? undefined : tr("请先选择已完成的备份") },
    manageGroup(false),
    { key: "rename-backup", label: tr("重命名"), disabled: !ready, reason: ready ? undefined : tr("请先选择已完成的备份") },
    { key: "show-backup-finder", label: tr("在 Finder 中显示"), disabled: !ready, reason: ready ? undefined : tr("请先选择已完成的备份"), separated: true },
    { key: "refresh-backups", label: tr("刷新"), separated: true },
  ];
}

export function buildDatabaseNavigatorMenu(target: DatabaseNavigatorTarget, context: { canShare?: boolean; canPaste?: boolean; profiles?: Array<{ id: string; name: string }> } = { canShare: true }): DatabaseNavigatorMenuItem[] {
  if (target.kind === "database") {
    return [
      { key: "close-database", label: tr("关闭数据库") },
      { key: "edit-database", label: tr("编辑数据库…"), separated: true },
      { key: "new-database", label: tr("新建数据库…") },
      { key: "delete-database", label: tr("删除数据库"), danger: true },
      { key: "new-query", label: tr("新建查询"), separated: true },
      { key: "command-line", label: tr("命令列界面") },
      { key: "run-sql-file", label: tr("运行 SQL 文件…") },
      {
        key: "dump-database",
        label: tr("转储 SQL 文件"),
        children: [
          { key: "dump-database-full", label: tr("结构和数据…") },
          { key: "dump-database-structure", label: tr("仅结构…") },
        ],
      },
      { key: "database-dictionary", label: tr("数据字典…") },
      { key: "search-database", label: tr("在数据库中查找…") },
      { key: "share-database", label: tr("共享…"), disabled: !context.canShare, reason: tr("请切换到具有管理权限的组织工作空间") },
      { key: "refresh-database", label: tr("刷新"), separated: true },
    ];
  }

  if (target.category === "queries") return queryMenu(target.kind === "object" && Boolean(target.objectId));
  if (target.category === "backups") return backupMenu(target.kind === "object" && Boolean(target.objectId), target.objectStatus);
  const hasObject = target.kind === "object";
  const canShare = context.canShare !== false;
  const canPaste = context.canPaste === true;
  if (target.category === "tables") return tableMenu(hasObject, canShare, canPaste, context.profiles ?? []);
  if (target.category === "views") return viewMenu(hasObject, canShare, canPaste);
  if (target.category === "functions") return routineMenu(hasObject, canShare, canPaste, target.objectSource);
  return eventMenu(hasObject, canShare, canPaste);
}
