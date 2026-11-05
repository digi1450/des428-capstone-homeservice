import { Router } from "express";
import { HttpError } from "./errors.js";
import { principalOf, positiveId } from "./validation.js";

export function createNotificationsRouter({ notifications, authenticate }) {
  const router = Router();
  router.use(async (req, _res, next) => {
    // No default/header-based trust path. Runtime remains closed until B wires
    // a real verifier from server.js into createApp({ authenticate }).
    if (typeof authenticate !== "function") throw new HttpError(503, "authentication not configured");
    req.principal = principalOf(await authenticate(req));
    next();
  });
  router.get("/", async (req, res) => res.json(await notifications.listForUser(req.principal)));
  router.post("/:id/read", async (req, res) => {
    const id = /^\d+$/.test(req.params.id) ? Number(req.params.id) : NaN;
    res.json(await notifications.markRead(positiveId(id, "notification id"), req.principal));
  });
  return router;
}
