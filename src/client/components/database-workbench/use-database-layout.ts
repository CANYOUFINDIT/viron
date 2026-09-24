import { computed, onScopeDispose, ref } from "vue";
import { WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD, WORKBENCH_SIDEBAR_RESTORE_WIDTH } from "../../workbench-sidebar-width";
import type { DatabaseWorkbenchProps } from "./types";

export function useDatabaseLayout(props: Readonly<DatabaseWorkbenchProps>) {
  const connectionPaneWidth = ref(240);
  const connectionPaneVisible = ref(true);
  const explorerPaneWidth = ref(280);
  const informationPaneVisible = ref(false);
  const informationPaneTab = ref<"general" | "ddl">("general");
  const queryResultLayout = ref<"below" | "right">("below");
  const queryFocused = ref(false);
  const workbenchElement = ref<HTMLElement | null>(null);
  let stopConnectionPaneResize: (() => void) | null = null;
  const persistenceKey = computed(() => `envman:database-workbench:${props.workspaceKey}:${props.environmentId ?? "global"}`);
  const workbenchStyle = computed(() => ({
    "--connection-pane-width": `${connectionPaneWidth.value}px`,
    "--information-pane-width": `${explorerPaneWidth.value}px`,
  }));

  function persistWorkbenchPreferences() {
    localStorage.setItem(persistenceKey.value, JSON.stringify({
      connectionPaneWidth: connectionPaneWidth.value,
      explorerPaneWidth: explorerPaneWidth.value,
      informationPaneVisible: informationPaneVisible.value,
      queryResultLayout: queryResultLayout.value,
    }));
  }

  function restoreWorkbenchPreferences() {
    try {
      const value = JSON.parse(localStorage.getItem(persistenceKey.value) ?? "{}") as {
        connectionPaneWidth?: number;
        explorerPaneWidth?: number;
        informationPaneVisible?: boolean;
        queryResultLayout?: "below" | "right";
      };
      if (value.connectionPaneWidth) connectionPaneWidth.value = Math.max(WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD + 1, Math.min(520, value.connectionPaneWidth));
      if (value.explorerPaneWidth) explorerPaneWidth.value = Math.max(220, Math.min(420, value.explorerPaneWidth));
      if (typeof value.informationPaneVisible === "boolean") informationPaneVisible.value = value.informationPaneVisible;
      if (value.queryResultLayout === "below" || value.queryResultLayout === "right") queryResultLayout.value = value.queryResultLayout;
    } catch {
      // Ignore invalid local preferences and use the defaults.
    }
  }

  function clampConnectionPaneWidth(value: number) {
    const maxWidth = Math.min(520, (workbenchElement.value?.getBoundingClientRect().width ?? 1040) * .5);
    return Math.round(Math.max(WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD + 1, Math.min(maxWidth, value)));
  }

  function setConnectionPaneWidth(value: number) {
    connectionPaneWidth.value = clampConnectionPaneWidth(value);
  }

  function startConnectionPaneResize(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const workbench = workbenchElement.value;
    const bounds = workbench?.getBoundingClientRect();
    if (!workbench || !bounds) return;
    stopConnectionPaneResize?.();

    const pointerId = event.pointerId;
    const maxWidth = Math.min(520, bounds.width * .5);
    const restoreWidth = Math.max(WORKBENCH_SIDEBAR_RESTORE_WIDTH, connectionPaneWidth.value);
    const widthAt = (clientX: number) => Math.round(Math.max(WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD + 1, Math.min(maxWidth, clientX - bounds.left)));
    let nextWidth = connectionPaneWidth.value;
    let frame = 0;
    const resizeGrid = () => {
      frame = 0;
      // Resize the real grid once per frame without rerendering the workbench's large Vue tree.
      workbench.style.setProperty("--connection-pane-width", `${nextWidth}px`);
    };
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      if (moveEvent.clientX - bounds.left <= WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD) {
        collapse();
        return;
      }
      nextWidth = widthAt(moveEvent.clientX);
      if (!frame) frame = requestAnimationFrame(resizeGrid);
    };
    const cleanup = () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", cancel);
      window.removeEventListener("blur", cancel);
      stopConnectionPaneResize = null;
    };
    const collapse = () => {
      cleanup();
      workbench.style.setProperty("--connection-pane-width", `${restoreWidth}px`);
      connectionPaneWidth.value = restoreWidth;
      setConnectionPaneVisible(false);
    };
    const finish = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      if (upEvent.clientX - bounds.left <= WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD) {
        collapse();
        return;
      }
      const width = widthAt(upEvent.clientX);
      cleanup();
      workbench.style.setProperty("--connection-pane-width", `${width}px`);
      setConnectionPaneWidth(width);
      persistWorkbenchPreferences();
    };
    const cancel = () => {
      cleanup();
      workbench.style.setProperty("--connection-pane-width", `${connectionPaneWidth.value}px`);
    };
    stopConnectionPaneResize = cancel;
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", cancel, { once: true });
    window.addEventListener("blur", cancel, { once: true });
  }

  onScopeDispose(() => stopConnectionPaneResize?.());

  function resizeConnectionPane(delta: number) {
    const width = connectionPaneWidth.value + delta;
    if (width <= WORKBENCH_SIDEBAR_COLLAPSE_THRESHOLD) {
      connectionPaneWidth.value = Math.max(WORKBENCH_SIDEBAR_RESTORE_WIDTH, connectionPaneWidth.value);
      setConnectionPaneVisible(false);
      return;
    }
    setConnectionPaneWidth(width);
    persistWorkbenchPreferences();
  }

  function setExplorerPaneWidth(value: number) {
    const workbenchWidth = workbenchElement.value?.getBoundingClientRect().width ?? 1200;
    const connectionWidth = connectionPaneVisible.value ? connectionPaneWidth.value : 0;
    const maxWidth = Math.min(420, workbenchWidth - connectionWidth - 420);
    explorerPaneWidth.value = Math.round(Math.max(220, Math.min(Math.max(220, maxWidth), value)));
  }

  function startExplorerPaneResize(event: PointerEvent) {
    event.preventDefault();
    const bounds = workbenchElement.value?.getBoundingClientRect();
    if (!bounds) return;
    const move = (moveEvent: PointerEvent) => setExplorerPaneWidth(bounds.right - moveEvent.clientX);
    const finish = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      persistWorkbenchPreferences();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish, { once: true });
  }

  function resizeExplorerPane(delta: number) {
    setExplorerPaneWidth(explorerPaneWidth.value + delta);
    persistWorkbenchPreferences();
  }

  function setConnectionPaneVisible(value: boolean) {
    connectionPaneVisible.value = value;
    setExplorerPaneWidth(explorerPaneWidth.value);
    persistWorkbenchPreferences();
  }

  function setInformationPaneVisible(value: boolean) {
    informationPaneVisible.value = value;
    setExplorerPaneWidth(explorerPaneWidth.value);
    persistWorkbenchPreferences();
  }

  function setQueryResultLayout(value: "below" | "right") {
    queryResultLayout.value = value;
    persistWorkbenchPreferences();
  }

  return {
    connectionPaneWidth,
    connectionPaneVisible,
    explorerPaneWidth,
    informationPaneVisible,
    informationPaneTab,
    queryResultLayout,
    queryFocused,
    workbenchElement,
    persistenceKey,
    workbenchStyle,
    persistWorkbenchPreferences,
    restoreWorkbenchPreferences,
    setConnectionPaneWidth,
    startConnectionPaneResize,
    resizeConnectionPane,
    setExplorerPaneWidth,
    startExplorerPaneResize,
    resizeExplorerPane,
    setConnectionPaneVisible,
    setInformationPaneVisible,
    setQueryResultLayout,
  };
}

export type DatabaseLayoutApi = ReturnType<typeof useDatabaseLayout>;
