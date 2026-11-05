import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv from "ajv";
import { fileURLToPath } from "node:url";

const specUrl = new URL("../notifications.openapi.json", import.meta.url);
const spec = JSON.parse(await readFile(specUrl, "utf8"));
const fixtures = JSON.parse(await readFile(new URL("../fixtures/notifications.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false });
ajv.addFormat("int32", { type: "number", validate: value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647 });
ajv.addFormat("date-time", value => /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
const validate = ajv.compile({ $ref: "#/components/schemas/Notification", components: spec.components });

test("Notifications document is valid OpenAPI 3", async () => {
  await SwaggerParser.validate(fileURLToPath(specUrl));
});
test("notification fixtures retain public field types and ISO date/null semantics", () => {
  assert.ok(validate(fixtures.unread), JSON.stringify(validate.errors));
  assert.ok(validate(fixtures.read), JSON.stringify(validate.errors));
});
test("notification contract rejects private recipient fields, string IDs and malformed dates", () => {
  assert.equal(validate({ ...fixtures.unread, recipient_id: 9 }), false);
  assert.equal(validate({ ...fixtures.unread, id: "1" }), false);
  assert.equal(validate({ ...fixtures.unread, created_at: "yesterday" }), false);
});
