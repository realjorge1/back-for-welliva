import cors from "cors";
import express from "express";
import { config, isProduction } from "./config.js";
import { errorHandler } from "./http.js";
import { log } from "./logger.js";
import { router } from "./routes.js";

export function createApp() {
  const app = express();

  const allowAnyOrigin = config.corsOrigin === "*";
  if (allowAnyOrigin && isProduction) {
    // Worth knowing about, but not fatal: the native app sends no Origin header,
    // so CORS never gates it. The JWT check in auth.ts is the real boundary.
    // This matters only if you also ship Welliva on the web.
    log.warn(
      "CORS_ORIGIN is '*' in production. Set it to your web app's origin(s) if you serve Welliva on the web.",
    );
  }

  app.use(
    cors({
      origin: allowAnyOrigin ? true : config.corsOrigin.split(",").map((s) => s.trim()),
      // The app authenticates with a bearer token, not cookies.
      credentials: false,
      allowedHeaders: ["Content-Type", "Authorization"],
      methods: ["GET", "POST"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  // Light request log.
  app.use((req, _res, next) => {
    if (req.path !== "/health") log.info(`${req.method} ${req.path}`);
    next();
  });

  app.use(router);

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Route not found" } });
  });

  app.use(errorHandler);

  return app;
}
