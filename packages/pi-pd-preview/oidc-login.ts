import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { PreviewError } from "./model";
import { createOidcLogin } from "./oidc";
import { editOidcAuth, oidcKey, readOidcAuth } from "./oidc-store";
import { readConfig, type PreviewConfig } from "./storage";
import type { Fetcher } from "./client";

const LOGIN_TTL_MS = 5 * 60 * 1000;
const HTTP_OK = 200;
const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const CALLBACK_PATH = "/callback";

export interface OidcLoginInfo {
  id: string;
  phase: "authorize" | "finishing" | "done" | "failed" | "cancelled" | "expired";
  authorizationUrl: string;
  error?: string;
}

interface Login extends OidcLoginInfo {
  server: Server;
  timer: ReturnType<typeof setTimeout>;
  config: PreviewConfig;
  generation: string;
  protocol: Awaited<ReturnType<typeof createOidcLogin>>;
  env?: NodeJS.ProcessEnv;
}

interface Entry {
  login?: Login;
  pending?: Promise<OidcLoginInfo>;
}

declare global {
  var __piPreviewOidcLogins: Map<string, Entry> | undefined;
}

const registry = globalThis.__piPreviewOidcLogins ??= new Map<string, Entry>();

function view(login: Login): OidcLoginInfo {
  return { id: login.id, phase: login.phase, authorizationUrl: login.authorizationUrl, ...(login.error ? { error: login.error } : {}) };
}

function lookup(dir: string, id: string): Login {
  const login = registry.get(dir)?.login;
  if (!login || login.id !== id) {
    throw new PreviewError("This OIDC sign-in no longer exists. Start Sign in again.", HTTP_NOT_FOUND);
  }
  return login;
}

function end(login: Login, phase: Login["phase"]) {
  login.phase = phase;
  clearTimeout(login.timer);
  login.server.close();
}

export function readOidcLogin(dir: string, id: string): OidcLoginInfo {
  return view(lookup(dir, id));
}

export async function finishOidcLogin(dir: string, id: string, value: string): Promise<OidcLoginInfo> {
  const login = lookup(dir, id);
  if (login.phase !== "authorize") {
    throw new PreviewError("This OIDC sign-in no longer accepts a callback.");
  }
  // A wrong paste leaves the real flow available. Only a valid state starts the exchange.
  login.protocol.validate(value);
  login.phase = "finishing";
  try {
    const session = await login.protocol.finish(value);
    await editOidcAuth(dir, async (state) => {
      const current = await readConfig(dir, login.env);
      if (login.phase !== "finishing" || state.generation !== login.generation || oidcKey(current) !== oidcKey(login.config)) {
        throw new PreviewError("The preview connection changed or signed out. Start Sign in again.");
      }
      state.session = session;
    });
    end(login, "done");
  } catch (error) {
    login.error = error instanceof PreviewError ? error.message : "OIDC sign-in failed. Start Sign in again.";
    const phase = view(login).phase;
    end(login, phase === "cancelled" || phase === "expired" ? phase : "failed");
  }
  return view(login);
}

export function cancelOidcLogin(dir: string, id: string): OidcLoginInfo {
  const login = lookup(dir, id);
  if (login.phase === "authorize" || login.phase === "finishing") {
    end(login, "cancelled");
  }
  return view(login);
}

export async function signOutOidc(dir: string): Promise<void> {
  const entry = registry.get(dir);
  if (entry?.pending) {
    await entry.pending.catch(() => undefined);
  }
  if (entry?.login) {
    cancelOidcLogin(dir, entry.login.id);
  }
  await editOidcAuth(dir, async (state) => {
    state.generation = randomUUID();
    delete state.session;
  });
}

async function begin(dir: string, options: { fetcher?: Fetcher; env?: NodeJS.ProcessEnv }): Promise<OidcLoginInfo> {
  const config = await readConfig(dir, options.env);
  if (!config.apiUrl || !config.token || !config.oidc) {
    throw new PreviewError("Save the API address, token, OIDC issuer, and client ID before Sign in.");
  }
  const generation = (await readOidcAuth(dir)).generation;
  const server = createServer();
  const id = randomUUID();
  let redirectUri = "";
  server.on("request", (request, response) => {
    const callback = new URL(request.url ?? "/", redirectUri);
    const allowed = request.method === "GET" && request.headers.host === new URL(redirectUri).host
      && callback.origin === new URL(redirectUri).origin && callback.pathname === CALLBACK_PATH;
    const result = allowed ? finishOidcLogin(dir, id, callback.href) : Promise.reject(new PreviewError("Invalid callback request."));
    void result.then((flow) => {
      response.writeHead(flow.phase === "done" ? HTTP_OK : HTTP_BAD_REQUEST, { "Content-Type": "text/plain", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "Referrer-Policy": "no-referrer" });
      response.end(flow.phase === "done" ? "Signed in to Pi previews. You can close this tab." : "Sign-in failed. Return to Pi and retry.");
    }).catch(() => {
      response.writeHead(HTTP_BAD_REQUEST, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
      response.end("Invalid callback. Return to Pi and retry.");
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    server.unref();
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error();
    }
    redirectUri = `http://localhost:${address.port}${CALLBACK_PATH}`;
    const protocol = await createOidcLogin(config, redirectUri, options.fetcher);
    const login: Login = {
      id, phase: "authorize", authorizationUrl: protocol.authorizationUrl, server, config, generation, protocol, env: options.env,
      timer: setTimeout(() => end(login, "expired"), LOGIN_TTL_MS),
    };
    login.timer.unref();
    registry.get(dir)!.login = login;
    return view(login);
  } catch (error) {
    server.close();
    if (error instanceof PreviewError) {
      throw error;
    }
    throw new PreviewError("Cannot start the OIDC callback listener. Make sure that local TCP access is available.");
  }
}

export function startOidcLogin(dir: string, options: { fetcher?: Fetcher; env?: NodeJS.ProcessEnv } = {}): Promise<OidcLoginInfo> {
  const entry = registry.get(dir) ?? {};
  registry.set(dir, entry);
  if (entry.pending) {
    return entry.pending;
  }
  if (entry.login?.phase === "authorize" || entry.login?.phase === "finishing") {
    return Promise.resolve(view(entry.login));
  }
  entry.pending = begin(dir, options).finally(() => { delete entry.pending; });
  return entry.pending;
}
