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
