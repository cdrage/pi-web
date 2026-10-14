import { isAbsolute } from "node:path";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { PREVIEW_HTTP, PreviewError } from "../packages/pi-pd-preview/model";
import { hasJsonContentType, isApiRequestAllowed } from "./request-security";

const HTTP_FORBIDDEN = 403;
const HTTP_UNSUPPORTED_MEDIA = 415;
const MAX_BODY_BYTES = 16 * 1024;

export async function previewCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new PreviewError("cwd must be an absolute path.");
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw new PreviewError("Access denied.", HTTP_FORBIDDEN);
  }
  return cwd;
}

export async function previewBody(request: Request): Promise<Record<string, unknown>> {
  if (!isApiRequestAllowed(request)) {
    throw new PreviewError("Untrusted API request.", HTTP_FORBIDDEN);
  }
  if (!hasJsonContentType(request)) {
    throw new PreviewError("Content-Type must be application/json.", HTTP_UNSUPPORTED_MEDIA);
  }
  // Read a bounded stream before JSON parsing. Settings can carry a secret token.
  const reader = request.body?.getReader();
  if (!reader) {
    throw new PreviewError("Expected a JSON object.");
  }
  let text = "";
  let size = 0;
  const decoder = new TextDecoder();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) {
        break;
      }
      size += part.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new PreviewError("Preview request exceeds the size limit.");
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected an object");
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof PreviewError) {
      throw error;
    }
    throw new PreviewError("Invalid JSON object.");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function previewFailure(error: unknown): Response {
  const status = error instanceof PreviewError ? error.status : PREVIEW_HTTP.internalError;
  const message = error instanceof PreviewError ? error.message : "Preview request failed.";
  return Response.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}
