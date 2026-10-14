import * as oauth from "openid-client";
import { PreviewError } from "./model";
import { editOidcAuth, oidcKey, readOidcAuth, type OidcSession } from "./oidc-store";
import type { PreviewConfig } from "./storage";
import type { Fetcher } from "./client";
import { oidcUrl } from "./oidc-config";

const HTTP_UNAUTHORIZED = 401;
const REQUEST_SECONDS = 15;
const MILLISECONDS = 1000;
const REFRESH_EARLY_MS = 30 * MILLISECONDS;
const SCOPES = "openid profile email offline_access";

async function discover(config: PreviewConfig, fetcher: Fetcher) {
  if (!config.oidc) {
    throw new PreviewError("Save an OIDC issuer and client ID before Sign in.");
  }
  const issuer = new URL(oidcUrl(config.oidc.issuer));
  const execute = [oauth.enableNonRepudiationChecks];
  if (issuer.protocol === "http:") {
    execute.push(oauth.allowInsecureRequests);
  }
  return oauth.discovery(issuer, config.oidc.clientId, undefined, oauth.None(), {
    execute, timeout: REQUEST_SECONDS,
    [oauth.customFetch]: (url, init) => fetcher(url, init as RequestInit),
  });
}

function sessionFrom(
  config: PreviewConfig,
  tokens: Awaited<ReturnType<typeof oauth.authorizationCodeGrant>>,
  previous?: OidcSession,
): OidcSession {
  const claims = tokens.claims();
  if (!tokens.id_token || !claims || previous && claims.sub !== previous.subject) {
    throw new PreviewError("OIDC returned no valid identity. Sign in again.", HTTP_UNAUTHORIZED);
  }
  return {
    key: oidcKey(config), idToken: tokens.id_token, subject: claims.sub,
    refreshToken: tokens.refresh_token ?? previous?.refreshToken,
    expiresAt: Math.min(claims.exp, Date.now() / MILLISECONDS + (tokens.expires_in ?? Infinity)) * MILLISECONDS,
  };
}

export async function createOidcLogin(config: PreviewConfig, redirectUri: string, fetcher: Fetcher = fetch) {
  try {
    const client = await discover(config, fetcher);
    const verifier = oauth.randomPKCECodeVerifier();
    const state = oauth.randomState();
    const nonce = oauth.randomNonce();
    const url = oauth.buildAuthorizationUrl(client, {
      redirect_uri: redirectUri, scope: SCOPES, state, nonce,
      code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256",
    });

    function validate(value: string): URL {
      let callback: URL;
      try {
        callback = new URL(value);
      } catch {
        throw new PreviewError("Paste the complete callback address.");
      }
      const expected = new URL(redirectUri);
      if (callback.origin !== expected.origin || callback.pathname !== expected.pathname || callback.hash
        || callback.searchParams.getAll("state").length !== 1 || callback.searchParams.get("state") !== state) {
        throw new PreviewError("The callback address does not match this sign-in.");
      }
      return callback;
    }

    return {
      authorizationUrl: url.href,
      validate,
      async finish(value: string): Promise<OidcSession> {
        const callback = validate(value);
        try {
          const tokens = await oauth.authorizationCodeGrant(client, callback, {
            pkceCodeVerifier: verifier, expectedState: state, expectedNonce: nonce, idTokenExpected: true,
          });
          return sessionFrom(config, tokens);
        } catch {
          throw new PreviewError("OIDC sign-in failed. Start Sign in again.", HTTP_UNAUTHORIZED);
        }
      },
    };
  } catch (error) {
    if (error instanceof PreviewError) {
      throw error;
    }
    throw new PreviewError("Cannot read the OIDC provider configuration. Make sure that the issuer and client ID are correct.");
  }
}
export async function oidcIdentity(dir: string, config: PreviewConfig, fetcher: Fetcher = fetch): Promise<string> {
  const saved = (await readOidcAuth(dir)).session;
  const key = oidcKey(config);
  if (saved?.key === key && saved.expiresAt > Date.now() + REFRESH_EARLY_MS) {
    return saved.idToken;
  }
  // Serialize refresh across Pi processes because Dex can rotate refresh tokens.
  return editOidcAuth(dir, async (state) => {
    const session = state.session;
    if (session?.key !== key) {
      throw new PreviewError("Sign in to OIDC in Settings > Previews, or run /preview login.", HTTP_UNAUTHORIZED);
    }
    if (session.expiresAt > Date.now() + REFRESH_EARLY_MS) {
      return session.idToken;
    }
    if (!session.refreshToken) {
      throw new PreviewError("The OIDC session expired. Sign in again.", HTTP_UNAUTHORIZED);
    }
    try {
      const client = await discover(config, fetcher);
      const tokens = await oauth.refreshTokenGrant(client, session.refreshToken);
      state.session = sessionFrom(config, tokens, session);
      return state.session.idToken;
    } catch {
      throw new PreviewError("Cannot refresh the OIDC session. Sign in again.", HTTP_UNAUTHORIZED);
    }
  });
}
