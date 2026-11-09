import assert from "node:assert/strict";
import { CLOSE, parseClientText as validate } from "shared/protocol";
import { test } from "vitest";

const join = { type: "join", v: 1, room: "abc-123", name: "Pilot" };

test("a correct join and chat are accepted", () => {
  assert.deepEqual(validate(JSON.stringify(join)), { ok: true, msg: join });
  assert.equal(validate(JSON.stringify({ type: "chat", text: "hello" })).ok, true);
});

test("broken JSON is a result, not an exception", () => {
  assert.deepEqual(validate("{oops"), {
    ok: false,
    code: CLOSE.BAD_MESSAGE,
    reason: "not json",
  });
});

test("wrong shape is rejected with BAD_MESSAGE", () => {
  for (const raw of ["null", "[]", "42", '"x"', "{}", '{"type":5}']) {
    assert.equal(validate(raw).code, CLOSE.BAD_MESSAGE, raw);
  }
  const bad = [
    { ...join, room: "has space" },
    { ...join, room: "x".repeat(41) },
    { ...join, name: "" },
    { ...join, name: "n".repeat(17) },
    { ...join, name: "line\nbreak" },
    { ...join, extra: 1 },
    { type: "chat", text: "" },
    { type: "chat", text: "x".repeat(201) },
    { type: "chat", text: 5 },
    { type: "chat", text: "ok", extra: true },
  ];
  for (const msg of bad)
    assert.equal(
      validate(JSON.stringify(msg)).code,
      CLOSE.BAD_MESSAGE,
      JSON.stringify(msg),
    );
});

test("unknown type and wrong version have their own codes", () => {
  assert.equal(validate('{"type":"teleport"}').code, CLOSE.UNKNOWN_TYPE);
  assert.equal(validate(JSON.stringify({ ...join, v: 2 })).code, CLOSE.BAD_VERSION);
});

test("limits are inclusive", () => {
  assert.equal(
    validate(JSON.stringify({ type: "chat", text: "x".repeat(200) })).ok,
    true,
  );
  assert.equal(validate(JSON.stringify({ ...join, name: "n".repeat(16) })).ok, true);
});
