import { describe, expect, it } from "vitest";
import {
  activityBucketIndexAt,
  japanDayStartMs,
  isUnmutedVoiceState,
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
});
