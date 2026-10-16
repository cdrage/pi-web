import { encodeFilePathForApi } from "./file-paths";
import type { FileEditSnapshot } from "./file-edit-types";

export async function readEditFile(filePath: string): Promise<FileEditSnapshot> {
  return editRequest(filePath);
}

export async function writeEditFile(filePath: string, snapshot: FileEditSnapshot): Promise<FileEditSnapshot> {
  return editRequest(filePath, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(snapshot),
  });
}

async function editRequest(filePath: string, init?: RequestInit): Promise<FileEditSnapshot> {
  const response = await fetch(`/api/files/${encodeFilePathForApi(filePath)}?type=edit`, { ...init, cache: "no-store" });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
  }
  return body as FileEditSnapshot;
}
