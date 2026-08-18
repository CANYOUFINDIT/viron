export const themeNames = ["light", "dark", "bright"] as const;

export type ThemeName = (typeof themeNames)[number];

export function normalizeTheme(value: string | null | undefined): ThemeName {
  return themeNames.includes(value as ThemeName) ? value as ThemeName : "light";
}
