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
  buildDetailReport,
  buildMessageCountLog,
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

const INITIAL_PHASE: Phase = "CLOSED";
const ACTIVE_PHASES = new Set<Phase>(["OPENING", "SEPARATED", "ALL_OPEN"]);
const TRACKING_PHASES = new Set<Phase>(["OPENING", "SEPARATED", "ALL_OPEN"]);
const GATEWAY_CLOSE_CODE = 1000;
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

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json(this.healthPayload());
    }

    if (request.method === "POST" && url.pathname === "/operation") {
      let body: { operation?: string; scheduledTime?: number } = {};
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
      }

      const operation = body.operation;
      if (operation !== "open" && operation !== "open_deep" && operation !== "close") {
        return Response.json({ ok: false, error: "Invalid operation" }, { status: 400 });
      }

      // Cron側へ202をすぐ返しつつ、Durable Objectの実行コンテキストが
      // 外部I/O完了前に終了しないようwaitUntilへ登録する。
      const operationPromise = this.runOperation(
        operation,
        body.scheduledTime ?? Date.now(),
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
    if (!retryingCurrentOpening) {
      // A new night starts a fresh Gateway session. Resume is for a
      // disconnect during the same night, not for yesterday's closed session.
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_session_id", "");
      this.setState("gateway_resume_url", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    }
    this.setState("message_count", "0");
    this.setState("message_count_available", "0");
    this.setState("announcement_sent", "0");
    this.setState("deep_announcement_sent", "0");
    this.setState("visitor_count", "0");
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

      const firstText = this.firstRegistered("normal_text");
      const firstDeepText = this.firstRegistered("deep_text");
      if (!firstText || !firstDeepText) {
        throw new Error("Required announcement text channels were not registered");
      }

      // The Gateway is READY before this call, so both bot-generated
      // announcements are counted by MESSAGE_CREATE without reading history.
      // Each flag makes a partial retry idempotent: a successful normal
      // announcement is not posted again when the deep one is retried.
      if (this.getState("announcement_sent") !== "1") {
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
      if (this.getState("deep_announcement_sent") !== "1") {
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
          rollbackComplete = await this.deleteChannels(created);
        } catch (rollbackError) {
          this.logOperationError("opening rollback", rollbackError);
        }
        if (rollbackComplete) {
          this.clearManagedChannels();
        }
        // 作成途中に届いた告知・投稿・通話イベントは、ロールバックした
        // チャンネルの履歴なので、次の作成試行へ持ち越さない。
        this.setState("message_count", "0");
        this.setState(
          "message_count_available",
          this.getState("metrics_integrity") === "degraded" || !this.isGatewayConnected()
            ? "0"
            : "1",
        );
        this.setState("visitor_count", "0");
        this.deleteDailyUsage(dateJst);
        this.deleteAnonymousActivity(dateJst);
        this.deleteActiveSessions(dateJst);
        this.setState("announcement_sent", "0");
        this.setState("deep_announcement_sent", "0");
        this.setState("opening_cleanup_done", "0");
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
      await putChannelPermission(
        this.env,
        channel.channel_id,
        buildDeepPublicOverwrite(this.env.DISCORD_GUILD_ID),
      );
    }
    this.setState("phase", "ALL_OPEN");
    this.setState("pending_operation", "");
    await this.scheduleGatewayWatchdog();
  }

  private async beginClose(dateJst: string): Promise<void> {
    const phase = this.getPhase();
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

    if (phase === "CLOSED" && this.getState("date_jst") !== dateJst) {
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
      this.flushActiveVoiceSessions(dateJst, cutoff);
      this.setState("visitor_count", String(this.countDailyUsage(dateJst)));
      this.setState("close_stage", "lock");
    }

    if (this.getState("close_stage") === "lock") {
      await this.lockRegisteredChannels(dateJst);
      this.setState("close_stage", "gateway");
      // 1回のAlarmで権限変更・削除・レポート・ロール同期まで連続実行
      // すると、Workers Freeのsubrequest上限を超える。段階ごとに返す。
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (this.getState("close_stage") === "gateway") {
      this.closeGateway();
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

  private async sendReportsInternal(dateJst: string): Promise<void> {
    const rawMessageCount = Number(this.getState("message_count") ?? "0");
    const rawVisitorCount = Number(this.getState("visitor_count") ?? "0");
    const messageCount = Number.isSafeInteger(rawMessageCount) && rawMessageCount >= 0
      ? rawMessageCount
      : 0;
    const visitorCount = Number.isSafeInteger(rawVisitorCount) && rawVisitorCount >= 0
      ? rawVisitorCount
      : 0;
    if (messageCount !== rawMessageCount || visitorCount !== rawVisitorCount) {
      this.markGatewayDegraded();
    }
    const buckets = this.activityBuckets(dateJst);
    const bustle = weightedBustleSeconds(buckets);

    if (this.getState("report_sent") !== "1") {
      try {
        const summary = this.getState("message_count_available") === "1"
          ? buildMessageCountLog(messageCount, visitorCount, bustle)
          : "今日もお疲れ様でした！おはようございます！";
        await createTextMessage(
          this.env,
          MESSAGE_LOG_CHANNEL_ID,
          summary,
          { nonce: `summary-${dateJst}` },
        );
        this.setState("report_sent", "1");
      } catch (error) {
        this.logReportError("summary", error);
        await this.scheduleRetry("report", error);
      }
    }

    if (this.getState("detail_report_sent") !== "1") {
      try {
        await createTextMessage(
          this.env,
          this.env.DISCORD_ACTIVITY_DETAIL_CHANNEL_ID,
          buildDetailReport(
            dateJst,
            buckets,
            this.getState("message_count_available") === "1",
          ),
          { nonce: `detail-${dateJst}` },
        );
        this.setState("detail_report_sent", "1");
      } catch (error) {
        this.logReportError("detail", error);
        await this.scheduleRetry("detail_report", error);
      }
    }
  }

  private prepareRoleSync(dateJst: string): void {
    if (this.getState("role_queue_initialized") === "1") {
      return;
    }

    // 前日の権限エラーで残った古いキューを、当日の利用状況から
    // 再構築する。成功済みのdeep_role_membersだけを基準にするため、
    // staleなユーザーIDや古い日付の操作を持ち越さない。
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
    const degraded = this.getState("metrics_integrity") === "degraded";

    for (const userId of detectedSet) {
      if (!currentSet.has(userId)) {
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'add')",
          userId,
        );
      }
    }

    if (!degraded) {
      for (const userId of currentSet) {
        if (!detectedSet.has(userId)) {
          this.ctx.storage.sql.exec(
            "INSERT OR REPLACE INTO role_sync_queue (user_id, action) VALUES (?, 'remove')",
            userId,
          );
        }
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
      this.deleteDailyUsage(dateJst);
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
          this.deleteDailyUsage(dateJst);
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
    this.deleteDailyUsage(dateJst);
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
    await this.scheduleAlarmAt(Date.now() + 300_000);
  }

  private clearDailyEphemeralState(): void {
    const placeholders = DAILY_EPHEMERAL_STATE_KEYS.map(() => "?").join(", ");
    this.ctx.storage.sql.exec(
      `DELETE FROM service_state WHERE key IN (${placeholders})`,
      ...DAILY_EPHEMERAL_STATE_KEYS,
    );
    // 次の日に持ち越すのは、現在のフェーズとロール同期の完了状態だけにする。
    this.setState("metrics_integrity", "complete");
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

  private enqueueChannelDeletes(channelIds: readonly string[]): void {
    // 無料枠のsubrequest上限を超えないよう、削除対象をSQLiteキューへ積む。
    for (const channelId of channelIds) {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO channel_delete_queue (channel_id) VALUES (?)",
        channelId,
      );
    }
  }

  private async processChannelDeleteQueue(): Promise<boolean> {
    const queue = this.rows<ChannelDeleteQueueItem>(
      `SELECT q.channel_id, m.name AS expected_name, m.kind AS expected_kind
       FROM channel_delete_queue q
       LEFT JOIN managed_channels m ON m.channel_id = q.channel_id
       ORDER BY q.channel_id
       LIMIT ?`,
      MAX_CHANNEL_DELETE_OPERATIONS_PER_ALARM,
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
        if (Number.isFinite(startedAt) && Date.now() - startedAt < 60_000) {
          return;
        }
        // The handshake can remain CONNECTING/OPEN forever without a READY.
        // Treat an expired attempt as stale so the watchdog can recover it.
        this.closeGateway();
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
      this.setState("gateway_connect_started_at", String(Date.now()));
      socket.addEventListener("message", (event) => {
        // Durable ObjectのWebSocketイベントではwaitUntilに依存しない。
        // 非同期処理の失敗を必ず捕捉し、Gateway復旧Alarmへつなげる。
        void this.handleGatewayMessage(socket, event.data).catch((error) => {
          this.handleGatewayTaskError(error);
        });
      });
      socket.addEventListener("close", (event) => {
        void this.handleGatewayClose(socket, event.code).catch((error) => {
          this.handleGatewayTaskError(error);
        });
      });
      socket.addEventListener("error", () => {
        // The close event drives the reconnect path. Payloads and error bodies
        // are intentionally not logged.
        try {
          socket.close();
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
    if (this.isTrackingPhase()) {
      this.markGatewayDegraded();
    }
    void this.scheduleRetry("gateway", error).catch((scheduleError) => {
      this.logOperationError("gateway retry", scheduleError);
    });
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
      this.markGatewayDegraded();
      this.logGatewayError(error);
      this.closeGateway();
      await this.scheduleAlarmAt(Date.now() + 1_000);
      return;
    }

    if (typeof envelope.s === "number") {
      this.setState("gateway_last_sequence", String(envelope.s));
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
        this.markGatewayDegraded();
        this.closeGateway();
        await this.scheduleAlarmAt(Date.now() + 1_000);
        return;
      case 9:
        await this.handleInvalidSession(Boolean(envelope.d));
        return;
      case 0:
        await this.handleGatewayDispatch(envelope.t ?? null, envelope.d);
        return;
      default:
        return;
    }
  }

  private handleGatewayHello(hello: GatewayHello): void {
    const interval = Number(hello.heartbeat_interval);
    if (!Number.isFinite(interval) || interval <= 0) {
      this.markGatewayDegraded();
      this.closeGateway();
      void this.scheduleAlarmAt(Date.now() + 1_000).catch((error) => {
        this.logOperationError("gateway hello retry", error);
      });
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
    const sequence = this.getState("gateway_last_sequence");
    if (!this.gatewayIdentifyOnly && sessionId && sequence) {
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
      socket.close(4000, "heartbeat timeout");
      return;
    }

    const sequence = this.getState("gateway_last_sequence");
    this.sendGatewayPayload({ op: 1, d: sequence ? Number(sequence) : null });
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

  private async handleGatewayDispatch(type: string | null, data: unknown): Promise<void> {
    if (type === "READY") {
      const ready = (data ?? {}) as GatewayReady;
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
      const hadGatewayGap = this.getState("gateway_resume_pending") === "1";
      if (hadGatewayGap) {
        this.markGatewayDegraded();
        this.setState("gateway_resume_pending", "0");
      }
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_connect_started_at", "");
      this.setState("gateway_connected", "1");
      this.setState(
        "message_count_available",
        hadGatewayGap || this.getState("metrics_integrity") === "degraded" ? "0" : "1",
      );
      if (!this.getState("metrics_integrity")) {
        this.setState("metrics_integrity", "complete");
      }
      if (this.getPhase() === "OPENING") {
        await this.finishOpen();
      }
      return;
    }

    if (type === "GUILD_CREATE") {
      const guild = (data ?? {}) as GatewayGuildCreate;
      if (guild.id !== this.env.DISCORD_GUILD_ID || !Array.isArray(guild.voice_states)) {
        return;
      }
      // 再接続時は、既に通話中の利用者に対するVOICE_STATE_UPDATEが
      // 改めて届かないことがある。GUILD_CREATEのスナップショットも同じ
      // 匿名セッション処理へ渡し、再接続直後の滞在人数を取りこぼさない。
      for (const state of guild.voice_states) {
        this.handleVoiceState({ ...state, guild_id: guild.id });
      }
      return;
    }

    if (type === "RESUMED") {
      this.gatewayIdentifyOnly = false;
      this.setState("gateway_connect_started_at", "");
      this.setState("gateway_resume_pending", "0");
      this.setState("gateway_connected", "1");
      if (this.getState("metrics_integrity") !== "degraded") {
        this.setState("message_count_available", "1");
      }
      return;
    }

    if (type === "MESSAGE_CREATE") {
      this.handleMessageCreate((data ?? {}) as GatewayMessageCreate);
      return;
    }

    if (type === "VOICE_STATE_UPDATE") {
      this.handleVoiceState((data ?? {}) as GatewayVoiceState);
    }
  }

  private handleMessageCreate(message: GatewayMessageCreate): void {
    if (!this.isActivityTrackingEnabled() || !message.channel_id) {
      return;
    }
    const channel = this.registeredChannels().find(
      (candidate) => candidate.channel_id === message.channel_id &&
        (candidate.kind === "normal_text" || candidate.kind === "deep_text"),
    );
    if (!channel) {
      return;
    }

    const now = Date.now();
    const dateJst = this.getState("date_jst");
    const storedCount = Number(this.getState("message_count") ?? "0");
    const count = Number.isSafeInteger(storedCount) && storedCount >= 0
      ? storedCount
      : 0;
    if (count !== storedCount) {
      // 壊れた状態をNaNとして保存・報告しない。集計の信頼性は落とし、
      // 終了時は件数ではなく挨拶だけを送る既存の保守動作へ切り替える。
      this.markGatewayDegraded();
    }
    const bucketIndex = dateJst === null ? null : activityBucketIndexAt(dateJst, now);
    const author = message.author;
    this.ctx.storage.transactionSync(() => {
      // 総数・内訳・来場者判定を同時に確定し、途中停止でログと詳細内訳が
      // 食い違う状態を作らない。
      this.setState("message_count", String(count + 1));
      if (bucketIndex !== null) {
        this.ctx.storage.sql.exec(
          `INSERT INTO message_buckets (date_jst, bucket_index, message_count)
           VALUES (?, ?, 1)
           ON CONFLICT(date_jst, bucket_index) DO UPDATE SET
             message_count = message_count + 1`,
          dateJst,
          bucketIndex,
        );
      }

      if (author?.id && !author.bot && !author.system) {
        this.markDailyUsage(dateJst, author.id);
      }
    });
  }

  private handleVoiceState(state: GatewayVoiceState): void {
    if (!this.isActivityTrackingEnabled() || state.guild_id !== this.env.DISCORD_GUILD_ID) {
      return;
    }
    const userId = state.user_id;
    if (!userId || state.member?.user?.bot || state.member?.user?.system) {
      return;
    }
    if (userId === this.getState("gateway_bot_user_id")) {
      return;
    }

    const dateJst = this.getState("date_jst");
    if (!dateJst) {
      return;
    }

    const now = Date.now();
    const nextChannelId = typeof state.channel_id === "string" ? state.channel_id : null;
    const nextChannel = nextChannelId
      ? this.registeredChannels().find((channel) => channel.channel_id === nextChannelId)
      : undefined;
    const active = this.activeVoiceSession(userId);
    const nextMuted = !isUnmutedVoiceState(state.self_mute, state.mute);
    const shouldSwitchSession = Boolean(
      active && (active.channel_id !== nextChannelId || active.muted !== Number(nextMuted)),
    );
    const nextIsManagedVoice = Boolean(nextChannel && this.isVoiceKind(nextChannel.kind));
    const shouldRegisterSession = nextIsManagedVoice && (!active || shouldSwitchSession);
    if (!shouldSwitchSession && !shouldRegisterSession) {
      return;
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
    });
  }

  private async handleInvalidSession(canResume: boolean): Promise<void> {
    if (!canResume) {
      this.markGatewayDegraded();
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_session_id", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    }
    this.closeGateway();
    await this.scheduleAlarmAt(Date.now() + (canResume ? 5_000 : 1_000));
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
    const tracking = this.isTrackingPhase();
    if (this.getPhase() === "CLOSED" || this.getPhase() === "BLOCKED") {
      return;
    }
    this.setState("gateway_connected", "0");
    if (tracking) {
      // RESUMEできても切断中の受信時刻・VOICE_STATE_UPDATEを完全には
      // 再構成できないため、その日の集計は保守的にdegradedへ落とす。
      this.markGatewayDegraded();
    }
    if (NON_RESUMABLE_GATEWAY_CODES.has(code)) {
      this.gatewayIdentifyOnly = true;
      this.setState("gateway_session_id", "");
      this.setState("gateway_last_sequence", "");
      this.setState("gateway_resume_pending", "0");
    }
    if (this.getState("gateway_session_id") && this.getState("gateway_last_sequence")) {
      this.setState("gateway_resume_pending", "1");
    }

    if (this.isTrackingPhase()) {
      await this.scheduleAlarmAt(Date.now() + 5_000);
    }
  }

  private closeGateway(): void {
    this.clearHeartbeatTimer();
    this.gatewayAwaitingAck = false;
    const socket = this.gatewaySocket;
    this.gatewaySocket = null;
    this.setState("gateway_connected", "0");
    this.setState("gateway_connect_started_at", "");
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      try {
        socket.close(GATEWAY_CLOSE_CODE, "night window ended");
      } catch {
        // A socket can transition to CLOSED between the state check and close.
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
      this.setState("gateway_watchdog_due", String(Date.now() + 60_000));
      await this.scheduleAlarmAt(Date.now() + 60_000);
    }
  }

  private async scheduleRetry(operation: string, error: unknown): Promise<void> {
    const delay = error instanceof DiscordRateLimitError
      ? Math.max(1_000, error.retryAfterMs)
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
    await this.scheduleAlarmAt(Date.now() + delay);
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

  private healthPayload(): Record<string, unknown> {
    const registered = this.registeredChannels();
    const phase = this.getPhase();
    const integrity = this.getState("metrics_integrity") || "degraded";
    const roleSyncStatus = this.getState("role_sync_status") || "unknown";
    const stable = phase === "CLOSED" ||
      ((phase === "SEPARATED" || phase === "ALL_OPEN") &&
        registered.length === EXPECTED_CHANNEL_COUNT &&
        this.isGatewayConnected());
    return {
      // OPENING/CLOSING/REPORTING/ROLE_SYNC中や、チャンネル数・Gatewayが
      // 不完全な状態を200として返すと、監視側が障害を見逃してしまう。
      ok: phase !== "BLOCKED" && integrity === "complete" && stable && roleSyncStatus !== "failed",
      phase,
      dateJst: this.getState("date_jst") ?? null,
      gateway: {
        connected: this.isGatewayConnected(),
        integrity,
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
    return roleStatus === null ||
      (roleStatus === "complete" && this.getState("role_sync_complete") !== "0" && queueCount === 0);
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
    return Number(row?.count ?? 0);
  }

  private deleteDailyUsage(dateJst: string): void {
    this.ctx.storage.sql.exec("DELETE FROM daily_usage WHERE date_jst = ?", dateJst);
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
      CREATE TABLE IF NOT EXISTS channel_delete_queue (
        channel_id TEXT PRIMARY KEY
      );
    `);
    if (this.getState("phase") === null) {
      this.setState("phase", INITIAL_PHASE);
    }
    if (this.getState("metrics_integrity") === null) {
      this.setState("metrics_integrity", "complete");
    }
    if (this.getState("role_sync_status") === null) {
      this.setState("role_sync_status", "complete");
    }
    if (this.getState("role_sync_complete") === null) {
      this.setState("role_sync_complete", "1");
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
    console.error("Discord Gateway processing failed; integrity is degraded or reconnect is pending");
  }

  private markGatewayDegraded(): void {
    this.setState("metrics_integrity", "degraded");
    this.setState("message_count_available", "0");
  }

  private isVoiceKind(kind: ManagedChannelKind): boolean {
    return kind === "normal_voice" || kind === "deep_voice";
  }

}
