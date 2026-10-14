"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { previewClient } from "@/lib/preview-client";

export function PreviewDesktop({ cwd, expiresAt, revision }: { cwd: string; expiresAt: string; revision: number }) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    void previewClient.desktop(cwd).then((desktop) => {
      if (!disposed) { setUrl(desktop.url); setError(""); }
    }).catch((error) => {
      if (!disposed) { setError(error instanceof Error ? error.message : t("preview.requestFailed")); }
    });
    return () => { disposed = true; };
  }, [cwd, expiresAt, revision, t]);

  return <div className="preview-desktop">
    {error && <p className="preview-error" role="alert">{error}</p>}
    {!url && !error && <p>{t("preview.connect")}</p>}
    {url && <iframe key={revision} src={url} title={t("preview.desktop")}
      allow="clipboard-read; clipboard-write; fullscreen; keyboard-map" referrerPolicy="no-referrer"
      sandbox="allow-scripts allow-same-origin allow-forms allow-pointer-lock allow-downloads" />}
  </div>;
}
