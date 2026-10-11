import { describe, expect, it, mock } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { createFakeAppApiClient } from "./fakeAppApiClient.ts";
import { useCalendarConnect } from "./useCalendarConnect.ts";
import { installDom } from "../test/setup.tsx";
installDom();

describe("useCalendarConnect", () => {
  it("routes a 401 through the shared auth-failure path", async () => {
    const onAuthFailure = mock(() => {});
    const client = createFakeAppApiClient({
      failStartCalendarConnectWith: { code: "SAMO-AUTH-001", message: "expired", status: 401 },
    });
    const { result } = renderHook(() => useCalendarConnect({ client, onAuthFailure, navigate: () => {} }));

    await act(async () => { await result.current.connect(); });

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });
});
