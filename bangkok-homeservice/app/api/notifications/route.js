export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { listNotifications } from "#lib/modules/notifications/access.js";
import { fetchAsOidcUser } from "#lib/security/oidc-service-fetch.js";
import { getServerOidcSession } from "#lib/security/oidc-server-session.js";

export const GET = handle(async (req) => {
  if (process.env.AREA_B_NOTIFICATIONS_PROXY === "true") {
    try {
      if(!getServerOidcSession(req))return json({error:"unauthorized"},{status:401});
      const response = await fetchAsOidcUser(req,{service:"notifications",url:"/api/notifications"});
      if (!response.ok) return json({error:"notification request failed"},{status:[401,403,404].includes(response.status)?response.status:503});
      return json(await response.json());
    } catch {return json({error:"notification authentication unavailable"},{status:503});}
  }
  const auth = getAuth(req);
  return json(await listNotifications(auth, req));
});
