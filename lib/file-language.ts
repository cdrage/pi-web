// Source and review share filename detection, including deleted files.
// HTML and Markdown enable Preview. Other templates use markup.
// Ambiguous extensions such as .m and .conf stay plain text.
const EXT_TO_LANGUAGE: Record<string, string> = {
  ts: "typescript", tsx: "tsx", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
  py: "python", rb: "ruby", php: "php", lua: "lua", pl: "perl", r: "r",
  go: "go", rs: "rust", java: "java", kt: "kotlin", kts: "kotlin", swift: "swift",
  scala: "scala", groovy: "groovy", gradle: "groovy", dart: "dart", zig: "zig",
  c: "c", cpp: "cpp", h: "c", hpp: "cpp", cs: "csharp", mm: "objectivec",
  ex: "elixir", exs: "elixir", hs: "haskell", ml: "ocaml", clj: "clojure", nix: "nix",
  html: "html", htm: "html", vue: "markup", svelte: "markup", astro: "markup",
  css: "css", scss: "scss", less: "less",
  json: "json", jsonl: "json", jsonc: "json5", yaml: "yaml", yml: "yaml", fmf: "yaml",
  toml: "toml", ini: "ini", cfg: "ini", properties: "properties",
  xml: "xml", svg: "xml", plist: "xml", nuspec: "xml", md: "markdown", mdx: "markdown", tex: "latex",
  sh: "bash", bash: "bash", zsh: "bash", fish: "bash",
  ps1: "powershell", psm1: "powershell", bat: "batch", cmd: "batch",
  sql: "sql", graphql: "graphql", gql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", containerfile: "dockerfile", tf: "hcl", hcl: "hcl", diff: "diff", patch: "diff",
  mustache: "mustache", nsh: "nsis", nsi: "nsis", desktop: "ini",
  env: "bash", gitignore: "bash", txt: "text",
  pdf: "pdf", docx: "word",
};

export function getLanguage(filePath: string): string {
  const base = (filePath.split(/[\\/]/).pop() ?? "").toLowerCase();
  // Match recipe names and suffix variants such as Containerfile.dev.
  if (/^(?:dockerfile|containerfile)(?:\.|$)/.test(base)) {
    return "dockerfile";
  }
  if (base === ".env" || base.startsWith(".env.")) {
    return "bash";
  }
  if (base === "makefile" || base === "gnumakefile") {
    return "makefile";
  }
  const ext = base.split(".").pop() ?? "";
  return EXT_TO_LANGUAGE[ext] ?? "text";
}
