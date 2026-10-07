export type MediaStorageStage = "preflight" | "decode" | "dns" | "upload" | "readback";
export type MediaStorageDiagnostic = { code: string; stage: MediaStorageStage; httpStatus: number | null };

const CODES = new Set([
  "MEDIA_STORAGE_TIME_BUDGET", "MEDIA_STORAGE_SOURCE_INVALID", "MEDIA_STORAGE_BYTE_LIMIT",
  "MEDIA_STORAGE_FORMAT_INVALID", "MEDIA_STORAGE_DECODE_FAILED", "MEDIA_STORAGE_BYTES_CHANGED",
  "MEDIA_STORAGE_DNS_UNSAFE", "MEDIA_STORAGE_DISABLED", "MEDIA_STORAGE_CONFIGURATION_INVALID",
  "MEDIA_STORAGE_MIME_NOT_ENABLED", "MEDIA_STORAGE_UPLOAD_UNCONFIRMED", "MEDIA_STORAGE_READ_FAILED",
]);
const STAGES = new Set<MediaStorageStage>(["preflight", "decode", "dns", "upload", "readback"]);

/** Contains no response body, URL, headers, credentials, or arbitrary provider message. */
export class MediaStorageFailure extends Error {
  readonly diagnostic: MediaStorageDiagnostic;
  constructor(error: unknown, stage: MediaStorageStage, httpStatus: number | null = null) {
    const code = error instanceof Error && CODES.has(error.message) ? error.message : "MEDIA_STORAGE_UPLOAD_UNCONFIRMED";
    super(code);
    this.diagnostic = { code, stage: STAGES.has(stage) ? stage : "upload",
      httpStatus: Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? httpStatus : null };
  }
}

export function mediaStorageDiagnostic(error: unknown, stage: MediaStorageStage): MediaStorageDiagnostic {
  return error instanceof MediaStorageFailure ? { ...error.diagnostic } : new MediaStorageFailure(error, stage).diagnostic;
}
