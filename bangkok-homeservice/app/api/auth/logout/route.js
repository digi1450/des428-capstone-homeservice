export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import {getIdentityAccess} from "#lib/http/identity-access.js";
import { getAuth, clearCookie } from "#lib/http/auth.js";

export const POST = handle(async (req) => {
  if(getIdentityAccess())return getIdentityAccess().logout(req);
  getAuth(req); // any authenticated user
  return json({ ok: true }, { status: 200, headers: { "Set-Cookie": clearCookie() } });
});
