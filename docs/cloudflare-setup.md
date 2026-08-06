# Cloudflare セットアップ

デプロイに必要な Cloudflare 側の準備をまとめます。ローカルの開発環境構築（mise）は [README](../README.md) を参照してください。

手順どおりに進めると、アカウント準備 → バケット → 認証情報 → サブドメイン → デプロイ → secrets の順に完了します。

## 1. アカウントの作成（推奨・任意）

Cloudflare には GCP のプロジェクトに相当する、リソースをグルーピングする概念がありません。Workers や R2 バケットはすべてアカウント直下にフラットに並びます。そのため、既存のアカウントを使い回すのではなく、**このサービス用（あるいは用途のまとまり単位）にアカウントを作ってから始めることを推奨します**。必須ではないので、既存アカウントでそのまま進めても構いません。

分けておく利点:

- リソース一覧が他のサービスと混ざらない
- workers.dev のサブドメイン（`https://<worker名>.<サブドメイン>.workers.dev`）はアカウントごとに1つ選べるため、分かりやすい名前を取れる
- API トークンや課金が完全に分離される

作成手順: [dash.cloudflare.com](https://dash.cloudflare.com) にログイン → アカウント切り替えメニュー → **Create account**。同じログインの下に複数アカウントをぶら下げられ、新しいメールアドレスは不要です。

複数アカウントを持つと `wrangler deploy` 時にアカウントの選択を求められます。gitignore 済みの `mise.local.toml` に次のように書けば、リポジトリにアカウント ID をコミットせずに固定できます。

```toml
[env]
CLOUDFLARE_ACCOUNT_ID = "<アカウントID>"
```

## 2. R2 の有効化

**R2 は有効化するまで使えず、アカウントごとに支払い方法の登録が必要です**（無料枠内で使う場合も登録は求められます）。ダッシュボード → **R2 Object Storage** を開き、案内に従って有効化してください。無料枠はストレージ 10 GB/月、Class A 操作 100万回/月、Class B 操作 1000万回/月です。

> 有効化しないままバケットを作成しようとすると、次のエラーになります。
>
> ```
> Please enable R2 through the Cloudflare Dashboard. [code: 10042]
> ```

## 3. Wrangler でログイン

```sh
mise exec -- npx wrangler login
```

ブラウザが開き OAuth で認可します。ログイン後、確認と Account ID の取得:

```sh
mise exec -- npx wrangler whoami
```

表示される **Account ID** は `mise.local.toml` と `R2_ENDPOINT` で使います。ダッシュボードの URL（`https://dash.cloudflare.com/<Account ID>/...`）からも確認できます。アカウント切り替えメニューに表示されるのは任意に付けたアカウント名（ラベル）であり、Account ID とは別物です。

## 4. R2 バケットの作成

バケット名は任意です（このドキュメントでは `assets-bin` を例にします）。

```sh
mise exec -- npx wrangler r2 bucket create assets-bin
```

`assets-bin` 以外の名前にした場合は、`wrangler.jsonc` の次の2箇所を同じ名前に変更してください。

- `vars.R2_BUCKET_NAME` — 署名付き URL の生成に使用
- `r2_buckets[0].bucket_name` — 存在確認に使う R2 バインディング

作成後に「設定ファイルへバインディングを追記するか」と聞かれる場合がありますが、`wrangler.jsonc` に設定済みなので不要です。

## 5. CORS の設定

ブラウザから署名付き URL へ直接 `PUT` するため、バケットに CORS を設定します。

```sh
mise exec -- npx wrangler r2 bucket cors set <バケット名> --file cors.json
mise exec -- npx wrangler r2 bucket cors list <バケット名>
```

同梱の `cors.json` は、すぐ試せるよう origin を `*` にしています。デプロイして URL が確定したら、Workers の URL（例: `https://assets-bin.example.workers.dev`）へ絞って再設定してください。

## 6. R2 API トークンの作成

署名付き URL の生成に使う認証情報です。ここだけは Wrangler では発行できず、Web ダッシュボードでの作業になります。

1. ダッシュボード → **R2 Object Storage** → **{} API** → **Manage API tokens**
2. **Create Account API token** を選択
3. Permissions は **Object Read & Write**、対象は「Apply to specific buckets only」で作成したバケットに絞ることを推奨
4. 作成すると **Access Key ID** と **Secret Access Key** が表示されます。**Secret Access Key はこの画面でしか確認できない**ので控えてください

詳細は [R2 API tokens のドキュメント](https://developers.cloudflare.com/r2/api/tokens/)を参照してください。

## 7. ローカル開発用の認証情報

設定例をコピーし、Account ID と発行された認証情報を記入します（`.dev.vars` は gitignore 済み）。

```sh
cp .dev.vars.example .dev.vars
```

`wrangler.jsonc` の R2 バインディングは `remote: true` にしてあります。したがって `mise run dev` からのアップロードと存在確認も、本番と同じ R2 バケットを使用します。

## 8. workers.dev サブドメインの登録

新しいアカウントでは、デプロイの前に workers.dev のサブドメイン（URL の `<サブドメイン>.workers.dev` 部分）を登録する必要があります。未登録のまま `wrangler deploy` すると「register a workers.dev subdomain here」というエラーで止まります。

- サブドメインは**アカウントに1つ**で、そのアカウントの全 Worker に共通です
- 名前空間は**全 Cloudflare アカウントでグローバル**（早い者勝ち）です。`<自分の名前>-<プロジェクト名>` のような形にすると衝突しにくく、アカウント = プロジェクト運用とも揃います

登録はダッシュボードの **Workers & Pages** → **概要 (Overview)** の右サイドバーにある「サブドメイン」から行います。

> wrangler のエラーメッセージに表示される `…/workers/onboarding` という URL は、ダッシュボードの改版により 404 になることがあります。その場合も上記のサイドバーから登録できます。ダッシュボードで見つからない場合は API でも登録できます:
>
> ```sh
> curl -X PUT "https://api.cloudflare.com/client/v4/accounts/<Account ID>/workers/subdomain" \
>   -H "Authorization: Bearer <APIトークン>" \
>   -H "Content-Type: application/json" \
>   --data '{"subdomain":"<サブドメイン>"}'
> ```

## 9. デプロイと secrets の登録

まずデプロイして Worker を作成します（この時点では secrets 未登録のため、アップロード API はまだ動きません）。

```sh
mise run check
mise run deploy
```

> **デプロイ直後は TLS 証明書の発行待ちで、URL にアクセスすると SSL ハンドシェイクエラーになることがあります。**サブドメインを登録した直後は特に起きやすく、数分待てば解消します。

次に、署名生成用の値を Workers secrets に登録します。`R2_ENDPOINT` はバケット名を含めず、Account ID までの S3 API URL を指定します。

```sh
mise exec -- npx wrangler secret put R2_ENDPOINT
# https://<ACCOUNT_ID>.r2.cloudflarestorage.com

mise exec -- npx wrangler secret put R2_ACCESS_KEY_ID
mise exec -- npx wrangler secret put R2_SECRET_ACCESS_KEY
```

`.dev.vars` と同じ値を一括で入れたい場合は、`{"R2_ENDPOINT": "...", ...}` 形式の JSON ファイルを作って `wrangler secret bulk <ファイル>` でも登録できます。この JSON はリポジトリ外（一時ディレクトリなど）に置き、登録後に削除してください。

署名付き URL は [S3 API ドメインでのみ利用可能](https://developers.cloudflare.com/r2/api/s3/presigned-urls/#custom-domains)です。R2 のカスタムドメインを `R2_ENDPOINT` に設定しないでください。

## 10. 動作確認

`https://<worker名>.<サブドメイン>.workers.dev` をブラウザで開き、アップロード画面からファイルを上げて、返ってきた URL で表示できれば完了です。確認できたら手順 5 のとおり CORS の origin をこの URL に絞ってください。

エラー系や署名の検証まで含めた詳細な確認は [manual_qa.md](manual_qa.md) を参照してください。
