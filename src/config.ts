export const NIGHT_CRON = "0 15,18,23 * * *";
export const OPEN_UTC_HOUR = 15;
export const DEEP_OPEN_UTC_HOUR = 18;
export const CLOSE_UTC_HOUR = 23;
export const TIME_ZONE = "Asia/Tokyo";
export const MESSAGE_LOG_CHANNEL_ID = "1543273845257928747";
export const EXPECTED_CHANNEL_COUNT = 10;
export const GATEWAY_INTENTS = 641;
export const NIGHT_START_HOUR_JST = 0;
export const DEEP_START_HOUR_JST = 3;
export const NIGHT_END_HOUR_JST = 8;
export const ACTIVITY_BUCKET_MINUTES = 30;
export const ACTIVITY_BUCKET_COUNT =
  ((NIGHT_END_HOUR_JST - NIGHT_START_HOUR_JST) * 60) / ACTIVITY_BUCKET_MINUTES;
// Discord APIのGET/PUT/DELETEは5xx時に最大2回再試行するため、論理操作を
// 10件に抑えても1回のAlarm内のsubrequestが50件を超えないようにする。
// 残りの対象はDurable Object Alarmで次回へ引き継ぐ。
export const MAX_CHANNEL_DELETE_OPERATIONS_PER_ALARM = 10;
export const MAX_ROLE_OPERATIONS_PER_ALARM = 10;

export const TEXT_CHANNEL_PREFIX = "深夜限定テキスト";
export const VOICE_CHANNEL_PREFIX = "深夜限定通話";
export const DEEP_CHANNEL_PREFIX = "深層-";

const LEGACY_TEXT_CHANNEL_PREFIX = "深夜限定テキスト-";
const LEGACY_VOICE_CHANNEL_PREFIX = "深夜限定通話-";

// Durable Objectなどのbinding型はwrangler typesが生成するglobal Envを
// 利用し、設定とコードの型が別々に drift しないようにする。Secretは
// Wranglerの生成対象外なので、アプリ側で必要な型だけを追加する。
type GeneratedEnv = globalThis.Env;

export type Env = Omit<GeneratedEnv, "NIGHT_COORDINATOR"> & {
  DISCORD_BOT_TOKEN: string;
  DISCORD_GUILD_ID: string;
  DISCORD_PARENT_CATEGORY_ID: string;
  DISCORD_DEEP_PARENT_CATEGORY_ID: string;
  DISCORD_MENTION_ROLE_ID: string;
  DISCORD_DEEP_ROLE_ID: string;
  DISCORD_ACTIVITY_DETAIL_CHANNEL_ID: string;
  NIGHT_COORDINATOR?: GeneratedEnv["NIGHT_COORDINATOR"];
  DRY_RUN?: string;
};

export interface PermissionOverwrite {
  id: string;
  type: 0 | 1;
  allow: string;
  deny: string;
}

export interface DiscordChannel {
  id: string;
  name?: string;
  type: number;
  parent_id?: string | null;
  guild_id?: string;
  permission_overwrites?: PermissionOverwrite[];
  user_limit?: number;
}

export interface ChannelNames {
  text: readonly [string, string, string];
  voice: readonly [string, string, string];
  deepText: readonly [string, string];
  deepVoice: readonly [string, string];
}

export type ScheduledOperation = "open" | "open_deep" | "close" | null;
export type ManagedChannelKind =
  | "normal_text"
  | "normal_voice"
  | "deep_text"
  | "deep_voice";

export interface ChannelDefinition {
  name: string;
  type: 0 | 2;
  kind: ManagedChannelKind;
  parent_id: string;
  permission_overwrites: PermissionOverwrite[];
  user_limit?: number;
}

export interface ActivityBucket {
  index: number;
  totalVoiceMs: number;
  mutedVoiceMs: number;
  uniqueUsers: number;
  mutedUsers: number;
  messageCount: number;
}

const REQUIRED_CONFIG_KEYS = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_PARENT_CATEGORY_ID",
  "DISCORD_DEEP_PARENT_CATEGORY_ID",
  "DISCORD_MENTION_ROLE_ID",
  "DISCORD_DEEP_ROLE_ID",
  "DISCORD_ACTIVITY_DETAIL_CHANNEL_ID",
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
    "DISCORD_DEEP_PARENT_CATEGORY_ID",
    "DISCORD_MENTION_ROLE_ID",
    "DISCORD_DEEP_ROLE_ID",
    "DISCORD_ACTIVITY_DETAIL_CHANNEL_ID",
  ] as const) {
    const value = env[key]?.trim();
    if (value && !/^\d+$/.test(value)) {
      issues.push(`${key} must be a Discord snowflake`);
    }
  }

  const normalParentCategoryId = env.DISCORD_PARENT_CATEGORY_ID?.trim();
  const deepParentCategoryId = env.DISCORD_DEEP_PARENT_CATEGORY_ID?.trim();
  if (
    normalParentCategoryId &&
    deepParentCategoryId &&
    normalParentCategoryId === deepParentCategoryId
  ) {
    issues.push("DISCORD_DEEP_PARENT_CATEGORY_ID must differ from DISCORD_PARENT_CATEGORY_ID");
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

/** Returns the JST calendar date in YYYY-MM-DD form. */
export function japanIsoDateKey(timestampMs: number): string {
  const japanTime = new Date(timestampMs + 9 * 60 * 60 * 1000);
  const year = japanTime.getUTCFullYear();
  const month = String(japanTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(japanTime.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Converts a UTC timestamp into the Japanese calendar date used in names. */
export function japanDateKey(timestampMs: number): string {
  return japanIsoDateKey(timestampMs).slice(5);
}

export function operationForScheduledTime(timestampMs: number): ScheduledOperation {
  const utcHour = new Date(timestampMs).getUTCHours();
  if (utcHour === OPEN_UTC_HOUR) {
    return "open";
  }
  if (utcHour === DEEP_OPEN_UTC_HOUR) {
    return "open_deep";
  }
  if (utcHour === CLOSE_UTC_HOUR) {
    return "close";
  }
  return null;
}

export function channelNames(dateKey: string): ChannelNames {
  return {
    text: [
      `${TEXT_CHANNEL_PREFIX}1-${dateKey}`,
      `${TEXT_CHANNEL_PREFIX}2-${dateKey}`,
      `${TEXT_CHANNEL_PREFIX}3-${dateKey}`,
    ],
    voice: [
      `${VOICE_CHANNEL_PREFIX}1-${dateKey}`,
      `${VOICE_CHANNEL_PREFIX}2-${dateKey}`,
      `${VOICE_CHANNEL_PREFIX}3-${dateKey}`,
    ],
    deepText: [
      `${DEEP_CHANNEL_PREFIX}${TEXT_CHANNEL_PREFIX}1-${dateKey}`,
      `${DEEP_CHANNEL_PREFIX}${TEXT_CHANNEL_PREFIX}2-${dateKey}`,
    ],
    deepVoice: [
      `${DEEP_CHANNEL_PREFIX}${VOICE_CHANNEL_PREFIX}1-${dateKey}`,
      `${DEEP_CHANNEL_PREFIX}${VOICE_CHANNEL_PREFIX}2-${dateKey}`,
    ],
  };
}

export function allChannelNames(names: ChannelNames): string[] {
  return [...names.text, ...names.voice, ...names.deepText, ...names.deepVoice];
}

export function channelDefinitions(
  dateKey: string,
  guildId: string,
  deepRoleId: string,
  parentCategoryId = "",
  deepParentCategoryId = parentCategoryId,
  botUserId?: string,
): ChannelDefinition[] {
  const names = channelNames(dateKey);
  const definitions: ChannelDefinition[] = [];

  names.text.forEach((name) => {
    definitions.push({
      name,
      type: 0,
      kind: "normal_text",
      parent_id: parentCategoryId,
      permission_overwrites: normalOverwrites(guildId, deepRoleId, botUserId),
    });
  });
  names.voice.forEach((name, index) => {
    definitions.push({
      name,
      type: 2,
      kind: "normal_voice",
      parent_id: parentCategoryId,
      permission_overwrites: normalOverwrites(guildId, deepRoleId, botUserId),
      user_limit: [0, 8, 4][index],
    });
  });
  names.deepText.forEach((name) => {
    definitions.push({
      name,
      type: 0,
      kind: "deep_text",
      parent_id: deepParentCategoryId,
      permission_overwrites: deepOverwrites(guildId, deepRoleId, botUserId),
    });
  });
  names.deepVoice.forEach((name, index) => {
    definitions.push({
      name,
      type: 2,
      kind: "deep_voice",
      parent_id: deepParentCategoryId,
      permission_overwrites: deepOverwrites(guildId, deepRoleId, botUserId),
      user_limit: [0, 4][index],
    });
  });

  return definitions;
}

export function buildDeepPublicOverwrite(guildId: string): PermissionOverwrite {
  return {
    id: guildId,
    type: 0,
    allow: String(VIEW_CHANNEL_BIT),
    deny: String(THREAD_CREATION_BITS),
  };
}

export function buildPrivateOverwrite(guildId: string): PermissionOverwrite {
  return {
    id: guildId,
    type: 0,
    allow: "0",
    deny: String(VIEW_CHANNEL_BIT + THREAD_CREATION_BITS),
  };
}

export function buildRolePrivateOverwrite(roleId: string): PermissionOverwrite {
  return {
    id: roleId,
    type: 0,
    allow: "0",
    deny: String(VIEW_CHANNEL_BIT + THREAD_CREATION_BITS),
  };
}

export function buildMorningGreeting(): string {
  return "今日もお疲れ様でした！おはようございます！";
}

export function buildMessageCountLog(
  messageCount: number,
  visitorCount = 0,
  bustleSeconds = 0,
): string {
  return [
    `今日のメッセージ数：${messageCount}件`,
    `今日の来場者数：${visitorCount}人`,
    `賑わい：${bustleSeconds}`,
    buildMorningGreeting(),
  ].join("\n");
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

export function buildDetailReport(
  dateJst: string,
  buckets: readonly ActivityBucket[],
  messageCountAvailable = true,
): string {
  const label = dateJst.length >= 7
    ? `${dateJst.slice(5, 7)}/${dateJst.slice(8, 10)}`
    : dateJst.replace("-", "/");
  const lines = [`【賑わい内訳 ${label}】`, "", "時間帯 | 滞在人数 | ミュート率 | メッセージ数"];

  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const bucket = buckets.find((candidate) => candidate.index === index);
    const uniqueUsers = Math.max(0, Math.floor(bucket?.uniqueUsers ?? 0));
    const mutedUsers = Math.min(
      uniqueUsers,
      Math.max(0, Math.floor(bucket?.mutedUsers ?? 0)),
    );
    const messageCount = Math.max(0, Math.floor(bucket?.messageCount ?? 0));
    const messageLabel = messageCountAvailable ? `${messageCount}件` : "取得不可";
    const startMinutes = index * ACTIVITY_BUCKET_MINUTES;
    const endMinutes = startMinutes + ACTIVITY_BUCKET_MINUTES - 1;
    lines.push(
      `${formatClock(startMinutes)}-${formatClock(endMinutes)} | ${uniqueUsers}人 | ${mutedUsers}/${uniqueUsers} | ${messageLabel}`,
    );
  }

  lines.push("", "【滞在人数グラフ】");
  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const bucket = buckets.find((candidate) => candidate.index === index);
    const uniqueUsers = Math.max(0, Math.floor(bucket?.uniqueUsers ?? 0));
    const mutedUsers = Math.min(
      uniqueUsers,
      Math.max(0, Math.floor(bucket?.mutedUsers ?? 0)),
    );
    const startMinutes = index * ACTIVITY_BUCKET_MINUTES;
    const endMinutes = startMinutes + ACTIVITY_BUCKET_MINUTES - 1;
    lines.push(
      `${formatClock(startMinutes)}-${formatClock(endMinutes)} | ${personGraph(uniqueUsers, mutedUsers)}`,
    );
  }

  lines.push("", "【メッセージ数グラフ】");
  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const bucket = buckets.find((candidate) => candidate.index === index);
    const messageCount = Math.max(0, Math.floor(bucket?.messageCount ?? 0));
    const startMinutes = index * ACTIVITY_BUCKET_MINUTES;
    const endMinutes = startMinutes + ACTIVITY_BUCKET_MINUTES - 1;
    lines.push(
      `${formatClock(startMinutes)}-${formatClock(endMinutes)} | ${messageGraph(messageCount, messageCountAvailable)}`,
    );
  }

  lines.push(
    "",
    "※滞在人数グラフは■=ミュートなしの1人、□=枠内にミュート状態があった1人です。",
    "※メッセージ数グラフは20件につき■1つです。長すぎる場合は末尾を…で省略します。",
  );

  const report = lines.join("\n");
  if (report.length > 2000) {
    throw new Error("Activity detail report exceeds Discord's 2000-character limit");
  }
  return report;
}

const MAX_GRAPH_SYMBOLS_PER_ROW = 20;

function personGraph(uniqueUsers: number, mutedUsers: number): string {
  if (uniqueUsers === 0) {
    return "（なし）";
  }

  const unmutedUsers = Math.max(0, uniqueUsers - mutedUsers);
  const visibleUnmuted = Math.min(unmutedUsers, MAX_GRAPH_SYMBOLS_PER_ROW);
  const remaining = MAX_GRAPH_SYMBOLS_PER_ROW - visibleUnmuted;
  const visibleMuted = Math.min(mutedUsers, remaining);
  const graph = "■".repeat(visibleUnmuted) + "□".repeat(visibleMuted);
  return uniqueUsers > graph.length ? `${graph}…` : graph;
}

function messageGraph(messageCount: number, messageCountAvailable: boolean): string {
  if (!messageCountAvailable) {
    return "取得不可";
  }
  if (messageCount === 0) {
    return "（なし）";
  }

  const units = Math.ceil(messageCount / 20);
  const visibleUnits = Math.min(units, MAX_GRAPH_SYMBOLS_PER_ROW);
  const graph = "■".repeat(visibleUnits);
  return units > visibleUnits ? `${graph}…` : graph;
}

export function classifyManagedChannel(
  channel: DiscordChannel,
  parentCategoryId: string,
  deepParentCategoryId = parentCategoryId,
): ManagedChannelKind | null {
  const name = channel.name ?? "";
  if (channel.type === 0) {
    if (new RegExp(`^${escapeRegExp(TEXT_CHANNEL_PREFIX)}[123]-\\d{2}-\\d{2}$`).test(name)) {
      return channel.parent_id === parentCategoryId ? "normal_text" : null;
    }
    if (new RegExp(`^${escapeRegExp(DEEP_CHANNEL_PREFIX + TEXT_CHANNEL_PREFIX)}[12]-\\d{2}-\\d{2}$`).test(name)) {
      // 深層カテゴリ分離前に通常カテゴリへ作られた旧チャンネルは、
      // 初回の移行掃除だけが安全に回収できるよう残存管理対象とする。
      return channel.parent_id === deepParentCategoryId || channel.parent_id === parentCategoryId
        ? "deep_text"
        : null;
    }
    if (new RegExp(`^${escapeRegExp(LEGACY_TEXT_CHANNEL_PREFIX)}\\d{2}-\\d{2}$`).test(name)) {
      return channel.parent_id === parentCategoryId ? "normal_text" : null;
    }
    return null;
  }

  if (channel.type === 2) {
    if (new RegExp(`^${escapeRegExp(VOICE_CHANNEL_PREFIX)}[123]-\\d{2}-\\d{2}$`).test(name)) {
      return channel.parent_id === parentCategoryId ? "normal_voice" : null;
    }
    if (new RegExp(`^${escapeRegExp(DEEP_CHANNEL_PREFIX + VOICE_CHANNEL_PREFIX)}[12]-\\d{2}-\\d{2}$`).test(name)) {
      return channel.parent_id === deepParentCategoryId || channel.parent_id === parentCategoryId
        ? "deep_voice"
        : null;
    }
    if (new RegExp(`^${escapeRegExp(LEGACY_VOICE_CHANNEL_PREFIX)}\\d{2}-\\d{2}$`).test(name)) {
      return channel.parent_id === parentCategoryId ? "normal_voice" : null;
    }
  }

  return null;
}

export function isManagedChannel(
  channel: DiscordChannel,
  parentCategoryId: string,
  deepParentCategoryId = parentCategoryId,
): boolean {
  return classifyManagedChannel(channel, parentCategoryId, deepParentCategoryId) !== null;
}

export function isManagedTextChannel(
  channel: DiscordChannel,
  parentCategoryId: string,
  deepParentCategoryId = parentCategoryId,
): boolean {
  const kind = classifyManagedChannel(channel, parentCategoryId, deepParentCategoryId);
  return kind === "normal_text" || kind === "deep_text";
}

export function isManagedVoiceChannel(
  channel: DiscordChannel,
  parentCategoryId: string,
  deepParentCategoryId = parentCategoryId,
): boolean {
  const kind = classifyManagedChannel(channel, parentCategoryId, deepParentCategoryId);
  return kind === "normal_voice" || kind === "deep_voice";
}

export function voiceUserLimit(kind: ManagedChannelKind, index: number): number | undefined {
  if (kind === "normal_voice") {
    return [0, 8, 4][index];
  }
  if (kind === "deep_voice") {
    return [0, 4][index];
  }
  return undefined;
}

export const VIEW_CHANNEL_BIT = 1 << 10;
export const SEND_MESSAGES_BIT = 1 << 11;
export const CONNECT_BIT = 1 << 20;
export const SPEAK_BIT = 1 << 21;
export const CREATE_PUBLIC_THREADS_BIT = 2 ** 35;
export const CREATE_PRIVATE_THREADS_BIT = 2 ** 36;
export const THREAD_CREATION_BITS = CREATE_PUBLIC_THREADS_BIT + CREATE_PRIVATE_THREADS_BIT;

function normalOverwrites(
  guildId: string,
  deepRoleId: string,
  botUserId?: string,
): PermissionOverwrite[] {
  const overwrites: PermissionOverwrite[] = [
    {
      id: guildId,
      type: 0,
      allow: String(VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT | CONNECT_BIT | SPEAK_BIT),
      deny: String(THREAD_CREATION_BITS),
    },
    {
      id: deepRoleId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL_BIT + THREAD_CREATION_BITS),
    },
  ];
  if (botUserId) {
    overwrites.push({
      id: botUserId,
      type: 1,
      allow: String(VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT | CONNECT_BIT | SPEAK_BIT),
      deny: String(THREAD_CREATION_BITS),
    });
  }
  return overwrites;
}

function deepOverwrites(
  guildId: string,
  deepRoleId: string,
  botUserId?: string,
): PermissionOverwrite[] {
  const overwrites: PermissionOverwrite[] = [
    {
      id: guildId,
      type: 0,
      allow: "0",
      deny: String(VIEW_CHANNEL_BIT + THREAD_CREATION_BITS),
    },
    {
      id: deepRoleId,
      type: 0,
      allow: String(VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT | CONNECT_BIT | SPEAK_BIT),
      deny: String(THREAD_CREATION_BITS),
    },
  ];
  if (botUserId) {
    overwrites.push({
      id: botUserId,
      type: 1,
      allow: String(VIEW_CHANNEL_BIT | SEND_MESSAGES_BIT | CONNECT_BIT | SPEAK_BIT),
      deny: String(THREAD_CREATION_BITS),
    });
  }
  return overwrites;
}

function formatClock(totalMinutes: number): string {
  const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
  const minutes = String(totalMinutes % 60).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
