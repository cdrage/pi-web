import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import ts from "typescript";
import { createJiti } from "jiti";

const { desktopUrl } = await createJiti(import.meta.url).import("./preview-desktop-url.ts");
const PARENT = "http://127.0.0.1:30141";
const RELAY_URL = "http://127.0.0.1:12345/connect/existing?autoconnect=1&resize=scale";
const script = new Script(ts.transpileModule(
  await readFile(new URL("./preview-desktop.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } },
).outputText);

function fixture() {
  const config = { apiUrl: "https://preview.test", oidc: null };
  const session = { id: "desktop-one", vncReady: true,
    vncUrl: "https://desktop.test/vnc.html?path=desktop%2Fwebsockify&resize=scale", expiresAt: "2030-01-01T12:00:00Z" };
  const touches = [];
  const key = JSON.stringify([config.apiUrl, config.oidc, session.id, PARENT]);
  const modules = {
    "@earendil-works/pi-coding-agent": { getAgentDir: () => "/agent" },
    "../packages/pi-pd-preview/service": { createPreviewService: () => ({ status: async () => ({ session }) }) },
    "../packages/pi-pd-preview/storage": { readConfig: async () => config },
    "../packages/pi-pd-preview/oidc": {},
    "../packages/pi-pd-preview/oidc-config": {},
    "../packages/pi-pd-preview/model": { PreviewError: Error },
    "./preview-desktop-relay": { openDesktopRelay: () => assert.fail("Reconnect must reuse the live relay") },
    "./preview-desktop-url": { desktopUrl },
    "./key-serializer": { serializeByKey: (_lock, _key, work) => work() },
  };
  const compiled = { exports: {} };
  script.runInContext(createContext({
    module: compiled, exports: compiled.exports, URL,
    __piDesktopRelays: new Map([[key, { url: RELAY_URL, touch: (expiry) => touches.push(expiry) }]]),
    require: (name) => {
      assert.ok(modules[name], `Unexpected desktop dependency: ${name}`);
      return modules[name];
    },
  }));
  return { previewDesktop: compiled.exports.previewDesktop, touches, session };
}

test("Reconnect updates a cached relay without a replacement connection", async () => {
  const { previewDesktop, touches, session } = fixture();
  const { url } = await previewDesktop("/project", PARENT);
  const desktop = new URL(url);

  assert.equal(desktop.searchParams.get("resize"), "remote");
  assert.equal(desktop.origin, new URL(RELAY_URL).origin);
  assert.equal(desktop.pathname, new URL(RELAY_URL).pathname);
  assert.deepEqual(touches, [Date.parse(session.expiresAt)]);
});

test("direct embeds select remote resize and keep connection parameters", async () => {
  const { previewDesktop } = fixture();
  const { url } = await previewDesktop("/project", "https://pi-web.test");
  const desktop = new URL(url);

  assert.equal(desktop.searchParams.get("resize"), "remote");
  assert.equal(desktop.searchParams.get("path"), "desktop/websockify");
});
