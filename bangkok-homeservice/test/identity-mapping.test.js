import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityMappingStore } from "../lib/security/identity-mapping.js";
import { getDb, closeDb } from "../lib/db/index.js";
import { migrate } from "../lib/db/migrate.js";

const issuer="https://id.example.test/realms/homeservice";
test("mapping keeps existing legacy IDs, rejects duplicates and cross-role rebind",()=>{
 process.env.NODE_ENV="test";
 process.env.DB_PATH=":memory:";
 const db=getDb();
 migrate(db);
 db.prepare("INSERT INTO customers (id,email,password_hash,name) VALUES (?,?,?,?)").run(42,"mapping-customer@example.test","not-used","Test");
 db.prepare("INSERT INTO providers (id,email,password_hash,name) VALUES (?,?,?,?)").run(17,"mapping-provider@example.test","not-used","Test");
 const store=createIdentityMappingStore({path:":memory:"});
 try {
  assert.deepEqual(store.provision({issuer,sub:"keycloak-sub-1",role:"customer",domainId:42}),{role:"customer",domainId:42});
  assert.deepEqual(store.lookup({issuer,sub:"keycloak-sub-1"}),{role:"customer",domainId:42});
  assert.equal(store.lookup({issuer,sub:"missing"}),null);
  assert.throws(()=>store.provision({issuer,sub:"keycloak-sub-2",role:"customer",domainId:42}));
  assert.throws(()=>store.provision({issuer,sub:"keycloak-sub-1",role:"provider",domainId:17}));
  assert.throws(()=>store.provision({issuer,sub:"unknown-domain",role:"admin",domainId:1}));
  assert.throws(()=>store.provision({issuer:"http://unsafe.example/realms/homeservice",sub:"bad",role:"customer",domainId:42}));
  db.prepare("DELETE FROM customers WHERE id=42").run();
  assert.equal(store.lookup({issuer,sub:"keycloak-sub-1"}),null);
 } finally {store.close();closeDb();}
});
