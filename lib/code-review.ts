import { parseUnifiedPatch } from "./patch";
import { getRelativeFilePath } from "./file-paths";

export interface ReviewLine {
  id: string;
  type: "hunk" | "context" | "removed" | "added";
  text: string;
  oldLine: number | null;
  newLine: number | null;
  hunk: number;
}

export interface ReviewTarget {
  filePath: string;
  path: string;
  patchId: string;
  oldStart: number | null;
  oldEnd: number | null;
  newStart: number | null;
  newEnd: number | null;
  code: string;
}

export interface ReviewComment {
  id: string;
  target: ReviewTarget;
  body: string;
}

export interface ReviewState {
  comments: ReviewComment[];
  reviewed: Record<string, string>;
}

const HASH_OFFSET = 0x811c9dc5;
const HASH_PRIME = 0x01000193;
const HEX_RADIX = 16;
const HASH_HEX_LENGTH = 8;
const MIN_INLINE_LENGTH = 1;
const MIN_FENCE_LENGTH = 3;
const REVIEW_PROMPT_HEADER = "Address these comments:";
const LINE_PREFIX = { context: " ", removed: "-", added: "+" } as const;

type CodeLine = ReviewLine & { type: keyof typeof LINE_PREFIX };

export function patchId(patch: string): string {
  let hash = HASH_OFFSET;
  for (let index = 0; index < patch.length; index++) {
    hash = Math.imul(hash ^ patch.charCodeAt(index), HASH_PRIME);
  }
  return `${(hash >>> 0).toString(HEX_RADIX).padStart(HASH_HEX_LENGTH, "0")}:${patch.length}`;
}

export function parseReviewPatch(patch: string): ReviewLine[] {
  const lines: ReviewLine[] = [];
  let hunk = 0;
  const append = (type: ReviewLine["type"], text: string, oldLine: number | null, newLine: number | null) => {
    lines.push({ id: `line-${lines.length}`, type, text, oldLine, newLine, hunk });
  };

  for (const file of parseUnifiedPatch(patch) ?? []) {
    const removed: Array<{ text: string; line: number | null }> = [];
    const added: Array<{ text: string; line: number | null }> = [];
    const flush = () => {
      // The split parser pairs changes. Restore unified order for range selection.
      for (const line of removed) {
        append("removed", line.text, line.line, null);
      }
      for (const line of added) {
        append("added", line.text, null, line.line);
      }
      removed.length = 0;
      added.length = 0;
    };

    for (const row of file.rows) {
      // Hunk headers already mark omitted context in the review.
      if (row.type === "gap") {
        flush();
        continue;
      }

      if (row.type === "hunk") {
        flush();
        if (row.text.startsWith("@@ ")) {
          hunk++;
        }
        append("hunk", row.text, null, null);
        continue;
      }
      if (row.left.type === "context" && row.right.type === "context") {
        flush();
        append("context", row.right.text, row.left.lineNo, row.right.lineNo);
        continue;
      }
      if (row.left.type === "removed") {
        removed.push({ text: row.left.text, line: row.left.lineNo });
      }
      if (row.right.type === "added") {
        added.push({ text: row.right.text, line: row.right.lineNo });
      }
    }
    flush();
  }

  return lines;
}

export function fileReviewTarget(filePath: string, path: string, patch: string): ReviewTarget {
  return {
    filePath, path, patchId: patchId(patch),
    oldStart: null, oldEnd: null, newStart: null, newEnd: null, code: "",
  };
}

export function buildReviewTarget(
  filePath: string,
  path: string,
  patch: string,
  lines: ReviewLine[],
  startIndex: number,
  endIndex: number,
): ReviewTarget | null {
  const start = Math.min(startIndex, endIndex);
  const end = Math.max(startIndex, endIndex);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= lines.length) {
    return null;
  }

  const selected = lines.slice(start, end + 1).filter((line): line is CodeLine => line.type !== "hunk");
  if (selected.length === 0) {
    return null;
  }
  const hasRemoved = selected.some((line) => line.type === "removed");
  const hasAdded = selected.some((line) => line.type === "added");
  const oldLines = hasRemoved ? selected.flatMap((line) => line.oldLine === null ? [] : [line.oldLine]) : [];
  const newLines = hasAdded || !hasRemoved ? selected.flatMap((line) => line.newLine === null ? [] : [line.newLine]) : [];
  const [oldStart, oldEnd] = lineRange(oldLines);
  const [newStart, newEnd] = lineRange(newLines);

  return {
    ...fileReviewTarget(filePath, path, patch),
    oldStart, oldEnd, newStart, newEnd,
    code: selected.map((line) => `${LINE_PREFIX[line.type]}${line.text}`).join("\n"),
  };
}

function lineRange(lines: number[]): [number | null, number | null] {
  if (lines.length === 0) {
    return [null, null];
  }
  return lines.reduce(([start, end], line) => [Math.min(start, line), Math.max(end, line)], [lines[0], lines[0]]);
}

export function commentOutdated(comment: ReviewComment, patch: string | null): boolean {
  return !patch || comment.target.patchId !== patchId(patch);
}

function codeMarker(text: string, minimum: number): string {
  const runs = text.match(/`+/g) ?? [];
  const length = runs.reduce((longest, run) => Math.max(longest, run.length + 1), minimum);
  return "`".repeat(length);
}

function inlineCode(text: string): string {
  const escaped = text.replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t");
  const marker = codeMarker(escaped, MIN_INLINE_LENGTH);
  // Padding keeps a path's edge backticks separate from its delimiters.
  const padding = /^[` ]|[` ]$/.test(escaped) ? " " : "";
  return `${marker}${padding}${escaped}${padding}${marker}`;
}

function rangeAnchor(path: string, start: number | null, end: number | null): string | null {
  if (start === null || end === null) {
    return null;
  }
  return inlineCode(`${path}:${start === end ? start : `${start}-${end}`}`);
}

function targetAnchor(target: ReviewTarget, cwd: string): string {
  const path = getRelativeFilePath(target.filePath, cwd);
  const old = rangeAnchor(path, target.oldStart, target.oldEnd);
  const current = rangeAnchor(path, target.newStart, target.newEnd);
  if (old && current) {
    return `${old} [OLD], ${current} [NEW]`;
  }
  if (old) {
    return `${old} [OLD]`;
  }
  return current ?? inlineCode(path);
}

function deletedCode(target: ReviewTarget, indent: string): string {
  if (target.oldStart === null || !target.code) {
    return "";
  }

  // Deleted lines are absent from the working file, so the prompt carries them.
  const fence = codeMarker(target.code, MIN_FENCE_LENGTH);
  const code = target.code.split("\n").map((line) => `${indent}${line}`).join("\n");
  return `\n\n${indent}${fence}diff\n${code}\n${indent}${fence}`;
}

export function formatReview(state: ReviewState, currentPatches: Record<string, string | null>, cwd: string): string {
  const items: string[] = [];
  for (const comment of state.comments) {
    const { target } = comment;
    if (commentOutdated(comment, currentPatches[target.filePath] ?? null)) {
      continue;
    }

    const body = comment.body.trim().replace(/[\r\n]+/g, " ");
    const prefix = `${items.length + 1}. `;
    const code = deletedCode(target, " ".repeat(prefix.length));
    items.push(`${prefix}${targetAnchor(target, cwd)} - ${body}${code}`);
  }

  return items.length ? `${REVIEW_PROMPT_HEADER}\n\n${items.join("\n")}` : "";
}
