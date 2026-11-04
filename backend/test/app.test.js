"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createApp } = require("../lib/app");
const { signJwt, hashPassword } = require("../lib/security");
const secret = "http-test-signing-key-at-least-thirty-two-bytes";
const sid = crypto.randomUUID();
function poolFor(role = "OPERATOR", overrides = {}) {
  const queries = [];
  const pool = {
    queries,
    request() {
      const params = {};
      return {
        input(name, _type, value) {
          params[name] = value;
          return this;
        },
        async query(query) {
          queries.push(query);
          if (overrides.query) {
            const result = await overrides.query(query, params);
            if (result) return result;
          }
          if (query.includes("FROM ErpSessions s"))
            return {
              recordset: overrides.revoked
                ? []
                : [
                    {
                      Role: role,
                      TenantID: 1,
                      FullName: "Test User",
                      Email: "user@example.test",
                    },
                  ],
            };
          if (query.includes("SELECT TenantID FROM ErpTenants"))
            return { recordset: [{ TenantID: params.tenant }] };
          return { recordset: [], rowsAffected: [1] };
        },
      };
    },
  };
  return pool;
}
async function running(t, pool, run) {
  const server = createApp({ pool }, { jwtSecret: secret }).listen(
    0,
    "127.0.0.1",
  );
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return run(`http://127.0.0.1:${server.address().port}`);
}
function headers(role = "OPERATOR", tenant = "1") {
  return {
    Authorization: `Bearer ${signJwt({ userId: 1, tenantId: 1, fullName: "Test User", role, sid }, secret)}`,
    "X-Tenant-Id": tenant,
    "Content-Type": "application/json",
  };
}
test("HTTP auth rejects missing auth, missing tenant, cross tenant and revoked sessions", async (t) => {
  await running(t, poolFor(), async (base) => {
    assert.equal((await fetch(base + "/api/auth/me")).status, 401);
    const h = headers();
    delete h["X-Tenant-Id"];
    assert.equal(
      (await fetch(base + "/api/auth/me", { headers: h })).status,
      400,
    );
    assert.equal(
      (
        await fetch(base + "/api/auth/me", {
          headers: headers("OPERATOR", "2"),
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(base + "/api/auth/me", { headers: headers() })).status,
      200,
    );
  });
  await running(t, poolFor("OPERATOR", { revoked: true }), async (base) => {
    assert.equal(
      (await fetch(base + "/api/auth/me", { headers: headers() })).status,
      401,
    );
  });
});
test("HTTP rejects stale role claims and allows explicit administrator tenant selection", async (t) => {
  await running(t, poolFor("AUDITOR"), async (base) => {
    assert.equal(
      (await fetch(base + "/api/auth/me", { headers: headers("ADMIN") }))
        .status,
      401,
    );
  });
  await running(t, poolFor("ADMIN"), async (base) => {
    assert.equal(
      (await fetch(base + "/api/auth/me", { headers: headers("ADMIN", "2") }))
        .status,
      200,
    );
  });
});
test("RBAC blocks operator HR edits and auditor stock movements before data writes", async (t) => {
  const operator = poolFor();
  await running(t, operator, async (base) => {
    assert.equal(
      (
        await fetch(base + "/api/erp/employees", {
          method: "POST",
          headers: headers(),
          body: "{}",
        })
      ).status,
      403,
    );
    assert.equal(
      operator.queries.some((q) => q.startsWith("INSERT")),
      false,
    );
  });
  const auditor = poolFor("AUDITOR");
  await running(t, auditor, async (base) => {
    assert.equal(
      (
        await fetch(base + "/api/inventory/movements", {
          method: "POST",
          headers: headers("AUDITOR"),
          body: "{}",
        })
      ).status,
      403,
    );
  });
});
test("non-admin HR read excludes salary from the SQL projection", async (t) => {
  const pool = poolFor("AUDITOR");
  await running(t, pool, async (base) => {
    const response = await fetch(base + "/api/erp/modules", {
      headers: headers("AUDITOR"),
    });
    assert.equal(response.status, 200);
    assert.equal(
      pool.queries
        .find((q) => q.includes("FROM ErpEmployees"))
        .includes("AnnualSalary"),
      false,
    );
  });
});
test("readiness fails when no database exists; malformed and unknown requests remain JSON", async (t) => {
  await running(t, null, async (base) => {
    assert.equal((await fetch(base + "/health")).status, 200);
    assert.equal((await fetch(base + "/api/ready")).status, 503);
  });
  await running(t, poolFor(), async (base) => {
    const bad = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad",
    });
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get("content-type"), /json/);
    const missing = await fetch(base + "/api/missing", { headers: headers() });
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get("content-type"), /json/);
    assert.equal((await missing.json()).error, "API route not found");
  });
});
test("login preserves whitespace passwords and stores a session before issuing token", async (t) => {
  const password = " surrounding whitespace password ";
  const hash = hashPassword(password);
  const pool = poolFor("ADMIN", {
    query: async (q) =>
      q.includes("WHERE u.Email=@email")
        ? {
            recordset: [
              {
                UserID: 1,
                TenantID: 1,
                FullName: "Admin",
                Role: "ADMIN",
                Email: "admin@example.test",
                PasswordHash: hash,
                CompanyName: "Test",
                BaseCurrency: "CAD",
              },
            ],
          }
        : undefined,
  });
  await running(t, pool, async (base) => {
    const response = await fetch(base + "/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "admin@example.test", password }),
    });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).token);
    assert.equal(
      pool.queries.some((q) => q.startsWith("INSERT INTO ErpSessions")),
      true,
    );
  });
});

test("database probe failures return unavailable readiness without exposing SQL errors", async (t) => {
  await running(
    t,
    poolFor("ADMIN", {
      query: async (q) => {
        if (q === "SELECT 1 AS ready")
          throw new Error("private SQL endpoint and credential detail");
      },
    }),
    async (base) => {
      const response = await fetch(base + "/api/ready");
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        status: "unavailable",
        dbConnected: false,
      });
    },
  );
});

test("user directory requires administrator role and excludes password hashes", async (t) => {
  await running(t, poolFor("OPERATOR"), async (base) => {
    assert.equal(
      (await fetch(base + "/api/users", { headers: headers() })).status,
      403,
    );
  });
  const admin = poolFor("ADMIN");
  await running(t, admin, async (base) => {
    assert.equal(
      (await fetch(base + "/api/users", { headers: headers("ADMIN") })).status,
      200,
    );
    const query = admin.queries.find((q) =>
      q.includes("FROM ErpUsers WHERE TenantID"),
    );
    assert.ok(query);
    assert.equal(query.includes("PasswordHash"), false);
    assert.equal(query.includes("SELECT *"), false);
    assert.equal(
      (
        await fetch(base + "/api/tenants/1", {
          method: "DELETE",
          headers: headers("ADMIN"),
        })
      ).status,
      409,
    );
  });
});
