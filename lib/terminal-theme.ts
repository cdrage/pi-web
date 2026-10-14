import type { ITheme } from "@xterm/xterm";

/** The terminal's own palette, apart from the app theme. */
export type TerminalTheme = "dark" | "light" | "zenburn";

export const TERMINAL_THEME_STORAGE_KEY = "pi-web:terminal-theme";
export const TERMINAL_THEME_DEFAULT: TerminalTheme = "dark";

export function parseTerminalTheme(raw: string | null): TerminalTheme {
  return raw === "light" || raw === "zenburn" ? raw : TERMINAL_THEME_DEFAULT;
}

// Keep the backgrounds in step with --terminal-bg in app/globals.css.
export const TERMINAL_XTERM_THEMES: Record<TerminalTheme, ITheme> = {
  dark: {
    background: "#111318", foreground: "#d7dce5", cursor: "#60a5fa",
    overviewRulerBorder: "#111318",
    selectionBackground: "#365b8a",
    black: "#1d222b", red: "#f87171", green: "#4ade80", yellow: "#facc15",
    blue: "#60a5fa", magenta: "#c084fc", cyan: "#22d3ee", white: "#e5e7eb",
    brightBlack: "#6b7280", brightRed: "#fca5a5", brightGreen: "#86efac",
    brightYellow: "#fde047", brightBlue: "#93c5fd", brightMagenta: "#d8b4fe",
    brightCyan: "#67e8f9", brightWhite: "#ffffff",
  },
  // ANSI white and bright white stay grey so text meant for a dark screen remains readable.
  light: {
    background: "#fbfbfc", foreground: "#24292f", cursor: "#2563eb",
    overviewRulerBorder: "#fbfbfc",
    cursorAccent: "#fbfbfc", selectionBackground: "#bfd7fb",
    black: "#24292f", red: "#cf222e", green: "#116329", yellow: "#7d4e00",
    blue: "#0969da", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37",
    brightYellow: "#633c01", brightBlue: "#218bff", brightMagenta: "#a475f9",
    brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
  zenburn: {
    background: "#3f3f3f", foreground: "#dcdccc", cursor: "#8faf9f",
    overviewRulerBorder: "#3f3f3f",
    cursorAccent: "#000d18", selectionBackground: "#2f2f2f",
    selectionForeground: "#dcdccc", selectionInactiveBackground: "#434443",
    black: "#4d4d4d", red: "#7d5d5d", green: "#60b48a", yellow: "#f0dfaf",
    blue: "#5d6d7d", magenta: "#dc8cc3", cyan: "#8cd0d3", white: "#dcdccc",
    brightBlack: "#709080", brightRed: "#dca3a3", brightGreen: "#c3bf9f",
    brightYellow: "#e0cf9f", brightBlue: "#94bff3", brightMagenta: "#ec93d3",
    brightCyan: "#93e0e3", brightWhite: "#ffffff",
  },
};
