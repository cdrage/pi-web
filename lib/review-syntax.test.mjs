import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadPrismLanguages } = await jiti.import("./prism-languages.ts");
const { parseReviewPatch } = await jiti.import("./code-review.ts");
const { getLanguage } = await jiti.import("./file-language.ts");
const { highlightReviewLines } = await jiti.import("./review-syntax.ts");
await loadPrismLanguages();

function highlight(patch, language = "typescript") {
  const lines = parseReviewPatch(patch);
  const tokens = highlightReviewLines(lines, language);
  for (const [index, row] of tokens) {
    assert.equal(row.map((token) => token.text).join(""), lines[index].text, "Tokens preserve exact code");
  }
  return lines.map((line, index) => ({ ...line, tokens: tokens.get(index) ?? [] }));
}

test("colors both sides without mixing multiline comments or later hunks", () => {
  const rows = highlight(`@@ -1,5 +1,4 @@
 export const label = "review";
-/* old comment
- * old body
- */
+const next = 1;
+// new body
 export const end = true;
@@ -20 +20 @@
-const old = 1;
+const next = 2;
`);
  assert.ok(rows.find((row) => row.text === " * old body").tokens.some((token) => token.classes.includes("comment")));
  for (const row of rows.filter((line) => /^(?:export |const )/.test(line.text))) {
    assert.ok(row.tokens.some((token) => token.classes.includes("keyword")), row.text);
  }
  assert.ok(rows.filter((line) => line.type === "hunk").every((line) => line.tokens.length === 0));
});

test("keeps nested Svelte script tokens and multiline template strings", () => {
  const rows = highlight(`@@ -0,0 +1,6 @@
+<script lang="ts">
+  const label: string = \`first
+second\`;
+</script>
+{#if label}
+<b>{label}</b>
`, "svelte");
  assert.ok(rows[2].tokens.some((token) => token.text === "const" && token.classes.includes("keyword")));
  assert.ok(rows[3].tokens.some((token) => token.text.includes("second") && token.classes.includes("string")));
  assert.ok(rows[5].tokens.some((token) => token.text === "if" && token.classes.includes("keyword")));
});

test("separate hunks reset incomplete tokens and preserve blank lines and tabs", () => {
  const rows = highlight("@@ -0,0 +1,2 @@\n+/* unfinished\n+\n@@ -0,0 +20,2 @@\n+\tconst count = 2;\n+\n");
  assert.ok(rows[4].tokens.some((token) => token.classes.includes("keyword")));
  assert.deepEqual(rows[2].tokens, []);
  assert.deepEqual(rows[5].tokens, []);
});

test("plain, unknown, and oversized hunks fall back without losing later colors", () => {
  const patch = "@@ -1 +1 @@\n-old\n+const next = 1;\n";
  for (const language of ["text", "unregistered"]) {
    assert.ok(highlight(patch, language).every((line) => line.tokens.length === 0));
  }
  const rows = highlight(`@@ -0,0 +1 @@\n+${"x".repeat(100_001)}\n@@ -0,0 +10 @@\n+const count = 1;\n`);
  assert.equal(rows[1].tokens.length, 0);
  assert.ok(rows[3].tokens.some((token) => token.classes.includes("keyword")));
});

test("a deleted file keeps syntax colors and markup stays literal text", () => {
  const rows = highlight('--- a/old.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const label = "<img src=x onerror=alert(1)>";\n-\n');
  assert.ok(rows[1].tokens.some((token) => token.classes.includes("string") && token.text.includes("<img")));
});

test("Podman Desktop source formats and recipe filenames produce syntax tokens", () => {
  const samples = [
    ["main.ts", "typescript", 'export const title: string = "hello";'],
    ["view.tsx", "tsx", 'const view = <p title="hello" />;'],
    ["main.mjs", "javascript", 'export const title = "hello";'],
    ["main.cjs", "javascript", 'const title = "hello";'],
    ["style.css", "css", "p { color: red; }"],
    ["config.json", "json", '{ "enabled": true }'],
    ["config.jsonc", "json5", '// Comment\n{ "enabled": true }'],
    ["workflow.yaml", "yaml", "name: review"],
    ["main.fmf", "yaml", "test: ./test.sh"],
    ["README.md", "markdown", "# Review\n**bold**"],
    ["guide.mdx", "markdown", "# Guide\n<Component />"],
    ["run.sh", "bash", 'echo "hello"'],
    ["run.ps1", "powershell", 'Write-Host "hello"'],
    ["icon.svg", "xml", '<svg xmlns="http://www.w3.org/2000/svg" />'],
    ["Info.plist", "xml", "<plist><dict /></plist>"],
    ["package.nuspec", "xml", "<package><metadata /></package>"],
    ["template.mustache", "mustache", "<p>{{title}}</p>"],
    ["installer.nsh", "nsis", 'Name "Podman Desktop"'],
    ["app.desktop", "ini", "[Desktop Entry]\nName=Podman Desktop"],
    ["Dockerfile", "dockerfile", "FROM alpine:latest"],
    ["Containerfile", "dockerfile", "FROM alpine:latest"],
    ["Containerfile.dev", "dockerfile", "FROM alpine:latest"],
    ["hello.containerfile", "dockerfile", "FROM alpine:latest"],
    ["C:\\project\\DOCKERFILE.dev", "dockerfile", "FROM alpine:latest"],
  ];
  for (const [name, expected, source] of samples) {
    const language = getLanguage(name);
    assert.equal(language, expected, name);
    const lines = source.split("\n");
    const patch = `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
    assert.ok(highlight(patch, language).some((line) => line.tokens.some((token) => token.classes.includes("token"))), name);
  }
  for (const name of ["unknown.extension", "containers.conf", "plot.m"]) {
    assert.equal(getLanguage(name), "text", name);
  }
});
