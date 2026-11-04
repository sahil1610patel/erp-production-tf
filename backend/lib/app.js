"use strict";
const express = require("express");
const crypto = require("node:crypto");
const { sql } = require("./db");
const {
  HttpError,
  verifyPassword,
  hashPassword,
  signJwt,
  verifyJwt,
  tenantFor,
  allow,
  integer,
  text,
  money,
} = require("./security");
const {
  request,
  transaction,
  audit,
  idempotent,
  journal,
  move,
} = require("./transactions");
const wrap = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);
const dummyHash = hashPassword(crypto.randomBytes(32).toString("hex"));
function createApp(state, config) {
  const app = express();
  app.disable("x-powered-by");
  // Deployed ingress is fixed: CloudFront -> ALB -> EC2; direct origin is gated.
  app.set("trust proxy", process.env.NODE_ENV === "production" ? 2 : false);
  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.set({
      "X-Request-Id": req.id,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use(express.json({ limit: "128kb" }));
  app.get("/health", (_req, res) => res.json({ status: "alive" }));
  app.get(
    ["/api/ready", "/api/health"],
    wrap(async (_req, res) => {
      if (!state.pool)
        return res
          .status(503)
          .json({ status: "initializing", dbConnected: false });
      try {
        await state.pool.request().query("SELECT 1 AS ready");
      } catch {
        return res
          .status(503)
          .json({ status: "unavailable", dbConnected: false });
      }
      res.json({ status: "ready", dbConnected: true });
    }),
  );
  app.use("/api", (_req, _res, next) =>
    state.pool ? next() : next(new HttpError(503, "Database is initializing")),
  );
  // Bounded local throttle complements the CloudFront WAF distributed rate limit.
  const attempts = new Map();
  app.post(
    "/api/auth/login",
    wrap(async (req, res) => {
      const now = Date.now(),
        key = req.ip;
      const window = attempts.get(key);
      if (window && window.until > now && window.count >= 10)
        throw new HttpError(
          429,
          "Too many login attempts; retry in 15 minutes",
        );
      if (!window || window.until <= now) {
        if (attempts.size >= 10000)
          for (const [k, v] of attempts) if (v.until <= now) attempts.delete(k);
        if (attempts.size >= 10000 && !attempts.has(key))
          throw new HttpError(429, "Login service busy; retry later");
        attempts.set(key, { until: now + 900000, count: 1 });
      } else window.count++;
      const email = text(req.body.email, "email", 150).toLowerCase();
      if (
        typeof req.body.password !== "string" ||
        req.body.password.length > 128
      )
        throw new HttpError(400, "Invalid password format");
      const password = req.body.password;
      const found = await state.pool
        .request()
        .input("email", sql.VarChar(150), email)
        .query(
          `SELECT u.*,t.CompanyName,t.BaseCurrency FROM ErpUsers u JOIN ErpTenants t ON t.TenantID=u.TenantID WHERE u.Email=@email AND u.IsActive=1 AND t.IsActive=1`,
        );
      const user = found.recordset[0];
      if (!verifyPassword(password, user?.PasswordHash || dummyHash) || !user)
        throw new HttpError(401, "Invalid email or password");
      const sid = crypto.randomUUID();
      await state.pool
        .request()
        .input("sid", sql.UniqueIdentifier, sid)
        .input("user", sql.Int, user.UserID)
        .query(
          "INSERT INTO ErpSessions (SessionID,UserID,ExpiresAt) VALUES (@sid,@user,DATEADD(hour,8,SYSUTCDATETIME()))",
        );
      const claims = {
        userId: user.UserID,
        tenantId: user.TenantID,
        role: user.Role,
        fullName: user.FullName,
        email: user.Email,
        companyName: user.CompanyName,
        currency: user.BaseCurrency,
        sid,
      };
      res.json({ token: signJwt(claims, config.jwtSecret), user: claims });
    }),
  );
  app.use(
    "/api",
    wrap(async (req, _res, next) => {
      if (!req.get("Authorization")?.startsWith("Bearer "))
        throw new HttpError(401, "Authentication required");
      const claims = verifyJwt(
        req.get("Authorization").slice(7),
        config.jwtSecret,
      );
      const active = await state.pool
        .request()
        .input("sid", sql.UniqueIdentifier, claims.sid)
        .input("user", sql.Int, claims.userId)
        .query(
          `SELECT u.Role,u.TenantID,u.FullName,u.Email FROM ErpSessions s JOIN ErpUsers u ON u.UserID=s.UserID JOIN ErpTenants t ON t.TenantID=u.TenantID WHERE s.SessionID=@sid AND s.UserID=@user AND s.RevokedAt IS NULL AND s.ExpiresAt>SYSUTCDATETIME() AND u.IsActive=1 AND t.IsActive=1`,
        );
      const current = active.recordset[0];
      if (
        !current ||
        current.Role !== claims.role ||
        current.TenantID !== claims.tenantId
      )
        throw new HttpError(401, "Session revoked");
      req.user = {
        ...claims,
        fullName: current.FullName,
        email: current.Email,
      };
      req.tenantId = tenantFor(req.user, req.get("X-Tenant-Id"));
      const tenant = await request(state.pool, req.tenantId).query(
        "SELECT TenantID FROM ErpTenants WHERE TenantID=@tenant AND IsActive=1",
      );
      if (!tenant.recordset.length)
        throw new HttpError(404, "Tenant not found");
      next();
    }),
  );
  app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));
  app.post(
    "/api/auth/logout",
    wrap(async (req, res) => {
      await state.pool
        .request()
        .input("sid", sql.UniqueIdentifier, req.user.sid)
        .query(
          "UPDATE ErpSessions SET RevokedAt=SYSUTCDATETIME() WHERE SessionID=@sid",
        );
      res.status(204).end();
    }),
  );
  app.get(
    "/api/tenants",
    wrap(async (req, res) =>
      res.json(
        (
          await request(state.pool, req.tenantId).query(
            `SELECT TenantID,TenantCode,CompanyName,BaseCurrency FROM ErpTenants WHERE IsActive=1 ${req.user.role === "ADMIN" ? "" : "AND TenantID=@tenant"} ORDER BY TenantID`,
          )
        ).recordset,
      ),
    ),
  );
  app.post(
    "/api/tenants",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const result = await transaction(state.pool, async (tx) => {
        const r = await new sql.Request(tx)
          .input(
            "code",
            sql.VarChar(30),
            text(req.body.tenantCode, "tenantCode", 30),
          )
          .input(
            "name",
            sql.NVarChar(150),
            text(req.body.companyName, "companyName", 150),
          )
          .input(
            "currency",
            sql.Char(3),
            text(req.body.baseCurrency, "baseCurrency", 3),
          )
          .query(
            "INSERT INTO ErpTenants(TenantCode,CompanyName,BaseCurrency) OUTPUT INSERTED.TenantID VALUES(@code,@name,@currency)",
          );
        await audit(tx, req, "CREATE", "tenant", r.recordset[0].TenantID);
        return r.recordset[0];
      });
      res.status(201).json(result);
    }),
  );
  app.put(
    "/api/tenants/:id",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      const currency = text(
        req.body.baseCurrency,
        "baseCurrency",
        3,
      ).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency))
        throw new HttpError(400, "Use a three-letter currency code");
      await transaction(state.pool, async (tx) => {
        // Currency changes after financial activity require an explicit accounting migration.
        const changed = await new sql.Request(tx)
          .input("id", sql.Int, id)
          .input(
            "name",
            sql.NVarChar(150),
            text(req.body.companyName, "companyName", 150),
          )
          .input("currency", sql.Char(3), currency)
          .query(`UPDATE ErpTenants SET CompanyName=@name,BaseCurrency=@currency WHERE TenantID=@id AND IsActive=1
          AND (BaseCurrency=@currency OR (NOT EXISTS(SELECT 1 FROM ErpFinanceLedger WHERE TenantID=@id) AND NOT EXISTS(SELECT 1 FROM ErpSalesOrders WHERE TenantID=@id)))`);
        if (!changed.rowsAffected[0])
          throw new HttpError(
            409,
            "Tenant unavailable or currency change requires an accounting migration",
          );
        await audit(tx, req, "UPDATE", "tenant", id, {
          fields: ["CompanyName", "BaseCurrency"],
        });
      });
      res.json({ message: "Tenant updated" });
    }),
  );
  app.delete(
    "/api/tenants/:id",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      if (id === req.user.tenantId || id === req.tenantId)
        throw new HttpError(
          409,
          "Switch to another tenant and retain your own administrator tenant",
        );
      await transaction(state.pool, async (tx) => {
        const changed = await new sql.Request(tx)
          .input("id", sql.Int, id)
          .query(
            "UPDATE ErpTenants SET IsActive=0 WHERE TenantID=@id AND IsActive=1",
          );
        if (!changed.rowsAffected[0])
          throw new HttpError(404, "Tenant not found");
        await new sql.Request(tx)
          .input("id", sql.Int, id)
          .query(
            "UPDATE s SET RevokedAt=SYSUTCDATETIME() FROM ErpSessions s JOIN ErpUsers u ON u.UserID=s.UserID WHERE u.TenantID=@id AND s.RevokedAt IS NULL",
          );
        await audit(tx, req, "DEACTIVATE", "tenant", id);
      });
      res.json({ message: "Tenant deactivated; records retained" });
    }),
  );
  app.get(
    "/api/users",
    allow("ADMIN"),
    wrap(async (req, res) => {
      res.json(
        (
          await request(state.pool, req.tenantId).query(
            "SELECT UserID,TenantID,Email,FullName,Role,IsActive FROM ErpUsers WHERE TenantID=@tenant ORDER BY FullName",
          )
        ).recordset,
      );
    }),
  );
  app.post(
    "/api/users",
    allow("ADMIN"),
    wrap(async (req, res) => {
      if (!["ADMIN", "OPERATOR", "AUDITOR"].includes(req.body.role))
        throw new HttpError(400, "Invalid role");
      const result = await transaction(state.pool, async (tx) => {
        const r = await request(tx, req.tenantId)
          .input(
            "name",
            sql.NVarChar(120),
            text(req.body.fullName, "fullName", 120),
          )
          .input(
            "email",
            sql.VarChar(150),
            text(req.body.email, "email", 150).toLowerCase(),
          )
          .input("hash", sql.VarChar(200), hashPassword(req.body.password))
          .input("role", sql.VarChar(20), req.body.role)
          .query(
            "INSERT INTO ErpUsers(TenantID,Email,PasswordHash,FullName,Role) OUTPUT INSERTED.UserID VALUES(@tenant,@email,@hash,@name,@role)",
          );
        await audit(tx, req, "CREATE", "user", r.recordset[0].UserID);
        return r.recordset[0];
      });
      res.status(201).json(result);
    }),
  );
  app.patch(
    "/api/users/:id",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      if (id === req.user.userId)
        throw new HttpError(
          409,
          "Use another administrator to modify your own role or status",
        );
      if (
        !["ADMIN", "OPERATOR", "AUDITOR"].includes(req.body.role) ||
        typeof req.body.isActive !== "boolean"
      )
        throw new HttpError(400, "role and isActive are required");
      await transaction(state.pool, async (tx) => {
        const r = await request(tx, req.tenantId)
          .input("id", sql.Int, id)
          .input("role", sql.VarChar(20), req.body.role)
          .input("active", sql.Bit, req.body.isActive)
          .query(
            "UPDATE ErpUsers SET Role=@role,IsActive=@active WHERE TenantID=@tenant AND UserID=@id",
          );
        if (!r.rowsAffected[0]) throw new HttpError(404, "User not found");
        await new sql.Request(tx)
          .input("id", sql.Int, id)
          .query(
            "UPDATE ErpSessions SET RevokedAt=SYSUTCDATETIME() WHERE UserID=@id AND RevokedAt IS NULL",
          );
        await audit(tx, req, "UPDATE", "user", id);
      });
      res.json({ message: "User updated; sessions revoked" });
    }),
  );
  app.get(
    "/api/inventory/items",
    wrap(async (req, res) => {
      const [items, balances, warehouses, movements] = await Promise.all([
        request(state.pool, req.tenantId).query(
          `SELECT i.*,COALESCE((SELECT SUM(CONVERT(bigint,b.QuantityOnHand)) FROM ErpStockBalances b WHERE b.TenantID=i.TenantID AND b.ItemID=i.ItemID),0) TotalQuantityOnHand FROM ErpCatalogItems i WHERE TenantID=@tenant AND IsActive=1 ORDER BY SKU`,
        ),
        request(state.pool, req.tenantId).query(
          "SELECT b.*,w.WarehouseCode,w.WarehouseName FROM ErpStockBalances b JOIN ErpWarehouses w ON w.TenantID=b.TenantID AND w.WarehouseID=b.WarehouseID WHERE b.TenantID=@tenant",
        ),
        request(state.pool, req.tenantId).query(
          "SELECT * FROM ErpWarehouses WHERE TenantID=@tenant AND IsActive=1 ORDER BY WarehouseCode",
        ),
        request(state.pool, req.tenantId).query(
          "SELECT TOP(200) m.*,i.SKU,w.WarehouseCode FROM ErpStockMovements m JOIN ErpCatalogItems i ON i.TenantID=m.TenantID AND i.ItemID=m.ItemID JOIN ErpWarehouses w ON w.TenantID=m.TenantID AND w.WarehouseID=m.WarehouseID WHERE m.TenantID=@tenant ORDER BY MovementID DESC",
        ),
      ]);
      res.json({
        items: items.recordset.map((i) => ({
          ...i,
          warehouseBalances: balances.recordset.filter(
            (b) => b.ItemID === i.ItemID,
          ),
        })),
        warehouses: warehouses.recordset,
        movements: movements.recordset,
      });
    }),
  );
  function itemRequest(tx, req) {
    const b = req.body;
    return request(tx, req.tenantId)
      .input("sku", sql.VarChar(60), text(b.sku, "sku", 60).toUpperCase())
      .input("name", sql.NVarChar(200), text(b.itemName, "itemName", 200))
      .input("cat", sql.NVarChar(80), text(b.category, "category", 80))
      .input(
        "description",
        sql.NVarChar(500),
        text(b.description || "", "description", 500, false),
      )
      .input(
        "uom",
        sql.VarChar(20),
        text(b.unitOfMeasure || "EA", "unitOfMeasure", 20),
      )
      .input("cost", sql.Decimal(18, 2), money(b.unitCost, "unitCost"))
      .input("price", sql.Decimal(18, 2), money(b.unitPrice, "unitPrice"))
      .input("point", sql.Int, integer(b.reorderPoint ?? 0, "reorderPoint", 0))
      .input("qty", sql.Int, integer(b.reorderQty ?? 0, "reorderQty", 0));
  }
  app.post(
    "/api/inventory/items",
    allow("ADMIN"),
    wrap(async (req, res) =>
      res.status(201).json(
        await transaction(state.pool, async (tx) => {
          if (req.body.initialQty)
            throw new HttpError(
              400,
              "Opening stock must be entered as a stock movement",
            );
          const r = await itemRequest(tx, req).query(
            `INSERT INTO ErpCatalogItems(TenantID,SKU,ItemName,Category,Description,UnitOfMeasure,UnitCost,UnitPrice,ReorderPoint,ReorderQty) OUTPUT INSERTED.ItemID VALUES(@tenant,@sku,@name,@cat,@description,@uom,@cost,@price,@point,@qty)`,
          );
          const id = r.recordset[0].ItemID;
          await audit(tx, req, "CREATE", "item", id);
          return { itemId: id };
        }),
      ),
    ),
  );
  app.put(
    "/api/inventory/items/:id",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      await transaction(state.pool, async (tx) => {
        const r = await itemRequest(tx, req)
          .input("id", sql.Int, id)
          .query(
            `UPDATE ErpCatalogItems SET SKU=@sku,ItemName=@name,Category=@cat,Description=@description,UnitOfMeasure=@uom,UnitCost=@cost,UnitPrice=@price,ReorderPoint=@point,ReorderQty=@qty,UpdatedAt=SYSUTCDATETIME() WHERE TenantID=@tenant AND ItemID=@id AND IsActive=1 AND (UnitCost=@cost OR NOT EXISTS(SELECT 1 FROM ErpStockBalances WHERE TenantID=@tenant AND ItemID=@id AND QuantityOnHand>0))`,
          );
        if (!r.rowsAffected[0])
          throw new HttpError(
            409,
            "Item unavailable or cost change requires zero stock",
          );
        await audit(tx, req, "UPDATE", "item", id);
      });
      res.json({ message: "Item updated" });
    }),
  );
  app.delete(
    "/api/inventory/items/:id",
    allow("ADMIN"),
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      await transaction(state.pool, async (tx) => {
        const r = await request(tx, req.tenantId)
          .input("id", sql.Int, id)
          .query(
            `UPDATE ErpCatalogItems SET IsActive=0 WHERE TenantID=@tenant AND ItemID=@id AND IsActive=1 AND NOT EXISTS(SELECT 1 FROM ErpStockBalances WHERE TenantID=@tenant AND ItemID=@id AND QuantityOnHand>0) AND NOT EXISTS(SELECT 1 FROM ErpSalesOrderLines l JOIN ErpSalesOrders o ON o.TenantID=l.TenantID AND o.OrderID=l.OrderID WHERE l.TenantID=@tenant AND l.ItemID=@id AND o.Status IN('PENDING','ALLOCATED'))`,
          );
        if (!r.rowsAffected[0])
          throw new HttpError(409, "Item unavailable or has stock/open orders");
        await audit(tx, req, "RETIRE", "item", id);
      });
      res.json({ message: "Item retired; history retained" });
    }),
  );
  app.post(
    "/api/inventory/warehouses",
    allow("ADMIN"),
    wrap(async (req, res) =>
      res.status(201).json(
        await transaction(state.pool, async (tx) => {
          const b = req.body,
            r = await request(tx, req.tenantId)
              .input(
                "code",
                sql.VarChar(30),
                text(b.warehouseCode, "warehouseCode", 30),
              )
              .input(
                "name",
                sql.NVarChar(120),
                text(b.warehouseName, "warehouseName", 120),
              )
              .input("city", sql.NVarChar(80), text(b.city, "city", 80))
              .input(
                "country",
                sql.NVarChar(80),
                text(b.country, "country", 80),
              )
              .query(
                "INSERT INTO ErpWarehouses(TenantID,WarehouseCode,WarehouseName,City,Country) OUTPUT INSERTED.WarehouseID VALUES(@tenant,@code,@name,@city,@country)",
              );
          await audit(
            tx,
            req,
            "CREATE",
            "warehouse",
            r.recordset[0].WarehouseID,
          );
          return r.recordset[0];
        }),
      ),
    ),
  );
  app.post(
    "/api/inventory/movements",
    allow("ADMIN", "OPERATOR"),
    wrap(async (req, res) =>
      res
        .status(201)
        .json(
          await idempotent(state.pool, req, (tx) => move(tx, req, req.body)),
        ),
    ),
  );
  app.get(
    "/api/erp/modules",
    wrap(async (req, res) => {
      const [finance, sales, hr, customers] = await Promise.all([
        request(state.pool, req.tenantId).query(
          "SELECT TOP(500) * FROM ErpFinanceLedger WHERE TenantID=@tenant ORDER BY LedgerID DESC",
        ),
        request(state.pool, req.tenantId).query(
          "SELECT TOP(500) o.*,w.WarehouseCode FROM ErpSalesOrders o JOIN ErpWarehouses w ON w.TenantID=o.TenantID AND w.WarehouseID=o.WarehouseID WHERE o.TenantID=@tenant ORDER BY OrderID DESC",
        ),
        request(state.pool, req.tenantId).query(
          `SELECT EmployeeID,TenantID,EmpCode,FullName,JobTitle,Department,Location,Status${req.user.role === "ADMIN" ? ",AnnualSalary" : ""} FROM ErpEmployees WHERE TenantID=@tenant ORDER BY FullName`,
        ),
        request(state.pool, req.tenantId).query(
          "SELECT * FROM ErpCustomers WHERE TenantID=@tenant AND IsActive=1 ORDER BY CustomerName",
        ),
      ]);
      res.json({
        financeLedger: finance.recordset,
        salesOrders: sales.recordset,
        employees: hr.recordset,
        customers: customers.recordset,
      });
    }),
  );
  app.get(
    "/api/audit",
    wrap(async (req, res) => {
      const limit = integer(req.query.limit || 100, "limit", 1, 500),
        before = integer(req.query.before || 2147483647, "before");
      res.json(
        (
          await request(state.pool, req.tenantId)
            .input("limit", sql.Int, limit)
            .input("before", sql.BigInt, before)
            .query(
              "SELECT TOP(@limit) * FROM ErpAudit WHERE TenantID=@tenant AND AuditID<@before ORDER BY AuditID DESC",
            )
        ).recordset,
      );
    }),
  );
  app.post(
    "/api/erp/journals",
    allow("ADMIN"),
    wrap(async (req, res) =>
      res.status(201).json(
        await idempotent(state.pool, req, async (tx) => {
          const allowed = new Set([
            "1400-INV",
            "2100-AP",
            "5000-COGS",
            "5100-ADJ",
            "1100-AR",
            "4000-REV",
            "1000-CASH",
            "3000-EQUITY",
          ]);
          if (
            !allowed.has(req.body.debitAccount) ||
            !allowed.has(req.body.creditAccount)
          )
            throw new HttpError(400, "Unknown GL account");
          // Inventory changes must always originate in the stock subledger.
          if (
            [req.body.debitAccount, req.body.creditAccount].includes("1400-INV")
          )
            throw new HttpError(
              400,
              "Post inventory corrections through stock movements",
            );
          const id = await journal(tx, req, {
            debit: req.body.debitAccount,
            credit: req.body.creditAccount,
            amount: money(req.body.amount),
            referenceDoc: text(
              req.body.referenceDoc || "",
              "referenceDoc",
              80,
              false,
            ),
            memo: text(req.body.memo || "", "memo", 250, false),
          });
          await audit(tx, req, "POST", "journal", id);
          return { journalId: id };
        }),
      ),
    ),
  );
  registerDirectory(app, state);
  registerSales(app, state);
  app.use((_req, _res, next) =>
    next(new HttpError(404, "API route not found")),
  );
  app.use((err, req, res, _next) => {
    let status = err.status || 500,
      message = err.status ? err.message : "Internal server error";
    if (err.type === "entity.parse.failed") {
      status = 400;
      message = "Malformed JSON body";
    }
    if ([2601, 2627].includes(err.number)) {
      status = 409;
      message = "A record with this identifier already exists";
    }
    if (err.number === 547) {
      status = 409;
      message = "Operation violates a data integrity rule";
    }
    if (err.number === 1205) {
      status = 409;
      message = "Concurrent update; retry with the same idempotency key";
    }
    if (status >= 500)
      console.error(
        JSON.stringify({
          event: "request_failed",
          requestId: req.id,
          code: err.code || err.number || "INTERNAL",
        }),
      );
    res.status(status).json({ error: message, requestId: req.id });
  });
  return app;
}
function registerDirectory(app, state) {
  function directory(name, path, idColumn, fields) {
    const bind = (tx, req) => {
      let r = request(tx, req.tenantId);
      for (const [key, col, type, validate] of fields)
        r = r.input(key, type, validate(req.body[key]));
      return r;
    };
    app.post(
      path,
      allow("ADMIN"),
      wrap(async (req, res) =>
        res.status(201).json(
          await transaction(state.pool, async (tx) => {
            const columns = fields.map((f) => f[1]).join(","),
              params = fields.map((f) => "@" + f[0]).join(",");
            const r = await bind(tx, req).query(
              `INSERT INTO ${name}(TenantID,${columns}) OUTPUT INSERTED.${idColumn} VALUES(@tenant,${params})`,
            );
            await audit(tx, req, "CREATE", name, r.recordset[0][idColumn]);
            return r.recordset[0];
          }),
        ),
      ),
    );
    app.put(
      path + "/:id",
      allow("ADMIN"),
      wrap(async (req, res) => {
        const id = integer(req.params.id, "id");
        await transaction(state.pool, async (tx) => {
          const set = fields.map((f) => `${f[1]}=@${f[0]}`).join(",");
          const r = await bind(tx, req)
            .input("id", sql.Int, id)
            .query(
              `UPDATE ${name} SET ${set} WHERE TenantID=@tenant AND ${idColumn}=@id`,
            );
          if (!r.rowsAffected[0]) throw new HttpError(404, "Record not found");
          await audit(tx, req, "UPDATE", name, id, {
            fields: fields.map((f) => f[1]),
          });
        });
        res.json({ message: "Record updated" });
      }),
    );
    app.delete(
      path + "/:id",
      allow("ADMIN"),
      wrap(async (req, res) => {
        const id = integer(req.params.id, "id");
        await transaction(state.pool, async (tx) => {
          const r = await request(tx, req.tenantId)
            .input("id", sql.Int, id)
            .query(
              `UPDATE ${name} SET ${name === "ErpEmployees" ? "Status='INACTIVE'" : "IsActive=0"} WHERE TenantID=@tenant AND ${idColumn}=@id`,
            );
          if (!r.rowsAffected[0]) throw new HttpError(404, "Record not found");
          await audit(tx, req, "DEACTIVATE", name, id);
        });
        res.json({ message: "Record deactivated; history retained" });
      }),
    );
  }
  directory("ErpCustomers", "/api/erp/customers", "CustomerID", [
    [
      "customerCode",
      "CustomerCode",
      sql.VarChar(30),
      (v) => text(v || crypto.randomUUID().slice(0, 20), "customerCode", 30),
    ],
    [
      "customerName",
      "CustomerName",
      sql.NVarChar(150),
      (v) => text(v, "customerName", 150),
    ],
    [
      "email",
      "Email",
      sql.VarChar(150),
      (v) => text(v || "", "email", 150, false),
    ],
  ]);
  directory("ErpEmployees", "/api/erp/employees", "EmployeeID", [
    [
      "empCode",
      "EmpCode",
      sql.VarChar(30),
      (v) =>
        text(v || "EMP-" + crypto.randomUUID().slice(0, 12), "empCode", 30),
    ],
    [
      "fullName",
      "FullName",
      sql.NVarChar(120),
      (v) => text(v, "fullName", 120),
    ],
    [
      "jobTitle",
      "JobTitle",
      sql.NVarChar(120),
      (v) => text(v, "jobTitle", 120),
    ],
    [
      "department",
      "Department",
      sql.NVarChar(80),
      (v) => text(v, "department", 80),
    ],
    ["location", "Location", sql.NVarChar(80), (v) => text(v, "location", 80)],
    [
      "annualSalary",
      "AnnualSalary",
      sql.Decimal(18, 2),
      (v) => money(v, "annualSalary"),
    ],
  ]);
}
function registerSales(app, state) {
  app.post(
    "/api/erp/sales-orders",
    allow("ADMIN", "OPERATOR"),
    wrap(async (req, res) =>
      res.status(201).json(
        await idempotent(state.pool, req, async (tx) => {
          const customer = integer(req.body.customerId, "customerId"),
            wh = integer(req.body.warehouseId, "warehouseId");
          if (
            !Array.isArray(req.body.lines) ||
            req.body.lines.length < 1 ||
            req.body.lines.length > 100
          )
            throw new HttpError(400, "Supply 1–100 order lines");
          const lines = req.body.lines
            .map((l) => ({
              itemId: integer(l.itemId, "itemId"),
              bin: text(l.binLocation, "binLocation", 50).toUpperCase(),
              qty: integer(l.quantity, "quantity", 1, 1000000),
            }))
            .sort((a, b) => a.itemId - b.itemId || a.bin.localeCompare(b.bin));
          if (
            new Set(lines.map((l) => `${l.itemId}:${l.bin}`)).size !==
            lines.length
          )
            throw new HttpError(400, "Duplicate item/bin order lines");
          const found = await request(tx, req.tenantId)
            .input("customer", sql.Int, customer)
            .input("wh", sql.Int, wh)
            .query(
              `SELECT CustomerName FROM ErpCustomers WHERE TenantID=@tenant AND CustomerID=@customer AND IsActive=1 AND EXISTS(SELECT 1 FROM ErpWarehouses WHERE TenantID=@tenant AND WarehouseID=@wh AND IsActive=1)`,
            );
          if (!found.recordset[0])
            throw new HttpError(
              404,
              "Customer or warehouse not found in tenant",
            );
          const number = "SO-" + crypto.randomUUID();
          const order = await request(tx, req.tenantId)
            .input("number", sql.VarChar(50), number)
            .input("customer", sql.Int, customer)
            .input("name", sql.NVarChar(150), found.recordset[0].CustomerName)
            .input("wh", sql.Int, wh)
            .query(
              `INSERT INTO ErpSalesOrders(TenantID,OrderNumber,CustomerID,CustomerName,Status,OrderTotal,WarehouseID) OUTPUT INSERTED.OrderID VALUES(@tenant,@number,@customer,@name,'PENDING',0,@wh)`,
            );
          const id = order.recordset[0].OrderID;
          for (const line of lines) {
            const r = await request(tx, req.tenantId)
              .input("order", sql.Int, id)
              .input("item", sql.Int, line.itemId)
              .input("bin", sql.VarChar(50), line.bin)
              .input("qty", sql.Int, line.qty)
              .query(
                `INSERT INTO ErpSalesOrderLines(TenantID,OrderID,ItemID,BinLocation,Quantity,UnitPrice) SELECT @tenant,@order,ItemID,@bin,@qty,UnitPrice FROM ErpCatalogItems WHERE TenantID=@tenant AND ItemID=@item AND IsActive=1`,
              );
            if (!r.rowsAffected[0])
              throw new HttpError(404, "Order item not found in tenant");
          }
          await request(tx, req.tenantId)
            .input("order", sql.Int, id)
            .query(
              `UPDATE ErpSalesOrders SET OrderTotal=(SELECT SUM(CONVERT(decimal(18,2),Quantity)*UnitPrice) FROM ErpSalesOrderLines WHERE TenantID=@tenant AND OrderID=@order) WHERE TenantID=@tenant AND OrderID=@order`,
            );
          await audit(tx, req, "CREATE", "sales_order", id, {
            number,
            lineCount: lines.length,
          });
          return { orderId: id, orderNumber: number, status: "PENDING" };
        }),
      ),
    ),
  );
  app.get(
    "/api/erp/sales-orders/:id",
    wrap(async (req, res) => {
      const id = integer(req.params.id, "id");
      const o = await request(state.pool, req.tenantId)
        .input("id", sql.Int, id)
        .query(
          "SELECT * FROM ErpSalesOrders WHERE TenantID=@tenant AND OrderID=@id",
        );
      if (!o.recordset[0]) throw new HttpError(404, "Order not found");
      const l = await request(state.pool, req.tenantId)
        .input("id", sql.Int, id)
        .query(
          "SELECT * FROM ErpSalesOrderLines WHERE TenantID=@tenant AND OrderID=@id ORDER BY ItemID,BinLocation",
        );
      res.json({ ...o.recordset[0], lines: l.recordset });
    }),
  );
  app.patch(
    "/api/erp/sales-orders/:id/status",
    allow("ADMIN", "OPERATOR"),
    wrap(async (req, res) =>
      res.json(
        await idempotent(state.pool, req, async (tx) => {
          const id = integer(req.params.id, "id"),
            status = req.body.status;
          const r = await request(tx, req.tenantId)
            .input("id", sql.Int, id)
            .query(
              "SELECT *,CONVERT(varchar(40),OrderTotal) TotalDecimal FROM ErpSalesOrders WITH(UPDLOCK,HOLDLOCK) WHERE TenantID=@tenant AND OrderID=@id",
            );
          const order = r.recordset[0];
          if (!order) throw new HttpError(404, "Order not found");
          if (
            !(
              {
                PENDING: ["ALLOCATED", "CANCELLED"],
                ALLOCATED: ["SHIPPED", "CANCELLED"],
              }[order.Status] || []
            ).includes(status)
          )
            throw new HttpError(409, "Invalid order status transition");
          const lines = (
            await request(tx, req.tenantId)
              .input("id", sql.Int, id)
              .query(
                "SELECT * FROM ErpSalesOrderLines WHERE TenantID=@tenant AND OrderID=@id ORDER BY ItemID,BinLocation",
              )
          ).recordset;
          for (const line of lines) {
            if (status === "SHIPPED") {
              await move(
                tx,
                req,
                {
                  itemId: line.ItemID,
                  warehouseId: order.WarehouseID,
                  binLocation: line.BinLocation,
                  movementType: "SHIPMENT",
                  quantity: line.Quantity,
                  referenceDoc: order.OrderNumber,
                  notes: "Sales order fulfillment",
                },
                true,
              );
            } else if (status === "ALLOCATED" || order.Status === "ALLOCATED") {
              // Serialize catalog then balance locks in the same order as movement operations.
              const item = await request(tx, req.tenantId)
                .input("item", sql.Int, line.ItemID)
                .query(
                  "SELECT ItemID FROM ErpCatalogItems WITH(UPDLOCK,HOLDLOCK) WHERE TenantID=@tenant AND ItemID=@item AND IsActive=1",
                );
              if (!item.recordset[0])
                throw new HttpError(409, "Order item inactive");
              const delta =
                status === "ALLOCATED" ? line.Quantity : -line.Quantity;
              const updated = await request(tx, req.tenantId)
                .input("item", sql.Int, line.ItemID)
                .input("wh", sql.Int, order.WarehouseID)
                .input("bin", sql.VarChar(50), line.BinLocation)
                .input("delta", sql.Int, delta)
                .query(
                  `UPDATE ErpStockBalances WITH(UPDLOCK,HOLDLOCK) SET ReservedQuantity=ReservedQuantity+@delta,UpdatedAt=SYSUTCDATETIME() WHERE TenantID=@tenant AND ItemID=@item AND WarehouseID=@wh AND BinLocation=@bin AND ReservedQuantity+@delta BETWEEN 0 AND QuantityOnHand`,
                );
              if (!updated.rowsAffected[0])
                throw new HttpError(
                  409,
                  "Insufficient stock to allocate order",
                );
            }
          }
          if (status === "SHIPPED")
            await journal(tx, req, {
              debit: "1100-AR",
              credit: "4000-REV",
              amount: order.TotalDecimal,
              referenceDoc: order.OrderNumber,
              memo: "Sales fulfillment revenue",
            });
          await request(tx, req.tenantId)
            .input("id", sql.Int, id)
            .input("status", sql.VarChar(20), status)
            .query(
              "UPDATE ErpSalesOrders SET Status=@status WHERE TenantID=@tenant AND OrderID=@id",
            );
          await audit(tx, req, "STATUS", "sales_order", id, {
            before: order.Status,
            after: status,
          });
          return { orderId: id, status };
        }),
      ),
    ),
  );
}
module.exports = { createApp };
