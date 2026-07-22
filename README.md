# Assets-bin

Cloudflare Workers と R2 で動く、小さなファイル置き場です。Hono 製の API と簡単なアップロード画面を備えています。

ファイル本体は Workers を通りません。API が発行した署名付き URL を使ってブラウザから R2 へ直接アップロードし、表示・ダウンロード時も期限付きの R2 URL へリダイレクトします。

## セットアップ

Node.js 24 LTS を用意し、依存関係をインストールします。`nvm` を使う場合は、同梱の `.nvmrc` で切り替えられます。

```sh
nvm use
npm install
```

Cloudflare にログインし、`assets-bin` バケットを作成します。

```sh
npx wrangler login
npx wrangler r2 bucket create assets-bin
```

Cloudflare の R2 管理画面で、対象バケットに対する Object Read & Write 権限の [R2 API token](https://developers.cloudflare.com/r2/api/tokens/) を作成してください。ローカル開発用に設定例をコピーし、Account ID と発行された認証情報を記入します。

```sh
cp .dev.vars.example .dev.vars
```

`wrangler.jsonc` の R2 バインディングは `remote: true` にしてあります。したがって `npm run dev` からのアップロードと存在確認も、本番と同じ R2 バケットを使用します。

## CORS

ブラウザから署名付き URL へ直接 `PUT` するため、R2 バケットに CORS を設定します。

```sh
npx wrangler r2 bucket cors set assets-bin --file cors.json
npx wrangler r2 bucket cors list assets-bin
```

同梱の `cors.json` は、すぐ試せるよう origin を `*` にしています。本番では Workers の URL（例: `https://assets-bin.example.workers.dev`）へ絞ってください。

## ローカル実行と検証

```sh
npm run dev
npm test
npm run typecheck
```

## デプロイ

署名生成用の値を Workers secrets に登録します。`R2_ENDPOINT` はバケット名を含めず、Account ID までの S3 API URL を指定します。

```sh
npx wrangler secret put R2_ENDPOINT
# https://<ACCOUNT_ID>.r2.cloudflarestorage.com

npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
npm run deploy
```

署名付き URL は [S3 API ドメインでのみ利用可能](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#custom-domains)です。R2 のカスタムドメインを `R2_ENDPOINT` に設定しないでください。

## API

- `POST /files` — 15分有効な署名付き PUT URL を発行
- `GET /files/:id` — 5分有効な通常表示用 URL へリダイレクト
- `GET /files/:id/raw` — 通常表示用 URL へリダイレクト
- `GET /files/:id/download` — 元のファイル名を使うダウンロード URL へリダイレクト

アップロード要求の例:

```json
{
  "filename": "example.png",
  "contentType": "image/png"
}
```

初期版のため、認証・一覧・削除・multipart upload は実装していません。単一 `PUT` で扱える上限は 5 GiB です。
