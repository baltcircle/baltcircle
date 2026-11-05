import fs from "node:fs/promises";
import { constants } from "node:fs";

// Check and read the same open file; never reopen its pathname after checking it.
// The configured parent directory must be trusted. O_NOFOLLOW protects the leaf.
export async function readMigrationAttachment(filePath: string, dryRun = false) {
  if (typeof constants.O_NOFOLLOW !== "number") {
    throw new Error("This migration requires O_NOFOLLOW support");
  }
  const file = await fs.open(
    filePath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) return null;
    if (dryRun) return { size: Number(before.size), data: undefined };
    const data = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(data.length) !== before.size
    ) {
      throw new Error("Attachment changed while being read");
    }
    return { size: Number(before.size), data };
  } finally {
    await file.close();
  }
}
