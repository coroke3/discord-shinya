import type {
  DiscordChannel,
  Env,
  PermissionOverwrite,
} from "./config";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_RETRIES = 2;
const DISCORD_REQUEST_TIMEOUT_MS = 15_000;

interface DiscordRequestOptions {
  attempt?: number;
  readResponseBody?: boolean;
}

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
  await discordRequest<void>(
    env,
    `/channels/${channelId}`,
    { method: "DELETE" },
    { readResponseBody: false },
  );
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
    { readResponseBody: false },
  );
}

export async function createTextMessage(
  env: Env,
  channelId: string,
  content: string,
  options: { nonce?: string } = {},
): Promise<void> {
  await discordRequest<void>(
    env,
    `/channels/${channelId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
        ...(options.nonce
          ? { nonce: options.nonce, enforce_nonce: true }
          : {}),
      }),
    },
    { readResponseBody: false },
  );
}

export async function createAnnouncement(
  env: Env,
  channelId: string,
  payload: {
    content: string;
    allowed_mentions: { parse: ["everyone"]; roles: string[] };
    nonce?: string;
  },
): Promise<void> {
  await discordRequest<void>(
    env,
    `/channels/${channelId}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        ...payload,
        ...(payload.nonce ? { enforce_nonce: true } : {}),
      }),
    },
    { readResponseBody: false },
  );
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
    { readResponseBody: false },
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
    { readResponseBody: false },
  );
}

export function initialGatewayUrl(): string {
  return "wss://gateway.discord.gg/?v=10&encoding=json";
}

/**
 * DiscordがREADYで返すRESUME用URLにも、接続時と同じバージョン・形式を
 * 必ず付ける。Bot tokenを送る接続先はGatewayドメインだけに限定し、異常な値は
 * 保存・接続に使わず初期Gatewayへフォールバックする。
 */
export function normalizeGatewayUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const isDiscordGatewayHost =
      /^gateway(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?\.discord\.gg$/.test(url.hostname);
    if (
      url.protocol !== "wss:" ||
      !isDiscordGatewayHost ||
      url.username !== "" ||
      url.password !== "" ||
      (url.port !== "" && url.port !== "443") ||
      url.hash !== ""
    ) {
      return null;
    }
    url.searchParams.set("v", "10");
    url.searchParams.set("encoding", "json");
    return url.toString();
  } catch {
    return null;
  }
}

async function discordRequest<T>(
  env: Env,
  path: string,
  init: RequestInit,
  options: DiscordRequestOptions = {},
): Promise<T> {
  const attempt = options.attempt ?? 0;
  const readResponseBody = options.readResponseBody ?? true;
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${env.DISCORD_BOT_TOKEN}`);
  headers.set("User-Agent", "discord-shinya/2.0");
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCORD_REQUEST_TIMEOUT_MS);
  let response: Response;
  let responseBody: string | undefined;
  try {
    response = await fetch(`${DISCORD_API_BASE}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
    // fetch()はヘッダー受信時に解決する。本文の読み込みもタイムアウト対象に
    // 含め、ヘッダーだけ返って本文が止まった場合に処理が永久待機するのを防ぐ。
    if (response.ok) {
      if (readResponseBody) {
        responseBody = await response.text();
      } else {
        // 投稿・削除・権限変更の成功判定に本文は不要。読むだけの本文待ちで
        // 成功済みのPOSTを失敗扱いにすると、上位の再試行が重複投稿を生む。
        controller.abort();
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  if (response.ok) {
    return (responseBody ? JSON.parse(responseBody) : undefined) as T;
  }

  // エラー本文は操作にもログにも不要。読み捨てずに接続を保持すると、
  // 再試行の多いAlarmでメモリ・接続資源を圧迫するため明示的に解放する。
  controller.abort();
  try {
    await response.body?.cancel();
  } catch {
    // 本文の解放失敗は元のDiscord APIエラーを隠さない。
  }

  if (response.status === 429) {
    throw new DiscordRateLimitError(
      response.status,
      init.method ?? "GET",
      path,
      parseRetryAfterMs(response),
    );
  }

  // POSTはDiscord側で処理済みなのに応答だけ5xxになると、再送で
  // チャンネルやメッセージを二重作成し得る。上位処理が状態を再照合して
  // 再試行するため、ここでは冪等なメソッドだけを自動再送する。
  const method = (init.method ?? "GET").toUpperCase();
  if (response.status >= 500 && isRetryableMethod(method) && attempt < MAX_RETRIES) {
    await sleep(250 * 2 ** attempt);
    return discordRequest<T>(env, path, init, { ...options, attempt: attempt + 1 });
  }

  // Do not include Discord's response body: it is unnecessary for operation
  // and avoids accidentally writing remote data into Worker logs.
  throw new DiscordApiError(response.status, method, path);
}

function isRetryableMethod(method: string): boolean {
  return method === "GET" || method === "PUT" || method === "DELETE";
}

function parseRetryAfterMs(response: Response): number {
  const retryAfterHeader = response.headers.get("Retry-After");
  if (retryAfterHeader !== null && retryAfterHeader.trim() !== "") {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      const retryAfterMs = Math.ceil(retryAfter * 1000);
      return Number.isSafeInteger(retryAfterMs) ? retryAfterMs : 300_000;
    }
  }

  const resetAfterHeader = response.headers.get("X-RateLimit-Reset-After");
  if (resetAfterHeader !== null && resetAfterHeader.trim() !== "") {
    const resetAfter = Number(resetAfterHeader);
    if (Number.isFinite(resetAfter) && resetAfter >= 0) {
      const resetAfterMs = Math.ceil(resetAfter * 1000);
      return Number.isSafeInteger(resetAfterMs) ? resetAfterMs : 300_000;
    }
  }

  return 1_000;
}

async function sleep(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}
