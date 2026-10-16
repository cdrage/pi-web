import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const HTTP_CONFLICT = 409;

const jiti = createJiti(import.meta.url);
const store = await jiti.import("./file-edit-store.ts");
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; });

function mockFile(content = "original\r\n") {
  const writes = [];
  globalThis.fetch = async (_url, init) => {
    if (init.method === "PUT") {
      const body = JSON.parse(init.body);
      writes.push(body);
      return Response.json({ ...body, revision: "saved-revision" });
    }
    return Response.json({ content, revision: "original-revision" });
  };
  return writes;
}

test("cancel retains a dirty draft across viewer subscriptions", async () => {
  mockFile();
  const file = "/cancel.ts";
  await store.startFileEdit(file);
  store.updateFileDraft(file, "draft\n");
  const stop = store.subscribeFileEdits(() => {});
  stop();
  await store.startFileEdit(file);
  assert.equal(store.getFileDraft(file).text, "draft\n");
  let closed = false;
  store.requestFileClose(file, () => { closed = true; });
  await store.resolveFileClose("cancel");
  assert.equal(closed, false);
  assert.equal(store.getFileDraft(file).text, "draft\n");
  store.requestFileClose(file, () => { closed = true; });
  await store.resolveFileClose("discard");
  assert.equal(closed, true);
  assert.equal(store.getFileDraft(file), null);
});

test("save before close preserves CRLF and clears the dirty indicator", async () => {
  const writes = mockFile();
  const file = "/save.ts";
  await store.startFileEdit(file);
  store.updateFileDraft(file, "new\ntext\n");
  assert.ok(JSON.parse(store.dirtyFilePaths()).includes(file));
  let closed = false;
  store.requestFileClose(file, () => { closed = true; });
  await store.resolveFileClose("save");
  assert.equal(closed, true);
  assert.deepEqual(writes, [{ content: "new\r\ntext\r\n", revision: "original-revision" }]);
  assert.equal(store.getFileDraft(file), null);
  assert.ok(!JSON.parse(store.dirtyFilePaths()).includes(file));
});

test("a save conflict keeps the close dialog and draft for recovery", async () => {
  mockFile();
  const file = "/conflict.ts";
  await store.startFileEdit(file);
  store.updateFileDraft(file, "draft");
  globalThis.fetch = async () => Response.json({ error: "File changed" }, { status: HTTP_CONFLICT });
  let closed = false;
  store.requestFileClose(file, () => { closed = true; });
  await store.resolveFileClose("save");
  assert.equal(closed, false);
  assert.equal(store.getFileClose().filePath, file);
  assert.equal(store.getFileDraft(file).text, "draft");
  assert.equal(store.getFileDraft(file).error, "File changed");
  await store.resolveFileClose("discard");
});

test("an unchanged or reverted draft closes without a prompt or write", async () => {
  const writes = mockFile();
  const file = "/unchanged.ts";
  await store.startFileEdit(file);
  store.updateFileDraft(file, "draft");
  store.updateFileDraft(file, "original\n");
  let closed = false;
  store.requestFileClose(file, () => { closed = true; });
  assert.equal(closed, true);
  assert.equal(store.getFileClose(), null);
  assert.deepEqual(writes, []);
});

test("a pending save blocks edits, duplicate saves, and close", async () => {
  mockFile();
  const file = "/pending.ts";
  await store.startFileEdit(file);
  store.updateFileDraft(file, "draft");
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const saving = store.saveFileDraft(file);
  store.updateFileDraft(file, "lost update");
  assert.equal(await store.saveFileDraft(file), false);
  let closed = false;
  store.requestFileClose(file, () => { closed = true; });
  assert.equal(closed, false);
  finish(Response.json({ content: "draft", revision: "saved-revision" }));
  assert.equal(await saving, true);
  assert.equal(store.getFileDraft(file).text, "draft");
  store.requestFileClose(file, () => {});
});

test("Source edits retain the clicked line position and save the complete file", async () => {
  const writes = mockFile("first\r\nsecond\r\nthird\r\n");
  const file = "/source.ts";
  await store.startFileEdit(file, 2);
  assert.equal(store.getFileDraft(file).focusOffset, "first\n".length);
  store.updateFileDraft(file, "first\nupdated\ninserted\nlast\n");
  await store.saveFileDraft(file);
  assert.equal(writes[0].content, "first\r\nupdated\r\ninserted\r\nlast\r\n");
  store.requestFileClose(file, () => {});
});
