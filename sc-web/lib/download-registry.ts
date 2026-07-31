// Shared in-memory registry for temporary download files.
// Both the upload and download routes access this.

export interface DownloadEntry {
  filePath: string;
  name: string;
  size: number;
  expiresAt: number;
}

export const downloads = new Map<string, DownloadEntry>();
