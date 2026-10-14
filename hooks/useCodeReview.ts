"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { formatReview, type ReviewState, type ReviewTarget } from "@/lib/code-review";
import {
  clearReview,
  deleteComment,
  getReview,
  pruneReview,
  reviewError,
  saveComment,
  subscribeReview,
} from "@/lib/code-review-store";
import { loadReviewPatches, loadReviewStatus } from "@/lib/code-review-client";

const EMPTY_REVIEW: ReviewState = { comments: [], reviewed: {} };
const serverSnapshot = () => EMPTY_REVIEW;

interface ReviewCatalog {
  cwd: string;
  root: string;
  filePaths: string[];
}

export function useCodeReview(cwd: string, filePath: string, patch: string, refreshKey = 0) {
  const [catalog, setCatalog] = useState<ReviewCatalog | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [focusRevision, setFocusRevision] = useState(0);
  const ready = catalog?.cwd === cwd;
  const reviewCwd = ready ? catalog.root : cwd;

  const subscribe = useCallback((listener: () => void) => subscribeReview(reviewCwd, listener), [reviewCwd]);
  const readSnapshot = useCallback(() => getReview(reviewCwd), [reviewCwd]);
  const state = useSyncExternalStore(subscribe, readSnapshot, serverSnapshot);
  const pathsKey = JSON.stringify([...new Set([
    ...state.comments.map((comment) => comment.target.filePath),
  ])].sort());

  useEffect(() => {
    const refresh = () => setFocusRevision((revision) => revision + 1);
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);

  useEffect(() => {
    if (!cwd) {
      return;
    }

    const controller = new AbortController();

    void loadReviewStatus(cwd, controller.signal).then((status) => {
      if (controller.signal.aborted) {
        return;
      }

      // A repository root shares drafts across its subfolders and isolates worktrees.
      setCatalog({
        cwd,
        root: status.repositoryRoot ?? cwd,
        filePaths: status.isGitRepository ? status.files.map((file) => file.filePath) : [],
      });
      setStatusError(null);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setStatusError(error instanceof Error ? error.message : "Cannot load changed files.");
      }
    });

    return () => controller.abort();
  }, [cwd, refreshKey, focusRevision]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    const controller = new AbortController();
    const paths = JSON.parse(pathsKey) as string[];

    void loadReviewPatches(reviewCwd, paths, controller.signal).then((patches) => {
      if (!controller.signal.aborted) {
        pruneReview(reviewCwd, patches);
        setPatchError(null);
      }
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        setPatchError(error instanceof Error ? error.message : "Cannot load the review diff.");
      }
    });

    return () => controller.abort();
  }, [ready, reviewCwd, pathsKey, filePath, patch, refreshKey, focusRevision]);

  const save = useCallback((target: ReviewTarget, body: string, id?: string) => {
    if (ready) {
      saveComment(reviewCwd, target, body, id);
    }
  }, [ready, reviewCwd]);

  const remove = useCallback((id: string) => deleteComment(reviewCwd, id), [reviewCwd]);
  const clear = useCallback(() => clearReview(reviewCwd), [reviewCwd]);

  const exportReview = useCallback(async (cwd = reviewCwd) => {
    // Refresh every target before export so changed files leave no old comments.
    const review = getReview(reviewCwd);
    const paths = review.comments.map((comment) => comment.target.filePath);
    const patches = await loadReviewPatches(reviewCwd, paths);
    return formatReview(pruneReview(reviewCwd, patches), patches, cwd);
  }, [reviewCwd]);

  return {
    cwd: reviewCwd,
    filePaths: ready ? catalog.filePaths : [],
    state,
    ready,
    error: statusError ?? patchError ?? reviewError(reviewCwd),
    saveComment: save,
    deleteComment: remove,
    clearReview: clear,
    exportReview,
  };
}
