import { PreviewError } from "./model";

export const OIDC_HEADER = "X-Pi-OIDC-Token";

export interface OidcSettings {
  issuer: string;
  clientId: string;
}

export function oidcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PreviewError("Use an HTTPS OIDC issuer address.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:"))
    || url.username || url.password || url.search || url.hash) {
    throw new PreviewError("Use an HTTPS OIDC issuer address without credentials, query, or fragment.");
  }
  return url.href.replace(/\/$/, "");
}

export function parseOidc(value: unknown): OidcSettings {
  const settings = value as Partial<OidcSettings> | null;
  if (!settings || typeof settings.issuer !== "string" || typeof settings.clientId !== "string"
    || !settings.clientId.trim() || /[\x00-\x1f\x7f]/.test(settings.clientId)
    || Object.keys(settings).some((key) => key !== "issuer" && key !== "clientId")) {
    throw new PreviewError("Provide an OIDC issuer and client ID.");
  }
  return { issuer: oidcUrl(settings.issuer.trim()), clientId: settings.clientId.trim() };
}
