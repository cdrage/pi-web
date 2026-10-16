import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isExistingFilePathAllowed } from "./file-access";
import { FILE_EDIT_MAX_BYTES, type FileEditSnapshot } from "./file-edit-types";

const HTTP_BAD_REQUEST = 400;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_TOO_LARGE = 413;
const FILE_MODE_MASK = 0o777;
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0) | (fs.constants.O_NOFOLLOW || 0);

export class FileEditError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function editTarget(filePath: string, roots: Set<string>): string {
  if (!isExistingFilePathAllowed(filePath, roots)) {
    throw new FileEditError("Access denied", HTTP_FORBIDDEN);
  }

  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new FileEditError("Only regular files can be edited", HTTP_BAD_REQUEST);
  }
  return fs.realpathSync(filePath);
}

function readSnapshot(filePath: string): FileEditSnapshot {
  const descriptor = fs.openSync(filePath, OPEN_FLAGS);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new FileEditError("Only regular files can be edited", HTTP_BAD_REQUEST);
    }
    if (stat.size > FILE_EDIT_MAX_BYTES) {
      throw new FileEditError("Editing is limited to files of 1 MiB", HTTP_TOO_LARGE);
    }

    // Read one byte past the limit so a growing file never becomes a partial draft.
    const bytes = Buffer.alloc(FILE_EDIT_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) {
        break;
      }
      length += count;
    }
    if (length > FILE_EDIT_MAX_BYTES) {
      throw new FileEditError("Editing is limited to files of 1 MiB", HTTP_TOO_LARGE);
    }

    const data = bytes.subarray(0, length);
    const content = data.toString("utf8");
    if (data.includes(0) || !Buffer.from(content, "utf8").equals(data)) {
      throw new FileEditError("Only UTF-8 text files can be edited", HTTP_BAD_REQUEST);
    }
    return { content, revision: createHash("sha256").update(data).digest("hex") };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readFileEdit(filePath: string, roots: Set<string>): FileEditSnapshot {
  try {
    return readSnapshot(editTarget(filePath, roots));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileEditError("File no longer exists", HTTP_NOT_FOUND);
    }
    throw error;
  }
}

export function saveFileEdit(filePath: string, roots: Set<string>, content: string, revision: string): FileEditSnapshot {
  if (Buffer.byteLength(content, "utf8") > FILE_EDIT_MAX_BYTES) {
    throw new FileEditError("Editing is limited to files of 1 MiB", HTTP_TOO_LARGE);
  }
  if (content.includes("\0")) {
    throw new FileEditError("Only UTF-8 text files can be edited", HTTP_BAD_REQUEST);
  }

  const target = editTarget(filePath, roots);
  const original = readSnapshot(target);
  if (original.revision !== revision) {
    throw new FileEditError("The file changed on disk. Copy your edits, then reopen the editor.", HTTP_CONFLICT);
  }

  // Stage beside the target. A failed write leaves the original file intact.
  const stat = fs.statSync(target);
  const directory = fs.mkdtempSync(path.join(path.dirname(target), ".pi-edit-"));
  const staged = path.join(directory, "file");
  try {
    fs.writeFileSync(staged, content, { encoding: "utf8", flag: "wx", mode: stat.mode & FILE_MODE_MASK, flush: true });
    fs.chmodSync(staged, stat.mode & FILE_MODE_MASK);

    // Recheck authorization and content after staging, before replacing the entry.
    const currentTarget = editTarget(filePath, roots);
    if (currentTarget !== target || readSnapshot(currentTarget).revision !== revision) {
      throw new FileEditError("The file changed on disk. Copy your edits, then reopen the editor.", HTTP_CONFLICT);
    }
    fs.renameSync(staged, target);
    return { content, revision: createHash("sha256").update(content, "utf8").digest("hex") };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
