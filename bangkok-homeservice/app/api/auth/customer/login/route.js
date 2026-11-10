import {getIdentityAccess} from "#lib/http/identity-access.js";
import {ConflictError} from "#lib/errors.js";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { z } from "zod";
import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { parse, readJson } from "#lib/http/validate.js";
import { tokenCookie } from "#lib/http/auth.js";
import * as identity from "#lib/modules/identity/service.js";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export const POST = handle(async (req) => {
  if(getIdentityAccess())throw new ConflictError("Use Keycloak login");
  const input = parse(schema, await readJson(req));
  const { token } = identity.loginCustomer(input);
  return json({ token }, { status: 200, headers: { "Set-Cookie": tokenCookie(token) } });
});
