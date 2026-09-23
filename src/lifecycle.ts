import {
  assertConfig,
  buildAnnouncementPayload,
  buildNormalPublicOverwrite,
  channelDefinitions,
  classifyManagedChannel,
  isDryRun,
  japanDateKey,
  MESSAGE_LOG_CHANNEL_ID,
  type DiscordChannel,
  type Env,
} from "./config";
import {
  createAnnouncement,
  createGuildChannel,
  createTextMessage,
  deleteChannel,
  DiscordApiError,
  listGuildChannels,
  putChannelPermission,
} from "./discord";

/**
 * Compatibility helpers for local/manual checks. Scheduled production work
 * runs through NightCoordinator; these helpers intentionally do not read
 * Discord message history.
 */
export async function openNightChannels(env: Env, scheduledTime: number): Promise<void> {
  assertConfig(env);
  const dateKey = japanDateKey(scheduledTime);
  const definitions = channelDefinitions(
    dateKey,
    env.DISCORD_GUILD_ID,
    env.DISCORD_DEEP_ROLE_ID,
    env.DISCORD_PARENT_CATEGORY_ID,
    env.DISCORD_DEEP_PARENT_CATEGORY_ID,
  );

  if (isDryRun(env)) {
    console.log(`[dry-run] would open ${definitions.length} night channels`);
    return;
  }

  const existing = await getManagedChannels(env);
  await deleteManagedChannels(env, existing, "opening cleanup");
  const created: DiscordChannel[] = [];
  try {
    for (const definition of definitions) {
      const { kind: _kind, ...payload } = definition;
      const channel = await createGuildChannel(env, payload);
      created.push(channel);
    }
    const firstTextDefinition = definitions.find((definition) => definition.kind === "normal_text");
    const firstDeepTextDefinition = definitions.find((definition) => definition.kind === "deep_text");
    const firstText = created.find((channel) => channel.name === firstTextDefinition?.name);
    const firstDeepText = created.find((channel) => channel.name === firstDeepTextDefinition?.name);
    if (!firstText || !firstDeepText) {
      throw new Error("Required text channels were not created for the announcement");
    }
    await createAnnouncement(
      env,
      firstText.id,
      buildAnnouncementPayload(env.DISCORD_MENTION_ROLE_ID),
    );
    await createAnnouncement(
      env,
      firstDeepText.id,
      buildAnnouncementPayload(env.DISCORD_MENTION_ROLE_ID),
    );
    for (const definition of definitions.filter(
      (candidate) => candidate.kind === "normal_text" || candidate.kind === "normal_voice",
    )) {
      const channel = created.find((candidate) => candidate.name === definition.name);
      if (!channel) {
        throw new Error(`Normal channel was not created: ${definition.name}`);
      }
      await putChannelPermission(
        env,
        channel.id,
        buildNormalPublicOverwrite(env.DISCORD_GUILD_ID),
      );
    }
  } catch (error) {
    await rollbackCreatedChannels(env, created);
    throw error;
  }
}

export async function closeNightChannels(env: Env): Promise<void> {
  assertConfig(env);
  if (isDryRun(env)) {
    console.log("[dry-run] would close all managed night channels");
    return;
  }

  const managed = await getManagedChannels(env);
  // The production path obtains these values from Gateway/DO state. This
  // manual compatibility path still posts the required four-line format but
  // never falls back to a history API.
  try {
    await createTextMessage(
      env,
      MESSAGE_LOG_CHANNEL_ID,
      "今日のメッセージ数：0件\n今日の来場者数：0人\n賑わい：0\n今日もお疲れ様でした！おはようございます！",
    );
  } catch (error) {
    console.error(`Manual summary logging failed: ${describeError(error)}`);
  }
  await deleteManagedChannels(env, managed, "closing cleanup");
}

export async function getManagedChannels(env: Env): Promise<DiscordChannel[]> {
  const channels = await listGuildChannels(env);
  return channels.filter((channel) =>
    classifyManagedChannel(
      channel,
      env.DISCORD_PARENT_CATEGORY_ID,
      env.DISCORD_DEEP_PARENT_CATEGORY_ID,
    ) !== null,
  );
}

export async function deleteManagedChannels(
  env: Env,
  channels: readonly DiscordChannel[],
  operation: string,
): Promise<void> {
  const failures: string[] = [];
  for (const channel of channels) {
    try {
      await deleteChannel(env, channel.id);
      console.log(`${operation}: deleted ${channel.name ?? "managed channel"}`);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        continue;
      }
      failures.push(channel.id);
      console.error(`${operation}: failed to delete managed channel`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`${operation} failed for ${failures.length} channel(s)`);
  }
}

export function hasExpectedChannels(
  channels: readonly DiscordChannel[],
  expectedNames: readonly string[],
): boolean {
  return (
    channels.length === expectedNames.length &&
    expectedNames.every((name) => channels.some((channel) => channel.name === name))
  );
}

async function rollbackCreatedChannels(env: Env, channels: readonly DiscordChannel[]): Promise<void> {
  for (const channel of [...channels].reverse()) {
    try {
      await deleteChannel(env, channel.id);
    } catch (error) {
      if (!(error instanceof DiscordApiError && error.status === 404)) {
        console.error("Rollback failed for a managed channel");
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof DiscordApiError ? `Discord ${error.status}` : "unexpected error";
}
