import express from "express";
import { randomUUID } from "node:crypto";
import { serviceName } from "./config.js";
import { createNotificationsService } from "./service.js";
import { createNotificationsRouter } from "./router.js";
import { errorHandler } from "./errors.js";

export function createApp({ database, authenticate }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.set("X-Request-Id", req.requestId);
    res.set("Cache-Control", "no-store");
    next();
  });

  // Added structured HTTP request logging with correlation ID (E) start
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

      console.log(JSON.stringify({
        event: "http_request",
        service: serviceName,
        requestId: req.requestId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2))
      }));
    });

    next();
  });
  // end

  app.get("/health/live", (_req, res) => res.json({ service: serviceName, status: "alive" }));
  app.get("/health/ready", async (req, res) => {
    try {
      await database.checkReady();
      res.json({ service: serviceName, status: "ready" });
    } catch {
      res.status(503).json({ service: serviceName, status: "not_ready", requestId: req.requestId });
    }
  });
  app.use("/api/notifications", createNotificationsRouter({
    notifications: createNotificationsService(database), authenticate,
  }));
  app.use((req, res) => res.status(404).json({ error: "NOT_FOUND", requestId: req.requestId }));
  app.use(errorHandler);
  return app;
}
