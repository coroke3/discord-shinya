import { afterEach, describe, expect, it, vi } from "vitest";
import { NightCoordinator } from "../src/coordinator";
import { japanDayStartMs } from "../src/activity";
import { DiscordRateLimitError } from "../src/discord";
import type { Env } from "../src/config";

const env: Env = {
  DISCORD_BOT_TOKEN: "test-token",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_PARENT_CATEGORY_ID: "234567890123456789",
  DISCORD_DEEP_PARENT_CATEGORY_ID: "987654321098765432",
  DISCORD_MENTION_ROLE_ID: "345678901234567890",
  DISCORD_DEEP_ROLE_ID: "456789012345678901",
  DISCORD_ACTIVITY_DETAIL_CHANNEL_ID: "567890123456789012",
};

type Row = Record<string, unknown>;

class MemorySql {
  readonly state = new Map<string, string>();
  readonly messageBuckets = new Map<string, number>();
  readonly dailyUsage = new Set<string>();
  readonly channelDeleteQueue = new Set<string>();
  gatewaySequenceWriteCount = 0;
  managedChannels: Row[] = [{
    channel_id: "text-1",
    name: "深夜限定テキスト1-08-29",
    kind: "normal_text",
    date_jst: "2026-08-29",
  }];
  failNextGatewaySequenceWrite = false;

  exec(query: string, ...bindings: unknown[]): { toArray: () => Row[] } {
    const normalized = query.replace(/\s+/g, " ").trim();

    if (normalized.startsWith("SELECT value FROM service_state")) {
      const value = this.state.get(String(bindings[0]));
      return { toArray: () => value === undefined ? [] : [{ value }] };
    }

    if (normalized.startsWith("INSERT INTO service_state")) {
      const key = String(bindings[0]);
      if (key === "gateway_last_sequence" && this.failNextGatewaySequenceWrite) {
        this.failNextGatewaySequenceWrite = false;
        throw new Error("simulated SQLite failure before sequence commit");
      }
      if (key === "gateway_last_sequence") {
        this.gatewaySequenceWriteCount += 1;
      }
      this.state.set(key, String(bindings[1]));
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT channel_id, name, kind, date_jst FROM managed_channels")) {
      return { toArray: () => [...this.managedChannels] };
    }

    if (normalized.startsWith("SELECT q.channel_id, m.name AS expected_name, m.kind AS expected_kind")) {
      const limit = Number(bindings[0]);
      return {
        toArray: () => [...this.channelDeleteQueue].sort().slice(0, limit).map((channelId) => {
          const managed = this.managedChannels.find((channel) => channel.channel_id === channelId);
          return {
            channel_id: channelId,
            expected_name: managed?.name ?? null,
            expected_kind: managed?.kind ?? null,
          };
        }),
      };
    }

    if (normalized.startsWith("INSERT OR IGNORE INTO channel_delete_queue")) {
      this.channelDeleteQueue.add(String(bindings[0]));
      return { toArray: () => [] };
    }

    if (normalized.startsWith("DELETE FROM channel_delete_queue")) {
      this.channelDeleteQueue.delete(String(bindings[0]));
      return { toArray: () => [] };
    }

    if (normalized.startsWith("SELECT COUNT(*) AS count FROM channel_delete_queue")) {
      return { toArray: () => [{ count: this.channelDeleteQueue.size }] };
    }

    if (normalized.startsWith("INSERT INTO message_buckets")) {
      const key = `${String(bindings[0])}:${String(bindings[1])}`;
      this.messageBuckets.set(key, (this.messageBuckets.get(key) ?? 0) + 1);
      return { toArray: () => [] };
    }

    if (normalized.startsWith("INSERT OR IGNORE INTO daily_usage")) {
      this.dailyUsage.add(`${String(bindings[0])}:${String(bindings[1])}`);
      return { toArray: () => [] };
    }

    return { toArray: () => [] };
  }
}

class MemoryStorage {
  readonly sql = new MemorySql();
  private alarm: number | null = null;

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  transactionSync(callback: () => void): void {
    const state = new Map(this.sql.state);
    const messageBuckets = new Map(this.sql.messageBuckets);
    const dailyUsage = new Set(this.sql.dailyUsage);
    try {
      callback();
    } catch (error) {
      this.sql.state.clear();
      for (const [key, value] of state) this.sql.state.set(key, value);
      this.sql.messageBuckets.clear();
      for (const [key, value] of messageBuckets) this.sql.messageBuckets.set(key, value);
      this.sql.dailyUsage.clear();
      for (const value of dailyUsage) this.sql.dailyUsage.add(value);
      throw error;
    }
  }
}

function createCoordinator(storage: MemoryStorage): NightCoordinator {
  const ctx = {
    storage,
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;
  const coordinator = new NightCoordinator(ctx, env);
  storage.sql.state.set("phase", "ALL_OPEN");
  storage.sql.state.set("date_jst", "2026-08-29");
  storage.sql.state.set("gateway_connected", "1");
  storage.sql.state.set("gateway_last_sequence", "");
  storage.sql.state.set("message_integrity", "complete");
  storage.sql.state.set("usage_integrity", "complete");
  storage.sql.state.set("voice_integrity", "complete");
  return coordinator;
}

function snowflakeFor(timestampMs: number): string {
  return ((BigInt(timestampMs) - 1_420_070_400_000n) << 22n).toString();
}

function attachOpenSocket(coordinator: NightCoordinator) {
  const socket = {
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    send: vi.fn(),
  } as unknown as WebSocket;
  (coordinator as unknown as { gatewaySocket: WebSocket }).gatewaySocket = socket;
  return socket;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("NightCoordinator Gateway復旧", () => {
  it("異常なRetry-Afterで再試行Alarmが無限時刻にならない", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T01:15:00+09:00"));
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const scheduleRetry = (coordinator as unknown as {
      scheduleRetry: (operation: string, error: unknown) => Promise<void>;
    }).scheduleRetry.bind(coordinator);

    await scheduleRetry(
      "open",
      new DiscordRateLimitError(429, "GET", "/test", Number.POSITIVE_INFINITY),
    );

    expect(await storage.getAlarm()).toBe(Date.now() + 300_000);
  });

  it("partial maskが残っている状態をhealthで正常扱いしない", () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    storage.sql.state.set("phase", "CLOSED");
    storage.sql.state.set("role_sync_status", "complete");
    storage.sql.state.set("message_partial_mask", "4");

    const healthPayload = (coordinator as unknown as {
      healthPayload: () => { ok: boolean; partialBuckets: { messageMask: number } };
    }).healthPayload.bind(coordinator)();

    expect(healthPayload.ok).toBe(false);
    expect(healthPayload.partialBuckets.messageMask).toBe(4);
  });

  it("operation APIの不正なbodyとscheduledTimeを拒否する", async () => {
    const nullBodyCoordinator = createCoordinator(new MemoryStorage());
    const nullBodyResponse = await nullBodyCoordinator.fetch(
      new Request("https://discord-shinya.internal/operation", {
        method: "POST",
        body: "null",
      }),
    );
    expect(nullBodyResponse.status).toBe(400);

    const invalidTimeCoordinator = createCoordinator(new MemoryStorage());
    const invalidTimeResponse = await invalidTimeCoordinator.fetch(
      new Request("https://discord-shinya.internal/operation", {
        method: "POST",
        body: JSON.stringify({ operation: "close", scheduledTime: "now" }),
      }),
    );
    expect(invalidTimeResponse.status).toBe(400);

    const outOfRangeTimeCoordinator = createCoordinator(new MemoryStorage());
    const outOfRangeTimeResponse = await outOfRangeTimeCoordinator.fetch(
      new Request("https://discord-shinya.internal/operation", {
        method: "POST",
        body: JSON.stringify({ operation: "close", scheduledTime: Number.MAX_SAFE_INTEGER }),
      }),
    );
    expect(outOfRangeTimeResponse.status).toBe(400);
  });

  it("messageをSnowflakeの枠へ入れ、同じsequenceを二重加算しない", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    attachOpenSocket(coordinator);
    const handleGatewayMessage = (coordinator as unknown as {
      handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
    }).handleGatewayMessage.bind(coordinator);
    const socket = (coordinator as unknown as { gatewaySocket: WebSocket }).gatewaySocket;
    const messageId = snowflakeFor(japanDayStartMs("2026-08-29") + 15 * 60_000);
    const dispatch = (sequence: number) => JSON.stringify({
      op: 0,
      t: "MESSAGE_CREATE",
      s: sequence,
      d: { id: messageId, channel_id: "text-1", author: { id: "user-1" } },
    });

    await handleGatewayMessage(socket, dispatch(10));
    await handleGatewayMessage(socket, dispatch(10));
    await handleGatewayMessage(socket, dispatch(11));

    expect(storage.sql.messageBuckets.get("2026-08-29:0")).toBe(2);
    expect(storage.sql.dailyUsage.has("2026-08-29:user-1")).toBe(true);
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("11");
    expect(storage.sql.gatewaySequenceWriteCount).toBe(2);
  });

  it("集計前にsequence保存を失敗させてもtransaction rollback後に一度だけ回収する", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    attachOpenSocket(coordinator);
    const handleGatewayMessage = (coordinator as unknown as {
      handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
    }).handleGatewayMessage.bind(coordinator);
    const socket = (coordinator as unknown as { gatewaySocket: WebSocket }).gatewaySocket;
    const messageId = snowflakeFor(japanDayStartMs("2026-08-29") + 15 * 60_000);
    const dispatch = JSON.stringify({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 12,
      d: { id: messageId, channel_id: "text-1", author: { id: "user-1" } },
    });

    storage.sql.failNextGatewaySequenceWrite = true;
    await expect(handleGatewayMessage(socket, dispatch)).rejects.toThrow("simulated SQLite failure");
    expect(storage.sql.messageBuckets.get("2026-08-29:0")).toBeUndefined();
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("");

    await handleGatewayMessage(socket, dispatch);
    expect(storage.sql.messageBuckets.get("2026-08-29:0")).toBe(1);
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("12");
  });

  it("08:00の権限ロック中でもcutoff前の遅延messageを回収する", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    attachOpenSocket(coordinator);
    storage.sql.state.set("phase", "CLOSING");
    storage.sql.state.set("close_stage", "lock");
    const handleGatewayMessage = (coordinator as unknown as {
      handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
    }).handleGatewayMessage.bind(coordinator);
    const socket = (coordinator as unknown as { gatewaySocket: WebSocket }).gatewaySocket;
    const cutoff = japanDayStartMs("2026-08-29") + 8 * 60 * 60 * 1000;
    const messageId = snowflakeFor(cutoff - 1_000);

    await handleGatewayMessage(socket, JSON.stringify({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 13,
      d: { id: messageId, channel_id: "text-1", author: { id: "user-1" } },
    }));

    expect(storage.sql.messageBuckets.get("2026-08-29:15")).toBe(1);
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("13");
  });

  it("Gateway終了待ち中もsequenceを維持し、遅延messageだけを一度集計する", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const socket = attachOpenSocket(coordinator);
    storage.sql.state.set("phase", "CLOSING");
    storage.sql.state.set("close_stage", "gateway");
    storage.sql.state.set("gateway_last_sequence", "12");

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    (coordinator as unknown as {
      gatewayClosePromises: WeakMap<WebSocket, Promise<void>>;
    }).gatewayClosePromises.set(socket, closePromise);

    const closeGatewayForNight = (coordinator as unknown as {
      closeGatewayForNight: () => Promise<void>;
    }).closeGatewayForNight.bind(coordinator);
    const enqueueGatewayMessage = (coordinator as unknown as {
      enqueueGatewayMessage: (socket: WebSocket, raw: string) => void;
    }).enqueueGatewayMessage.bind(coordinator);
    const enqueueGatewayClose = (coordinator as unknown as {
      enqueueGatewayClose: (socket: WebSocket, code: number) => void;
    }).enqueueGatewayClose.bind(coordinator);

    const closing = closeGatewayForNight();
    const messageId = snowflakeFor(japanDayStartMs("2026-08-29") + 8 * 60 * 60_000 - 1_000);
    const dispatch = (sequence: number) => JSON.stringify({
      op: 0,
      t: "MESSAGE_CREATE",
      s: sequence,
      d: { id: messageId, channel_id: "text-1", author: { id: "user-1" } },
    });
    enqueueGatewayMessage(socket, dispatch(12)); // 既に処理済みの重複
    enqueueGatewayMessage(socket, dispatch(13)); // 08:00前の遅延分
    enqueueGatewayClose(socket, 1000);
    resolveClose();

    await closing;

    expect(storage.sql.messageBuckets.get("2026-08-29:15")).toBe(1);
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("");
    expect((coordinator as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket).toBeNull();
  });

  it("socketがCLOSEDでもclose callback未処理なら最後のmessageを待つ", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const socket = attachOpenSocket(coordinator);
    (socket as unknown as { readyState: number }).readyState = WebSocket.CLOSED;
    storage.sql.state.set("phase", "CLOSING");
    storage.sql.state.set("close_stage", "gateway");
    storage.sql.state.set("gateway_last_sequence", "12");

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });
    (coordinator as unknown as {
      gatewayClosePromises: WeakMap<WebSocket, Promise<void>>;
    }).gatewayClosePromises.set(socket, closePromise);

    const privateCoordinator = coordinator as unknown as {
      closeGatewayForNight: () => Promise<void>;
      enqueueGatewayMessage: (socket: WebSocket, raw: string) => void;
      enqueueGatewayClose: (socket: WebSocket, code: number) => void;
    };
    let completed = false;
    const closing = privateCoordinator.closeGatewayForNight().then(() => {
      completed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(completed).toBe(false);

    const messageId = snowflakeFor(japanDayStartMs("2026-08-29") + 8 * 60 * 60_000 - 1_000);
    privateCoordinator.enqueueGatewayMessage(socket, JSON.stringify({
      op: 0,
      t: "MESSAGE_CREATE",
      s: 13,
      d: { id: messageId, channel_id: "text-1", author: { id: "user-1" } },
    }));
    privateCoordinator.enqueueGatewayClose(socket, 1000);
    resolveClose();

    await closing;

    expect(storage.sql.messageBuckets.get("2026-08-29:15")).toBe(1);
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("");
    expect((coordinator as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket).toBeNull();
  });

  it("Gateway close確認がtimeoutした場合は集計を欠測扱いにする", async () => {
    vi.useFakeTimers();
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const socket = attachOpenSocket(coordinator);
    storage.sql.state.set("phase", "CLOSING");
    storage.sql.state.set("close_stage", "gateway");
    (coordinator as unknown as {
      gatewayClosePromises: WeakMap<WebSocket, Promise<void>>;
    }).gatewayClosePromises.set(socket, new Promise<void>(() => undefined));

    const closeGatewayForNight = (coordinator as unknown as {
      closeGatewayForNight: () => Promise<void>;
    }).closeGatewayForNight.bind(coordinator);
    const closing = closeGatewayForNight();
    await vi.advanceTimersByTimeAsync(2_000);
    await closing;

    expect(storage.sql.state.get("message_integrity")).toBe("partial");
    expect(storage.sql.state.get("usage_integrity")).toBe("partial");
    expect(storage.sql.state.get("voice_integrity")).toBe("partial");
    expect(storage.sql.state.get("message_partial_mask")).toBe("65535");
    expect(storage.sql.state.get("voice_partial_mask")).toBe("65535");
    expect((coordinator as unknown as { gatewaySocket: WebSocket | null }).gatewaySocket).toBeNull();
    vi.useRealTimers();
  });

  it("チャンネル作成失敗時のロールバック削除を3件に制限して次回へ残す", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const channels = [
      ...[1, 2, 3].map((index) => ({
        id: `normal-text-${index}`,
        name: `深夜限定テキスト${index}-08-29`,
        type: 0,
        kind: "normal_text",
        parent_id: env.DISCORD_PARENT_CATEGORY_ID,
      })),
      ...[1, 2, 3].map((index) => ({
        id: `normal-voice-${index}`,
        name: `深夜限定通話${index}-08-29`,
        type: 2,
        kind: "normal_voice",
        parent_id: env.DISCORD_PARENT_CATEGORY_ID,
      })),
      ...[1, 2].map((index) => ({
        id: `deep-text-${index}`,
        name: `深層-深夜限定テキスト${index}-08-29`,
        type: 0,
        kind: "deep_text",
        parent_id: env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      })),
      ...[1, 2].map((index) => ({
        id: `deep-voice-${index}`,
        name: `深層-深夜限定通話${index}-08-29`,
        type: 2,
        kind: "deep_voice",
        parent_id: env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      })),
    ];
    storage.sql.managedChannels = channels.map((channel) => ({
      channel_id: channel.id,
      name: channel.name,
      kind: channel.kind,
      date_jst: "2026-08-29",
    }));

    const requests: Array<{ method: string; url: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      requests.push({ method, url });
      if (method === "GET" && url.endsWith(`/guilds/${env.DISCORD_GUILD_ID}/channels`)) {
        return new Response(JSON.stringify(channels), { status: 200 });
      }
      if (method === "DELETE" && url.includes("/channels/")) {
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    const rollbackOpeningChannels = (coordinator as unknown as {
      rollbackOpeningChannels: (channelIds: readonly string[]) => Promise<boolean>;
    }).rollbackOpeningChannels.bind(coordinator);
    const complete = await rollbackOpeningChannels(channels.map((channel) => channel.id));

    expect(complete).toBe(false);
    expect(requests.filter((request) => request.method === "DELETE")).toHaveLength(3);
    expect(storage.sql.channelDeleteQueue.size).toBe(7);
  });

  it("古い日付のclose要求で新しい夜を閉じない", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    storage.sql.state.set("phase", "ALL_OPEN");
    storage.sql.state.set("date_jst", "2026-08-30");
    const privateCoordinator = coordinator as unknown as {
      beginClose: (dateJst: string) => Promise<void>;
      continueClosing: () => Promise<void>;
    };
    const continueClosing = vi.spyOn(privateCoordinator, "continueClosing").mockResolvedValue();

    await privateCoordinator.beginClose("2026-08-29");

    expect(storage.sql.state.get("phase")).toBe("ALL_OPEN");
    expect(storage.sql.state.get("date_jst")).toBe("2026-08-30");
    expect(continueClosing).not.toHaveBeenCalled();
  });

  it("Opcode 7では1000では切断せず、session/sequenceを保持してRESUME待ちにする", async () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const socket = attachOpenSocket(coordinator);
    storage.sql.state.set("gateway_session_id", "session-1");
    storage.sql.state.set("gateway_resume_url", "wss://gateway.discord.gg");
    storage.sql.state.set("gateway_last_sequence", "42");

    const handleGatewayMessage = (coordinator as unknown as {
      handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
    }).handleGatewayMessage.bind(coordinator);
    await handleGatewayMessage(socket, JSON.stringify({ op: 7, d: null, s: 43 }));

    expect(socket.close).toHaveBeenCalledWith(4000, "resume reconnect");
    expect(socket.close).not.toHaveBeenCalledWith(1000, expect.anything());
    expect(storage.sql.state.get("gateway_session_id")).toBe("session-1");
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("42");
    expect(storage.sql.state.get("gateway_resume_pending")).toBe("1");
    expect(storage.sql.state.get("message_integrity")).toBe("complete");
    expect(storage.sql.state.get("usage_integrity")).toBe("complete");
  });

  it("Heartbeat timeoutでもsessionを保持して4000でRESUMEする", () => {
    const storage = new MemoryStorage();
    const coordinator = createCoordinator(storage);
    const socket = attachOpenSocket(coordinator);
    storage.sql.state.set("gateway_session_id", "session-1");
    storage.sql.state.set("gateway_last_sequence", "42");
    (coordinator as unknown as { gatewayAwaitingAck: boolean }).gatewayAwaitingAck = true;

    const sendGatewayHeartbeat = (coordinator as unknown as {
      sendGatewayHeartbeat: () => void;
    }).sendGatewayHeartbeat.bind(coordinator);
    sendGatewayHeartbeat();

    expect(socket.close).toHaveBeenCalledWith(4000, "resume reconnect");
    expect(storage.sql.state.get("gateway_session_id")).toBe("session-1");
    expect(storage.sql.state.get("gateway_last_sequence")).toBe("42");
    expect(storage.sql.state.get("gateway_resume_pending")).toBe("1");
    expect(storage.sql.state.get("message_integrity")).toBe("complete");
  });

  it("Invalid Session trueはRESUME情報を保持し、falseだけ新規IDENTIFYへ切り替える", async () => {
    const resumableStorage = new MemoryStorage();
    const resumable = createCoordinator(resumableStorage);
    const resumableSocket = attachOpenSocket(resumable);
    resumableStorage.sql.state.set("gateway_session_id", "session-1");
    resumableStorage.sql.state.set("gateway_last_sequence", "42");
    const handleInvalidSession = (resumable as unknown as {
      handleInvalidSession: (canResume: boolean) => Promise<void>;
    }).handleInvalidSession.bind(resumable);

    await handleInvalidSession(true);
    expect(resumableSocket.close).toHaveBeenCalledWith(4000, "resume reconnect");
    expect(resumableStorage.sql.state.get("gateway_session_id")).toBe("session-1");
    expect(resumableStorage.sql.state.get("gateway_last_sequence")).toBe("42");

    const identifyStorage = new MemoryStorage();
    const identify = createCoordinator(identifyStorage);
    const identifySocket = attachOpenSocket(identify);
    identifyStorage.sql.state.set("gateway_session_id", "session-1");
    identifyStorage.sql.state.set("gateway_last_sequence", "42");
    const identifyInvalidSession = (identify as unknown as {
      handleInvalidSession: (canResume: boolean) => Promise<void>;
    }).handleInvalidSession.bind(identify);

    await identifyInvalidSession(false);
    expect(identifySocket.close).toHaveBeenCalledWith(4000, "resume reconnect");
    expect(identifyStorage.sql.state.get("gateway_session_id")).toBe("");
    expect(identifyStorage.sql.state.get("gateway_last_sequence")).toBe("");
    expect(identifyStorage.sql.state.get("message_integrity")).toBe("complete");
  });

  it("RESUMED成功ではmessage/usageをcompleteのままvoiceだけgap partialにする", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T01:15:00+09:00"));
    try {
      const storage = new MemoryStorage();
      const coordinator = createCoordinator(storage);
      const socket = attachOpenSocket(coordinator);
      storage.sql.state.set("gateway_gap_started_at", String(Date.now() - 60_000));
      storage.sql.state.set("gateway_recovery_pending", "1");
      storage.sql.state.set("voice_replay_mode", "1");

      const handleGatewayMessage = (coordinator as unknown as {
        handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
      }).handleGatewayMessage.bind(coordinator);
      await handleGatewayMessage(socket, JSON.stringify({
        op: 0,
        t: "RESUMED",
        s: 43,
        d: null,
      }));

      expect(storage.sql.state.get("message_integrity")).toBe("complete");
      expect(storage.sql.state.get("usage_integrity")).toBe("complete");
      expect(storage.sql.state.get("voice_integrity")).toBe("partial");
      expect(Number(storage.sql.state.get("voice_partial_mask"))).toBe(1 << 2);
      expect(storage.sql.state.get("gateway_gap_started_at")).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("旧版の全体degradedはRESUMED成功後にmessage/usageを回復する", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T01:15:00+09:00"));
    try {
      const storage = new MemoryStorage();
      storage.sql.state.set("phase", "ALL_OPEN");
      storage.sql.state.set("date_jst", "2026-08-29");
      storage.sql.state.set("metrics_integrity", "degraded");
      // 旧単一flagを全枠へ拡張した後の永続状態を再現する。
      storage.sql.state.set("message_integrity", "partial");
      storage.sql.state.set("usage_integrity", "partial");
      storage.sql.state.set("voice_integrity", "partial");
      storage.sql.state.set("message_partial_mask", "65535");
      storage.sql.state.set("voice_partial_mask", "65535");
      storage.sql.state.set("gateway_connected", "1");
      storage.sql.state.set("gateway_session_id", "legacy-session");
      storage.sql.state.set("gateway_last_sequence", "42");
      const coordinator = new NightCoordinator({
        storage,
        waitUntil: vi.fn(),
      } as unknown as DurableObjectState, env);
      const socket = attachOpenSocket(coordinator);
      storage.sql.state.set("gateway_gap_started_at", String(Date.now() - 60_000));
      storage.sql.state.set("gateway_recovery_pending", "1");
      storage.sql.state.set("gateway_resume_pending", "1");
      storage.sql.state.set("voice_replay_mode", "1");

      const handleGatewayMessage = (coordinator as unknown as {
        handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
      }).handleGatewayMessage.bind(coordinator);
      await handleGatewayMessage(socket, JSON.stringify({
        op: 0,
        t: "RESUMED",
        s: 43,
        d: null,
      }));

      expect(storage.sql.state.get("message_integrity")).toBe("complete");
      expect(storage.sql.state.get("usage_integrity")).toBe("complete");
      expect(storage.sql.state.get("message_partial_mask")).toBe("0");
      expect(storage.sql.state.get("legacy_integrity_recovery_pending")).toBe("0");
      // 旧版ではvoice gapの時刻を保存していないため、全体partialを
      // message replay成功だけで解除しない。
      expect(storage.sql.state.get("voice_integrity")).toBe("partial");
      expect(Number(storage.sql.state.get("voice_partial_mask"))).toBe(0xffff);
    } finally {
      vi.useRealTimers();
    }
  });

  it("RESUME不能なら切断区間と重なるmessage/voice枠だけpartialにする", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T02:05:00+09:00"));
    try {
      const storage = new MemoryStorage();
      const coordinator = createCoordinator(storage);
      const socket = attachOpenSocket(coordinator);
      const dayStart = japanDayStartMs("2026-08-29");
      storage.sql.state.set("gateway_gap_started_at", String(dayStart + 1 * 60 * 60_000 + 55 * 60_000));
      storage.sql.state.set("gateway_recovery_pending", "1");

      const handleGatewayMessage = (coordinator as unknown as {
        handleGatewayMessage: (socket: WebSocket, raw: string) => Promise<void>;
      }).handleGatewayMessage.bind(coordinator);
      await handleGatewayMessage(socket, JSON.stringify({
        op: 0,
        t: "READY",
        s: 44,
        d: {
          session_id: "new-session",
          resume_gateway_url: "wss://gateway.discord.gg",
        },
      }));

      const expectedMask = (1 << 3) | (1 << 4);
      expect(Number(storage.sql.state.get("message_partial_mask"))).toBe(expectedMask);
      expect(Number(storage.sql.state.get("voice_partial_mask"))).toBe(expectedMask);
      expect(storage.sql.state.get("message_integrity")).toBe("partial");
      expect(storage.sql.state.get("usage_integrity")).toBe("partial");
    } finally {
      vi.useRealTimers();
    }
  });
});
