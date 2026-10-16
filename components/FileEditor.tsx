"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from "react";
import SyntaxHighlighter from "react-syntax-highlighter/dist/esm/prism-light";
import renderSyntaxNode from "react-syntax-highlighter/dist/esm/create-element";
import { vs, vscDarkPlus } from "react-syntax-highlighter/dist/cjs/styles/prism";
import { useFileDraft } from "@/hooks/useFileDraft";
import { useI18n } from "@/hooks/useI18n";
import { usePrismLanguages } from "@/hooks/usePrismLanguages";
import { useTheme } from "@/hooks/useTheme";
import { requestFileClose, saveFileDraft, updateFileDraft } from "@/lib/file-edit-store";
import { getFileExt } from "@/lib/file-types";
import "./FileEditor.css";

const EDITOR_HIGHLIGHT_MAX_LINES = 1_000;
const EDITOR_HIGHLIGHT_MAX_CHARS = 100_000;
const EDITOR_CODE_STYLE: CSSProperties = { font: "inherit", lineHeight: "inherit", tabSize: "inherit", whiteSpace: "inherit", overflowWrap: "inherit" };
const EDITOR_HIGHLIGHT_STYLE: CSSProperties = {
  ...EDITOR_CODE_STYLE,
  margin: 0,
  padding: 0,
  border: 0,
  background: "transparent",
  color: "var(--text)",
  textShadow: "none",
  overflow: "visible",
};

function editorTheme(theme: Record<string, CSSProperties>) {
  const next = { ...theme, 'pre[class*="language-"]': { ...theme['pre[class*="language-"]'] } };
  delete next['pre[class*="language-"]'].background;
  delete next['pre[class*="language-"]'].backgroundColor;
  return next;
}

const EDITOR_LIGHT_THEME = editorTheme(vs);
const EDITOR_DARK_THEME = editorTheme(vscDarkPlus);

function SourceHighlight({ text, language, lineCount }: { text: string; language: string; lineCount: number }) {
  const { isDark } = useTheme();
  const enabled = language !== "text" && lineCount <= EDITOR_HIGHLIGHT_MAX_LINES && text.length <= EDITOR_HIGHLIGHT_MAX_CHARS;
  const ready = usePrismLanguages(enabled);

  return useMemo(() => {
    // A final newline gives the last empty line the same height as the textarea.
    const code = `${text}\n`;
    if (!enabled || !ready) {
      return <pre className="source-editor-highlight" aria-hidden="true" style={EDITOR_HIGHLIGHT_STYLE}>
        {text.split("\n").map((line, index) => <span className="source-editor-line" key={index}>{`${line}\n`}</span>)}
      </pre>;
    }

    return <SyntaxHighlighter className="source-editor-highlight" aria-hidden="true" language={language}
      style={isDark ? EDITOR_DARK_THEME : EDITOR_LIGHT_THEME} customStyle={EDITOR_HIGHLIGHT_STYLE}
      wrapLines lineProps={{ className: "source-editor-line" }}
      renderer={({ rows, stylesheet, useInlineStyles }) => rows.slice(0, lineCount).map((node, index) =>
        renderSyntaxNode({ node, stylesheet, useInlineStyles, key: `editor-line-${index}` }))}
      codeTagProps={{ style: EDITOR_CODE_STYLE }}>{code}</SyntaxHighlighter>;
  }, [enabled, isDark, language, lineCount, ready, text]);
}

export function FileEditor({ filePath, language, wrapLines, onClose }: { filePath: string; language: string; wrapLines: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const draft = useFileDraft(filePath);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const codeRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLPreElement>(null);
  const focusOffset = draft?.focusOffset ?? 0;

  useEffect(() => {
    const input = inputRef.current;
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(focusOffset, focusOffset);
  }, [filePath, focusOffset]);

  useLayoutEffect(() => {
    const code = codeRef.current;
    const gutter = gutterRef.current;
    if (!code || !gutter) {
      return;
    }

    // Match each logical line's number to its visual height after soft wrap.
    const syncGutter = () => {
      const rows = code.querySelectorAll<HTMLElement>(".source-editor-line");
      const heights = Array.from(rows, (row) => row.getBoundingClientRect().height);
      Array.from(gutter.children).forEach((number, index) => {
        (number as HTMLElement).style.height = `${heights[index]}px`;
      });
    };
    syncGutter();

    // Defer resize writes so that Safari can finish its observer notifications.
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      frame = requestAnimationFrame(syncGutter);
    });
    observer.observe(code);
    return () => {
      observer.disconnect();
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
    };
  }, [draft?.text, wrapLines]);

  if (!draft) {
    return null;
  }
  const lines = draft.text.split("\n");
  const columns = lines.reduce((longest, line) => Math.max(longest, line.length), 1);

  async function save() {
    if (await saveFileDraft(filePath)) {
      requestFileClose(filePath, onClose);
    }
  }

  return <div className={wrapLines ? "source-editor is-wrapped" : "source-editor"}>
    <pre ref={gutterRef} className="source-editor-gutter" aria-hidden="true">{lines.map((_, index) => <span key={index}>{index + 1}</span>)}</pre>
    {/* Native input keeps selection and IME behavior over the colored text. */}
    <div ref={codeRef} className="source-editor-code">
    <SourceHighlight text={draft.text} language={getFileExt(filePath) === "svelte" ? "svelte" : language} lineCount={lines.length} />
    <textarea
      ref={inputRef}
      aria-label={t("files.editor.content")}
      value={draft.text}
      rows={lines.length}
      style={wrapLines ? undefined : { minWidth: `${columns + 1}ch` }}
      readOnly={draft.saving}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap={wrapLines ? "soft" : "off"}
      onChange={(event) => updateFileDraft(filePath, event.target.value)}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key.toLowerCase() === "s" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          requestFileClose(filePath, onClose);
          return;
        }
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          const input = event.currentTarget;
          const start = input.selectionStart;
          const end = input.selectionEnd;
          const value = `${draft.text.slice(0, start)}\t${draft.text.slice(end)}`;
          updateFileDraft(filePath, value);
          requestAnimationFrame(() => input.setSelectionRange(start + 1, start + 1));
        }
      }}
    />
    </div>
  </div>;
}

export function FileEditActions({ filePath, onClose }: { filePath: string; onClose: () => void }) {
  const { t } = useI18n();
  const draft = useFileDraft(filePath);
  if (!draft) {
    return null;
  }
  const dirty = draft.text !== draft.savedText;

  async function save() {
    if (await saveFileDraft(filePath)) {
      requestFileClose(filePath, onClose);
    }
  }

  return <div className="file-editor-actions">
    <span role="status">{t(draft.saving ? "files.editor.saving" : dirty ? "files.editor.unsaved" : "files.editor.saved")}</span>
    <button type="button" className="file-viewer-icon-button" disabled={!dirty || draft.saving} onClick={() => void save()} title={t("files.editor.saveHint")} aria-label={t("files.editor.save")}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2Z" />
        <path d="M7 3v6h10V3M7 21v-8h10v8" />
      </svg>
    </button>
    <button type="button" className="file-viewer-icon-button" disabled={draft.saving} onClick={() => requestFileClose(filePath, onClose)} title={t("files.editor.back")} aria-label={t("files.editor.back")}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m18 6-12 12M6 6l12 12" />
      </svg>
    </button>
  </div>;
}
