import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { parseRepo, type PreviewContext } from "./model";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BYTES = 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BYTES,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return stdout.trim();
}

export async function getContext(cwd: string): Promise<PreviewContext | null> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]).catch(() => "");
  if (!top) {
    return null;
  }
  const root = await realpath(process.platform === "win32" ? top.replace(/\//g, "\\") : top);
  const [branch, head, changes] = await Promise.all([
    git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => null),
    git(root, ["rev-parse", "HEAD"]).catch(() => ""),
    git(root, ["status", "--porcelain", "--untracked-files=normal"]),
  ]);
  const remoteKeys = [
    ...(branch ? [`branch.${branch}.pushRemote`] : []),
    "remote.pushDefault",
    ...(branch ? [`branch.${branch}.remote`] : []),
  ];
  const remotes = await Promise.all(remoteKeys.map((key) => git(root, ["config", "--get", key]).catch(() => "")));
  const remote = remotes.find(Boolean) || "origin";
  const url = await git(root, ["remote", "get-url", "--push", remote]).catch(() => "");
  let repo: string | null = null;
  try {
    repo = parseRepo(url);
  } catch {
    // A checkout without a GitHub remote can still use an explicit source.
  }
  return { root, branch, repo, head, dirty: Boolean(changes) };
}
