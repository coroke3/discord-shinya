import type {
  DiscordChannel,
  Env,
  PermissionOverwrite,
} from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_RETRIES = 2;

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

export class DiscordRateLimitError extends DiscordApiError {
  constructor(
    status: number,
    method: string,
    path: string,
    public readonly retryAfterMs: number,
  ) {
    super(status, method, path);
    this.name = "DiscordRateLimitError";
  }
}

export async function listGuildChannels(env: Env): Promise<DiscordChannel[]> {
  return discordRequest<DiscordChannel[]>(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    method: "GET",
  });
}

export async function createGuildChannel(
  env: Env,
  payload: {
    name: string;
    type: 0 | 2;
    parent_id: string;
    permission_overwrites?: PermissionOverwrite[];
    user_limit?: number;
  },
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

export async function putChannelPermission(
  env: Env,
  channelId: string,
  overwrite: PermissionOverwrite,
): Promise<void> {
  await discordRequest<void>(
    env,
    `/channels/${channelId}/permissions/${overwrite.id}`,
    {
      method: "PUT",
      body: JSON.stringify({
        allow: overwrite.allow,
        deny: overwrite.deny,
        type: overwrite.type,
      }),
    },
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

export async function addGuildMemberRole(
  env: Env,
  userId: string,
  roleId: string,
): Promise<void> {
  await discordRequest<void>(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
    {
      method: "PUT",
      body: "",
    },
  );
}

export async function removeGuildMemberRole(
  env: Env,
  userId: string,
  roleId: string,
): Promise<void> {
  await discordRequest<void>(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`,
    {
      method: "DELETE",
    },
  );
}

export function initialGatewayUrl(): string {
  return "wss://gateway.discord.gg/?v=10&encoding=json";
}

async function discordRequest<T>(
  env: Env,
  path: string,
  init: RequestInit,
  attempt = 0,
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("User-Agent", "discord-shinya/2.0");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    ...init,
    headers,
  });

  if (response.ok) {
    const body = await response.text();
    return (body ? JSON.parse(body) : undefined) as T;
  }

  if (response.status === 429) {
    throw new DiscordRateLimitError(
      response.status,
      init.method ?? "GET",
      path,
      parseRetryAfterMs(response),
    );
  }

  if (response.status >= 500 && attempt < MAX_RETRIES) {
    await sleep(250 * 2 ** attempt);
    return discordRequest<T>(env, path, init, attempt + 1);
  }

  // Do not include Discord's response body: it is unnecessary for operation
  // and avoids accidentally writing remote data into Worker logs.
  throw new DiscordApiError(response.status, init.method ?? "GET", path);
}

function parseRetryAfterMs(response: Response): number {
  const retryAfter = Number(response.headers.get("Retry-After"));
  if (Number.isFinite(retryAfter) && retryAfter >= 0) {
    return Math.ceil(retryAfter * 1000);
  }

  const resetAfter = Number(response.headers.get("X-RateLimit-Reset-After"));
  if (Number.isFinite(resetAfter) && resetAfter >= 0) {
    return Math.ceil(resetAfter * 1000);
  }

  return 1_000;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
