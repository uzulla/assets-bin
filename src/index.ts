import { AwsClient } from "aws4fetch";
import { Hono } from "hono";
import { html } from "hono/html";
import type { Handler } from "hono";

type Bindings = {
  FILES: R2Bucket;
  R2_ENDPOINT: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
};

type AppEnv = { Bindings: Bindings };

type UploadRequest = {
  filename?: unknown;
  contentType?: unknown;
};

const app = new Hono<AppEnv>();

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTENT_TYPE =
  /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"[^"\r\n]*"))*$/;
const MAX_FILENAME_BYTES = 1024;

app.use("*", async (c, next) => {
  await next();
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Content-Type-Options", "nosniff");
  if (c.req.path.startsWith("/files")) {
    c.header("Cache-Control", "no-store");
  }
});

app.get("/", (c) => c.html(homePage));

app.post("/files", async (c) => {
  let body: UploadRequest;
  try {
    body = await c.req.json<UploadRequest>();
  } catch {
    return c.json({ error: "JSON の形式が正しくありません" }, 400);
  }

  const validationError = validateUpload(body);
  if (validationError) {
    return c.json({ error: validationError }, 400);
  }

  const filename = body.filename as string;
  const contentType = normalizeContentType(body.contentType as string);
  const id = crypto.randomUUID();
  const metadataFilename = encodeURIComponent(filename);
  const client = createR2Client(c.env);
  const objectUrl = new URL(
    createObjectUrl(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME, id),
  );
  objectUrl.searchParams.set("X-Amz-Expires", String(15 * 60));
  const signed = await client.sign(objectUrl, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-amz-meta-original-filename": metadataFilename,
    },
    aws: { signQuery: true, allHeaders: true },
  });

  return c.json(
    {
      id,
      url: `/files/${id}`,
      upload: {
        method: "PUT",
        url: signed.url,
        headers: {
          "Content-Type": contentType,
          "x-amz-meta-original-filename": metadataFilename,
        },
      },
    },
    201,
  );
});

app.get("/files/:id", redirectToFile(false));
app.get("/files/:id/raw", redirectToFile(false));
app.get("/files/:id/download", redirectToFile(true));

app.notFound((c) => c.json({ error: "Not Found" }, 404));

app.onError((error, c) => {
  console.error(error);
  return c.json({ error: "ファイルの処理に失敗しました" }, 500);
});

function redirectToFile(download: boolean): Handler<AppEnv> {
  return async (c) => {
    const id = c.req.param("id");
    if (!id || !UUID_V4.test(id)) {
      return c.json({ error: "UUID の形式が正しくありません" }, 400);
    }

    const object = await c.env.FILES.head(id);
    if (!object) {
      return c.json({ error: "ファイルが存在しません" }, 404);
    }

    const url = new URL(
      createObjectUrl(c.env.R2_ENDPOINT, c.env.R2_BUCKET_NAME, id),
    );
    if (download) {
      const storedFilename =
        object.customMetadata?.["original-filename"] ??
        object.customMetadata?.originalFilename ??
        id;
      const filename = decodeMetadata(storedFilename, id);
      url.searchParams.set(
        "response-content-disposition",
        contentDisposition(filename),
      );
    }
    url.searchParams.set("X-Amz-Expires", String(5 * 60));

    const client = createR2Client(c.env);
    const signed = await client.sign(url.toString(), {
      method: "GET",
      aws: { signQuery: true },
    });
    return c.redirect(signed.url, 302);
  };
}

function validateUpload(body: UploadRequest): string | undefined {
  if (typeof body.filename !== "string" || body.filename.length === 0) {
    return "filename は必須です";
  }
  if (new TextEncoder().encode(body.filename).byteLength > MAX_FILENAME_BYTES) {
    return `filename は ${MAX_FILENAME_BYTES} バイト以内にしてください`;
  }
  if (/[/\\\u0000-\u001f\u007f]/.test(body.filename)) {
    return "filename に使用できない文字が含まれています";
  }
  if (typeof body.contentType !== "string" || body.contentType.length === 0) {
    return "contentType は必須です";
  }
  if (!CONTENT_TYPE.test(body.contentType)) {
    return "contentType の形式が正しくありません";
  }
  return undefined;
}

// charset のないテキストは UTF-8 以外として解釈されうるため、明示して文字化けを防ぐ
function normalizeContentType(contentType: string): string {
  if (/^text\//i.test(contentType) && !/;\s*charset=/i.test(contentType)) {
    return `${contentType}; charset=utf-8`;
  }
  return contentType;
}

function createR2Client(env: Bindings): AwsClient {
  if (
    !env.R2_ENDPOINT ||
    !env.R2_BUCKET_NAME ||
    !env.R2_ACCESS_KEY_ID ||
    !env.R2_SECRET_ACCESS_KEY
  ) {
    throw new Error("R2 S3 API の設定が不足しています");
  }
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
  });
}

function createObjectUrl(
  endpoint: string,
  bucketName: string,
  id: string,
): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("R2_ENDPOINT は https URL で指定してください");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(bucketName)}/${id}`;
  return url.toString();
}

function decodeMetadata(value: string, fallback: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return fallback;
  }
}

function contentDisposition(filename: string): string {
  const fallback =
    filename
      .normalize("NFKD")
      .replace(/[^\x20-\x7e]/g, "_")
      .replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

const homePage = html`<!doctype html>
  <html lang="ja">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Assets bin</title>
      <style>
        :root {
          color-scheme: light dark;
          font-family: ui-sans-serif, system-ui, sans-serif;
          background: #f4f4f0;
          color: #20211f;
        }
        body { margin: 0; min-height: 100vh; display: grid; place-items: center; }
        main { width: min(560px, calc(100% - 32px)); }
        h1 { margin-bottom: 8px; font-size: clamp(2rem, 8vw, 4rem); letter-spacing: -0.06em; }
        p { color: #62645f; }
        form { margin-top: 32px; padding: 28px; border: 1px solid #d6d7d1; border-radius: 18px; background: #fff; box-shadow: 0 12px 40px #24251f12; }
        input, button { box-sizing: border-box; width: 100%; font: inherit; }
        input { padding: 18px; border: 1px dashed #a5a79f; border-radius: 12px; }
        button { margin-top: 14px; padding: 13px; border: 0; border-radius: 999px; background: #272822; color: #fff; cursor: pointer; font-weight: 650; }
        button:disabled { opacity: .45; cursor: wait; }
        #result { display: none; margin-top: 20px; overflow-wrap: anywhere; }
        #result a { color: #335fbd; }
        #preview { display: block; max-width: 100%; max-height: 360px; margin-top: 18px; border-radius: 12px; }
        @media (prefers-color-scheme: dark) {
          :root { background: #171815; color: #efefeb; }
          form { background: #20211e; border-color: #3e4039; box-shadow: none; }
          p { color: #adafa8; }
          button { background: #efefeb; color: #20211f; }
          #result a { color: #90b7ff; }
        }
      </style>
    </head>
    <body>
      <main>
        <h1>Assets bin</h1>
        <p>ファイルを選ぶと、Workers を経由せず R2 へ直接保存します。</p>
        <form id="upload-form">
          <input id="file" name="file" type="file" required />
          <button type="submit">アップロード</button>
          <div id="result" role="status"></div>
        </form>
      </main>
      <script>
        const form = document.querySelector('#upload-form');
        const input = document.querySelector('#file');
        const button = form.querySelector('button');
        const result = document.querySelector('#result');

        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const file = input.files[0];
          if (!file) return;
          button.disabled = true;
          result.style.display = 'block';
          result.textContent = 'アップロード中…';

          try {
            const create = await fetch('/files', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                filename: file.name,
                contentType: file.type || 'application/octet-stream',
              }),
            });
            const data = await create.json();
            if (!create.ok) throw new Error(data.error || 'アップロード先を作成できませんでした');

            const upload = await fetch(data.upload.url, {
              method: data.upload.method,
              headers: data.upload.headers,
              body: file,
            });
            if (!upload.ok) throw new Error('R2 へのアップロードに失敗しました');

            const fileUrl = new URL(data.url, location.href).href;
            result.replaceChildren();
            const link = document.createElement('a');
            link.href = fileUrl;
            link.textContent = fileUrl;
            link.target = '_blank';
            link.rel = 'noreferrer';
            result.append('完了: ', link);
            if (file.type.startsWith('image/')) {
              const preview = document.createElement('img');
              preview.id = 'preview';
              preview.src = fileUrl;
              preview.alt = file.name;
              result.append(preview);
            }
          } catch (error) {
            result.textContent = error instanceof Error ? error.message : 'アップロードに失敗しました';
          } finally {
            button.disabled = false;
          }
        });
      </script>
    </body>
  </html>`;

export default app;
