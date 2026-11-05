import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { glyphRequestOptions, tileRequestOptions, createAssetLimiter } from "./asset-security";
import { registerTileRoutes } from "./http/tiles";

vi.mock("./logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock("fs", async () => {
  const { Readable } = await import("node:stream");
  return {
    statSync: vi.fn(() => ({ size: 8 })),
    createReadStream: vi.fn((_path: string, range?: { start: number; end: number }) => {
      const bytes = Buffer.from("abcdefgh");
      return Readable.from([range ? bytes.subarray(range.start, range.end + 1) : bytes]);
    }),
  };
});

afterEach(() => vi.unstubAllEnvs());

async function withHttp(app: express.Express, run: (base: string) => Promise<void>) {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
}

describe("fixed-authority map requests", () => {
  it("preserves normal and multi-font glyph stacks", () => {
    for (const font of ["Noto Sans Regular", "Noto Sans Regular,Noto Sans Bold", "Noto Sans CJK SC Regular"]) {
      const options = glyphRequestOptions(`/${encodeURIComponent(font)}/0-255.pbf`)!;
      expect(options).toMatchObject({ protocol: "https:", hostname: "protomaps.github.io", port: 443 });
      expect(options.path).toBe(`/basemaps-assets/fonts/${encodeURIComponent(font)}/0-255.pbf`);
    }
    expect(glyphRequestOptions("/Noto/65280-65535.pbf")).not.toBeNull();
  });
  it.each([
    "//evil.example/0-255.pbf", "/../0-255.pbf", "/%2e%2e/0-255.pbf",
    "/%2f%2fevil.example/0-255.pbf", "/%252e%252e/0-255.pbf",
    "/Noto%5c..%5csecret/0-255.pbf", "/Noto%0d%0aHost/0-255.pbf",
    "/Noto%3furl/0-255.pbf", "/Noto/1-256.pbf", "/Noto/0-65535.pbf",
    "/Noto/65536-65791.pbf", "/Noto/0-255.pbf/extra", "/%ZZ/0-255.pbf",
  ])("rejects unsafe glyph path %s", (path) => {
    expect(glyphRequestOptions(path)).toBeNull();
  });
  it("keeps tile hosts and ports independent from client input", () => {
    expect(tileRequestOptions("/data/kaliningrad.json", true)).toMatchObject({
      hostname: "host.docker.internal", port: 8080, path: "/data/kaliningrad.json",
    });
    expect(tileRequestOptions("/data/kaliningrad/1/2/3.pbf", false)).toMatchObject({
      hostname: "localhost", port: 8080, path: "/data/kaliningrad/1/2/3.pbf",
    });
  });
  it.each([
    "http://evil.example/a", "//evil.example/a", "/../secret", "/data/%2e%2e/secret",
    "/data/%252e%252e/secret", "/data/%5csecret", "/data/%0d%0aHost",
    "/data/a?url=http://evil.example", "/data/a#fragment", "/data/%ZZ", "/",
  ])("rejects unsafe tile path %s", (path) => {
    expect(tileRequestOptions(path, true)).toBeNull();
  });
});

describe("asset limiter enforcement", () => {
  it("cannot be disabled in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    const app = express();
    app.get("/", createAssetLimiter(2), (_req, res) => res.send("ok"));
    await withHttp(app, async (base) => {
      expect((await fetch(base)).status).toBe(200);
      expect((await fetch(base)).status).toBe(200);
      const blocked = await fetch(base);
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get("retry-after")).not.toBeNull();
    });
  });
  it("preserves the explicit non-production smoke-test bypass", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("DISABLE_RATE_LIMIT", "1");
    const app = express();
    app.get("/", createAssetLimiter(1), (_req, res) => res.send("ok"));
    await withHttp(app, async (base) => {
      expect((await fetch(base)).status).toBe(200);
      expect((await fetch(base)).status).toBe(200);
    });
  });
});

describe("PMTiles range regression", () => {
  it("preserves full, partial, clamped and invalid range responses on all three maps", async () => {
    const app = express();
    registerTileRoutes(app);
    await withHttp(app, async (base) => {
      for (const path of ["/kaliningrad.pmtiles", "/addresses.pmtiles", "/addresses-v2.pmtiles"]) {
        const full = await fetch(base + path);
        expect(full.status).toBe(200);
        expect(await full.text()).toBe("abcdefgh");
        expect(full.headers.get("accept-ranges")).toBe("bytes");
        const partial = await fetch(base + path, { headers: { Range: "bytes=2-4" } });
        expect(partial.status).toBe(206);
        expect(partial.headers.get("content-range")).toBe("bytes 2-4/8");
        expect(await partial.text()).toBe("cde");
        const clamped = await fetch(base + path, { headers: { Range: "bytes=6-999" } });
        expect(clamped.status).toBe(206);
        expect(await clamped.text()).toBe("gh");
        const open = await fetch(base + path, { headers: { Range: "bytes=5-" } });
        expect(open.status).toBe(206);
        expect(await open.text()).toBe("fgh");
        for (const range of ["garbage", "bytes=8-9", "bytes=4-2", "bytes=-3"]) {
          const invalid = await fetch(base + path, { headers: { Range: range } });
          expect(invalid.status).toBe(416);
          expect(invalid.headers.get("content-range")).toBe("bytes */8");
        }
      }
    });
  });
});
