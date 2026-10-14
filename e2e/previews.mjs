import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { showSidebarFiles } from "./sidebar.mjs";

const base = process.env.E2E_BASE_URL ?? "http://127.0.0.1:30141";
const browserName = process.env.PI_WEB_E2E_BROWSER ?? "chromium";
const artifacts = process.env.PI_WEB_E2E_ARTIFACTS ?? fileURLToPath(new URL("../test-results/previews/", import.meta.url));
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const CWD = "/private/tmp/pi-web-preview-fixture";
const ID = "preview-fixture-session";
const TIMESTAMP = "2026-10-14T12:00:00Z";
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const TIMEOUT_MS = 20_000;
const FILE = "preview-fixture.ts";
const PREVIEW_MIN_WIDTH = 300;
const PREVIEW_MAX_WIDTH = 1200;
const PREVIEW_SPLIT_WIDTH = 980;
const COMPACT_DESKTOP_WIDTH = 840;
const PREVIEW_DRAG_DISTANCE = 120;
const PREVIEW_DESKTOP_INSET = 8;
const MAX_PREVIEW_CHROME_HEIGHT = 44 + PREVIEW_DESKTOP_INSET * 2;

function snapshot() {
  return {
    configured: true, context: { root: CWD, repo: "owner/podman-desktop", branch: "fix/test", head: SHA, dirty: false },
    binding: null, session: null, pushedCommit: null, freshness: "unknown", expired: false,
  };
}

async function mockApi(context, state) {
  await context.addInitScript(() => {
    localStorage.setItem("pi-theme", "zenburn");
    localStorage.setItem("pi-locale", "en");
    localStorage.setItem("pi-sound-enabled", "false");
    class MockEventSource extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSED = 2;
      readyState = MockEventSource.OPEN;
      constructor(url) {
        super();
        this.url = new URL(url, location.href).href;
        queueMicrotask(() => this.onopen?.({ type: "open" }));
      }
      close() { this.readyState = MockEventSource.CLOSED; }
    }
    window.EventSource = MockEventSource;
  });
  await context.route("https://desktop.example.test/**", (route) => route.fulfill({
    contentType: "text/html", body: `<!doctype html>
      <label>Desktop input<input aria-label="Desktop input"></label>
      <output id="viewport"></output>
      <script>
        window.resizeCount = 0;
        const updateSize = () => {
          document.getElementById("viewport").textContent = innerWidth + "x" + innerHeight;
        };
        updateSize();
        window.addEventListener("resize", () => { window.resizeCount += 1; updateSize(); });
      </script>`,
  }));
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = HTTP_OK) => route.fulfill({ status, json: body });
    if (path === "/api/preview/desktop") {
      return json({ url: `https://desktop.example.test/?id=${state.snapshot.session.id}` });
    }
    if (path === "/api/preview/sign-in") {
      if (method === "GET") {
        return json(state.flow);
      }
      const body = request.postDataJSON();
      state.auth.push(body.action);
      if (body.action === "start") {
        state.flow = { id: "oidc-fixture", phase: "authorize", authorizationUrl: "https://auth.example.test/dex/auth?state=fixture" };
        return json(state.flow);
      }
      if (body.action === "logout") {
        state.config.signedIn = false;
        return json({ signedOut: true });
      }
      if (body.action === "cancel") {
        state.flow.phase = "cancelled";
        return json(state.flow);
      }
      if (body.action === "finish") {
        if (!body.redirectUrl.includes("state=fixture")) {
          return json({ error: "The callback address does not match this sign-in." }, 400);
        }
        state.flow.phase = "done";
        state.config.signedIn = true;
        return json(state.flow);
      }
    }
    if (path === "/api/preview/config") {
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.saved.push(body);
        state.config = { ...state.config, apiUrl: body.apiUrl, oidc: body.oidc };
        return json(state.config);
      }
      if (method === "POST") {
        return json({ sessions: 1 });
      }
      return json(state.config);
    }
    if (path === "/api/preview") {
      if (method === "GET") {
        return json(url.searchParams.get("view") === "logs" ? { lines: ["Build completed for fixture"] } : state.snapshot);
      }
      const body = request.postDataJSON();
      state.actions.push(body);
      assert.deepEqual(body.target, { ...state.snapshot.context }, "the browser guards actions with the displayed worktree");
      if (body.action === "start") {
        state.snapshot.binding = { id: "desktop-one", spec: { repo: "owner/podman-desktop", branch: "fix/test", kind: "desktop", mode: "dev", autoUpdate: true }, createKey: "fixture" };
        state.snapshot.session = {
          id: "desktop-one", phase: "ready", vncReady: true, vncUrl: "https://desktop.example.test/",
          expiresAt: "2030-01-01T12:00:00Z", runtime: { phase: "ready", appliedCommit: SHA, sourceCommit: SHA, lastError: "" },
        };
        state.snapshot.pushedCommit = SHA;
        state.snapshot.freshness = "current";
      }
      if (body.action === "sync") {
        state.snapshot.session.phase = "updating";
        state.snapshot.pushedCommit = NEXT_SHA;
        state.snapshot.freshness = "update-required";
      }
      if (body.action === "reset") {
        state.snapshot.session.id = "desktop-two";
        state.snapshot.session.phase = "building";
      }
      if (body.action === "stop") {
        state.snapshot = snapshot();
      }
      return json(state.snapshot);
    }
    if (method !== "GET") {
      if (path === `/api/agent/${ID}/lease`) {
        return json({ running: false, awaitingInput: false, subagentsActive: false });
      }
      if (["/api/cwd/validate", "/api/sessions/ui-state"].includes(path)) {
        return json({ success: true, valid: true, exists: true, cwd: CWD });
      }
      state.unexpected.push({ method, path });
      return json({ error: "Unexpected mutation" }, HTTP_NOT_FOUND);
    }
    const info = { id: ID, cwd: CWD, name: "Preview fixture", firstMessage: "Preview fixture message.", projectRoot: CWD, projectKey: CWD, branch: "fix/test", path: `${CWD}/fixture.jsonl`, created: TIMESTAMP, modified: TIMESTAMP, messageCount: 1 };
    if (path === "/api/sessions") {
      return json({ sessions: [info], sessionListVersion: 1, runningSessionIds: [] });
    }
    if (path === "/api/sessions/ui-state") {
      return json({ state: { version: 1, revision: 0, sessions: {}, projects: {} } });
    }
    if (path === "/api/agent/running") {
      return json({ sessionListVersion: 1, sessionUiStateRevision: 0, runningSessionIds: [], awaitingInputSessionIds: [] });
    }
    if (path === `/api/sessions/${ID}` || path.endsWith("/context")) {
      return json({ sessionId: ID, filePath: info.path, tree: [], treeFormat: "summary", leafId: null, snapshotRevision: "fixture", context: {
        messages: [{ role: "user", content: "Preview fixture message." }], entryIds: ["user-entry"], oldestEntryId: "user-entry", hasMore: false, turnsBefore: 0,
        thinkingLevel: "off", model: { provider: "test", modelId: "fixture" },
      } });
    }
    if (path.startsWith("/api/agent/") || path.endsWith("/state")) {
      return json({ running: false, state: { isStreaming: false, isPromptRunning: false } });
    }
    if (path === "/api/models") {
      return json({ models: {}, modelList: [] });
    }
    if (path === "/api/worktrees") {
      return json({ projectRoot: CWD, projectKey: CWD, isGit: true, isTopLevel: true, currentWorktreePath: CWD, worktrees: [{ path: CWD, branch: "fix/test", isMain: true }] });
    }
    if (path === "/api/git/status") {
      return json({ isGitRepository: true, files: [{ filePath: join(CWD, FILE), status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }] });
    }
    if (path === "/api/git/diff") {
      return json({ supported: true, status: "modified", patch: `diff --git a/${FILE} b/${FILE}\n--- a/${FILE}\n+++ b/${FILE}\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n` });
    }
    if (path.startsWith("/api/files/")) {
      return json(url.searchParams.get("type") === "list"
        ? { entries: [{ name: FILE, isDir: false, size: 24, modified: TIMESTAMP }] }
        : { content: "export const value = 2;\n", language: "typescript", size: 24, nextOffset: 0, truncated: false });
    }
    if (path === "/api/project-trust") {
      return json({ trusted: true, projectTrusted: true, servers: [], mcpServers: [], mcpFile: null });
    }
    return json({});
  });
}

mkdirSync(artifacts, { recursive: true });
const browser = await (browserName === "webkit" ? webkit : chromium).launch();
try {
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 1920, height: 1000 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, locale: "en-US", reducedMotion: "reduce" });
    const state = {
      snapshot: snapshot(), actions: [], saved: [], unexpected: [], auth: [], flow: null,
      config: { apiUrl: "http://preview.test", configured: true, hasToken: true, urlFromEnv: false, tokenFromEnv: false, oidc: null, signedIn: false },
    };
    const errors = [];
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT_MS);
    page.on("pageerror", (error) => errors.push(error.message));
    await mockApi(context, state);
    try {
      await page.goto(`${base}/?session=${ID}`);
      await page.getByText("Preview fixture message.", { exact: true }).waitFor();
      const chatBefore = await page.locator(".chat-workspace-content").boundingBox();
      assert.equal(await page.locator(".preview-card").count(), 0, "no extra row before the panel opens");
      await page.getByRole("button", { name: "Previews", exact: true }).click();
      const card = page.getByRole("region", { name: "Previews", exact: true });
      const controls = page.getByRole("dialog", { name: "Preview controls", exact: true });
      const controlsButton = card.getByRole("button", { name: "Preview controls", exact: true });
      async function openControls() {
        if (!await controls.isVisible()) {
          await controlsButton.click();
        }
        await controls.waitFor();
      }
      await card.waitFor();
      const application = card.getByRole("combobox", { name: /^Application/ });
      await application.waitFor();
      assert.equal(await application.inputValue(), "desktop");
      await card.locator(".preview-advanced > summary").click();
      const buildMode = card.getByRole("combobox", { name: /^Build mode/ });
      assert.equal(await buildMode.inputValue(), "dev");
      state.snapshot.context.repo = "owner/my-Extension";
      await card.getByRole("button", { name: "Refresh", exact: true }).click();
      await card.getByRole("combobox", { name: /^Extension build/ }).waitFor();
      assert.equal(await application.inputValue(), "extension");
      assert.equal(await buildMode.inputValue(), "dev");
      await application.selectOption("desktop");
      await Promise.all([
        page.waitForResponse((response) => new URL(response.url()).pathname === "/api/preview"),
        card.getByRole("button", { name: "Refresh", exact: true }).click(),
      ]);
      assert.equal(await application.inputValue(), "desktop", "refresh preserves a manual application choice");
      state.snapshot.context.repo = "owner/podman-desktop";
      await card.getByRole("button", { name: "Refresh", exact: true }).click();
      await card.getByPlaceholder("owner/podman-desktop", { exact: true }).waitFor();
      await card.locator(".preview-advanced > summary").click();
      if (viewport.width >= PREVIEW_SPLIT_WIDTH) {
        // An outside click must leave both the preview and the chat usable.
        await page.mouse.click(chatBefore.x + 16, chatBefore.y + 200);
        assert.equal(await card.isVisible(), true, "an outside click keeps the preview open");
        await page.locator(".chat-input-textarea").fill("Draft beside the desktop");
        await page.getByRole("separator", { name: "Resize preview panel", exact: true }).waitFor();
      }
      const previewBox = await page.locator("#workspace-preview").boundingBox();
      assert.ok(previewBox.height >= viewport.height - 2, "the preview uses a full-height pane");
      assert.ok(previewBox.width >= Math.min(PREVIEW_MIN_WIDTH, viewport.width), "the preview respects its minimum width");
      if (viewport.width >= PREVIEW_SPLIT_WIDTH) {
        const chatAfter = await page.locator(".chat-workspace-content").boundingBox();
        assert.equal(chatAfter.y, chatBefore.y, "opening the preview preserves the chat height");
        assert.ok(previewBox.x >= chatAfter.x + chatAfter.width - 1, "the preview sits beside the chat");
      }
      await card.getByRole("button", { name: "Start", exact: true }).click();
      await card.getByText("Ready", { exact: true }).waitFor();
      const link = card.getByRole("link", { name: "Open Desktop", exact: true });
      assert.equal(await link.getAttribute("href"), "https://desktop.example.test/");
      assert.equal(await link.getAttribute("target"), "_blank");
      const desktop = page.frameLocator('iframe[title="Live desktop"]');
      const desktopInput = desktop.getByRole("textbox", { name: "Desktop input" });
      await desktopInput.fill("Preserve the desktop connection");
      const liveBox = await card.locator("iframe").boundingBox();
      assert.ok(previewBox.height - liveBox.height <= MAX_PREVIEW_CHROME_HEIGHT,
        "the live desktop gives at most one compact toolbar to controls");
      assert.ok(liveBox.x - previewBox.x >= PREVIEW_DESKTOP_INSET, "the desktop keeps an inset on the left");
      assert.ok(previewBox.x + previewBox.width - liveBox.x - liveBox.width >= PREVIEW_DESKTOP_INSET, "the desktop keeps an inset on the right");
      assert.ok(previewBox.y + previewBox.height - liveBox.y - liveBox.height >= PREVIEW_DESKTOP_INSET, "the desktop keeps an inset at the bottom");
      if (viewport.width >= PREVIEW_SPLIT_WIDTH) {
        await page.locator(".chat-input-textarea").click();
        assert.equal(await desktopInput.inputValue(), "Preserve the desktop connection", "chat focus keeps the desktop open");
      }
      await openControls();
      assert.deepEqual(await card.locator("iframe").boundingBox(), liveBox, "the menu preserves the VNC viewport");
      await controls.getByRole("button", { name: "Refresh", exact: true }).click();
      await controls.getByRole("button", { name: "Sync", exact: true }).click();
      await card.getByText("Update", { exact: true }).waitFor();
      assert.equal(await desktopInput.inputValue(), "Preserve the desktop connection", "status and Sync preserve the VNC frame");
      await controls.locator(".preview-details > summary").click();
      await controls.getByText("Fetch the pushed branch and rebuild now. Keep the desktop and its container storage.", { exact: true }).waitFor();
      assert.deepEqual(await card.locator("iframe").boundingBox(), liveBox, "details preserve the VNC viewport");
      await page.keyboard.press("Escape");
      await controls.waitFor({ state: "hidden" });
      assert.equal(await controlsButton.evaluate((button) => button === document.activeElement), true, "Escape returns focus to the toolbar");
      await page.screenshot({ path: join(artifacts, `${browserName}-${viewport.width}-compact-desktop.png`), fullPage: true });
      if (viewport.width >= PREVIEW_SPLIT_WIDTH) {
        const resizer = page.getByRole("separator", { name: "Resize preview panel", exact: true });
        const frame = page.locator('iframe[title="Live desktop"]');
        await resizer.focus();
        await page.keyboard.press("Home");
        const beforeResize = await frame.boundingBox();
        const resizeCount = await desktop.locator("html").evaluate(() => window.resizeCount);
        await resizer.focus();
        await page.keyboard.press("ArrowLeft");
        const afterResize = await frame.boundingBox();
        assert.ok(afterResize.width > beforeResize.width, "the divider grows the live viewport");
        await desktop.locator("#viewport").filter({ hasText: `${Math.round(afterResize.width)}x${Math.round(afterResize.height)}` }).waitFor();
        assert.ok(await desktop.locator("html").evaluate(() => window.resizeCount) > resizeCount, "the live viewer receives the resize event");
        assert.equal(await desktop.locator("html").evaluate(() => innerWidth), Math.round(afterResize.width));
        await page.keyboard.press("End");
        assert.ok((await page.locator("#workspace-preview").boundingBox()).width <= PREVIEW_MAX_WIDTH, "the divider respects the maximum width");
        await page.keyboard.press("Home");
        assert.ok((await page.locator("#workspace-preview").boundingBox()).width >= PREVIEW_MIN_WIDTH, "the divider respects the minimum width");
        const handle = await resizer.boundingBox();
        const handleX = handle.x + handle.width / 2;
        const handleY = handle.y + handle.height / 2;
        await page.mouse.move(handleX, handleY);
        await page.mouse.down();
        await page.mouse.move(handleX - PREVIEW_DRAG_DISTANCE, handleY, { steps: 8 });
        const draggedFrame = await frame.boundingBox();
        assert.ok(draggedFrame.width > PREVIEW_MIN_WIDTH, "a drag grows the live viewport before release");
        await desktop.locator("#viewport").filter({ hasText: `${Math.round(draggedFrame.width)}x${Math.round(draggedFrame.height)}` }).waitFor();
        await page.mouse.move(handleX + PREVIEW_DRAG_DISTANCE, handleY, { steps: 8 });
        await page.mouse.up();
        assert.ok((await page.locator("#workspace-preview").boundingBox()).width >= PREVIEW_MIN_WIDTH, "a drag cannot shrink the preview below its minimum");
        assert.equal(await desktopInput.inputValue(), "Preserve the desktop connection", "resize preserves the VNC frame");
        await card.getByRole("button", { name: "Close preview panel" }).click();
        await showSidebarFiles(page);
        const changes = page.getByRole("button", { name: "1 changed files", exact: true });
        if (await changes.getAttribute("aria-pressed") !== "true") { await changes.click(); }
        await page.locator("#session-sidebar-panel-files").getByTitle(join(CWD, FILE), { exact: true }).first().click();
        await page.locator(".diff-review").waitFor();
        await page.getByRole("button", { name: "Previews", exact: true }).click();
        await desktopInput.waitFor();
        const diffBox = await page.locator("#file-panel").boundingBox();
        const alongside = await page.locator("#workspace-preview").boundingBox();
        const chatBox = await page.locator(".chat-workspace-content").boundingBox();
        assert.ok(alongside.x >= diffBox.x + diffBox.width - 1, "the preview sits to the right of the diff");
        assert.ok(chatBox.width >= 318, "both panes preserve space for chat");
        await desktopInput.fill("Keep this connection across window sizes");
        await page.locator("#file-panel").getByRole("button", { name: "Expand file panel", exact: true }).click();
        assert.equal(await page.locator("#workspace-preview").evaluate((node) => node.inert), true);
        await page.locator("#file-panel").getByRole("button", { name: "Restore file panel width", exact: true }).click();
        assert.equal(await desktopInput.inputValue(), "Keep this connection across window sizes", "full-width diff preserves the desktop");
        for (const width of [1880, 1680, 1440, 1280, 1180, 1120, 1024, 1000, 980, COMPACT_DESKTOP_WIDTH, 390, 1920]) {
          await page.setViewportSize({ width, height: viewport.height });
          await page.waitForTimeout(100);
          const pane = await page.locator("#workspace-preview").boundingBox();
          assert.ok(pane.x >= 0 && pane.x + pane.width <= width + 1, `the preview fits at ${width}`);
          assert.ok(pane.width >= Math.min(PREVIEW_MIN_WIDTH, width), `the preview keeps its minimum width at ${width}`);
          assert.ok(pane.width <= PREVIEW_MAX_WIDTH, `the preview keeps its maximum width at ${width}`);
          if (width === COMPACT_DESKTOP_WIDTH) {
            // The overlay must expose the same divider as the split pane.
            const handle = await resizer.boundingBox();
            assert.ok(handle, "the compact layout keeps the divider visible");
            const x = handle.x + handle.width / 2;
            const y = handle.y + handle.height / 2;
            await page.mouse.move(x, y);
            await page.mouse.down();
            await page.mouse.move(x - PREVIEW_DRAG_DISTANCE, y, { steps: 8 });
            await page.mouse.up();
            assert.ok((await page.locator("#workspace-preview").boundingBox()).width > pane.width, "the overlay divider resizes the pane");
          }
          assert.equal(await desktopInput.inputValue(), "Keep this connection across window sizes");
        }
        await page.screenshot({ path: join(artifacts, `${browserName}-${viewport.width}-diff-desktop.png`), fullPage: true });
      }
      await openControls();
      await controls.getByRole("button", { name: "Logs", exact: true }).click();
      await controls.getByText("Build completed for fixture", { exact: true }).waitFor();
      await controls.getByRole("button", { name: "Reset", exact: true }).click();
      assert.equal(state.actions.filter((item) => item.action === "reset").length, 0);
      await controls.locator(".preview-confirm").getByRole("button", { name: "Cancel", exact: true }).click();
      await controls.getByRole("button", { name: "Reset", exact: true }).click();
      await controls.locator(".preview-confirm").getByRole("button", { name: "Reset", exact: true }).click();
      await card.getByText("Build", { exact: true }).waitFor();
      assert.equal(await desktopInput.inputValue(), "", "a replacement desktop gets a new VNC frame");
      await desktopInput.fill("Preserve on Keep alive");
      await openControls();
      await controls.getByRole("button", { name: "Keep alive", exact: true }).click();
      await controls.getByText("Preview expiry extended.", { exact: true }).waitFor();
      assert.equal(await desktopInput.inputValue(), "Preserve on Keep alive");
      const beforeReconnect = state.actions.length;
      await controls.getByRole("button", { name: "Reconnect", exact: true }).click();
      await desktopInput.waitFor();
      assert.equal(await desktopInput.inputValue(), "", "Reconnect reloads only the VNC frame");
      assert.equal(state.actions.length, beforeReconnect, "Reconnect does not change the remote desktop");
      const beforeClose = state.actions.length;
      await card.getByRole("button", { name: "Close preview panel" }).click();
      assert.equal(state.actions.length, beforeClose, "close does not delete the desktop");
      await page.getByRole("button", { name: "Previews", exact: true }).click();
      await openControls();
      await controls.getByRole("button", { name: "Settings", exact: true }).click();
      const settings = page.getByRole("dialog", { name: "Settings", exact: true });
      const secret = settings.getByLabel("API token", { exact: true });
      assert.equal(await secret.inputValue(), "", "the saved token never returns to the browser");
      await secret.fill("replacement-test-token");
      await settings.getByRole("button", { name: "Save", exact: true }).click();
      await settings.getByText("Preview connection saved.", { exact: true }).waitFor();
      assert.equal(await secret.inputValue(), "", "clear the password input after save");
      await settings.getByRole("button", { name: "Test saved connection", exact: true }).click();
      await settings.getByText("The API connection works.", { exact: true }).waitFor();
      await settings.getByLabel("API address", { exact: true }).fill("https://preview.example.test");
      await settings.getByLabel("Use OIDC authentication", { exact: true }).check();
      await settings.getByLabel("OIDC issuer", { exact: true }).fill("https://auth.example.test/dex");
      await settings.getByLabel("OIDC client ID", { exact: true }).fill("pi-preview");
      await settings.getByRole("button", { name: "Save", exact: true }).click();
      const signIn = settings.getByRole("button", { name: "Sign in with OIDC", exact: true });
      await signIn.click();
      const authLink = settings.getByRole("link", { name: "Open sign-in page", exact: true });
      await authLink.waitFor();
      assert.equal(await authLink.getAttribute("target"), "_blank");
      const callback = settings.getByRole("textbox", { name: "OIDC callback address", exact: true });
      await callback.fill("http://localhost:12345/callback?code=one&state=wrong");
      await settings.getByRole("button", { name: "Complete sign-in", exact: true }).click();
      await settings.getByRole("alert").filter({ hasText: "The callback address does not match this sign-in." }).waitFor();
      await callback.fill("http://localhost:12345/callback?code=one&state=fixture");
      await settings.getByRole("button", { name: "Complete sign-in", exact: true }).click();
      await settings.getByText("Pi has a saved OIDC session.", { exact: true }).waitFor();
      await settings.getByRole("button", { name: "Sign out of OIDC", exact: true }).click();
      await settings.getByText("Pi needs an OIDC sign-in.", { exact: true }).waitFor();
      await signIn.click();
      await authLink.waitFor();
      state.flow.phase = "done";
      state.config.signedIn = true;
      await settings.getByText("Pi has a saved OIDC session.", { exact: true }).waitFor();
      await signIn.click();
      await authLink.waitFor();
      await settings.getByRole("button", { name: "Cancel", exact: true }).click();
      await signIn.waitFor();
      await page.screenshot({ path: join(artifacts, `${browserName}-${viewport.width}-oidc.png`), fullPage: true });
      await page.keyboard.press("Escape");
      assert.equal(state.saved.length, 2);
      assert.deepEqual(state.saved[1].oidc, { issuer: "https://auth.example.test/dex", clientId: "pi-preview" });
      assert.deepEqual(state.auth, ["start", "finish", "finish", "logout", "start", "start", "cancel"]);
      assert.deepEqual(state.unexpected, []);
      assert.deepEqual(errors, []);
      assert.equal(await card.evaluate((node) => node.scrollWidth <= node.clientWidth), true, "the card fits on mobile");
      await page.screenshot({ path: join(artifacts, `${browserName}-${viewport.width}.png`), fullPage: true });
      console.log(`PASS ${browserName} ${viewport.width}`);
    } catch (error) {
      await page.screenshot({ path: join(artifacts, `${browserName}-${viewport.width}-failure.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
