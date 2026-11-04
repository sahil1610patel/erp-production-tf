"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  tenantFor,
  integer,
  money,
  movementDelta,
} = require("../lib/security");
const secret = "a-test-signing-key-at-least-thirty-two-bytes";
const claims = {
  userId: 7,
  tenantId: 2,
  role: "OPERATOR",
  sid: crypto.randomUUID(),
};
test("scrypt uses unique salts and preserves passwords exactly", () => {
  const password = " leading and trailing spaces ";
  const one = hashPassword(password),
    two = hashPassword(password);
  assert.notEqual(one, two);
  assert.equal(verifyPassword(password, one), true);
  assert.equal(verifyPassword(password.trim(), one), false);
  assert.equal(verifyPassword("wrong-password", one), false);
  assert.equal(verifyPassword(password, "malformed"), false);
  assert.throws(() => hashPassword("short"));
});
test("JWT validates signature, algorithm, audience, required claims and exact expiry", () => {
  const token = signJwt(claims, secret, 1000);
  assert.equal(verifyJwt(token, secret, 1001).userId, 7);
  assert.throws(
    () => verifyJwt(token, "wrong-secret", 1001),
    /Invalid or expired/,
  );
  assert.throws(() => verifyJwt(token, secret, 29800), /Invalid or expired/);
  assert.throws(() => verifyJwt(token, secret, 900), /Invalid or expired/);
  const [header, body, signature] = token.split(".");
  assert.throws(() =>
    verifyJwt(
      `${header}.${Buffer.from("{}").toString("base64url")}.${signature}`,
      secret,
      1001,
    ),
  );
  assert.throws(() =>
    verifyJwt(
      signJwt({ ...claims, role: "SUPERUSER" }, secret, 1000),
      secret,
      1001,
    ),
  );
  assert.throws(() =>
    verifyJwt(
      signJwt({ ...claims, sid: undefined }, secret, 1000),
      secret,
      1001,
    ),
  );
  const noneHeader = Buffer.from(
    JSON.stringify({ alg: "none", typ: "JWT" }),
  ).toString("base64url");
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${noneHeader}.${body}`)
    .digest("base64url");
  assert.throws(() => verifyJwt(`${noneHeader}.${body}.${sig}`, secret, 1001));
});
test("tenant header is mandatory, strict integer and claim-bound except ADMIN", () => {
  assert.equal(tenantFor(claims, "2"), 2);
  for (const value of [
    undefined,
    "",
    "0",
    "-2",
    "2.0",
    "2abc",
    " 2 ",
    "9007199254740993",
  ])
    assert.throws(() => tenantFor(claims, value));
  assert.throws(() => tenantFor(claims, "3"), /Cross-tenant/);
  assert.throws(
    () => tenantFor({ ...claims, role: "AUDITOR" }, "3"),
    /Cross-tenant/,
  );
  assert.equal(tenantFor({ ...claims, role: "ADMIN" }, "3"), 3);
});
test("inventory input validation rejects coercion, fractional quantities and invalid signs", () => {
  for (const value of ["", null, true, "1x", "1.2", Infinity])
    assert.throws(() => integer(value, "quantity"));
  assert.equal(movementDelta("SHIPMENT", 4), -4);
  assert.equal(movementDelta("RECEIPT", 4), 4);
  assert.equal(movementDelta("ADJUSTMENT", -4), -4);
  for (const [kind, qty] of [
    ["BAD", 3],
    ["SHIPMENT", -3],
    ["RECEIPT", -3],
    ["ADJUSTMENT", 0],
    ["RECEIPT", 1.2],
  ])
    assert.throws(() => movementDelta(kind, qty));
});
test("money accepts decimal strings and rejects exponent notation or excess precision", () => {
  assert.equal(money("19.95"), "19.95");
  assert.equal(money(0), "0");
  for (const value of [
    -1,
    "1.001",
    "1e4",
    Infinity,
    null,
    true,
    "",
    "10000000000.00",
  ])
    assert.throws(() => money(value));
});
