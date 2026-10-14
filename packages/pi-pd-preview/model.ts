export const PREVIEW_ACTIONS = ["start", "sync", "reset", "touch", "stop"] as const;
export const PREVIEW_HTTP = {
  badRequest: 400,
  notFound: 404,
  conflict: 409,
  internalError: 500,
  badGateway: 502,
} as const;
export const UPDATE_INTERVAL_SECONDS = 30;
export const DEFAULT_PREVIEW_MODE = "dev";
export type PreviewAction = typeof PREVIEW_ACTIONS[number];
export type PreviewKind = "desktop" | "extension";

export interface PreviewSource {
  repo: string;
  branch: string;
}

export interface PreviewSpec extends PreviewSource {
  kind: PreviewKind;
  mode: "dev" | "compiled";
  autoUpdate: boolean;
  updateInterval: number;
  includeK8s: boolean;
  rootful: boolean;
  extensionBuild?: "pnpm" | "container";
  extensionDir?: string;
  containerfile?: string;
  desktop?: PreviewSource;
}

export interface PreviewOptions {
  source?: string;
  branch?: string;
  kind?: PreviewKind;
  mode?: "dev" | "compiled";
  autoUpdate?: boolean;
  includeK8s?: boolean;
  rootful?: boolean;
  extensionBuild?: "pnpm" | "container";
  extensionDir?: string;
  containerfile?: string;
  desktopRepo?: string;
  desktopBranch?: string;
}

export interface PreviewSession {
  id: string;
  phase: string;
  vncReady: boolean;
  vncUrl: string;
  expiresAt: string;
  runtime: {
    phase: string;
    sourceCommit: string;
    appliedCommit: string;
    desktopCommit: string;
    lastError: string;
  } | null;
}

export interface PreviewContext {
  root: string;
  branch: string | null;
  repo: string | null;
  head: string;
  dirty: boolean;
}

export function detectPreviewKind(context: Pick<PreviewContext, "root" | "repo">): PreviewKind {
  // Match project names only, so an owner or parent directory cannot select Extension.
  const names = [context.repo, context.root].map((path) => path?.split(/[\\/]/).filter(Boolean).pop() ?? "");
  return names.some((name) => name.toLowerCase().includes("extension")) ? "extension" : "desktop";
}

export interface PreviewBinding {
  spec: PreviewSpec;
  createKey: string;
  id?: string;
  resetId?: string;
}

export type PreviewTarget = Pick<PreviewContext, "root" | "branch">;

export type PreviewFreshness = "current" | "push-required" | "update-required" | "waiting" | "unknown" | "failed";

export interface PreviewSnapshot {
  configured: boolean;
  context: PreviewContext | null;
  binding: PreviewBinding | null;
  session: PreviewSession | null;
  pushedCommit: string | null;
  freshness: PreviewFreshness;
  expired: boolean;
}

export class PreviewError extends Error {
  readonly status: number;

  constructor(message: string, status: number = PREVIEW_HTTP.badRequest) {
    super(message);
    this.name = "PreviewError";
    this.status = status;
  }
}

export function safeWebUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
      return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function parseRepo(value: string): string {
  const repo = value.trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/^github\.com\//, "")
    .replace(/\.git\/?$/, "")
    .replace(/\/$/, "");

  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || repo.split("/").some((part) => part === "." || part === "..")) {
    throw new PreviewError("Use a public GitHub repository, such as owner/repo.");
  }
  return repo.toLowerCase();
}

export function validBranch(branch: string): boolean {
  return Boolean(branch) && branch !== "@" && !branch.startsWith("-") && !branch.endsWith(".")
    && !branch.includes("..") && !branch.includes("@{") && !/[\s\x00-\x1f\x7f~^:?*\[\\]/.test(branch)
    && branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

export function getFreshness(
  context: PreviewContext | null,
  spec: PreviewSpec | undefined,
  session: PreviewSession | null,
  pushed: string | null,
): PreviewFreshness {
  if (session?.phase === "failed" || session?.runtime?.phase === "failed") {
    return "failed";
  }
  if (!pushed) {
    return "unknown";
  }
  if (context?.repo === spec?.repo && context?.branch === spec?.branch && context?.head !== pushed) {
    return "push-required";
  }
  const applied = session?.runtime?.appliedCommit;
  if (!applied) {
    return "waiting";
  }
  return applied === pushed ? "current" : "update-required";
}
