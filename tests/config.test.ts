import { describe, expect, it } from "vitest";
import {
  buildAnnouncementPayload,
  buildMessageCountLog,
  channelNames,
  getConfigIssues,
  isManagedChannel,
  japanDateKey,
  operationForScheduledTime,
} from "../src/config";

describe("configuration and channel naming", () => {
  it("formats scheduled UTC timestamps as Japanese MM-DD dates", () => {
    expect(japanDateKey(Date.UTC(2026, 7, 28, 15, 0))).toBe("08-29");
    expect(japanDateKey(Date.UTC(2026, 7, 28, 23, 0))).toBe("08-29");
  });

  it("maps the combined free-plan cron trigger to open and close operations", () => {
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 15, 0))).toBe("open");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 23, 0))).toBe("close");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 16, 0))).toBeNull();
  });

  it("builds the requested daily channel names", () => {
    expect(channelNames("08-29")).toEqual({
      text: "深夜限定テキスト-08-29",
      voice: "深夜限定通話-08-29",
    });
  });

  it("only accepts managed names under the configured category", () => {
    expect(
      isManagedChannel(
        { id: "1", type: 0, name: "深夜限定テキスト-08-29", parent_id: "99" },
        "99",
      ),
    ).toBe(true);
    expect(
      isManagedChannel(
        { id: "2", type: 2, name: "深夜限定通話-08-29", parent_id: "99" },
        "99",
      ),
    ).toBe(true);
    expect(
      isManagedChannel(
        { id: "3", type: 0, name: "深夜限定テキスト-08-29", parent_id: "100" },
        "99",
      ),
    ).toBe(false);
    expect(
      isManagedChannel(
        { id: "4", type: 0, name: "深夜限定テキスト-雑談", parent_id: "99" },
        "99",
      ),
    ).toBe(false);
  });

  it("allows @here and only the configured role mention", () => {
    expect(buildAnnouncementPayload("123456789")).toEqual({
      content: "@here <@&123456789> 今日のチャンネルが作成されました！",
      allowed_mentions: {
        parse: ["everyone"],
        roles: ["123456789"],
      },
    });
  });

  it("formats the message count log exactly", () => {
    expect(buildMessageCountLog(12)).toBe(
      "今日のメッセージ数：12件\n今日もお疲れ様でした！おはようございます！",
    );
  });

  it("reports missing runtime configuration without exposing values", () => {
    const issues = getConfigIssues({});
    expect(issues).toEqual([
      "DISCORD_BOT_TOKEN is missing",
      "DISCORD_GUILD_ID is missing",
      "DISCORD_PARENT_CATEGORY_ID is missing",
      "DISCORD_MENTION_ROLE_ID is missing",
    ]);
    expect(issues.join(" ")).not.toContain("secret");
  });
});
