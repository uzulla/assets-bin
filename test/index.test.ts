import { describe, expect, it, vi } from "vitest";

import app from "../src/index";

const signingEnv = {
  R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
  R2_BUCKET_NAME: "assets-bin",
  R2_ACCESS_KEY_ID: "test-access-key",
  R2_SECRET_ACCESS_KEY: "test-secret-key",
};

function env(
  headResult: Partial<R2Object> | null = null,
  extra: Record<string, string> = {},
) {
  return {
    ...signingEnv,
    ...extra,
    FILES: {
      head: vi.fn().mockResolvedValue(headResult),
    } as unknown as R2Bucket,
  };
}

describe("assets-bin", () => {
  it("serves the upload page", async () => {
    const response = await app.request("/", {}, env());

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Assets bin");
  });

  it("creates a signed upload URL", async () => {
    const response = await app.request(
      "/files",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: "画像 1.png",
          contentType: "image/png",
        }),
      },
      env(),
    );

    expect(response.status).toBe(201);
    const result = await response.json<{
      id: string;
      url: string;
      upload: { method: string; url: string; headers: Record<string, string> };
    }>();
    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.url).toBe(`/files/${result.id}`);
    expect(result.upload.method).toBe("PUT");
    expect(result.upload.headers).toEqual({
      "Content-Type": "image/png",
      "x-amz-meta-original-filename": encodeURIComponent("画像 1.png"),
    });
    const uploadUrl = new URL(result.upload.url);
    expect(uploadUrl.pathname).toBe(`/assets-bin/${result.id}`);
    expect(uploadUrl.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(uploadUrl.searchParams.has("X-Amz-Signature")).toBe(true);
    expect(uploadUrl.searchParams.get("X-Amz-SignedHeaders")?.split(";"))
      .toEqual(["content-type", "host", "x-amz-meta-original-filename"]);
  });

  it.each([
    ["text/plain", "text/plain; charset=utf-8"],
    ["text/markdown", "text/markdown; charset=utf-8"],
    ["text/plain; charset=shift_jis", "text/plain; charset=shift_jis"],
    ["application/json", "application/json"],
    ["image/png", "image/png"],
  ])(
    "adds charset=utf-8 to charset-less text types (%s)",
    async (contentType, expected) => {
      const response = await app.request(
        "/files",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: "test.txt", contentType }),
        },
        env(),
      );

      expect(response.status).toBe(201);
      const result = await response.json<{
        upload: { headers: Record<string, string> };
      }>();
      expect(result.upload.headers["Content-Type"]).toBe(expected);
    },
  );

  it.each([
    [{ contentType: "image/png" }, "filename は必須です"],
    [{ filename: "test.png" }, "contentType は必須です"],
    [
      { filename: "../test.png", contentType: "image/png" },
      "filename に使用できない文字が含まれています",
    ],
    [
      { filename: "test.png", contentType: "image/png\r\nevil: yes" },
      "contentType の形式が正しくありません",
    ],
  ])("rejects an invalid upload request", async (body, error) => {
    const response = await app.request(
      "/files",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      env(),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error });
  });

  describe("upload password", () => {
    const uploadBody = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "test.png", contentType: "image/png" }),
    };
    const protectedEnv = () => env(null, { UPLOAD_PASSWORD: "hunter2" });

    it("requires the password when UPLOAD_PASSWORD is set", async () => {
      const response = await app.request("/files", uploadBody, protectedEnv());

      expect(response.status).toBe(401);
      expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");
      expect(await response.json()).toEqual({
        error: "アップロードにはパスワードが必要です",
      });
    });

    it("rejects a wrong password", async () => {
      const response = await app.request(
        "/files",
        {
          ...uploadBody,
          headers: { ...uploadBody.headers, Authorization: "Bearer nope" },
        },
        protectedEnv(),
      );

      expect(response.status).toBe(401);
    });

    it("accepts the correct password", async () => {
      const response = await app.request(
        "/files",
        {
          ...uploadBody,
          headers: { ...uploadBody.headers, Authorization: "Bearer hunter2" },
        },
        protectedEnv(),
      );

      expect(response.status).toBe(201);
    });

    it("does not protect downloads", async () => {
      const response = await app.request(
        "/files/91abbaca-e0e7-4a39-a9b4-7aafa7f1bb09",
        {},
        env({ customMetadata: {} }, { UPLOAD_PASSWORD: "hunter2" }),
      );

      expect(response.status).toBe(302);
    });

    it("shows the password field only when required", async () => {
      const withPassword = await app.request("/", {}, protectedEnv());
      expect(await withPassword.text()).toContain('id="password"');

      const withoutPassword = await app.request("/", {}, env());
      expect(await withoutPassword.text()).not.toContain('id="password"');
    });
  });

  it("rejects malformed JSON", async () => {
    const response = await app.request(
      "/files",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      },
      env(),
    );

    expect(response.status).toBe(400);
  });

  it("rejects an invalid UUID", async () => {
    const response = await app.request("/files/not-a-uuid", {}, env());

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "UUID の形式が正しくありません",
    });
  });

  it("returns 404 until the object exists", async () => {
    const response = await app.request(
      "/files/91abbaca-e0e7-4a39-a9b4-7aafa7f1bb09",
      {},
      env(null),
    );

    expect(response.status).toBe(404);
  });

  it("redirects an existing object to a five-minute signed URL", async () => {
    const response = await app.request(
      "/files/91abbaca-e0e7-4a39-a9b4-7aafa7f1bb09/raw",
      {},
      env({ customMetadata: { "original-filename": "test.png" } }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(location.searchParams.has("X-Amz-Signature")).toBe(true);
  });

  it("uses the original filename for downloads", async () => {
    const response = await app.request(
      "/files/91abbaca-e0e7-4a39-a9b4-7aafa7f1bb09/download",
      {},
      env({
        customMetadata: {
          "original-filename": encodeURIComponent("資料 1.pdf"),
        },
      }),
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.searchParams.get("response-content-disposition")).toContain(
      "filename*=UTF-8''%E8%B3%87%E6%96%99%201.pdf",
    );
  });
});
