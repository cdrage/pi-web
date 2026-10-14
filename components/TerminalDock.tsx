"use client";

import { useCallback, useEffect, useRef, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { setTerminalTheme, useTerminalTheme } from "@/hooks/useTerminalTheme";
import { getFileName } from "@/lib/file-paths";
import { TabBar, type Tab } from "./TabBar";
import { TerminalPanel } from "./TerminalPanel";
import type { TerminalTab } from "./terminal-tab-state";
import "./TerminalDock.css";

interface Props {
  tabs: TerminalTab[];
  activeId: string | null;
  open: boolean;
  onSelect: (id: string) => void;
  onHide: () => void;
  onClose: (id: string) => void;
  onRestart: (id: string) => void;
  onClosed: (tab: TerminalTab) => void;
  onCloseError: (id: string) => void;
}

const DEFAULT_HEIGHT = 300;
const MIN_HEIGHT = 180;
const MAX_HEIGHT = 1200;
const CHAT_RESERVE = 140;
const HEIGHT_KEY = "pi-terminal-height";
const NEXT_THEME = { dark: "light", light: "zenburn", zenburn: "dark" } as const;
const THEME_LABELS = {
  dark: "terminal.darkTheme",
  light: "terminal.lightTheme",
  zenburn: "terminal.zenburnTheme",
} as const;

export function TerminalDock({ tabs, activeId, open, onSelect, onHide, onClose, onRestart, onClosed, onCloseError }: Props) {
  const { t } = useI18n();
  const theme = useTerminalTheme();
  const nextTheme = NEXT_THEME[theme];
  const themeLabel = t(THEME_LABELS[nextTheme]);
  const heightRef = useRef(DEFAULT_HEIGHT);
  const parentRef = useRef<HTMLElement | null>(null);
  const getMaxHeight = useCallback(() => {
    return (parentRef.current?.clientHeight ?? window.innerHeight) - CHAT_RESERVE;
  }, []);
  const resizer = useResizablePanel({
    ariaLabel: t("layout.resizeTerminal"),
    axis: "vertical",
    cssVariable: "--terminal-height",
    defaultWidth: DEFAULT_HEIGHT,
    getMaxWidth: getMaxHeight,
    growthDirection: "up",
    minWidth: MIN_HEIGHT,
    maxWidth: MAX_HEIGHT,
    persistClamp: false,
    storageKey: HEIGHT_KEY,
    widthRef: heightRef,
  });
  const { panelRef, reclampWidth } = resizer;
  const hasTabs = tabs.length > 0;

  useEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) {
      return;
    }

    // Fit the dock after viewport changes without replacing its saved height.
    const observer = new ResizeObserver(reclampWidth);
    observer.observe(parent);
    reclampWidth();
    return () => observer.disconnect();
  }, [hasTabs, panelRef, reclampWidth]);

  if (!hasTabs) {
    return null;
  }

  const panelTabs: Tab[] = tabs.map((tab) => ({
    id: tab.id,
    label: getFileName(tab.cwd) || tab.cwd,
    filePath: tab.cwd,
    kind: "terminal",
    closing: Boolean(tab.closing),
  }));
  const activeTab = tabs.find((tab) => tab.id === activeId);

  return (
    <div
      ref={(element) => {
        panelRef.current = element;
        parentRef.current = element?.parentElement ?? null;
      }}
      id="terminal-dock"
      role="region"
      aria-label={t("terminal.title")}
      hidden={!open}
      className="terminal-dock"
      style={{ "--terminal-height": `${resizer.width}px`, "--terminal-chat-reserve": `${CHAT_RESERVE}px` } as CSSProperties}
    >
      <div
        {...resizer.separatorProps}
        aria-controls="terminal-dock"
        className={`terminal-dock-resize${resizer.isResizing ? " is-resizing" : ""}`}
        title={`${t("layout.resizeTerminal")}: ${t("layout.resizeHint")}`}
      />
      <div className="terminal-dock-tabs">
        <TabBar tabs={panelTabs} activeTabId={activeId ?? ""} onSelectTab={onSelect} onCloseTab={onClose} />
        <button
          type="button"
          className="terminal-dock-action"
          onClick={() => setTerminalTheme(nextTheme)}
          aria-label={themeLabel}
          title={themeLabel}
        >
          {nextTheme === "zenburn" ? <span aria-hidden="true">Z</span> : nextTheme === "light" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="terminal-dock-action"
          onClick={() => { if (activeTab) { onRestart(activeTab.id); } }}
          disabled={!activeTab || Boolean(activeTab.closing)}
          aria-label={t("terminal.restart")}
          title={t("terminal.restart")}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.34 5.66" /><polyline points="20 4 20 11 13 11" />
          </svg>
        </button>
        <button type="button" className="terminal-dock-hide" onClick={onHide} aria-label={t("terminal.hidePanel")} title={t("terminal.hidePanel")}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </div>
      <div className="terminal-dock-content">
        {tabs.map((tab) => (
          <div key={tab.id} hidden={tab.id !== activeId} className="terminal-dock-pane">
            <TerminalPanel
              tab={tab}
              active={open && tab.id === activeId}
              onClosed={() => onClosed(tab)}
              onCloseError={() => onCloseError(tab.id)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
