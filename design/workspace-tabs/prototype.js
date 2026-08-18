const concept = document.body.dataset.concept ?? "continuous";
const root = document.querySelector("#prototype-root");

const conceptLabels = {
  chrome: { name: "Chrome 式标签", code: "CHROME WORKSPACE TABS" },
  continuous: { name: "连续标签", code: "CONTINUOUS TABS" },
  deck: { name: "双层指挥台", code: "COMMAND DECK" },
  rail: { name: "紧凑命令轨", code: "COMMAND RAIL" },
};

const isChrome = concept === "chrome";
const chromeWorkspaces = [
  { id: "overview", type: "page", glyph: "ENV", title: "环境总览", detail: "全部环境", status: "neutral", statusText: "固定", closable: false, fixed: true },
  { id: "connections", type: "page", glyph: "POOL", title: "连接资源池", detail: "42 个连接", status: "neutral", statusText: "固定", closable: false, fixed: true },
  { id: "ssh-hub", type: "ssh-hub", glyph: "SSH", title: "SSH 工作台", detail: "28 个 SSH 连接", status: "neutral", statusText: "固定", closable: false, fixed: true },
  { id: "database-hub", type: "database-hub", glyph: "DB", title: "数据库工作台", detail: "14 个数据库连接", status: "neutral", statusText: "固定", closable: false, fixed: true },
  { id: "audit", type: "page", glyph: "AUD", title: "操作审计", detail: "今天 128 条", status: "neutral", statusText: "固定", closable: false, fixed: true },
];
const exploredWorkspaces = [
  { id: "overview", type: "page", glyph: "ENV", title: "环境总览", detail: "全部环境", status: "neutral", statusText: "固定", closable: false },
  { id: "connections", type: "page", glyph: "POOL", title: "连接资源池", detail: "42 个连接", status: "neutral", statusText: "页面", closable: true },
  { id: "ssh-bkk", type: "ssh", glyph: "SSH", title: "曼谷 / bkk-web-02", detail: "root · 31.195.18.42", status: "connected", statusText: "在线 · 42ms", closable: true, shells: 2 },
  { id: "db-cbdp", type: "database", glyph: "DB", title: "31.195 / ag-cbdp", detail: "MySQL 8.0 · cbdp", status: "task", statusText: "查询中 · 18s", closable: true, dirty: true, runningQueries: 1 },
  { id: "audit", type: "page", glyph: "AUD", title: "操作审计", detail: "今天 128 条", status: "neutral", statusText: "页面", closable: true },
  { id: "settings", type: "page", glyph: "SET", title: "平台设置", detail: "单机模式", status: "neutral", statusText: "页面", closable: true },
];

const state = {
  activeId: isChrome ? "overview" : "ssh-bkk",
  workspaces: (isChrome ? chromeWorkspaces : exploredWorkspaces).map((workspace) => ({ ...workspace })),
  candidates: [
    { id: "ssh-bkk", type: "ssh", glyph: "SSH", title: "曼谷 / bkk-web-02", detail: "root · 31.195.18.42", status: "connected", statusText: "在线 · 42ms", closable: true, shells: 2, hubId: "ssh-hub" },
    { id: "ssh-cache", type: "ssh", glyph: "SSH", title: "生产 / redis-cache-01", detail: "deploy · 10.2.8.17", status: "connecting", statusText: "连接中", closable: true, shells: 1 },
    { id: "ssh-log", type: "ssh", glyph: "SSH", title: "日志 / loki-prod", detail: "ops · 10.4.12.9", status: "disconnected", statusText: "已断开", closable: true, shells: 1 },
    { id: "db-cbdp", type: "database", glyph: "DB", title: "31.195 / ag-cbdp", detail: "MySQL 8.0 · cbdp", status: "task", statusText: "查询中 · 18s", closable: true, dirty: true, runningQueries: 1, hubId: "database-hub" },
    { id: "db-analytics", type: "database", glyph: "DB", title: "数据 / analytics", detail: "MariaDB 10.11 · analytics", status: "connected", statusText: "可用", closable: true, dirty: false, runningQueries: 0 },
  ],
  allOpen: false,
  pickerOpen: false,
  closeTarget: null,
  query: "",
  dark: false,
  toast: "",
  terminalLines: [],
  openMenuFor: null,
  currentConnectionByHub: {},
  immersive: false,
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

function statusDot(workspace) {
  return `<i class="status-dot status-dot--${workspace.status}" aria-hidden="true"></i>`;
}

function renderBrand() {
  return `
    <button class="brand-button" data-action="activate" data-id="overview" aria-label="打开环境总览">
      <span class="brand-mark"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="16" y="16" width="6" height="6" rx="1"></rect><rect x="2" y="16" width="6" height="6" rx="1"></rect><rect x="9" y="2" width="6" height="6" rx="1"></rect><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"></path><path d="M12 12V8"></path></svg></span>
      <div><strong>Viron</strong><small>环境运维平台</small></div>
    </button>`;
}

function renderOperator() {
  return `<div class="operator-chip" aria-label="当前管理员 admin"><i>A</i><span>admin</span></div>`;
}

function renderTab(workspace) {
  const active = workspace.id === state.activeId;
  return `
    <div class="workspace-tab ${active ? "is-active" : ""}" role="tab" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" data-action="activate" data-id="${workspace.id}">
      <span class="type-glyph">${workspace.glyph}</span>
      <span class="workspace-tab__copy"><strong>${workspace.title}</strong><small>${statusDot(workspace)}${workspace.statusText}</small></span>
      ${workspace.dirty ? '<span class="dirty-mark" aria-label="有未保存变更">•</span>' : ""}
      ${workspace.closable ? `<button class="tab-close" data-action="close" data-id="${workspace.id}" aria-label="关闭 ${workspace.title}">×</button>` : ""}
    </div>`;
}

function renderCompactTab(workspace) {
  const active = workspace.id === state.activeId;
  return `
    <button class="compact-tab ${active ? "is-active" : ""}" role="tab" aria-selected="${active}" data-action="activate" data-id="${workspace.id}" aria-label="${workspace.title}，${workspace.statusText}">
      ${statusDot(workspace)}<span>${workspace.glyph}</span><small>${workspace.title}</small>
    </button>`;
}

function renderChromeTab(workspace) {
  const active = workspace.id === state.activeId;
  return `
    <div class="chrome-tab ${active ? "is-active" : ""} ${workspace.fixed ? "is-fixed" : "is-dynamic"}" role="tab" aria-selected="${active}" tabindex="${active ? "0" : "-1"}" data-action="activate" data-id="${workspace.id}">
      ${workspace.fixed ? "" : statusDot(workspace)}
      <span class="chrome-tab__title">${workspace.title}</span>
      ${workspace.dirty ? '<span class="dirty-mark" aria-label="有未保存变更">•</span>' : ""}
      ${workspace.closable ? `<button class="chrome-tab__close" data-action="close" data-id="${workspace.id}" aria-label="关闭 ${workspace.title}">×</button>` : ""}
    </div>`;
}

function chromeControlIcon(name) {
  const paths = {
    settings: '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"></path><circle cx="12" cy="12" r="3"></circle>',
    immersive: '<path d="M15 3h6v6"></path><path d="m21 3-7 7"></path><path d="m3 21 7-7"></path><path d="M9 21H3v-6"></path>',
    theme: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"></path>',
  };
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
}

function renderChromeHeader() {
  return `
    <header class="chrome-header">
      <div class="chrome-brand">${renderBrand()}</div>
      <nav class="chrome-tab-strip" role="tablist" aria-label="Viron 页面与连接标签">${state.workspaces.map(renderChromeTab).join("")}</nav>
      <span class="chrome-header__spacer"></span>
      <div class="chrome-tail" aria-label="平台控制">
        <span class="service-health"><i class="status-dot status-dot--connected"></i><span>服务正常</span></span>
        <button class="chrome-tail__button" data-action="settings" aria-label="平台设置" title="平台设置">${chromeControlIcon("settings")}</button>
        <button class="chrome-tail__button" data-action="immersive" aria-label="进入沉浸模式" title="进入沉浸模式">${chromeControlIcon("immersive")}</button>
        <button class="chrome-tail__button" data-action="theme" aria-label="切换主题" title="切换主题">${chromeControlIcon("theme")}</button>
        ${renderOperator()}
      </div>
    </header>`;
}

function renderGlobalActions({ newLabel = "新建工作区" } = {}) {
  return `
    <button class="quiet-button" data-action="launcher">应用启动器</button>
    <button class="primary-button" data-action="picker">+ ${newLabel}</button>
    <button class="icon-button" data-action="theme" aria-label="切换明暗主题">◐</button>
    ${renderOperator()}`;
}

function renderHeader() {
  if (concept === "chrome") return renderChromeHeader();
  const tabs = state.workspaces.map(renderTab).join("");
  if (concept === "deck") {
    return `
      <header class="shell-top shell-top--deck">
        <div class="global-row">
          ${renderBrand()}
          <span class="global-row__spacer"></span>
          <span class="connection-readout"><i class="status-dot status-dot--connected"></i> 服务运行正常</span>
          ${renderGlobalActions()}
        </div>
        <div class="workspace-row">
          <span class="workspace-row__label">OPEN WORKSPACES</span>
          <nav class="workspace-tabs" role="tablist" aria-label="打开的工作区">${tabs}</nav>
          <button class="icon-button" data-action="all" aria-label="显示全部工作区">${state.workspaces.length}</button>
        </div>
      </header>`;
  }

  if (concept === "rail") {
    const active = activeWorkspace();
    return `
      <header class="shell-top shell-top--rail">
        <div class="rail-row">
          ${renderBrand()}
          <div class="active-summary"><small>${conceptLabels[concept].code}</small><strong>${active.title}</strong><span>${active.detail} · ${active.statusText}</span></div>
          <nav class="compact-tabs" role="tablist" aria-label="打开的工作区">${state.workspaces.map(renderCompactTab).join("")}</nav>
          <div class="global-row">
            <button class="icon-button" data-action="all" aria-label="显示全部工作区">⌘</button>
            <button class="primary-button" data-action="picker">+ 工作区</button>
            <button class="icon-button" data-action="theme" aria-label="切换明暗主题">◐</button>
            ${renderOperator()}
          </div>
        </div>
      </header>`;
  }

  return `
    <header class="shell-top shell-top--continuous">
      ${renderBrand()}
      <nav class="workspace-tabs" role="tablist" aria-label="打开的工作区">${tabs}</nav>
      <div class="global-row">
        <button class="icon-button" data-action="all" aria-label="显示全部工作区">${state.workspaces.length}</button>
        ${renderGlobalActions({ newLabel: "新建" })}
      </div>
    </header>`;
}

function activeWorkspace() {
  return state.workspaces.find((workspace) => workspace.id === state.activeId) ?? state.workspaces[0];
}

function stageTitle(workspace) {
  const map = { ssh: "SSH WORKSPACE", database: "DATABASE WORKSPACE", page: "PAGE WORKSPACE" };
  return map[workspace.type];
}

function renderStageToolbar(workspace) {
  return `
    <div class="stage-toolbar">
      <div class="stage-identity"><span class="stage-kicker">${stageTitle(workspace)} / ${conceptLabels[concept].code}</span><h1>${workspace.title}</h1><p>${workspace.detail} · 工作区切换不会释放当前现场</p></div>
      <span class="stage-toolbar__spacer"></span>
      <span class="connection-readout">${statusDot(workspace)} ${workspace.statusText}</span>
      <button class="command-button" data-action="all">全部工作区</button>
      <button class="command-button" data-action="picker">打开连接</button>
      ${workspace.closable ? `<button class="command-button" data-action="close" data-id="${workspace.id}">关闭</button>` : ""}
    </div>`;
}

function renderSshWorkbench(workspace = activeWorkspace()) {
  const host = workspace.title.split("/").at(-1)?.trim() || "bkk-web-02";
  const username = workspace.detail.split("·")[0]?.trim() || "root";
  const extraLines = state.terminalLines.map((line) => `<p><span class="prompt">${username}@${host}</span>:<span class="ok">/srv/envman</span># ${escapeHtml(line)}</p><p class="dim">command completed · exit 0</p>`).join("");
  return `
    <section class="workbench-frame">
      <header class="workbench-head">
        <div class="workbench-head__path"><strong>SSH 工作台</strong><span>/</span><strong>${workspace.title}</strong><span>/</span>${workspace.detail}</div>
        <div class="workbench-head__stats"><span>SESSION 2 / 20</span><span>BUFFER 84 KB / 512 KB</span><span>LATENCY 42 MS</span></div>
      </header>
      <div class="workbench-body">
        <section class="terminal-pane">
          <nav class="terminal-tabs" aria-label="Shell 会话"><button class="is-active">SHELL 01 · ROOT</button><button>SHELL 02 · LOGS</button><button class="new-shell" aria-label="新建 Shell">+</button></nav>
          <div class="terminal-output" aria-live="polite">
            <p class="dim">Last login: Fri Jul 17 16:42:08 2026 from 10.18.2.14</p>
            <p><span class="prompt">${username}@${host}</span>:<span class="ok">~</span># cd /srv/envman</p>
            <p><span class="prompt">${username}@${host}</span>:<span class="ok">/srv/envman</span># docker compose ps</p>
            <p>NAME       IMAGE           SERVICE    STATUS</p>
            <p><span class="ok">envman     envman:local    envman     Up 18 hours (healthy)</span></p>
            <p><span class="prompt">${username}@${host}</span>:<span class="ok">/srv/envman</span># tail -n 3 data/runtime.log</p>
            <p class="dim">16:46:31  INFO  ssh.session.attached  session=9a7f</p>
            <p class="dim">16:46:32  INFO  database.query.done   duration=184ms</p>
            <p class="warn">16:46:38  WARN  source.sync.retry    source=securecrt-bkk</p>
            ${extraLines}
            <p><span class="prompt">${username}@${host}</span>:<span class="ok">/srv/envman</span># <span class="dim">▌</span></p>
          </div>
          <form class="terminal-command" data-action="terminal-form"><span>COMMAND</span><input name="command" autocomplete="off" value="systemctl status envman" aria-label="终端命令演示" /><button class="command-button" type="submit">执行</button></form>
          <footer class="terminal-status"><span>UTF-8</span><span>XTERM-256COLOR</span><span>COLS 142</span><span>ROWS 38</span><span>REC ●</span></footer>
        </section>
        <aside class="sftp-pane">
          <header class="sftp-head"><strong>SFTP 文件</strong><span>CONNECTED</span></header>
          <div class="sftp-path">/srv/envman</div>
          <div class="file-list">
            <div class="file-row"><span class="file-type">DIR</span><strong>data</strong><small>16:40</small></div>
            <div class="file-row"><span class="file-type">DIR</span><strong>release</strong><small>07-15</small></div>
            <div class="file-row"><span class="file-type">DIR</span><strong>secrets</strong><small>07-12</small></div>
            <div class="file-row"><span class="file-type">YML</span><strong>docker-compose.yml</strong><small>1.2 KB</small></div>
            <div class="file-row"><span class="file-type">ENV</span><strong>.env</strong><small>604 B</small></div>
            <div class="file-row"><span class="file-type">LOG</span><strong>runtime.log</strong><small>8.4 MB</small></div>
          </div>
        </aside>
      </div>
    </section>`;
}

function renderDatabaseWorkbench(workspace = activeWorkspace()) {
  return `
    <section class="workbench-frame">
      <header class="workbench-head"><div class="workbench-head__path"><strong>${workspace.title}</strong><span>/</span>${workspace.detail}</div><div class="workbench-head__stats"><span>QUERY 1 / 10</span><span>18.4 SEC</span></div></header>
      <div class="database-body">
        <aside class="schema-tree"><header class="schema-tree__head"><strong>数据库对象</strong><span>8 SCHEMAS</span></header><div class="tree-item">▾ cbdp</div><div class="tree-item tree-item--child is-selected">表 · deployment_task</div><div class="tree-item tree-item--child">视图 · v_environment_health</div><div class="tree-item tree-item--child">存储过程 · sync_resource</div><div class="tree-item">› information_schema</div><div class="tree-item">› mysql</div></aside>
        <main class="sql-editor">
          <div class="editor-tools"><button class="primary-button">执行</button><button class="command-button">EXPLAIN</button><button class="command-button">取消查询</button><span class="spacer"></span><span class="connection-readout"><i class="status-dot status-dot--task"></i> 后台执行中</span></div>
          <div class="code-stage"><span class="comment">-- 生产环境最近 24 小时部署状态</span><br /><span class="kw">SELECT</span> environment_name, service_name, status,<br />&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;duration_ms, finished_at<br /><span class="kw">FROM</span> deployment_task<br /><span class="kw">WHERE</span> finished_at &gt; NOW() - <span class="kw">INTERVAL</span> <span class="string">'24 hours'</span><br /><span class="kw">ORDER BY</span> finished_at <span class="kw">DESC</span><br /><span class="kw">LIMIT</span> 200;</div>
          <div class="result-strip"><strong>结果 1</strong><span>4 行 · 查询仍在后台同步剩余分片</span></div>
          <table class="result-table"><thead><tr><th>ENVIRONMENT</th><th>SERVICE</th><th>STATUS</th><th>DURATION</th></tr></thead><tbody><tr><td>曼谷生产</td><td>envman-web</td><td>success</td><td>18422 ms</td></tr><tr><td>新加坡灰度</td><td>gateway</td><td>running</td><td>—</td></tr><tr><td>东京生产</td><td>audit-sync</td><td>success</td><td>7281 ms</td></tr></tbody></table>
        </main>
      </div>
    </section>`;
}

function renderGenericPage(workspace) {
  return `
    <section class="generic-page">
      <div class="metric-row"><div class="metric"><span>环境</span><strong>12</strong><small>全部正常</small></div><div class="metric"><span>SSH 连接</span><strong>28</strong><small>3 个在线</small></div><div class="metric"><span>数据库</span><strong>14</strong><small>1 个查询中</small></div><div class="metric"><span>今日操作</span><strong>128</strong><small>0 个高风险</small></div></div>
      <div class="environment-list">
        <div class="environment-row"><strong>曼谷生产环境</strong><span>8 个资源</span><span>3 个在线</span><code>HEALTHY</code><button class="command-button">打开</button></div>
        <div class="environment-row"><strong>新加坡灰度环境</strong><span>5 个资源</span><span>1 个在线</span><code>HEALTHY</code><button class="command-button">打开</button></div>
        <div class="environment-row"><strong>东京数据环境</strong><span>11 个资源</span><span>0 个在线</span><code>STANDBY</code><button class="command-button">打开</button></div>
        <div class="environment-row"><strong>${workspace.title}</strong><span>${workspace.detail}</span><span>当前页面</span><code>ACTIVE</code><button class="command-button">详情</button></div>
      </div>
    </section>`;
}

function connectionAction(connection) {
  const menuOpen = state.openMenuFor === connection.id;
  return `
    <div class="connection-open-control">
      <button class="connection-open-primary" data-action="open-current" data-id="${connection.id}">打开</button>
      <button class="connection-open-more" data-action="toggle-open-menu" data-id="${connection.id}" aria-expanded="${menuOpen}">打开方式</button>
      ${menuOpen ? `<div class="connection-open-menu" role="menu"><button role="menuitem" data-action="open-current" data-id="${connection.id}">在当前标签页中打开</button><button role="menuitem" data-action="open-new-tab" data-id="${connection.id}">在新标签页中打开</button></div>` : ""}
    </div>`;
}

function renderChromeOverview() {
  const ssh = state.candidates.find((candidate) => candidate.id === "ssh-bkk");
  const database = state.candidates.find((candidate) => candidate.id === "db-cbdp");
  return `
    <main class="chrome-main chrome-overview">
      <section class="overview-toolbar" aria-label="环境筛选">
        <input aria-label="搜索环境" placeholder="搜索环境名称、负责人、标签…" />
        <button>全部状态</button><button>应用筛选</button>
        <span class="overview-toolbar__spacer"></span>
        <span class="overview-health">0 个异常环境</span><button>数据概览</button><button>新建环境组</button><button class="overview-primary">+ 新建环境</button>
      </section>
      <nav class="group-pills" aria-label="环境分组"><button class="is-active">全部</button><button>验收环境组 <small>1</small></button><button>未分组 <small>0</small></button></nav>
      <section class="environment-card">
        <header><div><span class="environment-kicker">PRODUCTION / BANGKOK</span><h1>曼谷生产环境</h1><p>核心 Web 与数据服务 · 最近检查 2 分钟前</p></div><span class="environment-state"><i class="status-dot status-dot--connected"></i>运行正常</span></header>
        <div class="resource-list">
          <article class="resource-row"><span class="resource-type">SSH</span><div><strong>${ssh.title}</strong><small>${ssh.detail} · ${ssh.statusText}</small></div>${connectionAction(ssh)}</article>
          <article class="resource-row"><span class="resource-type">DB</span><div><strong>${database.title}</strong><small>${database.detail} · ${database.statusText}</small></div>${connectionAction(database)}</article>
        </div>
      </section>
    </main>`;
}

function renderConnectionHub(type) {
  const isSsh = type === "ssh";
  const connections = state.candidates.filter((candidate) => candidate.type === type);
  return `
    <main class="chrome-main connection-hub">
      <header class="hub-heading"><div><span>${isSsh ? "SSH CONNECTIONS" : "DATABASE CONNECTIONS"}</span><h1>${isSsh ? "SSH 工作台" : "数据库工作台"}</h1><p>选择连接后，可在当前菜单标签中打开，或保留列表并创建独立连接标签。</p></div><button class="overview-primary">+ 新建连接</button></header>
      <section class="hub-toolbar"><input aria-label="搜索连接" placeholder="搜索连接名称、主机或分组…" /><button>全部环境</button><button>全部状态</button></section>
      <section class="hub-table">
        <header><span>连接</span><span>目标地址</span><span>状态</span><span>打开方式</span></header>
        ${connections.map((connection) => `<article class="hub-row"><div><span class="resource-type">${connection.glyph}</span><span><strong>${connection.title}</strong><small>${connection.type === "ssh" ? "SSH 终端与 SFTP" : "MySQL / MariaDB 工作台"}</small></span></div><code>${connection.detail}</code><span class="hub-status">${statusDot(connection)}${connection.statusText}</span>${connectionAction(connection)}</article>`).join("")}
      </section>
    </main>`;
}

function renderEmbeddedWorkbench(hub, connection) {
  return `
    <main class="chrome-main chrome-workbench">
      <div class="embedded-bar"><button data-action="back-to-hub" data-id="${hub.id}">返回${hub.title}</button><span>当前标签页打开</span><strong>${connection.title}</strong></div>
      ${connection.type === "ssh" ? renderSshWorkbench(connection) : renderDatabaseWorkbench(connection)}
    </main>`;
}

function renderChromeMain() {
  const workspace = activeWorkspace();
  if (workspace.id === "overview") return renderChromeOverview();
  if (workspace.id === "ssh-hub" || workspace.id === "database-hub") {
    const currentId = state.currentConnectionByHub[workspace.id];
    const connection = state.candidates.find((candidate) => candidate.id === currentId);
    if (connection) return renderEmbeddedWorkbench(workspace, connection);
    return renderConnectionHub(workspace.id === "ssh-hub" ? "ssh" : "database");
  }
  if (workspace.type === "ssh" || workspace.type === "database") {
    return `<main class="chrome-main chrome-workbench">${workspace.type === "ssh" ? renderSshWorkbench(workspace) : renderDatabaseWorkbench(workspace)}</main>`;
  }
  return `<main class="chrome-main">${renderGenericPage(workspace)}</main>`;
}

function renderMain() {
  if (concept === "chrome") return renderChromeMain();
  const workspace = activeWorkspace();
  let content = renderGenericPage(workspace);
  if (workspace.type === "ssh") content = renderSshWorkbench();
  if (workspace.type === "database") content = renderDatabaseWorkbench();
  return `<main class="workspace-stage">${renderStageToolbar(workspace)}${content}</main>`;
}

function renderAllPanel() {
  if (!state.allOpen) return "";
  return `<aside class="floating-panel" aria-label="全部工作区"><header class="floating-panel__head"><strong>全部工作区</strong><span>${state.workspaces.length} OPEN</span></header>${state.workspaces.map((workspace) => `<button class="all-workspace-row" data-action="activate" data-id="${workspace.id}"><span class="type-glyph">${workspace.glyph}</span><span><strong>${workspace.title}</strong><small>${workspace.detail}</small></span><span>${workspace.statusText}</span></button>`).join("")}</aside>`;
}

function renderPicker() {
  if (!state.pickerOpen) return "";
  const query = state.query.trim().toLowerCase();
  const choices = [...state.workspaces.filter((workspace) => ["ssh", "database"].includes(workspace.type)), ...state.candidates].filter((workspace) => `${workspace.title} ${workspace.detail}`.toLowerCase().includes(query));
  return `
    <div class="overlay" data-action="dismiss">
      <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="picker-title" data-dialog>
        <header class="dialog__head"><div><small>NEW WORKSPACE</small><h2 id="picker-title">打开连接工作区</h2></div><button class="icon-button" data-action="picker-close" aria-label="关闭">×</button></header>
        <input class="workspace-search" name="workspace-search" value="${escapeHtml(state.query)}" placeholder="搜索名称、主机或数据库…" aria-label="搜索工作区" autofocus />
        <div class="picker-section"><span>SSH 与数据库连接</span>${choices.map((workspace) => `<button class="picker-row" data-action="open-candidate" data-id="${workspace.id}"><span class="type-glyph">${workspace.glyph}</span><span><strong>${workspace.title}</strong><small>${workspace.detail} · ${workspace.statusText}</small></span><span>${state.workspaces.some((item) => item.id === workspace.id) ? "切换" : "打开"}</span></button>`).join("") || '<p class="confirm-body">没有匹配的连接。</p>'}</div>
      </section>
    </div>`;
}

function renderCloseDialog() {
  if (!state.closeTarget) return "";
  const workspace = state.workspaces.find((item) => item.id === state.closeTarget);
  if (!workspace) return "";
  const detail = workspace.type === "ssh"
    ? `将关闭该工作区中的 <strong>${workspace.shells ?? 1} 个 Shell</strong>、WebSocket 和终端资源，其他 SSH 标签不受影响。`
    : workspace.type === "database"
      ? `将先取消 <strong>${workspace.runningQueries ?? 0} 个运行中查询</strong>，再丢弃未保存 SQL；取消失败时工作区保持打开。`
      : "关闭后可从应用启动器重新打开该页面。";
  return `
    <div class="overlay" data-action="dismiss-close">
      <section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="close-title" data-dialog>
        <header class="dialog__head"><div><small>CLOSE WORKSPACE</small><h2 id="close-title">关闭“${workspace.title}”？</h2></div></header>
        <div class="confirm-body"><p>${detail}</p></div>
        <footer class="dialog__actions"><button class="quiet-button" data-action="close-cancel">保留工作区</button><button class="danger-button" data-action="close-confirm">确认关闭</button></footer>
      </section>
    </div>`;
}

function render() {
  document.body.classList.toggle("is-dark", state.dark);
  document.body.classList.toggle("is-immersive", state.immersive);
  root.innerHTML = `<div class="app-prototype">${renderHeader()}${renderMain()}${renderAllPanel()}${renderPicker()}${renderCloseDialog()}${state.toast ? `<div class="toast" role="status">${state.toast}</div>` : ""}</div>`;
  if (state.pickerOpen) root.querySelector(".workspace-search")?.focus();
  if (concept === "chrome") {
    const strip = root.querySelector(".chrome-tab-strip");
    const active = root.querySelector('.chrome-tab[aria-selected="true"]');
    if (strip && active) {
      const stripRect = strip.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      if (activeRect.left < stripRect.left) strip.scrollLeft -= stripRect.left - activeRect.left;
      if (activeRect.right > stripRect.right) strip.scrollLeft += activeRect.right - stripRect.right;
    }
  }
}

function activate(id) {
  if (!state.workspaces.some((workspace) => workspace.id === id)) return;
  state.activeId = id;
  state.allOpen = false;
  state.openMenuFor = null;
  render();
}

function requestClose(id) {
  const workspace = state.workspaces.find((item) => item.id === id);
  if (!workspace?.closable) return;
  if (["ssh", "database"].includes(workspace.type)) {
    state.closeTarget = id;
    render();
    return;
  }
  closeWorkspace(id);
}

function closeWorkspace(id) {
  const index = state.workspaces.findIndex((workspace) => workspace.id === id);
  if (index < 0) return;
  const [closed] = state.workspaces.splice(index, 1);
  if (state.activeId === id) state.activeId = state.workspaces[Math.max(0, index - 1)]?.id ?? "overview";
  state.closeTarget = null;
  showToast(`已关闭 ${closed.title}`);
}

function showToast(message) {
  state.toast = message;
  render();
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { state.toast = ""; render(); }, 2200);
}

function openCandidate(id) {
  const existing = state.workspaces.find((workspace) => workspace.id === id);
  if (existing) {
    state.pickerOpen = false;
    activate(id);
    return;
  }
  const candidate = state.candidates.find((workspace) => workspace.id === id);
  if (!candidate) return;
  state.workspaces.push({ ...candidate });
  state.pickerOpen = false;
  state.query = "";
  state.activeId = candidate.id;
  showToast(`已打开 ${candidate.title}`);
}

function openConnectionInCurrentTab(id) {
  const connection = state.candidates.find((candidate) => candidate.id === id);
  if (!connection) return;
  const hubId = connection.type === "ssh" ? "ssh-hub" : "database-hub";
  state.currentConnectionByHub[hubId] = connection.id;
  state.activeId = hubId;
  state.openMenuFor = null;
  showToast(`已在当前${connection.type === "ssh" ? " SSH" : "数据库"}标签页打开 ${connection.title}`);
}

function openConnectionInNewTab(id) {
  const connection = state.candidates.find((candidate) => candidate.id === id);
  if (!connection) return;
  const existing = state.workspaces.find((workspace) => workspace.id === connection.id);
  if (existing) {
    state.openMenuFor = null;
    state.activeId = existing.id;
    showToast(`已切换到已有标签 ${existing.title}`);
    return;
  }
  state.workspaces.push({ ...connection, fixed: false, closable: true });
  state.activeId = connection.id;
  state.openMenuFor = null;
  showToast(`已在新标签页打开 ${connection.title}`);
}

root.addEventListener("click", (event) => {
  const target = event.target.closest("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  if (action === "activate") activate(id);
  if (action === "close") { event.stopPropagation(); requestClose(id); }
  if (action === "all") { state.allOpen = !state.allOpen; state.pickerOpen = false; render(); }
  if (action === "picker") { state.pickerOpen = true; state.allOpen = false; render(); }
  if (action === "picker-close") { state.pickerOpen = false; state.query = ""; render(); }
  if (action === "open-candidate") openCandidate(id);
  if (action === "toggle-open-menu") { state.openMenuFor = state.openMenuFor === id ? null : id; render(); }
  if (action === "open-current") openConnectionInCurrentTab(id);
  if (action === "open-new-tab") openConnectionInNewTab(id);
  if (action === "back-to-hub") { delete state.currentConnectionByHub[id]; state.openMenuFor = null; render(); }
  if (action === "theme") { state.dark = !state.dark; render(); }
  if (action === "settings") showToast("平台设置将从 header 尾部进入，不再占用菜单标签");
  if (action === "immersive") { state.immersive = true; showToast("已进入沉浸模式，按 Esc 退出"); }
  if (action === "launcher") showToast("应用启动器：环境、资源池、审计与设置");
  if (action === "close-cancel") { state.closeTarget = null; render(); }
  if (action === "close-confirm") closeWorkspace(state.closeTarget);
  if (action === "dismiss" && target === event.target) { state.pickerOpen = false; state.query = ""; render(); }
  if (action === "dismiss-close" && target === event.target) { state.closeTarget = null; render(); }
});

root.addEventListener("submit", (event) => {
  if (event.target.dataset.action !== "terminal-form") return;
  event.preventDefault();
  const data = new FormData(event.target);
  const command = String(data.get("command") ?? "").trim();
  if (!command) return;
  state.terminalLines.push(command);
  showToast("演示命令已执行，SSH 工作区保持在线");
});

root.addEventListener("input", (event) => {
  if (event.target.name !== "workspace-search") return;
  state.query = event.target.value;
  render();
});

root.addEventListener("keydown", (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab) return;
  const index = state.workspaces.findIndex((workspace) => workspace.id === tab.dataset.id);
  if (event.key === "ArrowRight") { event.preventDefault(); activate(state.workspaces[(index + 1) % state.workspaces.length].id); }
  if (event.key === "ArrowLeft") { event.preventDefault(); activate(state.workspaces[(index - 1 + state.workspaces.length) % state.workspaces.length].id); }
  if (event.key === "Delete") { event.preventDefault(); requestClose(tab.dataset.id); }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (state.pickerOpen || state.closeTarget || state.allOpen || state.openMenuFor || state.immersive) {
    state.pickerOpen = false;
    state.closeTarget = null;
    state.allOpen = false;
    state.openMenuFor = null;
    state.immersive = false;
    state.query = "";
    render();
  }
});

render();
