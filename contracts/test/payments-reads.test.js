import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
const specUrl=new URL("../payments-reads.openapi.json",import.meta.url);
const spec=JSON.parse(await readFile(specUrl,"utf8"));
const fixtures=JSON.parse(await readFile(new URL("../fixtures/payments-reads.json",import.meta.url),"utf8"));
const ajv=new Ajv({strict:false});
ajv.addFormat("int32",{type:"number",validate:n=>Number.isInteger(n)&&n>=-2147483648&&n<=2147483647});
ajv.addFormat("date-time",value=>/^\d{4}-\d{2}-\d{2}T/.test(value)&&Number.isFinite(Date.parse(value)));
const validate=ajv.compile({$ref:"#/components/schemas/Wallet",components:spec.components});
test("Payments reads OpenAPI is valid",async()=>{await SwaggerParser.validate(fileURLToPath(specUrl));});
test("wallet/history fixtures keep public numeric/ISO/null types",()=>{
  assert.ok(validate(fixtures.wallet),JSON.stringify(validate.errors));
  assert.ok(validate(fixtures.empty),JSON.stringify(validate.errors));
});
test("wallet contract rejects private ledger context, negative balances and string amounts",()=>{
  assert.equal(validate({...fixtures.wallet,balance_cents:-1}),false);
  assert.equal(validate({...fixtures.wallet,balance_cents:"900"}),false);
  assert.equal(validate({...fixtures.wallet,transactions:[{...fixtures.wallet.transactions[0],context_json:{private:true}}]}),false);
});
