import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { showSidebarFiles, showSidebarSessions } from "./sidebar.mjs";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const TIMEOUT_MS = 20_000;
const MOBILE_MAX_WIDTH = 640;
const GEOMETRY_TOLERANCE = 2;
const MIN_RESIZE_CHANGE = 40;
const RESIZE_DISTANCE = 90;
const HEIGHT_STORAGE_KEY = "pi-terminal-height";
const TIMESTAMP = "2026-10-13T12:00:00.000Z";
const CWD_A = "/private/tmp/pi-web-terminal-layout/workspace-a";
const CWD_B = "/private/tmp/pi-web-terminal-layout/workspace-b";
const FILE_NAME = "note.txt";
const BUFFER_TEXT = "BUFFER_ALIVE";
const OUTPUT = `${BUFFER_TEXT}\r\n\u001b[31mANSI_RED\u001b[0m\r\n`;
const TEST_CASES = ["all", "regression", "layout", "theme", "font-load"];
const testCase = process.env.PI_WEB_E2E_CASE ?? "all";
assert.ok(TEST_CASES.includes(testCase), "PI_WEB_E2E_CASE must be all, regression, layout, theme, or font-load");
const browserName = process.env.PI_WEB_E2E_BROWSER ?? "chromium";
assert.ok(["chromium", "webkit"].includes(browserName), "PI_WEB_E2E_BROWSER must be chromium or webkit");
const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
const artifacts = process.env.PI_WEB_E2E_ARTIFACTS ?? fileURLToPath(new URL("../test-results/terminal-layout/", import.meta.url));
const SESSIONS = [
  { id: "terminal-layout-a1", cwd: CWD_A, name: "Terminal layout one" },
  { id: "terminal-layout-a2", cwd: CWD_A, name: "Terminal layout two" },
  { id: "terminal-layout-b1", cwd: CWD_B, name: "Other project" },
];
const TERMINAL_THEMES = [
  ["light", "Switch terminal to light theme"],
  ["zenburn", "Switch terminal to Zenburn theme"],
  ["dark", "Switch terminal to dark theme"],
];
const TERMINAL_COLORS = {
  dark: { background: "rgb(17, 19, 24)", foreground: "rgb(215, 220, 229)", red: "rgb(248, 113, 113)" },
  light: { background: "rgb(251, 251, 252)", foreground: "rgb(36, 41, 47)", red: "rgb(207, 34, 46)" },
  zenburn: { background: "rgb(63, 63, 63)", foreground: "rgb(220, 220, 204)", red: "rgb(125, 93, 93)" },
};

function fixture() {
  return { terminals: new Map(), created: [], deleted: [], input: [], resizes: [], agentCommands: [], mutations: [] };
}

function sessionInfo(session) {
  return {
    ...session, projectRoot: session.cwd, projectKey: session.cwd, branch: "main",
    path: join(session.cwd, `${session.id}.jsonl`), created: TIMESTAMP, modified: TIMESTAMP,
    messageCount: 1, firstMessage: `${session.name} fixture.`,
  };
}

function sessionData(session) {
  return {
    sessionId: session.id, filePath: sessionInfo(session).path, totalActiveMs: 0,
    tree: [], treeFormat: "summary", leafId: null, snapshotRevision: session.id,
    context: {
      messages: [{ role: "user", content: `${session.name} fixture.` }],
      entryIds: ["fixture-user"], oldestEntryId: "fixture-user", hasMore: false,
      turnsBefore: 0, thinkingLevel: "off", model: { provider: "test", modelId: "fixture" },
    },
  };
}

async function mockApi(context, state) {
  // Mock every API route. Browser checks cannot start agents or write user files.
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = HTTP_OK) => route.fulfill({ status, json: body });
    const body = method === "GET" ? null : request.postDataJSON();

    if (path === "/api/terminal" && method === "POST") {
      state.created.push({ id: body.id, cwd: body.cwd });
      state.terminals.set(body.id, { id: body.id, cwd: body.cwd });
      await json({ id: body.id });
      return;
    }
    const terminal = path.match(/^\/api\/terminal\/([^/]+)$/);
    if (terminal) {
      const id = terminal[1];
      if (method === "DELETE") {
        state.deleted.push(id);
        state.terminals.delete(id);
        await json({ success: true });
        return;
      }
      if (method === "POST") {
        if (body.type === "resize") { state.resizes.push({ id, ...body }); }
        else { state.input.push({ id, ...body }); }
        await json({ success: true });
        return;
      }
      await json(state.terminals.get(id) ?? { error: "Terminal not found" }, state.terminals.has(id) ? HTTP_OK : HTTP_NOT_FOUND);
      return;
    }
    if (path.startsWith("/api/agent/") && method === "POST") {
      state.agentCommands.push({ path, body });
      await json({ success: true, data: body?.type === "get_tools" ? [] : { commands: [] } });
      return;
    }
    if (method !== "GET") {
      state.mutations.push({ path, method });
      await json(path === "/api/cwd/validate" ? { cwd: body.cwd, valid: true, exists: true } : { success: true });
      return;
    }
    if (path === "/api/sessions") {
      await json({ sessions: SESSIONS.map(sessionInfo), sessionListVersion: 1, runningSessionIds: [] });
      return;
    }
    if (path === "/api/sessions/ui-state") {
      await json({ state: { version: 1, revision: 0, sessions: {}, projects: {} } });
      return;
    }
    if (path === "/api/agent/running") {
      await json({ sessionListVersion: 1, sessionUiStateRevision: 0, runningSessionIds: [], awaitingInputSessionIds: [] });
      return;
    }
    const session = SESSIONS.find((item) => path.includes(item.id));
    if (session && (path.endsWith("/state") || path.startsWith("/api/agent/"))) {
      await json({ running: false, state: { isStreaming: false, isPromptRunning: false, model: { provider: "test", id: "fixture" } } });
      return;
    }
    if (session && (path.startsWith("/api/sessions/") || path.endsWith("/context"))) {
      await json(sessionData(session));
      return;
    }
    if (path === "/api/models") {
      await json({ models: { fixture: "Fixture" }, modelList: [{ provider: "test", id: "fixture", name: "Fixture" }], defaultModel: { provider: "test", modelId: "fixture" } });
      return;
    }
    if (path === "/api/worktrees") {
      const cwd = url.searchParams.get("cwd") ?? CWD_A;
      await json({ projectRoot: cwd, projectKey: cwd, isGit: true, isTopLevel: true, currentWorktreePath: cwd, worktrees: [{ path: cwd, branch: "main", isMain: true }] });
      return;
    }
    if (path === "/api/git/status") {
      await json({ isGitRepository: true, repositoryRoot: url.searchParams.get("cwd"), files: [], additions: 0, deletions: 0 });
      return;
    }
    if (path === "/api/git/diff") { await json({ supported: false }); return; }
    if (path.startsWith("/api/files/")) {
      await json(url.searchParams.get("type") === "list"
        ? { entries: [{ name: FILE_NAME, isDir: false, size: 25, modified: TIMESTAMP }] }
        : { content: "Terminal file fixture.\n", language: "text", size: 23, nextOffset: 0, truncated: false });
      return;
    }
    if (path === "/api/home") { await json({ home: "/private/tmp" }); return; }
    if (path === "/api/skills") { await json({ skills: [] }); return; }
    if (path === "/api/project-trust") { await json({ trusted: true, servers: [] }); return; }
    if (path === "/api/open-in-explorer") { await json({ available: false }); return; }
    if (path === "/api/app-update") { await json({ current: "0.12.1", latest: "0.12.1", updateAvailable: false }); return; }
    await json({});
  });

  await context.addInitScript(({ output }) => {
    localStorage.setItem("pi-theme", "light");
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-sound-enabled", "false");
    window.__terminalMock = { streams: [], closedStreams: [] };
    class MockEventSource {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = MockEventSource.CONNECTING;
      listeners = new Map();
      constructor(input) {
        this.url = new URL(input, location.href).href;
        const terminal = new URL(this.url).pathname.startsWith("/api/terminal/");
        if (terminal) { window.__terminalMock.streams.push(this.url); }
        queueMicrotask(() => {
          if (this.readyState === MockEventSource.CLOSED) { return; }
          this.readyState = MockEventSource.OPEN;
          this.onopen?.({ type: "open" });
          for (const handler of this.listeners.get("open") ?? []) { handler({ type: "open" }); }
          if (terminal) {
            this.onmessage?.({ data: JSON.stringify({ type: "output", data: output, offset: output.length, reset: true }) });
          }
        });
      }
      addEventListener(name, listener) {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
      }
      removeEventListener(name, listener) {
        this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
      }
      close() {
        this.readyState = MockEventSource.CLOSED;
        if (new URL(this.url).pathname.startsWith("/api/terminal/")) { window.__terminalMock.closedStreams.push(this.url); }
      }
    }
    window.EventSource = MockEventSource;
  }, { output: OUTPUT });
}

async function showSidebar(page) {
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await show.isVisible()) { await show.click(); }
}

async function openTerminal(page) {
  await showSidebar(page);
  await showSidebarFiles(page);
  await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
  await page.locator('.terminal-panel[data-terminal-status="ready"]:visible').waitFor();
  await page.locator(".terminal-panel:visible .xterm-rows").getByText(BUFFER_TEXT, { exact: false }).waitFor();
}

async function assertTheme(page, theme = "dark") {
  const colors = await page.locator(".terminal-panel:visible .xterm-viewport").evaluate((viewport) => {
    return {
      background: getComputedStyle(viewport).backgroundColor,
      foreground: getComputedStyle(viewport.closest(".terminal-panel").querySelector(".xterm-rows")).color,
      red: getComputedStyle([...viewport.closest(".terminal-panel").querySelectorAll(".xterm-rows span")].find((span) => span.textContent.includes("ANSI_RED"))).color,
    };
  });
  assert.deepEqual(colors, TERMINAL_COLORS[theme], "The terminal uses its own selected palette");
  assert.equal(await page.locator(".terminal-panel:visible").getAttribute("data-terminal-theme"), theme);
}

async function chooseTheme(page, id, label) {
  await showSidebar(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const general = page.locator(".settings-section-tabs").getByRole("button", { name: "General", exact: true });
  if (await general.count()) { await general.click(); }
  await page.getByRole("radio", { name: label, exact: true }).locator("..").click();
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, id);
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
  const backdrop = page.locator(".sidebar-overlay-backdrop");
  if (await backdrop.isVisible()) { await backdrop.click({ position: { x: page.viewportSize().width - 5, y: 100 } }); }
}

async function layoutChecks(page, state, viewport) {
  const dock = page.locator("#terminal-dock");
  assert.equal(await dock.count(), 1, "The terminal must have a separate bottom dock");
  assert.equal(await dock.getAttribute("role"), "region");
  assert.equal(await dock.getAttribute("aria-label"), "Terminal");
  const shell = await dock.locator(".xterm").elementHandle();
  const created = state.created.length;
  const [id] = state.terminals.keys();
  const streams = await page.evaluate(() => window.__terminalMock.streams.length);
  const chat = page.locator(".chat-input-shell").first();
  const composer = await chat.boundingBox();
  const bounds = await dock.boundingBox();
  assert.ok(composer && bounds && composer.y + composer.height <= bounds.y + GEOMETRY_TOLERANCE, "The terminal must sit below the chat composer");
  assert.equal(await page.locator("#file-panel .terminal-panel").count(), 0, "File tabs must not own terminal panels");
  assert.equal(await dock.locator(".terminal-panel header").count(), 0, "A healthy terminal must not reserve a header row");
  assert.equal(await dock.getByRole("button", { name: "Restart terminal", exact: true }).count(), 1, "Restart belongs in the dock tab bar");
  assert.equal(await dock.locator(".terminal-panel").innerText().then((text) => text.includes(CWD_A)), false, "The cwd belongs in the tab tooltip");
  assert.equal(await dock.getByRole("tab", { name: "Terminal: workspace-a", exact: true }).getByTitle(CWD_A, { exact: true }).count(), 1);
  const usableSpace = await dock.locator(".terminal-panel:visible").evaluate((element) => {
    const panel = element.getBoundingClientRect();
    const content = element.querySelector(".terminal-xterm").getBoundingClientRect();
    const keys = element.querySelector(".terminal-extra-keys")?.getBoundingClientRect().height ?? 0;
    return { topGap: content.top - panel.top, contentHeight: content.height, panelHeight: panel.height, keysHeight: keys };
  });
  assert.ok(usableSpace.topGap <= GEOMETRY_TOLERANCE, "Terminal content must start directly below the tab bar");
  assert.ok(usableSpace.contentHeight + usableSpace.keysHeight >= usableSpace.panelHeight - GEOMETRY_TOLERANCE, "Terminal content and touch keys must fill the panel");

  const grid = await dock.locator(".terminal-xterm-host:visible").evaluate((host) => {
    const bounds = host.closest(".terminal-xterm").getBoundingClientRect();
    const screen = host.querySelector(".xterm-screen").getBoundingClientRect();
    const row = host.querySelector(".xterm-rows > div").getBoundingClientRect();
    const style = getComputedStyle(host.querySelector(".xterm-rows"));
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = `${style.fontSize} ${style.fontFamily}`;
    return {
      leftGap: screen.left - bounds.left, topGap: screen.top - bounds.top,
      rightGap: bounds.right - screen.right, bottomGap: bounds.bottom - screen.bottom,
      rowHeight: row.height, cellWidth: canvas.measureText("W").width,
    };
  });
  const SCROLLBAR_WIDTH = 8;
  assert.ok(grid.leftGap <= GEOMETRY_TOLERANCE && grid.topGap <= GEOMETRY_TOLERANCE,
    `The terminal grid must start at the content edge: ${JSON.stringify(grid)}`);
  assert.ok(grid.rightGap >= -GEOMETRY_TOLERANCE && grid.rightGap < SCROLLBAR_WIDTH + grid.cellWidth + GEOMETRY_TOLERANCE,
    `Only the scrollbar and a partial cell can remain beside the grid: ${JSON.stringify(grid)}`);
  assert.ok(grid.bottomGap >= -GEOMETRY_TOLERANCE && grid.bottomGap < grid.rowHeight + GEOMETRY_TOLERANCE,
    `Terminal rows must fill the dock: ${JSON.stringify(grid)}`);

  await dock.getByRole("button", { name: "Hide terminal panel", exact: true }).click();
  await dock.waitFor({ state: "hidden" });
  assert.equal(await shell.evaluate((element) => element.isConnected), true, "Hide must keep xterm mounted");
  await page.getByRole("button", { name: "Show terminal panel", exact: true }).click();
  await dock.waitFor({ state: "visible" });
  assert.equal(state.created.length, created, "Reopen must not create a PTY");
  assert.equal(await page.evaluate(() => window.__terminalMock.streams.length), streams, "Reopen must keep the stream");
  assert.equal(state.deleted.length, 0);

  await showSidebar(page);
  await showSidebarFiles(page);
  await page.locator("#session-sidebar-panel-files").getByText(FILE_NAME, { exact: true }).click();
  await page.getByText("Terminal file fixture.", { exact: true }).waitFor();
  await dock.waitFor({ state: "visible" });
  assert.equal(await page.locator("#file-panel").getByRole("tab", { name: "Terminal: workspace-a", exact: true }).count(), 0);
  if (viewport.width > MOBILE_MAX_WIDTH) {
    const fileBounds = await page.locator("#file-panel").boundingBox();
    const terminalBounds = await dock.boundingBox();
    assert.ok(terminalBounds.x + terminalBounds.width <= fileBounds.x + GEOMETRY_TOLERANCE, "The right file panel must remain beside the chat and terminal");
  }
  const hideFile = page.locator("#file-panel").getByRole("button", { name: "Hide file panel", exact: true });
  if (await hideFile.getAttribute("aria-expanded") === "true") { await hideFile.click(); }
  await dock.waitFor({ state: "visible" });

  const separator = page.getByRole("separator", { name: "Resize terminal panel", exact: true });
  await separator.waitFor();
  const before = await dock.boundingBox();
  const handle = await separator.boundingBox();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2 - RESIZE_DISTANCE, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(({ oldHeight, change }) => document.querySelector("#terminal-dock").getBoundingClientRect().height > oldHeight + change, { oldHeight: before.height, change: MIN_RESIZE_CHANGE });
  const resized = await dock.boundingBox();
  const savedHeight = await page.evaluate((key) => localStorage.getItem(key), HEIGHT_STORAGE_KEY);
  assert.ok(savedHeight && Number(savedHeight) > before.height, "The resize must persist the terminal height");
  assert.ok(state.resizes.some((resize) => resize.id === id), "The PTY must receive fitted dimensions");
  await page.reload();
  await page.getByText("Terminal layout one fixture.", { exact: true }).waitFor();
  await page.locator('#terminal-dock:visible .terminal-panel[data-terminal-status="ready"]:visible').waitFor();
  const restored = await dock.boundingBox();
  assert.ok(Math.abs(restored.height - resized.height) <= GEOMETRY_TOLERANCE, "Reload must restore the panel height");
  assert.equal(state.created.length, created, "Reload must attach to the saved PTY");

  for (const name of ["Terminal layout two", "Other project"]) {
    await showSidebar(page);
    await showSidebarSessions(page);
    const session = SESSIONS.find((item) => item.name === name);
    const group = page.locator(".session-tree-group-toggle").and(page.getByTitle(session.cwd, { exact: true }));
    if (await group.getAttribute("aria-expanded") === "false") { await group.click(); }
    await page.locator("#session-sidebar-panel-sessions").getByText(name, { exact: true }).click();
    await page.getByText(`${name} fixture.`, { exact: true }).waitFor();
    await dock.waitFor({ state: "visible" });
    assert.equal(state.created.length, created, "Session and project switches must preserve the PTY");
    assert.equal(await dock.getByRole("tab", { name: "Terminal: workspace-a", exact: true }).getByTitle(CWD_A, { exact: true }).count(), 1);
    await dock.locator(".xterm-rows").getByText(BUFFER_TEXT, { exact: false }).waitFor();
  }
  await page.waitForFunction((cwd) => document.querySelector("#session-sidebar-panel-files .project-picker-button.is-project")?.title === cwd, CWD_B);
  await openTerminal(page);
  assert.equal(new Set(state.created.map((terminal) => terminal.id)).size, 2, "Another project receives its own PTY");
  await dock.getByRole("tab", { name: "Terminal: workspace-a", exact: true }).click();
  await dock.locator(".terminal-panel:visible .xterm-rows").getByText(BUFFER_TEXT, { exact: false }).waitFor();
  assert.equal(await dock.getByRole("tab").count(), 2);
  for (const name of ["workspace-a", "workspace-b"]) {
    await dock.getByRole("button", { name: `Terminate terminal ${name}`, exact: true }).click();
  }
  await page.waitForFunction(() => document.querySelectorAll(".terminal-panel").length === 0);
  assert.equal(state.terminals.size, 0, "Explicit termination must close both PTYs");
}

async function fontLoadChecks(page, state) {
  await page.evaluate(() => document.fonts.ready);
  const { cols } = state.resizes.at(-1);
  const metrics = await page.locator(".terminal-xterm-host:visible").evaluate((host, cols) => {
    const screen = host.querySelector(".xterm-screen").getBoundingClientRect();
    const style = getComputedStyle(host.querySelector(".xterm-rows"));
    const canvas = document.createElement("canvas").getContext("2d");
    canvas.font = `${style.fontSize} ${style.fontFamily}`;
    return { cellWidth: screen.width / cols, glyphWidth: canvas.measureText("W").width };
  }, cols);
  const CELL_ROUNDING_TOLERANCE = 0.1;
  assert.ok(Math.abs(metrics.cellWidth - metrics.glyphWidth) < CELL_ROUNDING_TOLERANCE,
    `The grid must use the loaded font metrics: ${JSON.stringify(metrics)}`);
}

async function themeChecks(page, state) {
  await assertTheme(page);
  const appTheme = await page.evaluate(() => document.documentElement.dataset.theme);
  const shell = await page.locator(".terminal-panel:visible .xterm").elementHandle();
  const creations = state.created.length;
  const streams = await page.evaluate(() => window.__terminalMock.streams.length);
  for (const [id, label] of TERMINAL_THEMES) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await assertTheme(page, id);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), appTheme, "Terminal colors do not change the interface");
    assert.equal(await page.evaluate(() => localStorage.getItem("pi-web:terminal-theme")), id);
    assert.equal(await shell.evaluate((element) => element.isConnected), true, "Theme changes must keep xterm mounted");
    assert.equal(state.created.length, creations, "Theme changes must not create a PTY");
    assert.equal(await page.evaluate(() => window.__terminalMock.streams.length), streams, "Theme changes must keep the stream");
    assert.equal(state.deleted.length, 0);
    await page.locator(".terminal-panel:visible .xterm-rows").getByText(BUFFER_TEXT, { exact: false }).waitFor();
  }

  await chooseTheme(page, "zenburn", "Zenburn");
  await assertTheme(page, "dark");
  await page.getByRole("button", { name: "Switch terminal to light theme", exact: true }).click();
  await page.getByRole("button", { name: "Switch terminal to Zenburn theme", exact: true }).click();
  await page.reload();
  await page.locator('.terminal-panel[data-terminal-status="ready"]:visible').waitFor();
  await assertTheme(page, "zenburn");
  assert.equal(state.created.length, creations, "Reload restores the same terminal with Zenburn");
  await chooseTheme(page, "light", "Light");
  await assertTheme(page, "zenburn");

  const other = await page.context().newPage();
  try {
    await other.goto(base);
    await other.evaluate(() => localStorage.setItem("pi-web:terminal-theme", "dark"));
    await page.locator('.terminal-panel[data-terminal-theme="dark"]:visible').waitFor();
    await assertTheme(page, "dark");
    await other.evaluate(() => localStorage.setItem("pi-web:terminal-theme", "zenburn"));
    await page.locator('.terminal-panel[data-terminal-theme="zenburn"]:visible').waitFor();
    await assertTheme(page, "zenburn");
    assert.equal(state.created.length, creations, "Another tab changes the palette without a new PTY");
  } finally {
    await other.close();
  }
}

mkdirSync(artifacts, { recursive: true });
const browser = await (browserName === "webkit" ? webkit : chromium).launch();
const failures = [];
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
    for (const check of testCase === "regression" ? ["layout", "theme"] : testCase === "all" ? ["layout", "theme", "font-load"] : [testCase]) {
      const label = `${browserName}-${viewport.width}-${check}`;
      const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce", hasTouch: viewport.width <= MOBILE_MAX_WIDTH });
      const page = await context.newPage();
      page.setDefaultTimeout(TIMEOUT_MS);
      const state = fixture();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await mockApi(context, state);
      let releaseFonts;
      if (check === "font-load") {
        const fonts = new Promise((resolve) => { releaseFonts = resolve; });
        await context.route("**/*.woff2", async (route) => { await fonts; await route.continue(); });
      }
      try {
        await page.goto(`${base}/?session=${SESSIONS[0].id}`, { waitUntil: "domcontentloaded" });
        await page.getByText("Terminal layout one fixture.", { exact: true }).waitFor();
        if (check === "font-load") {
          await showSidebar(page);
          await showSidebarFiles(page);
          await page.getByRole("button", { name: "Open workspace terminal", exact: true }).click();
          await page.locator(".terminal-panel:visible").waitFor();
          // Let the terminal mount before the delayed font arrives.
          await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          releaseFonts();
          await page.locator('.terminal-panel[data-terminal-status="ready"]:visible').waitFor();
        } else {
          await openTerminal(page);
        }
        if (testCase === "regression") {
          if (check === "layout") { assert.equal(await page.locator("#terminal-dock").count(), 1, "The terminal must have a separate bottom dock"); }
          else { await assertTheme(page); }
        } else if (check === "layout") { await layoutChecks(page, state, viewport); }
        else if (check === "font-load") { await fontLoadChecks(page, state); }
        else { await themeChecks(page, state); }
        assert.deepEqual(errors, []);
        assert.equal(state.agentCommands.filter(({ path, body }) => path === "/api/agent/new" || ["prompt", "steer", "follow_up"].includes(body?.type)).length, 0);
        assert.ok(state.mutations.every(({ path }) => path === "/api/cwd/validate" || path === "/api/sessions/ui-state"));
        await page.screenshot({ path: join(artifacts, `${label}.png`), fullPage: true });
        console.log(`PASS ${label}`);
      } catch (error) {
        failures.push(`${label}: ${error.message}`);
        await page.screenshot({ path: join(artifacts, `${label}-failure.png`), fullPage: true }).catch(() => {});
        console.error(`FAIL ${label}: ${error.message}`);
      } finally {
        releaseFonts?.();
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
}
assert.deepEqual(failures, [], `Terminal layout failures. Artifacts: ${artifacts}`);
