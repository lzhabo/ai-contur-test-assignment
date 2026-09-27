import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, expect, it } from "vitest";
import { installFrontendFallback } from "../../src/server/http/frontend.js";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function serve(root: string): Promise<string> {
  const app = express();
  installFrontendFallback(app, root);
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No HTTP port");
  return `http://127.0.0.1:${address.port}`;
}

it("serves built assets with explicit MIME and falls back to index for SPA routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-dist-")); roots.push(root);
  await writeFile(join(root, "index.html"), "<main>app</main>");
  await writeFile(join(root, "app.js"), "window.ready = true;");
  await writeFile(join(root, "blob.bin"), Buffer.from([0, 1, 255]));
  const base = await serve(root);
  const js = await fetch(`${base}/app.js`);
  expect(js.headers.get("content-type")).toContain("text/javascript");
  expect(await js.text()).toBe("window.ready = true;");
  const binary = await fetch(`${base}/blob.bin`);
  expect(binary.headers.get("content-type")).toBe("application/octet-stream");
  expect(Buffer.from(await binary.arrayBuffer())).toEqual(Buffer.from([0, 1, 255]));
  const spa = await fetch(`${base}/tasks/example`);
  expect(spa.headers.get("content-type")).toContain("text/html");
  expect(await spa.text()).toBe("<main>app</main>");
  const api = await fetch(`${base}/api/unknown`);
  expect(api.status).toBe(404);
  expect(await api.json()).toEqual({ code: "not_found", message: "Unknown API route" });
});

it("returns 503 when the frontend build is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-no-dist-")); roots.push(root);
  const base = await serve(root);
  const response = await fetch(base);
  expect(response.status).toBe(503);
  expect(await response.text()).toBe("Frontend build is unavailable; run npm run build");
});

it("does not follow an asset symlink outside dist", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-dist-link-")); roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(dist, "index.html"), "<main>app</main>");
  await writeFile(join(root, "private.txt"), "secret outside dist");
  await symlink(join(root, "private.txt"), join(dist, "leak.txt"));
  const base = await serve(dist);
  const response = await fetch(`${base}/leak.txt`);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("secret outside dist");
});

it("does not follow a fallback index symlink outside dist", async () => {
  const root = await mkdtemp(join(tmpdir(), "loop-index-link-")); roots.push(root);
  const dist = join(root, "dist");
  await mkdir(dist);
  await writeFile(join(root, "private.html"), "secret outside dist");
  await symlink(join(root, "private.html"), join(dist, "index.html"));
  const base = await serve(dist);
  const response = await fetch(`${base}/some/spa/route`);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("secret outside dist");
});
