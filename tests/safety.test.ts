import { afterEach, describe, expect, it, vi } from "vitest";
import { closeNightChannels, openNightChannels } from "../src/lifecycle";
import { countChannelMessages } from "../src/discord";
import type { Env } from "../src/config";

const liveTestEnv: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
};

const dryRunEnv: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
  DRY_RUN: "true",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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

  it("creates two text and two voice channels and announces in text channel 1", async () => {
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
              parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
            }),
            { status: 201, headers: { "Content-Type": "application/json" } },
          );
        }

        if (method === "POST" && url.includes("/channels/created-channel-0/messages")) {
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await openNightChannels(liveTestEnv, Date.UTC(2026, 7, 30, 15, 0));

    const channelCreates = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`),
    );
    expect(channelCreates.map((request) => JSON.parse(request.body ?? "{}")).map((body) => body.name)).toEqual([
      "深夜限定テキスト1-08-31",
      "深夜限定テキスト2-08-31",
      "深夜限定通話1-08-31",
      "深夜限定通話2-08-31",
    ]);
    expect(channelCreates.map((request) => JSON.parse(request.body ?? "{}")).map((body) => body.type)).toEqual([
      0,
      0,
      2,
      2,
    ]);

    const announcements = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/channels/created-channel-0/messages"),
    );
    expect(announcements).toHaveLength(1);
    expect(JSON.parse(announcements[0]?.body ?? "{}").content).toContain(
      "今日のチャンネルが作成されました！",
    );
    expect(requests.some((request) => request.method === "DELETE")).toBe(false);
  });

  it("logs the combined message count from both text channels", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        const body = typeof init?.body === "string" ? init.body : undefined;
        requests.push({ method, url, body });

        if (method === "GET" && url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`)) {
          return new Response(
            JSON.stringify([
              {
                id: "night-text-1-id",
                name: "深夜限定テキスト1-08-30",
                type: 0,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-text-2-id",
                name: "深夜限定テキスト2-08-30",
                type: 0,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-voice-1-id",
                name: "深夜限定通話1-08-30",
                type: 2,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-voice-2-id",
                name: "深夜限定通話2-08-30",
                type: 2,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/channels/night-text-1-id/messages?")) {
          return new Response(JSON.stringify([{ id: "message-1" }, { id: "message-2" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (url.includes("/channels/night-text-2-id/messages?")) {
          return new Response(JSON.stringify([{ id: "message-3" }]), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }

        if (method === "POST" && url.includes("/channels/1543273845257928747/messages")) {
          return new Response(null, { status: 204 });
        }

        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await closeNightChannels(liveTestEnv);

    const logPosts = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/channels/1543273845257928747/messages"),
    );
    expect(logPosts).toHaveLength(1);
    expect(JSON.parse(logPosts[0]?.body ?? "{}").content).toBe(
      "今日のメッセージ数：3件\n今日もお疲れ様でした！おはようございます！",
    );
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(4);
  });

  it("posts only the morning greeting when either message count fails", async () => {
    const requests: Array<{ method: string; url: string; body?: string }> = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        const url = String(input);
        requests.push({
          method,
          url,
          body: typeof init?.body === "string" ? init.body : undefined,
        });

        if (url.endsWith(`/guilds/${liveTestEnv.DISCORD_GUILD_ID}/channels`)) {
          return new Response(
            JSON.stringify([
              {
                id: "night-text-1-id",
                name: "深夜限定テキスト1-08-30",
                type: 0,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-text-2-id",
                name: "深夜限定テキスト2-08-30",
                type: 0,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-voice-1-id",
                name: "深夜限定通話1-08-30",
                type: 2,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
              {
                id: "night-voice-2-id",
                name: "深夜限定通話2-08-30",
                type: 2,
                parent_id: liveTestEnv.DISCORD_PARENT_CATEGORY_ID,
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        if (url.includes("/channels/night-text-1-id/messages?")) {
          return new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 });
        }

        if (url.includes("/channels/1543273845257928747/messages")) {
          return new Response(null, { status: 204 });
        }

        if (method === "DELETE") {
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected request: ${method} ${url}`);
      }),
    );

    await closeNightChannels(liveTestEnv);

    const logPosts = requests.filter(
      (request) =>
        request.method === "POST" &&
        request.url.includes("/channels/1543273845257928747/messages"),
    );
    expect(logPosts).toHaveLength(1);
    expect(JSON.parse(logPosts[0]?.body ?? "{}").content).toBe(
      "今日もお疲れ様でした！おはようございます！",
    );
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(4);
  });
});
