#!/usr/bin/env bash
# Grant API read roles only to a previously provisioned human user.
# Requires an authenticated kcadm.sh session; does not create users or passwords.
set -euo pipefail
: "${KEYCLOAK_USERNAME:?Set KEYCLOAK_USERNAME to an existing human Keycloak username}"
KCADM="${KCADM:-kcadm.sh}"
REALM="${KEYCLOAK_REALM:-homeservice}"
if [[ "$KEYCLOAK_USERNAME" == service-account-* ]]; then
  echo "Refusing to grant human API roles to a service account" >&2
  exit 1
fi
"$KCADM" get users -r "$REALM" -q "username=$KEYCLOAK_USERNAME" --fields username --format csv --noquotes | grep -Fxq "$KEYCLOAK_USERNAME" || {
 echo "Keycloak user not found: $KEYCLOAK_USERNAME" >&2; exit 1;
}
"$KCADM" add-roles -r "$REALM" --uusername "$KEYCLOAK_USERNAME" --cclientid notifications-service --rolename user:read
"$KCADM" add-roles -r "$REALM" --uusername "$KEYCLOAK_USERNAME" --cclientid payments-wallet-service --rolename user:read
echo "Granted API read roles to $KEYCLOAK_USERNAME. Confirm role scopes and signed access-token resource_access before cutover."
