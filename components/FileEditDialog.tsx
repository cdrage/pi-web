"use client";

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useFileDraft } from "@/hooks/useFileDraft";
import { useI18n } from "@/hooks/useI18n";
import { dirtyFilePaths, getFileClose, resolveFileClose, subscribeFileEdits } from "@/lib/file-edit-store";
import { getFileName } from "@/lib/file-paths";
import { openStackedDialog } from "@/lib/stacked-dialog";
import "./FileEditor.css";

const serverClose = () => null;
const serverPaths = () => "[]";

export function FileEditDialog() {
  const { t } = useI18n();
  const request = useSyncExternalStore(subscribeFileEdits, getFileClose, serverClose);
  const dirtyPaths = useSyncExternalStore(subscribeFileEdits, dirtyFilePaths, serverPaths);
  const draft = useFileDraft(request?.filePath ?? "");
  const dialogRef = useRef<HTMLDialogElement>(null);

  // Browser navigation cannot await a save. The native prompt protects every draft.
  useEffect(() => {
    if (dirtyPaths === "[]") {
      return;
    }
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirtyPaths]);

  useEffect(() => {
    if (!request) {
      return;
    }
    const dialog = dialogRef.current;
    dialog?.showModal();
    const cleanup = openStackedDialog(document, dialog, () => void resolveFileClose("cancel"));
    return () => { cleanup(); dialog?.close(); };
  }, [request]);

  if (!request) {
    return null;
  }
  return createPortal(<dialog
    ref={dialogRef}
    className="file-edit-dialog"
    aria-labelledby="file-edit-title"
    aria-describedby="file-edit-description"
    onCancel={(event) => { event.preventDefault(); void resolveFileClose("cancel"); }}
    tabIndex={-1}
  >
    <h2 id="file-edit-title">{t("files.editor.closeTitle")}</h2>
    <p id="file-edit-description">{t("files.editor.closePrompt", { name: getFileName(request.filePath) })}</p>
    {draft?.error && <p className="file-editor-error" role="alert">{draft.error}</p>}
    <div className="file-edit-dialog-actions">
      <button type="button" disabled={draft?.saving} onClick={() => void resolveFileClose("cancel")}>{t("files.editor.cancel")}</button>
      <button type="button" disabled={draft?.saving} onClick={() => void resolveFileClose("discard")}>{t("files.editor.discard")}</button>
      <button type="button" className="file-editor-save" disabled={draft?.saving} onClick={() => void resolveFileClose("save")}>{t(draft?.saving ? "files.editor.saving" : "files.editor.save")}</button>
    </div>
  </dialog>, document.body);
}
