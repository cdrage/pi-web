"use client";

import { useCallback, useSyncExternalStore } from "react";
import { getFileDraft, subscribeFileEdits } from "@/lib/file-edit-store";

const serverSnapshot = () => null;

export function useFileDraft(filePath: string) {
  const snapshot = useCallback(() => getFileDraft(filePath), [filePath]);
  return useSyncExternalStore(subscribeFileEdits, snapshot, serverSnapshot);
}
