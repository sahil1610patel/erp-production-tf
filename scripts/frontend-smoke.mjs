/** Browser contract tests use explicit API fixtures, never a live ERP database. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createRequire } from "node:module";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(path.join(root, "tooling/package.json"));
const { chromium } = require("playwright-core");
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = path.join(
      root,
      "dist/frontend",
      pathname === "/" ? "index.html" : pathname,
    );
    if (!file.startsWith(path.join(root, "dist/frontend") + path.sep))
      throw Error();
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": file.endsWith(".html")
        ? "text/html"
        : file.endsWith(".css")
          ? "text/css"
          : "text/javascript",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROMIUM_PATH ||
    (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
  args: ["--no-sandbox"],
});
let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log(`PASS ${name}`);
}
const date = "2026-11-03T12:00:00.000Z";
function fixtures(tenant, role) {
  const suffix = tenant === "2" ? "EMEA" : "NA";
  const warehouses = [
    {
      WarehouseID: 1,
      WarehouseCode: "YYZ-01",
      WarehouseName: "Toronto Distribution",
      City: "Toronto",
    },
    {
      WarehouseID: 2,
      WarehouseCode: "YVR-01",
      WarehouseName: "Vancouver Distribution",
      City: "Vancouver",
    },
  ];
  const items = Array.from({ length: 15 }, (_, i) => ({
    ItemID: i + 1,
    SKU: `${suffix}-${String(i + 1).padStart(3, "0")}`,
    ItemName: `${suffix} ${["Precision bearing", "Industrial motor", "Control panel", "Hydraulic pump", "Safety equipment"][i % 5]} ${i + 1}`,
    Category: ["Components", "Equipment", "Automation"][i % 3],
    Description: "Quality approved enterprise inventory",
    UnitOfMeasure: "EA",
    UnitCost: 125 + i * 20,
    UnitPrice: 200 + i * 25,
    ReorderPoint: 10,
    ReorderQty: 50,
    TotalQuantityOnHand: i === 0 ? 0 : i === 1 ? 5 : 45 + i * 3,
    warehouseBalances: [
      {
        WarehouseID: (i % 2) + 1,
        BinLocation: `A-${i + 1}`,
        QuantityOnHand: i === 0 ? 0 : i === 1 ? 5 : 45 + i * 3,
        ReservedQuantity: 2,
      },
    ],
  }));
  return {
    inventory: {
      items,
      warehouses,
      movements: [
        {
          MovementID: 1,
          ItemID: 3,
          WarehouseID: 1,
          WarehouseCode: "YYZ-01",
          SKU: `${suffix}-003`,
          MovementType: "RECEIPT",
          QuantityChange: 20,
          QuantityAfter: 51,
          ReferenceDoc: "PO-1036",
          CreatedAt: date,
        },
      ],
    },
    modules: {
      customers: [
        {
          CustomerID: 1,
          CustomerCode: "ACME",
          CustomerName: `${suffix} Acme Industries`,
          Email: "buyer@example.com",
        },
      ],
      salesOrders: [
        {
          OrderID: 1,
          OrderNumber: "SO-1036",
          CustomerID: 1,
          CustomerName: "Acme Industries",
          OrderTotal: 6750,
          WarehouseCode: "YYZ-01",
          Status: "PENDING",
          CreatedAt: date,
        },
      ],
      employees: [
        {
          EmployeeID: 1,
          EmpCode: "EMP-001",
          FullName: "Jordan Lee",
          JobTitle: "Operations Manager",
          Department: "Logistics",
          Location: "Toronto",
          Status: "ACTIVE",
          ...(role === "ADMIN" ? { AnnualSalary: 95000 } : {}),
        },
      ],
      financeLedger: [
        {
          LedgerID: 1,
          JournalNumber: "JE-1036",
          AccountCode: "1400-INV",
          EntryType: "DEBIT",
          Amount: 2500,
          ReferenceDoc: "PO-1036",
          PostedAt: date,
        },
        {
          LedgerID: 2,
          JournalNumber: "JE-1036",
          AccountCode: "2100-AP",
          EntryType: "CREDIT",
          Amount: 2500,
          ReferenceDoc: "PO-1036",
          PostedAt: date,
        },
      ],
    },
  };
}
async function contextFor(role = "ADMIN") {
  const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    }),
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (msg) => {
    if (msg.type() === "warning") errors.push(msg.text());
  });
  const state = { html: false, requests: [], delayTenant: null, release: null, logins: 0, delayedUnauthorized: false };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      endpoint = new URL(request.url()).pathname,
      tenant = request.headers()["x-tenant-id"] || "1";
    state.requests.push({
      endpoint,
      headers: request.headers(),
      method: request.method(),
    });
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(body),
      });
    if (endpoint === "/api/auth/login")
      return json({
        token: `test-${role}${state.logins++ ? "-new" : ""}`,
        user: {
          userId: 1,
          tenantId: 1,
          role,
          fullName: "Alex Morgan",
          email: "alex@example.com",
          companyName: "North America",
          currency: "CAD",
        },
      });
    if (endpoint === "/api/auth/logout")
      return route.fulfill({ status: 204, body: "" });
    if (state.html && endpoint === "/api/inventory/items")
      return route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<!DOCTYPE html><html><body>Bad Gateway</body></html>",
      });
    if (state.delayTenant === tenant && endpoint === "/api/inventory/items") {
      const unauthorized = state.delayedUnauthorized;
      await new Promise((resolve) => (state.release = resolve));
      if (unauthorized) return route.fulfill({status:401,contentType:'application/json',body:JSON.stringify({error:'Old session expired'})});
    }
    const f = fixtures(tenant, role);
    if (endpoint === "/api/inventory/items") return json(f.inventory);
    if (endpoint === "/api/erp/modules") return json(f.modules);
    if (endpoint === "/api/tenants")
      return json(
        role === "ADMIN"
          ? [
              {
                TenantID: 1,
                CompanyName: "North America",
                BaseCurrency: "CAD",
              },
              { TenantID: 2, CompanyName: "EMEA", BaseCurrency: "EUR" },
            ]
          : [
              {
                TenantID: 1,
                CompanyName: "North America",
                BaseCurrency: "CAD",
              },
            ],
      );
    if (endpoint === "/api/audit")
      return json([
        {
          AuditID: 1,
          Action: "STOCK_MOVEMENT",
          Entity: "movement",
          EntityID: "1",
          UserID: 1,
          Detail: "Receipt posted",
          CreatedAt: date,
        },
      ]);
    if (endpoint === "/api/health")
      return json({ dbConnected: true, status: "ready" });
    return json({ message: "Fixture mutation accepted" });
  });
  await page.goto(url);
  await page
    .getByLabel("Corporate email", { exact: true })
    .fill("alex@example.com");
  await page
    .getByLabel("Password", { exact: true })
    .fill("test-password-for-fixtures");
  await page.getByRole("button", { name: "Sign in to workspace" }).click();
  await page.getByText("Connected", { exact: true }).waitFor();
  return { context, page, state, errors };
}
try {
  const { context, page, state, errors } = await contextFor();
  await check(
    "login, bearer authorization and mandatory tenant header",
    async () => {
      assert(
        state.requests
          .filter((r) => !r.endpoint.includes("/auth/login"))
          .every(
            (r) =>
              r.headers.authorization === "Bearer test-ADMIN" &&
              r.headers["x-tenant-id"] === "1",
          ),
      );
      assert.equal(await page.evaluate(() => localStorage.length), 0);
    },
  );
  await check("all nine modules render under production CSP", async () => {
    for (const label of [
      "Inventory",
      "Warehouse operations",
      "Sales orders",
      "Customers",
      "General ledger",
      "People & payroll",
      "Audit trail",
      "Workspace settings",
      "Overview",
    ]) {
      await page
        .locator("aside")
        .getByRole("button", { name: label, exact: label !== "Inventory" })
        .click();
      await page.locator("main h1").waitFor();
    }
    assert.deepEqual(errors, []);
  });
  await check("catalog search, pagination and admin edit modal", async () => {
    await page
      .locator("aside")
      .getByRole("button", { name: /^Inventory/ })
      .click();
    await page.getByLabel("Search current module").fill("NA-003");
    await page
      .getByRole("button", { name: "Edit NA-003", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    assert.equal(
      await page.locator("#form-sku").inputValue(),
      "NA-003",
    );
    await page.getByLabel("Close dialog").click();
    await page.getByLabel("Search current module").fill("");
    await page.getByLabel("Next page").click();
    await page.getByRole("button",{name:"Edit NA-009",exact:true}).waitFor();
    await page.getByLabel("Previous page").click();
  });
  await check(
    "tenant switch ignores late previous-tenant response",
    async () => {
      state.delayTenant = "1";
      await page.getByLabel("Refresh workspace data").click();
      await page.waitForFunction(
        () =>
          document.querySelector('[aria-label="Refresh workspace data"]')
            .disabled,
      );
      await page.getByLabel("Active enterprise tenant").selectOption("2");
      await page
        .getByRole("button", { name: "Edit EMEA-001", exact: true })
        .waitFor();
      state.release?.();
      state.delayTenant = null;
      await page.waitForTimeout(100);
      assert.equal(
        await page
          .getByRole("button", { name: "Edit NA-001", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await page.getByLabel("Active enterprise tenant").inputValue(),
        "2",
      );
    },
  );
  await page
    .locator("aside")
    .getByRole("button", { name: "Overview", exact: true })
    .click();

  await page.screenshot({
    path: process.env.ERP_SCREENSHOT || (existsSync("/workspace/setup") ? "/workspace/setup/erp-dashboard.png" : path.join(root,"dist/erp-dashboard.png")),
    fullPage: true,
  });
  await check(
    "HTML origin failure provides actionable HTTPS diagnostics",
    async () => {
      state.html = true;
      await page.getByLabel("Refresh workspace data").click();
      await page.getByText(/The API returned HTML/).waitFor();
      assert.match(
        await page.locator('[role="alert"]').innerText(),
        /certificate|HTTPS/,
      );
    },
  );
  await check("mobile viewport has no page overflow", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
    await page.getByLabel("Toggle navigation").click();
    await page
      .locator("aside")
      .getByRole("button", { name: "People & payroll", exact: true })
      .click();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    );
  });
  await context.close();
  for (const role of ["OPERATOR", "AUDITOR"]) {
    const c = await contextFor(role);
    await check(`${role} controls and payroll redaction`, async () => {
      await c.page
        .locator("aside")
        .getByRole("button", { name: /^Inventory/ })
        .click();
      assert.equal(
        await c.page
          .getByRole("button", { name: "Edit NA-001", exact: true })
          .count(),
        0,
      );
      assert.equal(
        await c.page
          .getByRole("button", {
            name: "Record movement for NA-001",
            exact: true,
          })
          .count(),
        role === "OPERATOR" ? 1 : 0,
      );
      await c.page
        .locator("aside")
        .getByRole("button", { name: "People & payroll", exact: true })
        .click();
      assert.equal(
        await c.page.getByText("Restricted", { exact: true }).count(),
        1,
      );
      assert.equal(
        await c.page.getByRole("button", { name: /Onboard employee/ }).count(),
        0,
      );
      assert.deepEqual(c.errors, []);
    });
    await c.context.close();
  }
  const renewed = await contextFor();
  await check('late 401 cannot invalidate a newer login', async()=>{
    renewed.state.delayTenant='1'; renewed.state.delayedUnauthorized=true;
    await renewed.page.getByLabel('Refresh workspace data').click();
    for(let i=0;i<40&&!renewed.state.release;i++)await renewed.page.waitForTimeout(25);
    assert.equal(typeof renewed.state.release,'function');
    const release=renewed.state.release;renewed.state.delayTenant=null;
    await renewed.page.locator('aside').getByRole('button',{name:'Sign out',exact:true}).click();
    await renewed.page.getByLabel('Corporate email',{exact:true}).fill('alex@example.com');
    await renewed.page.getByLabel('Password',{exact:true}).fill('test-password-for-fixtures');
    await renewed.page.getByRole('button',{name:'Sign in to workspace'}).click();
    await renewed.page.getByText('Connected',{exact:true}).waitFor();
    release();await renewed.page.waitForTimeout(150);
    assert.equal(await renewed.page.getByRole('heading',{name:'Enterprise overview',exact:true}).count(),1);
    assert.equal(await renewed.page.getByRole('button',{name:'Sign in to workspace'}).count(),0);
  });
  await renewed.context.close();
  console.log(
    `${passed} browser contract checks passed (API fixtures, not SQL integration).`,
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
