import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNightChannels, openNightChannels } from "../src/lifecycle";
import {
  createGuildChannel,
  createTextMessage,
  DiscordApiError,
  DiscordRateLimitError,
  listGuildChannels,
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("破壊的操作の安全策", () => {
  it("RESUME用Gateway URLにAPIバージョンとJSON形式を付ける", () => {
    const normalized = normalizeGatewayUrl("wss://gateway.discord.gg/?v=9&encoding=etf");
    expect(normalized).not.toBeNull();
    const url = new URL(normalized ?? "wss://invalid.discord.gg");
    expect(url.protocol).toBe("wss:");
    expect(url.searchParams.get("v")).toBe("10");
    expect(url.searchParams.get("encoding")).toBe("json");
    expect(normalizeGatewayUrl("wss://gateway-us-east1-b.discord.gg/?v=10")).not.toBeNull();
    expect(normalizeGatewayUrl("https://gateway.discord.gg")).toBeNull();
    expect(normalizeGatewayUrl("wss://gateway.discord.gg.attacker.example")).toBeNull();
    expect(normalizeGatewayUrl("wss://attacker.example/gateway")).toBeNull();
    expect(normalizeGatewayUrl("wss://user:secret@gateway.discord.gg")).toBeNull();
    expect(normalizeGatewayUrl("wss://gateway.discord.gg:8443")).toBeNull();
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
        if (method === "PUT" && url.includes("/permissions/")) {
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
    expect(requests.filter((request) => request.method === "PUT" && request.url.includes("/permissions/")))
      .toHaveLength(6);
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

  it("ログ投稿が失敗しても10チャンネルの削除を継続する", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        requests.push({ method, url });
        if (method === "GET") {
          return new Response(
            JSON.stringify([{
              id: "channel-1",
              type: 0,
              name: "深夜限定テキスト1-08-30",
              parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
            }]),
            { status: 200 },
          );
        }
        if (method === "POST" && url.includes("/messages")) {
          return new Response(null, { status: 403 });
        }
        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await closeNightChannels(liveTestEnv);

    expect(requests.some((request) => request.method === "POST" && request.url.includes("/messages")))
      .toBe(true);
    expect(requests.some((request) => request.method === "DELETE" && request.url.endsWith("/channels/channel-1")))
      .toBe(true);
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

  it("異常に大きいRetry-AfterはAlarmに使える有限の待機時間へ置き換える", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, {
        status: 429,
        headers: { "Retry-After": "1e308" },
      })),
    );

    await expect(createTextMessage(liveTestEnv, "123456789012345678", "test"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof DiscordRateLimitError && error.retryAfterMs === 300_000,
      );
  });

  it("Retry-Afterが欠けている429ではX-RateLimit-Reset-Afterを使う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, {
        status: 429,
        headers: { "X-RateLimit-Reset-After": "2.75" },
      })),
    );

    await expect(createTextMessage(liveTestEnv, "123456789012345678", "test"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof DiscordRateLimitError && error.retryAfterMs === 2_750,
      );
  });

  it("429の待機ヘッダーが両方欠けている場合は最低待機時間を使う", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 429 })),
    );

    await expect(createTextMessage(liveTestEnv, "123456789012345678", "test"))
      .rejects.toSatisfy((error: unknown) =>
        error instanceof DiscordRateLimitError && error.retryAfterMs === 1_000,
      );
  });

  it("Discordの応答本文が止まってもリクエストタイムアウトで中断する", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null | undefined;
    let releaseBody: ((body: string) => void) | undefined;
    let markBodyReadStarted: (() => void) | undefined;
    const bodyReadStarted = new Promise<void>((resolve) => {
      markBodyReadStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal;
        const response = new Response(null, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
        vi.spyOn(response, "text").mockImplementation(() => {
          markBodyReadStarted?.();
          return new Promise<string>((resolve, reject) => {
            releaseBody = resolve;
            capturedSignal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          });
        });
        return response;
      }),
    );

    const outcome = listGuildChannels(liveTestEnv)
      .then(() => "resolved" as const, () => "rejected" as const);
    // ヘッダー受信後に本文の読み込みで停止している状態を確実に作る。
    await bodyReadStarted;
    await vi.advanceTimersByTimeAsync(15_000);

    const timedOut = capturedSignal?.aborted === true;
    // 修正前の挙動でもテスト自体がハングしないよう、本文を解放してから結果を確認。
    if (!timedOut) {
      releaseBody?.("{}");
    }
    const result = await outcome;

    expect(timedOut).toBe(true);
    expect(result).toBe("rejected");
  });

  it("成功済みのメッセージ投稿は応答本文を待たずに完了する", async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | null | undefined;
    let responseText: ReturnType<typeof vi.spyOn> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        capturedSignal = init?.signal;
        const response = new Response(null, { status: 201 });
        responseText = vi.spyOn(response, "text").mockImplementation(() =>
          new Promise<string>((_resolve, reject) => {
            capturedSignal?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            }, { once: true });
          })
        );
        return response;
      }),
    );

    const outcome = createTextMessage(liveTestEnv, "123456789012345678", "test")
      .then(() => "resolved" as const, () => "rejected" as const);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(await outcome).toBe("resolved");
    expect(capturedSignal?.aborted).toBe(true);
    expect(responseText).not.toHaveBeenCalled();
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
