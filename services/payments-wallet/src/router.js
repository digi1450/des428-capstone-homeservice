import express, { Router } from "express";
import { createPaymentsService } from "./service.js";
import { HttpError } from "./errors.js";
import { principal, id } from "./validation.js";
export function createPaymentsRouter({ database, authenticate, paymentHooks }) {
  const router = Router();
  const payments = createPaymentsService(database,paymentHooks);
  router.use(async (req,_res,next) => {
    if (typeof authenticate !== "function") throw new HttpError(503,"authentication not configured");
    req.principal = principal(await authenticate(req));
    next();
  });
  router.get("/provider/wallet",async (req,res) => res.json(await payments.getWallet(req.principal)));
  router.get("/customer/transactions",async (req,res) => res.json(await payments.listCustomerTransactions(req.principal)));
  router.get("/booking-payment-intents/:order_id",async(req,res)=>{
    if(!/^[1-9][0-9]*$/.test(req.params.order_id)) throw new HttpError(400,"invalid order id");
    res.json(await payments.getIntentForOrder(id(Number(req.params.order_id)),req.principal));
  });
  router.post("/payments/simulate",(req,_res,next)=>{
    principal(req.principal,"customer");
    if(!req.is("application/json")) throw new HttpError(415,"application/json required");
    next();
  },express.json({limit:"16kb",strict:true,inflate:false}),async(req,res)=>{
    if(!req.body || Array.isArray(req.body) || Object.keys(req.body).length!==1 || !Object.hasOwn(req.body,"order_id")) throw new HttpError(400,"invalid simulation request");
    res.json(await payments.simulateSucceeded(id(req.body.order_id),req.principal));
  });
  router.use((error,_req,_res,next)=>{
    if(error.type==="entity.parse.failed") error=new HttpError(400,"invalid JSON");
    else if(error.type==="entity.too.large") error=new HttpError(413,"request body too large");
    else if(error.type==="encoding.unsupported"||error.type==="charset.unsupported") error=new HttpError(415,"unsupported encoding");
    next(error);
  });
  return router;
}
