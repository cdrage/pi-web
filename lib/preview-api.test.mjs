import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
const { previewBody, previewCwd, previewFailure } = await jiti.import("./preview-api.ts");

function request(body, headers = {}) {
  return new Request("http://127.0.0.1:30141/api/preview", {
    method: "POST", headers: { host: "127.0.0.1:30141", "Content-Type": "application/json", ...headers }, body,
  });
}

test("preview mutations require a trusted JSON request and a bounded object", async () => {
  assert.deepEqual(await previewBody(request('{"action":"start"}')), { action: "start" });
  await assert.rejects(previewBody(request("{}", { origin: "https://other.test", "sec-fetch-site": "cross-site" })), /Untrusted/);
  await assert.rejects(previewBody(request("{}", { "Content-Type": "text/plain" })), /Content-Type/);
  await assert.rejects(previewBody(request("[1,2]")), /Invalid JSON/);
  await assert.rejects(previewBody(request("{bad")), /Invalid JSON/);
  await assert.rejects(previewBody(request(JSON.stringify({ data: "x".repeat(16 * 1024) }))), /size limit/);
});

test("unexpected server errors never expose file contents or token values", async () => {
  const response = previewFailure(new Error("secret-token and internal path"));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Preview request failed." });
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("preview cwd access refuses paths outside allowed roots and escaping links", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-preview-access-"));
  const root = join(dir, "allowed");
  const outside = join(dir, "outside");
  await mkdir(root);
  await mkdir(outside);
  await symlink(outside, join(root, "escape"));
  const previous = globalThis.__piAllowedRootsCache;
  globalThis.__piAllowedRootsCache = { roots: new Set([root]), expiresAt: Date.now() + 60_000 };
  t.after(async () => {
    globalThis.__piAllowedRootsCache = previous;
    await rm(dir, { recursive: true, force: true });
  });
  assert.equal(await previewCwd(root), root);
  await assert.rejects(previewCwd(outside), /Access denied/);
  await assert.rejects(previewCwd(join(root, "escape")), /Access denied/);
  await assert.rejects(previewCwd("relative/path"), /absolute path/);
});
