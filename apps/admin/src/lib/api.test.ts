import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  confirmReception,
  createLeave,
  getLeaveWorkbench,
  logout,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin API request headers", () => {
  it("does not send a JSON content type when POST has no body", async () => {
    let confirmationIdentity:
      | { staffUserId: string | undefined; storeId: string | undefined }
      | undefined;
    const received: Array<{
      body: string;
      contentType: string | undefined;
      csrf: string | undefined;
      idempotencyKey: string | undefined;
      method: string | undefined;
      path: string;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.url?.endsWith("/confirm")) {
          confirmationIdentity = {
            staffUserId: request.headers["x-initiating-staff-user-id"] as
              string | undefined,
            storeId: request.headers["x-initiating-store-id"] as
              string | undefined,
          };
        }
        received.push({
          body,
          contentType: request.headers["content-type"],
          csrf: request.headers["x-csrf-token"] as string | undefined,
          idempotencyKey: request.headers["idempotency-key"] as
            string | undefined,
          method: request.method,
          path: request.url ?? "",
        });
        if (
          request.url?.startsWith("/api/v1/admin/scheduling/leave-workbench")
        ) {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              user: {
                id: "00000000-0000-4000-8000-000000000010",
                storeId: "00000000-0000-4000-8000-000000000011",
                username: "frontdesk",
                displayName: "前台",
              },
              serverNow: "2026-09-10T01:00:00.000Z",
              canCreateLeave: true,
              therapists: [],
              conflictTotal: 0,
              conflicts: [],
              nextCursor: null,
            }),
          );
        } else if (request.url?.endsWith("/leaves")) {
          response.statusCode = 201;
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              restrictionId: "00000000-0000-4000-8000-000000000012",
              state: "active",
              invalidatedPendingCount: 0,
              affectedConfirmedCount: 0,
              invalidatedReceptions: [],
              conflicts: [],
            }),
          );
        } else if (request.url?.endsWith("/confirm")) {
          response.setHeader("Content-Type", "application/json");
          response.end(
            JSON.stringify({
              receptionId: "00000000-0000-4000-8000-000000000001",
              state: "confirmed",
              version: 2,
              quoteCents: "9500",
            }),
          );
        } else {
          response.statusCode = 204;
          response.end();
        }
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port");
    }
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("document", { cookie: "dexian_admin_csrf=test-csrf" });
    vi.stubGlobal("fetch", (path: string, init?: RequestInit) =>
      nativeFetch("http://127.0.0.1:" + address.port + path, init),
    );

    try {
      await getLeaveWorkbench();
      await getLeaveWorkbench("00000000-0000-4000-8000-000000000099");
      await createLeave(
        {
          therapistResourceId: "00000000-0000-4000-8000-000000000001",
          startAt: "2026-09-11T05:00:00.000Z",
          endAt: "2026-09-11T06:00:00.000Z",
          reasonPrivate: "已确认的个人请假",
        },
        "leave-attempt-1",
        {
          staffUserId: "00000000-0000-4000-8000-000000000002",
          storeId: "00000000-0000-4000-8000-000000000003",
        },
      );
      await confirmReception(
        "00000000-0000-4000-8000-000000000001",
        1,
        "confirmation-attempt-1",
        {
          staffUserId: "00000000-0000-4000-8000-000000000002",
          storeId: "00000000-0000-4000-8000-000000000003",
        },
      );
      await logout();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }

    expect(received).toEqual([
      {
        body: "",
        contentType: undefined,
        csrf: undefined,
        idempotencyKey: undefined,
        method: "GET",
        path: "/api/v1/admin/scheduling/leave-workbench",
      },
      {
        body: "",
        contentType: undefined,
        csrf: undefined,
        idempotencyKey: undefined,
        method: "GET",
        path: "/api/v1/admin/scheduling/leave-workbench?afterConflictId=00000000-0000-4000-8000-000000000099",
      },
      {
        body: JSON.stringify({
          therapistResourceId: "00000000-0000-4000-8000-000000000001",
          startAt: "2026-09-11T05:00:00.000Z",
          endAt: "2026-09-11T06:00:00.000Z",
          reasonPrivate: "已确认的个人请假",
          initiatingStaffUserId: "00000000-0000-4000-8000-000000000002",
          initiatingStoreId: "00000000-0000-4000-8000-000000000003",
        }),
        contentType: "application/json",
        csrf: "test-csrf",
        idempotencyKey: "leave-attempt-1",
        method: "POST",
        path: "/api/v1/admin/leaves",
      },
      {
        body: "",
        contentType: undefined,
        csrf: "test-csrf",
        idempotencyKey: "confirmation-attempt-1",
        method: "POST",
        path: "/api/v1/admin/receptions/00000000-0000-4000-8000-000000000001/confirm",
      },
      {
        body: "",
        contentType: undefined,
        csrf: "test-csrf",
        idempotencyKey: undefined,
        method: "POST",
        path: "/api/v1/admin/auth/logout",
      },
    ]);
    expect(confirmationIdentity).toEqual({
      staffUserId: "00000000-0000-4000-8000-000000000002",
      storeId: "00000000-0000-4000-8000-000000000003",
    });
  });
});
