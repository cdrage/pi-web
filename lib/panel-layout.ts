export const MOBILE_MAX_WIDTH = 640;
export const SPLIT_PANEL_MIN_WIDTH = 960;

export const SIDEBAR_DEFAULT_WIDTH = 260;
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;

export const RIGHT_PANEL_FALLBACK_WIDTH = 560;
export const RIGHT_PANEL_MIN_WIDTH = 300;
export const RIGHT_PANEL_MAX_WIDTH = 1200;
export const PREVIEW_PANEL_MIN_WIDTH = 300;
export const PREVIEW_PANEL_DEFAULT_WIDTH = 1000;
export const PREVIEW_PANEL_MAX_WIDTH = 1200;

const COMPACT_CHAT_MIN_WIDTH = 320;
const DESKTOP_CHAT_MIN_WIDTH = 420;

// Keep these thresholds in step with the overlay rules in Preview.css.
export const PREVIEW_SPLIT_MIN_WIDTH = PREVIEW_PANEL_MIN_WIDTH + SIDEBAR_DEFAULT_WIDTH + DESKTOP_CHAT_MIN_WIDTH;
export const THREE_PANE_MIN_WIDTH = PREVIEW_PANEL_MIN_WIDTH + SIDEBAR_DEFAULT_WIDTH + RIGHT_PANEL_MIN_WIDTH + COMPACT_CHAT_MIN_WIDTH;

function previewFits(viewportWidth: number, rightPanelOpen: boolean): boolean {
  return viewportWidth >= (rightPanelOpen ? THREE_PANE_MIN_WIDTH : PREVIEW_SPLIT_MIN_WIDTH);
}

export function clampPanelWidth(width: number, minWidth: number, maxWidth: number): number {
  const finiteWidth = Number.isFinite(width) ? width : minWidth;
  const effectiveMax = Math.max(minWidth, maxWidth);
  return Math.round(Math.max(minWidth, Math.min(effectiveMax, finiteWidth)));
}

export function getDefaultRightPanelWidth(viewportWidth: number): number {
  return clampPanelWidth(viewportWidth * 0.42, 360, 640);
}

export function getSidebarMaxWidth(options: {
  viewportWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
  previewOpen?: boolean;
  previewWidth?: number;
}): number {
  const { viewportWidth, rightPanelOpen, rightPanelWidth, previewOpen = false, previewWidth = 0 } = options;
  if (viewportWidth <= MOBILE_MAX_WIDTH) return SIDEBAR_MAX_WIDTH;

  const compact = viewportWidth < SPLIT_PANEL_MIN_WIDTH;
  const visiblePreview = previewOpen && previewFits(viewportWidth, rightPanelOpen);
  const chatWidth = compact || visiblePreview && rightPanelOpen ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH;
  const visibleRightPanelWidth = !compact && rightPanelOpen ? rightPanelWidth : 0;
  const visiblePreviewWidth = visiblePreview ? previewWidth : 0;
  return Math.min(SIDEBAR_MAX_WIDTH, viewportWidth - chatWidth - visibleRightPanelWidth - visiblePreviewWidth);
}

export function getRightPanelMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  previewOpen?: boolean;
  previewWidth?: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth, previewOpen = false, previewWidth = 0 } = options;
  if (viewportWidth < SPLIT_PANEL_MIN_WIDTH) return RIGHT_PANEL_MAX_WIDTH;

  const visibleSidebarWidth = sidebarOpen ? sidebarWidth : 0;
  const visiblePreview = previewOpen && previewFits(viewportWidth, true);
  return Math.min(
    RIGHT_PANEL_MAX_WIDTH,
    viewportWidth - (visiblePreview ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH)
      - visibleSidebarWidth - (visiblePreview ? previewWidth : 0),
  );
}

export function getPreviewMaxWidth(options: {
  viewportWidth: number;
  sidebarOpen: boolean;
  sidebarWidth: number;
  rightPanelOpen: boolean;
  rightPanelWidth: number;
}): number {
  const { viewportWidth, sidebarOpen, sidebarWidth, rightPanelOpen, rightPanelWidth } = options;
  if (!previewFits(viewportWidth, rightPanelOpen)) {
    return Math.min(PREVIEW_PANEL_MAX_WIDTH, viewportWidth);
  }
  return Math.min(PREVIEW_PANEL_MAX_WIDTH, viewportWidth
    - (rightPanelOpen ? COMPACT_CHAT_MIN_WIDTH : DESKTOP_CHAT_MIN_WIDTH)
    - (sidebarOpen ? sidebarWidth : 0) - (rightPanelOpen ? rightPanelWidth : 0));
}
