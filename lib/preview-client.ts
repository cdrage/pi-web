import type { PreviewAction, PreviewOptions, PreviewSnapshot, PreviewTarget } from "../packages/pi-pd-preview/model";
import type { PreviewConfigView } from "../packages/pi-pd-preview/storage";
import type { OidcSettings } from "../packages/pi-pd-preview/oidc-config";
import type { OidcLoginInfo } from "../packages/pi-pd-preview/oidc-login";

export const PREVIEW_CONFIG_EVENT = "pi-web:preview-config";

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const data = await response.json();
  if (!response.ok || data.error) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const previewClient = {
  desktop: (cwd: string) => request<{ url: string }>(`/api/preview/desktop?cwd=${encodeURIComponent(cwd)}`),
  status: (cwd: string, fresh = false) => request<PreviewSnapshot>(`/api/preview?cwd=${encodeURIComponent(cwd)}${fresh ? "&fresh=1" : ""}`),
  action: (cwd: string, action: PreviewAction, options?: PreviewOptions, target?: PreviewTarget) => request<PreviewSnapshot>("/api/preview", json("POST", { cwd, action, options, target })),
  logs: (cwd: string) => request<{ lines: string[] }>(`/api/preview?view=logs&cwd=${encodeURIComponent(cwd)}`),
  config: () => request<PreviewConfigView>("/api/preview/config"),
  save: (apiUrl: string, token?: string, oidc?: OidcSettings | null) => request<PreviewConfigView>("/api/preview/config", json("PUT", { apiUrl, token, oidc })),
  test: () => request<{ sessions: number }>("/api/preview/config", json("POST", {})),
  signIn: () => request<OidcLoginInfo>("/api/preview/sign-in", json("POST", { action: "start" })),
  signInStatus: (id: string) => request<OidcLoginInfo>(`/api/preview/sign-in?id=${encodeURIComponent(id)}`),
  finishSignIn: (id: string, redirectUrl: string) => request<OidcLoginInfo>("/api/preview/sign-in", json("POST", { action: "finish", id, redirectUrl })),
  cancelSignIn: (id: string) => request<OidcLoginInfo>("/api/preview/sign-in", json("POST", { action: "cancel", id })),
  signOut: () => request<{ signedOut: true }>("/api/preview/sign-in", json("POST", { action: "logout" })),
};
