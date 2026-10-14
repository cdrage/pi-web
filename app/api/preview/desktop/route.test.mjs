import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Script, createContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const script = new Script(ts.transpileModule(
  await readFile(new URL("./route.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ESNext } },
).outputText);

function fixture() {
  const calls = [];
  const modules = {
    "@/lib/preview-api": {
      previewCwd: async (cwd) => cwd,
      previewFailure: (error) => { throw error; },
    },
    "@/lib/preview-desktop": {
      previewDesktop: async (cwd, origin) => { calls.push({ cwd, origin }); return { url: origin }; },
    },
  };
  const compiled = { exports: {} };
  script.runInContext(createContext({
    module: compiled, exports: compiled.exports, URL, Response,
    require: (name) => { assert.ok(modules[name], `Unexpected dependency: ${name}`); return modules[name]; },
  }));
  return { GET: compiled.exports.GET, calls };
}

test("production desktop relays use the browser host instead of Next's internal hostname", async () => {
  const { GET, calls } = fixture();
  await GET(new Request("http://localhost:30141/api/preview/desktop?cwd=/project", {
    headers: { host: "127.0.0.1:30141" },
  }));
  assert.deepEqual(calls, [{ cwd: "/project", origin: "http://127.0.0.1:30141" }]);
});

test("desktop relays preserve localhost and use the URL when Host is absent", async () => {
  const { GET, calls } = fixture();
  await GET(new Request("http://localhost:30141/api/preview/desktop?cwd=/project"));
  assert.deepEqual(calls, [{ cwd: "/project", origin: "http://localhost:30141" }]);
});
