import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createOidcLogin, oidcIdentity } = await jiti.import("../packages/pi-pd-preview/oidc.ts");
const { editOidcAuth, oidcKey, readOidcAuth } = await jiti.import("../packages/pi-pd-preview/oidc-store.ts");
const { startOidcLogin, finishOidcLogin, readOidcLogin, signOutOidc } = await jiti.import("../packages/pi-pd-preview/oidc-login.ts");
const { configView, saveConfig } = await jiti.import("../packages/pi-pd-preview/storage.ts");
const { createClient } = await jiti.import("../packages/pi-pd-preview/client.ts");
const CONFIG = { apiUrl: "https://preview.test", token: "private-service-token", oidc: { issuer: "https://auth.test/dex", clientId: "pi-preview" } };
const CALLBACK = "http://localhost:12345/callback";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test", alg: "RS256", use: "sig" };

function jwt(claims, key = privateKey) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const text = `${encode({ alg: "RS256", kid: "test" })}.${encode(claims)}`;
  return `${text}.${sign("sha256", Buffer.from(text), key).toString("base64url")}`;
}

function provider() {
  const state = { calls: [], nonce: "", challenge: "", refreshes: 0, claims: {}, key: privateKey, beforeToken: async () => {} };
  const fetcher = async (url, init) => {
    state.calls.push({ url, init });
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        issuer: CONFIG.oidc.issuer, authorization_endpoint: "https://auth.test/dex/auth", token_endpoint: "https://auth.test/dex/token",
        jwks_uri: "https://auth.test/dex/keys", response_types_supported: ["code"], subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["RS256"], token_endpoint_auth_methods_supported: ["none"], code_challenge_methods_supported: ["S256"],
      });
    }
    if (url.endsWith("/keys")) {
      return Response.json({ keys: [jwk] });
    }
    assert.ok(url.endsWith("/token"), url);
    assert.equal(init.redirect, "manual");
    const form = new URLSearchParams(init.body);
    assert.equal(form.get("client_id"), CONFIG.oidc.clientId);
    if (form.get("grant_type") === "authorization_code") {
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), state.challenge);
    } else {
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "refresh-secret");
      state.refreshes += 1;
    }
    await state.beforeToken();
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: "access-secret", token_type: "Bearer", expires_in: 3600, refresh_token: "refresh-secret",
      id_token: jwt({ iss: CONFIG.oidc.issuer, aud: CONFIG.oidc.clientId, sub: "user-one", iat: now, exp: now + 3600, nonce: state.nonce, ...state.claims }, state.key),
    });
  };
  const accept = (authorizationUrl) => {
    const url = new URL(authorizationUrl);
    state.nonce = url.searchParams.get("nonce");
    state.challenge = url.searchParams.get("code_challenge");
    const callback = new URL(url.searchParams.get("redirect_uri"));
    callback.searchParams.set("state", url.searchParams.get("state"));
    callback.searchParams.set("code", "one-use-code");
    return callback.href;
  };
  return { state, fetcher, accept };
}

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "pi-preview-oidc-"));
  t.after(async () => {
    await signOutOidc(dir);
    await rm(dir, { recursive: true, force: true });
  });
  await saveConfig(dir, CONFIG, {});
  return dir;
}

test("OIDC uses PKCE, state, nonce, and a signed ID token", async () => {
  const p = provider();
  const login = await createOidcLogin(CONFIG, CALLBACK, p.fetcher);
  const url = new URL(login.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("scope"), /offline_access/);
  const callback = p.accept(login.authorizationUrl);
  const before = p.state.calls.length;
  await assert.rejects(login.finish(callback.replace("localhost", "other.test")), /does not match/);
  await assert.rejects(login.finish(callback.replace(/state=[^&]+/, "state=wrong")), /does not match/);
  assert.equal(p.state.calls.length, before, "invalid callbacks never reach the token endpoint");
  const result = await login.finish(callback);
  assert.equal(result.subject, "user-one");
  assert.equal(result.refreshToken, "refresh-secret");
  assert.ok(p.state.calls.some(({ url }) => url.endsWith("/keys")), "the ID token signature is checked");
});

test("OIDC refuses wrong nonce, audience, issuer, expired tokens, and forged signatures", async () => {
  const forged = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  for (const invalid of [{ nonce: "other" }, { aud: "other" }, { iss: "https://other.test" }, { exp: 1 }, { forged: true }]) {
    const p = provider();
    const login = await createOidcLogin(CONFIG, CALLBACK, p.fetcher);
    const callback = p.accept(login.authorizationUrl);
    if (invalid.forged) {
      p.state.key = forged;
    } else {
      p.state.claims = invalid;
    }
    await assert.rejects(login.finish(callback), /OIDC sign-in failed/);
  }
});

test("OIDC refresh is shared across callers and never returns credentials in settings", async (t) => {
  const dir = await directory(t);
  const p = provider();
  const login = await createOidcLogin(CONFIG, CALLBACK, p.fetcher);
  const session = await login.finish(p.accept(login.authorizationUrl));
  await editOidcAuth(dir, async (state) => { state.session = { ...session, expiresAt: 0 }; });
  const identities = await Promise.all([oidcIdentity(dir, CONFIG, p.fetcher), oidcIdentity(dir, CONFIG, p.fetcher)]);
  assert.equal(identities[0], identities[1]);
  assert.equal(p.state.refreshes, 1);
  assert.equal((await stat(join(dir, "pd-preview-auth.json"))).mode & 0o777, 0o600);
  const view = await configView(dir, {});
  assert.equal(view.signedIn, true);
  for (const secret of [session.idToken, session.refreshToken, CONFIG.token, "access-secret"]) {
    assert.equal(JSON.stringify(view).includes(secret), false);
  }
  const disk = await readFile(join(dir, "pd-preview-auth.json"), "utf8");
  assert.equal(disk.includes("access-secret"), false, "unused access tokens never persist");
  await assert.rejects(oidcIdentity(dir, { ...CONFIG, apiUrl: "https://other.test" }, p.fetcher), /Sign in to OIDC/);
  await signOutOidc(dir);
  await assert.rejects(oidcIdentity(dir, CONFIG, p.fetcher), /Sign in to OIDC/);
});

test("OIDC failures never expose provider responses or session tokens", async (t) => {
  const dir = await directory(t);
  const p = provider();
  const login = await createOidcLogin(CONFIG, CALLBACK, p.fetcher);
  const session = await login.finish(p.accept(login.authorizationUrl));
  await editOidcAuth(dir, async (state) => { state.session = { ...session, expiresAt: 0 }; });
  const broken = async () => { throw new Error("refresh-secret and access-secret"); };
  await assert.rejects(oidcIdentity(dir, CONFIG, broken), (error) => !/secret/.test(error.message));
  const client = createClient(CONFIG, async () => Response.json({ lines: [`${session.idToken} ${CONFIG.token}`] }), async () => session.idToken);
  assert.deepEqual(await client.logs("preview"), ["[redacted] [redacted]"]);
});

test("concurrent login requests share a listener and wrong pastes preserve the flow", async (t) => {
  const dir = await directory(t);
  const p = provider();
  const options = { fetcher: p.fetcher, env: {} };
  const [first, second] = await Promise.all([startOidcLogin(dir, options), startOidcLogin(dir, options)]);
  assert.equal(first.id, second.id);
  await assert.rejects(finishOidcLogin(dir, first.id, "http://other.test/callback"), /does not match/);
  assert.equal(readOidcLogin(dir, first.id).phase, "authorize");
  assert.equal((await finishOidcLogin(dir, first.id, p.accept(first.authorizationUrl))).phase, "done");
  assert.equal((await configView(dir, {})).signedIn, true);
  await assert.rejects(finishOidcLogin(dir, first.id, p.accept(first.authorizationUrl)), /no longer accepts/);
});

test("a browser callback completes the loopback flow", async (t) => {
  const dir = await directory(t);
  const p = provider();
  const flow = await startOidcLogin(dir, { fetcher: p.fetcher, env: {} });
  const response = await fetch(p.accept(flow.authorizationUrl));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(await response.text(), /Signed in to Pi/);
  assert.equal(readOidcLogin(dir, flow.id).phase, "done");
});

test("the settings API protects sign-in and uses the saved OIDC identity for Test", async (t) => {
  const dir = await directory(t);
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousFetch = globalThis.fetch;
  process.env.PI_CODING_AGENT_DIR = dir;
  t.after(() => {
    globalThis.fetch = previousFetch;
    if (previousDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousDir;
    }
  });
  const p = provider();
  let apiCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (url.startsWith(CONFIG.apiUrl)) {
      apiCalls += 1;
      assert.equal(init.headers.Authorization, `Bearer ${CONFIG.token}`);
      assert.equal(init.headers["X-Pi-OIDC-Token"], (await readOidcAuth(dir)).session.idToken);
      return Response.json({ sessions: [] });
    }
    return p.fetcher(url, init);
  };
  const routes = createJiti(import.meta.url, { alias: { "@": new URL("..", import.meta.url).pathname } });
  const auth = await routes.import("../app/api/preview/sign-in/route.ts");
  const config = await routes.import("../app/api/preview/config/route.ts");
  const request = (body, headers = {}) => new Request("http://127.0.0.1:30141/api/preview/sign-in", {
    method: "POST", headers: { host: "127.0.0.1:30141", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const denied = await auth.POST(request({ action: "start" }, { origin: "https://other.test", "sec-fetch-site": "cross-site" }));
  assert.equal(denied.status, 403);
  const flow = await (await auth.POST(request({ action: "start" }))).json();
  assert.equal(flow.phase, "authorize");
  const finished = await auth.POST(request({ action: "finish", id: flow.id, redirectUrl: p.accept(flow.authorizationUrl) }));
  assert.equal((await finished.json()).phase, "done");
  const response = await config.POST(request({}));
  assert.deepEqual(await response.json(), { sessions: 0 });
  assert.equal(apiCalls, 1);
  const view = await (await config.GET()).json();
  assert.equal(view.signedIn, true);
  assert.equal(JSON.stringify(view).includes("secret"), false);
  assert.equal((await auth.POST(request({ action: "logout" }))).status, 200);
  assert.equal((await configView(dir, {})).signedIn, false);
});

test("Pi CLI commands use the same OIDC session without an agent prompt", async (t) => {
  const dir = await directory(t);
  const p = provider();
  const previousFetch = globalThis.fetch;
  globalThis.fetch = p.fetcher;
  t.after(() => { globalThis.fetch = previousFetch; });
  const { createPreviewExtension } = await jiti.import("../packages/pi-pd-preview/extension.ts");
  const commands = new Map();
  const messages = [];
  const notices = [];
  const pi = { on() {}, registerTool() {}, registerCommand: (name, command) => commands.set(name, command), sendMessage: (message) => messages.push(message) };
  const ctx = { ui: { notify: (...args) => notices.push(args) } };
  await createPreviewExtension({ agentDir: dir })(pi);
  const command = commands.get("preview");
  await command.handler("login", ctx);
  const url = messages[0].content.match(/\(<([^>]+)>\)/)[1];
  await command.handler(`login ${p.accept(url)}`, ctx);
  assert.equal((await configView(dir, {})).signedIn, true);
  await command.handler("logout", ctx);
  assert.equal((await configView(dir, {})).signedIn, false);
  assert.ok(notices.every(([, tone]) => tone === "info"));
  assert.equal(messages.length, 1, "only the authorization link enters a custom message");
});

test("sign-out and configuration changes prevent a late exchange from restoring credentials", async (t) => {
  for (const action of ["logout", "reconfigure"]) {
    const dir = await directory(t);
    const p = provider();
    const flow = await startOidcLogin(dir, { fetcher: p.fetcher, env: {} });
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    p.state.beforeToken = () => { entered(); return new Promise((resolve) => { release = resolve; }); };
    const finishing = finishOidcLogin(dir, flow.id, p.accept(flow.authorizationUrl));
    await ready;
    if (action === "logout") {
      await signOutOidc(dir);
    } else {
      await saveConfig(dir, { ...CONFIG, apiUrl: "https://other.test" }, {});
    }
    release();
    assert.notEqual((await finishing).phase, "done");
    assert.equal((await readOidcAuth(dir)).session, undefined);
  }
});

test("OIDC settings reject insecure issuers and support removal without losing the service token", async (t) => {
  const dir = await directory(t);
  assert.equal((await configView(dir, {})).oidc.issuer, CONFIG.oidc.issuer);
  for (const issuer of ["http://auth.test", "https://user:pass@auth.test", "https://auth.test?token=secret"]) {
    await assert.rejects(saveConfig(dir, { ...CONFIG, oidc: { ...CONFIG.oidc, issuer } }, {}), /HTTPS OIDC/);
  }
  await assert.rejects(saveConfig(dir, { ...CONFIG, oidc: { issuer: CONFIG.oidc.issuer, clientId: "" } }, {}), /client ID/);
  await saveConfig(dir, { apiUrl: CONFIG.apiUrl, oidc: null }, {});
  const view = await configView(dir, {});
  assert.equal(view.oidc, null);
  assert.equal(view.hasToken, true);
  assert.equal(view.signedIn, false);
  assert.equal(oidcKey(CONFIG), oidcKey({ ...CONFIG, token: "changed-service-secret" }));
});

test("OIDC credentials require HTTPS for a remote preview API", async (t) => {
  const dir = await directory(t);
  await assert.rejects(saveConfig(dir, { ...CONFIG, apiUrl: "http://preview.test" }, {}), /HTTPS for the preview API/);
  assert.equal((await configView(dir, {})).apiUrl, CONFIG.apiUrl, "a refused save preserves the connection");
  await saveConfig(dir, { ...CONFIG, apiUrl: "http://127.0.0.1:8080" }, {});
  assert.equal((await configView(dir, {})).apiUrl, "http://127.0.0.1:8080");
});
