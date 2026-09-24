import {
  ACTIVITY_BUCKET_COUNT,
  ACTIVITY_BUCKET_MINUTES,
  NIGHT_END_HOUR_JST,
  type ActivityBucket,
} from "./config";

const MINUTE_MS = 60_000;
const HALF_HOUR_MS = ACTIVITY_BUCKET_MINUTES * MINUTE_MS;
const JST_OFFSET_MS = 9 * 60 * MINUTE_MS;

export interface VoiceInterval {
  userId: string;
  startedAt: number;
  endedAt: number;
  muted: boolean;
}

export interface ActivitySegment {
  bucketIndex: number;
  startedAt: number;
  endedAt: number;
  muted: boolean;
}

export function japanDayStartMs(dateJst: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateJst);
  if (!match) {
    throw new Error(`Invalid JST date: ${dateJst}`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utcDate = new Date(0);
  utcDate.setUTCHours(0, 0, 0, 0);
  utcDate.setUTCFullYear(year, month - 1, day);
  if (
    utcDate.getUTCFullYear() !== year ||
    utcDate.getUTCMonth() !== month - 1 ||
    utcDate.getUTCDate() !== day
  ) {
    throw new Error(`Invalid JST date: ${dateJst}`);
  }

  return utcDate.getTime() - JST_OFFSET_MS;
}

export function japanNightEndMs(dateJst: string): number {
  return japanDayStartMs(dateJst) + NIGHT_END_HOUR_JST * 60 * MINUTE_MS;
}

/**
 * Returns the 30-minute bucket for a received event, or null outside the
 * 00:00-08:00 JST window.
 */
export function activityBucketIndexAt(dateJst: string, timestampMs: number): number | null {
  if (!Number.isFinite(timestampMs)) {
    return null;
  }
  const offset = timestampMs - japanDayStartMs(dateJst);
  const bucketIndex = Math.floor(offset / HALF_HOUR_MS);
  if (bucketIndex < 0 || bucketIndex >= ACTIVITY_BUCKET_COUNT) {
    return null;
  }
  return bucketIndex;
}

/**
 * Returns the bit mask of 30-minute buckets overlapped by a time interval.
 * The end timestamp is exclusive, matching the interval arithmetic used by
 * voice aggregation. This is used only for anonymous integrity metadata.
 */
export function activityBucketMaskBetween(
  dateJst: string,
  startedAt: number,
  endedAt: number,
): number {
  const dayStart = japanDayStartMs(dateJst);
  const nightEnd = japanNightEndMs(dateJst);
  const start = Math.max(dayStart, startedAt);
  const end = Math.min(nightEnd, endedAt);
  if (end <= start) {
    return 0;
  }

  let mask = 0;
  for (let index = 0; index < ACTIVITY_BUCKET_COUNT; index += 1) {
    const bucketStart = dayStart + index * HALF_HOUR_MS;
    const bucketEnd = bucketStart + HALF_HOUR_MS;
    if (start < bucketEnd && end > bucketStart) {
      mask |= 1 << index;
    }
  }
  return mask;
}

/** Returns the Discord Snowflake creation timestamp without retaining the ID. */
export function discordSnowflakeTimestampMs(messageId: string): number | null {
  if (!/^\d+$/.test(messageId)) {
    return null;
  }
  try {
    const timestamp = Number((BigInt(messageId) >> 22n) + 1_420_070_400_000n);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
  } catch {
    return null;
  }
}

export function isUnmutedVoiceState(selfMute: unknown, mute: unknown): boolean {
  return selfMute === false && mute === false;
}

/**
 * Splits a received-time voice interval at every 30-minute boundary. Discord
 * does not provide an authoritative event timestamp, so callers pass the
 * event receipt time and the resulting approximation remains explicit.
 */
export function splitVoiceInterval(
  dateJst: string,
  interval: VoiceInterval,
): ActivitySegment[] {
  const dayStart = japanDayStartMs(dateJst);
  const nightEnd = japanNightEndMs(dateJst);
  const start = Math.max(interval.startedAt, dayStart);
  const end = Math.min(interval.endedAt, nightEnd);
  if (end <= start) {
    return [];
  }

  const segments: ActivitySegment[] = [];
  let cursor = start;
  while (cursor < end) {
    const bucketIndex = Math.floor((cursor - dayStart) / HALF_HOUR_MS);
    if (bucketIndex < 0 || bucketIndex >= ACTIVITY_BUCKET_COUNT) {
      break;
    }
    const bucketEnd = dayStart + (bucketIndex + 1) * HALF_HOUR_MS;
    const segmentEnd = Math.min(bucketEnd, end);
    segments.push({
      bucketIndex,
      startedAt: cursor,
      endedAt: segmentEnd,
      muted: interval.muted,
    });
    cursor = segmentEnd;
  }
  return segments;
}

export function weightedBustleSeconds(buckets: readonly ActivityBucket[]): number {
  let weightedMs = 0;
  for (const bucket of buckets) {
    const totalVoiceMs = nonNegativeFinite(bucket.totalVoiceMs);
    const mutedVoiceMs = Math.min(totalVoiceMs, nonNegativeFinite(bucket.mutedVoiceMs));
    const unmutedMs = totalVoiceMs - mutedVoiceMs;
    weightedMs += mutedVoiceMs + unmutedMs * 2;
  }
  return Math.floor(weightedMs / 1000);
}

export function muteRatioPercent(bucket: Pick<ActivityBucket, "totalVoiceMs" | "mutedVoiceMs">): number {
  const totalVoiceMs = nonNegativeFinite(bucket.totalVoiceMs);
  if (totalVoiceMs <= 0) {
    return 0;
  }
  const mutedVoiceMs = Math.min(totalVoiceMs, nonNegativeFinite(bucket.mutedVoiceMs));
  return (mutedVoiceMs / totalVoiceMs) * 100;
}

function nonNegativeFinite(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
