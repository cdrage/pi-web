import { commentOutdated, patchId, type ReviewComment, type ReviewState, type ReviewTarget } from "./code-review";

const STORAGE_PREFIX = "pi-web:code-review:v1:";
const STORAGE_VERSION = 1;
const ID_RADIX = 36;
const STORAGE_ERROR = "The browser cannot save this review. The review remains in this tab.";
const INVALID_REVIEW_ERROR = "The saved review is invalid. The review remains in this tab.";
const EMPTY_REVIEW: ReviewState = { comments: [], reviewed: {} };
const entries = new Map<string, ReviewEntry>();

interface ReviewEntry {
  key: string;
  state: ReviewState;
  serialized: string;
  error: string | null;
  dirty: boolean;
  browser: Window | null;
  listeners: Set<() => void>;
}

function normalizeCwd(cwd: string): string {
  const windowsPath = /^[a-zA-Z]:[\\/]/.test(cwd) || cwd.startsWith("\\\\") || cwd.startsWith("//");
  const path = windowsPath ? cwd.replace(/\\/g, "/").toLowerCase() : cwd;
  const drive = /^[a-zA-Z]:\//.test(path) ? path.slice(0, 3) : null;
  const prefix = drive ?? (path.startsWith("//") ? "//" : path.startsWith("/") ? "/" : "");
  const parts: string[] = [];
  for (const part of path.slice(prefix.length).split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop();
      continue;
    }
    if (part === ".." && prefix) {
      continue;
    }
    parts.push(part);
  }
  return prefix + parts.join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validRange(start: unknown, end: unknown): boolean {
  if (start === null || end === null) {
    return start === null && end === null;
  }
  return typeof start === "number" && typeof end === "number"
    && Number.isSafeInteger(start) && Number.isSafeInteger(end) && start > 0 && end >= start;
}

function validTarget(value: unknown): value is ReviewTarget {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.filePath === "string" && value.filePath.length > 0
    && typeof value.path === "string" && value.path.length > 0
    && typeof value.patchId === "string" && value.patchId.length > 0
    && typeof value.code === "string"
    && validRange(value.oldStart, value.oldEnd) && validRange(value.newStart, value.newEnd);
}

function validComment(value: unknown): value is ReviewComment {
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0
    && typeof value.body === "string" && value.body.trim().length > 0 && validTarget(value.target);
}

function copyTarget(target: ReviewTarget): ReviewTarget {
  return {
    filePath: target.filePath, path: target.path, patchId: target.patchId,
    oldStart: target.oldStart, oldEnd: target.oldEnd,
    newStart: target.newStart, newEnd: target.newEnd, code: target.code,
  };
}

function serializeState(state: ReviewState): string {
  return JSON.stringify({
    comments: state.comments.map(({ id, target, body }) => ({ id, target: copyTarget(target), body })),
    reviewed: Object.fromEntries(Object.entries(state.reviewed).sort(([left], [right]) => left.localeCompare(right))),
  });
}

function readState(raw: string | null): ReviewState {
  if (raw === null) {
    return EMPTY_REVIEW;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(INVALID_REVIEW_ERROR);
  }
  if (!isRecord(value) || value.version !== STORAGE_VERSION || !isRecord(value.state)) {
    throw new Error(INVALID_REVIEW_ERROR);
  }
  const { comments, reviewed } = value.state;
  if (!Array.isArray(comments) || !comments.every(validComment) || !isRecord(reviewed)) {
    throw new Error(INVALID_REVIEW_ERROR);
  }
  if (new Set(comments.map((comment) => comment.id)).size !== comments.length
    || Object.values(reviewed).some((id) => typeof id !== "string" || id.length === 0)) {
    throw new Error(INVALID_REVIEW_ERROR);
  }

  // Keep only the supported shape so saved data cannot inject extra state.
  return {
    comments: comments.map(({ id, body, target }) => ({ id, target: copyTarget(target), body })),
    reviewed: Object.fromEntries(Object.entries(reviewed)) as Record<string, string>,
  };
}

function notify(entry: ReviewEntry): void {
  for (const listener of entry.listeners) {
    listener();
  }
}

function applyState(entry: ReviewEntry, state: ReviewState): boolean {
  const serialized = serializeState(state);
  if (serialized === entry.serialized) {
    return false;
  }
  entry.state = state;
  entry.serialized = serialized;
  return true;
}

function setError(entry: ReviewEntry, error: string | null): boolean {
  if (entry.error === error) {
    return false;
  }
  entry.error = error;
  // React observes snapshot identity, including an error without data changes.
  entry.state = { ...entry.state };
  return true;
}

function loadEntry(entry: ReviewEntry, raw?: string | null): void {
  if (typeof window === "undefined" || entry.dirty) {
    return;
  }
  try {
    const state = readState(raw === undefined ? window.localStorage.getItem(entry.key) : raw);
    const changed = applyState(entry, state);
    const errorChanged = setError(entry, null);
    if (changed || errorChanged) {
      notify(entry);
    }
  } catch (error) {
    const nextError = error instanceof Error && error.message === INVALID_REVIEW_ERROR ? INVALID_REVIEW_ERROR : STORAGE_ERROR;
    if (setError(entry, nextError)) {
      notify(entry);
    }
  }
}

function getEntry(cwd: string): ReviewEntry {
  const normalized = normalizeCwd(cwd);
  let entry = entries.get(normalized);
  if (!entry) {
    entry = {
      key: STORAGE_PREFIX + encodeURIComponent(normalized),
      state: EMPTY_REVIEW, serialized: serializeState(EMPTY_REVIEW),
      error: null, dirty: false, browser: null, listeners: new Set(),
    };
    entries.set(normalized, entry);
  }
  if (typeof window !== "undefined" && entry.browser !== window) {
    entry.browser = window;
    loadEntry(entry);
  }
  return entry;
}

function persist(entry: ReviewEntry, state: ReviewState): void {
  if (serializeState(state) === entry.serialized) {
    return;
  }
  applyState(entry, state);
  entry.dirty = true;
  try {
    if (typeof window === "undefined") {
      throw new Error(STORAGE_ERROR);
    }
    window.localStorage.setItem(entry.key, JSON.stringify({ version: STORAGE_VERSION, state }));
    entry.dirty = false;
    entry.error = null;
  } catch {
    entry.error = STORAGE_ERROR;
  }
  notify(entry);
}

export function getReview(cwd: string): ReviewState {
  return getEntry(cwd).state;
}

export function subscribeReview(cwd: string, listener: () => void): () => void {
  const entry = getEntry(cwd);
  loadEntry(entry);
  entry.listeners.add(listener);
  if (typeof window === "undefined") {
    return () => { entry.listeners.delete(listener); };
  }

  const browser = window;
  const onStorage = (event: StorageEvent) => {
    if (event.key !== entry.key && event.key !== null) {
      return;
    }
    try {
      if (event.storageArea && event.storageArea !== browser.localStorage) {
        return;
      }
    } catch {
      return;
    }
    loadEntry(entry, event.key === null ? undefined : event.newValue);
  };
  browser.addEventListener("storage", onStorage);
  return () => {
    entry.listeners.delete(listener);
    browser.removeEventListener("storage", onStorage);
  };
}

export function saveComment(cwd: string, target: ReviewTarget, body: string, id?: string): void {
  const trimmed = body.trim();
  if (!trimmed || !validTarget(target)) {
    return;
  }
  const entry = getEntry(cwd);
  // Read recent changes before a write so another tab's comments survive.
  loadEntry(entry);
  // HTTP on a LAN can lack randomUUID. Comment ids do not authorize access.
  const commentId = id ?? globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(ID_RADIX)}-${Math.random().toString(ID_RADIX).slice(2)}`;
  const comment: ReviewComment = { id: commentId, target: copyTarget(target), body: trimmed };
  const index = entry.state.comments.findIndex((current) => current.id === commentId);
  const comments = [...entry.state.comments];
  if (index < 0) {
    comments.push(comment);
  } else {
    comments[index] = comment;
  }
  persist(entry, { ...entry.state, comments });
}

export function deleteComment(cwd: string, id: string): void {
  const entry = getEntry(cwd);
  loadEntry(entry);
  const comments = entry.state.comments.filter((comment) => comment.id !== id);
  if (comments.length === entry.state.comments.length) {
    return;
  }
  persist(entry, { ...entry.state, comments });
}

export function pruneReview(cwd: string, patches: Record<string, string | null>): ReviewState {
  const entry = getEntry(cwd);
  loadEntry(entry);

  // Drop obsolete targets only after Git returns a fresh diff for their file.
  const comments = entry.state.comments.filter((comment) => {
    const patch = patches[comment.target.filePath];
    return patch === undefined || !commentOutdated(comment, patch);
  });
  if (comments.length !== entry.state.comments.length) {
    persist(entry, { ...entry.state, comments });
  }

  return entry.state;
}

export function toggleReviewed(cwd: string, filePath: string, patch: string): void {
  const entry = getEntry(cwd);
  loadEntry(entry);
  const id = patchId(patch);
  const reviewed = { ...entry.state.reviewed };
  if (reviewed[filePath] === id) {
    delete reviewed[filePath];
  } else {
    reviewed[filePath] = id;
  }
  persist(entry, { ...entry.state, reviewed });
}

export function reviewError(cwd: string): string | null {
  return getEntry(cwd).error;
}

export function clearReview(cwd: string): void {
  const entry = getEntry(cwd);
  loadEntry(entry);
  persist(entry, EMPTY_REVIEW);
}
