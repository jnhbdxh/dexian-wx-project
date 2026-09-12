import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./api", () => ({ request: mocks.request }));

import { getResourceCalendar } from "./resource-calendar-api";

afterEach(() => vi.resetAllMocks());

describe("resource calendar API", () => {
  it("requests one store-local service date", () => {
    getResourceCalendar("2026-09-11");
    expect(mocks.request).toHaveBeenCalledWith(
      "/api/v1/admin/resource-calendar?serviceDate=2026-09-11",
    );
  });
});
