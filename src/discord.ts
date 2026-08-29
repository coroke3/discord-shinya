import type { DiscordChannel, DiscordMessage, Env } from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_RETRIES = 2;
const MESSAGE_PAGE_SIZE = 100;
const MAX_MESSAGE_COUNT_PAGES = 45;

export class DiscordApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly path: string,
  ) {
    super(`Discord API request failed: ${method} ${path} (${status})`);
    this.name = "DiscordApiError";
  }
}

export async function listGuildChannels(env: Env): Promise<DiscordChannel[]> {
  return discordRequest<DiscordChannel[]>(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    method: "GET",
  });
}

export async function createGuildChannel(
  env: Env,
  payload: { name: string; type: 0 | 2; parent_id: string },
): Promise<DiscordChannel> {
  return discordRequest<DiscordChannel>(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/channels`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );
}

export async function deleteChannel(env: Env, channelId: string): Promise<void> {
  await discordRequest<DiscordChannel>(env, `/channels/${channelId}`, {
    method: "DELETE",
  });
}

export async function listChannelMessages(
  env: Env,
  channelId: string,
  before?: string,
): Promise<DiscordMessage[]> {
  const query = new URLSearchParams({ limit: String(MESSAGE_PAGE_SIZE) });
  if (before) {
    query.set("before", before);
  }

  return discordRequest<DiscordMessage[]>(
    env,
    `/channels/${channelId}/messages?${query.toString()}`,
    { method: "GET" },
  );
}

export async function countChannelMessages(
  env: Env,
  channelId: string,
): Promise<number> {
  let before: string | undefined;
  let count = 0;

  for (let page = 0; page < MAX_MESSAGE_COUNT_PAGES; page += 1) {
    const messages = await listChannelMessages(env, channelId, before);
    count += messages.length;

    if (messages.length < MESSAGE_PAGE_SIZE) {
      return count;
    }

    const oldestMessageId = messages[messages.length - 1]?.id;
    if (!oldestMessageId) {
      throw new Error(`Discord returned a full message page without an ID for ${channelId}`);
    }
    before = oldestMessageId;
  }

  throw new Error(
    `Message count exceeded the safe pagination limit for channel ${channelId}`,
  );
}

export async function createTextMessage(
  env: Env,
  channelId: string,
  content: string,
): Promise<void> {
  await discordRequest(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content,
      allowed_mentions: { parse: [] },
    }),
  });
}

export async function createAnnouncement(
  env: Env,
  channelId: string,
  payload: { content: string; allowed_mentions: { parse: ["everyone"]; roles: string[] } },
): Promise<void> {
  await discordRequest(env, `/channels/${channelId}/messages`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function discordRequest<T>(
  env: Env,
  path: string,
  init: RequestInit,
  attempt = 0,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("Content-Type", "application/json");
  headers.set("User-Agent", "discord-shinya/1.0");

  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (response.ok) {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  if ((response.status === 429 || response.status >= 500) && attempt < MAX_RETRIES) {
    await waitBeforeRetry(response, attempt);
    return discordRequest<T>(env, path, init, attempt + 1);
  }

  // Do not include Discord's response body: it is unnecessary for operation
  // and avoids accidentally writing remote data into Worker logs.
  throw new DiscordApiError(response.status, init.method ?? "GET", path);
}

async function waitBeforeRetry(response: Response, attempt: number): Promise<void> {
  const retryAfterSeconds = Number(response.headers.get("Retry-After"));
  const delayMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(retryAfterSeconds * 1000, 30_000)
    : 500 * 2 ** attempt;

  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
