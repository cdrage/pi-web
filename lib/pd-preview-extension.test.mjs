import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url);
const { createPreviewExtension, previewText } = await jiti.import("../packages/pi-pd-preview/extension.ts");
const { previewExtension, previewPolicy } = await jiti.import("./pd-preview.ts");

const snapshot = {
  configured: true,
  context: { root: "/worktree", repo: "owner/repo", branch: "fix", head: "local-sha", dirty: true },
  binding: { spec: { repo: "owner/repo", branch: "fix" } },
  session: {
    id: "preview", phase: "failed", vncReady: true, vncUrl: "https://preview.example.test/",
    expiresAt: "2030-01-01T00:00:00Z", runtime: { appliedCommit: "old-sha", lastError: "build failed" },
  },
  pushedCommit: "pushed-sha", freshness: "failed", expired: false,
};

async function fixture(t, configured = true) {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-preview-extension-"));
  t.after(() => rm(agentDir, { force: true, recursive: true }));
  if (configured) {
    await writeFile(join(agentDir, "pd-preview.json"), JSON.stringify({ apiUrl: "http://preview.test", token: "test-only" }));
  }
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const messages = [];
  const statuses = [];
  const notices = [];
  const actions = [];
  const pi = {
    on(name, fn) { handlers.set(name, fn); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand(name, command) { commands.set(name, command); },
    sendMessage(message) { messages.push(message); },
  };
  const ctx = {
    cwd: "/worktree", hasUI: false,
    ui: { setStatus(...args) { statuses.push(args); }, notify(...args) { notices.push(args); }, confirm: async () => true },
  };
  const service = {
    status: async () => snapshot,
    action: async (...args) => { actions.push(args); return snapshot; },
    logs: async () => ["preview log"],
  };
  return { agentDir, handlers, tools, commands, messages, statuses, notices, actions, pi, ctx, service };
}

test("the portable package loads through Pi's real extension loader", async (t) => {
  const { agentDir } = await fixture(t, false);
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) { delete process.env.PI_CODING_AGENT_DIR; }
    else { process.env.PI_CODING_AGENT_DIR = previous; }
  });
  const path = fileURLToPath(new URL("../packages/pi-pd-preview/index.ts", import.meta.url));
  const loader = new DefaultResourceLoader({
    cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(), additionalExtensionPaths: [path],
    extensionFactories: [previewExtension(agentDir)],
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  const owners = result.extensions.filter((extension) => extension.commands.has("preview"));
  assert.equal(owners.length, 1, "an installed package replaces the web default");
  assert.equal(owners[0].tools.size, 7);
  assert.equal(owners[0].tools.get("pd_preview_reset").definition.annotations.destructiveHint, true);
});

test("unconfigured tools remain registered but inactive", async (t) => {
  const f = await fixture(t, false);
  await createPreviewExtension({ agentDir: f.agentDir, service: f.service })(f.pi);
  assert.equal(f.tools.size, 7);
  assert.ok([...f.tools.values()].every((tool) => tool.defaultActive === false));
  assert.equal(f.tools.get("pd_preview_status").annotations.readOnlyHint, true);
  assert.equal(f.tools.get("pd_preview_sync").annotations.readOnlyHint, false);
});

test("commands and tools share the same service, with source options and markdown links", async (t) => {
  const f = await fixture(t);
  await createPreviewExtension({ agentDir: f.agentDir, service: f.service })(f.pi);
  await f.commands.get("preview").handler("start https://github.com/a/b/pull/42", f.ctx);
  assert.deepEqual(f.actions[0], ["/worktree", "start", { source: "https://github.com/a/b/pull/42" }]);
  assert.match(f.messages[0].content, /\[Open Desktop\]\(<https:\/\/preview\.example\.test\/>\)/);
  await f.tools.get("pd_preview_sync").execute("call", {}, undefined, undefined, f.ctx);
  assert.equal(f.actions[1][1], "sync");
  assert.match(previewText(snapshot), /Applied: old-sha/);
  assert.match(previewText(snapshot), /Error: build failed/);
  assert.match(previewText(snapshot), /Local files never upload/);
  f.handlers.get("session_shutdown")();
  assert.equal(f.actions.some((action) => action[1] === "stop"), false, "closing Pi never deletes a preview");
});

test("read-only sessions block mutations from commands and nested tool execution", async (t) => {
  const f = await fixture(t);
  await createPreviewExtension({ agentDir: f.agentDir, service: f.service, canMutate: () => false })(f.pi);
  await assert.rejects(f.tools.get("pd_preview_reset").execute("call", {}, undefined, undefined, f.ctx), /read-only/);
  await f.commands.get("preview").handler("sync", f.ctx);
  assert.match(f.notices[0][0], /read-only/);
  await f.tools.get("pd_preview_status").execute("call", {}, undefined, undefined, f.ctx);
  assert.equal(f.actions.length, 0);
});

test("Reset asks the interactive user before a command deletes storage", async (t) => {
  const f = await fixture(t);
  f.ctx.hasUI = true;
  f.ctx.ui.confirm = async () => false;
  await createPreviewExtension({ agentDir: f.agentDir, service: f.service })(f.pi);
  await f.commands.get("preview").handler("reset", f.ctx);
  assert.equal(f.actions.length, 0);
});

test("the web adapter reads the latest read-only pin before a mutation", async (t) => {
  const f = await fixture(t);
  await previewExtension(f.agentDir).factory(f.pi);
  f.ctx.sessionManager = { getEntries: () => [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read", "grep", "ls"] } }] };
  await assert.rejects(f.tools.get("pd_preview_reset").execute("call", {}, undefined, undefined, f.ctx), /read-only/);
});

test("the tool policy survives replacement by the installed CLI package", async (t) => {
  const f = await fixture(t);
  await createPreviewExtension({ agentDir: f.agentDir, service: f.service })(f.pi);
  previewPolicy().factory(f.pi);
  let entries = [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read"] } }];
  f.ctx.sessionManager = { getEntries: () => entries };
  const guard = f.handlers.get("tool_call");
  assert.equal(guard({ toolName: "pd_preview_reset" }, f.ctx).block, true);
  assert.equal(guard({ toolName: "pd_preview_status" }, f.ctx), undefined);
  assert.equal(guard({ toolName: "bash" }, f.ctx), undefined);
  entries = [];
  assert.equal(guard({ toolName: "pd_preview_reset" }, f.ctx), undefined);
});
