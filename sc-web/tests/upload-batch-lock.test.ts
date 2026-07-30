import { describe, expect, it } from "vitest";
import { UploadBatchLock } from "@/lib/upload-batch-lock";

describe("UploadBatchLock", () => {
  it("allows only one upload pump until the active batch releases", () => {
    const lock = new UploadBatchLock();
    expect(lock.tryAcquire()).toBe(true);
    expect(lock.tryAcquire()).toBe(false);
    lock.release();
    expect(lock.tryAcquire()).toBe(true);
  });
});
