import type {
  CurationState,
  CuratorDraft,
  ValidationIssue,
} from "./types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const states = new Set<CurationState>(["draft", "approved"]);
const mediaTypes = new Set(["artwork"]);
const libraryCategories = new Set(["artwork"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown, field: string): string[] => {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === "string")
  ) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
};

/** Capitalize the first letter and drop exact (case-insensitive) duplicates. */
export const normalizeAssociations = (labels: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of labels) {
    const label = raw
      .trim()
      .replace(/\s+/g, " ")
      .replace(/[.,;:!]+$/, "")
      .trim();
    if (!label) continue;
    const key = label.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(label.charAt(0).toLocaleUpperCase() + label.slice(1));
  }
  return result;
};

const text = (value: unknown, field: string) => {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  return value.trim();
};

const parseSource = (value: unknown): NonNullable<CuratorDraft["source"]> => {
  if (!isRecord(value)) throw new Error("source must be an object.");
  const sourceUrl = text(value.sourceUrl, "source.sourceUrl");
  if (!/^https:\/\//.test(sourceUrl)) {
    throw new Error("source.sourceUrl must be an https URL.");
  }
  const licenseUrl =
    value.licenseUrl === undefined || value.licenseUrl === ""
      ? undefined
      : text(value.licenseUrl, "source.licenseUrl");
  return {
    provider: text(value.provider, "source.provider"),
    sourceUrl,
    license: text(value.license, "source.license"),
    ...(licenseUrl ? { licenseUrl } : {}),
  };
};

export function parseCuratorDraft(value: unknown): CuratorDraft {
  if (!isRecord(value)) {
    throw new Error("Draft must be an object.");
  }
  const state = text(value.state, "state") as CurationState;
  const mediaType = text(value.mediaType, "mediaType");
  const libraryCategory =
    value.libraryCategory === undefined
      ? "artwork"
      : text(value.libraryCategory, "libraryCategory");
  if (!states.has(state)) throw new Error("Invalid curation state.");
  if (!mediaTypes.has(mediaType)) {
    throw new Error("mediaType must be artwork.");
  }
  if (!libraryCategories.has(libraryCategory)) {
    throw new Error("Invalid library category.");
  }
  if (typeof value.byteSize !== "number" || value.byteSize < 0) {
    throw new Error("byteSize must be a non-negative number.");
  }
  const dimension = (raw: unknown, field: string) => {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      throw new Error(`${field} must be a positive integer.`);
    }
    return raw;
  };
  const width = dimension(value.width, "width");
  const height = dimension(value.height, "height");

  return {
    id: text(value.id, "id"),
    fileName: text(value.fileName, "fileName"),
    sha256: text(value.sha256, "sha256").toLowerCase(),
    byteSize: value.byteSize,
    mimeType: text(value.mimeType, "mimeType"),
    state,
    mediaType: mediaType as CuratorDraft["mediaType"],
    libraryCategory: libraryCategory as CuratorDraft["libraryCategory"],
    ...(width && height ? { width, height } : {}),
    title: text(value.title, "title"),
    creator: text(value.creator, "creator"),
    ...(value.year !== undefined && value.year !== ""
      ? { year: text(value.year, "year") }
      : {}),
    ...(value.source !== undefined && value.source !== null
      ? { source: parseSource(value.source) }
      : {}),
    associations: normalizeAssociations(
      strings(value.associations, "associations"),
    ),
    narrative:
      value.narrative === undefined ? "" : text(value.narrative, "narrative"),
    notes: value.notes === undefined ? "" : text(value.notes, "notes"),
  };
}

export function validateForApproval(draft: CuratorDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!draft.id) issues.push({ field: "id", message: "Draft id is required." });
  if (!draft.fileName) {
    issues.push({ field: "fileName", message: "File name is required." });
  }
  if (!SHA256_PATTERN.test(draft.sha256)) {
    issues.push({
      field: "sha256",
      message: "A valid SHA-256 digest is required.",
    });
  }
  if (draft.associations.length === 0) {
    issues.push({
      field: "associations",
      message: "Add at least one associated word or phrase.",
    });
  }
  return issues;
}
