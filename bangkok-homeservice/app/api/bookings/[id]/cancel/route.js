export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import {cancelBookingFinancial,getBookingFinancialAccess} from "#lib/modules/booking/financial-access.js";
import {readFinancialJson} from "#lib/http/financial-json.js";
import {BadRequestError} from "#lib/errors.js";

export const POST = handle(async (req, { params }) => {
  const auth = getAuth(req, "customer");
  if(getBookingFinancialAccess()){const input=await readFinancialJson(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new BadRequestError('empty cancellation body required');}
  const result=await cancelBookingFinancial(parseId(params.id, 'booking id'),auth,req);
  return json(result,{status:result.cancellation_status==='pending'?202:result.cancellation_status==='attention'?409:200});
});
