import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const EXECUTABLE_MODE = 0o755;
const FILE_MODE_MASK = 0o777;

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { readFileEdit, saveFileEdit } = await jiti.import("./file-edit.ts");
const { FILE_EDIT_MAX_BYTES } = await jiti.import("./file-edit-types.ts");
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-file-edit-")));
test.after(() => fs.rmSync(base, { recursive: true, force: true }));

function fixture(content = "original\r\n", mode = EXECUTABLE_MODE) {
  const root = fs.mkdtempSync(path.join(base, "root-"));
  const filePath = path.join(root, "script.sh");
  fs.writeFileSync(filePath, content, { mode });
  return { root, filePath, roots: new Set([root]) };
}

test("saves complete UTF-8 text atomically with its executable mode", () => {
  const { root, filePath, roots } = fixture();
  const snapshot = readFileEdit(filePath, roots);
  const saved = saveFileEdit(filePath, roots, "新内容\r\n", snapshot.revision);
  assert.equal(fs.readFileSync(filePath, "utf8"), "新内容\r\n");
  assert.deepEqual(saved, readFileEdit(filePath, roots));
  assert.notEqual(saved.revision, snapshot.revision);
  assert.equal(fs.statSync(filePath).mode & FILE_MODE_MASK, EXECUTABLE_MODE);
  assert.deepEqual(fs.readdirSync(root), ["script.sh"]);
});

test("stale revisions preserve an external edit, including equal-length edits", () => {
  const { filePath, roots } = fixture("original");
  const snapshot = readFileEdit(filePath, roots);
  fs.writeFileSync(filePath, "external");
  assert.throws(() => saveFileEdit(filePath, roots, "my draft", snapshot.revision), { status: HTTP_CONFLICT });
  assert.equal(fs.readFileSync(filePath, "utf8"), "external");
});

test("refuses missing files, directories, binary data, invalid UTF-8, and oversized text", () => {
  const { root, filePath, roots } = fixture();
  assert.throws(() => readFileEdit(root, roots), { status: HTTP_BAD_REQUEST });
  assert.throws(() => readFileEdit(path.join(root, "missing"), roots));
  for (const bytes of [Buffer.from([0, 1]), Buffer.from([0xff]), Buffer.alloc(FILE_EDIT_MAX_BYTES + 1, 65)]) {
    fs.writeFileSync(filePath, bytes);
    assert.throws(() => readFileEdit(filePath, roots));
  }
  fs.writeFileSync(filePath, "original");
  const snapshot = readFileEdit(filePath, roots);
  assert.throws(() => saveFileEdit(filePath, roots, "x".repeat(FILE_EDIT_MAX_BYTES + 1), snapshot.revision), { status: HTTP_TOO_LARGE });
  assert.throws(() => saveFileEdit(filePath, roots, "binary\0text", snapshot.revision), { status: HTTP_BAD_REQUEST });
  assert.equal(fs.readFileSync(filePath, "utf8"), "original");
});

test("refuses outside roots, parent traversal, and symbolic links", () => {
  const { root, filePath, roots } = fixture();
  const outside = fixture("private");
  const link = path.join(root, "link");
  fs.symlinkSync(outside.root, link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => readFileEdit(outside.filePath, roots), { status: HTTP_FORBIDDEN });
  assert.throws(() => readFileEdit(path.join(link, "script.sh"), roots), { status: HTTP_FORBIDDEN });
  assert.throws(() => readFileEdit(`${root}/link/../script.sh`, roots), { status: HTTP_FORBIDDEN });
  fs.symlinkSync(filePath, path.join(root, "alias"));
  assert.throws(() => readFileEdit(path.join(root, "alias"), roots), { status: HTTP_BAD_REQUEST });
  assert.equal(fs.readFileSync(outside.filePath, "utf8"), "private");
});

test("failed staging leaves the original file and no temporary entries", (t) => {
  const { root, filePath, roots } = fixture();
  const snapshot = readFileEdit(filePath, roots);
  t.mock.method(fs, "writeFileSync", () => { throw new Error("Disk full"); });
  assert.throws(() => saveFileEdit(filePath, roots, "draft", snapshot.revision), /Disk full/);
  assert.equal(fs.readFileSync(filePath, "utf8"), "original\r\n");
  assert.deepEqual(fs.readdirSync(root), ["script.sh"]);
});

test("a concurrent change during staging survives the save attempt", (t) => {
  const { root, filePath, roots } = fixture();
  const snapshot = readFileEdit(filePath, roots);
  const write = fs.writeFileSync;
  t.mock.method(fs, "writeFileSync", (target, ...args) => {
    const result = write(target, ...args);
    if (String(target).includes(".pi-edit-")) {
      write(filePath, "external edit");
    }
    return result;
  });
  assert.throws(() => saveFileEdit(filePath, roots, "draft", snapshot.revision), { status: HTTP_CONFLICT });
  assert.equal(fs.readFileSync(filePath, "utf8"), "external edit");
  assert.deepEqual(fs.readdirSync(root), ["script.sh"]);
});
