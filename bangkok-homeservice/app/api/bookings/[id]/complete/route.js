export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parse, parseId, readJson } from "#lib/http/validate.js";
import {completeBookingFinancial,getBookingFinancialAccess} from "#lib/modules/booking/financial-access.js";
import {readFinancialJson} from "#lib/http/financial-json.js";

// OTP is required and must be the 6-digit code the customer holds.
const schema = z.object({ otp: z.coerce.number().int() });

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, "provider");
  const { otp } = parse(getBookingFinancialAccess()?z.object({otp:z.number().int().min(100000).max(999999)}).strict():schema, await (getBookingFinancialAccess()?readFinancialJson(req):readJson(req)));
  return json(await completeBookingFinancial(parseId(params.id, "booking id"), auth, otp, req));
});
