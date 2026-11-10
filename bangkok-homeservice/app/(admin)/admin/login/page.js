export const dynamic = "force-dynamic";
import {redirect} from "next/navigation";
import {getIdentityAccess} from "#lib/http/identity-access.js";

import { Form } from "../../../_ui/client.js";

export default function AdminLoginPage() {
  if(getIdentityAccess())redirect("/api/auth/keycloak/start");
  return (
    <div style={{ maxWidth: 420 }}>
      <h1>Admin log in</h1>
      <Form
        endpoint="/api/auth/admin/login"
        redirectTo="/admin/providers"
        submitLabel="Log in"
        fields={[
          { name: "email", label: "Email", type: "email", default: "admin@edemand.test" },
          { name: "password", label: "Password", type: "password" },
        ]}
      />
      <p className="small muted" style={{ marginTop: 12 }}>Seeded: admin@edemand.test / eDemand-2026!</p>
    </div>
  );
}
