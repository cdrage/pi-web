import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { PreviewError } from "./model";
import type { PreviewConfig } from "./storage";

const AUTH_FILE = "pd-preview-auth.json";
const PRIVATE_MODE = 0o600;
const MAX_BYTES = 1024 * 1024;

export interface OidcSession {
  key: string;
  idToken: string;
  refreshToken?: string;
  expiresAt: number;
  subject: string;
}

interface AuthState {
  generation: string;
  session?: OidcSession;
}

export function oidcKey(config: PreviewConfig): string {
  return createHash("sha256").update(JSON.stringify([config.apiUrl, config.oidc])).digest("hex");
}

export async function readOidcAuth(dir: string): Promise<AuthState> {
  try {
    const path = join(dir, AUTH_FILE);
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_BYTES) {
      throw new Error();
    }
    const state = JSON.parse(await readFile(path, "utf8")) as AuthState;
    if (typeof state.generation !== "string" || state.session && (
      typeof state.session.key !== "string" || typeof state.session.idToken !== "string"
      || typeof state.session.subject !== "string" || !Number.isFinite(state.session.expiresAt)
      || state.session.refreshToken !== undefined && typeof state.session.refreshToken !== "string"
    )) {
      throw new Error();
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { generation: "initial" };
    }
    throw new PreviewError("Cannot read pd-preview-auth.json. Repair the file before retry.");
  }
}

export async function editOidcAuth<T>(dir: string, work: (state: AuthState) => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, AUTH_FILE);
  const release = await lockfile.lock(path, { realpath: false, retries: { retries: 30, minTimeout: 100, maxTimeout: 500 } });
  try {
    const state = await readOidcAuth(dir);
    const result = await work(state);
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: PRIVATE_MODE });
    await rename(temp, path);
    return result;
  } finally {
    await release();
  }
}
