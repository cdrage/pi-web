"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { PREVIEW_CONFIG_EVENT, previewClient } from "@/lib/preview-client";
import type { PreviewConfigView } from "@/packages/pi-pd-preview/storage";
import { ConfigButton, ConfigDetail, ConfigFooter, ConfigFooterStatus, ConfigScopeTag } from "./SettingsUi";
import "./Preview.css";
import { PreviewSignIn } from "./PreviewSignIn";

export function PreviewSettings() {
  const { t } = useI18n();
  const [config, setConfig] = useState<PreviewConfigView | null>(null);
  const [apiUrl, setApiUrl] = useState("");
  const [token, setToken] = useState("");
  const [useOidc, setUseOidc] = useState(false);
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void previewClient.config().then((result) => {
      if (active) {
        setConfig(result);
        setApiUrl(result.apiUrl);
        setUseOidc(Boolean(result.oidc));
        setIssuer(result.oidc?.issuer ?? "");
        setClientId(result.oidc?.clientId ?? "");
      }
    }).catch((error) => {
      if (active) {
        setError(error.message);
      }
    });
    return () => { active = false; };
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await previewClient.save(apiUrl, token || undefined, useOidc ? { issuer, clientId } : null);
      setConfig(result);
      setApiUrl(result.apiUrl);
      setToken("");
      setIssuer(result.oidc?.issuer ?? "");
      setClientId(result.oidc?.clientId ?? "");
      setMessage(t("preview.saved"));
      window.dispatchEvent(new Event(PREVIEW_CONFIG_EVENT));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("preview.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  const changed = Boolean(config && (apiUrl !== config.apiUrl || token || useOidc !== Boolean(config.oidc)
    || useOidc && (issuer !== config.oidc?.issuer || clientId !== config.oidc?.clientId)));

  async function test() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await previewClient.test();
      setMessage(t("preview.connected"));
    } catch (error) {
      setError(error instanceof Error ? error.message : t("preview.requestFailed"));
    } finally {
      setBusy(false);
    }
  }

  return <div className="preview-settings">
    <ConfigDetail>
      <h2>{t("preview.title")}</h2>
      <ConfigScopeTag scope="global">{t("preview.global")}</ConfigScopeTag>
      <p>{t("preview.description")}</p>
      <form id="preview-settings-form" className="preview-form" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label>{t("preview.apiUrl")}<input type="url" required value={apiUrl} disabled={!config || config.urlFromEnv || busy} onChange={(event) => setApiUrl(event.target.value)} placeholder="https://pd-testing.k8s.land" autoComplete="off" /></label>
        {config?.urlFromEnv && <p>{t("preview.urlEnv")}</p>}
        <label>{t("preview.token")}<input type="password" value={token} disabled={!config || config.tokenFromEnv || busy} onChange={(event) => setToken(event.target.value)} placeholder={config?.hasToken ? t("preview.tokenSaved") : ""} autoComplete="new-password" /></label>
        {config?.tokenFromEnv && <p>{t("preview.tokenEnv")}</p>}
        <p>{t("preview.secretNote")}</p>
        <label className="preview-check"><input type="checkbox" checked={useOidc} disabled={!config || busy} onChange={(event) => setUseOidc(event.target.checked)} />{t("preview.oidcEnable")}</label>
        {useOidc && <>
          <label>{t("preview.oidcIssuer")}<input type="url" required value={issuer} disabled={busy} onChange={(event) => setIssuer(event.target.value)} placeholder="https://auth.k8s.land/dex" autoComplete="off" /></label>
          <label>{t("preview.oidcClientId")}<input required value={clientId} disabled={busy} onChange={(event) => setClientId(event.target.value)} placeholder="pi-pd-preview" autoComplete="off" /></label>
          <p>{t("preview.oidcNote")}</p>
        </>}
        <p>{t("preview.apiNote")}</p>
        <p>{t("preview.reloadNote")}</p>
      </form>
      {config?.oidc && <PreviewSignIn config={config} disabled={busy || changed} onChange={setConfig} />}
    </ConfigDetail>
    <ConfigFooter status={<ConfigFooterStatus tone={error ? "error" : "default"} summary={<span role={error ? "alert" : "status"}>{error || message}</span>} />}>
      <ConfigButton disabled={busy || !config?.configured} onClick={() => void test()}>{t("preview.test")}</ConfigButton>
      <ConfigButton type="submit" form="preview-settings-form" variant="primary" disabled={busy || !config}>{t("preview.save")}</ConfigButton>
    </ConfigFooter>
  </div>;
}
