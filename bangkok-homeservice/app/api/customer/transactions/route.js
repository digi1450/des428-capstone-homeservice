export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { handle } from "#lib/http/handle.js";
import { json } from "#lib/http/respond.js";
import { getAuth } from "#lib/http/auth.js";
import { getTransactionView } from "#lib/modules/payments/access.js";
import { fetchAsOidcUser } from "#lib/security/oidc-service-fetch.js";
import { getServerOidcSession } from "#lib/security/oidc-server-session.js";

export const GET = handle(async (req) => {
  if(process.env.AREA_B_PAYMENTS_PROXY==="true"){
    try{
      const session=getServerOidcSession(req);
      if(!session)return json({error:"unauthorized"},{status:401});
      if(session.role!=="customer")return json({error:"forbidden"},{status:403});
      const response=await fetchAsOidcUser(req,{service:"payments-wallet",url:"/api/customer/transactions"});
      if(!response.ok)return json({error:"payment request failed"},{status:[401,403,404].includes(response.status)?response.status:503});
      return json(await response.json());
    }catch{return json({error:"payment authentication unavailable"},{status:503});}
  }
  const auth=getAuth(req,"customer");
  return json(await getTransactionView(auth,req));
});
