import { Router } from "express";
import { createPaymentsService } from "./service.js";
import { HttpError } from "./errors.js";
import { principal } from "./validation.js";
export function createPaymentsRouter({ database, authenticate }) {
  const router = Router();
  const payments = createPaymentsService(database);
  router.use(async (req,_res,next) => {
    if (typeof authenticate !== "function") throw new HttpError(503,"authentication not configured");
    req.principal = principal(await authenticate(req));
    next();
  });
  router.get("/provider/wallet",async (req,res) => res.json(await payments.getWallet(req.principal)));
  router.get("/customer/transactions",async (req,res) => res.json(await payments.listCustomerTransactions(req.principal)));
  return router;
}
