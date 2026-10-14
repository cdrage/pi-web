import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createPreviewService } = await jiti.import("../packages/pi-pd-preview/service.ts");
const { createGithub, makeSpec, parseOptions } = await jiti.import("../packages/pi-pd-preview/github.ts");
const { createClient } = await jiti.import("../packages/pi-pd-preview/client.ts");
const { configView, readConfig, saveConfig } = await jiti.import("../packages/pi-pd-preview/storage.ts");
const { getFreshness, parseRepo, validBranch } = await jiti.import("../packages/pi-pd-preview/model.ts");
const { getContext } = await jiti.import("../packages/pi-pd-preview/git.ts");
const SHA = "a".repeat(40);
const NEXT_SHA = "b".repeat(40);
const TOKEN = "secret-preview-test-token";
const SOURCE = { repo: "owner/podman-desktop", branch: "feature/test" };
const SPEC = { ...SOURCE, kind: "desktop", mode: "dev", autoUpdate: true, updateInterval: 30, includeK8s: false, rootful: false };

function record(id) {
  return {
    id, phase: "ready", vncReady: true, vncUrl: `https://${id}.example.test`,
    expiresAt: "2030-01-01T12:00:00Z",
    runtime: { phase: "ready", sourceCommit: SHA, appliedCommit: SHA, desktopCommit: SHA, lastError: "" },
  };
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pd-preview-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await saveConfig(dir, { apiUrl: "http://preview.test", token: TOKEN }, {});
  const state = {
    calls: [], records: new Map(), keys: new Map(), creates: 0, failCreate: false, failDelete: false,
    context: { root: "/workspace/one", ...SOURCE, head: SHA, dirty: false },
  };
  const fetcher = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.redirect, "error");
    state.calls.push([options.method, url]);
    if (url.endsWith("/sessions") && options.method === "POST") {
      const key = options.headers["Idempotency-Key"];
      const saved = JSON.parse(await readFile(join(dir, "pd-preview-state.json"), "utf8"));
      assert.ok(Object.values(saved.entries).some((entry) => entry.createKey === key), "request key persists before POST");
      let id = state.keys.get(key);
      if (!id) {
        id = `preview-${++state.creates}`;
        state.keys.set(key, id);
        state.records.set(id, record(id));
      }
      if (state.failCreate) {
        state.failCreate = false;
        throw new Error("connection lost after server accepts POST");
      }
      return Response.json(state.records.get(id), { status: 202 });
    }
    const id = new URL(url).pathname.split("/")[4];
    if (!state.records.has(id)) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (options.method === "DELETE") {
      state.records.delete(id);
      if (state.failDelete) {
        state.failDelete = false;
        throw new Error("connection lost after server deletes pod");
      }
      return new Response(null, { status: 204 });
    }
    if (url.endsWith("/sync")) {
      return Response.json({ status: "queued" }, { status: 202 });
    }
    if (url.includes("/logs?")) {
      return Response.json({ lines: [`build log ${TOKEN}`] });
    }
    return Response.json(state.records.get(id));
  };
  const github = { resolve: async (repo, branch) => ({ repo: parseRepo(repo), branch }), pushed: async () => SHA };
  const service = () => createPreviewService({ agentDir: dir, env: {}, fetcher, github, context: async () => ({ ...state.context }) });
  return { dir, state, service };
}

test("concurrent CLI and Web starts share one desktop and private registry", async (t) => {
  const { dir, state, service } = await fixture(t);
  const results = await Promise.all([service().action("/cwd", "start"), service().action("/cwd", "start")]);
  assert.equal(state.creates, 1);
  assert.equal(results[0].session.id, results[1].session.id);
  assert.equal(results[0].freshness, "current");
  assert.equal((await stat(join(dir, "pd-preview-state.json"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(dir, "pd-preview.json"))).mode & 0o777, 0o600);
});

test("an ambiguous POST retries the saved key after a process restart", async (t) => {
  const { state, service } = await fixture(t);
  state.failCreate = true;
  await assert.rejects(service().action("/cwd", "start"), /Cannot reach/);
  assert.equal((await service().status("/cwd")).session, null);
  const result = await service().action("/cwd", "start");
  assert.equal(result.session.id, "preview-1");
  assert.equal(state.creates, 1);
});

test("Sync preserves the desktop and Reset survives a lost delete response", async (t) => {
  const { state, service } = await fixture(t);
  const first = await service().action("/cwd", "start");
  const synced = await service().action("/cwd", "sync");
  assert.equal(synced.session.id, first.session.id);
  assert.equal(state.creates, 1);
  state.failDelete = true;
  await assert.rejects(service().action("/cwd", "reset"), /Cannot reach/);
  const reset = await service().action("/cwd", "start");
  assert.notEqual(reset.session.id, first.session.id);
  assert.equal(state.records.size, 1);
  assert.equal(state.creates, 2);
  await service().action("/cwd", "stop");
  assert.equal(state.records.size, 0);
  assert.equal((await service().status("/cwd")).binding, null);
});

test("Reset retries an ambiguous create without a second replacement", async (t) => {
  const { state, service } = await fixture(t);
  await service().action("/cwd", "start");
  state.failCreate = true;
  await assert.rejects(service().action("/cwd", "reset"), /Cannot reach/);
  const result = await service().action("/cwd", "reset");
  assert.equal(state.creates, 2);
  assert.equal(state.records.size, 1);
  assert.equal(result.session.id, "preview-2");
});

test("worktrees and branches keep separate bindings, and a source change refuses replacement", async (t) => {
  const { state, service } = await fixture(t);
  const first = await service().action("/cwd", "start");
  await assert.rejects(service().action("/cwd", "start", { source: "other/repo", branch: "main" }), /already use another/);
  assert.equal(state.records.size, 1);
  state.context.branch = "another-branch";
  assert.equal((await service().status("/cwd")).binding, null);
  await service().action("/cwd", "start");
  state.context.root = "/workspace/two";
  await service().action("/cwd", "start");
  state.context.root = "/workspace/one";
  state.context.branch = SOURCE.branch;
  assert.equal((await service().status("/cwd")).session.id, first.session.id);
  assert.equal(state.creates, 3);
});

test("expired status never creates a desktop or extends its expiry", async (t) => {
  const { state, service } = await fixture(t);
  await service().action("/cwd", "start");
  state.records.clear();
  state.calls.length = 0;
  const expired = await service().status("/cwd");
  assert.equal(expired.expired, true);
  assert.equal(state.calls.every(([method]) => method === "GET"), true);
  const fresh = await service().action("/cwd", "start");
  assert.equal(fresh.session.id, "preview-2");
});

test("a branch switch refuses an action from an old card", async (t) => {
  const { state, service } = await fixture(t);
  const before = await service().action("/cwd", "start");
  state.context.branch = "other-branch";
  await service().action("/cwd", "start");
  await assert.rejects(service().action("/cwd", "reset", {}, before.context), /worktree or branch changed/);
  assert.equal(state.creates, 2);
  assert.equal(state.records.size, 2);
});

test("logs redact the API token", async (t) => {
  const { service } = await fixture(t);
  await service().action("/cwd", "start");
  assert.deepEqual(await service().logs("/cwd"), ["build log [redacted]"]);
});

test("OIDC requests carry gateway identity and the separate service token", async () => {
  const identity = "signed-oidc-test-identity";
  const config = { apiUrl: "https://preview.test", token: TOKEN, oidc: { issuer: "https://auth.test/dex", clientId: "pi-preview" } };
  const client = createClient(config, async (_url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers["X-Pi-OIDC-Token"], identity);
    return Response.json({ sessions: [] });
  }, async () => identity);

  assert.deepEqual(await client.check(), { sessions: 0 });
});

test("commit tracking separates local, pushed, applied, and failed updates", () => {
  const context = { root: "/cwd", ...SOURCE, head: SHA, dirty: true };
  const session = record("preview");
  assert.equal(getFreshness(context, SPEC, session, SHA), "current", "dirty files do not change the committed SHA");
  assert.equal(getFreshness(context, SPEC, session, NEXT_SHA), "push-required");
  assert.equal(getFreshness({ ...context, head: NEXT_SHA }, SPEC, session, NEXT_SHA), "update-required");
  assert.equal(getFreshness(context, SPEC, { ...session, runtime: null }, SHA), "waiting");
  assert.equal(getFreshness(context, SPEC, session, null), "unknown");
  assert.equal(getFreshness({ ...context, repo: "other/repo" }, SPEC, session, NEXT_SHA), "update-required");
  assert.equal(getFreshness(context, SPEC, { ...session, phase: "failed" }, SHA), "failed");
});

test("configuration returns no token, keeps a blank replacement, and honors environment overrides", async (t) => {
  const { dir } = await fixture(t);
  const view = await configView(dir, {});
  assert.equal(JSON.stringify(view).includes(TOKEN), false);
  await saveConfig(dir, { apiUrl: "https://preview.example.test/" }, {});
  assert.equal((await readConfig(dir, {})).token, TOKEN);
  const env = { PD_API_URL: "http://override.test", PD_API_TOKEN: "env-token" };
  await saveConfig(dir, { apiUrl: "http://ignored.test", token: "ignored" }, env);
  assert.deepEqual(await readConfig(dir, env), { apiUrl: "http://override.test", token: "env-token" });
  assert.equal((await readConfig(dir, {})).token, TOKEN);
  await assert.rejects(saveConfig(dir, { apiUrl: "https://user:pass@preview.test" }, {}), /without credentials/);
  await assert.rejects(saveConfig(dir, { apiUrl: "https://preview.test?token=secret" }, {}), /query/);
  await assert.rejects(saveConfig(dir, { apiUrl: "https://preview.test", token: "x\r\ny" }, {}), /line breaks/);
});

test("client refuses redirects, unsafe desktop links, huge responses, and raw API errors", async () => {
  const config = { apiUrl: "http://preview.test", token: TOKEN };
  const session = record("test");
  const client = createClient(config, async () => Response.json({ ...session, vncUrl: "javascript:alert(1)", runtime: { ...session.runtime, lastError: TOKEN } }));
  const result = await client.get("test");
  assert.equal(result.vncUrl, "");
  assert.equal(result.runtime.lastError, "[redacted]");
  await assert.rejects(createClient(config, async () => Response.json({ error: TOKEN }, { status: 401 })).get("test"), /rejected the token/);
  await assert.rejects(createClient(config, async () => new Response("x".repeat(2 * 1024 * 1024 + 1))).get("test"), /size limit/);
  await assert.rejects(createClient(config, async (_url, init) => { assert.equal(init.redirect, "error"); throw new Error(TOKEN); }).get("test"), (error) => !error.message.includes(TOKEN));
});

test("PR resolution uses the fork head, and branches with slashes survive the API request", async () => {
  const calls = [];
  const github = createGithub(async (url, init) => {
    calls.push(url);
    assert.equal(init.headers.Authorization, undefined, "preview token never reaches GitHub");
    return Response.json(url.includes("/pulls/") ? { head: { repo: { full_name: "Fork/Podman-Desktop" }, ref: "fix/issue" } } : { object: { sha: SHA } });
  });
  const source = await github.resolve("https://github.com/podman-desktop/podman-desktop/pull/42");
  assert.deepEqual(source, { repo: "fork/podman-desktop", branch: "fix/issue" });
  assert.equal(await github.pushed(source, true), SHA);
  assert.match(calls.at(-1), /heads\/fix%2Fissue$/);
  await github.pushed(source);
  assert.equal(calls.length, 2, "polls reuse the GitHub ref cache");
  await assert.rejects(github.resolve("https://github.com/a/b/pull/1", "main"), /Clear the branch/);
  assert.deepEqual(await github.resolve("https://github.com/a/b/tree/fix/slash"), { repo: "a/b", branch: "fix/slash" });
});

test("spec validation refuses detached defaults and accepts extension build options", async () => {
  const github = createGithub();
  const context = { ...SOURCE, branch: null };
  await assert.rejects(makeSpec(context, {}, github), /Detached HEAD/);
  const spec = await makeSpec(context, { source: "a/b", branch: "dev", kind: "extension", extensionBuild: "container", containerfile: "build/Containerfile" }, github);
  assert.equal(spec.mode, "dev");
  assert.equal(spec.autoUpdate, true);
  await assert.rejects(makeSpec(context, { source: "a/b", branch: "main", kind: "extension", extensionDir: "../secrets" }, github), /traversal/);
  await assert.rejects(makeSpec(context, { source: "a/b", branch: "main", containerfile: "Containerfile" }, github), /require kind extension/);
  assert.throws(() => parseOptions({ token: "never send this to the service" }), /Invalid preview option/);
  for (const branch of ["-main", "a..b", "a.lock", "a@{b", ".secret", "bad\nref", "a//b"]) {
    assert.equal(validBranch(branch), false, branch);
  }
});

test("preview defaults detect extension projects and preserve explicit choices", async () => {
  const github = createGithub();
  const base = { ...SOURCE, root: "/workspace/podman-desktop", head: SHA, dirty: false };
  const cases = [
    [base, "desktop"],
    [{ ...base, repo: "owner/Extension-example" }, "extension"],
    [{ ...base, root: "/workspace/my-extension/" }, "extension"],
    [{ ...base, root: "C:\\work\\My-Extension\\" }, "extension"],
    [{ ...base, repo: "extension-owner/podman-desktop", root: "/extensions/podman-desktop" }, "desktop"],
  ];
  for (const [context, kind] of cases) {
    const spec = await makeSpec(context, {}, github);
    assert.equal(spec.kind, kind);
    assert.equal(spec.mode, "dev");
  }
  const explicit = await makeSpec(cases[1][0], { kind: "desktop", mode: "compiled" }, github);
  assert.equal(explicit.kind, "desktop");
  assert.equal(explicit.mode, "compiled");
});

test("Git context detects the push remote, detached HEAD, and uncommitted files", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-preview-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "feature/test");
  git("-c", "user.name=Preview Test", "-c", "user.email=preview@example.test", "commit", "--allow-empty", "-m", "test");
  git("remote", "add", "origin", "git@github.com:Owner/Podman-Desktop.git");
  assert.equal((await getContext(dir)).repo, "owner/podman-desktop");
  git("remote", "add", "upstream", "https://github.com/upstream/podman-desktop.git");
  git("config", "branch.feature/test.remote", "upstream");
  git("config", "branch.feature/test.pushRemote", "origin");
  assert.equal((await getContext(dir)).repo, "owner/podman-desktop", "the preview follows the push remote, not upstream");
  await writeFile(join(dir, "changed.txt"), "uncommitted");
  assert.equal((await getContext(dir)).dirty, true);
  git("checkout", "--detach");
  assert.equal((await getContext(dir)).branch, null);
});
