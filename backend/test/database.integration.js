"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { once } = require("node:events");
const sql = require("mssql");
const { createApp } = require("../lib/app");
const { migrate } = require("../lib/migrate");
const { bootstrap } = require("../lib/db");
const { hashPassword } = require("../lib/security");
const { transaction, move } = require("../lib/transactions");

// This suite always creates its own randomly named database. Never reuse or erase
// a supplied application database, even if a connection object includes one.
test(
  "SQL Server: isolated ERP transactions, tenancy, RBAC, and sessions",
  {
    skip:
      !process.env.TEST_DB_CONFIG_JSON &&
      "TEST_DB_CONFIG_JSON absent: real SQL Server integration was not executed",
    timeout: 180000,
  },
  async (t) => {
    const input = JSON.parse(process.env.TEST_DB_CONFIG_JSON);
    const connection = {
      server: input.host,
      port: Number(input.port || 1433),
      user: input.username,
      password: input.password,
      database: "master",
      requestTimeout: 30000,
      options: {
        encrypt: true,
        trustServerCertificate: process.env.DB_TRUST_CERT === "true",
        abortTransactionOnError: true,
      },
    };
    const database = "ERP_TEST_" + crypto.randomBytes(12).toString("hex");
    let admin,
      pool,
      server,
      created = false;
    try {
      admin = await new sql.ConnectionPool(connection).connect();
      await admin.request().query(`CREATE DATABASE [${database}]`);
      created = true;
      pool = await new sql.ConnectionPool({
        ...connection,
        database,
      }).connect();
      await migrate(pool);
      await migrate(pool); // An unchanged migration must be repeatable.
      const password = "Test-only-" + crypto.randomBytes(24).toString("hex");
      const config = {
        jwtSecret: crypto.randomBytes(48).toString("hex"),
        bootstrapPassword: password,
      };
      await bootstrap(pool, config, {
        BOOTSTRAP_ADMIN_EMAIL: "admin@example.test",
      });
      const fixtures = await pool
        .request()
        .input("hash", sql.VarChar(512), hashPassword(password)).query(`
      INSERT INTO ErpTenants(TenantCode,CompanyName,BaseCurrency) VALUES('EMEA','Europe','EUR');
      INSERT INTO ErpUsers(TenantID,Email,PasswordHash,FullName,Role)
        SELECT TenantID,'operator@example.test',@hash,'Test Operator','OPERATOR' FROM ErpTenants WHERE TenantCode='NA';
      INSERT INTO ErpUsers(TenantID,Email,PasswordHash,FullName,Role)
        SELECT TenantID,'auditor@example.test',@hash,'Test Auditor','AUDITOR' FROM ErpTenants WHERE TenantCode='NA';
      INSERT INTO ErpWarehouses(TenantID,WarehouseCode,WarehouseName,City,Country)
        SELECT TenantID,'LHR','London','London','UK' FROM ErpTenants WHERE TenantCode='EMEA';
      INSERT INTO ErpCatalogItems(TenantID,SKU,ItemName,Category,UnitCost,UnitPrice)
        SELECT TenantID,'TEST-001','Integration Item','Test',12.50,20.00 FROM ErpTenants;
      SELECT t.TenantID,t.TenantCode,i.ItemID,w.WarehouseID FROM ErpTenants t
        JOIN ErpCatalogItems i ON i.TenantID=t.TenantID JOIN ErpWarehouses w ON w.TenantID=t.TenantID;
    `);
      const na = fixtures.recordset.find((r) => r.TenantCode === "NA");
      const emea = fixtures.recordset.find((r) => r.TenantCode === "EMEA");
      server = createApp({ pool }, config).listen(0, "127.0.0.1");
      await once(server, "listening");
      const base = `http://127.0.0.1:${server.address().port}`;
      async function call(
        path,
        { token, tenant = na.TenantID, method = "GET", body, key } = {},
      ) {
        const headers = { "Content-Type": "application/json" };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (tenant !== null) headers["X-Tenant-Id"] = String(tenant);
        if (key) headers["X-Idempotency-Key"] = key;
        const response = await fetch(base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const data = response.status === 204 ? null : await response.json();
        return { status: response.status, data };
      }
      async function login(role) {
        const result = await call("/api/auth/login", {
          method: "POST",
          body: { email: role + "@example.test", password },
        });
        assert.equal(result.status, 200, `${role} login must succeed`);
        return result.data;
      }
      const owner = await login("admin"),
        operator = await login("operator"),
        auditor = await login("auditor");
      const stock = {
        itemId: na.ItemID,
        warehouseId: na.WarehouseID,
        binLocation: "TEST-BIN",
        movementType: "RECEIPT",
        quantity: 10,
        referenceDoc: "TEST-RECEIPT",
      };
      const mutate = (
        body,
        key = crypto.randomUUID(),
        token = operator.token,
      ) =>
        call("/api/inventory/movements", { method: "POST", token, key, body });

      await t.test(
        "requires tenant headers and enforces tenant and role boundaries",
        async () => {
          assert.equal((await call("/api/inventory/items")).status, 401);
          assert.equal(
            (
              await call("/api/inventory/items", {
                token: operator.token,
                tenant: null,
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await call("/api/inventory/items", {
                token: operator.token,
                tenant: emea.TenantID,
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await call("/api/inventory/items", {
                token: owner.token,
                tenant: emea.TenantID,
              })
            ).status,
            200,
          );
          assert.equal(
            (await mutate(stock, crypto.randomUUID(), auditor.token)).status,
            403,
          );
          assert.equal(
            (
              await call("/api/inventory/items", {
                method: "POST",
                token: operator.token,
                body: {},
              })
            ).status,
            403,
          );
          assert.equal(
            (await mutate({ ...stock, itemId: emea.ItemID })).status,
            404,
          );
          assert.equal(
            (await mutate({ ...stock, warehouseId: emea.WarehouseID })).status,
            404,
          );
          await assert.rejects(
            pool
              .request()
              .input("tenant", sql.Int, na.TenantID)
              .input("item", sql.Int, emea.ItemID)
              .input("wh", sql.Int, na.WarehouseID)
              .query(
                "INSERT INTO ErpStockBalances(TenantID,ItemID,WarehouseID,BinLocation) VALUES(@tenant,@item,@wh,'FORGED')",
              ),
            (error) => error.number === 547,
          );
        },
      );

      await t.test(
        "receipt replay is exactly once and mismatched replay is rejected",
        async () => {
          const key = crypto.randomUUID();
          const initial = await mutate(stock, key);
          assert.equal(initial.status, 201);
          assert.equal(initial.data.quantityAfter, 10);
          const replay = await mutate(stock, key);
          assert.equal(replay.status, 201);
          assert.equal(replay.data.movementId, initial.data.movementId);
          assert.equal(
            (await mutate({ ...stock, quantity: 11 }, key)).status,
            409,
          );
          assert.equal((await mutate({ ...stock, quantity: -1 })).status, 400);
          assert.equal(
            (await mutate({ ...stock, movementType: "INVALID" })).status,
            400,
          );
        },
      );

      await t.test(
        "concurrent shipments cannot oversell and every journal balances",
        async () => {
          const shipment = { ...stock, movementType: "SHIPMENT", quantity: 7 };
          const responses = await Promise.all([
            mutate(shipment),
            mutate(shipment),
          ]);
          assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
          const balance = await pool
            .request()
            .query("SELECT QuantityOnHand FROM ErpStockBalances");
          assert.equal(balance.recordset[0].QuantityOnHand, 3);
          const journals = await pool.request()
            .query(`SELECT JournalNumber,COUNT(*) Legs,
        SUM(CASE WHEN EntryType='DEBIT' THEN Amount ELSE -Amount END) Net
        FROM ErpFinanceLedger GROUP BY JournalNumber`);
          assert.equal(journals.recordset.length, 2);
          for (const j of journals.recordset) {
            assert.equal(j.Legs, 2);
            assert.equal(j.Net, 0);
          }
        },
      );

      await t.test(
        "failed surrounding transaction rolls back stock, journals, and audit",
        async () => {
          const req = { tenantId: na.TenantID, user: owner.user };
          const snapshot = async () =>
            (
              await pool.request().query(`SELECT
        (SELECT SUM(QuantityOnHand) FROM ErpStockBalances) Qty,
        (SELECT COUNT(*) FROM ErpStockMovements) Moves,
        (SELECT COUNT(*) FROM ErpFinanceLedger) Ledger,
        (SELECT COUNT(*) FROM ErpAudit) Audit`)
            ).recordset[0];
          const before = await snapshot();
          await assert.rejects(
            transaction(pool, async (tx) => {
              await move(tx, req, { ...stock, quantity: 2 });
              throw new Error("Deliberate isolated test rollback");
            }),
            /Deliberate isolated test rollback/,
          );
          assert.deepEqual(await snapshot(), before);
        },
      );

      await t.test(
        "HR compensation is absent for operator and auditor responses",
        async () => {
          const create = await call("/api/erp/employees", {
            token: owner.token,
            method: "POST",
            body: {
              fullName: "Test Employee",
              jobTitle: "Engineer",
              department: "Technology",
              location: "Toronto",
              annualSalary: "123456.78",
            },
          });
          assert.equal(create.status, 201);
          for (const session of [operator, auditor]) {
            const result = await call("/api/erp/modules", {
              token: session.token,
            });
            assert.equal(result.status, 200);
            assert.equal(result.data.employees.length, 1);
            assert.equal(
              Object.hasOwn(result.data.employees[0], "AnnualSalary"),
              false,
            );
          }
          const result = await call("/api/erp/modules", { token: owner.token });
          assert.equal(result.data.employees[0].AnnualSalary, 123456.78);
          assert.equal(
            (
              await call("/api/erp/employees", {
                token: operator.token,
                method: "POST",
                body: {},
              })
            ).status,
            403,
          );
        },
      );

      await t.test(
        "sales allocation reserves stock and shipping posts COGS and revenue once",
        async () => {
          const customer = await call("/api/erp/customers", {
            token: owner.token,
            method: "POST",
            body: { customerCode: "TEST", customerName: "Test Customer" },
          });
          assert.equal(customer.status, 201);
          const order = await call("/api/erp/sales-orders", {
            token: operator.token,
            method: "POST",
            key: crypto.randomUUID(),
            body: {
              customerId: customer.data.CustomerID,
              warehouseId: na.WarehouseID,
              lines: [
                { itemId: na.ItemID, binLocation: "TEST-BIN", quantity: 2 },
              ],
            },
          });
          assert.equal(order.status, 201);
          const path = `/api/erp/sales-orders/${order.data.orderId}/status`;
          assert.equal(
            (
              await call(path, {
                token: operator.token,
                method: "PATCH",
                key: crypto.randomUUID(),
                body: { status: "SHIPPED" },
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await call(path, {
                token: operator.token,
                method: "PATCH",
                key: crypto.randomUUID(),
                body: { status: "ALLOCATED" },
              })
            ).status,
            200,
          );
          assert.equal(
            (await mutate({ ...stock, movementType: "SHIPMENT", quantity: 2 }))
              .status,
            409,
          );
          const shipKey = crypto.randomUUID();
          const ship = () =>
            call(path, {
              token: operator.token,
              method: "PATCH",
              key: shipKey,
              body: { status: "SHIPPED" },
            });
          assert.equal((await ship()).status, 200);
          assert.equal((await ship()).status, 200);
          const balance = (
            await pool
              .request()
              .query(
                "SELECT QuantityOnHand,ReservedQuantity FROM ErpStockBalances",
              )
          ).recordset[0];
          assert.deepEqual(balance, { QuantityOnHand: 1, ReservedQuantity: 0 });
          const revenue = (
            await pool
              .request()
              .query(
                "SELECT Amount,EntryType FROM ErpFinanceLedger WHERE AccountCode='4000-REV'",
              )
          ).recordset;
          assert.equal(revenue.length, 1);
          assert.equal(revenue[0].Amount, 40);
          assert.equal(revenue[0].EntryType, "CREDIT");
          const unbalanced = (
            await pool
              .request()
              .query(
                "SELECT JournalNumber FROM ErpFinanceLedger GROUP BY JournalNumber HAVING SUM(CASE WHEN EntryType='DEBIT' THEN Amount ELSE -Amount END)<>0",
              )
          ).recordset;
          assert.equal(unbalanced.length, 0);
        },
      );

      await t.test(
        "logout invalidates the persisted session immediately",
        async () => {
          assert.equal(
            (
              await call("/api/auth/logout", {
                token: operator.token,
                method: "POST",
              })
            ).status,
            204,
          );
          assert.equal(
            (await call("/api/inventory/items", { token: operator.token }))
              .status,
            401,
          );
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (pool) await pool.close();
      if (admin) {
        try {
          if (created)
            await admin
              .request()
              .query(
                `ALTER DATABASE [${database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE [${database}]`,
              );
        } finally {
          await admin.close();
        }
      }
    }
  },
);
