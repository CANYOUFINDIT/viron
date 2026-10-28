export const DESKTOP_WEB_POPUP_TOOLBAR_HEIGHT = 46;

export interface DesktopWebPopupState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  secure: boolean;
}

export type DesktopWebPopupAction =
  | { type: "back" }
  | { type: "forward" }
  | { type: "reload" }
  | { type: "stop" }
  | { type: "navigate"; url: string }
  | { type: "close" };
