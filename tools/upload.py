#!/usr/bin/env python3
"""assets-bin へファイルをアップロードし、共有 URL を標準出力に出力する。

使い方:
    upload.py --base=https://assets-bin.example.workers.dev [--password=...] ファイル

依存ライブラリなし（Python 3.9+ の標準ライブラリのみ）。
--base と --password は環境変数 ASSETS_BIN_BASE / ASSETS_BIN_PASSWORD でも指定できる。
"""

import argparse
import json
import mimetypes
import os
import sys
import urllib.error
import urllib.request


# urllib デフォルトの Python-urllib/3.x は Cloudflare のボット対策 (error 1010) に
# ブロックされるため、独自の User-Agent を名乗る
USER_AGENT = "assets-bin-upload/1.0"


def fail(message: str) -> "NoReturn":
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def api_error_message(error: urllib.error.HTTPError) -> str:
    body = error.read().decode("utf-8", errors="replace")
    try:
        return json.loads(body)["error"]
    except (ValueError, KeyError):
        return body[:200] or error.reason


def main() -> None:
    parser = argparse.ArgumentParser(
        description="assets-bin へファイルをアップロードし、共有 URL を出力する",
    )
    parser.add_argument(
        "--base",
        default=os.environ.get("ASSETS_BIN_BASE"),
        help="デプロイ先 URL（例: https://assets-bin.example.workers.dev）。"
        "環境変数 ASSETS_BIN_BASE でも指定可",
    )
    parser.add_argument(
        "--password",
        default=os.environ.get("ASSETS_BIN_PASSWORD"),
        help="アップロードパスワード（サーバーが必須とする場合のみ）。"
        "環境変数 ASSETS_BIN_PASSWORD でも指定可",
    )
    parser.add_argument("file", help="アップロードするファイル")
    args = parser.parse_args()

    if not args.base:
        fail("--base または環境変数 ASSETS_BIN_BASE を指定してください")
    base = args.base.rstrip("/")

    if not os.path.isfile(args.file):
        fail(f"ファイルが見つかりません: {args.file}")
    filename = os.path.basename(args.file)
    content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"

    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if args.password:
        headers["Authorization"] = f"Bearer {args.password}"
    request = urllib.request.Request(
        f"{base}/files",
        data=json.dumps({"filename": filename, "contentType": content_type}).encode(),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request) as response:
            created = json.load(response)
    except urllib.error.HTTPError as error:
        fail(f"アップロード先の発行に失敗しました ({error.code}): {api_error_message(error)}")
    except urllib.error.URLError as error:
        fail(f"{base} に接続できません: {error.reason}")

    # 返された headers は署名対象のため、そのまま送る必要がある
    upload = created["upload"]
    put_headers = dict(upload["headers"])
    put_headers["User-Agent"] = USER_AGENT
    put_headers["Content-Length"] = str(os.path.getsize(args.file))
    with open(args.file, "rb") as body:
        request = urllib.request.Request(
            upload["url"],
            data=body,
            headers=put_headers,
            method=upload["method"],
        )
        try:
            with urllib.request.urlopen(request):
                pass
        except urllib.error.HTTPError as error:
            fail(f"R2 へのアップロードに失敗しました ({error.code}): {api_error_message(error)}")
        except urllib.error.URLError as error:
            fail(f"R2 に接続できません: {error.reason}")

    print(f"{base}{created['url']}")


if __name__ == "__main__":
    main()
