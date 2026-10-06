import { createApp, h, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElPopover } from "element-plus";
import "element-plus/dist/index.css";
import "./styles/base.css";
import { installBrowserPointerBridge } from "./native-dom-overlays";
import { installBrowserGuestHost, registerBrowserSurface, updateBrowserGuestLayout } from "./browser-guest-host";

installBrowserGuestHost();
installBrowserPointerBridge();

declare global {
  interface Window {
    vironDomOverlaySmoke?: {
      clicks: string[];
      close: () => void;
      hideElementPopover: () => void;
      setSidebarExpanded: (expanded: boolean) => void;
      setSidebarPinned: (pinned: boolean) => void;
      sidebar: () => HTMLElement | null;
      enableNativeHover: () => void;
      setVisible: (visible: boolean) => void;
      setModal: (visible: boolean) => void;
    };
  }
}

createApp({
  setup() {
    const clicks = reactive<string[]>([]);
    const elementPopoverOpen = ref(true);
    const sidebarExpanded = ref(false);
    const sidebarPinned = ref(false);
    const modal = ref(false);
    const pageVisible = ref(true);
    const sidebar = ref<HTMLElement | null>(null);
    let nativeHoverEnabled = false;
    let unregister: (() => void) | null = null;
    onMounted(() => {
      unregister = registerBrowserSurface("smoke-view", () => document.querySelector<HTMLElement>("#surface"), () => pageVisible.value);
      window.setTimeout(() => { sidebarExpanded.value = true; }, 30);
      window.addEventListener("viron:native-web-pointer-down", hideElementPopover);
      window.addEventListener("viron:native-sidebar-pointerenter", enterSidebar);
      window.addEventListener("viron:native-sidebar-pointerleave", leaveSidebar);
      window.vironDomOverlaySmoke = {
        clicks,
        setVisible: (visible) => { pageVisible.value = visible; updateBrowserGuestLayout(); },
        setModal: (visible) => { modal.value = visible; },
        close: () => unregister?.(),
        hideElementPopover,
        setSidebarExpanded: (expanded) => { sidebarExpanded.value = expanded; },
        setSidebarPinned: (pinned) => { sidebarPinned.value = pinned; },
        sidebar: () => sidebar.value,
        enableNativeHover: () => { nativeHoverEnabled = true; },
      };
    });
    function hideElementPopover() { elementPopoverOpen.value = false; }
    function enterSidebar() { if (nativeHoverEnabled && !sidebarPinned.value) sidebarExpanded.value = true; }
    function leaveSidebar() { if (nativeHoverEnabled && !sidebarPinned.value) sidebarExpanded.value = false; }
    onBeforeUnmount(() => {
      unregister?.();
      window.removeEventListener("viron:native-web-pointer-down", hideElementPopover);
      window.removeEventListener("viron:native-sidebar-pointerenter", enterSidebar);
      window.removeEventListener("viron:native-sidebar-pointerleave", leaveSidebar);
    });
    return () => [
      h("div", { class: ["app-frame", "is-desktop", { "is-sidebar-expanded": sidebarExpanded.value, "is-sidebar-pinned": sidebarPinned.value }] }, [
        h("aside", { class: "app-sidebar", ref: sidebar }, [
          h("div", { class: "app-sidebar__panel" }, [
            h("button", { id: "sidebar-action", onClick: () => clicks.push("sidebar") }, `Sidebar ${clicks.length}`),
          ]),
        ]),
        h("div", { id: "surface" }),
        h(ElPopover, {
          visible: elementPopoverOpen.value,
          "onUpdate:visible": (value: boolean) => { elementPopoverOpen.value = value; },
          teleported: true,
          placement: "bottom-start",
          width: 180,
          popperClass: "smoke-element-popper",
        }, {
          reference: () => h("button", { id: "element-popover-anchor", style: "position:fixed;left:340px;top:135px" }, "Element anchor"),
          default: () => h("button", { id: "element-popover-action", onClick: () => clicks.push("element") }, `Element ${clicks.length}`),
        }),
      ]),
      modal.value ? h("div", { class: "el-overlay", style: "position:fixed;inset:0;z-index:4000;background:rgba(0,0,0,.2)" }, [h("button", { id: "modal-action", style: "position:absolute;left:200px;top:220px", onClick: () => clicks.push("modal") }, "Modal action")]) : null,
      h("div", { class: "el-popper" }, [
        h("button", { id: "popover-action", onClick: () => clicks.push("popover") }, `Popover ${clicks.length}`),
      ]),
      h("input", { id: "host-input", style: "position:fixed;left:380px;top:300px;width:110px;height:24px;z-index:120" }),
    ];
  },
}).mount("#app");
