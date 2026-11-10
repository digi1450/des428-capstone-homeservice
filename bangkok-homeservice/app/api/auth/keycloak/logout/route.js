export const runtime="nodejs";
export const dynamic="force-dynamic";
import {logoutOidcSession} from "#lib/security/oidc-logout.js";
export const POST=request=>logoutOidcSession(request);
