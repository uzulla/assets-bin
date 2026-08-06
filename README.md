# Assets-bin

Cloudflare Workers と R2 で動く、小さなファイル置き場です。Hono 製の API と簡単なアップロード画面を備えています。

ファイル本体は Workers を通りません。API が発行した署名付き URL を使ってブラウザから R2 へ直接アップロードし、表示・ダウンロード時も期限付きの R2 URL へリダイレクトします。

## セットアップ

開発ツールは [mise](https://mise.jdx.dev/) で管理します。mise `2025.12.0` 以上を用意し、Node.js 24 LTS、npm、プロジェクト依存関係をインストールします。

```sh
mise trust
mise install
mise run setup
```

`mise.toml` で Node.js と npm のバージョンを固定しています。Wrangler、TypeScript、Vitest などのプロジェクト固有ツールは `package-lock.json` で固定され、`mise run setup` が `npm ci` で再現します。

Cloudflare 側の準備（アカウント、R2 バケット、CORS、認証情報、secrets）は [docs/cloudflare-setup.md](docs/cloudflare-setup.md) を参照してください。

## ローカル実行と検証

ローカル開発には `.dev.vars` が必要です（作成方法は [docs/cloudflare-setup.md](docs/cloudflare-setup.md)）。`wrangler.jsonc` の R2 バインディングは `remote: true` にしてあるため、`mise run dev` からのアップロードと存在確認も、本番と同じ R2 バケットを使用します。

```sh
mise run dev
mise run test
mise run typecheck
mise run check
```

## デプロイ

初回は [docs/cloudflare-setup.md](docs/cloudflare-setup.md) の手順で secrets の登録まで済ませてから実行してください。

```sh
mise run check
mise run deploy
```

デプロイ後の動作確認手順は [docs/manual_qa.md](docs/manual_qa.md) にあります。

## API

- `POST /files` — 15分有効な署名付き PUT URL を発行
- `GET /files/:id` — 5分有効な通常表示用 URL へリダイレクト
- `GET /files/:id/raw` — 通常表示用 URL へリダイレクト
- `GET /files/:id/download` — 元のファイル名を使うダウンロード URL へリダイレクト

secret `UPLOAD_PASSWORD` を設定すると、`POST /files` に `Authorization: Bearer <パスワード>` ヘッダが必須になります（不一致は `401`）。未設定なら認証なしでアップロードできます。表示・ダウンロードは設定に関係なく認証なしです（URL の UUID が類推不能であることを前提としています）。

アップロード要求の例:

```json
{
  "filename": "example.png",
  "contentType": "image/png"
}
```

初期版のため、認証・一覧・削除・multipart upload は実装していません。単一 `PUT` で扱える上限は 5 GiB です。

AI エージェントから利用する場合（GitHub Issue への画像添付など）の手順は [docs/agent-usage.md](docs/agent-usage.md) にあります。

## ライセンス

[MIT License](LICENSE)
