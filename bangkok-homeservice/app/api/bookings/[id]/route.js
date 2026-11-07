export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { parseId } from "#lib/http/validate.js";
import { getBookingView } from "#lib/modules/booking/payment-view.js";

export const GET = handle(async (req, { params }) => {
  const auth = getAuth(req, ["customer", "provider"]);
  return json(await getBookingView(parseId(params.id, "booking id"), auth, req));
});
