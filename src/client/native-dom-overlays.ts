import { onDesktopNativeViewPointerDown } from "./desktop";

let installed = false;
export function installBrowserPointerBridge(): void {
  if (installed || !window.vironDesktop) return;
  installed = true;
  onDesktopNativeViewPointerDown(() => {
    window.dispatchEvent(new Event("viron:native-web-pointer-down"));
    document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    // Element Plus document listeners need an outside event for guest clicks.
    document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

// Kept for shell consumers while all app chrome now remains in this document.
export function nativeSidebarPortalActive(): boolean { return false; }
export function nativeSidebarTransferInProgress(): boolean { return false; }
