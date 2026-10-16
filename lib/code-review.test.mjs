import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  buildReviewTarget,
  commentOutdated,
  fileReviewTarget,
  formatReview,
  parseReviewPatch,
  patchId,
} = await jiti.import("./code-review.ts");

const patch = `--- a/app.ts
+++ b/app.ts
@@ -10,4 +10,4 @@
 keep
-old one
-old two
+new one
+new two
 tail
@@ -30 +30 @@
-later old
+later new
`;
const LARGE_REVIEW_LINES = 130_000;

test("keeps hunk boundaries, diff sides, and unified change order", () => {
  const lines = parseReviewPatch(patch);

  assert.deepEqual(lines.map(({ type }) => type), [
    "hunk", "context", "removed", "removed", "added", "added", "context",
    "hunk", "removed", "added",
  ]);
  assert.deepEqual(lines.slice(1, 7).map(({ oldLine, newLine }) => [oldLine, newLine]), [
    [10, 10], [11, null], [12, null], [null, 11], [null, 12], [13, 13],
  ]);
  assert.equal(new Set(lines.map(({ id }) => id)).size, lines.length);
  assert.notEqual(lines[0].hunk, lines[7].hunk);
  assert.deepEqual(parseReviewPatch("binary or empty patch"), []);
});

test("builds targets for context, deleted lines, additions, and mixed ranges", () => {
  const lines = parseReviewPatch(patch);
  const target = (first, last) => buildReviewTarget("/repo/app.ts", "app.ts", patch, lines, first, last);

  assert.deepEqual(target(1, 1), {
    filePath: "/repo/app.ts", path: "app.ts", patchId: patchId(patch),
    oldStart: null, oldEnd: null, newStart: 10, newEnd: 10, code: " keep",
  });
  assert.deepEqual(target(3, 0), {
    filePath: "/repo/app.ts", path: "app.ts", patchId: patchId(patch),
    oldStart: 10, oldEnd: 12, newStart: null, newEnd: null,
    code: " keep\n-old one\n-old two",
  });
  assert.equal(target(4, 6).newEnd, 13);
  assert.equal(target(4, 6).oldStart, null);
  assert.deepEqual(
    [target(1, 6).oldStart, target(1, 6).oldEnd, target(1, 6).newStart, target(1, 6).newEnd],
    [10, 13, 10, 13],
  );
  assert.equal(target(0, 0), null);
  assert.equal(target(-1, 2), null);
  assert.equal(target(1, lines.length), null);
  assert.equal(target(1.5, 2), null);
});

test("fingerprints patches and marks changed or unavailable targets outdated", () => {
  const target = fileReviewTarget("/repo/app.ts", "app.ts", patch);
  const comment = { id: "comment", target, body: "Explain this choice." };

  assert.equal(patchId(patch), patchId(patch));
  assert.notEqual(patchId(patch), patchId(`${patch} `));
  assert.equal(commentOutdated(comment, patch), false);
  assert.equal(commentOutdated(comment, `${patch} `), true);
  assert.equal(commentOutdated(comment, null), true);
  assert.deepEqual([target.oldStart, target.oldEnd, target.newStart, target.newEnd], [null, null, null, null]);
});

test("handles large selections without the argument limit for spread calls", () => {
  const lines = Array.from({ length: LARGE_REVIEW_LINES }, (_, index) => ({
    id: `line-${index}`, type: "context", text: "",
    oldLine: index + 1, newLine: index + 1, hunk: 1,
  }));
  lines[0] = { ...lines[0], type: "removed", newLine: null };
  lines[lines.length - 1] = { ...lines.at(-1), type: "added", oldLine: null };
  const target = buildReviewTarget("/repo/large.ts", "large.ts", "large patch", lines, 0, lines.length - 1);

  assert.deepEqual([target.oldStart, target.oldEnd, target.newStart, target.newEnd], [
    1, LARGE_REVIEW_LINES - 1, 2, LARGE_REVIEW_LINES,
  ]);
  assert.equal(target.code.split("\n").length, LARGE_REVIEW_LINES);
});

test("exports fresh comments in the compact Pi tuicr format", () => {
  const base = fileReviewTarget("/repo/path", "path", patch);
  const oldTarget = { ...base, oldStart: 234, oldEnd: 236, code: "-captured old code" };
  const newTarget = { ...base, newStart: 234, newEnd: 236, code: "+captured new code" };
  const lineTarget = { ...base, newStart: 234, newEnd: 234, code: "+captured line" };
  const state = {
    comments: [
      { id: "old", target: oldTarget, body: "foobar" },
      { id: "new", target: newTarget, body: "  First line\n\nSecond line  " },
      { id: "line", target: lineTarget, body: "Check this line." },
      { id: "file", target: base, body: "Check this file." },
    ],
    reviewed: {},
  };

  assert.equal(formatReview(state, { "/repo/path": patch }, "/repo"), [
    "Address these comments:",
    "",
    "1. `path:234-236` [OLD] - foobar",
    "",
    "   ```diff",
    "   -captured old code",
    "   ```",
    "2. `path:234-236` - First line Second line",
    "3. `path:234` - Check this line.",
    "4. `path` - Check this file.",
  ].join("\n"));
  assert.equal(formatReview({ comments: [], reviewed: {} }, {}, "/repo"), "");
});

test("exports the selected diff when a range includes deleted lines", () => {
  const lines = parseReviewPatch(patch);
  const target = buildReviewTarget("/repo/app.ts", "app.ts", patch, lines, 1, 6);
  const state = { comments: [{ id: "mixed", target, body: "Keep the validation." }], reviewed: {} };

  assert.equal(formatReview(state, { [target.filePath]: patch }, "/repo"), [
    "Address these comments:",
    "",
    "1. `app.ts:10-13` [OLD], `app.ts:10-13` [NEW] - Keep the validation.",
    "",
    "   ```diff",
    "    keep",
    "   -old one",
    "   -old two",
    "   +new one",
    "   +new two",
    "    tail",
    "   ```",
  ].join("\n"));
});

test("includes the original code for a comment on a deleted file", () => {
  const deletedPatch = "--- a/RELEASE.md\n+++ /dev/null\n@@ -7,2 +6,0 @@\n-Release notes\n-Removed instructions\n";
  const lines = parseReviewPatch(deletedPatch);
  const target = buildReviewTarget("/repo/RELEASE.md", "RELEASE.md", deletedPatch, lines, 1, 2);
  const state = { comments: [{ id: "deleted", target, body: "foobar" }], reviewed: {} };

  assert.equal(formatReview(state, { [target.filePath]: deletedPatch }, "/repo"), [
    "Address these comments:",
    "",
    "1. `RELEASE.md:7-8` [OLD] - foobar",
    "",
    "   ```diff",
    "   -Release notes",
    "   -Removed instructions",
    "   ```",
  ].join("\n"));
});

test("deleted Markdown fences stay inside the captured diff block", () => {
  const target = {
    ...fileReviewTarget("/repo/RELEASE.md", "RELEASE.md", patch),
    oldStart: 7, oldEnd: 9, code: "-```ts\n-const previous = true;\n-```",
  };
  const state = { comments: [{ id: "markdown", target, body: "Keep this example." }], reviewed: {} };

  assert.ok(formatReview(state, { [target.filePath]: patch }, "/repo").endsWith([
    "   ````diff",
    "   -```ts",
    "   -const previous = true;",
    "   -```",
    "   ````",
  ].join("\n")));
});

test("captured code stays within a numbered item after the ninth comment", () => {
  const base = fileReviewTarget("/repo/app.ts", "app.ts", patch);
  const comments = Array.from({ length: 9 }, (_, index) => ({ id: `file-${index}`, target: base, body: "File comment." }));
  comments.push({ id: "deleted", target: { ...base, oldStart: 11, oldEnd: 11, code: "-old one" }, body: "Explain this deletion." });

  assert.ok(formatReview({ comments, reviewed: {} }, { [base.filePath]: patch }, "/repo").endsWith([
    "10. `app.ts:11` [OLD] - Explain this deletion.",
    "",
    "    ```diff",
    "    -old one",
    "    ```",
  ].join("\n")));
});

test("omits comments on changed files and renumbers current comments", () => {
  const oldTarget = fileReviewTarget("/repo/old.ts", "old.ts", patch);
  const target = fileReviewTarget("/repo/app.ts", "app.ts", patch);
  const state = {
    comments: [
      { id: "old", target: oldTarget, body: "Discard this comment." },
      { id: "current", target, body: "Keep this validation." },
    ],
    reviewed: {},
  };

  assert.equal(formatReview(state, {
    [oldTarget.filePath]: `${patch} `,
    [target.filePath]: patch,
  }, "/repo"), [
    "Address these comments:",
    "",
    "1. `app.ts` - Keep this validation.",
  ].join("\n"));
});

test("exports nothing when every comment belongs to an old or unavailable diff", () => {
  const target = fileReviewTarget("/repo/app.ts", "app.ts", patch);
  const state = { comments: [{ id: "old", target, body: "Discard this comment." }], reviewed: {} };

  for (const current of [`${patch} `, "", null, undefined]) {
    const patches = current === undefined ? {} : { [target.filePath]: current };
    assert.equal(formatReview(state, patches, "/repo"), "");
  }
});

test("exports relative paths and leaves paths outside the destination cwd absolute", () => {
  const target = fileReviewTarget("/repo/src/app.ts", "app.ts", patch);
  const state = { comments: [{ id: "subfolder", target, body: "Explain this module." }], reviewed: {} };

  assert.ok(formatReview(state, { [target.filePath]: patch }, "/repo").endsWith("1. `src/app.ts` - Explain this module."));
  assert.ok(formatReview(state, { [target.filePath]: patch }, "/repo/src").endsWith("1. `app.ts` - Explain this module."));
  assert.ok(formatReview(state, { [target.filePath]: patch }, "/repo-worktree").endsWith("1. `/repo/src/app.ts` - Explain this module."));
});

test("protects inline anchors with backticks and newline characters", () => {
  const target = fileReviewTarget("/repo/weird``\nname.ts", "ignored", patch);
  const edgeTarget = fileReviewTarget("/repo/`edge`", "ignored", patch);
  const state = {
    comments: [
      { id: "weird", target, body: "First line\r\nSecond line." },
      { id: "edge", target: edgeTarget, body: "Explain this path." },
    ],
    reviewed: {},
  };

  assert.equal(formatReview(state, { [target.filePath]: patch, [edgeTarget.filePath]: patch }, "/repo"), [
    "Address these comments:",
    "",
    "1. ```weird``\\nname.ts``` - First line Second line.",
    "2. `` `edge` `` - Explain this path.",
  ].join("\n"));
});
