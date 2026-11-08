export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, readJson } from "#lib/http/validate.js";
import { config } from "#lib/config.js";
import { UnauthorizedError,BadRequestError } from "#lib/errors.js";
import {remoteWebhookSelected,forwardFinancialWebhook} from "#lib/modules/payments/webhook-access.js";
import {readFinancialJson} from "#lib/http/financial-json.js";
import * as payments from "#lib/modules/payments/service.js";

const schema = z.object({
  gateway_event_id: z.string().min(1),
  type: z.string().min(1),
  gateway_ref: z.string().min(1),
});

// Authenticated by a shared secret header, not JWT — this is a server-to-server callback. Always
// 200 on a valid, well-formed event (including replays); 401 only on a bad secret.
export const POST = handle(async (req) => {
  if(remoteWebhookSelected()){if(new URL(req.url).search)throw new BadRequestError('unexpected callback query');return json(await forwardFinancialWebhook(req,await readFinancialJson(req)));}
  const secret = req.headers.get("x-webhook-secret");
  if (secret !== config.webhookSecret) {
    throw new UnauthorizedError("invalid webhook secret");
  }
  const input = parse(schema, await readJson(req));
  const result = payments.handleWebhook(input);
  return json({ received: true, ...result }, { status: 200 });
});
