import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";

const specUrl = new URL("../payment-intents.openapi.json", import.meta.url);
const spec = JSON.parse(await readFile(specUrl, "utf8"));
const fixtures = JSON.parse(await readFile(new URL("../fixtures/payment-intents.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addFormat("int32", { type: "number", validate: value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 });
function validator(name) {
  return ajv.compile({ $ref: "#/components/schemas/" + name, components: spec.components });
}

test("draft payment provisioning document is valid OpenAPI 3", async () => {
  await SwaggerParser.validate(specUrl.pathname);
});

test("create/cancel and outcome fixtures conform to the draft contract", () => {
  for (const [schema, value] of [
    ["CreatePaymentIntent", fixtures.create.body], ["CreatedOperation", fixtures.created],
    ["CancelPaymentIntent", fixtures.cancel.body], ["CancelledOperation", fixtures.cancelled],
    ["Error", fixtures.pending],
  ]) {
    const validate = validator(schema);
    assert.ok(validate(value), JSON.stringify(validate.errors));
  }
  assert.notEqual(fixtures.create.headers["Idempotency-Key"], fixtures.cancel.headers["Idempotency-Key"]);
  assert.equal(fixtures.created.create_command_id, fixtures.create.headers["Idempotency-Key"]);
  assert.equal(fixtures.cancel.body.create_command_id, fixtures.created.create_command_id);
});

test("contract rejects negative money, unknown fields and invalid command identity", () => {
  const create = validator("CreatePaymentIntent");
  assert.equal(create({ ...fixtures.create.body, amount_cents: -1 }), false);
  assert.equal(create({ ...fixtures.create.body, amount_cents: 2147483648 }), false);
  assert.equal(create({ ...fixtures.create.body, raw_role: "admin" }), false);
  assert.equal(create({ ...fixtures.create.body, saga_id: "" }), false);
});

test("command/saga contract rejects URL dot segments without banning normal dotted IDs",()=>{
  const createBody=validator("CreatePaymentIntent");
  const createdBody=validator("CreatedOperation");
  const cancelBody=validator("CancelPaymentIntent");
  const keySchemas=[
    spec.paths["/internal/payment-intents"].post.parameters[0].schema,
    spec.paths["/internal/payment-intents/cancel-by-command"].post.parameters[0].schema,
    spec.paths["/internal/payment-operations/{create_command_id}"].get.parameters[0].schema,
  ];
  for(const dot of [".",".."]) {
    assert.equal(createBody({...fixtures.create.body,saga_id:dot}),false);
    assert.equal(createdBody({...fixtures.created,create_command_id:dot}),false);
    assert.equal(cancelBody({...fixtures.cancel.body,create_command_id:dot}),false);
    for(const schema of keySchemas)assert.equal(ajv.compile(schema)(dot),false);
  }
  for(const schema of keySchemas)assert.equal(ajv.compile(schema)("..booking-42"),true);
});


test("activation route documents strict request/result, production-unwired state and error separation",()=>{
  const op=spec.paths["/internal/payment-intents/activate-by-command"].post;
  assert.equal(op["x-implementation-status"],"http-implemented-production-unwired");
  for (const status of ["200","400","401","403","409","413","415","503","500"]) assert.ok(op.responses[status]);
  for (const [name,value] of [["ActivatePaymentIntent",fixtures.activate.body],["ActivatedOperation",fixtures.activated],["ConflictError",fixtures.setup_cancelled],["ConflictError",fixtures.pending]]) {
    const validate=validator(name);assert.ok(validate(value),JSON.stringify(validate.errors));
  }
  assert.equal(new Set([fixtures.create,fixtures.cancel,fixtures.activate].map(x=>x.headers["Idempotency-Key"])).size,3);
});
test("activation and coded conflict schemas reject unknown fields and unreviewed codes",()=>{
  const body=validator("ActivatePaymentIntent"), result=validator("ActivatedOperation"), conflict=validator("ConflictError");
  for (const bad of [{...fixtures.activate.body,reason:"extra"},{...fixtures.activate.body,saga_id:".."},{create_command_id:fixtures.created.create_command_id}]) assert.equal(body(bad),false);
  assert.equal(result({...fixtures.activated,outcome:"created"}),false);
  assert.equal(result({...fixtures.activated,replayed:true}),false);
  assert.equal(conflict({...fixtures.setup_cancelled,code:"UNREVIEWED"}),false);
  assert.equal(conflict({...fixtures.setup_cancelled,secret:"private"}),false);
});
