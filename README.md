# discord-shinya

日本時間の深夜だけ、毎日新しい Discord チャンネルを公開する Cloudflare Workers ボットです。

## 動作

- 日本時間 0:00 に管理対象の古いチャンネルを削除
- `深夜限定テキスト1-MM-DD` と `深夜限定テキスト2-MM-DD` を作成
- `深夜限定通話1-MM-DD` と `深夜限定通話2-MM-DD` を作成
- `深夜限定テキスト1-MM-DD` へ次の通知を1回投稿

  ```text
  @here @設定したロール 今日のチャンネルが作成されました！
  ```

- 日本時間 8:00 に、削除前に2つのテキストチャンネルのメッセージ数を合算して指定ログチャンネルへ投稿

  ```text
  今日のメッセージ数：XX件
  今日もお疲れ様でした！おはようございます！
  ```

- その後、管理対象チャンネルを削除

ログ投稿先は `1543273845257928747` です。集計対象は削除直前の2つの深夜限定テキストチャンネルに存在する全メッセージの合算で、作成時の通知メッセージも含みます。
作成時の通知は、`@here` とロールメンションが重複しないよう `深夜限定テキスト1-MM-DD` へ1回だけ投稿します。
メッセージ数の取得に失敗した場合は、件数を含めず次の挨拶だけをログチャンネルへ1回投稿します。

```text
今日もお疲れ様でした！おはようございます！
```

件数取得またはログ投稿に失敗した場合も、エラーをWorkerログへ記録してチャンネル削除は継続します。

Cloudflare Cron は UTC 基準です。無料枠の Cron 数を節約するため、`0 15,23 * * *` という1本の式で実行します。`15:00 UTC` は日本時間 0:00、`23:00 UTC` は日本時間 8:00です。

ボットは Discord Gateway に常時接続せず、Discord HTTP API だけを使用します。音声通話への参加・録音・メッセージ監視は行いません。

## 必要な Discord 権限

ボットには次の権限を付与してください。

- View Channels
- Manage Channels
- Send Messages
- Mention Everyone
- Read Message History

`DISCORD_PARENT_CATEGORY_ID` に指定する親カテゴリは、参加者全員が子チャンネルを閲覧・投稿・通話参加できる権限にしてください。ボットはそのカテゴリ配下にだけチャンネルを作成します。
メッセージ数を取得するため、ボットには対象テキストチャンネルの `Read Message History` も必要です。ログチャンネル `1543273845257928747` では `View Channels` と `Send Messages` を許可してください。

ロールメンションにはロールIDを使用します。Discord の開発者モードを有効にし、対象ロールを右クリックしてIDをコピーしてください。

## ローカル確認

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run check
```

実際の Discord を操作せずにスケジュール処理の流れだけ確認する場合は、`.dev.vars` を作成して次を設定します。

```text
DRY_RUN=true
```

`DRY_RUN=true` の動作確認ではDiscord APIを呼び出さず、チャンネル作成・メッセージ投稿・チャンネル削除を一切行いません。テストコードも実Discordの削除APIを呼ばない構成です。本番SecretでのCronを動作テストとして手動発火しないでください。

その後、次を実行します。

```powershell
npm.cmd run dev
```

## Cloudflare への設定とデプロイ

Wrangler にログインした状態で、以下を実行します。値の入力は対話式で行われ、ソースコードには保存されません。

```powershell
npm.cmd exec wrangler -- secret put DISCORD_BOT_TOKEN
npm.cmd exec wrangler -- secret put DISCORD_GUILD_ID
npm.cmd exec wrangler -- secret put DISCORD_PARENT_CATEGORY_ID
npm.cmd exec wrangler -- secret put DISCORD_MENTION_ROLE_ID
npm.cmd run deploy
```

デプロイ後、Worker の `/health` にアクセスすると、設定状態とスケジュールを確認できます。

## 安全策

- 削除対象は指定カテゴリ配下かつ厳密な日付付き名前のチャンネルだけ
- 削除は順番に実行し、Discord のレート制限には再試行で対応
- 0:00 の古いチャンネル削除に失敗した場合、新規作成を中止
- 作成途中で失敗した場合、作成済みチャンネルをロールバック
- 同じ日付のチャンネルがすでに存在する場合、重複作成しない
- ボットトークンや Discord API のレスポンス本文をログへ出さない
