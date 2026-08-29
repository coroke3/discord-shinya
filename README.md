# discord-shinya

日本時間の深夜だけ、毎日新しい Discord チャンネルを公開する Cloudflare Workers ボットです。

## 動作

- 日本時間 0:00 に管理対象の古いチャンネルを削除
- `深夜限定テキスト-MM-DD` を作成
- `深夜限定通話-MM-DD` を作成
- テキストチャンネルへ次の通知を投稿

  ```text
  @here @設定したロール 今日のチャンネルが作成されました！
  ```

- 日本時間 8:00 に管理対象チャンネルを削除

Cloudflare Cron は UTC 基準です。無料枠の Cron 数を節約するため、`0 15,23 * * *` という1本の式で実行します。`15:00 UTC` は日本時間 0:00、`23:00 UTC` は日本時間 8:00です。

ボットは Discord Gateway に常時接続せず、Discord HTTP API だけを使用します。音声通話への参加・録音・メッセージ監視は行いません。

## 必要な Discord 権限

ボットには次の権限を付与してください。

- View Channels
- Manage Channels
- Send Messages
- Mention Everyone

`DISCORD_PARENT_CATEGORY_ID` に指定する親カテゴリは、参加者全員が子チャンネルを閲覧・投稿・通話参加できる権限にしてください。ボットはそのカテゴリ配下にだけチャンネルを作成します。

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

その後、次を実行します。

```powershell
npm.cmd run dev
```

## Cloudflare への設定とデプロイ

Wrangler にログインした状態で、以下を実行します。値の入力は対話式で行われ、ソースコードには保存されません。

```powershell
npm.cmd exec wrangler secret put DISCORD_BOT_TOKEN
npm.cmd exec wrangler secret put DISCORD_GUILD_ID
npm.cmd exec wrangler secret put DISCORD_PARENT_CATEGORY_ID
npm.cmd exec wrangler secret put DISCORD_MENTION_ROLE_ID
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
