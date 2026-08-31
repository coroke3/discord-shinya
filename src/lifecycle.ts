import {
  assertConfig,
  buildAnnouncementPayload,
  buildMorningGreeting,
  buildMessageCountLog,
  channelNames,
  MESSAGE_LOG_CHANNEL_ID,
  type DiscordChannel,
  type Env,
  isDryRun,
  isManagedChannel,
  japanDateKey,
} from "./config";
import {
  createAnnouncement,
  createGuildChannel,
  createTextMessage,
  countChannelMessages,
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
    console.log(`[dry-run] would open ${names.text.join(", ")} and ${names.voice.join(", ")}`);
    console.log(`[dry-run] would announce in ${names.text[0]}`);
    return;
  }

  const allManaged = await getManagedChannels(env);
  const currentText = allManaged.filter(
    (channel) => channel.type === 0 && names.text.includes(channel.name ?? ""),
  );
  const currentVoice = allManaged.filter(
    (channel) => channel.type === 2 && names.voice.includes(channel.name ?? ""),
  );
  const stale = allManaged.filter(
    (channel) => !currentText.includes(channel) && !currentVoice.includes(channel),
  );

  await deleteManagedChannels(env, stale, "opening cleanup");

  if (
    hasExpectedChannels(currentText, names.text) &&
    hasExpectedChannels(currentVoice, names.voice)
  ) {
    console.log(`Night channels already exist for ${dateKey}; no duplicate creation.`);
    return;
  }

  // Remove partial or duplicate current-day channels before recreating them.
  await deleteManagedChannels(env, [...currentText, ...currentVoice], "partial cleanup");

  const created: DiscordChannel[] = [];
  try {
    const textChannels: DiscordChannel[] = [];
    for (const name of names.text) {
      const channel = await createGuildChannel(env, {
        name,
        type: 0,
        parent_id: env.DISCORD_PARENT_CATEGORY_ID,
      });
      created.push(channel);
      textChannels.push(channel);
    }

    for (const name of names.voice) {
      const channel = await createGuildChannel(env, {
        name,
        type: 2,
        parent_id: env.DISCORD_PARENT_CATEGORY_ID,
      });
      created.push(channel);
    }

    const announcementChannel = textChannels[0];
    if (!announcementChannel) {
      throw new Error("No text channel was created for the announcement");
    }

    await createAnnouncement(
      env,
      announcementChannel.id,
      buildAnnouncementPayload(env.DISCORD_MENTION_ROLE_ID),
    );

    console.log(
      `Created ${[...names.text, ...names.voice].join(", ")}; announcement sent in ${names.text[0]}.`,
    );
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

  // Try to record the text-channel total before deleting any managed channel.
  // Counting/logging is best-effort: deletion must still proceed if either
  // operation fails.
  const textChannels = managed.filter((candidate) => candidate.type === 0);
  if (textChannels.length > 0) {
    let totalMessageCount = 0;
    let messageCountFailed = false;

    for (const channel of textChannels) {
      try {
        totalMessageCount += await countChannelMessages(env, channel.id);
      } catch (error) {
        messageCountFailed = true;
        console.error(
          `Message count retrieval failed for ${channel.name ?? channel.id}; posting greeting only: ${describeError(error)}`,
        );
        break;
      }
    }

    if (messageCountFailed) {
      try {
        await createTextMessage(env, MESSAGE_LOG_CHANNEL_ID, buildMorningGreeting());
        console.log(`Logged greeting only for ${textChannels.length} text channel(s).`);
      } catch (greetingError) {
        console.error(
          `Greeting logging failed; continuing with deletion: ${describeError(greetingError)}`,
        );
      }
    } else {
      try {
        await createTextMessage(
          env,
          MESSAGE_LOG_CHANNEL_ID,
          buildMessageCountLog(totalMessageCount),
        );
        console.log(
          `Logged ${totalMessageCount} message(s) across ${textChannels.length} text channel(s).`,
        );
      } catch (error) {
        console.error(
          `Message count log posting failed for ${textChannels.length} text channel(s); continuing with deletion: ${describeError(error)}`,
        );
      }
    }
  }

  await deleteManagedChannels(env, managed, "closing cleanup");
  console.log(`Deleted ${managed.length} managed night channel(s).`);
}

async function getManagedChannels(env: Env): Promise<DiscordChannel[]> {
  const channels = await listGuildChannels(env);
  return channels.filter((channel) =>
    isManagedChannel(channel, env.DISCORD_PARENT_CATEGORY_ID),
  );
}

function hasExpectedChannels(
  channels: DiscordChannel[],
  expectedNames: readonly string[],
): boolean {
  return (
    channels.length === expectedNames.length &&
    expectedNames.every((name) => channels.some((channel) => channel.name === name))
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
