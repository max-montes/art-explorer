const fileFromEntry = (entry: FileSystemFileEntry) =>
  new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function directoryEntries(entry: FileSystemDirectoryEntry) {
  const reader = entry.createReader();
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>(
      (resolve, reject) => reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) return entries;
    entries.push(...batch);
  }
}

async function filesFromEntry(
  entry: FileSystemEntry,
): Promise<File[]> {
  if (entry.isFile) {
    return [await fileFromEntry(entry as FileSystemFileEntry)];
  }
  const entries = await directoryEntries(entry as FileSystemDirectoryEntry);
  return (await Promise.all(entries.map(filesFromEntry))).flat();
}

export async function filesFromDrop(dataTransfer: DataTransfer) {
  const entries = Array.from(dataTransfer.items)
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null);

  if (entries.length > 0) {
    return (await Promise.all(entries.map(filesFromEntry))).flat();
  }
  return Array.from(dataTransfer.files);
}

export const hasFilePayload = (dataTransfer: DataTransfer) =>
  Array.from(dataTransfer.types).includes("Files");

export const isSupportedCuratorFile = (file: File) =>
  file.type.startsWith("image/") && file.type !== "image/gif";
