import type { GitFileDiffResponse, GitStatusResponse } from "./git-types";

const PATCH_BATCH_SIZE = 8;

async function readGit<T>(route: string, params: URLSearchParams, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/git/${route}?${params}`, { signal, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : "Cannot load the review diff.");
  }

  return body as T;
}

export function loadReviewStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  return readGit("status", new URLSearchParams({ cwd }), signal);
}

export async function loadReviewPatches(
  cwd: string,
  filePaths: string[],
  signal?: AbortSignal,
): Promise<Record<string, string | null>> {
  const paths = [...new Set(filePaths)];
  const patches: Record<string, string | null> = {};

  // Limit concurrent Git reads when a review contains many files.
  for (let offset = 0; offset < paths.length; offset += PATCH_BATCH_SIZE) {
    const batch = paths.slice(offset, offset + PATCH_BATCH_SIZE);
    const results = await Promise.all(batch.map(async (filePath) => {
      const diff = await readGit<GitFileDiffResponse>("diff", new URLSearchParams({ cwd, path: filePath }), signal);
      return [filePath, diff.supported && typeof diff.patch === "string" ? diff.patch : null] as const;
    }));

    for (const [filePath, patch] of results) {
      patches[filePath] = patch;
    }
  }

  return patches;
}
