import { refractor } from "refractor/core";
import type { Element, Text } from "hast";
import type { ReviewLine } from "./code-review";

interface ReviewToken {
  text: string;
  classes: string[];
}

const HUNK_HIGHLIGHT_MAX_CHARS = 100_000;

function splitTokens(nodes: Array<Element | Text>): ReviewToken[][] {
  const rows: ReviewToken[][] = [[]];

  function visit(node: Element | Text, classes: string[]) {
    if (node.type === "element") {
      const own = (node.properties.className ?? []) as string[];
      for (const child of node.children) {
        if (child.type === "element" || child.type === "text") {
          visit(child, [...classes, ...own]);
        }
      }
      return;
    }

    // Carry parent token classes across newlines, including nested script tokens.
    const parts = node.value.split("\n");
    parts.forEach((text, index) => {
      if (index > 0) {
        rows.push([]);
      }
      if (text) {
        rows[rows.length - 1].push({ text, classes });
      }
    });
  }

  for (const node of nodes) {
    visit(node, []);
  }
  return rows;
}

export function highlightReviewLines(lines: ReviewLine[], language: string): Map<number, ReviewToken[]> {
  const result = new Map<number, ReviewToken[]>();
  if (language === "text" || !refractor.registered(language)) {
    return result;
  }

  // Tokenize each hunk's old and new source separately. Omitted context resets state.
  let start = 0;
  while (start < lines.length) {
    if (lines[start].type === "hunk") {
      start++;
      continue;
    }
    let end = start;
    let size = 0;
    while (end < lines.length && lines[end].type !== "hunk") {
      size += lines[end].text.length + 1;
      end++;
    }
    const indices = Array.from({ length: end - start }, (_, index) => start + index);
    start = end;
    if (size > HUNK_HIGHLIGHT_MAX_CHARS) {
      continue;
    }

    for (const side of ["old", "new"] as const) {
      const sourceRows = indices.filter((index) => lines[index].type !== (side === "old" ? "added" : "removed"));
      if (!sourceRows.length) {
        continue;
      }
      const source = sourceRows.map((index) => lines[index].text).join("\n");
      try {
        const tokens = splitTokens(refractor.highlight(source, language).children as Array<Element | Text>);
        sourceRows.forEach((index, row) => {
          // Context uses the new side. Deleted lines retain the old side's grammar state.
          if (side === "new" || lines[index].type === "removed") {
            result.set(index, tokens[row]);
          }
        });
      } catch {
        // A grammar failure leaves this side readable as plain text.
      }
    }
  }
  return result;
}
