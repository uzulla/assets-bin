# 動作確認手順

デプロイ後に API が仕様どおり動いているかを curl で確認する手順です。ブラウザでトップページからアップロードするだけでも大まかな確認はできますが、こちらはエラー系や署名の検証まで含めた確認になります。

デプロイ先の URL を変数に入れておきます（以下のコマンドはすべてこの変数を使います）。

```sh
BASE=https://<worker名>.<サブドメイン>.workers.dev
```

毎回設定するのが面倒な場合は、gitignore 済みの `mise.local.toml` に書いておくと、このディレクトリ内では自動で設定されます。

```toml
[env]
BASE = "https://<worker名>.<サブドメイン>.workers.dev"
```

## 正常系

日本語やスペースを含むファイル名を使うと、メタデータの取り扱いまで確認できます。

### 1. トップページ

```sh
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "$BASE/"
```

期待: `200 text/html; charset=UTF-8`

### 2. アップロード先の発行

```sh
echo 'hello assets-bin' > test.txt
curl -s -X POST "$BASE/files" \
  -H 'Content-Type: application/json' \
  --data '{"filename":"テスト file.txt","contentType":"text/plain"}'
```

期待: HTTP `201` で、次の形の JSON が返る。

- `id` — UUID v4
- `url` — `/files/<id>`
- `upload.method` — `PUT`
- `upload.url` — 署名付き URL（クエリに `X-Amz-Expires=900` = 15分を含む）
- `upload.headers` — `Content-Type` と `x-amz-meta-original-filename`（URL エンコード済みファイル名）

以降の手順で使うので、`id`、`upload.url`、`upload.headers` の値を控えます。

### 3. アップロード完了前は 404

```sh
curl -s -w '\n%{http_code}\n' "$BASE/files/<id>"
```

期待: `404`（仕様: アップロードが完了するまで `GET /files/:id` は 404）

### 4. 署名ヘッダなしの PUT は拒否される

`upload.headers` を付けずに PUT します。

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X PUT '<upload.url>' --data-binary @test.txt
```

期待: `403`（ヘッダは署名対象なので、改ざん・省略すると R2 が拒否する）

### 5. 正しいヘッダ付きの PUT

`upload.headers` の2つをそのまま付けます。

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X PUT '<upload.url>' \
  -H 'Content-Type: text/plain'  \
  -H 'x-amz-meta-original-filename: <upload.headersの値>' \
  --data-binary @test.txt
```

期待: `200`

### 6. 表示用リダイレクトと内容の一致

```sh
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/files/<id>"
curl -sL "$BASE/files/<id>"
```

期待: 1つ目は `302`（リダイレクト先の署名付き URL は `X-Amz-Expires=300` = 5分）。2つ目はアップロードした内容がそのまま返る。`/files/<id>/raw` も同様に `302`。

### 7. ダウンロード用リダイレクト

```sh
curl -s -D - -o /dev/null "$BASE/files/<id>/download" | grep -i '^location'
```

期待: リダイレクト先 URL に `response-content-disposition=attachment...` が含まれ、デコードすると `filename*=UTF-8''<元のファイル名>` になっている（日本語ファイル名が保持される）。

### 8. セキュリティ関連ヘッダ

```sh
curl -s -D - -o /dev/null "$BASE/files/<id>" | grep -iE 'referrer-policy|x-content-type-options|cache-control'
```

期待:

```
cache-control: no-store
referrer-policy: no-referrer
x-content-type-options: nosniff
```

## エラー系

すべて `{"error":"メッセージ"}` の JSON で返ることも合わせて確認します。

```sh
# 不正な JSON → 400
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' --data 'not-json'

# filename 欠落 → 400
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' --data '{"contentType":"image/png"}'

# filename にパス区切り → 400
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' --data '{"filename":"a/b.png","contentType":"image/png"}'

# 不正な contentType → 400
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' --data '{"filename":"a.png","contentType":"not a type"}'

# 不正な UUID → 400
curl -s -w ' -> %{http_code}\n' "$BASE/files/not-a-uuid"

# 形式は正しいが存在しない UUID → 404
curl -s -w ' -> %{http_code}\n' "$BASE/files/00000000-0000-4000-8000-000000000000"

# 未知のパス → 404
curl -s -w ' -> %{http_code}\n' "$BASE/nonexistent-path"
```

## パスワード保護（`UPLOAD_PASSWORD` 設定時のみ）

secret `UPLOAD_PASSWORD` を設定した環境では、次も確認します。

```sh
# Authorization なし → 401
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' --data '{"filename":"a.png","contentType":"image/png"}'

# 誤ったパスワード → 401
curl -s -w ' -> %{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' -H 'Authorization: Bearer wrong' --data '{"filename":"a.png","contentType":"image/png"}'

# 正しいパスワード → 201
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/files" -H 'Content-Type: application/json' -H "Authorization: Bearer <パスワード>" --data '{"filename":"a.png","contentType":"image/png"}'
```

トップページにパスワード入力欄が表示されることも確認します（未設定の環境では表示されません）。

## 後片付け

削除 API は未実装なので、テストで作ったオブジェクトは wrangler で削除します。

```sh
mise exec -- npx wrangler r2 object delete <バケット名>/<id> --remote
rm -f test.txt
```
