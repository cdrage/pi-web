import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  clampPanelWidth,
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  getPreviewMaxWidth,
  PREVIEW_PANEL_MIN_WIDTH,
  PREVIEW_PANEL_DEFAULT_WIDTH,
} = await jiti.import("./panel-layout.ts");

test("clamps panel widths to finite bounds", () => {
  assert.equal(clampPanelWidth(420.4, 180, 480), 420);
  assert.equal(clampPanelWidth(120, 180, 480), 180);
  assert.equal(clampPanelWidth(600, 180, 480), 480);
  assert.equal(clampPanelWidth(Number.NaN, 180, 480), 180);
  assert.equal(clampPanelWidth(200, 300, 250), 300);
});

test("keeps the responsive right panel default within useful limits", () => {
  assert.equal(getDefaultRightPanelWidth(700), 360);
  assert.equal(getDefaultRightPanelWidth(1366), 574);
  assert.equal(getDefaultRightPanelWidth(1920), 640);
});

test("reserves chat space while split panels are visible", () => {
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 700,
    rightPanelOpen: true,
    rightPanelWidth: 560,
  }), 380);
  assert.equal(getSidebarMaxWidth({
    viewportWidth: 1366,
    rightPanelOpen: true,
    rightPanelWidth: 686,
  }), 260);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1024,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 344);
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 1366,
    sidebarOpen: true,
    sidebarWidth: 260,
  }), 686);
});

test("does not rewrite desktop widths while the file panel is in overlay mode", () => {
  assert.equal(getRightPanelMaxWidth({
    viewportWidth: 900,
    sidebarOpen: true,
    sidebarWidth: 480,
  }), 1200);
});

test("reserves chat space beside the file and preview panes", () => {
  assert.equal(getRightPanelMaxWidth({ viewportWidth: 1920, sidebarOpen: true, sidebarWidth: 260,
    previewOpen: true, previewWidth: 1000 }), 340);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 1920, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: true, rightPanelWidth: 340 }), 1000);
  assert.equal(getSidebarMaxWidth({ viewportWidth: 1880, rightPanelOpen: true, rightPanelWidth: 300,
    previewOpen: true, previewWidth: 1000 }), 260);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 1680, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: false, rightPanelWidth: 560 }), 1000);
});

test("uses an overlay when both panes cannot fit beside chat", () => {
  assert.equal(getRightPanelMaxWidth({ viewportWidth: 1024, sidebarOpen: true, sidebarWidth: 260,
    previewOpen: true, previewWidth: 480 }), 344);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 1024, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: true, rightPanelWidth: 344 }), 1024);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 840, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: false, rightPanelWidth: 560 }), 840);
});

test("fits a resizable preview beside chat on a laptop", () => {
  assert.equal(PREVIEW_PANEL_MIN_WIDTH, 300);
  assert.equal(PREVIEW_PANEL_DEFAULT_WIDTH, 1000);
  assert.equal(getRightPanelMaxWidth({ viewportWidth: 1440, sidebarOpen: true, sidebarWidth: 260,
    previewOpen: true, previewWidth: 300 }), 560);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 1440, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: false, rightPanelWidth: 560 }), 760);
  assert.equal(getSidebarMaxWidth({ viewportWidth: 1440, rightPanelOpen: true, rightPanelWidth: 560,
    previewOpen: true, previewWidth: 300 }), 260);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 980, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: false, rightPanelWidth: 560 }), 300);
  assert.equal(getPreviewMaxWidth({ viewportWidth: 1180, sidebarOpen: true, sidebarWidth: 260,
    rightPanelOpen: true, rightPanelWidth: 300 }), 300);
});
