import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const HTTP_UNSUPPORTED_MEDIA = 415;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-edit-route-")));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousRoots = globalThis.__piAllowedRootsCache;
process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
test.after(() => {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  globalThis.__piAllowedRootsCache = previousRoots;
  fs.rmSync(base, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET, PUT } = await jiti.import("./[...path]/route.ts");
const { NextRequest } = await jiti.import("next/server");
const { encodeFilePathForApi } = await jiti.import("../../../lib/file-paths.ts");
const { FILE_EDIT_MAX_BYTES } = await jiti.import("../../../lib/file-edit-types.ts");

function fixture() {
  const root = fs.mkdtempSync(path.join(base, "root-"));
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  const filePath = path.join(root, "file.txt");
  fs.writeFileSync(filePath, "original");
  return filePath;
}

function call(filePath, body, headers = {}) {
  const encoded = encodeFilePathForApi(filePath);
  const request = new NextRequest(`http://localhost/api/files/${encoded}?type=edit`, {
    method: body === undefined ? "GET" : "PUT",
    headers: { host: "localhost", "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return (body === undefined ? GET : PUT)(request, { params: Promise.resolve({ path: encoded.split("/").map(decodeURIComponent) }) });
}

test("reads a complete edit snapshot, saves it, and rejects a stale revision", async () => {
  const filePath = fixture();
  const response = await call(filePath);
  assert.equal(response.status, HTTP_OK);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const snapshot = await response.json();
  const saved = await call(filePath, { content: "edited", revision: snapshot.revision });
  assert.equal(saved.status, HTTP_OK);
  assert.equal(fs.readFileSync(filePath, "utf8"), "edited");
  assert.equal((await call(filePath, { content: "overwrite", revision: snapshot.revision })).status, HTTP_CONFLICT);
  assert.equal(fs.readFileSync(filePath, "utf8"), "edited");
});

test("refuses cross-origin saves, invalid payloads, and non-JSON saves", async () => {
  const filePath = fixture();
  const body = { content: "edited", revision: "revision" };
  assert.equal((await call(filePath, body, { origin: "https://evil.example", "sec-fetch-site": "cross-site" })).status, HTTP_FORBIDDEN);
  assert.equal((await call(filePath, body, { "content-type": "text/plain" })).status, HTTP_UNSUPPORTED_MEDIA);
  for (const invalid of [null, {}, { content: 123, revision: "revision" }, { content: "edited" }]) {
    assert.equal((await call(filePath, invalid)).status, HTTP_BAD_REQUEST);
  }
  assert.equal(fs.readFileSync(filePath, "utf8"), "original");
});

test("edit reads and writes never authorize files outside the allowed roots", async () => {
  fixture();
  const filePath = path.join(base, "outside.txt");
  fs.writeFileSync(filePath, "private");
  assert.equal((await call(filePath)).status, HTTP_FORBIDDEN);
  assert.equal((await call(filePath, { content: "edited", revision: "revision" })).status, HTTP_FORBIDDEN);
  assert.equal(fs.readFileSync(filePath, "utf8"), "private");
});

test("bounded requests reject oversized bodies without Content-Length", async () => {
  const filePath = fixture();
  const body = { content: "x".repeat(FILE_EDIT_MAX_BYTES * 6 + 1024), revision: "revision" };
  assert.equal((await call(filePath, body)).status, HTTP_TOO_LARGE);
  assert.equal(fs.readFileSync(filePath, "utf8"), "original");
});
