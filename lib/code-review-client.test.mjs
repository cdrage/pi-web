import assert from "node:assert/strict";
import test from "node:test";
import { loadReviewPatches, loadReviewStatus } from "./code-review-client.ts";

const HTTP_FORBIDDEN = 403;

test("review reads preserve paths and distinguish missing patches from failed requests", async (t) => {
  const cwd = "/repo with spaces";
  const filePath = `${cwd}/a & b.ts`;
  const calls = [];
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const url = new URL(input, "http://localhost");
    calls.push({ url, options });
    if (url.pathname.endsWith("status")) {
      return Response.json({ isGitRepository: true, repositoryRoot: cwd, files: [] });
    }
    if (url.searchParams.get("path") === filePath) {
      return Response.json({ supported: true, patch: "original patch" });
    }
    return Response.json({ supported: false });
  });

  assert.equal((await loadReviewStatus(cwd)).repositoryRoot, cwd);
  assert.deepEqual(await loadReviewPatches(cwd, [filePath, filePath, `${cwd}/gone.ts`]), {
    [filePath]: "original patch",
    [`${cwd}/gone.ts`]: null,
  });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ url, options }) => url.searchParams.get("cwd") === cwd && options.cache === "no-store"));
  assert.equal(calls[1].url.searchParams.get("path"), filePath);

  t.mock.method(globalThis, "fetch", async () => Response.json({ error: "Access denied" }, { status: HTTP_FORBIDDEN }));
  await assert.rejects(loadReviewPatches(cwd, [filePath]), /Access denied/);
});

test("a large review limits concurrent reads and forwards cancellation", async (t) => {
  const controller = new AbortController();
  const paths = Array.from({ length: 25 }, (_, index) => `/repo/file-${index}.ts`);
  let active = 0;
  let maximum = 0;
  const requested = [];

  t.mock.method(globalThis, "fetch", async (input, options) => {
    assert.equal(options.signal, controller.signal);
    const path = new URL(input, "http://localhost").searchParams.get("path");
    requested.push(path);
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 0));
    active -= 1;
    return Response.json({ supported: true, patch: path });
  });

  const patches = await loadReviewPatches("/repo", paths, controller.signal);
  assert.deepEqual(Object.keys(patches), paths);
  assert.deepEqual(requested, paths);
  assert.ok(maximum > 1 && maximum < paths.length);
});
