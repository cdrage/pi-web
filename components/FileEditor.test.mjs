import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { Script, createContext } from "node:vm";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import ts from "typescript";

const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url);
const { loadPrismLanguages } = await jiti.import("../lib/prism-languages.ts");
const fileTypes = await jiti.import("../lib/file-types.ts");
await loadPrismLanguages();

const script = new Script(ts.transpileModule(
  await readFile(new URL("./FileEditor.tsx", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } },
).outputText);

function render(text, language, filePath = "/project/file.ts", dark = false, options = {}) {
  const compiled = { exports: {} };
  const modules = {
    "@/hooks/useFileDraft": { useFileDraft: () => ({ text, savedText: options.savedText ?? text, saving: options.saving ?? false }) },
    "@/hooks/useI18n": { useI18n: () => ({ t: (key) => key }) },
    "@/hooks/useTheme": { useTheme: () => ({ isDark: dark }) },
    "@/hooks/usePrismLanguages": { usePrismLanguages: () => true },
    "@/lib/file-edit-store": {},
    "@/lib/file-types": fileTypes,
    "./FileEditor.css": {},
  };
  script.runInContext(createContext({
    module: compiled,
    exports: compiled.exports,
    require: (name) => modules[name] ?? require(name),
  }));
  const component = compiled.exports[options.actions ? "FileEditActions" : "FileEditor"];
  return renderToStaticMarkup(React.createElement(component, { filePath, language, wrapLines: options.wrapLines ?? false, onClose() {} }));
}

test("editable Source colors TypeScript without replacing its textarea", () => {
  const html = render("const value: number = 42;", "typescript");
  assert.match(html, /source-editor-highlight/);
  assert.match(html, /class="token" style="color:[^"]+">const/);
  assert.match(html, /class="token builtin"/);
  assert.match(html, /<textarea[^>]*>const value: number = 42;<\/textarea>/);
});

test("editable Svelte colors script types, markup, and template blocks", () => {
  const html = render('<script lang="ts">let count: number = 1;</script>\n{#if count}<p>{count}</p>{/if}', "markup", "/project/App.svelte");
  assert.match(html, /class="token [^"]*builtin"[^>]*>number/);
  assert.match(html, /class="token" style="color:[^"]+">p<\/span>/);
  assert.match(html, /class="token [^"]*block-keyword" style="color:[^"]+">if/);
});

test("other known languages use their grammar and unknown files stay readable", () => {
  const samples = { python: "def count(): return 1", json: '{"count": 1}', yaml: "count: 1", css: "p { color: red }", bash: "echo true", rust: "let count = 1;" };
  for (const language of ["python", "json", "yaml", "css", "bash", "rust"]) {
    assert.match(render(samples[language], language), /class="token[" ]/, language);
  }
  const html = render("<script>plain text</script>", "unknown-language");
  assert.match(html, /&lt;script&gt;plain text&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("editor colors follow the light and dark themes", () => {
  const color = (dark) => render("const value = 1;", "typescript", "/project/file.ts", dark)
    .match(/class="token" style="color:([^"]+)">const/)[1];
  assert.notEqual(color(false), color(true));
});

test("editor soft wrap preserves logical lines and removes the longest-line width", () => {
  const text = `const value = "${"long text ".repeat(20)}";\n\n`;
  for (const language of ["typescript", "text", "unknown-language"]) {
    const html = render(text, language, "/project/file.ts", false, { wrapLines: true });
    assert.match(html, /class="source-editor is-wrapped"/);
    assert.match(html, /<textarea[^>]*wrap="soft"/);
    assert.doesNotMatch(html, /min-width:\d+ch/);
    assert.equal((html.match(/class="source-editor-line"/g) ?? []).length, 3, language);
    assert.match(html, /source-editor-gutter[^>]*><span>1<\/span><span>2<\/span><span>3<\/span>/);
  }
  assert.match(render(text, "typescript"), /<textarea[^>]*wrap="off"/);
});

test("editor toolbar uses labeled icons and preserves save states", () => {
  const actions = (options = {}) => render("draft", "text", "/project/file.ts", false, { actions: true, ...options });
  const html = actions({ savedText: "saved" });
  for (const label of ["files.editor.save", "files.editor.back"]) {
    assert.match(html, new RegExp(`<button[^>]*class="file-viewer-icon-button"[^>]*aria-label="${label}"[^>]*><svg`));
  }
  assert.doesNotMatch(html, /disabled/);
  assert.equal((actions().match(/disabled/g) ?? []).length, 1);
  assert.equal((actions({ saving: true }).match(/disabled/g) ?? []).length, 2);
});
