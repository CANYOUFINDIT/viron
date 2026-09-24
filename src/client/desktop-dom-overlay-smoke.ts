import { createApp, h, onBeforeUnmount, onMounted, reactive } from "vue";
import { registerNativeWebSurface } from "./native-dom-overlays";

declare global {
  interface Window {
    vironDomOverlaySmoke?: { clicks: string[]; close: () => void };
  }
}

createApp({
  setup() {
    const clicks = reactive<string[]>([]);
    let unregister: (() => void) | null = null;
    onMounted(() => {
      unregister = registerNativeWebSurface(() => document.querySelector<HTMLElement>("#surface"), () => true);
      window.vironDomOverlaySmoke = { clicks, close: () => unregister?.() };
    });
    onBeforeUnmount(() => unregister?.());
    return () => [
      h("div", { class: "app-frame is-sidebar-expanded" }, [
        h("aside", { class: "app-sidebar" }, [
          h("button", { id: "sidebar-action", onClick: () => clicks.push("sidebar") }, `Sidebar ${clicks.length}`),
        ]),
        h("div", { id: "surface" }),
      ]),
      h("div", { class: "el-popper" }, [
        h("button", { id: "popover-action", onClick: () => clicks.push("popover") }, `Popover ${clicks.length}`),
      ]),
    ];
  },
}).mount("#app");
