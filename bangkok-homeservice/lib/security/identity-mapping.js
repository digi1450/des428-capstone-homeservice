// Monolith-owned Keycloak -> legacy identity binding. Separate SQLite file deliberately
// avoids changing the fingerprinted legacy schema or querying other services' databases.
import Database from "better-sqlite3";
import { getDb } from "../db/index.js";

const roles = Object.freeze({ customer: "customers", provider: "providers", admin: "admins" });
const validId = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const validIssuer = value => {\n  if (typeof value !== "string") return false;\n  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && /^\\/realms\\/[^/]+$/.test(url.pathname) && url.href === value; } catch { return false; }\n};
const validSubject = value => typeof value === "string" && value.length >= 1 && value.length <= 255 && !/[\x00-\x1f]/.test(value);

export function createIdentityMappingStore({ path } = {}) {
  if (!path || (path === ":memory:" && process.env.NODE_ENV !== "test")) throw new Error("IDENTITY_MAPPING_DB_PATH required");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS keycloak_identity_bindings (
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('customer','provider','admin')),
    domain_id INTEGER NOT NULL CHECK(domain_id BETWEEN 1 AND 2147483647),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (issuer,subject),
    UNIQUE (role,domain_id)
  )`);
  function existingDomain(role, domainId) {
    if (!Object.hasOwn(roles,role) || !validId(domainId)) return false;
    return Boolean(getDb().prepare(`SELECT 1 FROM ${roles[role]} WHERE id = ?`).get(domainId));
  }
  function lookup({issuer,sub}) {
    if (!validIssuer(issuer) || !validSubject(sub)) return null;
    const found = db.prepare("SELECT role,domain_id FROM keycloak_identity_bindings WHERE issuer=? AND subject=?").get(issuer,sub);
    if (!found || !existingDomain(found.role,found.domain_id)) return null;
    return {role:found.role,domainId:found.domain_id};
  }
  function provision({issuer,sub,role,domainId}) {
    if (!validIssuer(issuer) || !validSubject(sub) || !existingDomain(role,domainId))
      throw new TypeError("Valid issuer, subject and existing domain identity required");
    // Never silently overwrite a mapping or reassign an existing legacy identity.
    const insert=db.prepare("INSERT INTO keycloak_identity_bindings(issuer,subject,role,domain_id) VALUES(?,?,?,?)");
    insert.run(issuer,sub,role,domainId);
    return {role,domainId};
  }
  return {lookup,provision,close:()=>db.close()};
}
