"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { PREVIEW_CONFIG_EVENT, previewClient } from "@/lib/preview-client";
import { DEFAULT_PREVIEW_MODE, detectPreviewKind, type PreviewAction, type PreviewOptions, type PreviewSnapshot } from "@/packages/pi-pd-preview/model";
import { ConfigButton } from "./SettingsUi";
import { PreviewDesktop } from "./PreviewDesktop";
import { MoreIcon } from "./SidebarIcons";
import { SidebarMenu, type SidebarMenuAnchor } from "./SidebarMenu";
import "./Preview.css";

const POLL_MS = 10_000;
const SHA_LENGTH = 8;
const CONTROLS_WIDTH = 360;

export function PreviewIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M8 21h8M12 17v4m-3-14 6 3-6 3Z" /></svg>;
}

export function PreviewCard({ cwd, onSettings, onClose }: {
  cwd: string;
  onSettings: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [menu, setMenu] = useState<{ anchor: SidebarMenuAnchor; opener: HTMLButtonElement } | null>(null);
  const [desktopRevision, setDesktopRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<PreviewSnapshot | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[] | null>(null);
  const [confirm, setConfirm] = useState<"reset" | "stop" | null>(null);
  const [options, setOptions] = useState<PreviewOptions>({ autoUpdate: true });
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  const operation = useRef(false);
  const revision = useRef(0);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  useEffect(() => {
    if (!menu) {
      return;
    }

    // Clicks inside the VNC iframe stay in its document, so close on focus loss.
    const closeMenu = () => setMenu(null);
    window.addEventListener("blur", closeMenu);
    return () => window.removeEventListener("blur", closeMenu);
  }, [menu]);

  const load = useCallback(async (fresh = false) => {
    if (operation.current) {
      return;
    }
    const started = revision.current;
    try {
      const next = await previewClient.status(cwd, fresh);
      if (alive.current && started === revision.current) {
        setSnapshot(next);
        setError("");
      }
    } catch (error) {
      if (alive.current && started === revision.current) {
        setError(error instanceof Error ? error.message : t("preview.requestFailed"));
      }
    }
  }, [cwd, t]);

  useEffect(() => {
    alive.current = true;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState === "visible") {
        await load();
      }
      if (!disposed) {
        timer = setTimeout(tick, POLL_MS);
      }
    };
    void tick();
    const refresh = () => { void load(); };
    window.addEventListener("focus", refresh);
    window.addEventListener(PREVIEW_CONFIG_EVENT, refresh);
    return () => {
      alive.current = false;
      disposed = true;
      revision.current += 1;
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      window.removeEventListener(PREVIEW_CONFIG_EVENT, refresh);
    };
  }, [load]);

  async function run(action: PreviewAction) {
    if (operation.current) {
      return;
    }
    operation.current = true;
    revision.current += 1;
    setBusy(true);
    setError("");
    setNotice("");
    setConfirm(null);
    try {
      // An expired or incomplete binding retains its exact source for a safe retry.
      const input = action === "start" && !snapshotRef.current?.binding ? options : undefined;
      const next = await previewClient.action(cwd, action, input, snapshotRef.current?.context ?? undefined);
      if (!alive.current) {
        return;
      }
      setSnapshot(next);
      setLogs(null);
      setNotice(t(`preview.done.${action}`));
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : t("preview.requestFailed"));
        const next = await previewClient.status(cwd).catch(() => null);
        if (alive.current && next) {
          setSnapshot(next);
        }
      }
    } finally {
      operation.current = false;
      if (alive.current) {
        setBusy(false);
      }
    }
  }

  async function showLogs() {
    if (logs) {
      setLogs(null);
      return;
    }
    const started = revision.current;
    try {
      const result = await previewClient.logs(cwd);
      if (alive.current && started === revision.current) {
        setLogs(result.lines);
      }
    } catch (error) {
      if (alive.current) {
        setError(error instanceof Error ? error.message : t("preview.requestFailed"));
      }
    }
  }

  function textOption(name: keyof PreviewOptions, value: string) {
    setOptions((current) => {
      const next = { ...current, [name]: value };
      if (!value) {
        delete next[name];
      }
      if (name === "source" && /\/(pull|tree)\//.test(value)) {
        delete next.branch;
      }
      return next;
    });
  }

  function showSettings() {
    setMenu(null);
    onSettings();
  }

  const session = snapshot?.session;
  const binding = snapshot?.binding;
  const phase = snapshot?.expired ? "expired" : session?.phase ?? "pending";
  const phaseKey = ["pending", "building", "starting", "ready", "updating", "failed", "expired"].includes(phase) ? phase : "pending";
  const active = Boolean(session && !snapshot?.expired);
  // Use Git context for the default. Preserve manual choices across refreshes.
  const kind = options.kind ?? detectPreviewKind(snapshot?.context ?? { root: cwd, repo: null });
  const extension = kind === "extension";
  const desktopReady = active && session?.vncReady && Boolean(session.vncUrl);

  const controls = (
    <div className="preview-controls">
      <div className="preview-actions">
        <ConfigButton size="small" onClick={() => void load(true)} disabled={busy}>{t("preview.refresh")}</ConfigButton>
        <ConfigButton size="small" onClick={showSettings}>{t("preview.settings")}</ConfigButton>
      </div>
      {notice && <p className="preview-success" role="status">{notice}</p>}
      {!snapshot && !error && <p>{t("preview.load")}</p>}
      {snapshot && !snapshot.configured && <p>{t("preview.setup")} <ConfigButton size="small" onClick={showSettings}>{t("preview.configure")}</ConfigButton></p>}
      {snapshot?.configured && !snapshot.context && <p>{t("preview.noGit")}</p>}
      {binding && <details className="preview-details">
        <summary>{t("preview.details")} <span title={t("preview.autoHelp")}>{t(binding.spec.autoUpdate ? "preview.autoOn" : "preview.autoOff")}</span></summary>
        <div className="preview-source"><code>{binding.spec.repo}</code><code>{binding.spec.branch}</code><span>{binding.spec.kind} · {binding.spec.mode}</span></div>
      {session && (
        <>
          <dl className="preview-commits">
            <div><dt>{t("preview.local")}</dt><dd><code title={snapshot?.context?.head}>{snapshot?.context?.head.slice(0, SHA_LENGTH) || "?"}</code></dd></div>
            <div><dt>{t("preview.pushed")}</dt><dd><code title={snapshot?.pushedCommit ?? undefined}>{snapshot?.pushedCommit?.slice(0, SHA_LENGTH) || "?"}</code></dd></div>
            <div><dt>{t("preview.applied")}</dt><dd><code title={session.runtime?.appliedCommit}>{session.runtime?.appliedCommit.slice(0, SHA_LENGTH) || t("preview.none")}</code></dd></div>
            <div><dt>{t("preview.expires")}</dt><dd><time dateTime={session.expiresAt}>{new Date(session.expiresAt).toLocaleTimeString()}</time></dd></div>
          </dl>
          <p className={`preview-freshness is-${snapshot?.freshness}`}>{t(`preview.freshness.${snapshot?.freshness}`)}</p>
          {binding?.spec.repo !== snapshot?.context?.repo || binding?.spec.branch !== snapshot?.context?.branch ? <p>{t("preview.otherSource")}</p> : null}
          {session.runtime?.lastError && <p role="alert" className="preview-error">{session.runtime.lastError}</p>}
        </>
      )}
      <dl className="preview-help">
        <dt>{t("preview.autoUpdate")}</dt><dd>{t("preview.autoHelp")}</dd>
        <dt>{t("preview.sync")}</dt><dd>{t("preview.syncHelp")}</dd>
        <dt>{t("preview.reset")}</dt><dd>{t("preview.resetHelp")}</dd>
      </dl>
      </details>}
      {snapshot?.context?.dirty && <p className="preview-warning">{t("preview.dirty")}</p>}
      {active && (
        <div className="preview-actions">
          {desktopReady && <ConfigButton size="small" onClick={() => { setDesktopRevision((current) => current + 1); setMenu(null); }}>{t("preview.reconnect")}</ConfigButton>}
          <ConfigButton size="small" title={t("preview.syncHelp")} disabled={busy || !session?.runtime} onClick={() => void run("sync")}>{t("preview.sync")}</ConfigButton>
          <ConfigButton size="small" disabled={busy} onClick={() => void run("touch")}>{t("preview.touch")}</ConfigButton>
          <ConfigButton size="small" disabled={busy} onClick={() => void showLogs()}>{logs ? t("preview.hideLogs") : t("preview.logs")}</ConfigButton>
          <ConfigButton size="small" title={t("preview.resetHelp")} disabled={busy} onClick={() => setConfirm("reset")}>{t("preview.reset")}</ConfigButton>
          <ConfigButton size="small" variant="danger" disabled={busy} onClick={() => setConfirm("stop")}>{t("preview.stop")}</ConfigButton>
        </div>
      )}
      {confirm && <div className="preview-confirm" role="alert">
        <span>{t("preview.deleteWarning")}</span>
        <ConfigButton size="small" variant="danger" disabled={busy} onClick={() => void run(confirm)}>{t(`preview.${confirm}`)}</ConfigButton>
        <ConfigButton size="small" data-sidebar-menu-autofocus="" onClick={() => setConfirm(null)}>{t("preview.cancel")}</ConfigButton>
      </div>}
      {logs && <pre className="preview-logs" aria-label={t("preview.logs")}>{logs.join("\n") || t("preview.noLogs")}</pre>}
      {snapshot?.configured && snapshot.context && !active && (
        <form onSubmit={(event) => { event.preventDefault(); void run("start"); }} className="preview-form">
          {!binding && <>
            <label>{t("preview.source")}<input value={options.source ?? ""} onChange={(event) => textOption("source", event.target.value)} placeholder={snapshot.context.repo ?? "owner/repo"} /></label>
            <label>{t("preview.branch")}<input value={options.branch ?? ""} onChange={(event) => textOption("branch", event.target.value)} placeholder={options.source ? "" : snapshot.context.branch ?? ""} disabled={/\/pull\//.test(options.source ?? "")} /></label>
            <label>{t("preview.kind")}<select value={kind} onChange={(event) => setOptions({ kind: event.target.value as "desktop" | "extension", source: options.source, branch: options.branch, autoUpdate: options.autoUpdate })}><option value="desktop">Podman Desktop</option><option value="extension">{t("preview.extension")}</option></select></label>
            <details className="preview-advanced"><summary>{t("preview.advanced")}</summary>
              <label>{t("preview.mode")}<select value={options.mode ?? DEFAULT_PREVIEW_MODE} onChange={(event) => textOption("mode", event.target.value)}><option value="dev">dev</option><option value="compiled">compiled</option></select></label>
              {["autoUpdate", "includeK8s", "rootful"].map((key) => <label className="preview-check" key={key}><input type="checkbox" checked={Boolean(options[key as keyof PreviewOptions])} onChange={(event) => setOptions((current) => ({ ...current, [key]: event.target.checked }))} />{t(`preview.${key}`)}</label>)}
              {extension && <>
                <label>{t("preview.build")}<select value={options.extensionBuild ?? "pnpm"} onChange={(event) => textOption("extensionBuild", event.target.value)}><option value="pnpm">pnpm</option><option value="container">container</option></select></label>
                <label>{t("preview.extensionDir")}<input value={options.extensionDir ?? ""} onChange={(event) => textOption("extensionDir", event.target.value)} /></label>
                {options.extensionBuild === "container" && <label>Containerfile<input value={options.containerfile ?? ""} onChange={(event) => textOption("containerfile", event.target.value)} /></label>}
                <label>{t("preview.desktopRepo")}<input value={options.desktopRepo ?? ""} placeholder="podman-desktop/podman-desktop" onChange={(event) => textOption("desktopRepo", event.target.value)} /></label>
                <label>{t("preview.desktopBranch")}<input value={options.desktopBranch ?? ""} placeholder="main" onChange={(event) => textOption("desktopBranch", event.target.value)} /></label>
              </>}
            </details>
          </>}
          {binding && <p>{t(snapshot.expired ? "preview.expired" : "preview.incomplete")}</p>}
          <div className="preview-actions"><ConfigButton type="submit" variant="primary" size="small" disabled={busy}>{busy ? t("preview.wait") : t("preview.start")}</ConfigButton><span>{t("preview.pushNote")}</span></div>
          {snapshot.expired && binding?.id && <ConfigButton size="small" disabled={busy} onClick={() => setConfirm("stop")}>{t("preview.stop")}</ConfigButton>}
        </form>
      )}
    </div>
  );

  return (
    <section className="preview-card" aria-label={t("preview.title")} aria-busy={busy}>
      <div className="preview-heading">
        <PreviewIcon /><strong>{t("preview.title")}</strong>
        {binding && <span className={`preview-phase is-${phaseKey}`} role="status">{t(`preview.phase.${phaseKey}`)}</span>}
        <div className="preview-heading-actions">
          {desktopReady && <>
            <a className="preview-tool-button" href={session?.vncUrl} target="_blank" rel="noopener noreferrer" aria-label={t("preview.open")} title={t("preview.open")}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6m0-6L10 14M9 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-4" /></svg>
            </a>
            <button type="button" className="preview-tool-button" title={t("preview.controls")} aria-label={t("preview.controls")}
              aria-expanded={menu !== null} aria-haspopup="dialog"
              onClick={(event) => setMenu(menu ? null : {
                anchor: { kind: "rect", rect: event.currentTarget.getBoundingClientRect(), align: "end" },
                opener: event.currentTarget,
              })}><MoreIcon size={16} /></button>
          </>}
          <button type="button" className="preview-tool-button preview-close" onClick={onClose} aria-label={t("preview.close")} title={t("preview.close")}>×</button>
        </div>
      </div>
      {error && <p className="preview-error" role="alert">{error}</p>}
      {!desktopReady && controls}
      <SidebarMenu open={Boolean(desktopReady && menu)} anchor={menu?.anchor ?? null} sheet={isMobile}
        ariaLabel={t("preview.controls")} title={t("preview.controls")} cancelLabel={t("preview.cancel")}
        onClose={() => setMenu(null)} returnFocusTo={menu?.opener} width={CONTROLS_WIDTH} focusKey={confirm ?? "controls"}>
        {controls}
      </SidebarMenu>
      {desktopReady && session && <PreviewDesktop key={session.id} cwd={cwd} expiresAt={session.expiresAt} revision={desktopRevision} />}
    </section>
  );
}
