# Assets-bin 仕様

## 概要

Cloudflare Workers 上で動作する、API ベースのファイル置き場を作る。
実装は TypeScript と Hono を使用し、ファイル本体は Cloudflare R2 に保存する。

## API

### アップロード

- `POST /files`
- ファイル本体は送らず、次の JSON でアップロード先を要求する

```json
{
  "filename": "example.png",
  "contentType": "image/png"
}
```

- Workers は UUID v4 を発行し、R2 へ直接 `PUT` できる署名付き URL を生成する
- 署名付き URL の有効期限は15分とする
- 成功時は `201 Created` と次の JSON を返す

```json
{
  "id": "UUID",
  "url": "/files/UUID",
  "upload": {
    "method": "PUT",
    "url": "R2の署名付きURL",
    "headers": {
      "Content-Type": "image/png",
      "x-amz-meta-original-filename": "example.png"
    }
  }
}
```

クライアントは返された method、URL、headers をそのまま使い、ファイル本体を R2 へ送信する。
アップロードが完了するまでは `GET /files/:id` は `404` を返す。

### 表示・ダウンロード

- Workers はファイルの存在を確認し、5分有効な R2 の署名付き GET URL へ `302 Found` でリダイレクトする
- `GET /files/:id` または `GET /files/:id/raw` は通常表示用の URL へリダイレクトする
  - 画像は `img` 要素の `src` などに指定できる
  - ZIP など、ブラウザで表示できない形式は通常どおりダウンロードされる
- `GET /files/:id/download` は `Content-Disposition: attachment` を指定した URL へリダイレクトする
- 保存時の Content-Type を返す
- ダウンロード時のファイル名には元のファイル名を使用する

ファイル本体は Workers を経由しない。

## R2 に保存する情報

- オブジェクトキー: UUID
- ファイル本体
- 元のファイル名
- Content-Type

元のファイル名と Content-Type は署名対象のメタデータとしてアップロード時に保存する。

## エラー

エラーは `{ "error": "メッセージ" }` の JSON で返す。

- 必須項目の不足・不正な UUID: `400 Bad Request`
- ファイルが存在しない: `404 Not Found`
- その他の失敗: `500 Internal Server Error`

## 対象外

アップロードは、環境変数 `UPLOAD_PASSWORD` を設定した場合のみ `Authorization: Bearer <パスワード>` を必須とする（未設定なら認証なし、不一致は `401`）。表示・ダウンロードは URL の UUID が類推不能であることを前提に認証を設けない。
初期版では、ファイル一覧、削除、管理画面は実装しない。
ブラウザから R2 へ `PUT`、`GET` できるよう、バケットに CORS を設定する。
初期版は最大 5 GiB の単一 `PUT` のみとし、multipart upload は対象外とする。
