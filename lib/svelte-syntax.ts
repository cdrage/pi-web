import type { GrammarValue, TokenObject } from "prismjs";
import type { Refractor } from "refractor/core";

/** Add Svelte expressions to markup and use TypeScript inside script tags. */
export default function svelte(prism: Refractor) {
  const expression: TokenObject = {
    pattern: /\{(?:[^{}"'`]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\{(?:[^{}]|\{[^{}]*\})*\})*\}/,
    greedy: true,
    inside: {
      "block-keyword": {
        pattern: /(^\{[#:/*@])(?:if|else|each|as|await|then|catch|key|snippet|html|debug|const|render|attach)\b/,
        lookbehind: true,
        alias: "keyword",
      },
      "block-punctuation": { pattern: /^\{[#:/*@]?|\}$/, alias: "punctuation" },
      rest: prism.languages.typescript,
    },
  };

  // Script and style bodies take precedence over template expressions.
  const grammar = prism.languages.extend("markup", {
    script: {
      pattern: /(<script\b[^>]*>)[\s\S]*?(?=<\/script\s*>)/i,
      lookbehind: true,
      greedy: true,
      alias: "language-typescript",
      inside: prism.languages.typescript,
    },
  });
  const tag = (grammar as Record<string, GrammarValue>).tag as TokenObject;
  tag.inside = { "svelte-expression": expression, ...tag.inside };
  prism.languages.svelte = grammar;
  prism.languages.insertBefore("svelte", "tag", { "svelte-expression": expression });
}

svelte.displayName = "svelte";
