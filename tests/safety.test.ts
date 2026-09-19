import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNightChannels, openNightChannels } from "../src/lifecycle";
import {
  createGuildChannel,
  createTextMessage,
  DiscordApiError,
  DiscordRateLimitError,
  normalizeGatewayUrl,
} from "../src/discord";
import type { Env } from "../src/config";

const liveTestEnv: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_DEEP_PARENT_CATEGORY_ID: "987654321098765432",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
  DISCORD_DEEP_ROLE_ID: "456789012345678901",
  DISCORD_ACTIVITY_DETAIL_CHANNEL_ID: "567890123456789012",
};

const dryRunEnv: Env = {
  ...liveTestEnv,
  DRY_RUN: "true",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("破壊的操作の安全策", () => {
  it("RESUME用Gateway URLにAPIバージョンとJSON形式を付ける", () => {
    const normalized = normalizeGatewayUrl("wss://gateway.example.test/?v=9&encoding=etf");
    expect(normalized).not.toBeNull();
    const url = new URL(normalized ?? "wss://invalid.example.test");
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("v")).toBe("10");
    expect(url.searchParams.get("encoding")).toBe("json");
    expect(normalizeGatewayUrl("https://gateway.example.test")).toBeNull();
  });

  it("DRY_RUNではDiscord APIを一切呼ばない", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await openNightChannels(dryRunEnv, Date.UTC(2026, 7, 30, 15, 0));
    await closeNightChannels(dryRunEnv);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("10チャンネルを作り、通常テキスト1と深層テキスト1へ一度ずつ告知する", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];
    let createdChannelNumber = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ method, url, body });

        if (method === "GET" && url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`)) {
          return new Response("[]", { status: 200 });
        }
        if (method === "POST" && url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`)) {
          const channel = JSON.parse(body ?? "{}");
          const id = `created-channel-${createdChannelNumber}`;
          createdChannelNumber += 1;
          return new Response(
            JSON.stringify({
              id,
              name: channel.name,
              type: channel.type,
              parent_id: channel.parent_id,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }
        if (method === "POST" && url.includes("/messages")) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await openNightChannels(liveTestEnv, Date.UTC(2026, 7, 30, 15, 0));

    const channelCreates = requests.filter(
      (request) => request.method === "POST" &&
        request.url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`),
    );
    expect(channelCreates).toHaveLength(10);
    expect(channelCreates.map((request) => JSON.parse(request.body ?? "{}").name)).toEqual([
      "深夜限定テキスト1-08-31",
      "深夜限定テキスト2-08-31",
      "深夜限定テキスト3-08-31",
      "深夜限定通話1-08-31",
      "深夜限定通話2-08-31",
      "深夜限定通話3-08-31",
      "深層-深夜限定テキスト1-08-31",
      "深層-深夜限定テキスト2-08-31",
      "深層-深夜限定通話1-08-31",
      "深層-深夜限定通話2-08-31",
    ]);
    expect(JSON.parse(channelCreates[4]?.body ?? "{}").user_limit).toBe(8);
    expect(JSON.parse(channelCreates[8]?.body ?? "{}").user_limit).toBe(0);
    const announcements = requests.filter(
      (request) => request.method === "POST" && request.url.includes("/messages"),
    );
    expect(announcements).toHaveLength(2);
    expect(announcements.map((request) => request.url)).toEqual([
      expect.stringContaining("/channels/created-channel-0/messages"),
      expect.stringContaining("/channels/created-channel-6/messages"),
    ]);
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("終了時も履歴APIを呼ばず、ログ投稿後に10チャンネルを削除する", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        requests.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
        if (method === "GET") {
          return new Response(
            JSON.stringify(Array.from({ length: 10 }, (_, index) => ({
              id: `channel-${index}`,
              type: index < 3 || index === 6 || index === 7 ? 0 : 2,
              name: index < 3
                ? `深夜限定テキスト${index + 1}-08-30`
                : index < 6
                  ? `深夜限定通話${index - 2}-08-30`
                  : index < 8
                    ? `深層-深夜限定テキスト${index - 5}-08-30`
                    : `深層-深夜限定通話${index - 7}-08-30`,
              parent_id: index >= 6
                ? liveTestEnv.DISCORD_DEEP_PARENT_CATEGORY_ID
                : liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
            }))),
            { status: 200 },
          );
        }
        return new Response(null, { status: 204 });
      }),
    );

    await closeNightChannels(liveTestEnv);

    expect(requests.some((request) => request.method === "GET" && request.url.includes("/messages")))
      .toBe(false);
    expect(requests.filter((request) => request.method === "POST" && request.url.includes("/messages")))
      .toHaveLength(1);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(10);
  });

  it("429のRetry-Afterを上限30秒に丸めず、Alarm用エラーとして返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, {
        status: 429,
        headers: { "Retry-After": "61.5" },
      })),
    );

    await expect(createTextMessage(liveTestEnv, "123456789012345678", "test"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof DiscordRateLimitError && error.retryAfterMs === 61_500,
      );
  });

  it("投稿再試行用のnonceで同じ通知を二重作成しない", async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      }),
    );

    await createTextMessage(
      liveTestEnv,
      "123456789012345678",
      "今日のログ",
      { nonce: "summary-2026-08-29" },
    );

    expect(requestBody).toMatchObject({
      nonce: "summary-2026-08-29",
      enforce_nonce: true,
    });
  });

  it("チャンネル作成POSTの5xxを自動再送して二重作成しない", async () => {
    const fetchSpy = vi.fn(async () => new Response(null, { status: 502 }));
    vi.stubGlobal("fetch", fetchSpy);

    await expect(createGuildChannel(liveTestEnv, {
      name: "深夜限定テキスト1-08-30",
      type: 0,
      parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof DiscordApiError && error.status === 502,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
