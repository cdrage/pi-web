export const FILE_EDIT_MAX_BYTES = 1024 * 1024;

export interface FileEditSnapshot {
  content: string;
  revision: string;
}
