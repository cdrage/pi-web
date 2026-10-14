import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile, chmod, stat } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { PREVIEW_HTTP, PreviewError, safeWebUrl, type PreviewBinding } from "./model";
import { oidcKey, readOidcAuth } from "./oidc-store";
import { oidcUrl, parseOidc, type OidcSettings } from "./oidc-config";

const PRIVATE_MODE = 0o600;
const MAX_FILE_BYTES = 1024 * 1024;
const CONFIG_FILE = "pd-preview.json";
const STATE_FILE = "pd-preview-state.json";

export interface PreviewConfig {
  apiUrl: string;
  token: string;
  oidc?: OidcSettings;
}

export interface PreviewConfigView {
  apiUrl: string;
  hasToken: boolean;
  configured: boolean;
  urlFromEnv: boolean;
  tokenFromEnv: boolean;
  oidc: OidcSettings | null;
  signedIn: boolean;
}

interface Registry {
  version: 1;
  entries: Record<string, PreviewBinding>;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const details = await stat(path);
    if (!details.isFile() || details.size > MAX_FILE_BYTES) {
      throw new Error("Invalid configuration file");
    }
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return fallback;
    }
    throw new PreviewError(`Cannot read ${path}. Repair the file before retry.`, PREVIEW_HTTP.internalError);
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: PRIVATE_MODE });
  await rename(temp, path);
  await chmod(path, PRIVATE_MODE);
}

async function withFileLock<T>(dir: string, name: string, work: (path: string) => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 30, minTimeout: 100, maxTimeout: 500 },
  });
  try {
    return await work(path);
  } finally {
    await release();
  }
}

export function normalizeApiUrl(value: string): string {
  const safe = safeWebUrl(value.trim());
  if (!safe) {
    throw new PreviewError("Use an HTTP or HTTPS API address without credentials.");
  }
  const url = new URL(safe);
  if (url.search || url.hash) {
    throw new PreviewError("The API address cannot include a query or fragment.");
  }
  return safe.replace(/\/$/, "");
}

function checkOidcTarget(apiUrl: string, oidc?: OidcSettings) {
  if (!oidc || !apiUrl) {
    return;
  }
  try {
    oidcUrl(apiUrl);
  } catch {
    throw new PreviewError("Use HTTPS for the preview API when OIDC is enabled. HTTP is permitted only on loopback.");
  }
}

export async function readConfig(dir: string, env = process.env): Promise<PreviewConfig> {
  const saved = await readJson<Partial<PreviewConfig>>(join(dir, CONFIG_FILE), {});
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
    throw new PreviewError("Invalid preview configuration.", PREVIEW_HTTP.internalError);
  }
  const apiUrl = env.PD_API_URL ?? saved.apiUrl ?? "";
  const token = env.PD_API_TOKEN ?? saved.token ?? "";
  if (typeof apiUrl !== "string" || typeof token !== "string" || /[\r\n]/.test(token)) {
    throw new PreviewError("Invalid preview configuration.", PREVIEW_HTTP.internalError);
  }
  const config = { apiUrl: apiUrl ? normalizeApiUrl(apiUrl) : "", token, ...(saved.oidc ? { oidc: parseOidc(saved.oidc) } : {}) };
  checkOidcTarget(config.apiUrl, config.oidc);
  return config;
}

export async function configView(dir: string, env = process.env): Promise<PreviewConfigView> {
  const config = await readConfig(dir, env);
  const session = config.oidc ? (await readOidcAuth(dir)).session : undefined;
  return {
    apiUrl: config.apiUrl,
    hasToken: Boolean(config.token),
    configured: Boolean(config.apiUrl && config.token),
    urlFromEnv: env.PD_API_URL !== undefined,
    tokenFromEnv: env.PD_API_TOKEN !== undefined,
    oidc: config.oidc ?? null,
    signedIn: Boolean(session?.key === oidcKey(config) && (session.expiresAt > Date.now() || session.refreshToken)),
  };
}

export async function saveConfig(dir: string, input: { apiUrl: string; token?: string; oidc?: OidcSettings | null }, env = process.env): Promise<PreviewConfigView> {
  const apiUrl = input.apiUrl ? normalizeApiUrl(input.apiUrl) : "";
  const oidc = input.oidc == null ? input.oidc : parseOidc(input.oidc);
  if (input.token !== undefined && /[\r\n]/.test(input.token)) {
    throw new PreviewError("The API token cannot include line breaks.");
  }
  await withFileLock(dir, CONFIG_FILE, async (path) => {
    const saved = await readJson<Partial<PreviewConfig>>(path, {});
    const next = {
      apiUrl: env.PD_API_URL !== undefined ? saved.apiUrl : apiUrl,
      token: env.PD_API_TOKEN !== undefined ? saved.token : input.token ?? saved.token ?? "",
      ...(oidc === null ? {} : { oidc: oidc ?? saved.oidc }),
    };
    checkOidcTarget(env.PD_API_URL ?? next.apiUrl ?? "", next.oidc);
    await writeJson(path, next);
  });
  return configView(dir, env);
}

export async function readRegistry(dir: string): Promise<Registry> {
  const registry = await readJson<Registry>(join(dir, STATE_FILE), { version: 1, entries: {} });
  if (registry?.version !== 1 || !registry.entries || Array.isArray(registry.entries) || typeof registry.entries !== "object") {
    throw new PreviewError("Invalid preview registry. Repair pd-preview-state.json before retry.", PREVIEW_HTTP.internalError);
  }
  return registry;
}

export async function editRegistry<T>(
  dir: string,
  work: (state: Registry, save: () => Promise<void>) => Promise<T>,
): Promise<T> {
  return withFileLock(dir, STATE_FILE, async (path) => {
    const state = await readRegistry(dir);
    return work(state, () => writeJson(path, state));
  });
}
