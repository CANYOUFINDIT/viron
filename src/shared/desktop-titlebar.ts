import type { ThemeName } from "./theme.js";

export const DESKTOP_TITLE_BAR_HEIGHT = 36;
export const desktopTitleBarAppearances = ["light", "dark", "bright", "login"] as const;

export type DesktopTitleBarAppearance = ThemeName | "login";

export interface DesktopTitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

export function isDesktopTitleBarAppearance(value: unknown): value is DesktopTitleBarAppearance {
  return desktopTitleBarAppearances.includes(value as DesktopTitleBarAppearance);
}

export function desktopTitleBarOverlay(appearance: DesktopTitleBarAppearance): DesktopTitleBarOverlay {
  if (appearance === "login") return { color: "#00000000", symbolColor: "#b8c9c5", height: DESKTOP_TITLE_BAR_HEIGHT };
  if (appearance === "dark") return { color: "#00000000", symbolColor: "#b8c9c5", height: DESKTOP_TITLE_BAR_HEIGHT };
  return { color: "#00000000", symbolColor: "#52656b", height: DESKTOP_TITLE_BAR_HEIGHT };
}
