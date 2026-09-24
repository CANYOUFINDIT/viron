import { createApp, h, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { ElPopover } from "element-plus";
import { registerNativeWebSurface } from "./native-dom-overlays";

declare global {
  interface Window {
    vironDomOverlaySmoke?: { clicks: string[]; close: () => void; hideElementPopover: () => void };
  }
}

createApp({
  setup() {
    const clicks = reactive<string[]>([]);
    const elementPopoverOpen = ref(true);
    let unregister: (() => void) | null = null;
    onMounted(() => {
      unregister = registerNativeWebSurface(() => document.querySelector<HTMLElement>("#surface"), () => true);
      window.addEventListener("viron:native-web-pointer-down", hideElementPopover);
      window.vironDomOverlaySmoke = {
        clicks,
        close: () => unregister?.(),
        hideElementPopover,
      };
    });
    function hideElementPopover() { elementPopoverOpen.value = false; }
    onBeforeUnmount(() => {
      unregister?.();
      window.removeEventListener("viron:native-web-pointer-down", hideElementPopover);
    });
    return () => [
      h("div", { class: "app-frame is-sidebar-expanded" }, [
        h("aside", { class: "app-sidebar" }, [
          h("button", { id: "sidebar-action", onClick: () => clicks.push("sidebar") }, `Sidebar ${clicks.length}`),
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
      h("div", { class: "el-popper" }, [
        h("button", { id: "popover-action", onClick: () => clicks.push("popover") }, `Popover ${clicks.length}`),
      ]),
    ];
  },
}).mount("#app");
