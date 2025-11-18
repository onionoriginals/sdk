import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

export async function setupVite(app: Express, server: Server) {
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };

  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  
  // Serve static files from public directory in development too
  // This allows files like /<userId>/did.jsonl to be served from public/<userId>/did.jsonl
  // Use same path resolution as webvh-integration.ts (process.cwd())
  const publicPath = path.join(process.cwd(), "public");
  if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath, {
      index: false, // Don't serve index.html for all routes
    }));
  }
  
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${Date.now()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  // Vite builds to dist/public/, so we need to serve from there
  // When running from root (Railway), process.cwd() is /app
  // When running from app dir (local dev), process.cwd() is apps/originals-explorer
  // Check if we're running from root by looking for apps/originals-explorer directory
  const cwd = process.cwd();
  const isRoot = fs.existsSync(path.join(cwd, "apps", "originals-explorer"));
  const distPath = isRoot 
    ? path.join(cwd, "apps", "originals-explorer", "dist", "public")
    : path.join(cwd, "dist", "public");
  const publicPath = isRoot
    ? path.join(cwd, "apps", "originals-explorer", "public")
    : path.join(cwd, "public");

  // Serve static files from dist/public (built assets)
  if (fs.existsSync(distPath)) {
    app.use(express.static(distPath, {
      // Don't serve index.html for all routes - only for SPA fallback
      index: false,
    }));
  }

  // Also serve from public directory for DID logs and other static files
  // This allows files like /<userId>/did.jsonl to be served from public/<userId>/did.jsonl
  if (!fs.existsSync(publicPath)) {
    // Create public directory if it doesn't exist (for DID logs)
    fs.mkdirSync(publicPath, { recursive: true });
  }
  app.use(express.static(publicPath, {
    index: false, // Don't serve index.html for all routes
  }));

  // fall through to index.html if the file doesn't exist (SPA fallback)
  app.use("*", (_req, res) => {
    const indexPath = path.resolve(distPath, "index.html");
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send("Not found: index.html not found in dist/public");
    }
  });
}
