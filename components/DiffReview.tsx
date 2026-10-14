"use client";

import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import type { useCodeReview } from "@/hooks/useCodeReview";
import { useI18n } from "@/hooks/useI18n";
import {
  buildReviewTarget,
  commentOutdated,
  fileReviewTarget,
  parseReviewPatch,
  patchId,
  type ReviewComment,
  type ReviewTarget,
} from "@/lib/code-review";
import { getRelativeFilePath } from "@/lib/file-paths";
import "./DiffReview.css";

interface Props {
  patch: string;
  filePath: string;
  review: ReturnType<typeof useCodeReview>;
  onAddReview?: (loadPrompt: (cwd?: string) => Promise<string>, send?: boolean) => Promise<boolean>;
  onOpenDiff?: (filePath: string) => void;
}

interface EditorState {
  target: ReviewTarget;
  id?: string;
  index: number | null;
  inList: boolean;
}

const LABEL_SEPARATOR = " · ";
function ReviewCard({ comment, showCode, onEdit, onDelete, onOpen }: {
  comment: ReviewComment;
  showCode?: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onOpen?: () => void;
}) {
  const { t } = useI18n();
  const { target } = comment;
  const anchors: string[] = [];
  if (target.oldStart !== null) {
    anchors.push(t("review.oldLines", { start: target.oldStart, end: target.oldEnd ?? target.oldStart }));
  }
  if (target.newStart !== null) {
    anchors.push(t("review.newLines", { start: target.newStart, end: target.newEnd ?? target.newStart }));
  }

  return (
    <article className="diff-review-card" data-review-comment={comment.id}>
      <div className="diff-review-card-head">
        {onOpen ? <button type="button" className="diff-review-path" onClick={onOpen}>{target.path}</button> : <span className="diff-review-path">{target.path}</span>}
        <span className="diff-review-anchor">{anchors.join(LABEL_SEPARATOR) || t("review.file")}</span>
      </div>
      {showCode && target.code && <pre className="diff-review-snippet">{target.code}</pre>}
      <p className="diff-review-body">{comment.body}</p>
      <div className="diff-review-card-actions">
        <button type="button" onClick={onEdit}>{t("review.edit")}</button>
        <button type="button" onClick={onDelete}>{t("review.delete")}</button>
      </div>
    </article>
  );
}

export function DiffReview({ patch, filePath, review, onAddReview, onOpenDiff }: Props) {
  const { t } = useI18n();
  const lines = useMemo(() => parseReviewPatch(patch), [patch]);
  const positions = useMemo(() => lines.flatMap((line, index) => line.type === "hunk" ? [] : [index]), [lines]);
  const fingerprint = useMemo(() => patchId(patch), [patch]);
  const path = getRelativeFilePath(filePath, review.cwd);
  const fileIndex = review.filePaths.indexOf(filePath);
  const previousFile = fileIndex > 0 ? review.filePaths[fileIndex - 1] : undefined;
  const nextFile = fileIndex >= 0 ? review.filePaths[fileIndex + 1] : undefined;
  const rootRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<number, HTMLDivElement>());
  const searchRef = useRef<HTMLInputElement>(null);
  const [cursor, setCursor] = useState(positions[0] ?? 0);
  const [anchor, setAnchor] = useState<number | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [body, setBody] = useState("");
  const [showList, setShowList] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const start = Math.min(anchor ?? cursor, cursor);
  const end = Math.max(anchor ?? cursor, cursor);
  const selectedCount = positions.filter((index) => index >= start && index <= end).length;
  const commentCount = review.state.comments.length;
  const matches = useMemo(() => {
    if (!query) {
      return [];
    }
    const search = query.toLocaleLowerCase();
    return positions.filter((index) => lines[index].text.toLocaleLowerCase().includes(search));
  }, [query, positions, lines]);
  const matchSet = useMemo(() => new Set(matches), [matches]);
  const fileComments = useMemo(() => review.state.comments.filter((comment) => comment.target.filePath === filePath), [review.state.comments, filePath]);
  const commentRows = useMemo(() => {
    const indices = new Map<string, number | null>();
    for (const comment of fileComments) {
      const { target } = comment;
      if (commentOutdated(comment, patch)) {
        indices.set(comment.id, null);
        continue;
      }
      const index = positions.find((position) => target.newEnd !== null
        ? lines[position].newLine === target.newEnd
        : target.oldEnd !== null && lines[position].oldLine === target.oldEnd);
      indices.set(comment.id, index ?? null);
    }
    return indices;
  }, [fileComments, patch, positions, lines]);

  // A patch update invalidates the selection and the editor's original target.
  useEffect(() => {
    setCursor(positions[0] ?? 0);
    setAnchor(null);
    setEditor(null);
    setBody("");
    setNotice(null);
  }, [filePath, fingerprint, positions]);

  useEffect(() => {
    if (showSearch) {
      searchRef.current?.focus();
    }
  }, [showSearch]);

  // Close the summary after the last comment disappears in this tab or another tab.
  useEffect(() => {
    if (!commentCount) {
      setShowList(false);
    }
    setEditor((current) => current?.id && !review.state.comments.some((comment) => comment.id === current.id) ? null : current);
  }, [commentCount, review.state.comments]);

  function focusDiff() {
    rootRef.current?.focus({ preventScroll: true });
  }

  function moveCursor(index: number) {
    if (!positions.includes(index)) {
      return;
    }
    setCursor(index);
    setAnchor(null);
    rowRefs.current.get(index)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function selectLine(index: number, event: MouseEvent<HTMLButtonElement>) {
    const extend = event.shiftKey && lines[anchor ?? cursor]?.hunk === lines[index].hunk;
    setAnchor(extend ? anchor ?? cursor : index);
    setCursor(index);
    setShowList(false);
    focusDiff();
  }

  function openEditor(target: ReviewTarget, index: number | null, id?: string, text = "", inList = false) {
    setEditor({ target, index, id, inList });
    setBody(text);
    setNotice(null);
  }

  function addComment(wholeFile = false) {
    if (!review.ready) {
      return;
    }
    const target = wholeFile ? fileReviewTarget(filePath, path, patch) : buildReviewTarget(filePath, path, patch, lines, start, end);
    if (target) {
      setShowList(false);
      openEditor(target, wholeFile ? null : end);
    }
  }

  function toggleList() {
    if (showList && editor?.inList) {
      closeEditor();
    }
    setShowList(!showList);
  }

  function removeComment(id: string) {
    review.deleteComment(id);
    if (commentCount === 1) {
      focusDiff();
    }
  }

  function closeEditor() {
    setEditor(null);
    setBody("");
    focusDiff();
  }

  function saveComment() {
    if (!editor || !review.ready || !body.trim()) {
      return;
    }
    review.saveComment(editor.target, body.trim(), editor.id);
    closeEditor();
    setAnchor(null);
  }

  async function exportComments(toChat = false, send = false) {
    if (!review.ready || exporting || !review.state.comments.length) {
      return;
    }
    setExporting(true);
    setNotice(null);
    setActionError(null);
    let noComments = false;
    const loadPrompt = async (cwd?: string) => {
      const prompt = await review.exportReview(cwd);
      noComments = !prompt;
      return prompt;
    };

    try {
      if (toChat && onAddReview) {
        const inserted = await onAddReview(loadPrompt, send);
        if (!inserted) {
          setActionError(t(noComments ? "review.noComments" : send ? "review.sendError" : "review.contextChanged"));
          return;
        }
        setNotice(t(send ? "review.sent" : "review.added"));
        return;
      }
      const prompt = await loadPrompt();
      if (noComments) {
        setActionError(t("review.noComments"));
        return;
      }

      try {
        await navigator.clipboard.writeText(prompt);
        setNotice(t("review.copied"));
      } catch {
        setActionError(t("review.copyError"));
      }
    } catch {
      setActionError(t("review.exportError"));
    } finally {
      setExporting(false);
    }
  }

  function commentIndex(comment: ReviewComment) {
    return commentRows.get(comment.id) ?? null;
  }

  function nextMatch(direction: number) {
    if (!matches.length) {
      return;
    }
    const next = direction > 0 ? matches.find((index) => index > cursor) : matches.findLast((index) => index < cursor);
    moveCursor(next ?? (direction > 0 ? matches[0] : matches[matches.length - 1]));
  }

  function handleEscape(event: KeyboardEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.key !== "Escape") {
      return;
    }

    // Consume a local Escape before the page's agent-stop listener receives it.
    event.preventDefault();
    if (editor) {
      closeEditor();
      return;
    }
    if (showSearch) {
      setShowSearch(false);
      focusDiff();
      return;
    }
    if (showList) {
      setShowList(false);
      focusDiff();
      return;
    }
    setAnchor(null);
  }

  function renderEditor() {
    return (
      <form className="diff-review-editor" onSubmit={(event) => { event.preventDefault(); saveComment(); }}>
        <textarea
          autoFocus
          value={body}
          onChange={(event) => setBody(event.target.value)}
          aria-label={t("review.commentInput")}
          placeholder={t("review.placeholder")}
          rows={3}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              saveComment();
            }
          }}
        />
        <div className="diff-review-card-actions">
          <button type="submit" disabled={!body.trim() || !review.ready}>{t("review.save")}</button>
          <button type="button" onClick={closeEditor}>{t("review.cancel")}</button>
        </div>
      </form>
    );
  }

  function renderComment(comment: ReviewComment, inList = false) {
    if (editor?.id === comment.id) {
      return <Fragment key={comment.id}>{renderEditor()}</Fragment>;
    }
    return <ReviewCard
      key={comment.id}
      comment={comment}
      showCode={inList}
      onEdit={() => openEditor(comment.target, commentIndex(comment), comment.id, comment.body, inList)}
      onDelete={() => removeComment(comment.id)}
      onOpen={inList && onOpenDiff ? () => onOpenDiff(comment.target.filePath) : undefined}
    />;
  }

  const aboveComments = fileComments.filter((comment) => commentIndex(comment) === null);

  return (
    <div
      ref={rootRef}
      className="diff-review"
      tabIndex={0}
      aria-label={t("review.title")}
      onKeyDownCapture={handleEscape}
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("button, input, textarea, a, select")) {
          focusDiff();
        }
      }}
    >
      <div className="diff-review-toolbar" role="toolbar" aria-label={t("review.title")}>
        {onOpenDiff && <div className="diff-review-navigation" role="group" aria-label={t("sidebar.changedFiles", { count: review.filePaths.length })}>
          <button
            type="button"
            onClick={() => { if (previousFile) { onOpenDiff(previousFile); } }}
            disabled={!previousFile}
            aria-label={t("review.previousFile")}
            title={previousFile ? getRelativeFilePath(previousFile, review.cwd) : t("review.previousFile")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          {fileIndex >= 0 && <span>{t("review.filePosition", { current: fileIndex + 1, total: review.filePaths.length })}</span>}
          <button
            type="button"
            onClick={() => { if (nextFile) { onOpenDiff(nextFile); } }}
            disabled={!nextFile}
            aria-label={t("review.nextFile")}
            title={nextFile ? getRelativeFilePath(nextFile, review.cwd) : t("review.nextFile")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>}
        <div className="diff-review-tools">
          <button type="button" className="diff-review-file-comment" onClick={() => addComment(true)} disabled={!review.ready} aria-label={t("review.fileComment")} title={t("review.fileComment")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v6m-3-3h6" />
            </svg>
            <span className="diff-review-file-label">{t("review.fileComment")}</span>
          </button>
          <span className="diff-review-toolbar-hint" title={t("review.selectHint")}>{!commentCount && anchor === null && !editor && t("review.selectHint")}</span>
          {!!commentCount && <button type="button" onClick={toggleList} aria-expanded={showList}>{t("review.comments", { count: commentCount })}</button>}
          {!!commentCount && <button
            type="button"
            className="diff-review-submit"
            onClick={() => void exportComments(!!onAddReview)}
            disabled={!review.ready || exporting}
            title={onAddReview ? t("review.addToChatHint") : undefined}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12h16m-6-6 6 6-6 6" />
            </svg>
            {onAddReview ? t("review.addToChat") : t("review.copy")}
          </button>}
          {!!commentCount && onAddReview && <button
            type="button"
            className="diff-review-send"
            onClick={() => void exportComments(true, true)}
            disabled={!review.ready || exporting}
          >{t("review.addAndSend")}</button>}
          <button type="button" className="diff-review-search-toggle" onClick={() => setShowSearch(!showSearch)} aria-label={t("review.search")} title={t("review.search")} aria-expanded={showSearch}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" />
            </svg>
          </button>
        </div>
      </div>
      {(notice || actionError || review.error) && <div
        className={`diff-review-notice ${actionError || review.error ? "diff-review-error" : "diff-review-success"}`}
        role={actionError || review.error ? "alert" : "status"}
      >{actionError || review.error || notice}</div>}
      {showSearch && <div className="diff-review-search">
        <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("review.searchPlaceholder")} aria-label={t("review.search")} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
        }} />
        {query && <span>{matches.length || t("review.noMatches")}</span>}
        <button type="button" onClick={() => { setShowSearch(false); focusDiff(); }} aria-label={t("review.close")}>×</button>
      </div>}
      {showList && !!commentCount && <section className="diff-review-list" aria-label={t("review.comments", { count: commentCount })}>
        {review.state.comments.map((comment) => renderComment(comment, true))}
        <div className="diff-review-list-actions">
          {onAddReview && <button type="button" onClick={() => void exportComments()} disabled={!review.ready || exporting}>{t("review.copy")}</button>}
          <button type="button" onClick={() => { if (window.confirm(t("review.clearConfirm"))) { review.clearReview(); closeEditor(); } }}>{t("review.clear")}</button>
        </div>
      </section>}
      {!showList && aboveComments.map((comment) => renderComment(comment))}
      {editor && editor.index === null && !editor.id && renderEditor()}
      <div className="diff-review-code">
        {!lines.length && <p className="diff-review-hint">{t("review.noChanges")}</p>}
        {lines.map((line, index) => {
          if (line.type === "hunk") {
            return <div key={line.id} className="diff-review-hunk">{line.text}</div>;
          }
          const selected = anchor !== null && index >= start && index <= end;
          return <Fragment key={line.id}>
            <div
              ref={(element) => { if (element) { rowRefs.current.set(index, element); } else { rowRefs.current.delete(index); } }}
              className={`diff-review-row diff-review-${line.type}${cursor === index ? " is-cursor" : ""}${selected ? " is-selected" : ""}${matchSet.has(index) ? " is-match" : ""}`}
              data-review-index={index}
              data-review-selected={selected ? "true" : undefined}
              data-review-cursor={cursor === index ? "true" : undefined}
            >
              {(["old", "new"] as const).map((side) => {
                const number = side === "old" ? line.oldLine : line.newLine;
                return <button key={side} type="button" className="diff-review-gutter" tabIndex={side === "new" || line.newLine === null ? 0 : -1} disabled={number === null} data-review-index={index} data-review-side={side} aria-label={number === null ? t(`review.${side}`) : t("review.selectLine", { line: number })} title={t(`review.${side}`)} onClick={(event) => selectLine(index, event)}>{number ?? ""}</button>;
              })}
              <span className="diff-review-prefix" aria-hidden="true">{line.type === "added" ? "+" : line.type === "removed" ? "-" : " "}</span>
              <code>{line.text || "\u00a0"}</code>
            </div>
            {anchor !== null && index === end && !editor && <div className="diff-review-selection" role="group" aria-label={t("review.selection", { count: selectedCount })}>
              <span>{selectedCount === 1 ? t("review.oneLine") : t("review.selection", { count: selectedCount })}</span>
              <button type="button" onClick={() => addComment()} disabled={!review.ready}>{t("review.comment")}</button>
              <button type="button" className="diff-review-dismiss" onClick={() => { setAnchor(null); focusDiff(); }} aria-label={t("review.clearSelection")} title={t("review.clearSelection")}>×</button>
            </div>}
            {!showList && fileComments.filter((comment) => commentIndex(comment) === index).map((comment) => renderComment(comment))}
            {editor && editor.index === index && !editor.id && renderEditor()}
          </Fragment>;
        })}
      </div>
    </div>
  );
}
