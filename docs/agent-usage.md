# エージェント向け利用ガイド

AI エージェント（Claude Code など）が、GitHub Issue への画像添付や大きなファイルの受け渡しに assets-bin を使うための手順です。このファイルの内容は、エージェントの設定（CLAUDE.md や AGENTS.md）にデプロイ先 URL とともに貼り付けて使うことを想定しています。

## 前提

- デプロイ先 URL を `BASE` とします（例: `https://assets-bin.example.workers.dev`）
- サーバーに `UPLOAD_PASSWORD` が設定されている場合、`POST /files` に `Authorization: Bearer <パスワード>` ヘッダが必要です（なし・不一致は `401`）。未設定の環境では不要です
- ダウンロード側に認証はありません。**URL を知っている人は誰でもファイルを取得できます。機密情報・個人情報はアップロードしないでください**
- 単一 `PUT` の上限は 5 GiB、multipart 非対応

## アップロード手順（スクリプト）

同梱の [tools/upload.py](../tools/upload.py)（Python 3 標準ライブラリのみ、依存なし）を使うのが最も簡単です。成功すると共有 URL だけを標準出力に出力します。

```sh
python3 tools/upload.py --base="$BASE" --password=<パスワード> screenshot.png
# → https://assets-bin.example.workers.dev/files/<UUID>
```

`--password` はサーバーが `UPLOAD_PASSWORD` を設定している場合のみ必要です。`--base` / `--password` は環境変数 `ASSETS_BIN_BASE` / `ASSETS_BIN_PASSWORD` でも指定できます。contentType はファイル名から自動判定します。

## アップロード手順（curl）

スクリプトを使わない場合は2ステップです: (1) `POST /files` でアップロード先を発行 → (2) 返された署名付き URL へファイル本体を `PUT`。

```sh
BASE=https://<worker名>.<サブドメイン>.workers.dev
FILE=screenshot.png
MIME=$(file --mime-type -b "$FILE")   # 不明なら application/octet-stream

RES=$(curl -sf -X POST "$BASE/files" \
  -H 'Content-Type: application/json' \
  --data "{\"filename\":\"$(basename "$FILE")\",\"contentType\":\"$MIME\"}")
# パスワード必須の環境では -H "Authorization: Bearer $UPLOAD_PASSWORD" を追加

UPLOAD_URL=$(echo "$RES" | jq -r '.upload.url')
CT=$(echo "$RES" | jq -r '.upload.headers["Content-Type"]')
META=$(echo "$RES" | jq -r '.upload.headers["x-amz-meta-original-filename"]')
SHARE_URL="$BASE$(echo "$RES" | jq -r '.url')"

curl -sf -o /dev/null -X PUT "$UPLOAD_URL" \
  -H "Content-Type: $CT" \
  -H "x-amz-meta-original-filename: $META" \
  --data-binary @"$FILE"

echo "$SHARE_URL"
```

最後に出力される `SHARE_URL`（`$BASE/files/<UUID>` 形式）が共有用の永続 URL です。

### 守るべきルール

- **PUT には応答の `upload.headers` をそのまま付けること。** 2つのヘッダは署名対象なので、変更・省略すると R2 が 403 を返します。`Content-Type` は API 側で正規化されることがある（`text/*` に `charset=utf-8` が付くなど）ため、リクエストに使った値ではなく**応答の値**を使ってください。
- 署名付きアップロード URL の有効期限は**15分**です。発行したらすぐ PUT してください。
- `contentType` は実際のファイルに合ったものを指定してください。ブラウザでのインライン表示（画像の埋め込み等）はこの値に依存します。
- アップロードの成否確認は `curl -s -o /dev/null -w '%{http_code}' "$SHARE_URL"` で行えます。`302` なら完了、`404` なら本体が未アップロードです。

## URL の使い分け

| URL | 用途 |
|-----|------|
| `$BASE/files/<id>` | 共有用の永続 URL。アクセスごとに5分有効な署名付き URL へ 302 リダイレクトする。Markdown への貼り付けはこれを使う |
| `$BASE/files/<id>/raw` | 同上（別名） |
| `$BASE/files/<id>/download` | 元のファイル名での強制ダウンロード（`Content-Disposition: attachment`） |

リダイレクト先の署名付き URL（`r2.cloudflarestorage.com` の長い URL）は5分で失効するため、**リダイレクト先ではなく `/files/<id>` の方を共有・記録してください**。

## GitHub での使い方

画像を Issue や PR コメントに埋め込む:

```sh
gh issue comment 123 --body "スクリーンショット: ![screenshot]($SHARE_URL)"
```

`/files/<id>` はアクセスごとに新しい署名付き URL へリダイレクトするため、GitHub の画像プロキシ（camo）経由でも表示できます。画像以外のファイル（ログ、アーカイブ等）は URL をそのままリンクとして貼ってください。

```sh
gh pr comment 45 --body "ビルドログ（全文）: $SHARE_URL"
```

## エラー

エラーは `{"error":"メッセージ"}` の JSON で返ります。主なもの:

- `400` — filename / contentType の欠落や不正、不正な UUID
- `401` — アップロードパスワードの欠落・不一致（`UPLOAD_PASSWORD` 設定時のみ）
- `404` — ファイル未アップロードまたは存在しない ID
- `403`（R2 から） — 署名ヘッダの不一致、または署名付き URL の期限切れ

## 制限事項

- 一覧・削除 API はありません。**`SHARE_URL` を失うとファイルには辿り着けなくなる**ので、アップロード後は必ず URL を記録してください（Issue に貼る、結果として報告するなど）
- 削除はバケット管理者のみが行えます: `wrangler r2 object delete <バケット名>/<UUID> --remote`
