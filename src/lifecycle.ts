import {
  assertConfig,
  buildAnnouncementPayload,
  channelNames,
  type DiscordChannel,
  type Env,
  isDryRun,
  isManagedChannel,
  japanDateKey,
} from "./config";
import {
  createAnnouncement,
  createGuildChannel,
  deleteChannel,
  DiscordApiError,
  listGuildChannels,
} from "./discord";

export async function openNightChannels(
  env: Env,
  scheduledTime: number,
): Promise<void> {
  assertConfig(env);
  const dateKey = japanDateKey(scheduledTime);
  const names = channelNames(dateKey);

  if (isDryRun(env)) {
    console.log(`[dry-run] would open ${names.text} and ${names.voice}`);
    console.log(`[dry-run] would announce in ${names.text}`);
    return;
  }

  const allManaged = await getManagedChannels(env);
  const currentText = allManaged.filter(
    (channel) => channel.type === 0 && channel.name === names.text,
  );
  const currentVoice = allManaged.filter(
    (channel) => channel.type === 2 && channel.name === names.voice,
  );
  const stale = allManaged.filter(
    (channel) => !currentText.includes(channel) && !currentVoice.includes(channel),
  );

  await deleteManagedChannels(env, stale, "opening cleanup");

  if (currentText.length === 1 && currentVoice.length === 1) {
    console.log(`Night channels already exist for ${dateKey}; no duplicate creation.`);
    return;
  }

  // Remove partial or duplicate current-day channels before recreating them.
  await deleteManagedChannels(env, [...currentText, ...currentVoice], "partial cleanup");

  const created: DiscordChannel[] = [];
  try {
    const textChannel = await createGuildChannel(env, {
      name: names.text,
      type: 0,
      parent_id: env.DISCORD_PARENT_CATEGORY_ID,
    });
    created.push(textChannel);

    const voiceChannel = await createGuildChannel(env, {
      name: names.voice,
      type: 2,
      parent_id: env.DISCORD_PARENT_CATEGORY_ID,
    });
    created.push(voiceChannel);

    await createAnnouncement(
      env,
      textChannel.id,
      buildAnnouncementPayload(env.DISCORD_MENTION_ROLE_ID),
    );

    console.log(`Created ${names.text} and ${names.voice}; announcement sent.`);
  } catch (error) {
    await rollbackCreatedChannels(env, created);
    throw error;
  }
}

export async function closeNightChannels(env: Env): Promise<void> {
  assertConfig(env);

  if (isDryRun(env)) {
    console.log("[dry-run] would delete all managed night channels");
    return;
  }

  const managed = await getManagedChannels(env);
  await deleteManagedChannels(env, managed, "closing cleanup");
  console.log(`Deleted ${managed.length} managed night channel(s).`);
}

async function getManagedChannels(env: Env): Promise<DiscordChannel[]> {
  const channels = await listGuildChannels(env);
  return channels.filter((channel) =>
    isManagedChannel(channel, env.DISCORD_PARENT_CATEGORY_ID),
  );
}

async function deleteManagedChannels(
  env: Env,
  channels: DiscordChannel[],
  operation: string,
): Promise<void> {
  const failures: string[] = [];

  for (const channel of channels) {
    try {
      await deleteChannel(env, channel.id);
      console.log(`${operation}: deleted ${channel.name ?? channel.id}`);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        console.log(`${operation}: ${channel.id} was already deleted`);
        continue;
      }

      failures.push(channel.id);
      console.error(`${operation}: failed to delete ${channel.id}`, error);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${operation} failed for ${failures.length} channel(s)`);
  }
}

async function rollbackCreatedChannels(
  env: Env,
  channels: DiscordChannel[],
): Promise<void> {
  for (const channel of [...channels].reverse()) {
    try {
      await deleteChannel(env, channel.id);
      console.log(`Rollback: deleted ${channel.name ?? channel.id}`);
    } catch (error) {
      if (error instanceof DiscordApiError && error.status === 404) {
        continue;
      }
      console.error(`Rollback failed for ${channel.id}`, error);
    }
  }
}
