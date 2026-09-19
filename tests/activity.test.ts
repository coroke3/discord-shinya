import { describe, expect, it } from "vitest";
import {
  japanDayStartMs,
  isUnmutedVoiceState,
  splitVoiceInterval,
  weightedBustleSeconds,
} from "../src/activity";

describe("匿名の通話集計", () => {
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
      { index: 0, totalVoiceMs: 1_500, mutedVoiceMs: 500, uniqueUsers: 1 },
      { index: 1, totalVoiceMs: 2_000, mutedVoiceMs: 2_000, uniqueUsers: 1 },
    ])).toBe(4);
  });
});
