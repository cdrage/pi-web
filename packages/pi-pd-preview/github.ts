import { DEFAULT_PREVIEW_MODE, detectPreviewKind, parseRepo, PreviewError, UPDATE_INTERVAL_SECONDS, validBranch, type PreviewOptions, type PreviewSource, type PreviewContext, type PreviewSpec } from "./model";
import { readResponse, type Fetcher } from "./client";

const GITHUB_TIMEOUT_MS = 10_000;
const REF_CACHE_MS = 60_000;
const MAX_CACHED_REFS = 100;
const refs = new Map<string, { until: number; value: Promise<string | null> }>();

export function createGithub(fetcher: Fetcher = fetch) {
  async function get(path: string): Promise<unknown> {
    const response = await fetcher(`https://api.github.com/repos/${path}`, {
      headers: { Accept: "application/vnd.github+json" },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new PreviewError(`GitHub returned HTTP ${response.status}. Use a public repository and an existing branch.`);
    }
    return readResponse(response);
  }

  async function resolve(source: string, branch?: string): Promise<PreviewSource> {
    const pr = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/.exec(source);
    if (pr) {
      if (branch) {
        throw new PreviewError("A pull request URL supplies its own branch. Clear the branch field.");
      }
      const data = await get(`${parseRepo(pr[1])}/pulls/${pr[2]}`) as {
        head?: { ref?: string; repo?: { full_name?: string } };
      };
      if (!data.head?.repo?.full_name || !data.head.ref) {
        throw new PreviewError("The pull request head repository is unavailable.");
      }
      return resolve(data.head.repo.full_name, data.head.ref);
    }
    const tree = /^(?:https:\/\/)?github\.com\/([\w.-]+\/[\w.-]+)\/tree\/(.+)$/.exec(source);
    const repo = parseRepo(tree ? tree[1] : source);
    const ref = branch || (tree ? tree[2] : "");
    if (!validBranch(ref)) {
      throw new PreviewError("Provide a valid branch. Detached HEAD requires an explicit source and branch.");
    }
    return { repo, branch: ref };
  }

  async function pushed(source: PreviewSource, fresh = false): Promise<string | null> {
    const key = `${source.repo}/${source.branch}`;
    const cached = refs.get(key);
    if (!fresh && cached && cached.until > Date.now()) {
      return cached.value;
    }
    const value = get(`${source.repo}/git/ref/heads/${encodeURIComponent(source.branch)}`)
      .then((data) => {
        const sha = (data as { object?: { sha?: unknown } }).object?.sha;
        return typeof sha === "string" && /^[a-f\d]{40,64}$/.test(sha) ? sha : null;
      })
      .catch(() => null);
    if (refs.size >= MAX_CACHED_REFS) {
      refs.delete(refs.keys().next().value!);
    }
    refs.set(key, { until: Date.now() + REF_CACHE_MS, value });
    return value;
  }
  return { resolve, pushed };
}

export function parseOptions(value: unknown): PreviewOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PreviewError("Preview options must be an object.");
  }
  const fields = value as Record<string, unknown>;
  const strings = new Set(["source", "branch", "extensionDir", "containerfile", "desktopRepo", "desktopBranch"]);
  const booleans = new Set(["autoUpdate", "includeK8s", "rootful"]);
  const enums: Record<string, string[]> = {
    kind: ["desktop", "extension"], mode: ["dev", "compiled"], extensionBuild: ["pnpm", "container"],
  };
  for (const [key, entry] of Object.entries(fields)) {
    if (strings.has(key) && typeof entry === "string" && entry.length <= 1024) {
      continue;
    }
    if (booleans.has(key) && typeof entry === "boolean") {
      continue;
    }
    if (enums[key]?.includes(entry as string)) {
      continue;
    }
    throw new PreviewError(`Invalid preview option: ${key}.`);
  }
  return fields as PreviewOptions;
}

export async function makeSpec(
  context: PreviewContext,
  options: PreviewOptions,
  github: ReturnType<typeof createGithub>,
): Promise<PreviewSpec> {
  const source = options.source || context.repo;
  if (!source) {
    throw new PreviewError("Provide a GitHub repository or pull request URL.");
  }
  // An explicit URL supplies its branch. A local source uses the checkout branch.
  const branch = options.branch || (options.source ? undefined : context.branch ?? undefined);
  const resolved = await github.resolve(source, branch);
  const kind = options.kind ?? detectPreviewKind(context);
  const spec: PreviewSpec = {
    ...resolved,
    kind,
    mode: options.mode ?? DEFAULT_PREVIEW_MODE,
    autoUpdate: options.autoUpdate ?? true,
    updateInterval: UPDATE_INTERVAL_SECONDS,
    includeK8s: options.includeK8s ?? false,
    rootful: options.rootful ?? false,
  };
  const hasExtensionOptions = options.extensionBuild || options.extensionDir || options.containerfile || options.desktopRepo || options.desktopBranch;
  if (kind === "desktop" && hasExtensionOptions) {
    throw new PreviewError("Extension build options require kind extension.");
  }
  if (kind === "desktop") {
    return spec;
  }
  spec.extensionBuild = options.extensionBuild ?? "pnpm";
  for (const name of ["extensionDir", "containerfile"] as const) {
    const path = options[name];
    if (!path) {
      continue;
    }
    if (path.startsWith("/") || /[\\\x00\r\n]/.test(path) || path.split("/").some((part) => !part || part === ".." || part === ".") && path !== ".") {
      throw new PreviewError(`${name} must be a relative path without traversal.`);
    }
    spec[name] = path;
  }
  if (spec.containerfile && spec.extensionBuild !== "container") {
    throw new PreviewError("A Containerfile requires the container build method.");
  }
  if (options.desktopRepo || options.desktopBranch) {
    spec.desktop = await github.resolve(options.desktopRepo || "podman-desktop/podman-desktop", options.desktopBranch || "main");
  }
  return spec;
}
