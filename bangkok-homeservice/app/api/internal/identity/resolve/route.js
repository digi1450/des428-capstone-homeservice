// Identity-owner endpoint. Service-only authentication; no end-user headers are trusted.
import { timingSafeEqual } from "node:crypto";
import { createIdentityMappingStore } from "#lib/security/identity-mapping.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request,secret) {
 const value=request.headers.get("authorization") || "";
 if (!secret || !value.startsWith("Bearer ")) return false;
 const actual=Buffer.from(value.slice(7)), expected=Buffer.from(secret);
 return actual.length===expected.length && timingSafeEqual(actual,expected);
}
export async function POST(request) {
 const secret=process.env.IDENTITY_RESOLVER_TOKEN;
 if (!secret) return Response.json({error:"unavailable"},{status:503});
 if (!authorized(request,secret)) return Response.json({error:"unauthorized"},{status:401});
 const path=process.env.IDENTITY_MAPPING_DB_PATH;
 if (!path) return Response.json({error:"unavailable"},{status:503});
 let input;
 try {
   if (Number(request.headers.get("content-length") || 0)>4096) return Response.json({error:"invalid request"},{status:400});
   input=await request.json();
   if (!input || typeof input!=="object" || Array.isArray(input) ||
       Object.keys(input).sort().join(",")!=="issuer,sub") throw Error("invalid body");
 } catch { return Response.json({error:"invalid request"},{status:400}); }
 let store;
 try {
   store=createIdentityMappingStore({path});
   const identity=store.lookup(input);
   if (!identity) return Response.json({error:"not found"},{status:404});
   return Response.json(identity,{headers:{"Cache-Control":"no-store"}});
 } catch {
   return Response.json({error:"unavailable"},{status:503});
 } finally { store?.close(); }
}
