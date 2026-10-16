import { readEditFile, writeEditFile } from "./file-edit-client";

interface FileDraft {
  text: string;
  savedText: string;
  revision: string;
  lineEnding: string;
  saving: boolean;
  error: string | null;
  focusOffset: number;
}

interface CloseRequest {
  filePath: string;
  onClose: () => void;
}

// Drafts outlive viewers, which unmount on tab and workspace switches.
const drafts = new Map<string, FileDraft>();
const listeners = new Set<() => void>();
const saveListeners = new Set<(filePath: string) => void>();
let closeRequest: CloseRequest | null = null;

function notify() {
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeFileEdits(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function onFileSaved(listener: (filePath: string) => void): () => void {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
}

export function getFileDraft(filePath: string) {
  return drafts.get(filePath) ?? null;
}

export function getFileClose() {
  return closeRequest;
}

export function dirtyFilePaths(): string {
  return JSON.stringify([...drafts].filter(([, draft]) => draft.text !== draft.savedText).map(([filePath]) => filePath));
}

export async function startFileEdit(filePath: string, line = 1): Promise<void> {
  if (drafts.has(filePath)) {
    return;
  }
  const snapshot = await readEditFile(filePath);
  if (drafts.has(filePath)) {
    return;
  }
  const text = snapshot.content.replace(/\r\n?/g, "\n");
  drafts.set(filePath, {
    text, savedText: text, revision: snapshot.revision,
    lineEnding: snapshot.content.match(/\r\n|\r|\n/)?.[0] ?? "\n",
    saving: false, error: null,
    focusOffset: text.split("\n").slice(0, Math.max(0, line - 1)).reduce((offset, value) => offset + value.length + 1, 0),
  });
  notify();
}

export function updateFileDraft(filePath: string, text: string): void {
  const draft = drafts.get(filePath);
  if (!draft || draft.saving) {
    return;
  }
  drafts.set(filePath, { ...draft, text, error: null });
  notify();
}

export async function saveFileDraft(filePath: string): Promise<boolean> {
  const draft = drafts.get(filePath);
  if (!draft || draft.saving) {
    return false;
  }
  if (draft.text === draft.savedText) {
    return true;
  }
  drafts.set(filePath, { ...draft, saving: true, error: null });
  notify();

  try {
    const snapshot = await writeEditFile(filePath, {
      content: draft.text.replace(/\n/g, draft.lineEnding), revision: draft.revision,
    });
    drafts.set(filePath, { ...draft, savedText: draft.text, revision: snapshot.revision, saving: false, error: null });
    for (const listener of saveListeners) {
      listener(filePath);
    }
    return true;
  } catch (error) {
    drafts.set(filePath, { ...draft, saving: false, error: error instanceof Error ? error.message : String(error) });
    return false;
  } finally {
    notify();
  }
}

export function requestFileClose(filePath: string, onClose: () => void): void {
  const draft = drafts.get(filePath);
  if (draft?.saving || closeRequest) {
    return;
  }
  if (draft && draft.text !== draft.savedText) {
    closeRequest = { filePath, onClose };
    notify();
    return;
  }
  drafts.delete(filePath);
  notify();
  onClose();
}

export async function resolveFileClose(action: "save" | "discard" | "cancel"): Promise<void> {
  const request = closeRequest;
  if (!request || drafts.get(request.filePath)?.saving) {
    return;
  }
  if (action === "cancel") {
    closeRequest = null;
    notify();
    return;
  }
  if (action === "save" && !await saveFileDraft(request.filePath)) {
    return;
  }
  drafts.delete(request.filePath);
  closeRequest = null;
  notify();
  request.onClose();
}
