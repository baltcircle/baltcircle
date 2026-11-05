import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMigrationAttachment } from "./local-attachment-file";

let root: string;
let filename: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-file-test-"));
  filename = path.join(root, "attachment.bin");
  await fs.writeFile(filename, Buffer.from([0, 1, 2, 255]));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe("readMigrationAttachment", () => {
  it("reads a regular binary file", async () => {
    const result = await readMigrationAttachment(filename);
    expect(result?.size).toBe(4);
    expect(result?.data).toEqual(Buffer.from([0, 1, 2, 255]));
  });
  it("skips directories", async () => {
    expect(await readMigrationAttachment(root)).toBeNull();
  });
  it("rejects a symbolic link without reading its target", async () => {
    const link = path.join(root, "link.bin");
    await fs.symlink(filename, link);
    await expect(readMigrationAttachment(link)).rejects.toMatchObject({ code: "ELOOP" });
  });
  it("reports missing files", async () => {
    await expect(readMigrationAttachment(path.join(root, "missing")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not read bytes in dry-run and closes the descriptor", async () => {
    const open = fs.open;
    const handle = await open(filename, "r");
    const read = vi.spyOn(handle, "readFile");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    expect(await readMigrationAttachment(filename, true)).toEqual({ size: 4, data: undefined });
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("reads the opened inode even when its pathname is replaced", async () => {
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      await fs.rename(filename, filename + ".original");
      await fs.writeFile(filename, "replacement");
      return handle;
    });
    const result = await readMigrationAttachment(filename);
    expect(result?.data).toEqual(Buffer.from([0, 1, 2, 255]));
  });
  it("refuses content modified during the read and still closes", async () => {
    const handle = await fs.open(filename, "r");
    const read = handle.readFile.bind(handle);
    const close = vi.spyOn(handle, "close");
    vi.spyOn(handle, "readFile").mockImplementationOnce(async () => {
      const data = await read();
      await fs.writeFile(filename, "changed content");
      return data;
    });
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    await expect(readMigrationAttachment(filename)).rejects.toThrow("changed while being read");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("closes the descriptor when reading fails", async () => {
    const handle = await fs.open(filename, "r");
    const close = vi.spyOn(handle, "close");
    vi.spyOn(handle, "readFile").mockRejectedValueOnce(new Error("read failed"));
    vi.spyOn(fs, "open").mockResolvedValueOnce(handle);
    await expect(readMigrationAttachment(filename)).rejects.toThrow("read failed");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
