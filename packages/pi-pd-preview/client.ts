import { PREVIEW_HTTP, PreviewError, safeWebUrl, type PreviewSession, type PreviewSpec } from "./model";
import type { PreviewConfig } from "./storage";
import { OIDC_HEADER } from "./oidc-config";

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HTTP_NO_CONTENT = 204;
export const HTTP_NOT_FOUND = 404;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_CONFLICT = 409;
const API_SESSIONS = "/api/v1/sessions";

export type Fetcher = typeof fetch;

export async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new PreviewError("The preview service returned an empty response.", PREVIEW_HTTP.badGateway);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new PreviewError("The preview response exceeds the size limit.", PREVIEW_HTTP.badGateway);
      }
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    if (error instanceof PreviewError) {
      throw error;
    }
    throw new PreviewError("The preview service did not return JSON. Use its API address, without an OIDC login redirect.", PREVIEW_HTTP.badGateway);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseSession(value: unknown, redact: (value: string) => string): PreviewSession {
  const data = value as PreviewSession;
  if (!data || typeof data.id !== "string" || !/^[\w-]+$/.test(data.id)
    || typeof data.phase !== "string" || typeof data.expiresAt !== "string" || !Number.isFinite(Date.parse(data.expiresAt))) {
    throw new PreviewError("The preview service returned an invalid session.", PREVIEW_HTTP.badGateway);
  }
  const clean = (text: unknown) => typeof text === "string" ? redact(text) : "";
  return {
    id: data.id,
    phase: clean(data.phase),
    expiresAt: data.expiresAt,
    vncReady: data.vncReady === true,
    vncUrl: typeof data.vncUrl === "string" ? safeWebUrl(data.vncUrl) : "",
    runtime: data.runtime ? {
      phase: clean(data.runtime.phase),
      sourceCommit: clean(data.runtime.sourceCommit),
      appliedCommit: clean(data.runtime.appliedCommit),
      desktopCommit: clean(data.runtime.desktopCommit),
      lastError: clean(data.runtime.lastError),
    } : null,
  };
}

export function createClient(config: PreviewConfig, fetcher: Fetcher = fetch, identity?: () => Promise<string>) {
  const secrets = new Set([config.token]);
  const redact = (value: string) => [...secrets].filter(Boolean).reduce((text, secret) => text.split(secret).join("[redacted]"), value);

  async function request(path: string, method = "GET", spec?: PreviewSpec, key?: string): Promise<unknown> {
    if (!config.apiUrl || !config.token) {
      throw new PreviewError("Configure the preview API address and token in Settings > Previews, or set PD_API_URL and PD_API_TOKEN.");
    }
    const idToken = config.oidc ? await identity?.() : undefined;
    if (config.oidc && !idToken) {
      throw new PreviewError("Sign in to OIDC in Settings > Previews, or run /preview login.", HTTP_UNAUTHORIZED);
    }
    if (idToken) {
      secrets.add(idToken);
    }
    let response: Response;
    try {
      response = await fetcher(`${config.apiUrl}${API_SESSIONS}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(idToken ? { [OIDC_HEADER]: idToken } : {}),
          Accept: "application/json",
          ...(spec ? { "Content-Type": "application/json" } : {}),
          ...(key ? { "Idempotency-Key": key } : {}),
        },
        ...(spec ? { body: JSON.stringify(spec) } : {}),
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PreviewError("Cannot reach the preview API. If the gateway requires OIDC, configure Sign in and its JWT header rule.", PREVIEW_HTTP.badGateway);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const messages: Record<number, string> = {
        [HTTP_NOT_FOUND]: "The preview expired or was removed.",
        [HTTP_UNAUTHORIZED]: "The preview API rejected the token.",
        [HTTP_FORBIDDEN]: "The preview API denied access.",
        [HTTP_CONFLICT]: "The preview service reached its session limit or rejected the request key.",
      };
      throw new PreviewError(messages[response.status] ?? `The preview API returned HTTP ${response.status}.`, response.status);
    }
    if (response.status === HTTP_NO_CONTENT) {
      return null;
    }
    return readResponse(response);
  }

  const sessionPath = (id: string) => `/${encodeURIComponent(id)}`;
  return {
    check: async () => {
      const result = await request("") as { sessions?: unknown };
      if (!Array.isArray(result?.sessions)) {
        throw new PreviewError("The preview service returned an invalid session list.", PREVIEW_HTTP.badGateway);
      }
      return { sessions: result.sessions.length };
    },
    create: async (spec: PreviewSpec, key: string) => parseSession(await request("", "POST", spec, key), redact),
    get: async (id: string) => parseSession(await request(sessionPath(id)), redact),
    sync: async (id: string) => { await request(`${sessionPath(id)}/sync`, "POST"); },
    touch: async (id: string) => parseSession(await request(`${sessionPath(id)}/touch`, "POST"), redact),
    remove: async (id: string) => { await request(sessionPath(id), "DELETE"); },
    logs: async (id: string) => {
      const result = await request(`${sessionPath(id)}/logs?tail=500`) as { lines?: unknown };
      if (!Array.isArray(result?.lines) || result.lines.some((line) => typeof line !== "string")) {
        throw new PreviewError("The preview service returned invalid logs.", PREVIEW_HTTP.badGateway);
      }
      return (result.lines as string[]).map(redact);
    },
  };
}
