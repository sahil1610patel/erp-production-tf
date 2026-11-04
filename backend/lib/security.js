"use strict";
const crypto = require("node:crypto");
const ROLES = new Set(["ADMIN", "OPERATOR", "AUDITOR"]);
const ISSUER = "nexus-erp";
const AUDIENCE = "nexus-erp-web";
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  if (
    typeof password !== "string" ||
    password.length < 12 ||
    password.length > 128
  )
    throw new HttpError(400, "Password must contain 12–128 characters");
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password, stored) {
  if (
    typeof password !== "string" ||
    password.length > 128 ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored || "")
  )
    return false;
  const [salt, key] = stored.split(":");
  return crypto.timingSafeEqual(
    crypto.scryptSync(password, salt, 64),
    Buffer.from(key, "hex"),
  );
}
function signJwt(claims, secret, now = Math.floor(Date.now() / 1000)) {
  const head = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...claims,
      iss: ISSUER,
      aud: AUDIENCE,
      iat: now,
      exp: now + 28800,
    }),
  ).toString("base64url");
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`;
}
function verifyJwt(token, secret, now = Math.floor(Date.now() / 1000)) {
  try {
    if (typeof token !== "string" || token.length > 4096) throw Error();
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p)))
      throw Error();
    const [head, body, signature] = parts;
    const h = JSON.parse(Buffer.from(head, "base64url").toString());
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    const expected = crypto
      .createHmac("sha256", secret)
      .update(`${head}.${body}`)
      .digest();
    const actual = Buffer.from(signature, "base64url");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    )
      throw Error();
    if (
      h.alg !== "HS256" ||
      h.typ !== "JWT" ||
      p.iss !== ISSUER ||
      p.aud !== AUDIENCE ||
      !Number.isInteger(p.exp) ||
      p.exp <= now ||
      !Number.isInteger(p.iat) ||
      p.iat > now + 30 ||
      p.exp - p.iat !== 28800
    )
      throw Error();
    if (
      !Number.isInteger(p.userId) ||
      p.userId < 1 ||
      !Number.isInteger(p.tenantId) ||
      p.tenantId < 1 ||
      !ROLES.has(p.role) ||
      !/^[a-f0-9-]{36}$/.test(p.sid || "")
    )
      throw Error();
    return p;
  } catch {
    throw new HttpError(401, "Invalid or expired session");
  }
}
function tenantFor(user, header) {
  if (
    !/^[1-9][0-9]*$/.test(header || "") ||
    !Number.isSafeInteger(Number(header))
  )
    throw new HttpError(400, "A positive X-Tenant-Id header is required");
  const tenantId = Number(header);
  if (user.role !== "ADMIN" && tenantId !== user.tenantId)
    throw new HttpError(403, "Cross-tenant access denied");
  return tenantId;
}
function allow(...roles) {
  return (req, _res, next) =>
    roles.includes(req.user.role)
      ? next()
      : next(new HttpError(403, "Role does not permit this operation"));
}
function integer(value, name, min = 1, max = 2147483647) {
  if (!["string", "number"].includes(typeof value))
    throw new HttpError(400, `${name} must be an integer`);
  if (typeof value === "string" && !/^-?\d+$/.test(value))
    throw new HttpError(400, `${name} must be an integer`);
  const n = Number(value);
  if (
    value === "" ||
    value === null ||
    typeof value === "boolean" ||
    !Number.isInteger(n) ||
    n < min ||
    n > max
  )
    throw new HttpError(
      400,
      `${name} must be an integer between ${min} and ${max}`,
    );
  return n;
}
function text(value, name, max = 200, required = true) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    (required && !value.trim())
  )
    throw new HttpError(
      400,
      `${name} is required and must be at most ${max} characters`,
    );
  return value.trim();
}
function money(value, name = "amount") {
  if (!["string", "number"].includes(typeof value))
    throw new HttpError(400, `${name} must be a decimal amount`);
  const s = String(value);
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(s))
    throw new HttpError(
      400,
      `${name} must be a nonnegative amount with at most two decimal places`,
    );
  return s;
}
function movementDelta(type, quantity) {
  const q = integer(quantity, "quantity", -100000000, 100000000);
  if (
    !["RECEIPT", "SHIPMENT", "ADJUSTMENT"].includes(type) ||
    q === 0 ||
    (type !== "ADJUSTMENT" && q < 0)
  )
    throw new HttpError(400, "Movement type or quantity is invalid");
  return type === "SHIPMENT" ? -q : q;
}
module.exports = {
  HttpError,
  hashPassword,
  verifyPassword,
  signJwt,
  verifyJwt,
  tenantFor,
  allow,
  integer,
  text,
  money,
  movementDelta,
};
