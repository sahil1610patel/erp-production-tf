const express = require('express');
const sql = require('mssql');
const cors = require('cors');
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors());

const PORT = process.env.PORT || 5000;
const REGION = process.env.AWS_REGION || "ca-central-1";
const SECRET_ID = process.env.SECRET_ID;
const JWT_SECRET = process.env.JWT_SECRET || "nexus-global-erp-2026-hmac-sha256-enterprise-key";

let dbPool = null;
let lastDbError = null;

// ============================================================================
// 1. CRYPTOGRAPHIC PASSWORD HASHING & JWT ENGINE (ZERO NATIVE BUILD DEPS)
// ============================================================================
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const derived = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return `${salt}:${derived}`;
}

function verifyPassword(password, storedHash) {
    const [salt, key] = String(storedHash || '').split(':');
    if (!salt || !key) return false;
    const derived = crypto.scryptSync(String(password), salt, 64);
    const keyBuffer = Buffer.from(key, 'hex');
    return derived.length === keyBuffer.length && crypto.timingSafeEqual(derived, keyBuffer);
}

function signJwt(payload, expiresInSeconds = 28800) {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString('base64url');
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) throw new Error('Invalid token format');
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest('base64url');
    if (signature !== expectedSig) throw new Error('Invalid token signature');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
        throw new Error('Session token expired');
    }
    return payload;
}

function authenticate(req, res, next) {
    try {
        const authHeader = req.headers.authorization || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : (req.query.token || '');
        if (!token) {
            return res.status(401).json({ error: 'Authentication required. Please sign in.' });
        }
        const decoded = verifyJwt(token);
        const requestedTenant = parseInt(req.headers['x-tenant-id'] || req.query.tenantId, 10);
        req.user = {
            ...decoded,
            activeTenantId: (decoded.role === 'ADMIN' && requestedTenant) ? requestedTenant : decoded.tenantId
        };
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired session', details: err.message });
    }
}

function authorizeRoles(...allowedRoles) {
    return (req, res, next) => {
        if (!req.user || !allowedRoles.includes(req.user.role)) {
            return res.status(403).json({
                error: `RBAC Access Denied: Role '${req.user?.role || 'UNKNOWN'}' cannot perform this action. Required: ${allowedRoles.join(' or ')}`
            });
        }
        next();
    };
}

// ============================================================================
// 2. AWS SECRETS MANAGER & MULTI-AZ RDS DATABASE INITIALIZATION
// ============================================================================
async function getDbSecret() {
    const client = new SecretsManagerClient({ region: REGION });
    const response = await client.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    return JSON.parse(response.SecretString);
}

async function initDb() {
    try {
        console.log(`Fetching RDS credentials from Secrets Manager (${SECRET_ID})...`);
        const secret = await getDbSecret();

        const masterConfig = {
            user: secret.username,
            password: secret.password,
            server: secret.host,
            port: Number(secret.port || 1433),
            database: 'master',
            connectionTimeout: 15000,
            requestTimeout: 30000,
            options: { encrypt: true, trustServerCertificate: true }
        };

        const masterPool = await sql.connect(masterConfig);
        await masterPool.request().query(`
            IF NOT EXISTS (SELECT * FROM sys.databases WHERE name = 'ERP_DB')
            CREATE DATABASE ERP_DB;
        `);
        await masterPool.close();

        const appConfig = {
            ...masterConfig,
            database: 'ERP_DB',
            pool: { max: 15, min: 2, idleTimeoutMillis: 30000 }
        };

        dbPool = await sql.connect(appConfig);
        await createEnterpriseSchemaAndSeed();
        lastDbError = null;
        console.log("SUCCESS: Nexus Global Enterprise ERP v3.0 Schema & Seed Data Ready!");
    } catch (err) {
        lastDbError = err.message;
        console.error("Database initialization error (retrying in 10s):", err.message);
        setTimeout(initDb, 10000);
    }
}

async function createEnterpriseSchemaAndSeed() {
    await dbPool.request().query(`
        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpTenants' AND xtype='U')
        CREATE TABLE ErpTenants (
            TenantID INT IDENTITY(1,1) PRIMARY KEY,
            TenantCode VARCHAR(30) NOT NULL UNIQUE,
            CompanyName NVARCHAR(150) NOT NULL,
            BaseCurrency CHAR(3) NOT NULL DEFAULT 'CAD',
            Country NVARCHAR(80) NOT NULL,
            CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpUsers' AND xtype='U')
        CREATE TABLE ErpUsers (
            UserID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            Email VARCHAR(150) NOT NULL UNIQUE,
            PasswordHash VARCHAR(255) NOT NULL,
            FullName NVARCHAR(120) NOT NULL,
            Role VARCHAR(30) NOT NULL,
            Department NVARCHAR(80) NOT NULL,
            IsActive BIT NOT NULL DEFAULT 1,
            CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpWarehouses' AND xtype='U')
        CREATE TABLE ErpWarehouses (
            WarehouseID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            WarehouseCode VARCHAR(30) NOT NULL UNIQUE,
            WarehouseName NVARCHAR(120) NOT NULL,
            City NVARCHAR(80) NOT NULL,
            Country NVARCHAR(80) NOT NULL
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpCatalogItems' AND xtype='U')
        CREATE TABLE ErpCatalogItems (
            ItemID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            SKU VARCHAR(60) NOT NULL,
            ItemName NVARCHAR(200) NOT NULL,
            Category NVARCHAR(80) NOT NULL,
            Description NVARCHAR(500) NULL,
            UnitOfMeasure VARCHAR(20) NOT NULL DEFAULT 'EA',
            UnitCost DECIMAL(12,2) NOT NULL DEFAULT 0.00,
            UnitPrice DECIMAL(12,2) NOT NULL DEFAULT 0.00,
            ReorderPoint INT NOT NULL DEFAULT 20,
            ReorderQty INT NOT NULL DEFAULT 50,
            IsActive BIT NOT NULL DEFAULT 1,
            UpdatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
            CONSTRAINT UQ_ErpTenant_SKU UNIQUE (TenantID, SKU)
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpStockBalances' AND xtype='U')
        CREATE TABLE ErpStockBalances (
            BalanceID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            ItemID INT NOT NULL REFERENCES ErpCatalogItems(ItemID) ON DELETE CASCADE,
            WarehouseID INT NOT NULL REFERENCES ErpWarehouses(WarehouseID),
            BinLocation VARCHAR(50) NOT NULL DEFAULT 'A1-RACK-01',
            QuantityOnHand INT NOT NULL DEFAULT 0,
            UpdatedAt DATETIME2 DEFAULT SYSUTCDATETIME(),
            CONSTRAINT UQ_ErpItem_Warehouse UNIQUE (ItemID, WarehouseID)
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpStockMovements' AND xtype='U')
        CREATE TABLE ErpStockMovements (
            MovementID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            ItemID INT NOT NULL REFERENCES ErpCatalogItems(ItemID) ON DELETE CASCADE,
            WarehouseID INT NOT NULL REFERENCES ErpWarehouses(WarehouseID),
            BinLocation VARCHAR(50) NOT NULL,
            MovementType VARCHAR(30) NOT NULL,
            QuantityChange INT NOT NULL,
            QuantityBefore INT NOT NULL,
            QuantityAfter INT NOT NULL,
            ReferenceDoc VARCHAR(80) NOT NULL,
            Notes NVARCHAR(300) NULL,
            PerformedBy NVARCHAR(120) NOT NULL,
            CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpFinanceLedger' AND xtype='U')
        CREATE TABLE ErpFinanceLedger (
            EntryID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            JournalNumber VARCHAR(40) NOT NULL,
            AccountCode VARCHAR(30) NOT NULL,
            AccountName NVARCHAR(120) NOT NULL,
            EntryType VARCHAR(20) NOT NULL,
            Amount DECIMAL(14,2) NOT NULL,
            ReferenceDoc VARCHAR(80) NOT NULL,
            Memo NVARCHAR(250) NULL,
            PostedBy NVARCHAR(120) NOT NULL,
            PostedAt DATETIME2 DEFAULT SYSUTCDATETIME()
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpSalesOrders' AND xtype='U')
        CREATE TABLE ErpSalesOrders (
            OrderID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            OrderNumber VARCHAR(40) NOT NULL,
            CustomerName NVARCHAR(150) NOT NULL,
            Status VARCHAR(30) NOT NULL,
            OrderTotal DECIMAL(14,2) NOT NULL,
            WarehouseCode VARCHAR(30) NOT NULL,
            CreatedAt DATETIME2 DEFAULT SYSUTCDATETIME()
        );

        IF NOT EXISTS (SELECT * FROM sysobjects WHERE name='ErpEmployees' AND xtype='U')
        CREATE TABLE ErpEmployees (
            EmployeeID INT IDENTITY(1,1) PRIMARY KEY,
            TenantID INT NOT NULL REFERENCES ErpTenants(TenantID),
            EmpCode VARCHAR(30) NOT NULL,
            FullName NVARCHAR(120) NOT NULL,
            JobTitle NVARCHAR(120) NOT NULL,
            Department NVARCHAR(80) NOT NULL,
            Location NVARCHAR(80) NOT NULL,
            AnnualSalary DECIMAL(12,2) NOT NULL,
            Status VARCHAR(30) NOT NULL DEFAULT 'ACTIVE'
        );
    `);

    const existingTenants = await dbPool.request().query('SELECT COUNT(*) AS cnt FROM ErpTenants');
    if (existingTenants.recordset[0].cnt > 0) return;

    console.log("Seeding initial Multinational Enterprise ERP dataset...");
    const adminHash = hashPassword('Admin@2026!');
    const userHash = hashPassword('User@2026!');
    const auditHash = hashPassword('Audit@2026!');

    await dbPool.request().query(`
        INSERT INTO ErpTenants (TenantCode, CompanyName, BaseCurrency, Country) VALUES
        ('NEXUS-NA', 'Nexus Global Industries - North America', 'CAD', 'Canada'),
        ('NEXUS-EU', 'Nexus Global GmbH - EMEA Division', 'EUR', 'Germany');
    `);

    await dbPool.request()
        .input('adminHash', sql.VarChar(255), adminHash)
        .input('userHash', sql.VarChar(255), userHash)
        .input('auditHash', sql.VarChar(255), auditHash)
        .query(`
            INSERT INTO ErpUsers (TenantID, Email, PasswordHash, FullName, Role, Department) VALUES
            (1, 'admin@nexuscorp.com', @adminHash, 'Sahil Patel (Global ERP Admin)', 'ADMIN', 'Executive IT & Cloud Architecture'),
            (1, 'operator@nexuscorp.com', @userHash, 'Marcus Vance (WMS Operator)', 'OPERATOR', 'Supply Chain & Logistics'),
            (1, 'auditor@nexuscorp.com', @auditHash, 'Elena Rostova (SOX Auditor)', 'AUDITOR', 'Global Risk & Compliance');
        `);

    await dbPool.request().query(`
        INSERT INTO ErpWarehouses (TenantID, WarehouseCode, WarehouseName, City, Country) VALUES
        (1, 'YYZ-DC01', 'Toronto Automated Fulfillment Hub', 'Mississauga, ON', 'Canada'),
        (1, 'YVR-DC02', 'Vancouver Pacific Gateway Depot', 'Richmond, BC', 'Canada'),
        (1, 'FRA-DC03', 'Frankfurt European Cross-Dock', 'Frankfurt', 'Germany'),
        (2, 'BER-DC01', 'Berlin Central Logistics Park', 'Berlin', 'Germany');

        INSERT INTO ErpCatalogItems (TenantID, SKU, ItemName, Category, Description, UnitOfMeasure, UnitCost, UnitPrice, ReorderPoint, ReorderQty) VALUES
        (1, 'SRV-BLADE-X9', 'Nexus Hyperscale Server Blade X9', 'Data Center Hardware', 'Dual-Socket 128-Core Rackmount Compute Node', 'EA', 4200.00, 6899.00, 15, 40),
        (1, 'NET-SW-100G', 'Quantum 64-Port 100GbE Core Switch', 'Networking', 'Low-latency L3 spine switch with redundant PSUs', 'EA', 1850.00, 3299.00, 20, 50),
        (1, 'STO-NVME-15T', 'Enterprise U.3 NVMe SSD 15.36TB', 'Storage Media', 'PCIe Gen5 High-Endurance Datacenter Drive', 'EA', 690.00, 1199.00, 40, 100),
        (1, 'SEC-HSM-FIPS', 'CloudHSM Hardware Security Module', 'Cybersecurity', 'FIPS 140-3 Level 3 Tamper-Proof Appliance', 'EA', 5400.00, 8950.00, 10, 25),
        (1, 'OPT-QSFP-28', '100G QSFP28 SR4 Optical Transceiver', 'Optics & Cabling', 'Multimode fiber optic transceiver module', 'BOX', 95.00, 210.00, 80, 250),
        (1, 'PWR-UPS-10KV', 'SmartOnline 10kVA Modular Rack UPS', 'Power Management', 'Lithium-ion double-conversion rackmount UPS', 'EA', 2100.00, 3590.00, 12, 30),
        (2, 'EU-SRV-NODE1', 'EMEA Sovereign Cloud Compute Node', 'Data Center Hardware', 'GDPR-compliant encrypted compute chassis', 'EA', 3900.00, 6400.00, 10, 30);

        INSERT INTO ErpStockBalances (TenantID, ItemID, WarehouseID, BinLocation, QuantityOnHand) VALUES
        (1, 1, 1, 'YYZ-A01-R02', 42),
        (1, 1, 2, 'YVR-B04-R01', 8),
        (1, 2, 1, 'YYZ-A02-R05', 11),
        (1, 3, 1, 'YYZ-C01-BIN9', 165),
        (1, 4, 1, 'YYZ-VAULT-01', 4),
        (1, 5, 3, 'FRA-OPT-B12', 45),
        (1, 6, 2, 'YVR-PWR-03', 0),
        (2, 7, 4, 'BER-A01-R01', 28);

        INSERT INTO ErpStockMovements (TenantID, ItemID, WarehouseID, BinLocation, MovementType, QuantityChange, QuantityBefore, QuantityAfter, ReferenceDoc, Notes, PerformedBy) VALUES
        (1, 1, 1, 'YYZ-A01-R02', 'RECEIPT', 50, 0, 50, 'PO-2026-8801', 'Initial Q4 factory batch from Taiwan', 'Sahil Patel (Global ERP Admin)'),
        (1, 1, 1, 'YYZ-A01-R02', 'SHIPMENT', -8, 50, 42, 'SO-2026-4410', 'Fulfilled enterprise order for RBC Toronto', 'Marcus Vance (WMS Operator)'),
        (1, 2, 1, 'YYZ-A02-R05', 'SHIPMENT', -14, 25, 11, 'SO-2026-4419', 'Dispatched core switches to Montreal PoP', 'Marcus Vance (WMS Operator)'),
        (1, 4, 1, 'YYZ-VAULT-01', 'ADJUSTMENT', -2, 6, 4, 'AUD-2026-102', 'Allocated 2 units to internal R&D lab', 'Sahil Patel (Global ERP Admin)');

        INSERT INTO ErpFinanceLedger (TenantID, JournalNumber, AccountCode, AccountName, EntryType, Amount, ReferenceDoc, Memo, PostedBy) VALUES
        (1, 'JE-2026-1001', '1400-INV', 'Finished Goods Inventory Asset', 'DEBIT', 210000.00, 'PO-2026-8801', 'Capitalized 50x SRV-BLADE-X9 receipt', 'System Auto-GL'),
        (1, 'JE-2026-1001', '2100-AP', 'Accounts Payable - Trade', 'CREDIT', 210000.00, 'PO-2026-8801', 'Vendor liability recorded', 'System Auto-GL'),
        (1, 'JE-2026-1002', '5000-COGS', 'Cost of Goods Sold', 'DEBIT', 33600.00, 'SO-2026-4410', 'COGS recognition for 8x SRV-BLADE-X9', 'System Auto-GL'),
        (1, 'JE-2026-1003', '4000-REV', 'Enterprise Hardware Revenue', 'CREDIT', 55192.00, 'SO-2026-4410', 'Invoice billed to Royal Bank of Canada', 'Sahil Patel (Global ERP Admin)');

        INSERT INTO ErpSalesOrders (TenantID, OrderNumber, CustomerName, Status, OrderTotal, WarehouseCode) VALUES
        (1, 'SO-2026-4410', 'Royal Bank of Canada (RBC)', 'SHIPPED', 55192.00, 'YYZ-DC01'),
        (1, 'SO-2026-4419', 'Bell Canada Enterprise Telecom', 'SHIPPED', 46186.00, 'YYZ-DC01'),
        (1, 'SO-2026-4425', 'Shopify Cloud Infrastructure', 'ALLOCATED', 119900.00, 'YYZ-DC01'),
        (1, 'SO-2026-4431', 'Telus Western Data Centers', 'PENDING', 27596.00, 'YVR-DC02');

        INSERT INTO ErpEmployees (TenantID, EmpCode, FullName, JobTitle, Department, Location, AnnualSalary, Status) VALUES
        (1, 'EMP-1001', 'Sahil D. Patel', 'VP of Cloud Architecture & Security', 'Executive IT', 'Toronto, ON', 185000.00, 'ACTIVE'),
        (1, 'EMP-1002', 'Marcus Vance', 'Lead Logistics Coordinator', 'Supply Chain & WMS', 'Mississauga, ON', 88000.00, 'ACTIVE'),
        (1, 'EMP-1003', 'Elena Rostova', 'Principal SOX & Financial Auditor', 'Finance & Risk', 'Toronto, ON', 132000.00, 'ACTIVE'),
        (1, 'EMP-1004', 'David Chen', 'Regional Sales Director', 'Enterprise Sales', 'Vancouver, BC', 148000.00, 'ACTIVE');
    `);
}

initDb();

// ============================================================================
// 3. HEALTH & AUTHENTICATION ENDPOINTS (SUPPORTS BOTH POST & GET FALLBACK)
// ============================================================================
app.get('/health', (req, res) => {
    res.status(200).json({
        status: "Healthy",
        service: "Nexus Global Enterprise ERP v3.0",
        dbConnected: Boolean(dbPool && dbPool.connected),
        dbError: lastDbError
    });
});

app.get('/api/health', (req, res) => {
    res.status(200).json({
        status: "Healthy",
        service: "Nexus Global Enterprise ERP v3.0",
        dbConnected: Boolean(dbPool && dbPool.connected),
        dbError: lastDbError
    });
});

async function handleLoginRequest(req, res) {
    const email = req.body?.email || req.query?.email || '';
    const password = req.body?.password || req.query?.password || '';
    try {
        if (!dbPool || !dbPool.connected) {
            return res.status(503).json({ error: "Database initializing, please wait 10 seconds." });
        }
        const result = await dbPool.request()
            .input('email', sql.VarChar(150), String(email).trim().toLowerCase())
            .query(`
                SELECT u.*, t.TenantCode, t.CompanyName, t.BaseCurrency
                FROM ErpUsers u
                JOIN ErpTenants t ON u.TenantID = t.TenantID
                WHERE LOWER(u.Email) = @email AND u.IsActive = 1
            `);

        const user = result.recordset[0];
        if (!user || !verifyPassword(password, user.PasswordHash)) {
            return res.status(401).json({ error: "Invalid corporate email or password." });
        }

        const tokenPayload = {
            userId: user.UserID,
            tenantId: user.TenantID,
            tenantCode: user.TenantCode,
            companyName: user.CompanyName,
            currency: user.BaseCurrency,
            email: user.Email,
            fullName: user.FullName,
            role: user.Role,
            department: user.Department
        };

        const token = signJwt(tokenPayload);
        res.json({ token, user: tokenPayload });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}

app.post('/api/auth/login', handleLoginRequest);
app.get('/api/auth/login', handleLoginRequest);

app.get('/api/tenants', authenticate, async (req, res) => {
    try {
        const result = await dbPool.request().query('SELECT * FROM ErpTenants ORDER BY TenantID');
        res.json(result.recordset);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// 4. INVENTORY & WAREHOUSE MANAGEMENT REST API (CRUD + ACID STOCK MOVEMENTS)
// ============================================================================
app.get('/api/inventory/items', authenticate, async (req, res) => {
    const tenantId = req.user.activeTenantId;
    try {
        const itemsResult = await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .query(`
                SELECT 
                    i.ItemID, i.TenantID, i.SKU, i.ItemName, i.Category, i.Description,
                    i.UnitOfMeasure, i.UnitCost, i.UnitPrice, i.ReorderPoint, i.ReorderQty, i.UpdatedAt,
                    ISNULL(SUM(b.QuantityOnHand), 0) AS TotalQuantityOnHand
                FROM ErpCatalogItems i
                LEFT JOIN ErpStockBalances b ON i.ItemID = b.ItemID
                WHERE i.TenantID = @tenantId AND i.IsActive = 1
                GROUP BY i.ItemID, i.TenantID, i.SKU, i.ItemName, i.Category, i.Description,
                         i.UnitOfMeasure, i.UnitCost, i.UnitPrice, i.ReorderPoint, i.ReorderQty, i.UpdatedAt
                ORDER BY i.SKU ASC
            `);

        const balancesResult = await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .query(`
                SELECT 
                    b.BalanceID, b.ItemID, b.WarehouseID, w.WarehouseCode, w.WarehouseName, w.City,
                    b.BinLocation, b.QuantityOnHand, b.UpdatedAt
                FROM ErpStockBalances b
                JOIN ErpWarehouses w ON b.WarehouseID = w.WarehouseID
                WHERE b.TenantID = @tenantId
            `);

        const warehousesResult = await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .query(`SELECT * FROM ErpWarehouses WHERE TenantID = @tenantId ORDER BY WarehouseCode`);

        const movementsResult = await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .query(`
                SELECT TOP 50
                    m.*, i.SKU, i.ItemName, w.WarehouseCode, w.WarehouseName
                FROM ErpStockMovements m
                JOIN ErpCatalogItems i ON m.ItemID = i.ItemID
                JOIN ErpWarehouses w ON m.WarehouseID = w.WarehouseID
                WHERE m.TenantID = @tenantId
                ORDER BY m.CreatedAt DESC
            `);

        const balancesByItem = {};
        for (const bal of balancesResult.recordset) {
            if (!balancesByItem[bal.ItemID]) balancesByItem[bal.ItemID] = [];
            balancesByItem[bal.ItemID].push(bal);
        }

        const enrichedItems = itemsResult.recordset.map(item => ({
            ...item,
            warehouseBalances: balancesByItem[item.ItemID] || []
        }));

        res.json({
            items: enrichedItems,
            warehouses: warehousesResult.recordset,
            movements: movementsResult.recordset
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Master Catalog SKU (ADMIN Only)
app.post('/api/inventory/items', authenticate, authorizeRoles('ADMIN'), async (req, res) => {
    const tenantId = req.user.activeTenantId;
    const {
        sku, itemName, category, description, unitOfMeasure,
        unitCost, unitPrice, reorderPoint, reorderQty,
        initialWarehouseId, initialBin, initialQty
    } = req.body;

    if (!sku || !itemName || !category) {
        return res.status(400).json({ error: "SKU, Item Name, and Category are required." });
    }

    const transaction = new sql.Transaction(dbPool);
    try {
        await transaction.begin();

        const insertItem = await new sql.Request(transaction)
            .input('tenantId', sql.Int, tenantId)
            .input('sku', sql.VarChar(60), String(sku).trim().toUpperCase())
            .input('itemName', sql.NVarChar(200), String(itemName).trim())
            .input('category', sql.NVarChar(80), String(category).trim())
            .input('description', sql.NVarChar(500), description || '')
            .input('uom', sql.VarChar(20), unitOfMeasure || 'EA')
            .input('unitCost', sql.Decimal(12, 2), Number(unitCost || 0))
            .input('unitPrice', sql.Decimal(12, 2), Number(unitPrice || 0))
            .input('reorderPoint', sql.Int, Number(reorderPoint ?? 20))
            .input('reorderQty', sql.Int, Number(reorderQty ?? 50))
            .query(`
                INSERT INTO ErpCatalogItems (TenantID, SKU, ItemName, Category, Description, UnitOfMeasure, UnitCost, UnitPrice, ReorderPoint, ReorderQty)
                OUTPUT INSERTED.ItemID
                VALUES (@tenantId, @sku, @itemName, @category, @description, @uom, @unitCost, @unitPrice, @reorderPoint, @reorderQty)
            `);

        const newItemId = insertItem.recordset[0].ItemID;
        const initQuantity = parseInt(initialQty || 0, 10);

        if (initialWarehouseId && initQuantity > 0) {
            const bin = String(initialBin || 'A1-RACK-01').trim().toUpperCase();
            await new sql.Request(transaction)
                .input('tenantId', sql.Int, tenantId)
                .input('itemId', sql.Int, newItemId)
                .input('warehouseId', sql.Int, Number(initialWarehouseId))
                .input('bin', sql.VarChar(50), bin)
                .input('qty', sql.Int, initQuantity)
                .query(`
                    INSERT INTO ErpStockBalances (TenantID, ItemID, WarehouseID, BinLocation, QuantityOnHand)
                    VALUES (@tenantId, @itemId, @warehouseId, @bin, @qty)
                `);

            await new sql.Request(transaction)
                .input('tenantId', sql.Int, tenantId)
                .input('itemId', sql.Int, newItemId)
                .input('warehouseId', sql.Int, Number(initialWarehouseId))
                .input('bin', sql.VarChar(50), bin)
                .input('qty', sql.Int, initQuantity)
                .input('ref', sql.VarChar(80), `INIT-${String(sku).trim().toUpperCase()}`)
                .input('user', sql.NVarChar(120), req.user.fullName)
                .query(`
                    INSERT INTO ErpStockMovements (TenantID, ItemID, WarehouseID, BinLocation, MovementType, QuantityChange, QuantityBefore, QuantityAfter, ReferenceDoc, Notes, PerformedBy)
                    VALUES (@tenantId, @itemId, @warehouseId, @bin, 'RECEIPT', @qty, 0, @qty, @ref, 'Initial opening stock balance', @user)
                `);
        }

        await transaction.commit();
        res.status(201).json({ message: "Catalog SKU created successfully", itemId: newItemId });
    } catch (err) {
        await transaction.rollback();
        res.status(400).json({ error: err.message });
    }
});

// Update Master Catalog SKU (ADMIN Only)
app.put('/api/inventory/items/:id', authenticate, authorizeRoles('ADMIN'), async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    const tenantId = req.user.activeTenantId;
    const { itemName, category, description, unitOfMeasure, unitCost, unitPrice, reorderPoint, reorderQty } = req.body;

    try {
        await dbPool.request()
            .input('itemId', sql.Int, itemId)
            .input('tenantId', sql.Int, tenantId)
            .input('itemName', sql.NVarChar(200), itemName)
            .input('category', sql.NVarChar(80), category)
            .input('description', sql.NVarChar(500), description || '')
            .input('uom', sql.VarChar(20), unitOfMeasure || 'EA')
            .input('unitCost', sql.Decimal(12, 2), Number(unitCost))
            .input('unitPrice', sql.Decimal(12, 2), Number(unitPrice))
            .input('reorderPoint', sql.Int, Number(reorderPoint))
            .input('reorderQty', sql.Int, Number(reorderQty))
            .query(`
                UPDATE ErpCatalogItems
                SET ItemName = @itemName, Category = @category, Description = @description,
                    UnitOfMeasure = @uom, UnitCost = @unitCost, UnitPrice = @unitPrice,
                    ReorderPoint = @reorderPoint, ReorderQty = @reorderQty, UpdatedAt = SYSUTCDATETIME()
                WHERE ItemID = @itemId AND TenantID = @tenantId
            `);

        res.json({ message: "Catalog SKU updated successfully." });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Delete Master Catalog SKU (ADMIN Only)
app.delete('/api/inventory/items/:id', authenticate, authorizeRoles('ADMIN'), async (req, res) => {
    const itemId = parseInt(req.params.id, 10);
    const tenantId = req.user.activeTenantId;
    try {
        await dbPool.request()
            .input('itemId', sql.Int, itemId)
            .input('tenantId', sql.Int, tenantId)
            .query(`DELETE FROM ErpCatalogItems WHERE ItemID = @itemId AND TenantID = @tenantId`);
        res.json({ message: "Catalog SKU and associated stock records deleted." });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Log ACID Warehouse Stock Movement (ADMIN & OPERATOR)
app.post('/api/inventory/movements', authenticate, authorizeRoles('ADMIN', 'OPERATOR'), async (req, res) => {
    const tenantId = req.user.activeTenantId;
    const { itemId, warehouseId, binLocation, movementType, quantity, referenceDoc, notes } = req.body;

    const rawQty = parseInt(quantity, 10);
    if (!itemId || !warehouseId || !movementType || isNaN(rawQty) || rawQty === 0) {
        return res.status(400).json({ error: "Item, Warehouse, Movement Type, and non-zero Quantity are required." });
    }

    let delta = rawQty;
    if (movementType === 'SHIPMENT') delta = -Math.abs(rawQty);
    if (movementType === 'RECEIPT') delta = Math.abs(rawQty);

    const transaction = new sql.Transaction(dbPool);
    try {
        await transaction.begin();

        const balRes = await new sql.Request(transaction)
            .input('tenantId', sql.Int, tenantId)
            .input('itemId', sql.Int, Number(itemId))
            .input('warehouseId', sql.Int, Number(warehouseId))
            .query(`
                SELECT BalanceID, QuantityOnHand, BinLocation
                FROM ErpStockBalances WITH (UPDLOCK, HOLDLOCK)
                WHERE TenantID = @tenantId AND ItemID = @itemId AND WarehouseID = @warehouseId
            `);

        const currentBal = balRes.recordset[0];
        const qtyBefore = currentBal ? currentBal.QuantityOnHand : 0;
        const qtyAfter = qtyBefore + delta;
        const finalBin = String(binLocation || currentBal?.BinLocation || 'A1-RACK-01').trim().toUpperCase();

        if (qtyAfter < 0) {
            throw new Error(`Insufficient stock in warehouse! Available: ${qtyBefore}, Attempted deduction: ${Math.abs(delta)}`);
        }

        if (currentBal) {
            await new sql.Request(transaction)
                .input('balanceId', sql.Int, currentBal.BalanceID)
                .input('qtyAfter', sql.Int, qtyAfter)
                .input('bin', sql.VarChar(50), finalBin)
                .query(`
                    UPDATE ErpStockBalances
                    SET QuantityOnHand = @qtyAfter, BinLocation = @bin, UpdatedAt = SYSUTCDATETIME()
                    WHERE BalanceID = @balanceId
                `);
        } else {
            await new sql.Request(transaction)
                .input('tenantId', sql.Int, tenantId)
                .input('itemId', sql.Int, Number(itemId))
                .input('warehouseId', sql.Int, Number(warehouseId))
                .input('bin', sql.VarChar(50), finalBin)
                .input('qtyAfter', sql.Int, qtyAfter)
                .query(`
                    INSERT INTO ErpStockBalances (TenantID, ItemID, WarehouseID, BinLocation, QuantityOnHand)
                    VALUES (@tenantId, @itemId, @warehouseId, @bin, @qtyAfter)
                `);
        }

        const refNumber = String(referenceDoc || `MV-${Date.now().toString().slice(-6)}`).trim().toUpperCase();
        await new sql.Request(transaction)
            .input('tenantId', sql.Int, tenantId)
            .input('itemId', sql.Int, Number(itemId))
            .input('warehouseId', sql.Int, Number(warehouseId))
            .input('bin', sql.VarChar(50), finalBin)
            .input('type', sql.VarChar(30), movementType)
            .input('delta', sql.Int, delta)
            .input('before', sql.Int, qtyBefore)
            .input('after', sql.Int, qtyAfter)
            .input('ref', sql.VarChar(80), refNumber)
            .input('notes', sql.NVarChar(300), notes || '')
            .input('user', sql.NVarChar(120), req.user.fullName)
            .query(`
                INSERT INTO ErpStockMovements (TenantID, ItemID, WarehouseID, BinLocation, MovementType, QuantityChange, QuantityBefore, QuantityAfter, ReferenceDoc, Notes, PerformedBy)
                VALUES (@tenantId, @itemId, @warehouseId, @bin, @type, @delta, @before, @after, @ref, @notes, @user)
            `);

        const itemCostRes = await new sql.Request(transaction)
            .input('itemId', sql.Int, Number(itemId))
            .query(`SELECT SKU, UnitCost FROM ErpCatalogItems WHERE ItemID = @itemId`);

        if (itemCostRes.recordset[0]) {
            const { SKU, UnitCost } = itemCostRes.recordset[0];
            const financialValue = Math.abs(delta) * Number(UnitCost || 0);
            if (financialValue > 0) {
                const isReceipt = delta > 0;
                await new sql.Request(transaction)
                    .input('tenantId', sql.Int, tenantId)
                    .input('jeNum', sql.VarChar(40), `JE-${Date.now().toString().slice(-6)}`)
                    .input('acctCode', sql.VarChar(30), isReceipt ? '1400-INV' : '5000-COGS')
                    .input('acctName', sql.NVarChar(120), isReceipt ? 'Finished Goods Inventory Asset' : 'Cost of Goods Sold (COGS)')
                    .input('entryType', sql.VarChar(20), 'DEBIT')
                    .input('amount', sql.Decimal(14, 2), financialValue)
                    .input('ref', sql.VarChar(80), refNumber)
                    .input('memo', sql.NVarChar(250), `${movementType} (${delta > 0 ? '+' : ''}${delta} units) of ${SKU}`)
                    .input('user', sql.NVarChar(120), req.user.fullName)
                    .query(`
                        INSERT INTO ErpFinanceLedger (TenantID, JournalNumber, AccountCode, AccountName, EntryType, Amount, ReferenceDoc, Memo, PostedBy)
                        VALUES (@tenantId, @jeNum, @acctCode, @acctName, @entryType, @amount, @ref, @memo, @user)
                    `);
            }
        }

        await transaction.commit();
        res.status(201).json({
            message: `Stock ${movementType} recorded! Balance updated: ${qtyBefore} -> ${qtyAfter}`,
            quantityBefore: qtyBefore,
            quantityAfter: qtyAfter
        });
    } catch (err) {
        await transaction.rollback();
        res.status(400).json({ error: err.message });
    }
});

// ============================================================================
// 5. FINANCE GL, SALES ORDERS & HR DIRECTORY ENDPOINTS
// ============================================================================
app.get('/api/erp/modules', authenticate, async (req, res) => {
    const tenantId = req.user.activeTenantId;
    try {
        const [finance, sales, hr] = await Promise.all([
            dbPool.request().input('tenantId', sql.Int, tenantId).query(`SELECT TOP 50 * FROM ErpFinanceLedger WHERE TenantID = @tenantId ORDER BY PostedAt DESC`),
            dbPool.request().input('tenantId', sql.Int, tenantId).query(`SELECT * FROM ErpSalesOrders WHERE TenantID = @tenantId ORDER BY CreatedAt DESC`),
            dbPool.request().input('tenantId', sql.Int, tenantId).query(`SELECT * FROM ErpEmployees WHERE TenantID = @tenantId ORDER BY EmpCode ASC`)
        ]);

        res.json({
            financeLedger: finance.recordset,
            salesOrders: sales.recordset,
            employees: hr.recordset
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/erp/sales-orders', authenticate, authorizeRoles('ADMIN', 'OPERATOR'), async (req, res) => {
    const tenantId = req.user.activeTenantId;
    const { customerName, orderTotal, warehouseCode, status } = req.body;
    if (!customerName || !orderTotal) {
        return res.status(400).json({ error: "Customer Name and Order Total are required." });
    }
    try {
        const orderNum = `SO-2026-${Math.floor(5000 + Math.random() * 4999)}`;
        await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .input('orderNum', sql.VarChar(40), orderNum)
            .input('customer', sql.NVarChar(150), customerName)
            .input('status', sql.VarChar(30), status || 'ALLOCATED')
            .input('total', sql.Decimal(14, 2), Number(orderTotal))
            .input('wh', sql.VarChar(30), warehouseCode || 'YYZ-DC01')
            .query(`
                INSERT INTO ErpSalesOrders (TenantID, OrderNumber, CustomerName, Status, OrderTotal, WarehouseCode)
                VALUES (@tenantId, @orderNum, @customer, @status, @total, @wh)
            `);
        res.status(201).json({ message: `Created Sales Order ${orderNum}` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/erp/employees', authenticate, authorizeRoles('ADMIN'), async (req, res) => {
    const tenantId = req.user.activeTenantId;
    const { fullName, jobTitle, department, location, annualSalary } = req.body;
    if (!fullName || !jobTitle) {
        return res.status(400).json({ error: "Full Name and Job Title are required." });
    }
    try {
        const empCode = `EMP-${Math.floor(2000 + Math.random() * 7999)}`;
        await dbPool.request()
            .input('tenantId', sql.Int, tenantId)
            .input('code', sql.VarChar(30), empCode)
            .input('name', sql.NVarChar(120), fullName)
            .input('title', sql.NVarChar(120), jobTitle)
            .input('dept', sql.NVarChar(80), department || 'Operations')
            .input('loc', sql.NVarChar(80), location || 'Toronto, ON')
            .input('sal', sql.Decimal(12, 2), Number(annualSalary || 95000))
            .query(`
                INSERT INTO ErpEmployees (TenantID, EmpCode, FullName, JobTitle, Department, Location, AnnualSalary, Status)
                VALUES (@tenantId, @code, @name, @title, @dept, @loc, @sal, 'ACTIVE')
            `);
        res.status(201).json({ message: `Onboarded Employee ${empCode}` });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

// Global JSON 404 & Error Handler (Guarantees Express NEVER returns <!DOCTYPE html>)
app.use((req, res) => {
    res.status(404).json({ error: `API Route Not Found on Backend: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
    console.error("Unhandled Express Error:", err);
    res.status(500).json({ error: err.message || "Internal Server Error" });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Nexus Global Enterprise ERP v3.0 active on port ${PORT}`);
});