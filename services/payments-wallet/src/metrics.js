
import { Registry, Counter, Histogram } from "@prometheus-io/client";

// Area E — HTTP metrics for Prometheus
const register = new Registry();

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
  registers: [register]
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register]
});

export function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();

  res.on("finish", () => {
    const duration = Number(process.hrtime.bigint() - start) / 1e9;

    // Avoid using unique request URLs as metric labels.
    const route = req.route?.path ?? "unmatched";

    httpRequestsTotal.inc({
      method: req.method,
      route,
      status_code: String(res.statusCode)
    });

    httpRequestDuration.observe(
      { method: req.method, route },
      duration
    );
  });

  next();
}

export async function metricsHandler(_req, res) {
  res.set("Content-Type", register.contentType);
  res.send(await register.metrics());
}