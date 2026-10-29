import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { chromium, webkit } from "playwright";
import { showSidebarFiles } from "./sidebar.mjs";

const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_UNAVAILABLE = 503;
const DEFAULT_TIMEOUT_MS = 20_000;
const MOBILE_MAX_WIDTH = 640;
const MIN_REVIEW_WIDTH = 300;
const BROWSER = { all: "all", chromium: "chromium", webkit: "webkit" };
const TEST_CASE = { all: "all", freshCwd: "fresh-cwd", send: "send", edit: "edit", syntax: "syntax" };
const selectedBrowser = process.env.PI_WEB_E2E_BROWSER ?? BROWSER.all;
const selectedCase = process.env.PI_WEB_E2E_CASE ?? TEST_CASE.all;
assert.ok(Object.values(BROWSER).includes(selectedBrowser), "PI_WEB_E2E_BROWSER must be all, chromium, or webkit");
assert.ok(Object.values(TEST_CASE).includes(selectedCase), "PI_WEB_E2E_CASE must be all, fresh-cwd, send, edit, or syntax");
const base = process.env.E2E_BASE_URL ?? process.env.PI_WEB_E2E_BASE_URL ?? "http://127.0.0.1:30141";
const artifacts = process.env.PI_WEB_E2E_ARTIFACTS ?? fileURLToPath(new URL("../test-results/code-review/", import.meta.url));
const cwd = dirname(dirname(fileURLToPath(import.meta.url)));
const SESSION_ID = "e2e-code-review";
const TIMESTAMP = "2026-10-13T12:00:00.000Z";
const REVIEW_STORAGE_VERSION = 1;
const REVIEW_STORAGE_PREFIX = "pi-web:code-review:v1:";
const FRESH_SUBDIR = "e2e-review-subdir";
const ALPHA = "review-alpha.ts";
const BETA = "review-beta.ts";
const ORIGINAL_DRAFT = "Keep this chat draft.";
const OLD_COMMENT = "Preserve the original empty-input guard.";
const NEW_COMMENT = "Name the fallback value.";
const FILE_COMMENT = "Explain this module's public contract.";
const REVIEW_HEADER = "Address these comments:";
const UNBOUND_REVIEW_KEYS = [
  "j", "k", "g", "G", "V", "c", "C", "[", "]", "{", "}", "r", "y", "?", "/", "n", "N", "Control+d", "Control+u",
];
const ALPHA_PATCH = `diff --git a/${ALPHA} b/${ALPHA}
index 1111111..2222222 100644
--- a/${ALPHA}
+++ b/${ALPHA}
@@ -1,6 +1,6 @@
 export function count(values: number[]) {
-  const total = values.length;
-  return total;
+  const total = values?.length ?? 0;
+  return Math.max(total, 0);
 }
\x20
 export const label = "review";
@@ -20,3 +20,4 @@
 export function format(value: number) {
-  return String(value);
+  return value.toFixed(2);
+  // Keep a separate hunk for navigation.
 }
`;
const BETA_PATCH = `diff --git a/${BETA} b/${BETA}
index 3333333..4444444 100644
--- a/${BETA}
+++ b/${BETA}
@@ -1,3 +1,3 @@
 export function title(value: string) {
-  return value;
+  return value.trim();
 }
`;

const EDIT_SECTION = [
  "export function count(values: number[]) {",
  "  const total = values?.length ?? 0;",
  "  return Math.max(total, 0);",
  "}",
  "",
  'export const label = "review";',
].join("\n") + "\n";
const EDIT_TAIL = "\n".repeat(13) + [
  "export function format(value: number) {",
  "  return value.toFixed(2);",
  "  // Keep a separate hunk for navigation.",
  "}",
].join("\n") + "\n";
const EDIT_CONTENT = (EDIT_SECTION + EDIT_TAIL).replaceAll("\n", "\r\n");

function fixture() {
  return {
    editContent: EDIT_CONTENT, editPatch: null, editRevision: 1, editConflict: false, editWrites: [],
    changed: false, clean: false, cleanBeta: false, prompts: [], aborts: [], mutations: [], unknown: [],
    fileNames: [ALPHA, BETA],
    pauseExport: false, exportWaiters: [], onExportStarted: null,
  };
}

function sessionInfo() {
  return {
    id: SESSION_ID,
    path: join(cwd, "e2e-code-review.jsonl"),
    cwd,
    projectRoot: cwd,
    projectKey: cwd,
    branch: "main",
    name: "Code review fixture",
    created: TIMESTAMP,
    modified: TIMESTAMP,
    messageCount: 1,
    firstMessage: "Review fixture ready.",
  };
}

function sessionData() {
  return {
    sessionId: SESSION_ID,
    filePath: sessionInfo().path,
    totalActiveMs: 0,
    tree: [],
    treeFormat: "summary",
    leafId: null,
    snapshotRevision: "code-review-fixture",
    context: {
      messages: [{ role: "user", content: "Review fixture ready." }],
      entryIds: ["fixture-user"],
      oldestEntryId: "fixture-user",
      hasMore: false,
      turnsBefore: 0,
      thinkingLevel: "off",
      model: { provider: "test", modelId: "fixture" },
    },
  };
}

async function mockApi(context, state) {
  // Intercept every API call so this suite cannot start agents or change user data.
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const json = (body, status = HTTP_OK) => route.fulfill({ status, json: body });

    if (path.endsWith("/events") || url.searchParams.get("type") === "watch") {
      const connected = path.endsWith("/events") ? `data: ${JSON.stringify({ type: "connected", isStreaming: false })}\n\n` : "";
      await route.fulfill({ status: HTTP_OK, contentType: "text/event-stream", body: `retry: 60000\n\n${connected}` });
      return;
    }

    if (path.startsWith("/api/agent/") && method === "POST") {
      const command = request.postDataJSON() ?? {};
      if (["prompt", "steer", "follow_up"].includes(command.type) || path === "/api/agent/new") {
        state.prompts.push({ path, command });
      }
      if (command.type === "abort") {
        state.aborts.push(command);
      }
      const data = command.type === "get_tools" ? [] : { commands: [] };
      await json({ success: true, data });
      return;
    }

    if (path.startsWith("/api/files/") && url.searchParams.get("type") === "edit") {
      if (method === "PUT") {
        const body = request.postDataJSON();
        state.editWrites.push(body);
        if (state.editConflict || body.revision !== String(state.editRevision)) {
          await json({ error: "The file changed on disk. Copy your edits, then reopen the editor." }, HTTP_CONFLICT);
          return;
        }
        state.editContent = body.content;
        state.editRevision += 1;
        const expression = body.content.match(/Math.max\(total, \d+\)/)?.[0] ?? "Math.max(total, 0)";
        state.editPatch = ALPHA_PATCH.replace("Math.max(total, 0)", expression);
      }
      await json({ content: state.editContent, revision: String(state.editRevision) });
      return;
    }

    if (method !== "GET") {
      state.mutations.push({ path, method });
      const validatedCwd = state.freshComposer ? request.postDataJSON()?.cwd : cwd;
      await json(path === "/api/cwd/validate" ? { cwd: validatedCwd, valid: true, exists: true } : { success: true });
      return;
    }

    if (path === "/api/sessions") {
      await json({ sessions: [sessionInfo()], sessionListVersion: 1, runningSessionIds: [] });
      return;
    }
    if (path === "/api/sessions/ui-state") {
      await json({ state: { version: 1, revision: 0, sessions: {}, projects: {} } });
      return;
    }
    if (path === `/api/sessions/${SESSION_ID}/state` || path === `/api/agent/${SESSION_ID}`) {
      await json({ running: false, state: { isStreaming: false, isPromptRunning: false, model: { provider: "test", id: "fixture" } } });
      return;
    }
    if (path === `/api/sessions/${SESSION_ID}` || path.endsWith("/context")) {
      await json(sessionData());
      return;
    }
    if (path === "/api/agent/running") {
      await json({ sessionListVersion: 1, sessionUiStateRevision: 0, runningSessionIds: [], awaitingInputSessionIds: [] });
      return;
    }
    if (path === "/api/models") {
      await json({ models: { fixture: "Fixture" }, modelList: [{ provider: "test", id: "fixture", name: "Fixture" }], defaultModel: { provider: "test", modelId: "fixture" } });
      return;
    }
    if (path === "/api/git/status") {
      await json({
        isGitRepository: true,
        repositoryRoot: cwd,
        files: state.fileNames.map((name) => ({ filePath: join(cwd, name), status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" })),
        additions: 5,
        deletions: 4,
      });
      return;
    }
    if (path === "/api/git/diff") {
      const alpha = url.searchParams.get("path") === join(cwd, ALPHA);
      const patch = state.editPatch ?? (state.changed ? ALPHA_PATCH.replace("Math.max(total, 0)", "Math.max(total, 1)") : ALPHA_PATCH);
      const clean = alpha ? state.clean : state.cleanBeta;
      const diff = clean ? { supported: false }
        : { supported: true, status: state.syntaxDeleted ? "deleted" : "modified", patch: alpha ? patch : state.syntaxPatch ?? BETA_PATCH };
      if (state.pauseExport) {
        state.exportWaiters.push(() => json(diff));
        state.onExportStarted?.();
        return;
      }
      await json(diff);
      return;
    }
    if (path.startsWith("/api/files/")) {
      if (url.searchParams.get("type") === "list") {
        const names = state.syntaxFile ? [ALPHA, BETA, state.syntaxFile] : [ALPHA, BETA];
        await json({ entries: names.map((name) => ({ name, isDir: false, size: 200, modified: TIMESTAMP })) });
        return;
      }
      if (state.syntaxDeleted) {
        await json({ error: "File not found" }, HTTP_NOT_FOUND);
        return;
      }
      await json({ content: state.editContent, language: state.syntaxLanguage ?? "typescript", size: 34, nextOffset: 0, truncated: false });
      return;
    }
    if (path === "/api/worktrees") {
      await json({ projectRoot: cwd, projectKey: cwd, isGit: true, isTopLevel: true, currentWorktreePath: cwd, worktrees: [{ path: cwd, branch: "main", isMain: true }] });
      return;
    }
    if (path === "/api/home") {
      await json({ home: "/Users/cdrage" });
      return;
    }
    if (path === "/api/skills") {
      await json({ skills: [] });
      return;
    }
    if (path === "/api/open-in-explorer") {
      await json({ available: false });
      return;
    }
    if (path === "/api/app-update") {
      await json({ current: "0.12.1", latest: "0.12.1", updateAvailable: false });
      return;
    }
    if (path === "/api/project-trust") {
      await json({ trusted: true, servers: [] });
      return;
    }

    state.unknown.push(path);
    await json({});
  });
}

function review(page) {
  return page.locator(".diff-review");
}

function button(page, name) {
  return review(page).getByRole("button", { name, exact: true });
}

function gutter(page, side, line) {
  return review(page).getByRole("button", { name: `Select line ${line}`, exact: true })
    .and(review(page).locator(`[data-review-side="${side}"]`));
}

async function openFile(page, name, clean = false, signature) {
  const hide = page.locator("#file-panel").getByRole("button", { name: "Hide file panel", exact: true });
  if (page.viewportSize().width <= MOBILE_MAX_WIDTH && await hide.count()) {
    await hide.press("Enter");
  }
  // Wait for session hydration before the mobile sidebar chooses its initial state.
  await page.getByText("Review fixture ready.", { exact: true }).first().waitFor();
  const show = page.getByRole("button", { name: "Show sidebar", exact: true });
  if (await show.isVisible()) {
    await show.click();
  }
  await showSidebarFiles(page);
  const changes = page.getByRole("button", { name: "2 changed files", exact: true });
  if (await changes.getAttribute("aria-pressed") !== "true") {
    await changes.click();
  }
  await page.locator("#session-sidebar-panel-files").getByTitle(join(cwd, name), { exact: true }).first().click();
  await review(page).waitFor();
  await fileReady(page, name, clean, signature);
  await page.locator("#file-panel").evaluate((element) => Promise.all(
    element.getAnimations().map((animation) => animation.finished.catch(() => {}))));
}

async function fileReady(page, name, clean = false, signature = name === ALPHA ? "export function count" : "export function title") {
  if (clean) {
    await review(page).getByText("No current changes.", { exact: true }).waitFor();
    return;
  }
  await review(page).locator("code").filter({ hasText: signature }).first().waitFor();
}

async function checkFileNavigation(page, state) {
  const navigation = review(page).locator(".diff-review-navigation");
  const previous = button(page, "Previous changed file");
  const next = button(page, "Next changed file");
  await navigation.getByText("1 / 2", { exact: true }).waitFor();
  assert.equal(await previous.isDisabled(), true, "The first file has no previous file");
  assert.equal(await next.getAttribute("title"), BETA);

  await next.press("Enter");
  await fileReady(page, BETA);
  await navigation.getByText("2 / 2", { exact: true }).waitFor();
  assert.equal(await next.isDisabled(), true, "The last file has no next file");
  assert.equal(await page.locator(".file-viewer-mode-button").getByText("Diff", { exact: true }).getAttribute("aria-pressed"), "true");
  await previous.click();
  await fileReady(page, ALPHA);

  // Focus refreshes must update the boundaries when files leave the list.
  state.fileNames = [ALPHA];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await navigation.getByText("1 / 1", { exact: true }).waitFor();
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await next.isDisabled(), true);

  state.fileNames = [];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await navigation.and(review(page).getByRole("group", { name: "0 changed files", exact: true })).waitFor();
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await next.isDisabled(), true);
  assert.equal(await navigation.locator("span").count(), 0, "An absent file has no list position");

  state.fileNames = [ALPHA, BETA];
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await navigation.getByText("1 / 2", { exact: true }).waitFor();
  assert.equal(await next.isEnabled(), true);
  assert.equal(await page.locator(".chat-input-textarea").inputValue(), ORIGINAL_DRAFT, "File navigation preserves the chat draft");
}

async function commentCount(page, count) {
  if (!count) {
    await review(page).getByRole("button", { name: /^Comments \(/ }).waitFor({ state: "hidden" });
    return;
  }
  await button(page, `Comments (${count})`).waitFor();
}

async function saveComment(page, text) {
  await page.getByRole("textbox", { name: "Review comment", exact: true }).fill(text);
  await button(page, "Save comment").click();
  await page.getByRole("textbox", { name: "Review comment", exact: true }).waitFor({ state: "hidden" });
}

async function summary(page, count) {
  const toggle = button(page, `Comments (${count})`);
  if (await toggle.getAttribute("aria-expanded") !== "true") {
    await toggle.click();
  }
  return review(page).locator(".diff-review-list");
}

async function closeSummary(page, count) {
  if (!count) {
    await review(page).locator(".diff-review-list").waitFor({ state: "hidden" });
    return;
  }
  const toggle = button(page, `Comments (${count})`);
  if (await toggle.getAttribute("aria-expanded") === "true") {
    await toggle.click();
  }
}

async function editDelete(page, text, count) {
  const list = await summary(page, count);
  const card = list.locator("[data-review-comment]").filter({ hasText: text });
  await card.getByRole("button", { name: "Edit comment", exact: true }).click();
  const changed = `${text} Revised.`;
  await saveComment(page, changed);
  await card.getByText(changed, { exact: true }).waitFor();
  await card.getByRole("button", { name: "Delete comment", exact: true }).click();
  await commentCount(page, count - 1);
  await closeSummary(page, count - 1);
}

async function selectionState(page) {
  return review(page).evaluate((element) => ({
    cursor: element.querySelector('[data-review-cursor="true"]')?.getAttribute("data-review-index"),
    selected: [...element.querySelectorAll('[data-review-selected="true"]')].map((row) => row.getAttribute("data-review-index")),
  }));
}

async function checkUnboundKeys(page) {
  // Removed bindings must leave the selection and browser key behavior intact.
  await gutter(page, "new", 2).click();
  await button(page, "Cancel").click();
  const selected = await selectionState(page);
  await page.evaluate(() => {
    window.reviewUnhandledKeys = [];
    window.reviewClipboardWrites = 0;
    document.addEventListener("keydown", (event) => {
      if (event.target instanceof Element && event.target.closest(".diff-review")) {
        queueMicrotask(() => window.reviewUnhandledKeys.push({ key: event.key, ctrl: event.ctrlKey, prevented: event.defaultPrevented }));
      }
    }, true);
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      window.reviewOriginalWrite = clipboard.writeText;
      clipboard.writeText = function (...args) {
        window.reviewClipboardWrites += 1;
        return window.reviewOriginalWrite.apply(this, args);
      };
    }
  });

  try {
    for (const key of UNBOUND_REVIEW_KEYS) {
      await review(page).press(key);
    }
    await page.evaluate(() => new Promise(requestAnimationFrame));
    const events = await page.evaluate(() => window.reviewUnhandledKeys.filter((event) => !["Control", "Shift"].includes(event.key)));
    assert.equal(events.length, UNBOUND_REVIEW_KEYS.length, "Every removed binding must reach the review");
    assert.ok(events.every((event) => !event.prevented), "Removed bindings must not prevent browser key behavior");
    assert.deepEqual(await selectionState(page), selected, "Removed bindings must not change the review selection or cursor");
    assert.equal(await page.getByRole("textbox", { name: "Review comment", exact: true }).count(), 0);
    assert.equal(await review(page).locator(".diff-review-help, .diff-review-search").count(), 0);
    assert.equal(await page.evaluate(() => window.reviewClipboardWrites), 0, "Removed bindings must not export to the clipboard");
    await fileReady(page, ALPHA);
  } finally {
    await page.evaluate(() => {
      if (window.reviewOriginalWrite) {
        navigator.clipboard.writeText = window.reviewOriginalWrite;
      }
    });
  }
}

async function checkSubmitStyle(page, count) {
  const submit = button(page, "Add to chat").and(review(page).locator(".diff-review-submit"));
  await submit.waitFor();
  await page.waitForFunction(() => document.querySelector(".diff-review-submit")?.disabled === false);
  const colors = await submit.evaluate((element) => {
    const sample = document.createElement("span");
    element.appendChild(sample);
    sample.style.backgroundColor = "var(--accent)";
    const accent = getComputedStyle(sample).backgroundColor;
    sample.style.backgroundColor = "var(--accent-hover)";
    const hover = getComputedStyle(sample).backgroundColor;
    sample.style.color = "var(--accent-contrast)";
    const contrast = getComputedStyle(sample).color;
    const style = getComputedStyle(element);
    const result = { accent, hover, contrast, background: style.backgroundColor, text: style.color };
    sample.remove();
    return result;
  });
  assert.ok([colors.accent, colors.hover].includes(colors.background), "The submit action must use the accent background");
  assert.equal(colors.text, colors.contrast, "The submit action must use the accent contrast color");
  await commentCount(page, count);
  assert.equal(await submit.textContent(), "Add to chat", "The primary action must keep its label short");
}

async function checkReviewToolbar(page, count) {
  const toolbar = review(page).getByRole("toolbar", { name: "Code review", exact: true });
  const tools = toolbar.locator(".diff-review-tools");
  const names = await tools.getByRole("button").evaluateAll((buttons) => buttons.map((button) =>
    button.getAttribute("aria-label") ?? button.textContent.trim()));
  assert.deepEqual(names, count
    ? ["Comment on file", `Comments (${count})`, "Add to chat", "Add to chat & send", "Search this diff"]
    : ["Comment on file", "Search this diff"], "The toolbar must expose only relevant actions");
  const bounds = await tools.getByRole("button").evaluateAll((buttons) => buttons.map((button) => {
    const { top, left, right, bottom } = button.getBoundingClientRect();
    return { top, left, right, bottom };
  }));
  const firstRow = bounds.filter((_, index) => names[index] !== "Add to chat & send");
  assert.ok(firstRow.every((bound) => bound.top === firstRow[0].top), "The existing toolbar actions must fit on one row");
  const { width } = await toolbar.boundingBox();
  assert.ok(Math.max(...bounds.map(({ right }) => right)) - bounds[0].left <= width, "The toolbar must stay inside its panel");
}

async function addLineComment(page) {
  const editor = review(page).getByRole("textbox", { name: "Review comment", exact: true });
  await editor.waitFor();
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true,
    "A line number click must focus the comment box without another action");
}

async function checkSuccessStyle(page) {
  const notice = review(page).getByRole("status").and(review(page).locator(".diff-review-success"))
    .filter({ hasText: "Review added to the chat draft." });
  await notice.waitFor();
  const indicator = await notice.evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.borderLeftColor, width: parseFloat(style.borderLeftWidth), style: style.borderLeftStyle };
  });
  const [red, green, blue] = indicator.color.match(/\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  assert.ok(green > red && green > blue, "The successful handoff must display a green indicator");
  assert.ok(indicator.width > 0 && indicator.style === "solid", "The success indicator must be visible");
}

function checkCompactExport(text) {
  const header = text.indexOf(REVIEW_HEADER);
  assert.ok(header >= 0, "The export must use the compact review header");
  const prompt = text.slice(header);
  const items = [
    `1. \`${ALPHA}:2-3\` [OLD] - ${OLD_COMMENT}`,
    `2. \`${ALPHA}:2\` - ${NEW_COMMENT}`,
    `3. \`${BETA}\` - ${FILE_COMMENT}`,
  ];
  for (const item of items) {
    assert.ok(prompt.includes(item), `The compact export must contain ${item}`);
  }
  assert.equal(prompt.split("\n").filter((line) => /^\d+\. /.test(line)).length, items.length);
  assert.ok(prompt.includes([
    "   ```diff",
    "   -  const total = values.length;",
    "   -  return total;",
    "   ```",
  ].join("\n")), "Comments on removed lines must include the deleted code");
  assert.equal(prompt.split("```diff").length - 1, 1, "Only the deleted selection needs captured code");
  assert.doesNotMatch(prompt, /Worktree:|old lines|new lines|File:|File comment|Captured diff:|Comment:/i,
    "Review exports must omit verbose metadata");
}

async function checkReview(page, state, label) {
  await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
  await page.getByText("Review fixture ready.", { exact: true }).first().waitFor();
  const composer = page.locator(".chat-input-textarea");
  await composer.fill(ORIGINAL_DRAFT);
  await openFile(page, ALPHA);
  await checkFileNavigation(page, state);
  await checkReviewToolbar(page, 0);
  await page.screenshot({ path: join(artifacts, `${label}-empty.png`), fullPage: true });

  // Mouse ranges exercise new-side anchors and the complete comment lifecycle.
  await gutter(page, "new", 2).click();
  const rangeEditor = page.getByRole("textbox", { name: "Review comment", exact: true });
  await addLineComment(page);
  await rangeEditor.fill("Keep this range draft.");
  await gutter(page, "new", 3).click({ modifiers: ["Shift"] });
  assert.equal(await rangeEditor.inputValue(), "Keep this range draft.", "Shift-click must preserve the comment draft");
  await review(page).locator(".diff-review-card-actions").getByText("2 lines", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, `${label}-selection.png`), fullPage: true });
  await addLineComment(page);
  await saveComment(page, "Review the replacement range.");
  await commentCount(page, 1);
  await review(page).getByText(/New lines 2-3/).first().waitFor();
  await editDelete(page, "Review the replacement range.", 1);

  // Removed lines retain old-side anchors through a mouse range.
  await gutter(page, "old", 2).click();
  await gutter(page, "old", 3).click({ modifiers: ["Shift"] });
  await addLineComment(page);
  await saveComment(page, OLD_COMMENT);
  await review(page).getByText(/Old lines 2-3/).first().waitFor();
  await commentCount(page, 1);

  await gutter(page, "new", 2).press("Enter");
  await addLineComment(page);
  const editor = page.getByRole("textbox", { name: "Review comment", exact: true });
  await editor.fill("Text: ");
  await editor.press("j");
  await editor.press("k");
  await editor.press("v");
  await editor.press("c");
  assert.equal(await editor.inputValue(), "Text: jkvc", "Ordinary characters remain text inside the comment editor");
  await saveComment(page, NEW_COMMENT);
  await commentCount(page, 2);

  await gutter(page, "new", 2).click();
  await addLineComment(page);
  await editor.fill("Discard this unsaved comment.");
  await button(page, "Cancel").click();
  await commentCount(page, 2);
  await checkUnboundKeys(page);

  await button(page, "Search this diff").click();
  const search = review(page).getByRole("textbox", { name: "Search this diff", exact: true });
  await search.fill("export function format");
  await search.press("Enter");
  await review(page).locator('[data-review-cursor="true"]').getByText("export function format", { exact: false }).waitFor();
  await search.press("Escape");
  await search.waitFor({ state: "hidden" });

  // A local Escape handler must consume the key before global abort shortcuts.
  await page.evaluate(() => {
    window.reviewEscapePrevented = false;
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        queueMicrotask(() => { window.reviewEscapePrevented = event.defaultPrevented; });
      }
    }, true);
  });
  await gutter(page, "new", 2).click();
  await review(page).press("Escape");
  assert.equal(await page.evaluate(() => window.reviewEscapePrevented), true, "Review Escape consumes the local selection");
  assert.equal(state.aborts.length, 0, "Review Escape must not abort the agent");

  await openFile(page, BETA);
  await button(page, "Comment on file").click();
  await saveComment(page, "Temporary file comment.");
  await editDelete(page, "Temporary file comment.", 3);
  await button(page, "Comment on file").click();
  await saveComment(page, FILE_COMMENT);
  await commentCount(page, 3);
  await openFile(page, ALPHA);
  await commentCount(page, 3);

  // Browser storage must survive file switches and a full page reload.
  await page.reload({ waitUntil: "domcontentloaded" });
  const hidePanel = page.locator("#file-panel").getByRole("button", { name: "Hide file panel", exact: true });
  if (await hidePanel.count() && await hidePanel.getAttribute("aria-expanded") === "true") {
    await hidePanel.press("Enter");
  }
  await composer.fill(ORIGINAL_DRAFT);
  await openFile(page, BETA);
  await commentCount(page, 3);
  const list = await summary(page, 3);
  for (const text of [OLD_COMMENT, NEW_COMMENT, FILE_COMMENT]) {
    await list.getByText(text, { exact: true }).waitFor();
  }
  await closeSummary(page, 3);
  await checkSubmitStyle(page, 3);
  await checkReviewToolbar(page, 3);
  await review(page).evaluate((element, width) => { element.style.width = `${width}px`; }, MIN_REVIEW_WIDTH);
  await checkReviewToolbar(page, 3);
  await review(page).evaluate((element) => { element.style.removeProperty("width"); });

  await summary(page, 3);
  await button(page, "Copy review").click();
  await review(page).getByRole("status").filter({ hasText: "Review copied." }).waitFor();
  const clipboard = await page.evaluate(() => navigator.clipboard?.readText().catch(() => null));
  if (typeof clipboard === "string") {
    for (const text of [ALPHA, BETA, OLD_COMMENT, NEW_COMMENT, FILE_COMMENT]) {
      assert.ok(clipboard.includes(text), `Clipboard export contains ${text}`);
    }
    checkCompactExport(clipboard);
  }

  await closeSummary(page, 3);
  await button(page, "Add to chat").click();
  await page.waitForFunction((text) => document.querySelector(".chat-input-textarea")?.value.includes(text), FILE_COMMENT);
  const draft = await composer.inputValue();
  for (const text of [ORIGINAL_DRAFT, ALPHA, BETA, OLD_COMMENT, NEW_COMMENT, FILE_COMMENT]) {
    assert.ok(draft.includes(text), `Composer export contains ${text}`);
  }
  checkCompactExport(draft);
  if (page.viewportSize().width > MOBILE_MAX_WIDTH) {
    await checkSuccessStyle(page);
  }
  assert.equal(state.prompts.length, 0, "Review export must not send an agent prompt");

  // A patch change must discard its comments and close the obsolete editor.
  await openFile(page, ALPHA);
  await gutter(page, "new", 2).click();
  await addLineComment(page);
  const pendingComment = "Discard this unfinished review comment after an update.";
  await editor.fill(pendingComment);
  state.changed = true;
  await page.evaluate(() => {
    for (const source of window.reviewSources) {
      source.dispatchEvent(new Event("change"));
    }
  });
  await review(page).locator("code").filter({ hasText: "Math.max(total, 1)" }).waitFor();
  await editor.waitFor({ state: "hidden" });
  await commentCount(page, 1);
  const current = await summary(page, 1);
  await current.getByText(FILE_COMMENT, { exact: true }).waitFor();
  assert.equal(await current.getByText(OLD_COMMENT, { exact: true }).count(), 0);
  assert.equal(await current.getByText(NEW_COMMENT, { exact: true }).count(), 0);
  await closeSummary(page, 1);
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, ALPHA);
  await commentCount(page, 1);
  await page.screenshot({ path: join(artifacts, `${label}.png`), fullPage: true });

  // A file that becomes clean must lose its comments too.
  await button(page, "Comment on file").click();
  const updatedComment = "Review the updated file.";
  await saveComment(page, updatedComment);
  await commentCount(page, 2);
  state.clean = true;
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, ALPHA, true);
  await commentCount(page, 1);
  const remaining = await summary(page, 1);
  await remaining.getByText(FILE_COMMENT, { exact: true }).waitFor();
  assert.equal(await remaining.getByText(updatedComment, { exact: true }).count(), 0);
  await closeSummary(page, 1);

  // An export that finishes after a session switch must preserve the new draft.
  state.pauseExport = true;
  const started = new Promise((resolve) => { state.onExportStarted = resolve; });
  const responses = [BETA].map((name) => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/git/diff" && url.searchParams.get("path") === join(cwd, name);
  }).catch(() => null));
  await button(page, "Add to chat").click();
  await started;
  await page.keyboard.press("Control+Alt+n");
  await page.waitForURL((url) => !url.searchParams.has("session"));
  if (await hidePanel.count() && await hidePanel.getAttribute("aria-expanded") === "true") {
    await hidePanel.press("Enter");
  }
  const nextDraft = "Keep the new chat draft.";
  await composer.fill(nextDraft);
  state.pauseExport = false;
  await Promise.all(state.exportWaiters.splice(0).map((fulfill) => fulfill()));
  await Promise.all(responses.map(async (pending) => {
    const response = await pending;
    assert.ok(response, "The export request must complete");
    await response.finished();
  }));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await composer.inputValue(), nextDraft, "A late export must not enter another composer");
  assert.equal(state.prompts.length, 0);

  // Clear affects the local review and must restore the quiet toolbar.
  await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
  await composer.fill(nextDraft);
  await openFile(page, ALPHA, true);
  await summary(page, 1);
  page.once("dialog", (dialog) => {
    assert.equal(dialog.message(), "Clear all review comments?");
    void dialog.accept();
  });
  await button(page, "Clear comments").click();
  await commentCount(page, 0);
  await review(page).locator(".diff-review-list").waitFor({ state: "hidden" });
  await checkReviewToolbar(page, 0);
  assert.equal(await composer.inputValue(), nextDraft, "Clear must preserve the chat draft");
  console.log(`PASS: ${label}: mouse ranges, comments, unbound keys, persistence, obsolete comment cleanup, and composer export`);
}

async function checkFileEditing(page, state, label) {
  await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
  await openFile(page, ALPHA);
  const panel = page.locator("#file-panel");
  assert.equal(await review(page).locator(".diff-review-editable").count(), 0, "Diff must be read-only");
  const sourceMode = panel.getByRole("button", { name: "Source", exact: true });
  const diffMode = panel.getByRole("button", { name: "Diff", exact: true });
  const sourceLine = () => panel.locator('.file-source-line[data-line-number="3"] .file-source-line-content');
  const edit = async () => {
    if (await sourceMode.getAttribute("aria-pressed") !== "true") {
      await sourceMode.click();
    }
    await sourceLine().click();
  };
  const editor = panel.getByRole("textbox", { name: "File content", exact: true });
  const save = panel.getByRole("button", { name: "Save", exact: true });
  const back = panel.getByRole("button", { name: "Close editor", exact: true });
  const dialog = page.getByRole("dialog", { name: "Save changes?", exact: true });
  const close = () => panel.getByRole("button", { name: `Close ${ALPHA}`, exact: true });
  const unsaved = () => page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });

  await edit();
  await editor.waitFor();
  assert.equal(await editor.evaluate((element) => Boolean(element.closest(".source-editor"))), true,
    "The editor must live in Source");
  const original = EDIT_CONTENT.replaceAll("\r\n", "\n");
  assert.equal(await editor.inputValue(), original);
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true);
  assert.equal(await editor.evaluate((element) => element.selectionStart), original.indexOf("  return"));
  await panel.locator(".source-editor-highlight .token").filter({ hasText: "export" }).first().waitFor();
  await panel.locator(".source-editor-highlight .token.builtin").filter({ hasText: "number" }).first().waitFor();
  const metrics = await panel.locator(".source-editor").evaluate((root) => {
    const input = root.querySelector("textarea");
    const layer = root.querySelector(".source-editor-highlight");
    const properties = ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "tabSize", "letterSpacing"];
    const font = (element) => properties.map((property) => getComputedStyle(element)[property]);
    return { input: font(input), layer: font(layer), inputX: input.getBoundingClientRect().x, layerX: layer.getBoundingClientRect().x };
  });
  assert.deepEqual(metrics.layer, metrics.input, "Colored text must share the caret's font metrics");
  assert.equal(metrics.layerX, metrics.inputX, "Colored text must start at the caret's left edge");
  assert.equal(await save.isDisabled(), true);
  assert.equal(await unsaved(), false);
  await checkEditorWrap(page, panel, editor, original, label);
  const draft = original.replace("Math.max(total, 0)", "Math.max(total, 2)");
  await editor.fill(draft);
  await panel.locator(".source-editor-highlight .token").filter({ hasText: "2" }).first().waitFor();
  await panel.getByRole("tab", { name: ALPHA, exact: true }).getByLabel("Unsaved changes", { exact: true }).waitFor();
  assert.equal(await unsaved(), true, "Dirty drafts register the browser navigation guard");

  // A live update and a tab switch must preserve the local draft.
  await page.evaluate(() => {
    for (const source of window.reviewSources) {
      source.dispatchEvent(new Event("change"));
    }
  });
  assert.equal(await editor.inputValue(), draft);
  await openFile(page, BETA);
  await panel.getByRole("tab", { name: ALPHA, exact: true }).click();
  await editor.waitFor();
  assert.equal(await editor.inputValue(), draft);

  await page.screenshot({ path: join(artifacts, `${label}-file-editor.png`), fullPage: true });
  await diffMode.click();
  await dialog.waitFor();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await sourceMode.getAttribute("aria-pressed"), "true", "Cancel must retain Source and its draft");
  await close().click();
  await dialog.waitFor();
  const bounds = await dialog.boundingBox();
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - page.viewportSize().width / 2) < 1, "The close dialog must be centered");
  await page.screenshot({ path: join(artifacts, `${label}-unsaved-dialog.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await editor.inputValue(), draft);
  await back.click();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(state.aborts.length, 0, "The unsaved dialog must consume Escape");

  // Save errors preserve the dialog and draft until the user makes another choice.
  state.editConflict = true;
  await close().click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await dialog.getByRole("alert").filter({ hasText: "The file changed on disk." }).waitFor();
  assert.equal(await editor.inputValue(), draft);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  state.editConflict = false;
  await editor.press("Control+s");
  await editor.waitFor({ state: "hidden" });
  assert.equal(state.editContent, draft.replaceAll("\n", "\r\n"), "Save preserves CRLF and the rest of the file");
  assert.equal(await unsaved(), false);
  await sourceLine().filter({ hasText: "Math.max(total, 2)" }).waitFor();
  await diffMode.click();
  await review(page).locator("code").filter({ hasText: "Math.max(total, 2)" }).waitFor();

  await edit();
  const nextDraft = draft.replace("Math.max(total, 2)", "Math.max(total, 3)");
  await editor.fill(nextDraft);
  await close().click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await panel.getByRole("tab", { name: ALPHA, exact: true }).waitFor({ state: "hidden" });
  assert.equal(state.editContent, nextDraft.replaceAll("\n", "\r\n"));

  await openFile(page, ALPHA);
  await edit();
  await editor.fill("discard this draft");
  const writes = state.editWrites.length;
  await close().click();
  await dialog.getByRole("button", { name: "Discard", exact: true }).click();
  await panel.getByRole("tab", { name: ALPHA, exact: true }).waitFor({ state: "hidden" });
  assert.equal(state.editWrites.length, writes, "Discard must not write the file");
  assert.equal(await unsaved(), false);

  // A clean editor returns to the Source view without a close dialog.
  await openFile(page, ALPHA);
  await edit();
  await editor.waitFor();
  await back.click();
  await sourceLine().waitFor();
  assert.equal(await dialog.count(), 0);

  // Source and the editor share the tab's wrap preference.
  await panel.getByRole("button", { name: "Enable word wrap", exact: true }).click();
  await edit();
  await editor.waitFor();
  assert.equal(await editor.getAttribute("wrap"), "soft");
  await back.click();
  const disableWrap = panel.getByRole("button", { name: "Disable word wrap", exact: true });
  assert.equal(await disableWrap.getAttribute("aria-pressed"), "true");
  await disableWrap.click();
  await page.screenshot({ path: join(artifacts, `${label}-file-edit.png`), fullPage: true });
  console.log(`PASS: ${label}: Source-only edits, save shortcut, CRLF, draft retention, save conflicts, and guarded close`);
}

async function checkEditorWrap(page, panel, editor, original, label) {
  const enable = panel.getByRole("button", { name: "Enable word wrap", exact: true });
  const disable = panel.getByRole("button", { name: "Disable word wrap", exact: true });
  assert.equal(await enable.count(), 1, "The editor must retain the Source wrap button");

  for (const name of ["Save", "Close editor"]) {
    const action = panel.getByRole("button", { name, exact: true });
    assert.equal(await action.locator("svg").count(), 1, `${name} must use a toolbar icon`);
    assert.equal(await action.textContent(), "", `${name} keeps its label accessible without visible text`);
  }

  const longLine = `\tconst message = "${"words and spaces ".repeat(30)}${"x".repeat(150)}";`;
  const content = `${longLine}\n\n${longLine}\nreturn message;\n`;
  await editor.fill(content);
  await enable.click();
  assert.equal(await disable.getAttribute("aria-pressed"), "true");
  assert.equal(await editor.getAttribute("wrap"), "soft");
  assert.equal(await editor.inputValue(), content, "Soft wrap must preserve the file text");

  const layout = () => panel.locator(".source-editor").evaluate((root) => {
    const input = root.querySelector("textarea");
    const highlight = root.querySelector(".source-editor-highlight");
    const rows = [...root.querySelectorAll(".source-editor-line")];
    const numbers = [...root.querySelector(".source-editor-gutter").children];
    const bounds = (element) => element.getBoundingClientRect();
    return {
      overflow: input.scrollWidth - input.clientWidth,
      clipped: input.scrollHeight - input.clientHeight,
      heights: rows.map((row) => bounds(row).height),
      offsets: rows.map((row, index) => bounds(row).y - bounds(numbers[index]).y),
      layerOffset: bounds(input).y - bounds(highlight).y,
    };
  });
  const checkLayout = async () => {
    await page.waitForFunction(() => {
      const root = document.querySelector(".source-editor");
      const rows = [...root.querySelectorAll(".source-editor-line")];
      const numbers = [...root.querySelector(".source-editor-gutter").children];
      return rows.length === numbers.length && rows.every((row, index) =>
        Math.abs(row.getBoundingClientRect().y - numbers[index].getBoundingClientRect().y) < 1);
    });
    const metrics = await layout();
    assert.ok(metrics.overflow <= 1, "Wrapped input must fit the available width");
    assert.ok(metrics.clipped <= 1, "Wrapped input must expose every visual line");
    assert.equal(metrics.layerOffset, 0, "The input and colors must share their first line");
    assert.ok(metrics.heights[0] > metrics.heights[1], "Long lines must wrap above empty lines");
    assert.ok(metrics.offsets.every((offset) => Math.abs(offset) < 1), "Line numbers must follow wrapped rows");
  };
  await checkLayout();

  // A panel resize must update the wrapped gutter without an edit.
  await panel.locator(".file-viewer-content").evaluate((element) => { element.style.width = "75%"; });
  await checkLayout();
  await panel.locator(".file-viewer-content").evaluate((element) => { element.style.width = ""; });
  await checkLayout();
  await page.screenshot({ path: join(artifacts, `${label}-editor-wrap.png`), fullPage: true });

  await disable.click();
  assert.equal(await editor.getAttribute("wrap"), "off");
  assert.equal(await editor.inputValue(), content);
  await editor.fill(original);
  console.log(`PASS: ${label}: editor icon actions, word wrap, gutter alignment, and resize`);
}

async function checkSourceSyntax(page, state, label) {
  const samples = [
    { name: "review-component.svelte", language: "markup", text: '<script lang="ts">\n  let count: number = 1;\n</script>\n{#if count}<p>{count}</p>{/if}\n', token: "number" },
    { name: "review-script.py", language: "python", text: 'def title():\n\treturn "hello"\n', token: "return" },
    { name: "review-config.json", language: "json", text: '{\n  "title": "hello"\n}\n', token: '"title"' },
  ];
  const panel = page.locator("#file-panel");
  const editor = panel.getByRole("textbox", { name: "File content", exact: true });
  for (const sample of samples) {
    state.syntaxFile = sample.name;
    state.syntaxLanguage = sample.language;
    state.fileNames = [ALPHA, sample.name];
    state.editContent = sample.text;
    await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
    await openFile(page, sample.name);
    await panel.getByRole("button", { name: "Source", exact: true }).click();
    await panel.locator('.file-source-line[data-line-number="2"] .file-source-line-content').click();
    await editor.waitFor();
    const tokens = panel.locator(".source-editor-highlight .token");
    await tokens.filter({ hasText: sample.token }).first().waitFor();
    const draft = sample.text.replace("1", "2").replace("hello", "world");
    await editor.fill(draft);
    assert.equal(await editor.inputValue(), draft);
    await page.waitForFunction((text) => document.querySelector(".source-editor-highlight")?.textContent === `${text}\n`, draft);
    await page.screenshot({ path: join(artifacts, `${label}-${sample.language}-editor.png`), fullPage: true });
    await editor.press("Control+s");
    await editor.waitFor({ state: "hidden" });
    assert.equal(state.editContent, draft, `${sample.language} saves its exact text`);
  }
  delete state.syntaxFile;
  delete state.syntaxLanguage;
  state.fileNames = [ALPHA, BETA];
  console.log(`PASS: ${label}: Svelte, Python, and JSON colors update with edits and preserve saved text`);
}

async function checkSendReview(page, state, label) {
  await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
  await openFile(page, BETA);
  await button(page, "Comment on file").click();
  await saveComment(page, FILE_COMMENT);
  const composer = page.locator(".chat-input-textarea");
  await composer.fill(ORIGINAL_DRAFT);
  const [sent] = await Promise.all([
    page.waitForResponse((response) => response.request().method() === "POST"
      && new URL(response.url()).pathname === `/api/agent/${SESSION_ID}`
      && response.request().postDataJSON()?.type === "prompt"),
    button(page, "Add to chat & send").click(),
  ]);
  const command = sent.request().postDataJSON();
  assert.equal(state.prompts.length, 1, "The send action must submit exactly one prompt");
  assert.ok(command.message.includes(ORIGINAL_DRAFT), "The send action must include the existing draft");
  assert.ok(command.message.includes(`${REVIEW_HEADER}\n\n1. \`${BETA}\` - ${FILE_COMMENT}`));
  await page.waitForFunction(() => document.querySelector(".chat-input-textarea")?.value === "");

  // A delayed send must never submit to a different chat.
  await page.reload({ waitUntil: "domcontentloaded" });
  await openFile(page, BETA);
  await commentCount(page, 1);
  state.pauseExport = true;
  const started = new Promise((resolve) => { state.onExportStarted = resolve; });
  await button(page, "Add to chat & send").click();
  await started;
  await page.keyboard.press("Control+Alt+n");
  await page.waitForURL((url) => !url.searchParams.has("session"));
  const nextDraft = "Preserve the destination draft.";
  const hide = page.locator("#file-panel").getByRole("button", { name: "Hide file panel", exact: true });
  if (await hide.count() && await hide.getAttribute("aria-expanded") === "true") {
    await hide.press("Enter");
  }
  await composer.fill(nextDraft);
  state.pauseExport = false;
  await Promise.all(state.exportWaiters.splice(0).map((fulfill) => fulfill()));
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal(await composer.inputValue(), nextDraft);
  assert.equal(state.prompts.length, 1, "A delayed export must not submit to another chat");

  // If every comment expires during export, preserve the draft without a send.
  await page.goto(`${base}/?session=${SESSION_ID}`, { waitUntil: "domcontentloaded" });
  await openFile(page, BETA);
  await commentCount(page, 1);
  await composer.fill(nextDraft);
  state.cleanBeta = true;
  await button(page, "Add to chat & send").click();
  await review(page).getByRole("alert").filter({ hasText: "No current review comments remain." }).waitFor();
  await commentCount(page, 0);
  assert.equal(await composer.inputValue(), nextDraft);
  assert.equal(state.prompts.length, 1, "An empty export must not submit the existing draft");
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key)),
    `${REVIEW_STORAGE_PREFIX}${encodeURIComponent(cwd)}`);
  assert.deepEqual(saved.state.comments, [], "Obsolete comments must leave browser storage");
  console.log(`PASS: ${label}: immediate send, draft preservation, destination guard, and empty export guard`);
}

async function checkReviewWrap(page, state, label) {
  const longLine = `export const label = "${"long/path/".repeat(80)}";`;
  state.editPatch = ALPHA_PATCH.replace('export const label = "review";', longLine);
  await page.goto(`${base}/?session=${SESSION_ID}`);
  await openFile(page, ALPHA);
  const panel = page.locator("#file-panel");
  const enable = panel.getByRole("button", { name: "Enable word wrap", exact: true });
  assert.equal(await enable.count(), 1, "Diff must expose the word wrap button");
  await enable.click();
  const line = review(page).locator("code").filter({ hasText: longLine });
  await page.waitForFunction(() => {
    const code = document.querySelector(".diff-review-code");
    return code && code.scrollWidth <= code.clientWidth + 1;
  });
  const heights = await line.evaluate((element) => ({
    code: element.getBoundingClientRect().height,
    gutter: element.parentElement.querySelector(".diff-review-gutter").getBoundingClientRect().height,
    single: parseFloat(getComputedStyle(element).lineHeight),
  }));
  assert.ok(heights.code > heights.single * 2, "Long code must wrap across rows");
  assert.equal(heights.code, heights.gutter, "The gutter spans the wrapped line");
  assert.equal(await line.textContent(), longLine, "Wrap preserves the exact code");
  await panel.getByRole("button", { name: "Source", exact: true }).click();
  const disable = panel.getByRole("button", { name: "Disable word wrap", exact: true });
  assert.equal(await disable.getAttribute("aria-pressed"), "true", "Source shares the wrap preference");
  await panel.getByRole("button", { name: "Diff", exact: true }).click();
  await gutter(page, "new", 6).click();
  await review(page).getByRole("textbox", { name: "Review comment", exact: true }).fill("Wrapped line comment");
  await page.screenshot({ path: join(artifacts, `${label}-review-wrap.png`), fullPage: true });
  await button(page, "Cancel").click();
  await disable.click();
  assert.equal(await line.evaluate((element) => getComputedStyle(element).whiteSpace), "pre");
  state.editPatch = null;
}

async function checkReviewSyntax(page, state, label) {
  await page.goto(`${base}/?session=${SESSION_ID}`);
  await openFile(page, ALPHA);
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction((dark) => document.documentElement.classList.contains("dark") === dark, colorScheme === "dark");
    for (const type of ["context", "removed", "added"]) {
      const code = review(page).locator(`.diff-review-${type} code`).first();
      await code.locator(".token.keyword").first().waitFor();
      const colors = await code.evaluate((element) => ({
        plain: getComputedStyle(element).color,
        keyword: getComputedStyle(element.querySelector(".token.keyword")).color,
        background: getComputedStyle(element.parentElement).backgroundColor,
      }));
      assert.notEqual(colors.keyword, colors.plain, `${type} keywords must have syntax colors in ${colorScheme}`);
      if (type !== "context") {
        assert.notEqual(colors.background, "rgba(0, 0, 0, 0)", `${type} retains its diff background`);
      }
    }
    await page.screenshot({ path: join(artifacts, `${label}-review-syntax-${colorScheme}.png`), fullPage: true });
  }
  await gutter(page, "new", 2).click();
  await review(page).getByRole("textbox", { name: "Review comment", exact: true }).waitFor();
  await button(page, "Cancel").click();
  const panel = page.locator("#file-panel");
  const editLine = review(page).getByRole("button", { name: "Edit file at line 21", exact: true });
  assert.equal(await editLine.count(), 1, "A current diff line must offer an edit action");
  assert.equal(await review(page).locator('.diff-review-removed [aria-label^="Edit file"]').count(), 0,
    "Deleted lines have no current source location");
  await editLine.click();
  const editor = panel.getByRole("textbox", { name: "File content", exact: true });
  await editor.waitFor();
  assert.equal(await panel.getByRole("button", { name: "Source", exact: true }).getAttribute("aria-pressed"), "true");
  assert.equal(await editor.evaluate((element) => document.activeElement === element), true);
  assert.equal(await editor.evaluate((element) => element.selectionStart), EDIT_CONTENT.replaceAll("\r\n", "\n").indexOf("  return value.toFixed"));
  await panel.getByRole("button", { name: "Close editor", exact: true }).click();
  assert.equal(await panel.getByRole("button", { name: "Source", exact: true }).getAttribute("aria-pressed"), "true",
    "Close editor stays in Source after a diff jump");
  await checkReviewWrap(page, state, label);
  const samples = [
    { name: "Review.svelte", text: '<script lang="ts">\nconst count: number = 1;\n</script>\n{#if count}<p>{count}</p>{/if}', token: ".token.builtin", word: "number" },
    { name: "Containerfile", text: 'FROM alpine:latest\nRUN echo "hello"', token: ".token.keyword", word: "FROM" },
    { name: "build.containerfile", text: 'FROM alpine:latest\nCMD ["echo", "hello"]', token: ".token.keyword", word: "FROM", deleted: true },
    { name: "workflow.yaml", text: 'name: review\non: [push]', token: ".token.key", word: "name" },
    { name: "Review.tsx", text: 'export const view = <p title="hello">review</p>;', token: ".token.tag", word: "p" },
    { name: "settings.jsonc", text: '// Configuration\n{ "enabled": true }', token: ".token.comment", word: "Configuration" },
    { name: "setup.ps1", text: 'Write-Host "hello"', token: ".token.function", word: "Write-Host" },
  ];
  for (const sample of samples) {
    state.fileNames = [ALPHA, sample.name];
    state.syntaxDeleted = sample.deleted;
    const lines = sample.text.split("\n");
    const prefix = sample.deleted ? "-" : "+";
    const range = sample.deleted ? `-1,${lines.length} +0,0` : `-0,0 +1,${lines.length}`;
    state.syntaxPatch = `@@ ${range} @@\n${lines.map((line) => prefix + line).join("\n")}\n`;
    await page.goto(`${base}/?session=${SESSION_ID}`);
    await openFile(page, sample.name, false, lines[0]);
    await review(page).locator(`code ${sample.token}`).filter({ hasText: sample.word }).first().waitFor();
    assert.deepEqual(await review(page).locator("code").allTextContents(), lines, `${sample.name} preserves its code`);
  }
  delete state.syntaxPatch;
  delete state.syntaxDeleted;
  state.fileNames = [ALPHA, BETA];
  await page.emulateMedia({ colorScheme: "light" });
  console.log(`PASS: ${label}: review syntax, themes, deleted files, diff backgrounds, and comment selection`);
}

async function runCase(browser, options, label) {
  const context = await browser.newContext({ ...options, locale: "en-US", serviceWorkers: "block" });
  await context.addInitScript(() => {
    window.reviewSources = [];
    window.EventSource = new Proxy(window.EventSource, {
      construct(Source, args) {
        const source = Reflect.construct(Source, args);
        if (String(args[0]).includes("type=watch")) {
          window.reviewSources.push(source);
        }
        return source;
      },
    });
  });
  const state = fixture();
  await mockApi(context, state);
  if (browser.browserType().name() === BROWSER.chromium) {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  }
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    if (selectedCase === TEST_CASE.all || selectedCase === TEST_CASE.syntax) {
      await checkReviewSyntax(page, state, label);
    }
    if (selectedCase === TEST_CASE.syntax) {
      assert.deepEqual(errors, [], "The fixture must produce no browser errors");
      return;
    }
    if (selectedCase === TEST_CASE.all || selectedCase === TEST_CASE.edit) {
      await checkFileEditing(page, state, label);
      await checkSourceSyntax(page, state, label);
      state.changed = false;
      state.editPatch = null;
      state.editContent = EDIT_CONTENT;
    }
    if (selectedCase === TEST_CASE.all) {
      await checkReview(page, state, label);
    }
    if (selectedCase !== TEST_CASE.edit) {
      await checkSendReview(page, state, label);
    }
    assert.deepEqual(errors, [], "The fixture must produce no browser errors");
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `${label}-failure.png`), fullPage: true }).catch(() => {});
    console.error(`Fixture requests without a dedicated response: ${state.unknown.join(", ") || "none"}`);
    throw error;
  } finally {
    await context.close();
  }
}

async function runFreshCwd(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: "en-US", serviceWorkers: "block" });
  const state = fixture();
  state.freshComposer = true;
  await mockApi(context, state);

  // Repository drafts must export against the fresh composer's selected folder.
  const freshCwd = join(cwd, FRESH_SUBDIR);
  const outsideFile = join(cwd, ALPHA);
  const insideFile = join(freshCwd, BETA);
  const jiti = createJiti(import.meta.url);
  const { fileReviewTarget } = await jiti.import("../lib/code-review.ts");
  const target = (filePath, path, patch) => ({ ...fileReviewTarget(filePath, path, patch), newStart: 2, newEnd: 2 });
  const savedReview = {
    version: REVIEW_STORAGE_VERSION,
    state: {
      reviewed: {},
      comments: [
        { id: "fresh-outside", target: target(outsideFile, ALPHA, ALPHA_PATCH), body: NEW_COMMENT },
        { id: "fresh-inside", target: target(insideFile, `${FRESH_SUBDIR}/${BETA}`, BETA_PATCH), body: FILE_COMMENT },
      ],
    },
  };
  await context.addInitScript(({ key, value }) => localStorage.setItem(key, value), {
    key: `${REVIEW_STORAGE_PREFIX}${encodeURIComponent(cwd)}`,
    value: JSON.stringify(savedReview),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));

  try {
    await page.goto(`${base}/?cwd=${encodeURIComponent(freshCwd)}`, { waitUntil: "domcontentloaded" });
    const composer = page.locator(".chat-input-textarea");
    await composer.waitFor();
    await composer.fill(ORIGINAL_DRAFT);
    await showSidebarFiles(page);
    const changes = page.getByRole("button", { name: "2 changed files", exact: true });
    await changes.waitFor();
    if (await changes.getAttribute("aria-pressed") !== "true") {
      await changes.click();
    }
    await page.locator("#session-sidebar-panel-files").getByTitle(outsideFile, { exact: true }).first().click();
    await fileReady(page, ALPHA);
    await commentCount(page, 2);
    assert.equal(new URL(page.url()).searchParams.get("cwd"), freshCwd, "The fixture must retain the fresh composer's folder");
    await button(page, "Add to chat").click();
    await page.waitForFunction((text) => document.querySelector(".chat-input-textarea")?.value.includes(text), FILE_COMMENT);
    const draft = await composer.inputValue();
    assert.ok(draft.includes(`\`${outsideFile}:2\``), `An outside file must use an absolute anchor in the fresh composer. Received:\n${draft}`);
    assert.ok(draft.includes(`\`${BETA}:2\``), "An inside file must use an anchor relative to the fresh composer");
    assert.ok(draft.includes(ORIGINAL_DRAFT));
    assert.equal(state.prompts.length, 0, "A fresh composer export must not send an agent prompt");
    assert.deepEqual(errors, [], "The fresh composer fixture must produce no browser errors");
    console.log(`PASS: ${browser.browserType().name()}: fresh composer export uses its selected folder`);
  } catch (error) {
    await page.screenshot({ path: join(artifacts, `${browser.browserType().name()}-fresh-cwd-failure.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

// This standalone suite uses the existing dev server and never creates another one.
mkdirSync(artifacts, { recursive: true });
const ready = await fetch(base, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) }).catch(() => null);
assert.equal(ready?.status ?? HTTP_UNAVAILABLE, HTTP_OK, `Start the Pi Web dev server at ${base} before this suite`);

if (selectedBrowser !== BROWSER.webkit) {
  const chrome = await chromium.launch();
  try {
    if (selectedCase === TEST_CASE.all || selectedCase === TEST_CASE.freshCwd) {
      await runFreshCwd(chrome);
    }
    if (selectedCase !== TEST_CASE.freshCwd) {
      await runCase(chrome, { viewport: { width: 1440, height: 1000 } }, "chromium-desktop");
      await runCase(chrome, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "chromium-mobile");
    }
  } finally {
    await chrome.close();
  }
}

let safari;
if (selectedBrowser !== BROWSER.chromium) {
  try {
    safari = await webkit.launch();
  } catch (error) {
    if (selectedBrowser === BROWSER.webkit || !String(error).includes("Executable doesn't exist")) {
      throw error;
    }
    console.log("SKIP: WebKit executable is not installed");
  }
}
if (safari) {
  try {
    if (selectedCase === TEST_CASE.all || selectedCase === TEST_CASE.freshCwd) {
      await runFreshCwd(safari);
    }
    if (selectedCase !== TEST_CASE.freshCwd) {
      await runCase(safari, { viewport: { width: 1280, height: 900 } }, "webkit-desktop");
      await runCase(safari, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, "webkit-mobile");
    }
  } finally {
    await safari.close();
  }
}
