import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));

vi.mock("./api", () => ({ request: mocks.request }));

import { getReception, getReceptions } from "./receptions-api";

afterEach(() => vi.resetAllMocks());

describe("admin reception API", () => {
  it("serializes the active filters and cursor using the server contract", () => {
    getReceptions({
      serviceDate: "2026-09-11",
      state: "confirmed",
      therapistId: "00000000-0000-4000-8000-000000000001",
      receptionId: "00000000-0000-4000-8000-000000000002",
      after: "00000000-0000-4000-8000-000000000003",
    });

    expect(mocks.request).toHaveBeenCalledWith(
      "/api/v1/admin/receptions?serviceDate=2026-09-11&state=confirmed&therapistId=00000000-0000-4000-8000-000000000001&receptionId=00000000-0000-4000-8000-000000000002&after=00000000-0000-4000-8000-000000000003",
    );
  });

  it("encodes a reception id when loading details", () => {
    getReception("reception/id");

    expect(mocks.request).toHaveBeenCalledWith(
      "/api/v1/admin/receptions/reception%2Fid",
    );
  });
});
