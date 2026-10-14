"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PREVIEW_CONFIG_EVENT, previewClient } from "@/lib/preview-client";
import type { PreviewConfigView } from "@/packages/pi-pd-preview/storage";
import type { OidcLoginInfo } from "@/packages/pi-pd-preview/oidc-login";
import { ConfigButton } from "./SettingsUi";
import { OAuthPastePanel } from "./OAuthPastePanel";

const POLL_MS = 1000;

export function PreviewSignIn({ config, disabled, onChange }: {
  config: PreviewConfigView;
  disabled: boolean;
  onChange: (config: PreviewConfigView) => void;
}) {
  const { t } = useI18n();
  const [flow, setFlow] = useState<OidcLoginInfo>();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = flow?.phase === "authorize" || flow?.phase === "finishing";
  const id = flow?.id;

  useEffect(() => {
    if (!active || !id) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const next = await previewClient.signInStatus(id!);
        if (next.phase === "done") {
          const saved = await previewClient.config();
          if (!cancelled) {
            onChange(saved);
            window.dispatchEvent(new Event(PREVIEW_CONFIG_EVENT));
          }
        }
        if (!cancelled) {
          setFlow(next);
        }
      } catch (error) {
        if (!cancelled) {
          setError(error instanceof Error ? error.message : t("preview.requestFailed"));
        }
      }
      if (!cancelled) {
        timer = setTimeout(() => void poll(), POLL_MS);
      }
    }
    timer = setTimeout(() => void poll(), POLL_MS);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [active, id, onChange, t]);

  async function run(action: "start" | "finish" | "cancel" | "logout") {
    setBusy(true);
    setError("");
    try {
      if (action === "logout") {
        await previewClient.signOut();
        onChange(await previewClient.config());
        setFlow(undefined);
        window.dispatchEvent(new Event(PREVIEW_CONFIG_EVENT));
        return;
      }
      const next = action === "start" ? await previewClient.signIn()
        : action === "cancel" ? await previewClient.cancelSignIn(flow!.id)
          : await previewClient.finishSignIn(flow!.id, value);
      if (next.phase === "done") {
        onChange(await previewClient.config());
        window.dispatchEvent(new Event(PREVIEW_CONFIG_EVENT));
      }
      setFlow(next);
      setValue("");
    } catch (error) {
      setError(error instanceof Error ? error.message : t("preview.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="preview-sign-in">
    <p role="status">{t(config.signedIn ? "preview.oidcSignedIn" : "preview.oidcSignedOut")}</p>
    {disabled && <p>{t("preview.oidcSaveFirst")}</p>}
    {flow?.phase === "authorize" && <OAuthPastePanel
      message={t("preview.oidcContinue")}
      hint={<a href={flow.authorizationUrl} target="_blank" rel="noopener noreferrer">{t("preview.oidcOpen")}</a>}
      value={value}
      placeholder="http://localhost:…/callback?code=…&state=…"
      inputLabel={t("preview.oidcCallback")}
      submitLabel={t("preview.oidcFinish")}
      disabled={busy || disabled}
      onValueChange={setValue}
      onSubmit={() => void run("finish")}
    />}
    {flow?.phase === "finishing" && <p role="status">{t("preview.oidcWait")}</p>}
    {flow?.phase === "expired" && <p role="alert">{t("preview.oidcExpired")}</p>}
    {(error || flow?.error) && <p role="alert" className="preview-error">{error || flow?.error}</p>}
    <div className="preview-actions">
      {active
        ? <ConfigButton disabled={busy} onClick={() => void run("cancel")}>{t("preview.cancel")}</ConfigButton>
        : <ConfigButton disabled={busy || disabled || !config.configured} onClick={() => void run("start")}>{t("preview.oidcSignIn")}</ConfigButton>}
      {config.signedIn && <ConfigButton disabled={busy} onClick={() => void run("logout")}>{t("preview.oidcSignOut")}</ConfigButton>}
    </div>
  </div>;
}
