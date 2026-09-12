import { describe, expect, it } from "vitest";

describe("integration test environment", () => {
  it("requires DATABASE_URL so database coverage cannot be skipped silently", () => {
    expect(
      process.env.DATABASE_URL,
      "DATABASE_URL is required: API integration tests must not be skipped",
    ).toBeTruthy();
  });
});
