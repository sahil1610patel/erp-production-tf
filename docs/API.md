# API conventions

All paths below use JSON. Authentication is `POST /api/auth/login` with `{email,password}`. The response includes `{token,user}`. Tokens expire after eight hours. Send `Authorization: Bearer <token>` and `X-Tenant-Id: <positive integer>` on every authenticated request, including logout. Non-administrators can select only their assigned tenant. A tenant ID is never accepted from a request body as authorization.

Use a fresh `X-Idempotency-Key` for each logical stock movement, journal, sales order creation and status transition. Retain the **same** key and unchanged body if retrying that operation after a lost response. Reusing a key with different content returns 409. A database deadlock may return 409; retry only the same operation with bounded backoff. Do not turn every failure into a new mutation.

| Path | Methods | Purpose |
| --- | --- | --- |
| `/health` | GET | Process liveness |
| `/api/health`, `/api/ready` | GET | SQL readiness |
| `/api/auth/login` | POST | Authenticate and create durable session |
| `/api/auth/me` | GET | Current authenticated identity |
| `/api/auth/logout` | POST | Revoke session |
| `/api/tenants` | GET, POST | Visible companies / administrator provisioning |
| `/api/tenants/:id` | PUT, DELETE | Update / deactivate company while retaining history |
| `/api/users` | GET, POST | Tenant user directory / administrator provisioning |
| `/api/users/:id` | PATCH | Change role/status and revoke sessions |
| `/api/inventory/items` | GET, POST | Catalog, balances, warehouses and recent movements / new item |
| `/api/inventory/items/:id` | PUT, DELETE | Update / retire an empty item while retaining history |
| `/api/inventory/warehouses` | POST | Create tenant warehouse |
| `/api/inventory/movements` | POST | Atomic stock, journal and audit transaction |
| `/api/erp/modules` | GET | Recent GL/sales, customers and role-filtered HR |
| `/api/erp/customers` | POST | Create customer |
| `/api/erp/customers/:id` | PUT, DELETE | Update / deactivate customer |
| `/api/erp/sales-orders` | POST | Create priced order lines in PENDING state |
| `/api/erp/sales-orders/:id` | GET | Order with lines |
| `/api/erp/sales-orders/:id/status` | PATCH | Allocate, ship or cancel |
| `/api/erp/employees` | POST | Onboard employee |
| `/api/erp/employees/:id` | PUT, DELETE | Update / deactivate employee |
| `/api/erp/journals` | POST | Balanced manual journal (ADMIN) |
| `/api/audit?limit=100&before=...` | GET | Tenant audit cursor, newest first |

Request fields use camelCase; database record responses use the legacy PascalCase naming convention. Typical mutations:

```json
{
  "itemId": 1,
  "warehouseId": 1,
  "binLocation": "A-01",
  "movementType": "RECEIPT",
  "quantity": 10,
  "referenceDoc": "PO-10001",
  "notes": "Supplier receipt"
}
```

RECEIPT and SHIPMENT quantities are positive; ADJUSTMENT uses a nonzero signed quantity. Bins are normalized to uppercase. Opening stock must use this workflow to ensure a corresponding GL posting. Stock reserved for orders cannot be removed by an unrelated movement.

```json
{
  "customerId": 1,
  "warehouseId": 1,
  "lines": [{"itemId": 1, "binLocation": "A-01", "quantity": 2}]
}
```

Order prices and totals come from the catalog, not client-supplied totals. PATCH status bodies use `{"status":"ALLOCATED"}` then `{"status":"SHIPPED"}`. Allocation reserves quantities; shipping consumes reservations, posts stock/COGS and revenue/receivable journals in one transaction. Cancellation releases reservations. Posted financial/stock records are not deletable; use documented compensating transactions.

Errors are JSON with `error` and `requestId`. Typical statuses: 400 validation, 401 authentication/session, 403 role/tenant, 404 scoped resource, 409 conflict, 429 login throttle, 503 database startup. Internal SQL and secret-provider details are not returned to clients. Successful HTTP responses from mock tests do not verify database integrity; run the SQL integration suite.
