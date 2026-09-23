import { describe, expect, it } from "vitest";
import handler from "../src/index";
import type { Env } from "../src/config";

const baseEnv: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_DEEP_PARENT_CATEGORY_ID: "987654321098765432",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
  DISCORD_DEEP_ROLE_ID: "456789012345678901",
  DISCORD_ACTIVITY_DETAIL_CHANNEL_ID: "567890123456789012",
};

async function fetchHealth(payload: unknown): Promise<Response> {
  const coordinator = {
    fetch: async () => Response.json(payload),
  };
  const env = {
    ...baseEnv,
    NIGHT_COORDINATOR: {
      getByName: () => coordinator,
    },
  } as unknown as Env;
  const fetchHandler = handler.fetch;
  if (!fetchHandler) {
    throw new Error("Worker fetch handler is missing");
  }
  return fetchHandler(
    new Request("https://discord-shinya.example/health"),
    env,
    {} as ExecutionContext,
  );
}

describe("ヘルスチェック", () => {
  it("内部状態がok:falseなら503を返す", async () => {
    const response = await fetchHealth({ ok: false, phase: "CLOSING" });
    expect(response.status).toBe(503);
  });

  it("内部状態がok:trueなら200を返す", async () => {
    const response = await fetchHealth({ ok: true, phase: "CLOSED" });
    expect(response.status).toBe(200);
  });

  it("Coordinatorのintegrityとpartial maskをそのまま公開する", async () => {
    const response = await fetchHealth({
      ok: false,
      phase: "ALL_OPEN",
      gateway: { connected: true, reconnecting: true, resumePending: true },
      integrity: { message: "complete", usage: "complete", voice: "partial" },
      partialBuckets: { messageMask: 0, voiceMask: 8 },
    });
    expect(await response.json()).toMatchObject({
      integrity: { voice: "partial" },
      partialBuckets: { voiceMask: 8 },
    });
  });
});
