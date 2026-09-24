import { describe, expect, it } from "vitest";
import {
  activityBucketIndexAt,
  activityBucketMaskBetween,
  discordSnowflakeTimestampMs,
  japanDayStartMs,
  isUnmutedVoiceState,
  muteRatioPercent,
  splitVoiceInterval,
  weightedBustleSeconds,
} from "../src/activity";

describe("匿名の通話集計", () => {
  it("30分枠の境界を正しく割り当て、00:00-08:00 JSTの外は対象外にする", () => {
    const dateJst = "2026-08-29";
    const dayStart = japanDayStartMs(dateJst);
    const nightEnd = dayStart + 8 * 60 * 60 * 1000;

    expect(activityBucketIndexAt(dateJst, dayStart - 1)).toBeNull();
    expect(activityBucketIndexAt(dateJst, dayStart)).toBe(0);
    expect(activityBucketIndexAt(dateJst, dayStart + 30 * 60 * 1000 - 1)).toBe(0);
    expect(activityBucketIndexAt(dateJst, dayStart + 30 * 60 * 1000)).toBe(1);
    expect(activityBucketIndexAt(dateJst, nightEnd - 1)).toBe(15);
    expect(activityBucketIndexAt(dateJst, nightEnd)).toBeNull();
  });

  it("不正な暦日を正規化せず拒否し、無効なイベント時刻は集計対象外にする", () => {
    expect(() => japanDayStartMs("2026-02-30")).toThrow("Invalid JST date");
    expect(() => japanDayStartMs("2026-2-03")).toThrow("Invalid JST date");
    expect(activityBucketIndexAt("2026-08-29", Number.NaN)).toBeNull();
  });

  it("ミュート判定はself_muteとmuteが両方falseのときだけ発話中にする", () => {
    expect(isUnmutedVoiceState(false, false)).toBe(true);
    expect(isUnmutedVoiceState(true, false)).toBe(false);
    expect(isUnmutedVoiceState(false, true)).toBe(false);
    expect(isUnmutedVoiceState(false, false /* deafは判定対象外 */)).toBe(true);
  });

  it("30分境界で区切り、8時を越える区間を切り捨てる", () => {
    const start = japanDayStartMs("2026-08-29") + 29 * 60_000;
    const segments = splitVoiceInterval("2026-08-29", {
      userId: "user-id-is-not-output",
      startedAt: start,
      endedAt: start + 32 * 60_000,
      muted: false,
    });
    expect(segments.map((segment) => segment.bucketIndex)).toEqual([0, 1, 2]);
    expect(segments.map((segment) => segment.endedAt - segment.startedAt)).toEqual([
      1 * 60_000,
      30 * 60_000,
      1 * 60_000,
    ]);
  });

  it("Gateway gapの重なる枠だけをpartial maskにする", () => {
    const dayStart = japanDayStartMs("2026-08-29");
    expect(activityBucketMaskBetween(
      "2026-08-29",
      dayStart + 1 * 60 * 60 * 1000 + 12 * 60_000,
      dayStart + 1 * 60 * 60 * 1000 + 18 * 60_000,
    )).toBe(1 << 2);
    expect(activityBucketMaskBetween(
      "2026-08-29",
      dayStart + 1 * 60 * 60 * 1000 + 55 * 60_000,
      dayStart + 2 * 60 * 60 * 1000 + 5 * 60_000,
    )).toBe((1 << 3) | (1 << 4));
  });

  it("Discord Snowflakeからmessage作成時刻を復元する", () => {
    const timestamp = japanDayStartMs("2026-08-29") + 15 * 60_000;
    const id = ((BigInt(timestamp) - 1_420_070_400_000n) << 22n).toString();
    expect(discordSnowflakeTimestampMs(id)).toBe(timestamp);
    expect(activityBucketIndexAt("2026-08-29", discordSnowflakeTimestampMs(id) ?? 0)).toBe(0);

    const nightEnd = japanDayStartMs("2026-08-29") + 8 * 60 * 60 * 1000;
    const delayedBeforeCutoff = ((BigInt(nightEnd - 1) - 1_420_070_400_000n) << 22n).toString();
    const afterCutoff = ((BigInt(nightEnd) - 1_420_070_400_000n) << 22n).toString();
    expect(activityBucketIndexAt(
      "2026-08-29",
      discordSnowflakeTimestampMs(delayedBeforeCutoff) ?? 0,
    )).toBe(15);
    expect(activityBucketIndexAt(
      "2026-08-29",
      discordSnowflakeTimestampMs(afterCutoff) ?? 0,
    )).toBeNull();
    expect(discordSnowflakeTimestampMs("not-a-snowflake")).toBeNull();
  });

  it("ミュート1倍、発話中2倍を合算して秒で切り捨てる", () => {
    expect(weightedBustleSeconds([
      {
        index: 0,
        totalVoiceMs: 1_500,
        mutedVoiceMs: 500,
        uniqueUsers: 1,
        mutedUsers: 1,
        messageCount: 0,
      },
      {
        index: 1,
        totalVoiceMs: 2_000,
        mutedVoiceMs: 2_000,
        uniqueUsers: 1,
        mutedUsers: 1,
        messageCount: 0,
      },
    ])).toBe(4);
  });

  it("異常な集計値をログへ伝播させない", () => {
    const bucket = {
      totalVoiceMs: Number.NaN,
      mutedVoiceMs: Number.POSITIVE_INFINITY,
    };
    expect(muteRatioPercent(bucket)).toBe(0);
    expect(weightedBustleSeconds([{
      index: 0,
      ...bucket,
      uniqueUsers: 0,
      mutedUsers: 0,
      messageCount: 0,
    }])).toBe(0);
  });
});
