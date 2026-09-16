import type { CuratorIndexRecord } from "@/lib/curation/types";
import { isSupportedCuratorFile } from "@/lib/curation/dropped-files";

export interface CuratorUploadResult {
  uploads: Array<{
    record: CuratorIndexRecord;
    duplicate: boolean;
    mediaUrl: string;
  }>;
  skipped: number;
}

export const CURATOR_UPLOAD_EVENT = "commonplace:curator-upload";
export const CURATOR_UPLOAD_STORAGE_KEY = "commonplace:pending-curator-upload";

export async function uploadCuratorFiles(
  files: File[],
): Promise<CuratorUploadResult> {
  const supported = files.filter(isSupportedCuratorFile);
  const skipped = files.length - supported.length;
  if (supported.length === 0) {
    throw new Error("No supported artwork files were found.");
  }

  const form = new FormData();
  supported.forEach((file) => form.append("files", file));
  const response = await fetch("/api/admin/curation/upload", {
    method: "POST",
    body: form,
  });
  const payload: {
    uploads?: CuratorUploadResult["uploads"];
    error?: string;
  } = await response.json();
  if (!response.ok || !payload.uploads) {
    throw new Error(payload.error ?? "Upload failed.");
  }
  return { uploads: payload.uploads, skipped };
}
