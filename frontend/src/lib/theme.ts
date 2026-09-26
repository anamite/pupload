import type { Theme } from "./api";
import { readLocal, writeLocal } from "./storage";

const KEY = "pupload.theme";
const BAR_COLOR = { light: "#f7f4ef", slate: "#171b22", ink: "#000000" } as const;

export const THEMES: { id: Theme; label: string; hint: string }[] = [
  { id: "system", label: "Auto", hint: "Follows the device" },
  { id: "light", label: "Paper", hint: "Warm light" },
  { id: "slate", label: "Slate", hint: "Soft dark" },
  { id: "ink", label: "Ink", hint: "True black, OLED" },
];

export function savedTheme(): Theme | null {
  const value = readLocal(KEY);
  return value === "system" || value === "light" || value === "slate" || value === "ink" ? value : null;
}

function resolve(theme: Theme): "light" | "slate" | "ink" {
  if (theme !== "system") return theme;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "slate" : "light";
}

export function applyTheme(theme: Theme, remember = true) {
  const actual = resolve(theme);
  document.documentElement.dataset.theme = actual;
  document.documentElement.dataset.themeChoice = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", BAR_COLOR[actual]);
  if (remember) writeLocal(KEY, theme);
}

export function currentThemeChoice(): Theme {
  return (document.documentElement.dataset.themeChoice as Theme) || "system";
}

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (currentThemeChoice() === "system") applyTheme("system", false);
});
