# discord-shinya

Cloudflare Workers Free と SQLite-backed Durable Objects Free だけで動く、JST深夜帯のDiscordボットです。VPS、常駐サーバー、外部データベースは使いません。

## 無料枠での構成

有料専用のKV-backed Durable Objects、D1、KV、R2、Queues、Workers AI、外部VPSは使用しません。状態保存はWorkers Freeで利用できるSQLite-backed Durable Objectを1クラスだけ使います。Workers Logsの自動ログもFree枠内の機能です。

処理は無料枠のsubrequest上限を超えにくいように分割しています。

- 1回のチャンネル削除処理は最大20件。残りはDurable Object Alarmで継続します。
- ロール同期も1回最大20件。残りはAlarmで継続します。
- 1回のGateway接続は1本だけです。
- Discordのメッセージ履歴APIや大量並列リクエストは使いません。

Cloudflareの無料枠にはアカウント単位の上限があります。Workersのリクエストは1日100,000件、1回のsubrequestは50件、SQLite-backed Durable Objectsは無料枠で1日100,000リクエスト・書き込み100,000行・読み取り500万行が目安です。SQLiteの無料保存容量は合計5GBです。通常規模の1ギルド運用を想定した構成であり、同じCloudflareアカウントの他Worker利用量や、極端に大量のDiscordイベントがある場合まで無料枠内を保証するものではありません。上限に達した場合はCloudflare側で処理が失敗するため、課金を発生させずに自動継続することはできません。

詳細は[Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)、[Workersの料金](https://developers.cloudflare.com/workers/platform/pricing/)、[Durable Objectsの料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)を参照してください。

## 動作

CronはUTC基準の1本です。

```text
0 15,18,23 * * *
```

- 15:00 UTC（日本時間00:00）: 前日のロール同期完了を確認してから、当日分の10チャンネルを作成します。GatewayのREADY後に作成するため、開始告知の`MESSAGE_CREATE`も件数に入ります。
- 18:00 UTC（日本時間03:00）: 深層4チャンネルだけ`@everyone`の閲覧を許可します。通常6チャンネルの深層ロール拒否は変更しません。
- 23:00 UTC（日本時間08:00）: 新規利用を止め、通話区間を08:00まで集計し、チャンネルを削除してからログ・内訳・ロール同期を再試行可能な形で処理します。

作成されるチャンネルは次の10個です。

```text
深夜限定テキスト1-MM-DD
深夜限定テキスト2-MM-DD
深夜限定テキスト3-MM-DD
深夜限定通話1-MM-DD     上限なし
深夜限定通話2-MM-DD     8人
深夜限定通話3-MM-DD     4人
深層-深夜限定テキスト1-MM-DD
深層-深夜限定テキスト2-MM-DD
深層-深夜限定通話1-MM-DD 上限なし
深層-深夜限定通話2-MM-DD 4人
```

告知は通常テキスト1へ一度だけ投稿します。

```text
@here @設定したロール 今日のチャンネルが作成されました！
```

`allowed_mentions`で`@here`と`DISCORD_MENTION_ROLE_ID`だけを有効にしています。

## 8時のログ

ログ先は既存の固定チャンネル `1543273845257928747` です。

```text
今日のメッセージ数：XX件
今日の来場者数：YY人
賑わい：ZZ
今日もお疲れ様でした！おはようございます！
```

- `XX`: 00:00〜08:00の5つのテキストチャンネルに届いた`MESSAGE_CREATE`数。Botの開始告知も含み、履歴APIは使いません。
- `YY`: テキスト投稿または通話参加をした人の重複なし人数。Botは除外します。
- `ZZ`: 通話の加重秒数。ミュート中を1倍、`self_mute === false && mute === false`だけを2倍として合算し、秒未満を切り捨てます。deaf状態は判定しません。

Gatewayの件数が利用できない（`degraded`）場合は、件数を推測せず、ログ先には挨拶だけを投稿します。この場合もチャンネル削除と再試行可能な状態保存は継続します。

内訳は `DISCORD_ACTIVITY_DETAIL_CHANNEL_ID` へ、個人を特定できない30分単位の1メッセージとして投稿します。

```text
【賑わい内訳 MM/DD】

時間帯 | 滞在人数 | ミュート率
00:00-00:29 | 12人 | 35.2%
...
07:30-07:59 | 2人 | 80.0%
```

メッセージ本文、メッセージID、ユーザー名、表示名、メンション、個人ごとの滞在時間は保存・出力しません。SQLiteには処理に必要な当日ユーザーIDだけを一時保存し、ロール同期成功後に削除します。匿名集計も両レポート送信後に削除します。

## 必要なSecret

`.dev.vars.example` をコピーしてローカル値を設定します。本物の値はコミットしないでください。

```text
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_PARENT_CATEGORY_ID=
DISCORD_MENTION_ROLE_ID=
DISCORD_DEEP_ROLE_ID=
DISCORD_ACTIVITY_DETAIL_CHANNEL_ID=
DRY_RUN=false
```

本番では次のように設定します。入力内容はソースコードへ保存されません。

```powershell
npm.cmd exec wrangler -- secret put DISCORD_BOT_TOKEN
npm.cmd exec wrangler -- secret put DISCORD_GUILD_ID
npm.cmd exec wrangler -- secret put DISCORD_PARENT_CATEGORY_ID
npm.cmd exec wrangler -- secret put DISCORD_MENTION_ROLE_ID
npm.cmd exec wrangler -- secret put DISCORD_DEEP_ROLE_ID
npm.cmd exec wrangler -- secret put DISCORD_ACTIVITY_DETAIL_CHANNEL_ID
```

6つの必須Secretが欠けている場合、`/health`は503になり、Cronは失敗閉じになります。TokenやDiscord APIのレスポンス本文はログに出しません。

## Discord権限

Botには少なくとも次を付与してください。

- View Channels
- Manage Channels
- Send Messages
- Mention Everyone
- Connect / Speak
- Manage Roles（深層ロールを操作するため）

Botのロールは`DISCORD_DEEP_ROLE_ID`のロールより上に置き、Bot自身が親カテゴリと内訳・ログチャンネルを閲覧・送信できるようにしてください。内訳チャンネルは`DISCORD_ACTIVITY_DETAIL_CHANNEL_ID`で指定し、BotのView Channels / Send Messagesを事前に許可します。

深層ロールは、00:00〜03:00は深層4チャンネルだけ閲覧可能、03:00〜08:00は全10チャンネルを閲覧可能です。通常チャンネル側の深層ロール拒否は維持します。管理対象テキストチャンネルでは公開・非公開スレッド作成を拒否します。

Gateway Intentは次の3つだけです。

```text
GUILDS | GUILD_VOICE_STATES | GUILD_MESSAGES = 641
```

`MESSAGE_CONTENT`、`GUILD_MEMBERS`、`PRESENCES`は要求しません。Botのロール同期がDiscord側で実行できるよう、対象ロールの階層も確認してください。

## 安全策と再試行

- 管理対象は指定カテゴリ配下かつ厳密な日付付き名前だけです。カテゴリが違うチャンネルは削除しません。旧形式の単一テキスト・通話名も安全な範囲でクリーンアップ対象にします。
- 00:00はGateway READY前に新規チャンネルを公開しません。作成途中の失敗は作成済み分をロールバックします。
- 08:00の処理はDurable ObjectのSQLiteに段階を保存します。429の`Retry-After`を上限で丸めず、長いsleepをせず、次のDurable Object Alarmへ処理を移します。
- Alarmは1つだけ使い、最も早い期限を保存します。ロール変更は1回最大20件です。
- Gatewayのsession_id、resume_gateway_url、last sequenceを保存し、可能な場合はRESUMEを優先します。RESUME不能時だけIDENTIFYし、その日は`degraded`として既存の深層ロールを一括削除しません。
- 8時の動作テストでDiscordの削除APIを呼ばないよう、`DRY_RUN=true`とローカルテストを使います。本番SecretのCronを手動発火しないでください。

## 既知の制約

- Discordの管理者・Ownerはチャンネル上書きを迂回できます。
- 強い`MOVE_MEMBERS`権限を持つユーザーは音声チャンネル人数制限の運用上の意味を弱める場合があります。
- Gatewayセッションを失った時間帯のイベントを完全には再構成できません。その日は正確性を`degraded`として扱います。
- `VOICE_STATE_UPDATE`には利用者が実際に操作した正確な時刻がないため、受信時刻ベースです。
- 20件を超えるロール変更は、00:00までに厳密に終わらない可能性があります。同期は08:00に開始し、次の00:00までに完了させる運用です。
- Durable Objects SQLiteに対して論理削除しても、Cloudflare側の復旧機構から物理的に完全消去できることを保証するものではありません。

## 確認とデプロイ

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run check
npm.cmd run deploy
```

`npm.cmd run types` は`wrangler.jsonc`のDurable Object変更後に実行します。デプロイ後はWorkerの`/health`で次を確認できます。

```json
{
  "ok": true,
  "phase": "CLOSED",
  "dateJst": "YYYY-MM-DD",
  "gateway": { "connected": false, "integrity": "complete" },
  "channels": { "expected": 10, "registered": 0 },
  "roleSync": { "status": "complete" }
}
```
