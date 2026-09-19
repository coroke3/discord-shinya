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
  const [year, month, day] = dateJst.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) {
    throw new Error(`Invalid JST date: ${dateJst}`);
  }
  return Date.UTC(year, month - 1, day) - JST_OFFSET_MS;
}

export function japanNightEndMs(dateJst: string): number {
  return japanDayStartMs(dateJst) + NIGHT_END_HOUR_JST * 60 * MINUTE_MS;
}

/**
 * Returns the 30-minute bucket for a received event, or null outside the
 * 00:00-08:00 JST window.
 */
export function activityBucketIndexAt(dateJst: string, timestampMs: number): number | null {
  const offset = timestampMs - japanDayStartMs(dateJst);
  const bucketIndex = Math.floor(offset / HALF_HOUR_MS);
  if (bucketIndex < 0 || bucketIndex >= ACTIVITY_BUCKET_COUNT) {
    return null;
  }
  return bucketIndex;
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
    const unmutedMs = Math.max(0, bucket.totalVoiceMs - bucket.mutedVoiceMs);
    weightedMs += bucket.mutedVoiceMs + unmutedMs * 2;
  }
  return Math.floor(weightedMs / 1000);
}

export function muteRatioPercent(bucket: Pick<ActivityBucket, "totalVoiceMs" | "mutedVoiceMs">): number {
  if (bucket.totalVoiceMs <= 0) {
    return 0;
  }
  return (bucket.mutedVoiceMs / bucket.totalVoiceMs) * 100;
}
