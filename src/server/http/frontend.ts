import { readFile, realpath } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import type { Express } from "express";

const mimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

export function installFrontendFallback(app: Express, distRoot: string): void {
  app.use(async (request, response) => {
    if (request.originalUrl.startsWith("/api/")) {
      response.status(404).json({ code: "not_found", message: "Unknown API route" });
      return;
    }
    const requested = new URL(request.originalUrl, "http://localhost").pathname;
    const candidate = resolve(distRoot, `.${requested}`);
    const withinRoot = (file: string, root: string) => {
      const pathFromRoot = relative(root, file);
      return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`);
    };
    if (!withinRoot(candidate, distRoot)) {
      response.status(404).send("Not found");
      return;
    }
    try {
      const actualRoot = await realpath(distRoot);
      const actualCandidate = await realpath(candidate);
      if (!withinRoot(actualCandidate, actualRoot)) {
        response.status(404).send("Not found");
        return;
      }
      const file = await readFile(actualCandidate);
      response.type(mimeTypes[extname(candidate)] ?? "application/octet-stream").send(file);
    } catch {
      try {
        const actualRoot = await realpath(distRoot);
        const actualIndex = await realpath(resolve(distRoot, "index.html"));
        if (!withinRoot(actualIndex, actualRoot)) {
          response.status(404).send("Not found");
          return;
        }
        const html = await readFile(actualIndex);
        response.type(mimeTypes[".html"]).send(html);
      } catch {
        response.status(503).send("Frontend build is unavailable; run npm run build");
      }
    }
  });
}
