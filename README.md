# discord-shinya

日本時間（JST）の深夜帯だけDiscordに一時チャンネルを作り、朝8時に削除するBotです。

- 00:00〜08:00だけ、テキスト5個・通話5個を公開
- 毎日チャンネルを作り直し、前日のチャンネル履歴を残さない
- 08:00にメッセージ数・来場者数・通話の賑わいを集計
- Cloudflare Workers FreeとSQLite-backed Durable Objectsだけで運用

## 1日の動作

Cloudflare CronはUTCで設定し、Bot内部ではすべてJSTとして扱います。

| JST | UTC | 処理 |
| --- | --- | --- |
| 00:00 | 15:00 | 前日の後処理を確認し、当日分の10チャンネルを作成 |
| 03:00 | 18:00 | 深層チャンネル4個を`@everyone`へ公開 |
| 08:00 | 23:00 | 集計、チャンネル削除、ログ投稿、深層ロール同期 |

Cron設定：

```text
0 15,18,23 * * *
```

00:00の処理が失敗しても、03:00の処理が当日分の作成を引き継ぎます。遅延した公開処理が08:00を越えた場合は、新しく公開せず終了処理へ切り替えます。

## 作成されるチャンネル

通常チャンネル6個と、深層チャンネル4個を作成します。`MM-DD`は日本時間の日付です。

| 種類 | チャンネル名 | 個数 | カテゴリ |
| --- | --- | ---: | --- |
| 通常テキスト | `深夜限定テキスト1-MM-DD`〜`3-MM-DD` | 3 | `DISCORD_PARENT_CATEGORY_ID` |
| 通常通話 | `深夜限定通話1-MM-DD`〜`3-MM-DD` | 3 | `DISCORD_PARENT_CATEGORY_ID` |
| 深層テキスト | `深層-深夜限定テキスト1-MM-DD`〜`2-MM-DD` | 2 | `DISCORD_DEEP_PARENT_CATEGORY_ID` |
| 深層通話 | `深層-深夜限定通話1-MM-DD`〜`2-MM-DD` | 2 | `DISCORD_DEEP_PARENT_CATEGORY_ID` |

通話チャンネルの人数上限は次のとおりです。

```text
通常通話1：無制限　通常通話2：8人　通常通話3：4人
深層通話1：無制限　深層通話2：4人
```

### 作成時の通知

次の2チャンネルへ1回ずつ投稿します。

- `深夜限定テキスト1-MM-DD`
- `深層-深夜限定テキスト1-MM-DD`

投稿内容：

```text
@here @設定したロール 今日のチャンネルが作成されました！
```

`@here`と`DISCORD_MENTION_ROLE_ID`だけをメンション対象にします。

## 08:00の集計とログ

### 概要ログ

固定チャンネル `1543273845257928747` に投稿します。

```text
今日のメッセージ数：XX件
今日の来場者数：YY人
賑わい：ZZ
今日もお疲れ様でした！おはようございます！
```

- `XX`：5つのテキストチャンネルに届いたメッセージ数
- `YY`：テキスト投稿または通話参加をした重複なし人数（Bot除外）
- `ZZ`：通話の加重秒数。ミュート中は1倍、発話中は2倍

Gatewayの集計が不完全な場合、件数を推測せず、概要ログには挨拶だけを投稿します。ログ投稿に失敗しても、チャンネル削除は継続します。

### 30分ごとの詳細ログ

`DISCORD_ACTIVITY_DETAIL_CHANNEL_ID`へ1メッセージ投稿します。

```text
【賑わい内訳 MM/DD】

時間帯 | 滞在人数 | ミュート率 | メッセージ数
00:00-00:29 | 12人 | 4/12 | 37件
...
07:30-07:59 | 2人 | 1/2 | 0件
```

- ミュート率は「その枠でミュート状態になった人数 / 滞在人数」
- 滞在人数グラフは1人を`■`、ミュート状態があった人を`□`
- メッセージ数グラフは20件ごとに`■`1つ
- 件数が取得できない場合は、メッセージ数欄とグラフを`取得不可`と表示

## データ保持方針

長期的な利用履歴は保存しません。

一時的に保存するもの：

- 当日の合計メッセージ数と来場者ID
- 現在の通話セッション
- 30分単位の匿名集計とグラフ用の一時ID
- 深層ロール同期のキュー
- Gateway再接続用のセッション情報
- 失敗した処理を再試行するための状態

次の処理が成功すると、当日分のメッセージ数・通話集計・利用者ID・再試行状態などを削除します。長期的に残るのは、翌日のロール解除判定に必要な`deep_role_members`と最小限のサービス状態だけです。

## 構成

```text
Cloudflare Cron
      ↓
Worker（JSTの日付・処理を判定）
      ↓
NightCoordinator Durable Object（SQLiteで段階状態を管理）
      ├─ Discord Gateway（メッセージ・通話イベント）
      └─ Discord REST API（作成・権限変更・ログ・削除）
```

外部VPS、D1、KV、R2、Queues、Workers AIは使用しません。削除とロール同期は1回あたり最大10件に分け、無料枠のsubrequest上限を超えにくくしています。

## セットアップ

### 1. 依存関係をインストール

```powershell
npm.cmd install
```

### 2. 環境変数を設定

ローカルでは`.dev.vars.example`をコピーして、`.dev.vars`へ値を設定します。

```powershell
Copy-Item .dev.vars.example .dev.vars
```

`.dev.vars`：

```text
DISCORD_BOT_TOKEN=
DISCORD_GUILD_ID=
DISCORD_PARENT_CATEGORY_ID=
DISCORD_DEEP_PARENT_CATEGORY_ID=
DISCORD_MENTION_ROLE_ID=
DISCORD_DEEP_ROLE_ID=
DISCORD_ACTIVITY_DETAIL_CHANNEL_ID=
DRY_RUN=false
```

設定項目：

| 変数 | 内容 |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Discord Botトークン |
| `DISCORD_GUILD_ID` | 対象サーバーID |
| `DISCORD_PARENT_CATEGORY_ID` | 通常6チャンネル用カテゴリID |
| `DISCORD_DEEP_PARENT_CATEGORY_ID` | 深層4チャンネル用カテゴリID（通常カテゴリとは別） |
| `DISCORD_MENTION_ROLE_ID` | 作成通知でメンションするロールID |
| `DISCORD_DEEP_ROLE_ID` | 深層チャンネルと深層ロール同期に使うロールID |
| `DISCORD_ACTIVITY_DETAIL_CHANNEL_ID` | 詳細ログ投稿先チャンネルID |
| `DRY_RUN` | `true`ならDiscord APIを呼ばず、破壊的操作もしない |

本番ではSecretとして登録します。各コマンド実行後に値を入力してください。

```powershell
npm.cmd exec wrangler -- secret put DISCORD_BOT_TOKEN
npm.cmd exec wrangler -- secret put DISCORD_GUILD_ID
npm.cmd exec wrangler -- secret put DISCORD_PARENT_CATEGORY_ID
npm.cmd exec wrangler -- secret put DISCORD_DEEP_PARENT_CATEGORY_ID
npm.cmd exec wrangler -- secret put DISCORD_MENTION_ROLE_ID
npm.cmd exec wrangler -- secret put DISCORD_DEEP_ROLE_ID
npm.cmd exec wrangler -- secret put DISCORD_ACTIVITY_DETAIL_CHANNEL_ID
```

Secret不足時は`/health`が503になり、Cron処理は開始しません。実際の値やDiscord APIのレスポンス本文はログに出力しません。

### 3. Durable Object型を生成

`wrangler.jsonc`のDurable Object設定を変更した場合だけ実行します。

```powershell
npm.cmd run types
```

## Discord側の権限

Botには対象サーバー・両カテゴリ・ログチャンネルに対して、少なくとも次を許可します。

- View Channels
- Manage Channels
- Send Messages
- Mention Everyone
- Connect / Speak
- Manage Roles

深層ロールはBotのロールより下位に配置してください。Botが`1543273845257928747`と`DISCORD_ACTIVITY_DETAIL_CHANNEL_ID`へ投稿できることも確認します。

深層ロールの付与・解除で401/403が返った場合は、チャンネル削除と翌日の公開を止めず、ロール同期を失敗状態として記録します。次の終了処理で利用状況からキューを再構築するため、Botの「ロールの管理」権限とロール階層を直した後に自動再試行されます。

Gateway Intentは次の3つだけです。

```text
GUILDS | GUILD_VOICE_STATES | GUILD_MESSAGES = 641
```

`MESSAGE_CONTENT`、`GUILD_MEMBERS`、`PRESENCES`は使用しません。

## 安全策

- 管理対象は、指定カテゴリ内の厳密な日付付きチャンネル名だけです。
- メッセージ履歴APIは使わず、Gatewayイベントだけで件数を集計します。
- 通知・ログ投稿にはnonceを使い、応答失敗時の二重投稿を抑えます。
- Discord REST要求は15秒でタイムアウトし、Durable Object Alarmで再試行します。
- Discord APIの429は`Retry-After`に従い、長時間の待機を1回の実行内で行いません。
- 8時のテストでは必ず`DRY_RUN=true`を使います。本番Cronを手動発火しないでください。

## 確認・テスト・デプロイ

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd exec wrangler -- types --check
npm.cmd run check
npm.cmd run deploy
```

`npm.cmd run check`はdry-runです。デプロイ後はWorkerの`/health`を確認してください。正常に待機中なら、概ね次の状態になります。

```json
{
  "ok": true,
  "phase": "CLOSED",
  "gateway": { "connected": false, "integrity": "complete" },
  "channels": { "expected": 10, "registered": 0 },
  "roleSync": { "status": "complete" }
}
```

## 既知の制約

- Gateway切断中のイベントは完全には復元できず、その日の件数は`degraded`扱いになります。
- 通話時間はDiscordイベントの受信時刻を基準に集計する近似値です。
- Discord管理者やOwnerはチャンネル権限を迂回できます。
- Cloudflareアカウント全体の無料枠上限や、極端なイベント量まで保証するものではありません。
- SQLiteから論理削除したデータが、Cloudflareのバックアップ領域から物理的に即時消去されることまでは保証できません。
