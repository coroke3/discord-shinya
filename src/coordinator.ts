import {
  ACTIVITY_BUCKET_COUNT,
  EXPECTED_CHANNEL_COUNT,
  GATEWAY_INTENTS,
  MAX_CHANNEL_DELETE_OPERATIONS_PER_ALARM,
  MAX_ROLE_OPERATIONS_PER_ALARM,
  MESSAGE_LOG_CHANNEL_ID,
  assertConfig,
  buildAnnouncementPayload,
  buildDeepPublicOverwrite,
  buildDeepRolePublicOverwrite,
  buildDetailReport,
  buildMessageCountLog,
  buildNormalPublicOverwrite,
  buildPrivateOverwrite,
  buildRolePrivateOverwrite,
  channelDefinitions,
  classifyManagedChannel,
  isDryRun,
  japanIsoDateKey,
  type ActivityBucket,
  type ChannelDefinition,
  type Env,
  type ManagedChannelKind,
} from "./config";
import {
  addGuildMemberRole,
  createAnnouncement,
  createGuildChannel,
  createTextMessage,
  deleteChannel,
  DiscordApiError,
  DiscordRateLimitError,
  initialGatewayUrl,
  listGuildChannels,
  normalizeGatewayUrl,
  putChannelPermission,
  removeGuildMemberRole,
} from "./discord";
import {
  activityBucketIndexAt,
  activityBucketMaskBetween,
  discordSnowflakeTimestampMs,
  japanNightEndMs,
  isUnmutedVoiceState,
  splitVoiceInterval,
  weightedBustleSeconds,
  type VoiceInterval,
} from "./activity";

type Phase =
  | "CLOSED"
  | "OPENING"
  | "SEPARATED"
  | "ALL_OPEN"
  | "CLOSING"
  | "REPORTING"
  | "ROLE_SYNC"
  | "BLOCKED";

type CloseStage =
  | "flush"
  | "lock"
  | "drain"
  | "gateway"
  | "delete"
  | "reports"
  | "role_queue"
  | "role_sync"
  | "done";

interface StoredChannel {
  channel_id: string;
  name: string;
  kind: ManagedChannelKind;
  date_jst: string;
}

interface ActiveVoiceSession {
  user_id: string;
  date_jst: string;
  channel_id: string;
  segment_started_at: number;
  muted: number;
}

interface RoleQueueItem {
  user_id: string;
  action: "add" | "remove";
}

interface ChannelDeleteQueueItem {
  channel_id: string;
  expected_name: string | null;
  expected_kind: ManagedChannelKind | null;
}

interface GatewayEnvelope {
  op?: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

interface GatewayHello {
  heartbeat_interval?: number;
}

interface GatewayReady {
  session_id?: string;
  resume_gateway_url?: string;
  user?: { id?: string };
}

interface GatewayGuildCreate {
  id?: string;
  voice_states?: GatewayVoiceState[];
}

interface GatewayMessageCreate {
  id?: string;
  channel_id?: string;
  author?: { id?: string; bot?: boolean; system?: boolean };
}

interface GatewayVoiceState {
  guild_id?: string;
  user_id?: string;
  channel_id?: string | null;
  self_mute?: boolean;
  mute?: boolean;
  member?: { user?: { id?: string; bot?: boolean; system?: boolean } };
}

interface VoiceReplayState {
  user_id: string;
  date_jst: string;
  channel_id: string | null;
  muted: number;
}

const INITIAL_PHASE: Phase = "CLOSED";
const ACTIVE_PHASES = new Set<Phase>(["OPENING", "SEPARATED", "ALL_OPEN"]);
const TRACKING_PHASES = new Set<Phase>(["OPENING", "SEPARATED", "ALL_OPEN"]);
const GATEWAY_NIGHT_CLOSE_CODE = 1000;
const GATEWAY_RESUME_CLOSE_CODE = 4000;
const GATEWAY_WATCHDOG_MS = 30_000;
const GATEWAY_RECONNECT_INITIAL_DELAY_MS = 500;
const GATEWAY_DRAIN_GRACE_MS = 30_000;
const GATEWAY_NIGHT_CLOSE_WAIT_MS = 2_000;
const MAX_ALARM_TIMESTAMP_MS = 8_640_000_000_000_000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1_000;
// OPENINGは最大33回（channel list・作成・通知・権限公開）の外部subrequestを
// 使うため、失敗時のロールバックは3件に絞り、再試行込みでも50件未満にする。
const MAX_OPENING_ROLLBACK_OPERATIONS_PER_ALARM = 3;
const FULL_ACTIVITY_BUCKET_MASK = (1 << ACTIVITY_BUCKET_COUNT) - 1;
const NON_RESUMABLE_GATEWAY_CODES = new Set([
  4003,
  4004,
  4005,
  4006,
  4007,
  4009,
  4010,
  4011,
  4012,
  4013,
  4014,
]);

// 08:00の終了処理が完全に成功したら削除する日次・接続中だけの状態。
// 次回の運用判定に必要なphase、ロール同期完了状態、現在の深層ロール集合は残す。
const DAILY_EPHEMERAL_STATE_KEYS = [
  "alarm_due",
  "date_jst",
  "pending_operation",
  "open_after_cleanup",
  "next_open_date",
  "deferred_open_deep_date",
  "message_count",
  "message_count_available",
  "visitor_count",
  "report_sent",
  "detail_report_sent",
  "report_retry_at",
  "detail_report_retry_at",
  "announcement_sent",
  "deep_announcement_sent",
  "role_queue_initialized",
  "close_stage",
  "opening_stage",
  "opening_cleanup_done",
  "gateway_session_id",
  "gateway_resume_url",
  "gateway_last_sequence",
  "gateway_connect_started_at",
  "gateway_resume_pending",
  "gateway_connected",
  "gateway_bot_user_id",
  "gateway_heartbeat_ack_at",
  "gateway_heartbeat_sent_at",
  "gateway_watchdog_due",
  "message_integrity",
  "usage_integrity",
  "voice_integrity",
  "message_partial_mask",
  "voice_partial_mask",
  "legacy_integrity_recovery_pending",
  "gateway_state",
  "gateway_gap_started_at",
  "gateway_recovery_pending",
  "gateway_reconnect_attempts",
  "gateway_last_dispatch_at",
  "voice_replay_mode",
  "voice_replay_snapshot_required",
  "gateway_drain_until",
  "normal_channels_public",
] as const;

/**
 * One coordinator exists per guild. All durable state that can affect a
 * future operation is kept in SQLite; the in-memory fields only hold the
 * currently open outbound Gateway socket, heartbeat timer, and same-instance
 * I/O guards.
 */
export class NightCoordinator {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private gatewaySocket: WebSocket | null = null;
  private gatewayHeartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly gatewayClosePromises = new WeakMap<WebSocket, Promise<void>>();
  private gatewayHeartbeatIntervalMs = 0;
  private gatewayAwaitingAck = false;
  private gatewayIdentifyOnly = false;
  // Durable Objectの外部I/Oは入力イベントをまたいで並行実行されるため、
  // 同じインスタンス内で重複しやすい処理だけを明示的に直列化する。
  // インスタンスが再生成された場合はSQLiteの段階状態から再開する。
  private openingFinishInProgress = false;
  private openingInProgress = false;
  private deepOpenInProgress = false;
  private closingInProgress = false;
  private reportsInProgress = false;
  private alarmScheduleChain: Promise<void> = Promise.resolve();
  private gatewayEventChain: Promise<void> = Promise.resolve();
  private schemaInitialized = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    // 初回のfetchとalarmが同時に来ても、SQLiteのDDL・初期stateが
    // 先に完了してから処理を開始する。古いテスト用mockなどでAPIが
    // 無い場合だけ、同期的なフォールバックを使う。
    if (typeof this.ctx.blockConcurrencyWhile === "function") {
      const initialization = this.ctx.blockConcurrencyWhile(async () => {
        this.ensureSchema();
      });
      initialization.catch(() => {
        console.error("Durable Object schema initialization failed");
      });
    } else {
      this.ensureSchema();
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    this.recoverGatewayIfNeeded();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(this.healthPayload());
    }

    if (request.method === "POST" && url.pathname === "/operation") {
      let rawBody: unknown;
      try {
        rawBody = await request.json();
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
      }

      if (rawBody === null || typeof rawBody !== "object" || Array.isArray(rawBody)) {
        return Response.json({ ok: false, error: "Invalid operation body" }, { status: 400 });
      }

      const body = rawBody as { operation?: unknown; scheduledTime?: unknown };
      const operation = body.operation;
      if (operation !== "open" && operation !== "open_deep" && operation !== "close") {
        return Response.json({ ok: false, error: "Invalid operation" }, { status: 400 });
      }

      const scheduledTime = body.scheduledTime;
      if (
        scheduledTime !== undefined &&
        (typeof scheduledTime !== "number" ||
          !Number.isSafeInteger(scheduledTime) ||
          scheduledTime < 0 ||
          !Number.isFinite(new Date(scheduledTime + JST_OFFSET_MS).getTime()))
      ) {
        return Response.json({ ok: false, error: "Invalid scheduledTime" }, { status: 400 });
      }

      // Cron側へ202をすぐ返しつつ、Durable Objectの実行コンテキストが
      // 外部I/O完了前に終了しないようwaitUntilへ登録する。
      const operationPromise = this.runOperation(
        operation,
        scheduledTime ?? Date.now(),
      ).catch((error) => {
        this.logOperationError(operation, error);
      });
      this.ctx.waitUntil(operationPromise);
      return Response.json({ ok: true, accepted: true }, { status: 202 });
    }

    return new Response("Not Found", { status: 404 });
  }

  async alarm(): Promise<void> {
    this.ensureSchema();
    this.recoverGatewayIfNeeded();
    this.setState("alarm_due", "");

    try {
      const phase = this.getPhase();
      const dateJst = this.getState("date_jst");
      if (
        dateJst &&
        Date.now() >= japanNightEndMs(dateJst) &&
        phase !== "CLOSED" &&
        phase !== "BLOCKED"
      ) {
        // 08:00を越えた復旧Alarmは、公開処理を再開せず終了処理へ渡す。
        // 00:00の失敗が長引いて朝にチャンネルを作る事故を防ぐ。
        if (phase === "CLOSING" || phase === "REPORTING" || phase === "ROLE_SYNC") {
          await this.continueClosing();
        } else {
          await this.beginClose(dateJst);
        }
        return;
      }
      if (phase === "OPENING") {
        if (this.getState("opening_cleanup_done") !== "1") {
          const dateJst = this.getState("date_jst");
          if (dateJst) {
            await this.beginOpen(dateJst);
          }
        } else if (!this.isGatewayConnected()) {
          this.connectGateway();
          await this.scheduleGatewayWatchdog();
        } else {
          await this.finishOpen();
        }
      } else if (
        ACTIVE_PHASES.has(phase) &&
        this.getState("pending_operation") === "open_deep"
      ) {
        const dateJst = this.getState("date_jst");
        if (dateJst) {
          await this.beginOpenDeep(dateJst);
        }
      } else if (phase === "CLOSING" || phase === "REPORTING" || phase === "ROLE_SYNC") {
        await this.continueClosing();
      } else if (ACTIVE_PHASES.has(phase)) {
        if (!this.isGatewayConnected()) {
          this.connectGateway();
        }
        await this.scheduleGatewayWatchdog();
      }
    } catch (error) {
      this.logOperationError("alarm", error);
      await this.scheduleRetry("alarm", error);
    }
  }

  private async runOperation(
    operation: "open" | "open_deep" | "close",
    scheduledTime: number,
  ): Promise<void> {
    try {
      if (
        !Number.isSafeInteger(scheduledTime) ||
        scheduledTime < 0 ||
        !Number.isFinite(new Date(scheduledTime + JST_OFFSET_MS).getTime())
      ) {
        throw new Error("Invalid scheduledTime");
      }
      assertConfig(this.env);

      if (isDryRun(this.env)) {
        console.log(`[dry-run] accepted ${operation} at ${japanIsoDateKey(scheduledTime)} JST`);
        return;
      }

      const dateJst = japanIsoDateKey(scheduledTime);
      if (
        (operation === "open" || operation === "open_deep") &&
        Date.now() >= japanNightEndMs(dateJst)
      ) {
        // Cronや一時障害からの再試行が08:00を越えた場合、作成ではなく
        // 当日分の終了処理だけを行う。CLOSEDなら保留Alarmも消費する。
        await this.beginClose(dateJst);
        return;
      }

      if (operation === "open") {
        await this.beginOpen(dateJst);
      } else if (operation === "open_deep") {
        await this.beginOpenDeep(dateJst);
      } else {
        await this.beginClose(japanIsoDateKey(scheduledTime));
      }
    } catch (error) {
      this.logOperationError(operation, error);
      await this.scheduleRetry(operation, error);
    }
  }

  private async beginOpen(dateJst: string): Promise<void> {
    if (this.openingInProgress) {
      // 既存の実行がチャンネル掃除・作成を進めている間は、二重作成や
      // 後続処理によるmanaged_channelsの消去を避け、Alarmで再確認する。
      await this.scheduleAlarmAt(Date.now() + 5_000);
      return;
    }
    this.openingInProgress = true;
    try {
      await this.beginOpenInternal(dateJst);
    } finally {
      this.openingInProgress = false;
    }
  }

  private async beginOpenInternal(dateJst: string): Promise<void> {
    // 前夜の深層公開APIがまだ進行中なら、新しい日付の掃除と権限変更を
    // 同時に走らせない。外部I/O中は別イベントが割り込めるための保護。
    if (
      this.deepOpenInProgress &&
      this.getState("date_jst") !== dateJst &&
      this.getState("deferred_open_deep_date") !== dateJst
    ) {
      await this.scheduleAlarmAt(Date.now() + 5_000);
      return;
    }
    const phase = this.getPhase();
    const currentDate = this.getState("date_jst");

    // 前日の終了処理がまだ段階途中なら、ロール同期・レポートがたまたま
    // 完了済みでも、新しい日付のOPENINGへ先に進めない。削除処理と作成処理
    // の並行実行は、管理対象の取り違えにつながる。
    if (phase === "CLOSING" || phase === "REPORTING" || phase === "ROLE_SYNC") {
      if (currentDate !== dateJst) {
        this.setState("open_after_cleanup", "1");
        this.setState("next_open_date", dateJst);
      }
      await this.continueClosing();
      return;
    }

    if ((phase === "SEPARATED" || phase === "ALL_OPEN") && currentDate === dateJst) {
      if (!this.isGatewayConnected()) {
        this.connectGateway();
      }
      return;
    }

    const retryingCurrentOpening = phase === "OPENING" && currentDate === dateJst;
    const previousDayNeedsRoleSync = !retryingCurrentOpening && !this.previousRoleSyncIsComplete();
    const previousDayNeedsReports =
      !retryingCurrentOpening && currentDate !== null && !this.reportsAreComplete();

    if (previousDayNeedsRoleSync || previousDayNeedsReports) {
      this.setState("open_after_cleanup", "1");
      this.setState("next_open_date", dateJst);

      if (previousDayNeedsRoleSync) {
        this.setState("phase", "ROLE_SYNC");
        this.setState("close_stage", "role_sync");
        console.error("Opening blocked because the previous role sync is incomplete");
        await this.continueClosing();
      } else if (currentDate) {
        this.setState("phase", "REPORTING");
        this.setState("close_stage", "done");
        await this.sendReports(currentDate);
        await this.finalizeCloseIfReady(currentDate);
      }
      return;
    }

    // 00:00処理の再試行では、既に受信したメッセージ件数や作成済み
    // チャンネルを初期化しない。Alarmや重複Cronが同時期に走っても、
    // 未完了の段階から再開する。
    if (retryingCurrentOpening) {
      // 外部API処理の途中で実行コンテキストが終了しても、OPENINGを
      // 再開できるよう先に監視用Alarmを確保する。
      await this.scheduleGatewayWatchdog();
      if (this.getState("opening_cleanup_done") !== "1") {
        const channels = await listGuildChannels(this.env);
        const stale = channels.filter((channel) =>
          classifyManagedChannel(
            channel,
            this.env.DISCORD_PARENT_CATEGORY_ID,
            this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
          ) !== null,
        );
        if (!await this.deleteChannels(stale.map((channel) => channel.id))) {
          return;
        }
        this.clearManagedChannels();
        this.setState("opening_cleanup_done", "1");
      }

      if (!this.isGatewayConnected()) {
        this.connectGateway();
      }
      if (this.isGatewayConnected()) {
        // 古いチャンネルの削除と新規チャンネル作成を同じInvocationに
        // 詰め込まず、次のAlarmへ分けてFreeのsubrequest上限を守る。
        await this.scheduleAlarmAt(Date.now() + 1_000);
      } else {
        await this.scheduleGatewayWatchdog();
      }
      return;
    }

    this.setState("phase", "OPENING");
    this.setState("date_jst", dateJst);
    const deferredDeepOpen = this.getState("deferred_open_deep_date") === dateJst;
    this.setState("pending_operation", deferredDeepOpen ? "open_deep" : "open");
    this.setState("open_after_cleanup", "0");
    this.setState("next_open_date", "");
    this.setState("metrics_integrity", "complete");
    this.setState("message_integrity", "complete");
    this.setState("usage_integrity", "complete");
    this.setState("voice_integrity", "complete");
    this.setState("message_partial_mask", "0");
    this.setState("voice_partial_mask", "0");
    this.setState("legacy_integrity_recovery_pending", "0");
    this.setState("gateway_state", "connecting");
    this.setState("gateway_gap_started_at", "");
    this.setState("gateway_recovery_pending", "0");
    this.setState("gateway_reconnect_attempts", "0");
    this.setState("gateway_last_dispatch_at", "");
    this.setState("gateway_heartbeat_ack_at", "");
    this.setState("gateway_heartbeat_sent_at", "");
    this.setState("voice_replay_mode", "0");
    this.setState("voice_replay_snapshot_required", "0");
    this.setState("gateway_drain_until", "");
    this.setState("normal_channels_public", "0");
    if (!retryingCurrentOpening) {
      this.clearVoiceReplayStates();
    }
    if (!retryingCurrentOpening) {
      // A new night starts a fresh Gateway session. Resume is for a
      // disconnect during the same night, not for yesterday's closed session.
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_connected", "0");
      this.setState("gateway_session_id", "");
      this.setState("gateway_resume_url", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    }
    this.setState("announcement_sent", "0");
    this.setState("deep_announcement_sent", "0");
    this.setState("report_sent", "0");
    this.setState("detail_report_sent", "0");
    this.setState("role_queue_initialized", "0");
    this.setState("role_sync_status", "pending");
    this.setState("role_sync_complete", "0");
    this.setState("close_stage", "flush");
    this.setState("opening_cleanup_done", "0");
    // 一覧取得・古いチャンネル削除が長引いてもOPENINGを再試行できるよう、
    // 破壊的な外部API処理より先に監視用Alarmを登録する。
    await this.scheduleGatewayWatchdog();

    // Only exact managed names in the configured category are eligible for
    // cleanup. Unrelated channels are never touched.
    const channels = await listGuildChannels(this.env);
    const stale = channels.filter((channel) =>
      classifyManagedChannel(
        channel,
        this.env.DISCORD_PARENT_CATEGORY_ID,
        this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      ) !== null,
    );
    if (!await this.deleteChannels(stale.map((channel) => channel.id))) {
      return;
    }
    this.clearManagedChannels();
    this.setState("opening_cleanup_done", "1");

    this.connectGateway();
    if (this.isGatewayConnected()) {
      // cleanupとfinishOpenを別Invocationに分離する。
      await this.scheduleAlarmAt(Date.now() + 1_000);
    } else {
      await this.scheduleGatewayWatchdog();
    }
  }

  private async finishOpen(): Promise<void> {
    if (this.openingFinishInProgress) {
      // 外部REST処理中にWatchdog Alarmが先に消費されても、処理が
      // 長時間止まった場合の復旧Alarmを失わないようにする。
      await this.scheduleGatewayWatchdog();
      return;
    }
    this.openingFinishInProgress = true;
    try {
      await this.finishOpenInternal();
    } finally {
      this.openingFinishInProgress = false;
    }
  }

  private async finishOpenInternal(): Promise<void> {
    if (this.getPhase() !== "OPENING") {
      return;
    }
    // READYが古いチャンネル掃除より先に届くことがある。掃除完了前に
    // 新しいチャンネルを作ると、旧チャンネルと新チャンネルが混在する。
    if (this.getState("opening_cleanup_done") !== "1") {
      return;
    }

    // チャンネル作成が複数回の外部API呼び出しになるため、作成処理の前に
    // 監視用Alarmを確保する。既存Alarmが早ければそちらを維持する。
    await this.scheduleGatewayWatchdog();

    const dateJst = this.getState("date_jst");
    if (!dateJst) {
      throw new Error("Opening has no JST date");
    }
    if (Date.now() >= japanNightEndMs(dateJst)) {
      // READYが08:00をまたいで届いた場合、公開処理を開始せず、次の
      // Alarmで通常の終了処理へ引き継ぐ。深夜帯外に公開するraceを防ぐ。
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    const definitions = channelDefinitions(
      dateJst.slice(5),
      this.env.DISCORD_GUILD_ID,
      this.env.DISCORD_DEEP_ROLE_ID,
      this.env.DISCORD_PARENT_CATEGORY_ID,
      this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      this.getState("gateway_bot_user_id") ?? undefined,
    );
    const created: string[] = [];

    try {
      const current = await listGuildChannels(this.env);
      const currentByName = new Map(
        current
          .filter((channel) =>
            channel.parent_id === this.env.DISCORD_PARENT_CATEGORY_ID ||
            channel.parent_id === this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
          )
          .map((channel) => [
            `${channel.parent_id}:${channel.type}:${channel.name ?? ""}`,
            channel,
          ] as const),
      );
      const registeredByName = new Map(
        this.registeredChannels().map((channel) => [`${channel.kind}:${channel.name}`, channel] as const),
      );

      for (const definition of definitions) {
        if (Date.now() >= japanNightEndMs(dateJst)) {
          // REST呼び出しの途中で08:00をまたいだ場合は、残りの作成・
          // 通知・公開を開始せず、CLOSINGの再走査・削除へ引き継ぐ。
          await this.scheduleAlarmAt(Date.now() + 1_000);
          return;
        }
        const existing = registeredByName.get(`${definition.kind}:${definition.name}`);
        const existingRemote = currentByName.get(
          `${definition.parent_id}:${definition.type}:${definition.name}`,
        );

        // 前回の途中失敗でDBだけが残ると、削除済み・移動済みのチャンネルを
        // 既存扱いしてしまう。リモートIDが一致する場合だけ再利用し、それ
        // 以外は登録を捨てて、現在のDiscord状態から再登録・再作成する。
        if (existing && existingRemote?.id === existing.channel_id) {
          this.registerManagedChannel(existingRemote.id, definition.name, definition.kind, dateJst);
          continue;
        }
        if (existing) {
          this.ctx.storage.sql.exec(
            "DELETE FROM managed_channels WHERE channel_id = ?",
            existing.channel_id,
          );
        }
        if (existingRemote) {
          this.registerManagedChannel(existingRemote.id, definition.name, definition.kind, dateJst);
          continue;
        }
        const { kind: _kind, ...payload } = definition;
        const channel = await createGuildChannel(this.env, payload);
        created.push(channel.id);
        this.registerManagedChannel(channel.id, definition.name, definition.kind, dateJst);
      }

      // 10チャンネルの作成とDB登録が完了するまで、通常チャンネルも
      // @everyoneには非公開のstaging状態にする。作成途中の投稿raceを
      // 避け、全件そろった後に通常6チャンネルだけ公開する。
      if (this.getState("normal_channels_public") !== "1") {
        const normalChannels = this.registeredChannels().filter(
          (channel) => channel.kind === "normal_text" || channel.kind === "normal_voice",
        );
        if (normalChannels.length !== 6) {
          throw new Error(`Expected six normal channels, found ${normalChannels.length}`);
        }
        this.setState("normal_channels_public", "publishing");
        for (const channel of normalChannels) {
          if (Date.now() >= japanNightEndMs(dateJst)) {
            await this.scheduleAlarmAt(Date.now() + 1_000);
            return;
          }
          await putChannelPermission(
            this.env,
            channel.channel_id,
            buildNormalPublicOverwrite(this.env.DISCORD_GUILD_ID),
          );
        }
        this.setState("normal_channels_public", "1");
      }

      // 通常チャンネル6個の公開権限をすべて反映してから、作成通知を送る。
      // Gateway READY後の投稿なのでMESSAGE_CREATEで集計され、nonceと状態flagで
      // 途中失敗時の二重投稿も抑止する。
      const firstText = this.firstRegistered("normal_text");
      if (!firstText) {
        throw new Error("Required normal announcement channel was not registered");
      }
      if (this.getState("announcement_sent") !== "1") {
        if (Date.now() >= japanNightEndMs(dateJst)) {
          await this.scheduleAlarmAt(Date.now() + 1_000);
          return;
        }
        await createAnnouncement(
          this.env,
          firstText.channel_id,
          {
            ...buildAnnouncementPayload(this.env.DISCORD_MENTION_ROLE_ID),
            // チャンネルIDをnonceに含め、作成途中でチャンネルをロール
            // バックしても、別チャンネルの通知と衝突しないようにする。
            nonce: `open-${firstText.channel_id}`,
          },
        );
        this.setState("announcement_sent", "1");
      }

      if (Date.now() >= japanNightEndMs(dateJst)) {
        await this.scheduleAlarmAt(Date.now() + 1_000);
        return;
      }

      // 03:00の公開処理が、00:00のチャンネル作成完了前に到着する場合が
      // ある。判定は外部API処理の直後に行い、作成中に届いた遅延イベントも
      // 取りこぼさない。
      const pendingDeepOpen = this.getState("pending_operation") === "open_deep";
      this.setState("phase", "SEPARATED");
      this.setState("opening_stage", "done");
      this.setState("pending_operation", pendingDeepOpen ? "open_deep" : "");
      if (pendingDeepOpen) {
        await this.scheduleAlarmAt(Date.now() + 1_000);
      }
      console.log(`Created ${EXPECTED_CHANNEL_COUNT} night channels for ${dateJst}`);
    } catch (error) {
      if (this.getPhase() === "OPENING") {
        let rollbackComplete = false;
        try {
          // 失敗時は次の再試行で厳密な管理対象を改めて掃除する。
          // キュー処理が未完了でもOPENINGのまま再利用しない。
          rollbackComplete = await this.rollbackOpeningChannels(created);
        } catch (rollbackError) {
          this.logOperationError("opening rollback", rollbackError);
        }
        if (rollbackComplete) {
          this.clearManagedChannels();
        }
        // 作成途中に届いた告知・投稿・通話イベントは、ロールバックした
        // チャンネルの履歴なので、次の作成試行へ持ち越さない。
        this.setState("message_partial_mask", "0");
        this.setState("voice_partial_mask", "0");
        this.setState("metrics_integrity", "complete");
        this.setState("message_integrity", "complete");
        this.setState("usage_integrity", "complete");
        this.setState("voice_integrity", "complete");
        this.clearVoiceReplayStates();
        this.setState("voice_replay_mode", "0");
        this.setState("voice_replay_snapshot_required", "0");
        this.deleteDailyUsage(dateJst);
        this.deleteAnonymousActivity(dateJst);
        this.deleteActiveSessions(dateJst);
        this.setState("announcement_sent", "0");
        this.setState("deep_announcement_sent", "0");
        this.setState("opening_cleanup_done", "0");
        this.setState("normal_channels_public", "0");
      }
      throw error;
    }
  }

  private async beginOpenDeep(dateJst: string): Promise<void> {
    if (this.deepOpenInProgress) {
      await this.scheduleAlarmAt(Date.now() + 5_000);
      return;
    }
    this.deepOpenInProgress = true;
    try {
      await this.beginOpenDeepInternal(dateJst);
    } finally {
      this.deepOpenInProgress = false;
    }
  }

  private async beginOpenDeepInternal(dateJst: string): Promise<void> {
    if (this.getState("date_jst") !== dateJst) {
      // 00:00のCronが欠落して03:00だけ到着しても、その日の通常チャンネル
      // を作成してから深層公開まで続ける。予約日は日次状態として保持し、
      // beginOpenが前日の後処理を待つ場合も、途中再起動で意図を失わない。
      this.setState("deferred_open_deep_date", dateJst);
      await this.beginOpen(dateJst);
      return;
    }
    if (Date.now() >= japanNightEndMs(dateJst)) {
      // 03:00公開が遅延して08:00を越えた場合は、公開せずにcloseへ
      // 引き継ぐ。呼び出し側のフラグ解除後にAlarmが再判定する。
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }
    this.setState("pending_operation", "open_deep");
    this.setState("deferred_open_deep_date", "");

    const phase = this.getPhase();
    if (phase !== "SEPARATED" && phase !== "ALL_OPEN") {
      await this.scheduleAlarmAt(Date.now() + 5_000);
      return;
    }
    if (phase === "ALL_OPEN") {
      // 既に公開済みの重複Cronは、公開処理を再実行せず意図だけ消費する。
      this.setState("pending_operation", "");
      return;
    }

    if (!this.isGatewayConnected()) {
      this.connectGateway();
    }

    // 公開権限の反映は複数の外部API呼び出しになるため、処理開始時点で
    // OPENING/公開処理の復旧用Alarmを確保する。
    await this.scheduleGatewayWatchdog();

    const deepChannels = this.registeredChannels().filter(
      (channel) => channel.kind === "deep_text" || channel.kind === "deep_voice",
    );
    if (deepChannels.length !== 4) {
      throw new Error(`Expected four deep channels, found ${deepChannels.length}`);
    }

    // SQLiteの登録情報だけを信頼せず、公開権限を書き込む直前に全件を
    // 再検証する。移動・改名・種別変更されたチャンネルは公開しない。
    const remoteById = new Map(
      (await listGuildChannels(this.env)).map((channel) => [channel.id, channel] as const),
    );
    for (const channel of deepChannels) {
      const remote = remoteById.get(channel.channel_id);
      const remoteKind = remote
        ? classifyManagedChannel(
          remote,
          this.env.DISCORD_PARENT_CATEGORY_ID,
          this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
        )
        : null;
      if (
        !remote ||
        remote.name !== channel.name ||
        remote.parent_id !== this.env.DISCORD_DEEP_PARENT_CATEGORY_ID ||
        remoteKind !== channel.kind
      ) {
        throw new Error(`Deep channel validation failed: ${channel.channel_id}`);
      }
    }

    for (const channel of deepChannels) {
      if (this.getPhase() !== "SEPARATED" || this.getState("date_jst") !== dateJst) {
        return;
      }
      if (Date.now() >= japanNightEndMs(dateJst)) {
        await this.scheduleAlarmAt(Date.now() + 1_000);
        return;
      }
      await putChannelPermission(
        this.env,
        channel.channel_id,
        buildDeepPublicOverwrite(this.env.DISCORD_GUILD_ID),
      );
      if (Date.now() >= japanNightEndMs(dateJst)) {
        await this.scheduleAlarmAt(Date.now() + 1_000);
        return;
      }
      await putChannelPermission(
        this.env,
        channel.channel_id,
        buildDeepRolePublicOverwrite(this.env.DISCORD_DEEP_ROLE_ID),
      );
    }

    // 深層4チャンネルの公開権限がすべて整った後で、深層テキストへ通知する。
    // 通知に失敗した場合はpending_operationとAlarmで公開処理ごと再試行する。
    if (this.getState("deep_announcement_sent") !== "1") {
      const firstDeepText = this.firstRegistered("deep_text");
      if (!firstDeepText) {
        throw new Error("Required deep announcement channel was not registered");
      }
      if (Date.now() >= japanNightEndMs(dateJst)) {
        await this.scheduleAlarmAt(Date.now() + 1_000);
        return;
      }
      await createAnnouncement(
        this.env,
        firstDeepText.channel_id,
        {
          ...buildAnnouncementPayload(this.env.DISCORD_MENTION_ROLE_ID),
          nonce: `open-${firstDeepText.channel_id}`,
        },
      );
      this.setState("deep_announcement_sent", "1");
    }

    this.setState("phase", "ALL_OPEN");
    this.setState("pending_operation", "");
    await this.scheduleGatewayWatchdog();
  }

  private async beginClose(dateJst: string): Promise<void> {
    const phase = this.getPhase();
    const currentDate = this.getState("date_jst");
    if (
      currentDate &&
      /^\d{4}-\d{2}-\d{2}$/.test(currentDate) &&
      currentDate > dateJst
    ) {
      // 遅延・重複した前日closeが新しい夜のチャンネルを閉じないようにする。
      return;
    }
    // 作成処理や深層公開処理の途中でCLOSINGへ遷移すると、後から到着した
    // 外部APIの完了処理が公開状態を復活させ得る。完了を待ってから閉じる。
    if (
      this.deepOpenInProgress ||
      (phase === "OPENING" && (this.openingInProgress || this.openingFinishInProgress))
    ) {
      await this.scheduleAlarmAt(Date.now() + (phase === "OPENING" ? 30_000 : 5_000));
      return;
    }

    // 実行中のOPENINGを待つのは上の条件だけ。外部I/Oが既に終わった後も
    // OPENINGだけが残ると08:00削除が永久に始まらないため、停止した作成処理
    // はCLOSINGへ引き継ぐ。削除段階ではDiscord上の管理対象を再走査する。
    if (phase === "OPENING") {
      console.error("Closing superseded an unfinished opening operation");
    }

    if (phase === "CLOSED" && currentDate !== dateJst) {
      return;
    }
    if (phase === "CLOSED" && this.getState("close_stage") === "done") {
      return;
    }

    this.setState("date_jst", this.getState("date_jst") || dateJst);
    this.setState("phase", "CLOSING");
    this.setState("pending_operation", "close");
    this.setState("close_stage", this.getState("close_stage") || "flush");
    await this.continueClosing();
  }

  private async continueClosing(): Promise<void> {
    if (this.closingInProgress) {
      return;
    }
    this.closingInProgress = true;
    try {
      await this.continueClosingInternal();
    } finally {
      this.closingInProgress = false;
    }
  }

  private async continueClosingInternal(): Promise<void> {
    const dateJst = this.getState("date_jst");
    if (!dateJst) {
      throw new Error("Closing has no JST date");
    }
    // 08:00処理はDiscord APIを複数回呼ぶため、実行コンテキストが途中で
    // 終了しても同じclose_stageから再開できるよう、先に復旧Alarmを置く。
    await this.scheduleAlarmAt(Date.now() + 300_000);
    const cutoff = japanNightEndMs(dateJst);
    const stage = (this.getState("close_stage") as CloseStage | null) ?? "flush";

    // Reports can remain pending after the channel deletion and role queue
    // have already advanced. Alarm retries must revisit them without
    // re-running destructive phases.
    if (stage === "role_queue" || stage === "role_sync" || stage === "done") {
      this.setState("phase", "REPORTING");
      // ログ投稿はベストエフォートにし、失敗してもチャンネル削除後の
      // ロール同期・後処理を止めない。投稿だけは未完了フラグを残し、
      // 次のAlarmで再試行する。
      await this.sendReportsWithoutBlockingCleanup(dateJst);
    }

    if (stage === "flush") {
      // 08:00で新規利用は止めるが、Gatewayは短いdrain期間まで保持する。
      // その間にRESUMEできれば、Snowflake時刻のMESSAGE_CREATEを回収する。
      this.setState("close_stage", "lock");
    }

    if (this.getState("close_stage") === "lock") {
      await this.lockRegisteredChannels(dateJst);
      // 権限ロックが完了してからrecovery graceを開始する。ロック中に
      // 30秒を使い切って、Gateway replayの機会を失わないようにする。
      this.setState("gateway_drain_until", String(Date.now() + GATEWAY_DRAIN_GRACE_MS));
      this.setState("close_stage", "drain");
      // 1回のAlarmで権限変更・削除・レポート・ロール同期まで連続実行
      // すると、Workers Freeのsubrequest上限を超える。段階ごとに返す。
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "drain") {
      let drainUntil = Number(this.getState("gateway_drain_until"));
      if (!Number.isFinite(drainUntil)) {
        drainUntil = Date.now() + GATEWAY_DRAIN_GRACE_MS;
        this.setState("gateway_drain_until", String(drainUntil));
      }
      if (Number.isFinite(drainUntil) && Date.now() < drainUntil) {
        if (!this.isGatewayConnected()) {
          this.connectGateway();
        }
        await this.scheduleAlarmAt(Math.min(drainUntil, Date.now() + 1_000));
        return;
      }

      // drain中に届いたイベントがまだchainへ残っている場合、先に
      // sequence/集計を確定させる。ここで先にflushやpartial確定を行うと、
      // 08:00直前の遅延MESSAGE_CREATEを取りこぼす可能性がある。
      await this.waitForGatewayEventChain();
      if (this.getState("gateway_gap_started_at")) {
        this.finalizeUnresolvedGatewayGap(dateJst, cutoff);
      } else {
        this.flushActiveVoiceSessions(dateJst, cutoff);
      }
      this.setState("close_stage", "gateway");
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "gateway") {
      // 先にclose frameを送り、close callbackがdispatch chainの末尾へ
      // 積まれるまでsocket参照を保つ。08:00 cutoff前の遅延messageが
      // close直前に届いた場合も、sequence確定後に削除へ進む。
      await this.closeGatewayForNight();
      this.setState("close_stage", "delete");
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "delete") {
      const registered = await this.ensureRegisteredChannels(dateJst);
      // OPENING失敗や前回の途中停止でDB登録が欠けても、厳密な名前・
      // カテゴリ・種別に一致するDiscord上の管理対象を取りこぼさない。
      const remote = await listGuildChannels(this.env);
      const channelIds = new Set(registered.map((channel) => channel.channel_id));
      for (const channel of remote) {
        if (
          classifyManagedChannel(
            channel,
            this.env.DISCORD_PARENT_CATEGORY_ID,
            this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
          ) !== null
        ) {
          channelIds.add(channel.id);
        }
      }
      if (!await this.deleteChannels([...channelIds])) {
        return;
      }
      this.clearManagedChannels();
      this.setState("close_stage", "reports");
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "reports") {
      this.setState("phase", "REPORTING");
      // close_stage=reportsに到達した時点で、チャンネル削除は完了済み。
      // ログ出力の成否に関係なく、後続のロール同期へ進める。
      await this.sendReportsWithoutBlockingCleanup(dateJst);
      this.setState("close_stage", "role_queue");
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "role_queue") {
      this.prepareRoleSync(dateJst);
      this.setState("close_stage", "role_sync");
      this.setState("phase", "ROLE_SYNC");
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "role_sync") {
      await this.processRoleSync(dateJst);
      if (this.getState("close_stage") !== "done") {
        return;
      }
    }

    await this.finalizeCloseIfReady(dateJst);
  }

  private async sendReports(dateJst: string): Promise<void> {
    if (this.reportsInProgress) {
      return;
    }
    this.reportsInProgress = true;
    try {
      await this.sendReportsInternal(dateJst);
    } finally {
      this.reportsInProgress = false;
    }
  }

  private async sendReportsWithoutBlockingCleanup(dateJst: string): Promise<void> {
    try {
      await this.sendReports(dateJst);
    } catch (error) {
      // Discord API以外の予期せぬ投稿エラーでも、削除後の終了処理は
      // 継続する。未送信フラグは残るため、最終化前のAlarmで再試行される。
      this.logOperationError("reports", error);
    }
  }

  private reportRetryIsPending(key: "report_retry_at" | "detail_report_retry_at"): boolean {
    const retryAt = Number(this.getState(key));
    return Number.isSafeInteger(retryAt) && retryAt > Date.now();
  }

  private nextReportRetryAt(): number | null {
    const now = Date.now();
    const retryAt = ["report_retry_at", "detail_report_retry_at"]
      .map((key) => Number(this.getState(key)))
      .filter((value) => Number.isSafeInteger(value) && value > now);
    return retryAt.length > 0 ? Math.min(...retryAt) : null;
  }

  private async scheduleReportRetry(
    key: "report_retry_at" | "detail_report_retry_at",
    error: unknown,
  ): Promise<void> {
    const requestedDelay = error instanceof DiscordRateLimitError
      ? error.retryAfterMs
      : 300_000;
    // Discordの通常のRetry-Afterは短時間だが、異常なヘッダー値で
    // setAlarmへ非安全なtimestampを渡さない。
    const delay = Number.isSafeInteger(requestedDelay) && requestedDelay >= 0
      ? Math.max(1_000, requestedDelay)
      : 300_000;
    const retryAt = Math.min(MAX_ALARM_TIMESTAMP_MS, Date.now() + delay);
    this.setState(key, String(retryAt));
    await this.scheduleAlarmAt(retryAt);
  }

  private async sendReportsInternal(dateJst: string): Promise<void> {
    // レポート直前に匿名SQLite正本から再計算する。service_stateの古い
    // cacheが壊れていても、message_buckets/daily_usageを優先する。
    let messageCount = 0;
    let visitorCount = 0;
    let buckets: ActivityBucket[] = [];
    let detailActivityReadFailed = false;
    try {
      messageCount = this.countMessageBuckets(dateJst);
    } catch (error) {
      // 集計読み取りの失敗でも、概要ログの挨拶と他指標の送信を
      // 省略しない。件数は観測値0ではなくpartialとして表示する。
      this.markIntegrityPartial("message");
      this.logReportError("message aggregate", error);
    }
    try {
      visitorCount = this.countDailyUsage(dateJst);
    } catch (error) {
      this.markIntegrityPartial("usage");
      this.logReportError("visitor aggregate", error);
    }
    try {
      buckets = this.activityBuckets(dateJst);
    } catch (error) {
      // 詳細内訳だけが読めない場合は、メッセージ概要の正本結果まで
      // 巻き戻さず、詳細側を全枠partial・voice概算として継続する。
      detailActivityReadFailed = true;
      this.markIntegrityPartial("voice");
      this.logReportError("activity aggregate", error);
      buckets = Array.from({ length: ACTIVITY_BUCKET_COUNT }, (_, index) => ({
        index,
        totalVoiceMs: 0,
        mutedVoiceMs: 0,
        uniqueUsers: 0,
        mutedUsers: 0,
        messageCount: 0,
      }));
    }
    const bustle = weightedBustleSeconds(buckets);
    const messagePartialMask = this.partialMask("message_partial_mask");
    const voicePartialMask = this.partialMask("voice_partial_mask");
    const messagePartial = this.getIntegrity("message_integrity") === "partial" ||
      messagePartialMask !== 0;
    const usagePartial = this.getIntegrity("usage_integrity") === "partial";
    const voicePartial = this.getIntegrity("voice_integrity") === "partial" ||
      voicePartialMask !== 0;

    if (this.getState("report_sent") !== "1" && !this.reportRetryIsPending("report_retry_at")) {
      try {
        const summary = buildMessageCountLog(messageCount, visitorCount, bustle, {
          messagePartial,
          usagePartial,
        });
        await createTextMessage(
          this.env,
          MESSAGE_LOG_CHANNEL_ID,
          summary,
          { nonce: `summary-${dateJst}` },
        );
        this.setState("report_sent", "1");
        this.setState("report_retry_at", "");
      } catch (error) {
        this.logReportError("summary", error);
        await this.scheduleReportRetry("report_retry_at", error);
      }
    }

    if (
      this.getState("detail_report_sent") !== "1" &&
      !this.reportRetryIsPending("detail_report_retry_at")
    ) {
      try {
        await createTextMessage(
          this.env,
          this.env.DISCORD_ACTIVITY_DETAIL_CHANNEL_ID,
          buildDetailReport(
            dateJst,
            buckets,
            {
              messagePartialMask,
              voicePartialMask,
              messagePartial: detailActivityReadFailed ||
                (messagePartial && messagePartialMask === 0),
              voicePartial: detailActivityReadFailed ||
                (voicePartial && voicePartialMask === 0),
            },
          ),
          { nonce: `detail-${dateJst}` },
        );
        this.setState("detail_report_sent", "1");
        this.setState("detail_report_retry_at", "");
      } catch (error) {
        this.logReportError("detail", error);
        await this.scheduleReportRetry("detail_report_retry_at", error);
      }
    }
  }

  private prepareRoleSync(dateJst: string): void {
    if (this.getState("role_queue_initialized") === "1") {
      return;
    }

    // 前日の権限エラーで残ったキューを先に退避する。権限エラー後も
    // チャンネル削除と翌日の公開を止めない設計のため、ここで単純に
    // DELETEすると、次回終了処理まで利用していないユーザーの追加や
    // 前日の解除を永久に失う。
    const pendingRetry = this.roleQueueCount() > 0
      ? this.rows<RoleQueueItem>(
        "SELECT user_id, action FROM role_sync_queue ORDER BY user_id",
      )
      : [];
    this.ctx.storage.sql.exec("DELETE FROM role_sync_queue");

    const detected = this.rows<{ user_id: string }>(
      "SELECT user_id FROM daily_usage WHERE date_jst = ?",
      dateJst,
    ).map((row) => row.user_id);
    const current = this.rows<{ user_id: string }>(
      "SELECT user_id FROM deep_role_members",
    ).map((row) => row.user_id);
    const currentSet = new Set(current);
    const detectedSet = new Set(detected);
    const usagePartial = this.getIntegrity("usage_integrity") === "partial";

    for (const userId of detectedSet) {
      if (!currentSet.has(userId)) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'add')",
          userId,
        );
      }
    }

    if (!usagePartial) {
      for (const userId of currentSet) {
        if (!detectedSet.has(userId)) {
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'remove')",
            userId,
          );
        }
      }
    }

    // 以前の未処理操作を当日の利用状況とマージする。追加は保守的に
    // 維持し、解除は当日も「未利用」と確認できた場合だけ維持する。
    // usageがpartialなら、欠測で既存deep roleを外さない。
    for (const item of pendingRetry) {
      if (item.action === "add") {
        if (!currentSet.has(item.user_id)) {
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'add')",
            item.user_id,
          );
        }
      } else if (
        !usagePartial &&
        currentSet.has(item.user_id) &&
        !detectedSet.has(item.user_id)
      ) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'remove')",
          item.user_id,
        );
      }
    }

    this.setState("role_queue_initialized", "1");
    const complete = this.roleQueueCount() === 0;
    this.setState("role_sync_status", complete ? "complete" : "pending");
    this.setState("role_sync_complete", complete ? "1" : "0");
  }

  private async processRoleSync(dateJst: string): Promise<void> {
    const queue = this.rows<RoleQueueItem>(
      "SELECT user_id, action FROM role_sync_queue ORDER BY user_id LIMIT ?",
      MAX_ROLE_OPERATIONS_PER_ALARM,
    );

    if (queue.length === 0) {
      this.setState("role_sync_status", "complete");
      this.setState("role_sync_complete", "1");
      if (this.reportsAreComplete()) {
        this.deleteDailyUsage(dateJst);
      }
      this.setState("close_stage", "done");
      return;
    }

    for (const item of queue) {
      try {
        if (item.action === "add") {
          await addGuildMemberRole(this.env, item.user_id, this.env.DISCORD_DEEP_ROLE_ID);
          this.ctx.storage.sql.exec(
            "INSERT OR IGNORE INTO deep_role_members (user_id) VALUES (?)",
            item.user_id,
          );
        } else {
          await removeGuildMemberRole(this.env, item.user_id, this.env.DISCORD_DEEP_ROLE_ID);
          this.ctx.storage.sql.exec(
            "DELETE FROM deep_role_members WHERE user_id = ?",
            item.user_id,
          );
        }
        this.ctx.storage.sql.exec("DELETE FROM role_sync_queue WHERE user_id = ?", item.user_id);
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) {
          // The member may have left the guild between detection and the
          // batch. There is no role mutation left to perform for that user.
          if (item.action === "remove") {
            this.ctx.storage.sql.exec(
              "DELETE FROM deep_role_members WHERE user_id = ?",
              item.user_id,
            );
          }
          this.ctx.storage.sql.exec("DELETE FROM role_sync_queue WHERE user_id = ?", item.user_id);
          continue;
        }
        this.logRoleSyncError(item.action, error);
        if (error instanceof DiscordApiError && (error.status === 401 || error.status === 403)) {
          // 権限・トークン設定の恒久エラーで、チャンネルの削除や翌日の
          // 公開まで止めない。未処理キューは残し、次の日の終了処理で
          // 現在の利用状況から再構築して再試行する。
          this.setState("role_sync_status", "failed");
          this.setState("role_sync_complete", "0");
          this.setState("close_stage", "done");
          return;
        }
        await this.scheduleRetry("role_sync", error);
        return;
      }
    }

    if (this.roleQueueCount() > 0) {
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    this.setState("role_sync_status", "complete");
    this.setState("role_sync_complete", "1");
    if (this.reportsAreComplete()) {
      this.deleteDailyUsage(dateJst);
    }
    this.setState("close_stage", "done");
  }

  private async finalizeCloseIfReady(dateJst: string): Promise<void> {
    const roleSyncComplete = this.roleSyncIsReadyForClose();
    const reportsComplete =
      this.getState("report_sent") === "1" && this.getState("detail_report_sent") === "1";

    if (this.getState("report_sent") === "1" && this.getState("detail_report_sent") === "1") {
      this.deleteAnonymousActivity(dateJst);
    }
    this.deleteActiveSessions(dateJst);

    if (roleSyncComplete && reportsComplete && this.getState("close_stage") === "done") {
      // 投稿が一時的に失敗した場合も、レポート再試行が完了するまでは
      // daily_usageを残してvisitor数の正本を失わない。
      this.deleteDailyUsage(dateJst);
      const nextOpenDate = this.getState("next_open_date");
      const shouldOpenNextDay = this.getState("open_after_cleanup") === "1" && nextOpenDate;
      const nextOpenDeepDate = this.getState("deferred_open_deep_date");
      this.clearDailyEphemeralState();
      this.setState("phase", "CLOSED");
      // 成功後に残った復旧Alarmを消し、次の日の処理だけが新しいAlarmを作る。
      await this.ctx.storage.deleteAlarm();
      if (shouldOpenNextDay && nextOpenDate) {
        // 03:00の深層公開が前日の終了処理を待っていた場合は、日次状態を
        // 消去した後も、その予約だけを次のOPENINGへ引き継ぐ。
        if (nextOpenDeepDate === nextOpenDate) {
          this.setState("deferred_open_deep_date", nextOpenDate);
        }
        // 00:00のbeginOpenが前日の終了処理を待っている場合、ここは
        // beginOpenの再入呼び出しになる。ロックに弾かれてAlarmだけ残すと、
        // CLOSEDのalarm()は新規OPENを知らないため、同日分を取りこぼす。
        if (this.openingInProgress) {
          await this.beginOpenInternal(nextOpenDate);
        } else {
          await this.beginOpen(nextOpenDate);
        }
      }
      return;
    }

    if (!roleSyncComplete) {
      this.setState("phase", "ROLE_SYNC");
    } else if (!reportsComplete) {
      this.setState("phase", "REPORTING");
    }
    await this.scheduleAlarmAt(this.nextReportRetryAt() ?? Date.now() + 300_000);
  }

  private clearDailyEphemeralState(): void {
    const placeholders = DAILY_EPHEMERAL_STATE_KEYS.map(() => "?").join(", ");
    this.ctx.storage.sql.exec(
      `DELETE FROM service_state WHERE key IN (${placeholders})`,
      ...DAILY_EPHEMERAL_STATE_KEYS,
    );
    this.clearVoiceReplayStates();
    // 次の日に持ち越すのは、現在のフェーズとロール同期の完了状態だけにする。
    this.setState("metrics_integrity", "complete");
    this.setState("message_integrity", "complete");
    this.setState("usage_integrity", "complete");
    this.setState("voice_integrity", "complete");
    this.setState("message_partial_mask", "0");
    this.setState("voice_partial_mask", "0");
    this.setState("gateway_state", "closed");
  }

  private async lockRegisteredChannels(dateJst: string): Promise<void> {
    const registered = await this.ensureRegisteredChannels(dateJst);
    if (registered.length === 0) {
      return;
    }

    // SQLiteの登録情報だけを信頼せず、権限変更直前にも現在の名前・親・
    // 種別を検証する。管理者が移動・改名したチャンネルは触らない。
    const remoteById = new Map(
      (await listGuildChannels(this.env)).map((channel) => [channel.id, channel] as const),
    );
    for (const channel of registered) {
      const remote = remoteById.get(channel.channel_id);
      const remoteKind = remote
        ? classifyManagedChannel(
          remote,
          this.env.DISCORD_PARENT_CATEGORY_ID,
          this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
        )
        : null;
      const expectedParentId = channel.kind.startsWith("deep_")
        ? this.env.DISCORD_DEEP_PARENT_CATEGORY_ID
        : this.env.DISCORD_PARENT_CATEGORY_ID;
      if (
        !remote ||
        remote.name !== channel.name ||
        remote.parent_id !== expectedParentId ||
        remoteKind !== channel.kind
      ) {
        this.ctx.storage.sql.exec(
          "DELETE FROM managed_channels WHERE channel_id = ?",
          channel.channel_id,
        );
        continue;
      }

      try {
        await putChannelPermission(
          this.env,
          channel.channel_id,
          buildPrivateOverwrite(this.env.DISCORD_GUILD_ID),
        );
        if (channel.kind === "deep_text" || channel.kind === "deep_voice") {
          await putChannelPermission(
            this.env,
            channel.channel_id,
            buildRolePrivateOverwrite(this.env.DISCORD_DEEP_ROLE_ID),
          );
        }
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) {
          this.ctx.storage.sql.exec(
            "DELETE FROM managed_channels WHERE channel_id = ?",
            channel.channel_id,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private async ensureRegisteredChannels(dateJst: string): Promise<StoredChannel[]> {
    const stored = this.registeredChannels();
    const expected = new Map(
      channelDefinitions(
        dateJst.slice(5),
        this.env.DISCORD_GUILD_ID,
        this.env.DISCORD_DEEP_ROLE_ID,
        this.env.DISCORD_PARENT_CATEGORY_ID,
        this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      ).map((definition) => [definition.name, definition] as const),
    );
    const validStored = new Map<string, StoredChannel>();
    for (const channel of stored) {
      const definition = expected.get(channel.name);
      if (
        channel.date_jst === dateJst &&
        definition?.kind === channel.kind
      ) {
        validStored.set(`${channel.kind}:${channel.name}`, channel);
      }
    }
    if (validStored.size === EXPECTED_CHANNEL_COUNT) {
      return [...validStored.values()];
    }

    const remote = await listGuildChannels(this.env);
    for (const channel of remote) {
      const definition = expected.get(channel.name ?? "");
      const remoteKind = classifyManagedChannel(
        channel,
        this.env.DISCORD_PARENT_CATEGORY_ID,
        this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
      );
      if (
        definition &&
        channel.parent_id === definition.parent_id &&
        channel.type === definition.type &&
        remoteKind === definition.kind
      ) {
        this.registerManagedChannel(channel.id, channel.name ?? "", definition.kind, dateJst);
      }
    }

    // 古い日付・種別・カテゴリの登録を、現在の終了処理の対象に混ぜない。
    return this.registeredChannels().filter((channel) => {
      const definition = expected.get(channel.name);
      return channel.date_jst === dateJst && definition?.kind === channel.kind;
    });
  }

  private async deleteChannels(channelIds: readonly string[]): Promise<boolean> {
    this.enqueueChannelDeletes(channelIds);
    return this.processChannelDeleteQueue();
  }

  private async rollbackOpeningChannels(channelIds: readonly string[]): Promise<boolean> {
    this.enqueueChannelDeletes(channelIds);
    return this.processChannelDeleteQueue(MAX_OPENING_ROLLBACK_OPERATIONS_PER_ALARM);
  }

  private enqueueChannelDeletes(channelIds: readonly string[]): void {
    // 無料枠のsubrequest上限を超えないよう、削除対象をSQLiteキューへ積む。
    for (const channelId of channelIds) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO channel_delete_queue (channel_id) VALUES (?)",
        channelId,
      );
    }
  }

  private async processChannelDeleteQueue(
    operationLimit = MAX_CHANNEL_DELETE_OPERATIONS_PER_ALARM,
  ): Promise<boolean> {
    const queue = this.rows<ChannelDeleteQueueItem>(
      `SELECT q.channel_id, m.name AS expected_name, m.kind AS expected_kind
       FROM channel_delete_queue q
       LEFT JOIN managed_channels m ON m.channel_id = q.channel_id
       ORDER BY q.channel_id
       LIMIT ?`,
      operationLimit,
    );
    if (queue.length === 0) {
      return true;
    }

    // Alarm待ちの間に名前や親カテゴリが変更された場合は、削除せずキューから外す。
    // 登録済みチャンネルは、キュー投入時の名前・種別とも一致する場合だけ削除する。
    const remoteChannels = await listGuildChannels(this.env);
    const remoteById = new Map(remoteChannels.map((channel) => [channel.id, channel] as const));
    const failures: string[] = [];

    for (const item of queue) {
      const channel = remoteById.get(item.channel_id);
      const remoteKind = channel
        ? classifyManagedChannel(
          channel,
          this.env.DISCORD_PARENT_CATEGORY_ID,
          this.env.DISCORD_DEEP_PARENT_CATEGORY_ID,
        )
        : null;
      if (
        !channel ||
        !remoteKind ||
        (item.expected_name !== null && channel.name !== item.expected_name) ||
        (item.expected_kind !== null && remoteKind !== item.expected_kind)
      ) {
        this.ctx.storage.sql.exec(
          "DELETE FROM channel_delete_queue WHERE channel_id = ?",
          item.channel_id,
        );
        continue;
      }

      try {
        await deleteChannel(this.env, item.channel_id);
        this.ctx.storage.sql.exec(
          "DELETE FROM channel_delete_queue WHERE channel_id = ?",
          item.channel_id,
        );
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) {
          this.ctx.storage.sql.exec(
            "DELETE FROM channel_delete_queue WHERE channel_id = ?",
            item.channel_id,
          );
          continue;
        }
        if (error instanceof DiscordRateLimitError) {
          throw error;
        }
        this.logChannelDeleteError(item.channel_id, error);
        failures.push(item.channel_id);
      }
    }

    if (failures.length > 0) {
      throw new Error(`Managed channel deletion failed for ${failures.length} channel(s)`);
    }

    const remaining = this.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM channel_delete_queue",
    )[0];
    if (Number(remaining?.count ?? 0) > 0) {
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return false;
    }
    return true;
  }

  private connectGateway(): void {
    if (this.getPhase() === "CLOSED" || this.getPhase() === "BLOCKED") {
      return;
    }

    if (this.gatewaySocket) {
      const readyState = this.gatewaySocket.readyState;
      const connected = this.getState("gateway_connected") === "1";
      if (readyState === WebSocket.OPEN && connected) {
        return;
      }
      if (readyState === WebSocket.CONNECTING || readyState === WebSocket.OPEN) {
        if (connected) {
          return;
        }
        const startedAt = Number(this.getState("gateway_connect_started_at"));
        if (Number.isFinite(startedAt) && Date.now() - startedAt < GATEWAY_WATCHDOG_MS) {
          return;
        }
        // The handshake can remain CONNECTING/OPEN forever without a READY.
        // Treat an expired attempt as stale so the watchdog can recover it.
        this.beginGatewayGap();
        this.disconnectGatewayForResume();
      }
      if (readyState === WebSocket.CLOSING || readyState === WebSocket.CLOSED) {
        // errorイベント後にclose callbackが届かないZombie socketでも、
        // watchdog経由の再接続を実欠測区間として扱う。
        this.beginGatewayGap();
      }
      if (this.gatewaySocket) {
        // A CLOSED/CLOSING socket can remain referenced until its event loop
        // callback runs. It must not block a reconnect attempt.
        this.clearHeartbeatTimer();
        this.gatewayAwaitingAck = false;
        this.gatewaySocket = null;
      }
    }

    const storedResumeUrl = this.getState("gateway_resume_url");
    const normalizedResumeUrl = storedResumeUrl
      ? normalizeGatewayUrl(storedResumeUrl)
      : null;
    const url = !this.gatewayIdentifyOnly && normalizedResumeUrl
      ? normalizedResumeUrl
      : initialGatewayUrl();

    try {
      const socket = new WebSocket(url);
      this.gatewaySocket = socket;
      let resolveClose!: () => void;
      const closePromise = new Promise<void>((resolve) => {
        resolveClose = resolve;
      });
      this.gatewayClosePromises.set(socket, closePromise);
      this.setState("gateway_connect_started_at", String(Date.now()));
      this.setState("gateway_state", "connecting");
      socket.addEventListener("message", (event) => {
        this.enqueueGatewayMessage(socket, event.data);
      });
      socket.addEventListener("close", (event) => {
        this.enqueueGatewayClose(socket, event.code);
        resolveClose();
      });
      socket.addEventListener("error", () => {
        // The close event drives the reconnect path. Payloads and error bodies
        // are intentionally not logged.
        try {
          socket.close(GATEWAY_RESUME_CLOSE_CODE, "gateway error");
        } catch {
          // The socket may already be closed.
        }
      });
    } catch (error) {
      this.handleGatewayTaskError(error);
    }
  }

  private handleGatewayTaskError(error: unknown): void {
    const phase = this.getPhase();
    if (phase === "CLOSED" || phase === "BLOCKED") {
      return;
    }
    this.logGatewayError(error);
    const drainActive = this.gatewayDrainIsActive();
    if (
      phase === "CLOSING" &&
      !drainActive &&
      (this.getState("close_stage") === "drain" ||
        this.getState("close_stage") === "gateway")
    ) {
      // cutoff後に最後のdispatch処理が失敗した場合は、再接続しても削除前に
      // 安全に回収しきれない。完全値を出さず、夜間分を保守的にpartialにする。
      this.markAllActivityPartial();
      return;
    }
    if (this.isTrackingPhase() || drainActive) {
      this.beginGatewayGap();
      this.disconnectGatewayForResume();
    } else {
      return;
    }
    this.ctx.waitUntil(this.scheduleGatewayReconnect().catch((scheduleError) => {
      this.logOperationError("gateway retry", scheduleError);
    }));
  }

  private enqueueGatewayMessage(socket: WebSocket, raw: string | ArrayBuffer): void {
    const task = this.gatewayEventChain.then(() => this.handleGatewayMessage(socket, raw));
    this.gatewayEventChain = task.catch((error) => {
      this.handleGatewayTaskError(error);
    });
    this.ctx.waitUntil(this.gatewayEventChain);
  }

  private enqueueGatewayClose(socket: WebSocket, code: number): void {
    const task = this.gatewayEventChain.then(() => this.handleGatewayClose(socket, code));
    this.gatewayEventChain = task.catch((error) => {
      this.handleGatewayTaskError(error);
    });
    this.ctx.waitUntil(this.gatewayEventChain);
  }

  private async waitForGatewayEventChain(): Promise<void> {
    // await中に新しいcallbackがchainへ追加されることがあるため、
    // 安定したchainを2回確認する。Gateway自体はdrain終了時点で閉じる
    // ので、無限に待たずFree枠の実行時間も守る。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const pending = this.gatewayEventChain;
      await pending;
      if (this.gatewayEventChain === pending) {
        return;
      }
    }
  }

  private async handleGatewayMessage(socket: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    // Reconnect中に古いsocketから届いたイベントで、新しい接続の状態を
    // 上書きしない。特にREADY/sequenceの混線はRESUMEを壊す。
    if (this.gatewaySocket !== socket) {
      return;
    }

    let envelope: GatewayEnvelope;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      envelope = JSON.parse(text) as GatewayEnvelope;
    } catch (error) {
      this.logGatewayError(error);
      if (this.isTrackingPhase() || this.gatewayDrainIsActive()) {
        this.beginGatewayGap();
        this.disconnectGatewayForResume();
        await this.scheduleGatewayReconnect();
      }
      return;
    }

    const sequence = typeof envelope.s === "number" && Number.isSafeInteger(envelope.s)
      ? envelope.s
      : null;
    const lastSequence = this.gatewaySequence();
    if (
      envelope.op === 0 &&
      envelope.t !== "READY" &&
      envelope.t !== "RESUMED" &&
      sequence !== null &&
      lastSequence !== null &&
      sequence <= lastSequence
    ) {
      // 同一Gateway sessionの重複Dispatchは、metricsを再加算せず捨てる。
      return;
    }

    switch (envelope.op) {
      case 10:
        this.handleGatewayHello((envelope.d ?? {}) as GatewayHello);
        return;
      case 11:
        this.gatewayAwaitingAck = false;
        this.setState("gateway_heartbeat_ack_at", String(Date.now()));
        return;
      case 1:
        this.sendGatewayHeartbeat(true);
        return;
      case 7:
        this.beginGatewayGap();
        this.disconnectGatewayForResume();
        await this.scheduleGatewayReconnect();
        return;
      case 9:
        await this.handleInvalidSession(Boolean(envelope.d));
        return;
      case 0:
        const sequenceCommitted = await this.handleGatewayDispatch(
          envelope.t ?? null,
          envelope.d,
          sequence ?? undefined,
        );
        // MESSAGE_CREATE/VOICE_STATE_UPDATEの実集計では、metric更新と
        // sequence保存を同じSQLite transactionで完了させる。ここで同じ
        // sequenceをもう一度保存すると、二回目だけ失敗した際に集計済み
        // eventがRESUMEで再送され、二重加算されるため分岐する。
        if (sequence !== null && !sequenceCommitted) {
          this.persistGatewaySequence(sequence);
        }
        this.setState("gateway_last_dispatch_at", String(Date.now()));
        return;
      default:
        return;
    }
  }

  private handleGatewayHello(hello: GatewayHello): void {
    const interval = Number(hello.heartbeat_interval);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.logGatewayError(new Error("invalid gateway hello"));
      this.beginGatewayGap();
      this.disconnectGatewayForResume();
      this.ctx.waitUntil(this.scheduleGatewayReconnect().catch((error) => {
        this.logOperationError("gateway hello retry", error);
      }));
      return;
    }

    this.gatewayHeartbeatIntervalMs = interval;
    this.sendGatewayIdentifyOrResume();
    this.clearHeartbeatTimer();
    const jitter = Math.floor(Math.random() * interval);
    const socket = this.gatewaySocket;
    this.gatewayHeartbeatTimer = setTimeout(() => {
      if (this.gatewaySocket === socket) {
        this.sendGatewayHeartbeat();
      }
    }, jitter);
  }

  private sendGatewayIdentifyOrResume(): void {
    const sessionId = this.getState("gateway_session_id");
    const sequence = this.gatewaySequence();
    if (!this.gatewayIdentifyOnly && sessionId && sequence !== null) {
      this.sendGatewayPayload({
        op: 6,
        d: {
          token: this.env.DISCORD_BOT_TOKEN,
          session_id: sessionId,
          seq: Number(sequence),
        },
      });
      return;
    }

    this.sendGatewayPayload({
      op: 2,
      d: {
        token: this.env.DISCORD_BOT_TOKEN,
        intents: GATEWAY_INTENTS,
        properties: {
          os: "cloudflare-workers",
          browser: "discord-shinya",
          device: "discord-shinya",
        },
      },
    });
  }

  private sendGatewayHeartbeat(force = false): void {
    const socket = this.gatewaySocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.gatewayAwaitingAck && !force) {
      this.beginGatewayGap();
      this.disconnectGatewayForResume();
      this.ctx.waitUntil(this.scheduleGatewayReconnect().catch((error) => {
        this.logOperationError("gateway heartbeat retry", error);
      }));
      return;
    }

    this.sendGatewayPayload({ op: 1, d: this.gatewaySequence() });
    this.gatewayAwaitingAck = true;
    this.setState("gateway_heartbeat_sent_at", String(Date.now()));
    this.clearHeartbeatTimer();
    this.gatewayHeartbeatTimer = setTimeout(
      () => {
        if (this.gatewaySocket === socket) {
          this.sendGatewayHeartbeat();
        }
      },
      this.gatewayHeartbeatIntervalMs || 45_000,
    );
  }

  private sendGatewayPayload(payload: unknown): void {
    if (!this.gatewaySocket || this.gatewaySocket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.gatewaySocket.send(JSON.stringify(payload));
  }

  private async handleGatewayDispatch(
    type: string | null,
    data: unknown,
    sequence?: number,
  ): Promise<boolean> {
    if (type === "READY") {
      const ready = (data ?? {}) as GatewayReady;
      const hadGatewayGap = Boolean(this.getState("gateway_gap_started_at")) ||
        this.getState("gateway_recovery_pending") === "1" ||
        (this.isMetricsTrackingActive() && this.getState("gateway_resume_pending") === "1");

      // READYは新規IDENTIFYの新session。古いsessionのsequenceを先に
      // 消し、READY処理が成功した最後に今回のsequenceを保存する。
      this.setState("gateway_last_sequence", "");
      if (ready.session_id) {
        this.setState("gateway_session_id", ready.session_id);
      }
      this.setState(
        "gateway_resume_url",
        ready.resume_gateway_url
          ? normalizeGatewayUrl(ready.resume_gateway_url) ?? ""
          : "",
      );
      if (ready.user?.id) {
        this.setState("gateway_bot_user_id", ready.user.id);
      }
      if (hadGatewayGap) {
        this.markGatewayGapPartial(Date.now(), true);
        this.setState("gateway_recovery_pending", "1");
        this.setState("voice_replay_mode", "1");
        this.setState("voice_replay_snapshot_required", "1");
        this.setState("gateway_resume_pending", "0");
      } else {
        this.setState("voice_replay_mode", "0");
        this.setState("voice_replay_snapshot_required", "0");
      }
      console.log(
        hadGatewayGap
          ? "Discord Gateway IDENTIFY completed; the unrecoverable gap remains partial"
          : "Discord Gateway IDENTIFY completed",
      );
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_connect_started_at", "");
      this.setState("gateway_connected", "1");
      this.setState("gateway_state", "connected");
      this.setState("gateway_reconnect_attempts", "0");
      if (this.getPhase() === "OPENING") {
        // チャンネル作成中もGatewayのheartbeat/dispatch処理を止めない。
        // READY自体はこのdispatch内で完了させ、作成失敗だけAlarmで再試行
        // することで、外部RESTの遅延から不要なGateway欠測を作らない。
        this.ctx.waitUntil(this.finishOpen().catch((error) => {
          this.logOperationError("opening", error);
          return this.scheduleRetry("open", error).catch((scheduleError) => {
            this.logOperationError("opening retry", scheduleError);
          });
        }));
      }
      return false;
    }

    if (type === "GUILD_CREATE") {
      const guild = (data ?? {}) as GatewayGuildCreate;
      if (guild.id !== this.env.DISCORD_GUILD_ID || !Array.isArray(guild.voice_states)) {
        return false;
      }
      // 再接続時は、既に通話中の利用者に対するVOICE_STATE_UPDATEが
      // 改めて届かないことがある。GUILD_CREATEのスナップショットも同じ
      // 匿名セッション処理へ渡し、再接続直後の滞在人数を取りこぼさない。
      for (const state of guild.voice_states) {
        this.handleVoiceState({ ...state, guild_id: guild.id });
      }
      if (
        this.getState("voice_replay_mode") === "1" &&
        this.getState("voice_replay_snapshot_required") === "1"
      ) {
        const dateJst = this.getState("date_jst");
        if (dateJst) {
          this.reconcileVoiceReplay(dateJst, Date.now(), true);
        }
        this.setState("gateway_gap_started_at", "");
        this.setState("gateway_recovery_pending", "0");
        this.setState("voice_replay_mode", "0");
        this.setState("voice_replay_snapshot_required", "0");
      }
      return false;
    }

    if (type === "RESUMED") {
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_connect_started_at", "");
      this.setState("gateway_resume_pending", "0");
      this.setState("gateway_connected", "1");
      this.setState("gateway_state", "connected");
      this.setState("gateway_reconnect_attempts", "0");
      const dateJst = this.getState("date_jst");
      if (dateJst) {
        this.markGatewayGapPartial(Date.now(), false);
        this.reconcileVoiceReplay(dateJst, Date.now(), false);
      }
      this.recoverLegacyMessageIntegrityAfterResume();
      console.log("Discord Gateway RESUME succeeded; message dispatch replay completed");
      this.setState("gateway_gap_started_at", "");
      this.setState("gateway_recovery_pending", "0");
      this.setState("voice_replay_mode", "0");
      this.setState("voice_replay_snapshot_required", "0");
      return false;
    }

    if (type === "MESSAGE_CREATE") {
      return this.handleMessageCreate((data ?? {}) as GatewayMessageCreate, sequence);
    }

    if (type === "VOICE_STATE_UPDATE") {
      return this.handleVoiceState((data ?? {}) as GatewayVoiceState, sequence);
    }

    return false;
  }

  private handleMessageCreate(message: GatewayMessageCreate, sequence?: number): boolean {
    if (!this.isMessageTrackingEnabled() || !message.channel_id) {
      return false;
    }
    const channel = this.registeredChannels().find(
      (candidate) => candidate.channel_id === message.channel_id &&
        (candidate.kind === "normal_text" || candidate.kind === "deep_text"),
    );
    if (!channel) {
      return false;
    }

    const dateJst = this.getState("date_jst");
    if (!dateJst || !message.id) {
      this.markIntegrityPartial("message");
      this.markIntegrityPartial("usage");
      return false;
    }
    const messageTimestamp = discordSnowflakeTimestampMs(message.id);
    if (messageTimestamp === null) {
      // Snowflakeを解釈できないイベントは受信時刻で補完しない。正確な
      // bucketが不明なため、観測済みの他イベントを捨てずに全体partialへ。
      this.markIntegrityPartial("message");
      this.markIntegrityPartial("usage");
      return false;
    }
    const bucketIndex = activityBucketIndexAt(dateJst, messageTimestamp);
    if (bucketIndex === null) {
      // 08:00後に届いた遅延/replayでも、Snowflakeが当日08:00前なら上で
      // bucketへ入る。ここは当日対象外のメッセージなので無視する。
      return false;
    }
    const author = message.author;
    if (!author?.id) {
      // 件数はSnowflakeで確定できるが、来場者判定だけはできない。
      // メッセージ数を捨てず、usageだけpartialへ分離する。
      this.markIntegrityPartial("usage");
    }
    this.ctx.storage.transactionSync(() => {
      // message_bucketsを総数の正本にし、sequenceも同じtransactionの
      // 最後に保存する。途中停止時はDiscordが同じDispatchを再送できる。
      this.ctx.storage.sql.exec(
        `INSERT INTO message_buckets (date_jst, bucket_index, message_count)
         VALUES (?, ?, 1)
         ON CONFLICT(date_jst, bucket_index) DO UPDATE SET
           message_count = message_count + 1`,
        dateJst,
        bucketIndex,
      );

      if (author?.id && !author.bot && !author.system) {
        this.markDailyUsage(dateJst, author.id);
      }
      if (sequence !== undefined) {
        this.persistGatewaySequence(sequence);
      }
    });
    return true;
  }

  private handleVoiceState(state: GatewayVoiceState, sequence?: number): boolean {
    if (!this.isVoiceTrackingEnabled() || state.guild_id !== this.env.DISCORD_GUILD_ID) {
      return false;
    }
    const userId = state.user_id;
    if (!userId || state.member?.user?.bot || state.member?.user?.system) {
      return false;
    }
    if (userId === this.getState("gateway_bot_user_id")) {
      return false;
    }

    const dateJst = this.getState("date_jst");
    if (!dateJst) {
      return false;
    }

    const nextChannelId = typeof state.channel_id === "string" ? state.channel_id : null;
    const nextChannel = nextChannelId
      ? this.registeredChannels().find((channel) => channel.channel_id === nextChannelId)
      : undefined;
    const nextIsManagedVoice = Boolean(nextChannel && this.isVoiceKind(nextChannel.kind));
    const nextMuted = !isUnmutedVoiceState(state.self_mute, state.mute);
    if (this.getState("voice_replay_mode") === "1") {
      // replay中はイベント受信時刻を滞在時刻に使わず、最終状態だけを
      // 一時テーブルへ保持してRESUMED/GUILD_CREATE後にreconcileする。
      this.ctx.storage.transactionSync(() => {
        if (nextIsManagedVoice) {
          this.markDailyUsage(dateJst, userId);
        }
        this.ctx.storage.sql.exec(
          `INSERT INTO voice_replay_states (user_id, date_jst, channel_id, muted)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             date_jst = excluded.date_jst,
             channel_id = excluded.channel_id,
             muted = excluded.muted`,
          userId,
          dateJst,
          nextChannelId,
          nextMuted ? 1 : 0,
        );
        if (sequence !== undefined) {
          this.persistGatewaySequence(sequence);
        }
      });
      return true;
    }

    const now = Date.now();
    const active = this.activeVoiceSession(userId);
    const shouldSwitchSession = Boolean(
      active && (active.channel_id !== nextChannelId || active.muted !== Number(nextMuted)),
    );
    const shouldRegisterSession = nextIsManagedVoice && (!active || shouldSwitchSession);
    if (!shouldSwitchSession && !shouldRegisterSession) {
      return false;
    }

    // 区間の確定・旧セッション削除・新セッション登録を一つの同期
    // トランザクションにする。途中停止後の再送で同じ区間を二重加算したり、
    // 状態切替の間に新しい区間を取りこぼしたりしないようにする。
    this.ctx.storage.transactionSync(() => {
      if (shouldSwitchSession && active) {
        this.recordVoiceInterval({
          userId,
          startedAt: active.segment_started_at,
          endedAt: now,
          muted: active.muted === 1,
        }, active.date_jst);
        this.deleteActiveSession(userId);
      }

      if (nextIsManagedVoice) {
        this.markDailyUsage(dateJst, userId);
        if (shouldRegisterSession) {
          this.ctx.storage.sql.exec(
            `INSERT OR REPLACE INTO active_voice_sessions
             (user_id, date_jst, channel_id, segment_started_at, muted)
             VALUES (?, ?, ?, ?, ?)`,
            userId,
            dateJst,
            nextChannelId,
            now,
            nextMuted ? 1 : 0,
          );
        }
      }
      if (sequence !== undefined) {
        this.persistGatewaySequence(sequence);
      }
    });
    return true;
  }

  private async handleInvalidSession(canResume: boolean): Promise<void> {
    this.beginGatewayGap();
    if (!canResume) {
      console.warn("Discord Gateway session cannot resume; switching to IDENTIFY");
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_session_id", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    } else {
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_resume_pending", "1");
    }
    this.disconnectGatewayForResume();
    await this.scheduleGatewayReconnect();
  }

  private async handleGatewayClose(socket: WebSocket, code = 1000): Promise<void> {
    // 古い接続のcloseイベントが、新しい接続の参照や再接続状態を
    // 消さないようにする。
    if (this.gatewaySocket !== socket) {
      return;
    }

    this.gatewaySocket = null;
    this.clearHeartbeatTimer();
    this.gatewayAwaitingAck = false;
    this.setState("gateway_connect_started_at", "");
    if (this.getPhase() === "CLOSED" || this.getPhase() === "BLOCKED") {
      return;
    }
    this.setState("gateway_connected", "0");
    const drainActive = this.gatewayDrainIsActive();
    if (!this.isTrackingPhase() && !drainActive) {
      this.setState("gateway_state", "closed");
      return;
    }

    this.beginGatewayGap();
    const sessionId = this.getState("gateway_session_id");
    const sequence = this.gatewaySequence();
    const canResume = !NON_RESUMABLE_GATEWAY_CODES.has(code) &&
      Boolean(sessionId) && sequence !== null;
    if (!canResume) {
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_session_id", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    } else {
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_resume_pending", "1");
    }
    await this.scheduleGatewayReconnect();
  }

  private async closeGatewayForNight(): Promise<void> {
    this.clearHeartbeatTimer();
    this.gatewayAwaitingAck = false;
    const socket = this.gatewaySocket;
    this.setState("gateway_connected", "0");
    this.setState("gateway_state", "closed");
    this.setState("gateway_connect_started_at", "");
    let closeObserved = true;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close(GATEWAY_NIGHT_CLOSE_CODE, "night window ended");
      } catch {
        // A socket can transition to CLOSED between the state check and close.
      }
    }
    if (socket) {
      const closePromise = this.gatewayClosePromises.get(socket);
      // CLOSEDはclose callbackのdispatch完了を意味しない。イベントがまだ
      // chainへ積まれていない場合にsession/sequenceを先に消さないよう、
      // readyStateに関係なくclose eventそのものを待つ。
      if (closePromise) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        closeObserved = await Promise.race([
          closePromise.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), GATEWAY_NIGHT_CLOSE_WAIT_MS);
          }),
        ]);
        if (timeout !== undefined) {
          clearTimeout(timeout);
        }
      }
      await this.waitForGatewayEventChain();
      if (!closeObserved) {
        this.markAllActivityPartial();
      }
      if (this.gatewaySocket === socket) {
        this.gatewaySocket = null;
      }
      this.gatewayClosePromises.delete(socket);
    }
    // close event chainを処理するまでsequence/sessionを維持する。
    // 先に消すと、終了待ち中に届いた過去sequenceの重複dispatchを
    // 判定できず、メッセージ数を二重加算する可能性がある。
    this.setState("gateway_resume_pending", "0");
    this.setState("gateway_recovery_pending", "0");
    this.setState("gateway_session_id", "");
    this.setState("gateway_resume_url", "");
    this.setState("gateway_last_sequence", "");
    this.gatewayIdentifyOnly = true;
  }

  private disconnectGatewayForResume(): void {
    this.clearHeartbeatTimer();
    this.gatewayAwaitingAck = false;
    const socket = this.gatewaySocket;
    this.gatewaySocket = null;
    this.setState("gateway_connected", "0");
    this.setState("gateway_state", "reconnecting");
    this.setState("gateway_connect_started_at", "");
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        // 1000/1001はRESUME用の切断では使わない。sessionを保持したまま
        // Discord側へ一時的な再接続を通知する。
        socket.close(GATEWAY_RESUME_CLOSE_CODE, "resume reconnect");
      } catch {
        // The socket may already be closed.
      }
    }
  }

  private clearHeartbeatTimer(): void {
    if (this.gatewayHeartbeatTimer !== undefined) {
      clearTimeout(this.gatewayHeartbeatTimer);
      this.gatewayHeartbeatTimer = undefined;
    }
  }

  private async scheduleGatewayWatchdog(): Promise<void> {
    if (this.isTrackingPhase()) {
      this.setState("gateway_watchdog_due", String(Date.now() + GATEWAY_WATCHDOG_MS));
      await this.scheduleAlarmAt(Date.now() + GATEWAY_WATCHDOG_MS);
    }
  }

  private async scheduleGatewayReconnect(): Promise<void> {
    const previousAttempts = Number(this.getState("gateway_reconnect_attempts") ?? "0");
    const attempts = Number.isSafeInteger(previousAttempts) && previousAttempts >= 0
      ? previousAttempts
      : 0;
    const delay = Math.min(
      60_000,
      GATEWAY_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.min(attempts, 7),
    );
    this.setState("gateway_reconnect_attempts", String(Math.min(attempts + 1, 8)));
    this.setState("gateway_state", "reconnecting");
    await this.scheduleAlarmAt(Date.now() + delay);
  }

  private async scheduleRetry(operation: string, error: unknown): Promise<void> {
    if (operation === "gateway") {
      await this.scheduleGatewayReconnect();
      return;
    }
    const requestedDelay = error instanceof DiscordRateLimitError
      ? error.retryAfterMs
      : 300_000;
    const delay = Number.isSafeInteger(requestedDelay) && requestedDelay >= 0
      ? Math.max(1_000, requestedDelay)
      : 300_000;
    const phase = this.getPhase();
    // pending_operationはAlarmが再開する公開処理の意図として使う。
    // 終了処理中に遅れて返ったopen/open_deepのエラーでcloseを上書き
    // しないよう、現在のフェーズと矛盾する操作は保存しない。
    // また、OPENING中に03:00のopen_deepが先に記録されている場合は、
    // 00:00側の再試行でopenへ戻さない。作成完了後に深層公開へ進むための
    // 予約を失うと、その日の深層チャンネルが非公開のままになる。
    const pendingOperation = this.getState("pending_operation");
    const canKeepPendingOperation =
      (operation === "open" && phase === "OPENING" && pendingOperation !== "open_deep") ||
      (operation === "open_deep" && ACTIVE_PHASES.has(phase)) ||
      (operation === "close" &&
        (phase === "CLOSING" || phase === "REPORTING" || phase === "ROLE_SYNC"));
    if (canKeepPendingOperation) {
      this.setState("pending_operation", operation);
    }
    await this.scheduleAlarmAt(Math.min(MAX_ALARM_TIMESTAMP_MS, Date.now() + delay));
  }

  private scheduleAlarmAt(timestamp: number): Promise<void> {
    // getAlarm()とsetAlarm()の間に別イベントが割り込むと、後から来た
    // 遅いAlarmが、先に登録した早いAlarmを上書きする可能性がある。
    // 同一インスタンス内では読み取り・更新を直列化する。
    const scheduled = this.alarmScheduleChain.then(
      () => this.scheduleAlarmAtInternal(timestamp),
      () => this.scheduleAlarmAtInternal(timestamp),
    );
    this.alarmScheduleChain = scheduled.catch(() => undefined);
    return scheduled;
  }

  private async scheduleAlarmAtInternal(timestamp: number): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || timestamp < existing) {
      this.setState("alarm_due", String(timestamp));
      await this.ctx.storage.setAlarm(timestamp);
    }
  }

  private isMessageTrackingEnabled(): boolean {
    if (this.isActivityTrackingEnabled()) {
      return true;
    }
    if (
      this.getPhase() === "CLOSING" &&
      (this.getState("close_stage") === "lock" ||
        this.getState("close_stage") === "drain" ||
        this.getState("close_stage") === "gateway")
    ) {
      // ロック処理中またはロック済み。event chainへ残った、08:00前
      // Snowflakeの遅延/replayだけは削除直前まで回収する。
      return true;
    }
    return this.isDrainTrackingEnabled();
  }

  private isVoiceTrackingEnabled(): boolean {
    if (this.isActivityTrackingEnabled()) {
      return true;
    }
    return this.isDrainTrackingEnabled();
  }

  private isDrainTrackingEnabled(): boolean {
    const phase = this.getPhase();
    if (phase !== "CLOSING" && phase !== "REPORTING" && phase !== "ROLE_SYNC") {
      return false;
    }
    if (this.getState("close_stage") === "lock") {
      // 権限ロック中も、08:00前Snowflakeの遅延イベントを取り込める
      // ようにする。08:00後に作られたメッセージはbucket判定で除外し、
      // 通話区間も終了時刻のcutoffで切り詰める。
      return true;
    }
    const drainUntil = Number(this.getState("gateway_drain_until"));
    return Number.isFinite(drainUntil) && Date.now() <= drainUntil;
  }

  private gatewayDrainIsActive(): boolean {
    // 権限ロック中も、cutoff前イベントを取り込むための回復区間に含める。
    return this.isDrainTrackingEnabled();
  }

  private persistGatewaySequence(sequence: number): void {
    if (Number.isSafeInteger(sequence) && sequence >= 0) {
      this.setState("gateway_last_sequence", String(sequence));
    }
  }

  private gatewaySequence(): number | null {
    const raw = this.getState("gateway_last_sequence");
    if (raw === null || raw === "") {
      return null;
    }
    const sequence = Number(raw);
    return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : null;
  }

  private gatewayLastSeenAt(): number | null {
    const candidates = ["gateway_last_dispatch_at", "gateway_heartbeat_ack_at"]
      .map((key) => Number(this.getState(key)))
      .filter((value) => Number.isFinite(value) && value > 0);
    if (candidates.length === 0) {
      return null;
    }
    return Math.min(Math.max(...candidates), Date.now());
  }

  private beginGatewayGap(startAt?: number): void {
    const drainActive = this.gatewayDrainIsActive();
    if (!this.isMetricsTrackingActive() && !drainActive) {
      return;
    }
    if (!this.getState("gateway_gap_started_at")) {
      const now = Date.now();
      const persistedLastSeen = this.gatewayLastSeenAt();
      const effectiveStart = startAt === undefined ? persistedLastSeen ?? now : startAt;
      const normalizedStart = Number.isFinite(effectiveStart)
        ? Math.min(Math.max(effectiveStart, 0), now)
        : now;
      this.setState("gateway_gap_started_at", String(normalizedStart));
      this.clearVoiceReplayStates();
      console.warn("Discord Gateway connection interrupted; attempting RESUME");
    }
    this.setState("gateway_state", "reconnecting");
    this.setState("gateway_connected", "0");
    this.setState("gateway_recovery_pending", "1");
    this.setState("voice_replay_mode", "1");
    const sessionId = this.getState("gateway_session_id");
    const sequence = this.gatewaySequence();
    if (!this.gatewayIdentifyOnly && sessionId && sequence !== null) {
      this.setState("gateway_resume_pending", "1");
    }
  }

  private markGatewayGapPartial(endAt: number, reidentify: boolean): void {
    const dateJst = this.getState("date_jst");
    const startAt = Number(this.getState("gateway_gap_started_at"));
    if (!dateJst || !Number.isFinite(startAt)) {
      if (reidentify) {
        this.setState("legacy_integrity_recovery_pending", "0");
        this.addPartialMask("message_partial_mask", FULL_ACTIVITY_BUCKET_MASK);
        this.addPartialMask("voice_partial_mask", FULL_ACTIVITY_BUCKET_MASK);
        this.markIntegrityPartial("message");
        this.markIntegrityPartial("usage");
        this.markIntegrityPartial("voice");
      }
      return;
    }

    const mask = activityBucketMaskBetween(dateJst, startAt, endAt);
    if (reidentify && mask !== 0) {
      // 旧版の不明なdegradedに加えて、新コード上でも回収不能なgapが
      // 確定した場合は、その既知の欠測を後続RESUMEDで消さない。
      this.setState("legacy_integrity_recovery_pending", "0");
      this.addPartialMask("message_partial_mask", mask);
      this.markIntegrityPartial("message");
      this.markIntegrityPartial("usage");
      console.warn("Discord Gateway RESUME failed; affected message and visitor metrics are partial");
    }
    this.addPartialMask("voice_partial_mask", mask);
    if (mask !== 0) {
      this.markIntegrityPartial("voice");
      console.warn("Discord Gateway gap overlaps voice buckets; voice metrics are partial");
    }
    this.syncLegacyMetricsIntegrity();
  }

  private reconcileVoiceReplay(
    dateJst: string,
    reconciledAt: number,
    snapshotComplete: boolean,
  ): void {
    if (this.getState("voice_replay_mode") !== "1") {
      return;
    }
    const gapStartedAt = Number(this.getState("gateway_gap_started_at"));
    const conservativeEnd = Number.isFinite(gapStartedAt)
      ? Math.min(gapStartedAt, reconciledAt)
      : reconciledAt;
    const replayStates = this.rows<VoiceReplayState>(
      "SELECT user_id, date_jst, channel_id, muted FROM voice_replay_states WHERE date_jst = ?",
      dateJst,
    );
    const stateByUser = new Map(replayStates.map((state) => [state.user_id, state] as const));
    const active = this.rows<ActiveVoiceSession>(
      `SELECT user_id, date_jst, channel_id, segment_started_at, muted
       FROM active_voice_sessions WHERE date_jst = ?`,
      dateJst,
    );
    const activeByUser = new Map(active.map((session) => [session.user_id, session] as const));

    this.ctx.storage.transactionSync(() => {
      for (const state of replayStates) {
        const current = activeByUser.get(state.user_id);
        const nextChannel = state.channel_id
          ? this.registeredChannels().find((channel) => channel.channel_id === state.channel_id)
          : undefined;
        const nextIsManagedVoice = Boolean(nextChannel && this.isVoiceKind(nextChannel.kind));
        const changed = Boolean(
          current &&
          (current.channel_id !== state.channel_id || current.muted !== state.muted),
        );

        if (current && (!nextIsManagedVoice || changed)) {
          this.recordVoiceInterval({
            userId: state.user_id,
            startedAt: current.segment_started_at,
            endedAt: conservativeEnd,
            muted: current.muted === 1,
          }, dateJst);
          this.deleteActiveSession(state.user_id);
          activeByUser.delete(state.user_id);
        }

        if (nextIsManagedVoice) {
          this.markDailyUsage(dateJst, state.user_id);
          if (!current || changed) {
            this.ctx.storage.sql.exec(
              `INSERT OR REPLACE INTO active_voice_sessions
               (user_id, date_jst, channel_id, segment_started_at, muted)
               VALUES (?, ?, ?, ?, ?)`,
              state.user_id,
              dateJst,
              state.channel_id,
              reconciledAt,
              state.muted,
            );
          }
        }
      }

      if (snapshotComplete) {
        for (const session of activeByUser.values()) {
          if (stateByUser.has(session.user_id)) {
            continue;
          }
          this.recordVoiceInterval({
            userId: session.user_id,
            startedAt: session.segment_started_at,
            endedAt: conservativeEnd,
            muted: session.muted === 1,
          }, dateJst);
          this.deleteActiveSession(session.user_id);
        }
      }
      this.clearVoiceReplayStates();
    });
  }

  private finalizeUnresolvedGatewayGap(dateJst: string, cutoff: number): void {
    this.markGatewayGapPartial(cutoff, true);
    const gapStartedAt = Number(this.getState("gateway_gap_started_at"));
    const conservativeEnd = Number.isFinite(gapStartedAt)
      ? Math.min(gapStartedAt, cutoff)
      : cutoff;
    const active = this.rows<ActiveVoiceSession>(
      `SELECT user_id, date_jst, channel_id, segment_started_at, muted
       FROM active_voice_sessions WHERE date_jst = ?`,
      dateJst,
    );
    this.ctx.storage.transactionSync(() => {
      for (const session of active) {
        this.recordVoiceInterval({
          userId: session.user_id,
          startedAt: session.segment_started_at,
          endedAt: conservativeEnd,
          muted: session.muted === 1,
        }, dateJst);
        this.deleteActiveSession(session.user_id);
      }
      this.clearVoiceReplayStates();
    });
    this.setState("gateway_gap_started_at", "");
    this.setState("gateway_recovery_pending", "0");
    this.setState("voice_replay_mode", "0");
    this.setState("voice_replay_snapshot_required", "0");
  }

  private healthPayload(): Record<string, unknown> {
    const registered = this.registeredChannels();
    const phase = this.getPhase();
    const messageIntegrity = this.getIntegrity("message_integrity");
    const usageIntegrity = this.getIntegrity("usage_integrity");
    const voiceIntegrity = this.getIntegrity("voice_integrity");
    const messagePartialMask = this.partialMask("message_partial_mask");
    const voicePartialMask = this.partialMask("voice_partial_mask");
    const overallIntegrity = messageIntegrity === "complete" &&
      usageIntegrity === "complete" &&
      voiceIntegrity === "complete" &&
      messagePartialMask === 0 &&
      voicePartialMask === 0
      ? "complete"
      : "degraded";
    const reconnecting = this.getState("gateway_state") === "reconnecting" ||
      Boolean(this.getState("gateway_gap_started_at"));
    const resumePending = this.getState("gateway_resume_pending") === "1";
    const roleSyncStatus = this.getState("role_sync_status") || "unknown";
    const stable = phase === "CLOSED" ||
      ((phase === "SEPARATED" || phase === "ALL_OPEN") &&
        registered.length === EXPECTED_CHANNEL_COUNT &&
        this.isGatewayConnected());
    const closedStateIsReady = phase !== "CLOSED" ||
      (roleSyncStatus === "complete" && this.roleQueueCount() === 0);
    return {
      // OPENING/CLOSING/REPORTING/ROLE_SYNC中や、チャンネル数・Gatewayが
      // 不完全な状態を200として返すと、監視側が障害を見逃してしまう。
      ok: phase !== "BLOCKED" &&
        overallIntegrity === "complete" &&
        stable &&
        closedStateIsReady &&
        roleSyncStatus !== "failed",
      phase,
      dateJst: this.getState("date_jst") ?? null,
      gateway: {
        connected: this.isGatewayConnected(),
        reconnecting,
        resumePending,
        integrity: overallIntegrity,
      },
      integrity: {
        message: messageIntegrity,
        usage: usageIntegrity,
        voice: voiceIntegrity,
      },
      partialBuckets: {
        messageMask: messagePartialMask,
        voiceMask: voicePartialMask,
      },
      channels: {
        expected: EXPECTED_CHANNEL_COUNT,
        registered: registered.length,
      },
      roleSync: {
        status: roleSyncStatus,
      },
    };
  }

  private previousRoleSyncIsComplete(): boolean {
    const roleStatus = this.getState("role_sync_status");
    const queueCount = this.roleQueueCount();
    if (roleStatus === "failed") {
      return true;
    }
    if (roleStatus === null) {
      return queueCount === 0;
    }
    return roleStatus === "complete" &&
      this.getState("role_sync_complete") !== "0" &&
      queueCount === 0;
  }

  private roleSyncIsReadyForClose(): boolean {
    const roleStatus = this.getState("role_sync_status");
    return roleStatus === "complete" || roleStatus === "failed";
  }

  private reportsAreComplete(): boolean {
    return this.getState("report_sent") === "1" && this.getState("detail_report_sent") === "1";
  }

  private isTrackingPhase(): boolean {
    return TRACKING_PHASES.has(this.getPhase());
  }

  private isActivityTrackingEnabled(): boolean {
    return this.isTrackingPhase() &&
      (this.getPhase() !== "OPENING" || this.getState("opening_cleanup_done") === "1");
  }

  private isMetricsTrackingActive(): boolean {
    return this.isActivityTrackingEnabled() &&
      (this.getPhase() !== "OPENING" || this.getState("normal_channels_public") === "1");
  }

  private isGatewayConnected(): boolean {
    return this.getState("gateway_connected") === "1" &&
      this.gatewaySocket?.readyState === WebSocket.OPEN;
  }

  private getPhase(): Phase {
    return (this.getState("phase") as Phase | null) ?? INITIAL_PHASE;
  }

  private registeredChannels(): StoredChannel[] {
    return this.rows<StoredChannel>(
      "SELECT channel_id, name, kind, date_jst FROM managed_channels ORDER BY channel_id",
    );
  }

  private firstRegistered(kind: ManagedChannelKind): StoredChannel | undefined {
    return this.registeredChannels().find((channel) => channel.kind === kind);
  }

  private registerManagedChannel(
    channelId: string,
    name: string,
    kind: ManagedChannelKind,
    dateJst: string,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO managed_channels (channel_id, name, kind, date_jst)
       VALUES (?, ?, ?, ?)`,
      channelId,
      name,
      kind,
      dateJst,
    );
  }

  private clearManagedChannels(): void {
    this.ctx.storage.sql.exec("DELETE FROM managed_channels");
  }

  private activeVoiceSession(userId: string): ActiveVoiceSession | undefined {
    return this.rows<ActiveVoiceSession>(
      `SELECT user_id, date_jst, channel_id, segment_started_at, muted
       FROM active_voice_sessions WHERE user_id = ?`,
      userId,
    )[0];
  }

  private deleteActiveSession(userId: string): void {
    this.ctx.storage.sql.exec("DELETE FROM active_voice_sessions WHERE user_id = ?", userId);
  }

  private deleteActiveSessions(dateJst: string): void {
    this.ctx.storage.sql.exec("DELETE FROM active_voice_sessions WHERE date_jst = ?", dateJst);
  }

  private flushActiveVoiceSessions(dateJst: string, cutoff: number): void {
    const active = this.rows<ActiveVoiceSession>(
      `SELECT user_id, date_jst, channel_id, segment_started_at, muted
       FROM active_voice_sessions WHERE date_jst = ?`,
      dateJst,
    );
    for (const session of active) {
      this.ctx.storage.transactionSync(() => {
        this.recordVoiceInterval({
          userId: session.user_id,
          startedAt: session.segment_started_at,
          endedAt: cutoff,
          muted: session.muted === 1,
        }, dateJst);
        // 区間の保存と削除を同じトランザクションにして、再試行時の
        // 二重加算を防ぐ。利用者単位で確定するため途中失敗にも強い。
        this.deleteActiveSession(session.user_id);
      });
    }
    this.deleteActiveSessions(dateJst);
  }

  private recordVoiceInterval(interval: VoiceInterval, dateJst: string): void {
    for (const segment of splitVoiceInterval(dateJst, interval)) {
      const duration = Math.max(0, segment.endedAt - segment.startedAt);
      if (duration === 0) {
        continue;
      }
      this.ctx.storage.sql.exec(
        `INSERT INTO voice_buckets
         (date_jst, bucket_index, total_voice_ms, muted_voice_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(date_jst, bucket_index) DO UPDATE SET
           total_voice_ms = total_voice_ms + excluded.total_voice_ms,
           muted_voice_ms = muted_voice_ms + excluded.muted_voice_ms`,
        dateJst,
        segment.bucketIndex,
        duration,
        segment.muted ? duration : 0,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO voice_bucket_users (date_jst, bucket_index, user_id)
         VALUES (?, ?, ?)`,
        dateJst,
        segment.bucketIndex,
        interval.userId,
      );
      if (segment.muted) {
        this.ctx.storage.sql.exec(
          `INSERT OR IGNORE INTO voice_bucket_muted_users
           (date_jst, bucket_index, user_id)
           VALUES (?, ?, ?)`,
          dateJst,
          segment.bucketIndex,
          interval.userId,
        );
      }
    }
  }

  private activityBuckets(dateJst: string): ActivityBucket[] {
    const voiceRows = this.rows<{
      bucket_index: number;
      total_voice_ms: number;
      muted_voice_ms: number;
      unique_users: number;
      muted_users: number;
    }>(
      `SELECT b.bucket_index, b.total_voice_ms, b.muted_voice_ms,
              COUNT(DISTINCT u.user_id) AS unique_users,
              COUNT(DISTINCT m.user_id) AS muted_users
       FROM voice_buckets b
       LEFT JOIN voice_bucket_users u
         ON u.date_jst = b.date_jst AND u.bucket_index = b.bucket_index
       LEFT JOIN voice_bucket_muted_users m
         ON m.date_jst = b.date_jst AND m.bucket_index = b.bucket_index
       WHERE b.date_jst = ?
       GROUP BY b.bucket_index, b.total_voice_ms, b.muted_voice_ms
       ORDER BY b.bucket_index`,
      dateJst,
    );
    const messageRows = this.rows<{ bucket_index: number; message_count: number }>(
      `SELECT bucket_index, message_count
       FROM message_buckets
       WHERE date_jst = ?
       ORDER BY bucket_index`,
      dateJst,
    );
    const voiceByIndex = new Map(voiceRows.map((row) => [Number(row.bucket_index), row] as const));
    const messageByIndex = new Map(
      messageRows.map((row) => [Number(row.bucket_index), Number(row.message_count)] as const),
    );

    return Array.from({ length: ACTIVITY_BUCKET_COUNT }, (_, index) => {
      const row = voiceByIndex.get(index);
      return {
        index,
        totalVoiceMs: Number(row?.total_voice_ms ?? 0),
        mutedVoiceMs: Number(row?.muted_voice_ms ?? 0),
        uniqueUsers: Number(row?.unique_users ?? 0),
        mutedUsers: Number(row?.muted_users ?? 0),
        messageCount: messageByIndex.get(index) ?? 0,
      };
    });
  }

  private deleteAnonymousActivity(dateJst: string): void {
    this.ctx.storage.sql.exec("DELETE FROM message_buckets WHERE date_jst = ?", dateJst);
    this.ctx.storage.sql.exec("DELETE FROM voice_bucket_muted_users WHERE date_jst = ?", dateJst);
    this.ctx.storage.sql.exec("DELETE FROM voice_bucket_users WHERE date_jst = ?", dateJst);
    this.ctx.storage.sql.exec("DELETE FROM voice_buckets WHERE date_jst = ?", dateJst);
    this.ctx.storage.sql.exec("DELETE FROM voice_replay_states WHERE date_jst = ?", dateJst);
  }

  private markDailyUsage(dateJst: string | null, userId: string): void {
    if (!dateJst) {
      return;
    }
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO daily_usage (date_jst, user_id) VALUES (?, ?)",
      dateJst,
      userId,
    );
  }

  private countDailyUsage(dateJst: string): number {
    const row = this.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM daily_usage WHERE date_jst = ?",
      dateJst,
    )[0];
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid daily usage aggregate");
    }
    return count;
  }

  private countMessageBuckets(dateJst: string): number {
    const row = this.rows<{ count: number }>(
      `SELECT COALESCE(SUM(message_count), 0) AS count
       FROM message_buckets WHERE date_jst = ?`,
      dateJst,
    )[0];
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("Invalid message aggregate");
    }
    return count;
  }

  private deleteDailyUsage(dateJst: string): void {
    this.ctx.storage.sql.exec("DELETE FROM daily_usage WHERE date_jst = ?", dateJst);
  }

  private clearVoiceReplayStates(): void {
    this.ctx.storage.sql.exec("DELETE FROM voice_replay_states");
  }

  private getIntegrity(key: string): "complete" | "partial" {
    return this.getState(key) === "partial" ? "partial" : "complete";
  }

  private partialMask(key: string): number {
    const raw = Number(this.getState(key) ?? "0");
    if (!Number.isSafeInteger(raw) || raw < 0) {
      return 0;
    }
    return raw & FULL_ACTIVITY_BUCKET_MASK;
  }

  private addPartialMask(key: string, mask: number): void {
    if (!mask) {
      return;
    }
    this.setState(key, String(this.partialMask(key) | (mask & FULL_ACTIVITY_BUCKET_MASK)));
  }

  private markIntegrityPartial(kind: "message" | "usage" | "voice"): void {
    if (
      (kind === "message" || kind === "usage") &&
      this.getState("legacy_integrity_recovery_pending") === "1"
    ) {
      // 旧版由来のflagを回復できるのは、その後に新しい既知欠測が
      // 発生していない場合だけに限定する。
      this.setState("legacy_integrity_recovery_pending", "0");
    }
    this.setState(`${kind}_integrity`, "partial");
    this.syncLegacyMetricsIntegrity();
  }

  private markAllActivityPartial(): void {
    this.addPartialMask("message_partial_mask", FULL_ACTIVITY_BUCKET_MASK);
    this.addPartialMask("voice_partial_mask", FULL_ACTIVITY_BUCKET_MASK);
    this.markIntegrityPartial("message");
    this.markIntegrityPartial("usage");
    this.markIntegrityPartial("voice");
  }

  private syncLegacyMetricsIntegrity(): void {
    const complete = this.getIntegrity("message_integrity") === "complete" &&
      this.getIntegrity("usage_integrity") === "complete" &&
      this.getIntegrity("voice_integrity") === "complete";
    this.setState("metrics_integrity", complete ? "complete" : "degraded");
  }

  private roleQueueCount(): number {
    const row = this.rows<{ count: number }>(
      "SELECT COUNT(*) AS count FROM role_sync_queue",
    )[0];
    return Number(row?.count ?? 0);
  }

  private rows<T>(query: string, ...bindings: unknown[]): T[] {
    return this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue>>(query, ...bindings)
      .toArray() as T[];
  }

  private getState(key: string): string | null {
    const row = this.rows<{ value: string }>(
      "SELECT value FROM service_state WHERE key = ?",
      key,
    )[0];
    return row?.value ?? null;
  }

  private setState(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO service_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private ensureSchema(): void {
    if (this.schemaInitialized) {
      return;
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS service_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS managed_channels (
        channel_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        date_jst TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS daily_usage (
        date_jst TEXT NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (date_jst, user_id)
      );
      CREATE TABLE IF NOT EXISTS active_voice_sessions (
        user_id TEXT PRIMARY KEY,
        date_jst TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        segment_started_at INTEGER NOT NULL,
        muted INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS voice_buckets (
        date_jst TEXT NOT NULL,
        bucket_index INTEGER NOT NULL,
        total_voice_ms INTEGER NOT NULL DEFAULT 0,
        muted_voice_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date_jst, bucket_index)
      );
      CREATE TABLE IF NOT EXISTS voice_bucket_users (
        date_jst TEXT NOT NULL,
        bucket_index INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (date_jst, bucket_index, user_id)
      );
      CREATE TABLE IF NOT EXISTS voice_bucket_muted_users (
        date_jst TEXT NOT NULL,
        bucket_index INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        PRIMARY KEY (date_jst, bucket_index, user_id)
      );
      CREATE TABLE IF NOT EXISTS message_buckets (
        date_jst TEXT NOT NULL,
        bucket_index INTEGER NOT NULL,
        message_count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date_jst, bucket_index)
      );
      CREATE TABLE IF NOT EXISTS deep_role_members (
        user_id TEXT PRIMARY KEY
      );
      CREATE TABLE IF NOT EXISTS role_sync_queue (
        user_id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('add', 'remove'))
      );
      CREATE TABLE IF NOT EXISTS voice_replay_states (
        user_id TEXT PRIMARY KEY,
        date_jst TEXT NOT NULL,
        channel_id TEXT,
        muted INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_delete_queue (
        channel_id TEXT PRIMARY KEY
      );
    `);
    const storedMessageIntegrity = this.getState("message_integrity");
    const storedUsageIntegrity = this.getState("usage_integrity");
    const storedVoiceIntegrity = this.getState("voice_integrity");
    const storedMessageMask = this.getState("message_partial_mask");
    const storedVoiceMask = this.getState("voice_partial_mask");
    const migrationVersion = this.getState("integrity_migration_version");

    if (this.getState("phase") === null) {
      this.setState("phase", INITIAL_PHASE);
    }
    if (this.getState("metrics_integrity") === null) {
      this.setState("metrics_integrity", "complete");
    }
    const legacyDegraded = this.getState("metrics_integrity") === "degraded";
    const legacyDegradedState = legacyDegraded && migrationVersion === null && (
      (storedMessageIntegrity === null && storedUsageIntegrity === null &&
        storedVoiceIntegrity === null && storedMessageMask === null && storedVoiceMask === null) ||
      (storedMessageIntegrity === "partial" && storedUsageIntegrity === "partial" &&
        storedVoiceIntegrity === "partial" && storedMessageMask === String(FULL_ACTIVITY_BUCKET_MASK) &&
        storedVoiceMask === String(FULL_ACTIVITY_BUCKET_MASK))
    );
    if (legacyDegradedState) {
      // 旧版の単一flagを最初のbucket対応版が全16枠へ展開した状態を識別する。
      // RESUMEDならDiscord replayでmessage/visitorを回復できるが、旧版では
      // voiceのgap時刻を保存していないためvoice側の保守的なpartialは残す。
      this.setState("legacy_integrity_recovery_pending", "1");
    } else if (this.getState("legacy_integrity_recovery_pending") === null) {
      this.setState("legacy_integrity_recovery_pending", "0");
    }
    if (this.getState("message_integrity") === null) {
      this.setState("message_integrity", legacyDegraded ? "partial" : "complete");
    }
    if (this.getState("usage_integrity") === null) {
      this.setState("usage_integrity", legacyDegraded ? "partial" : "complete");
    }
    if (this.getState("voice_integrity") === null) {
      this.setState("voice_integrity", legacyDegraded ? "partial" : "complete");
    }
    if (this.getState("message_partial_mask") === null) {
      this.setState("message_partial_mask", legacyDegraded ? String(FULL_ACTIVITY_BUCKET_MASK) : "0");
    }
    if (this.getState("voice_partial_mask") === null) {
      this.setState("voice_partial_mask", legacyDegraded ? String(FULL_ACTIVITY_BUCKET_MASK) : "0");
    }
    if (this.getState("gateway_state") === null) {
      this.setState(
        "gateway_state",
        this.getState("gateway_connected") === "1" ? "connected" : "closed",
      );
    }
    if (this.getState("gateway_reconnect_attempts") === null) {
      this.setState("gateway_reconnect_attempts", "0");
    }
    if (this.getState("voice_replay_mode") === null) {
      this.setState("voice_replay_mode", "0");
    }
    if (this.getState("voice_replay_snapshot_required") === null) {
      this.setState("voice_replay_snapshot_required", "0");
    }
    if (this.getState("gateway_recovery_pending") === null) {
      this.setState("gateway_recovery_pending", "0");
    }
    if (this.getState("role_sync_status") === null) {
      this.setState("role_sync_status", "complete");
    }
    if (this.getState("role_sync_complete") === null) {
      this.setState("role_sync_complete", "1");
    }
    if (migrationVersion === null) {
      this.setState("integrity_migration_version", "1");
    }

    this.schemaInitialized = true;
  }

  private recoverLegacyMessageIntegrityAfterResume(): void {
    if (this.getState("legacy_integrity_recovery_pending") !== "1") {
      return;
    }
    // 旧版の単一degraded flagには欠測のbucket情報がなく、RESUME成功後も
    // message/visitorを全日partialのまま残していた。Discord replayの完了を
    // 確認できた場合だけこの旧flag由来の不確実性を解除する。
    this.setState("message_integrity", "complete");
    this.setState("usage_integrity", "complete");
    this.setState("message_partial_mask", "0");
    this.setState("legacy_integrity_recovery_pending", "0");
    this.syncLegacyMetricsIntegrity();
  }

  private recoverGatewayIfNeeded(): void {
    // DOが再生成され、永続stateだけがgateway_connected=1のまま残った
    // 場合は、in-memory socketの消失をGateway gapとして扱う。schema初期化の
    // blockConcurrencyWhile内では外部I/OやAlarm操作を始めず、最初のイベント
    // を受けてから復旧をスケジュールする。
    if (
      (this.isTrackingPhase() || this.gatewayDrainIsActive()) &&
      this.getState("gateway_connected") === "1" &&
      !this.gatewaySocket
    ) {
      this.beginGatewayGap(this.gatewayLastSeenAt() ?? Date.now());
      this.ctx.waitUntil(this.scheduleGatewayReconnect().catch((error) => {
        this.logOperationError("gateway recovery schedule", error);
      }));
    }
  }

  private logOperationError(operation: string, error: unknown): void {
    if (error instanceof DiscordRateLimitError) {
      console.error(`${operation} is rate limited; retry scheduled by Durable Object Alarm`);
      return;
    }
    if (error instanceof DiscordApiError) {
      console.error(
        `${operation} Discord API error (${error.status}) ${error.method} ${error.path}`,
      );
      return;
    }
    console.error(`${operation} failed`);
  }

  private logChannelDeleteError(channelId: string, error: unknown): void {
    if (error instanceof DiscordApiError) {
      console.error(
        `channel delete failed (${error.status}) ${error.method} ${error.path}`,
      );
      return;
    }
    console.error(`channel delete failed for ${channelId}`);
  }

  private logReportError(kind: string, error: unknown): void {
    if (error instanceof DiscordRateLimitError) {
      console.error(`${kind} report is rate limited; retry scheduled`);
    } else if (error instanceof DiscordApiError) {
      console.error(
        `${kind} report Discord API error (${error.status}) ${error.method} ${error.path}`,
      );
    } else {
      console.error(`${kind} report failed`);
    }
  }

  private logRoleSyncError(action: string, error: unknown): void {
    if (error instanceof DiscordRateLimitError) {
      console.error(`role ${action} is rate limited; retry scheduled`);
    } else if (error instanceof DiscordApiError) {
      console.error(
        `role ${action} Discord API error (${error.status}) ${error.method} ${error.path}`,
      );
    } else {
      console.error(`role ${action} failed; the queue is retained`);
    }
  }

  private logGatewayError(_error: unknown): void {
    console.error("Discord Gateway processing failed; reconnect handling is pending");
  }

  private isVoiceKind(kind: ManagedChannelKind): boolean {
    return kind === "normal_voice" || kind === "deep_voice";
  }

}
