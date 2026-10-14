import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { fileReviewTarget, patchId } = await jiti.import("./code-review.ts");
const {
  clearReview,
  deleteComment,
  getReview,
  pruneReview,
  reviewError,
  saveComment,
  subscribeReview,
  toggleReviewed,
} = await jiti.import("./code-review-store.ts");

function installWindow(t) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const values = new Map();
  const listeners = new Set();
  let writes = 0;
  const browser = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem(key, value) { writes++; values.set(key, value); },
    },
    addEventListener(type, listener) { if (type === "storage") { listeners.add(listener); } },
    removeEventListener(type, listener) { if (type === "storage") { listeners.delete(listener); } },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
  t.after(() => {
    if (previous) { Object.defineProperty(globalThis, "window", previous); }
    else { delete globalThis.window; }
  });

  return {
    browser, values, listeners,
    get writes() { return writes; },
    external(key, value) {
      if (value === null) { values.delete(key); }
      else { values.set(key, value); }
      for (const listener of listeners) { listener({ key, newValue: value, storageArea: browser.localStorage }); }
    },
  };
}

test("persists review changes and preserves snapshots for no-op actions", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-persistence/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  let notifications = 0;
  const unsubscribe = subscribeReview(cwd, () => { notifications++; });
  t.after(unsubscribe);
  const empty = getReview(cwd);
  assert.strictEqual(getReview(cwd), empty);

  saveComment(cwd, target, " First comment. ", "one");
  const saved = getReview(cwd);
  assert.equal(saved.comments[0].body, "First comment.");
  assert.equal(notifications, 1);
  assert.equal(browser.writes, 1);
  saveComment(cwd, { ...target }, "First comment.", "one");
  saveComment(cwd, target, " ");
  deleteComment(cwd, "absent");
  assert.strictEqual(getReview(cwd), saved);
  assert.equal(browser.writes, 1);

  toggleReviewed(cwd, target.filePath, "patch");
  assert.equal(getReview(cwd).reviewed[target.filePath], patchId("patch"));
  toggleReviewed(cwd, target.filePath, "new patch");
  assert.equal(getReview(cwd).reviewed[target.filePath], patchId("new patch"));
  toggleReviewed(cwd, target.filePath, "new patch");
  assert.equal(getReview(cwd).reviewed[target.filePath], undefined);
  deleteComment(cwd, "one");
  assert.deepEqual(getReview(cwd).comments, []);
  assert.equal(reviewError(cwd), null);
  clearReview(cwd);
  const cleared = getReview(cwd);
  clearReview(cwd);
  assert.strictEqual(getReview(cwd), cleared);
});

test("normalizes cwd keys and keeps distinct worktrees separate", (t) => {
  installWindow(t);
  const windowsCwd = "C:\\Review-Normalization\\repo\\";
  const target = fileReviewTarget("C:/Review-Normalization/repo/app.ts", "app.ts", "patch");
  saveComment(windowsCwd, target, "Windows review.", "windows");

  assert.strictEqual(getReview(windowsCwd), getReview("c:/review-normalization/repo"));
  saveComment("/review-normalization/repo/./", target, "Main review.", "main");
  assert.strictEqual(getReview("/review-normalization/repo"), getReview("/review-normalization/repo/./"));
  assert.deepEqual(getReview("/review-normalization/worktree").comments, []);
});

test("discards obsolete comments only for files with a fresh diff", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-prune/repo";
  const target = (path, patch = "patch") => fileReviewTarget(`${cwd}/${path}`, path, patch);
  saveComment(cwd, target("changed.ts"), "Discard the old line comment.", "changed");
  saveComment(cwd, target("changed.ts", "new patch"), "Keep the new comment.", "new");
  saveComment(cwd, target("clean.ts"), "Discard the clean file comment.", "clean");
  saveComment(cwd, target("gone.ts"), "Discard the missing diff comment.", "gone");
  saveComment(cwd, target("same.ts"), "Keep the current comment.", "same");
  saveComment(cwd, target("unknown.ts"), "Keep the unread comment.", "unknown");
  const patches = {
    [`${cwd}/changed.ts`]: "new patch",
    [`${cwd}/clean.ts`]: "",
    [`${cwd}/gone.ts`]: null,
    [`${cwd}/same.ts`]: "patch",
  };

  const current = pruneReview(cwd, patches);
  assert.deepEqual(current.comments.map(({ id }) => id), ["new", "same", "unknown"]);
  assert.strictEqual(getReview(cwd), current);
  const [key] = browser.values.keys();
  assert.deepEqual(JSON.parse(browser.values.get(key)).state, current);

  const writes = browser.writes;
  assert.strictEqual(pruneReview(cwd, patches), current);
  assert.equal(browser.writes, writes, "An unchanged review must not write storage");
});

test("retains current comments from another tab when it prunes old comments", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-prune-tabs/repo";
  const filePath = `${cwd}/app.ts`;
  saveComment(cwd, fileReviewTarget(filePath, "app.ts", "old patch"), "Old comment.", "old");
  const [key, raw] = [...browser.values.entries()][0];
  const saved = JSON.parse(raw);
  saved.state.comments.push({
    id: "remote", target: fileReviewTarget(filePath, "app.ts", "new patch"), body: "New comment.",
  });
  browser.values.set(key, JSON.stringify(saved));

  const current = pruneReview(cwd, { [filePath]: "new patch" });
  assert.deepEqual(current.comments.map(({ id }) => id), ["remote"]);
  assert.deepEqual(JSON.parse(browser.values.get(key)).state, current);
});

test("loads saved reviews and accepts storage events across remounts", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-events/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  saveComment(cwd, target, "Initial.", "one");
  const [key, stored] = [...browser.values.entries()][0];
  const document = JSON.parse(stored);
  document.state.comments.push({ id: "two", target, body: "From another tab." });
  let notifications = 0;
  const unsubscribe = subscribeReview(cwd, () => { notifications++; });

  browser.external(key, JSON.stringify(document));
  const updated = getReview(cwd);
  assert.equal(updated.comments.length, 2);
  assert.equal(notifications, 1);
  browser.external(key, JSON.stringify(document));
  assert.strictEqual(getReview(cwd), updated);
  assert.equal(notifications, 1);
  unsubscribe();
  assert.equal(browser.listeners.size, 0);

  document.state.comments[1].body = "Updated while unmounted.";
  browser.values.set(key, JSON.stringify(document));
  const remounted = subscribeReview(cwd, () => { notifications++; });
  assert.equal(getReview(cwd).comments[1].body, "Updated while unmounted.");
  browser.external(key, null);
  assert.deepEqual(getReview(cwd).comments, []);
  remounted();
});

test("rejects malformed storage and preserves memory if persistence fails", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-invalid/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  saveComment(cwd, target, "Safe comment.", "one");
  const [key] = [...browser.values.keys()];
  const unsubscribe = subscribeReview(cwd, () => {});
  t.after(unsubscribe);

  browser.external(key, JSON.stringify({ version: 1, state: { comments: [{ id: "bad", target: {}, body: "Bad." }], reviewed: {} } }));
  assert.equal(getReview(cwd).comments[0].body, "Safe comment.");
  assert.match(reviewError(cwd), /saved review/);

  browser.browser.localStorage.setItem = () => { throw new Error("quota"); };
  saveComment(cwd, target, "Memory comment.", "one");
  assert.equal(getReview(cwd).comments[0].body, "Memory comment.");
  assert.match(reviewError(cwd), /browser/);
});

test("keeps SSR snapshots stable and catches blocked localStorage access", (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  delete globalThis.window;
  t.after(() => {
    if (previous) { Object.defineProperty(globalThis, "window", previous); }
    else { delete globalThis.window; }
  });
  const cwd = "/review-blocked/repo";
  const empty = getReview(cwd);
  assert.strictEqual(getReview(cwd), empty);
  assert.doesNotThrow(() => subscribeReview(cwd, () => {})());

  const blocked = { addEventListener() {}, removeEventListener() {} };
  Object.defineProperty(blocked, "localStorage", { get() { throw new Error("blocked"); } });
  Object.defineProperty(globalThis, "window", { configurable: true, value: blocked });
  assert.doesNotThrow(() => saveComment(cwd, fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch"), "Memory only."));
  assert.equal(getReview(cwd).comments.length, 1);
  assert.match(reviewError(cwd), /browser/);
});

test("updates snapshots for storage errors and recovery without data changes", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-error-snapshots/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  saveComment(cwd, target, "Keep this comment.", "one");
  const [key, saved] = [...browser.values.entries()][0];
  const unsubscribe = subscribeReview(cwd, () => {});
  t.after(unsubscribe);
  const initial = getReview(cwd);

  browser.external(key, "malformed JSON");
  const failed = getReview(cwd);
  assert.notStrictEqual(failed, initial);
  assert.deepEqual(failed, initial);
  assert.match(reviewError(cwd), /saved review/);
  browser.external(key, "malformed JSON");
  assert.strictEqual(getReview(cwd), failed);

  browser.external(key, saved);
  assert.notStrictEqual(getReview(cwd), failed);
  assert.deepEqual(getReview(cwd), initial);
  assert.equal(reviewError(cwd), null);
});

test("creates unique comment ids when randomUUID is unavailable", (t) => {
  installWindow(t);
  const previous = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
  t.after(() => {
    if (previous) { Object.defineProperty(globalThis, "crypto", previous); }
    else { delete globalThis.crypto; }
  });
  const cwd = "/review-insecure/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  saveComment(cwd, target, "First comment.");
  saveComment(cwd, target, "Second comment.");

  const comments = getReview(cwd).comments;
  assert.equal(comments.length, 2);
  assert.notEqual(comments[0].id, comments[1].id);
});

test("loads a persisted review before any subscriber mounts", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-initial-load/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  const saved = { comments: [{ id: "persisted", target, body: "Saved in another tab." }], reviewed: {} };
  browser.values.set(`pi-web:code-review:v1:${encodeURIComponent(cwd)}`, JSON.stringify({ version: 1, state: saved }));

  assert.deepEqual(getReview(cwd), saved);
  assert.strictEqual(getReview(cwd), getReview(cwd));
  assert.equal(browser.writes, 0);
});

test("retains recent comments from another tab before a local mutation", (t) => {
  const browser = installWindow(t);
  const cwd = "/review-tab-write/repo";
  const target = fileReviewTarget(`${cwd}/app.ts`, "app.ts", "patch");
  saveComment(cwd, target, "Initial comment.", "one");
  const [key, raw] = [...browser.values.entries()][0];
  const saved = JSON.parse(raw);
  saved.state.comments.push({ id: "remote", target, body: "Remote comment." });
  browser.values.set(key, JSON.stringify(saved));
  saveComment(cwd, target, "Local comment.", "local");

  assert.deepEqual(getReview(cwd).comments.map(({ id }) => id), ["one", "remote", "local"]);
  assert.equal(JSON.parse(browser.values.get(key)).state.comments.length, 3);
});
