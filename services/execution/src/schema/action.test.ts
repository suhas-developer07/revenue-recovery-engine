import { test } from "node:test";
import assert from "node:assert/strict";
import { RecoveryActionSchema } from "./action";

// A legitimate, fully-formed authorized action must parse.
const valid = {
  action: "SEND_PAYMENT_LINK",
  target: { order_id: "ord_1", customer_id: "cust_1" },
  channel: "email",
  reasoning: "AFA threshold exceeded — routing to authenticated payment link",
  authorized_by_rule: "AFA_THRESHOLD_EXCEEDED_ROUTES_TO_PAYMENT_LINK",
  attempt_number: 1,
  cooldown_until: null,
};

test("a well-formed authorized RecoveryAction parses", () => {
  const parsed = RecoveryActionSchema.safeParse(valid);
  assert.ok(parsed.success, "expected a valid action to parse");
});

test("accepts channel-less action (defaults to none) and omitted cooldown", () => {
  const payload: Record<string, unknown> = { ...valid };
  delete payload.channel;
  delete payload.cooldown_until;
  const parsed = RecoveryActionSchema.safeParse(payload);
  assert.ok(parsed.success);
  if (parsed.success) {
    assert.equal(parsed.data.channel, "none");
  }
});

// --- zod-invalid actions are rejected, never partially executed -------------

test("rejects an action missing the required target (schema-drift class)", () => {
  const { target, ...rest } = valid;
  const parsed = RecoveryActionSchema.safeParse(rest);
  if (parsed.success) {
    assert.fail("a missing target must be rejected");
    return;
  }
  assert.ok(parsed.error.issues.some((i) => i.path[0] === "target"));
});

test("rejects an unknown action enum value", () => {
  const parsed = RecoveryActionSchema.safeParse({ ...valid, action: "MOVE_MONEY" });
  assert.ok(!parsed.success);
});

test("rejects a non-integer attempt_number", () => {
  const parsed = RecoveryActionSchema.safeParse({ ...valid, attempt_number: 1.5 });
  assert.ok(!parsed.success);
});

test("rejects missing reasoning", () => {
  const { reasoning, ...rest } = valid;
  const parsed = RecoveryActionSchema.safeParse(rest);
  assert.ok(!parsed.success);
});

test("rejects an invalid channel", () => {
  const parsed = RecoveryActionSchema.safeParse({ ...valid, channel: "carrier_pigeon" });
  assert.ok(!parsed.success);
});
