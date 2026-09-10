import { describe, expect, it } from "vitest";

import {
  createToken,
  hashPassword,
  hashToken,
  verifyPassword,
} from "../src/lib/crypto.js";

describe("authentication crypto", () => {
  it("hashes and verifies passwords without storing the original value", async () => {
    const password = "stage-zero-password";
    const encoded = await hashPassword(password);

    expect(encoded).not.toContain(password);
    await expect(verifyPassword(password, encoded)).resolves.toBe(true);
    await expect(verifyPassword("wrong-password", encoded)).resolves.toBe(
      false,
    );
  });

  it("creates opaque session tokens and stable hashes", () => {
    const token = createToken();
    expect(token.length).toBeGreaterThan(32);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(token);
  });
});
