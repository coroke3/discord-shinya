export const OPEN_CRON = "0 15 * * *";
export const CLOSE_CRON = "0 23 * * *";
export const TIME_ZONE = "Asia/Tokyo";

export const TEXT_CHANNEL_PREFIX = "深夜限定テキスト-";
export const VOICE_CHANNEL_PREFIX = "深夜限定通話-";

export interface Env {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_PARENT_CATEGORY_ID: string;
  DISCORD_MENTION_ROLE_ID: string;
  DRY_RUN?: string;
}

export interface DiscordChannel {
  id: string;
  name?: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
}

export interface ChannelNames {
  text: string;
  voice: string;
}

const REQUIRED_CONFIG_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_PARENT_CATEGORY_ID",
  "DISCORD_MENTION_ROLE_ID",
] as const;

export function getConfigIssues(env: Partial<Env>): string[] {
  const issues: string[] = [];

  for (const key of REQUIRED_CONFIG_KEYS) {
    if (!env[key]?.trim()) {
      issues.push(`${key} is missing`);
    }
  }

  for (const key of [
    "DISCORD_GUILD_ID",
    "DISCORD_PARENT_CATEGORY_ID",
    "DISCORD_MENTION_ROLE_ID",
  ] as const) {
    const value = env[key]?.trim();
    if (value && !/^\d+$/.test(value)) {
      issues.push(`${key} must be a Discord snowflake`);
    }
  }

  return issues;
}

export function assertConfig(env: Partial<Env>): asserts env is Env {
  const issues = getConfigIssues(env);
  if (issues.length > 0) {
    throw new Error(`Runtime configuration is invalid: ${issues.join("; ")}`);
  }
}

export function isDryRun(env: Pick<Env, "DRY_RUN">): boolean {
  return env.DRY_RUN?.trim().toLowerCase() === "true";
}

/**
 * Converts a UTC timestamp into the Japanese calendar date without relying
 * on runtime-specific timezone data. Japan Standard Time is UTC+09:00 and
 * does not observe daylight saving time.
 */
export function japanDateKey(timestampMs: number): string {
  const japanTime = new Date(timestampMs + 9 * 60 * 60 * 1000);
  const month = String(japanTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(japanTime.getUTCDate()).padStart(2, "0");
  return `${month}-${day}`;
}

export function channelNames(dateKey: string): ChannelNames {
  return {
    text: `${TEXT_CHANNEL_PREFIX}${dateKey}`,
    voice: `${VOICE_CHANNEL_PREFIX}${dateKey}`,
  };
}

export function isManagedChannel(
  channel: DiscordChannel,
  parentCategoryId: string,
): boolean {
  if (channel.parent_id !== parentCategoryId) {
    return false;
  }

  if (channel.type === 0) {
    return new RegExp(`^${escapeRegExp(TEXT_CHANNEL_PREFIX)}\\d{2}-\\d{2}$`).test(
      channel.name ?? "",
    );
  }

  if (channel.type === 2) {
    return new RegExp(`^${escapeRegExp(VOICE_CHANNEL_PREFIX)}\\d{2}-\\d{2}$`).test(
      channel.name ?? "",
    );
  }

  return false;
}

export function buildAnnouncementPayload(roleId: string): {
  content: string;
  allowed_mentions: {
    parse: ["everyone"];
    roles: string[];
  };
} {
  return {
    content: `@here <@&${roleId}> 今日のチャンネルが作成されました！`,
    allowed_mentions: {
      parse: ["everyone"],
      roles: [roleId],
    },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
