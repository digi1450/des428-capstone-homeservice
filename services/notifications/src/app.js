import express from "express";
import { randomUUID } from "node:crypto";
import { serviceName } from "./config.js";

export function createApp({ database }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.set("X-Request-Id", req.requestId);
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/health/live", (_req, res) => res.json({ service: serviceName, status: "alive" }));
  app.get("/health/ready", async (req, res) => {
    try {
      await database.checkReady();
      res.json({ service: serviceName, status: "ready" });
    } catch {
      res.status(503).json({ service: serviceName, status: "not_ready", requestId: req.requestId });
    }
  });
  // Business endpoints remain unmounted until A's implementations and B's
  // token validation are ready. Contract fixtures must never be served as writes.
  app.use((req, res) => res.status(404).json({ error: "NOT_FOUND", requestId: req.requestId }));
  return app;
}
