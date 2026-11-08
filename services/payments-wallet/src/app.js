import express from "express";
import {paymentRequestContext} from "./request-context.js";
import { randomUUID } from "node:crypto";
import { serviceName } from "./config.js";
import { createPaymentCommandRouter } from "./command-router.js";
import { createPaymentsRouter } from "./router.js";
import { createFinancialRouter } from "./financial-router.js";
import { createPaymentsService } from "./service.js";
import { errorHandler } from "./errors.js";
import { context, trace, isSpanContextValid } from "@opentelemetry/api";

// Area E — Prometheus metrics
import { metricsMiddleware, metricsHandler } from "./metrics.js";

export function createApp({ database, authenticate, authenticateService, paymentCommands, paymentHooks, financialOperations, authenticateWebhook }) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const incoming = req.get("x-request-id");
    req.requestId = incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.set("X-Request-Id", req.requestId);
    res.set("Cache-Control", "no-store");
    next();
  });

  app.use(paymentRequestContext);

  // Added structured HTTP request logging with correlation ID (E) start
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();

    // Area E - Capture the active OpenTelemetry trace ID
    const spanContext = trace.getSpan(context.active())?.spanContext();
    const traceId =
      spanContext && isSpanContextValid(spanContext)
        ? spanContext.traceId
        : null;

    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;

      console.log(JSON.stringify({
        event: "http_request",
        service: serviceName,
        requestId: req.requestId,
        traceId,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(2))
      }));
    });

    next();
  });
  // (E) end

  // Area E — Prometheus metrics integration start
  app.use(metricsMiddleware);
  app.get("/metrics", metricsHandler);
  // Area E — Prometheus metrics integration end

  app.get("/health/live", (_req, res) => res.json({ service: serviceName, status: "alive" }));
  app.get("/health/ready", async (req, res) => {
    try {
      await database.checkReady();
      res.json({ service: serviceName, status: "ready" });
    } catch {
      res.status(503).json({ service: serviceName, status: "not_ready", requestId: req.requestId });
    }
  });
  app.use(createFinancialRouter({authenticateService,financialOperations,authenticateWebhook,payments:createPaymentsService(database,paymentHooks)}));
  app.use("/api", createPaymentsRouter({ database, authenticate, paymentHooks }));
  app.use("/internal", createPaymentCommandRouter({ authenticateService, paymentCommands }));
  // Internal command HTTP is a fail-closed B/C seam, not a participant implementation.
  // Simulated settlement requires separately injected C hooks; completion/refund cutover and live saga activation remain pending.
  app.use((req, res) => res.status(404).json({ error: "NOT_FOUND", requestId: req.requestId }));
  app.use(errorHandler);
  return app;
}
