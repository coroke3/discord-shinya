import { describe, expect, it } from "vitest";
import {
  buildAnnouncementPayload,
  buildDetailReport,
  buildMessageCountLog,
  channelDefinitions,
  channelNames,
  getConfigIssues,
  isManagedChannel,
  japanDateKey,
  operationForScheduledTime,
  THREAD_CREATION_BITS,
} from "../src/config";

describe("新しい深夜チャンネル構成", () => {
  it("JSTの日付と3段階のCron操作を計算する", () => {
    expect(japanDateKey(Date.UTC(2026, 7, 28, 15, 0))).toBe("08-29");
    expect(japanDateKey(Date.UTC(2026, 7, 28, 23, 0))).toBe("08-29");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 15, 0))).toBe("open");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 18, 0))).toBe("open_deep");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 23, 0))).toBe("close");
    expect(operationForScheduledTime(Date.UTC(2026, 7, 28, 16, 0))).toBeNull();
  });

  it("通常6つと深層4つの名前を生成する", () => {
    expect(channelNames("08-29")).toEqual({
      text: [
        "深夜限定テキスト1-08-29",
        "深夜限定テキスト2-08-29",
        "深夜限定テキスト3-08-29",
      ],
      voice: [
        "深夜限定通話1-08-29",
        "深夜限定通話2-08-29",
        "深夜限定通話3-08-29",
      ],
      deepText: ["深層-深夜限定テキスト1-08-29", "深層-深夜限定テキスト2-08-29"],
      deepVoice: ["深層-深夜限定通話1-08-29", "深層-深夜限定通話2-08-29"],
    });
  });

  it("チャンネル定義に音声上限と初期権限を含める", () => {
    const definitions = channelDefinitions("08-29", "99", "88", "77");
    expect(definitions).toHaveLength(10);
    expect(definitions.filter((definition) => definition.type === 2).map((definition) => definition.user_limit))
      .toEqual([0, 8, 4, 0, 4]);
    const privateDeep = definitions.find((definition) => definition.kind === "deep_text");
    expect(privateDeep?.permission_overwrites).toContainEqual({
      id: "99",
      type: 0,
      allow: "0",
      deny: String(1024 + THREAD_CREATION_BITS),
    });
  });

  it("厳密な名前と親カテゴリだけを管理対象にする", () => {
    expect(isManagedChannel({ id: "1", type: 0, name: "深層-深夜限定テキスト1-08-29", parent_id: "99" }, "99"))
      .toBe(true);
    expect(isManagedChannel({ id: "2", type: 2, name: "深層-深夜限定通話2-08-29", parent_id: "99" }, "99"))
      .toBe(true);
    expect(isManagedChannel({ id: "3", type: 0, name: "深夜限定テキスト4-08-29", parent_id: "99" }, "99"))
      .toBe(false);
    expect(isManagedChannel({ id: "4", type: 0, name: "深夜限定テキスト1-08-29", parent_id: "100" }, "99"))
      .toBe(false);
    expect(isManagedChannel({ id: "5", type: 0, name: "深夜限定テキスト-08-29", parent_id: "99" }, "99"))
      .toBe(true);
  });

  it("@hereと指定ロールを同時に許可する", () => {
    expect(buildAnnouncementPayload("123456789")).toEqual({
      content: "@here <@&123456789> 今日のチャンネルが作成されました！",
      allowed_mentions: { parse: ["everyone"], roles: ["123456789"] },
    });
  });

  it("終了ログを指定フォーマットで出力する", () => {
    expect(buildMessageCountLog(123, 45, 67890)).toBe(
      "今日のメッセージ数：123件\n今日の来場者数：45人\n賑わい：67890\n今日もお疲れ様でした！おはようございます！",
    );
  });

  it("30分内訳を匿名の集計値だけで出力する", () => {
    const report = buildDetailReport("2026-08-29", [
      { index: 0, totalVoiceMs: 10_000, mutedVoiceMs: 2_500, uniqueUsers: 3 },
    ]);
    expect(report).toContain("【賑わい内訳 08/29】");
    expect(report).toContain("00:00-00:29 | 3人 | 25.0%");
    expect(report).not.toContain("user");
    expect(report.length).toBeLessThan(2000);
  });

  it("新しいSecretが欠けている場合は値をログに出さずに報告する", () => {
    const issues = getConfigIssues({});
    expect(issues).toEqual([
      "DISCORD_BOT_TOKEN is missing",
      "DISCORD_GUILD_ID is missing",
      "DISCORD_PARENT_CATEGORY_ID is missing",
      "DISCORD_MENTION_ROLE_ID is missing",
      "DISCORD_DEEP_ROLE_ID is missing",
      "DISCORD_ACTIVITY_DETAIL_CHANNEL_ID is missing",
    ]);
    expect(issues.join(" ")).not.toContain("secret");
  });
});
