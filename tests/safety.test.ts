import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNightChannels, openNightChannels } from "../src/lifecycle";
import { countChannelMessages } from "../src/discord";
import type { Env } from "../src/config";

const dryRunEnv: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
  DRY_RUN: "true",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safe test behavior", () => {
  it("does not call Discord at all in dry-run scheduled operations", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await openNightChannels(dryRunEnv, Date.UTC(2026, 7, 30, 15, 0));
    await closeNightChannels(dryRunEnv);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts paginated messages using GET requests only", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({ id: String(1000 - index) })),
      [{ id: "1" }],
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          method: init?.method ?? "GET",
          url: String(input),
        });
        return new Response(JSON.stringify(pages.shift() ?? []), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    await expect(countChannelMessages(dryRunEnv, "456789012345678901")).resolves.toBe(101);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.method)).toEqual(["GET", "GET"]);
    expect(requests[1]?.url).toContain("before=901");
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });
});
