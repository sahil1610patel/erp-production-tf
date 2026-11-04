-- Fresh ERP schema. Existing legacy installations need an explicit data migration;
-- the migration runner refuses to infer or overwrite an unversioned schema.
-- Composite foreign keys make cross-tenant item, warehouse, and customer references
-- impossible even if a future application route omits an ownership check.
CREATE TABLE dbo.ErpTenants (
    TenantID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpTenants PRIMARY KEY,
    TenantCode VARCHAR(30) NOT NULL CONSTRAINT UQ_ErpTenants_Code UNIQUE,
    CompanyName NVARCHAR(150) NOT NULL,
    BaseCurrency CHAR(3) NOT NULL CONSTRAINT DF_ErpTenants_Currency DEFAULT 'CAD',
    IsActive BIT NOT NULL CONSTRAINT DF_ErpTenants_Active DEFAULT 1,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpTenants_Created DEFAULT SYSUTCDATETIME()
);

CREATE TABLE dbo.ErpUsers (
    UserID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpUsers PRIMARY KEY,
    TenantID INT NOT NULL,
    Email VARCHAR(150) NOT NULL CONSTRAINT UQ_ErpUsers_Email UNIQUE,
    PasswordHash VARCHAR(512) NOT NULL,
    FullName NVARCHAR(120) NOT NULL,
    Role VARCHAR(20) NOT NULL,
    IsActive BIT NOT NULL CONSTRAINT DF_ErpUsers_Active DEFAULT 1,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpUsers_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ErpUsers_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT CK_ErpUsers_Role CHECK (Role IN ('ADMIN', 'OPERATOR', 'AUDITOR'))
);
CREATE INDEX IX_ErpUsers_Tenant ON dbo.ErpUsers(TenantID, IsActive);

CREATE TABLE dbo.ErpSessions (
    SessionID UNIQUEIDENTIFIER NOT NULL CONSTRAINT PK_ErpSessions PRIMARY KEY,
    UserID INT NOT NULL,
    ExpiresAt DATETIME2(3) NOT NULL,
    RevokedAt DATETIME2(3) NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpSessions_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ErpSessions_User FOREIGN KEY (UserID) REFERENCES dbo.ErpUsers(UserID)
);
CREATE INDEX IX_ErpSessions_User ON dbo.ErpSessions(UserID, ExpiresAt) INCLUDE (RevokedAt);
CREATE INDEX IX_ErpSessions_Expiry ON dbo.ErpSessions(ExpiresAt);

CREATE TABLE dbo.ErpWarehouses (
    WarehouseID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpWarehouses PRIMARY KEY,
    TenantID INT NOT NULL,
    WarehouseCode VARCHAR(30) NOT NULL,
    WarehouseName NVARCHAR(120) NOT NULL,
    City NVARCHAR(80) NOT NULL CONSTRAINT DF_ErpWarehouses_City DEFAULT '',
    Country NVARCHAR(80) NOT NULL CONSTRAINT DF_ErpWarehouses_Country DEFAULT '',
    IsActive BIT NOT NULL CONSTRAINT DF_ErpWarehouses_Active DEFAULT 1,
    CONSTRAINT FK_ErpWarehouses_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT UQ_ErpWarehouses_TenantID UNIQUE (TenantID, WarehouseID),
    CONSTRAINT UQ_ErpWarehouses_Code UNIQUE (TenantID, WarehouseCode)
);

CREATE TABLE dbo.ErpCatalogItems (
    ItemID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpCatalogItems PRIMARY KEY,
    TenantID INT NOT NULL,
    SKU VARCHAR(60) NOT NULL,
    ItemName NVARCHAR(200) NOT NULL,
    Category NVARCHAR(80) NOT NULL,
    Description NVARCHAR(500) NOT NULL CONSTRAINT DF_ErpCatalogItems_Description DEFAULT '',
    UnitOfMeasure VARCHAR(20) NOT NULL CONSTRAINT DF_ErpCatalogItems_Uom DEFAULT 'EA',
    UnitCost DECIMAL(18,2) NOT NULL CONSTRAINT DF_ErpCatalogItems_Cost DEFAULT 0,
    UnitPrice DECIMAL(18,2) NOT NULL CONSTRAINT DF_ErpCatalogItems_Price DEFAULT 0,
    ReorderPoint INT NOT NULL CONSTRAINT DF_ErpCatalogItems_ReorderPoint DEFAULT 20,
    ReorderQty INT NOT NULL CONSTRAINT DF_ErpCatalogItems_ReorderQty DEFAULT 50,
    IsActive BIT NOT NULL CONSTRAINT DF_ErpCatalogItems_Active DEFAULT 1,
    UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpCatalogItems_Updated DEFAULT SYSUTCDATETIME(),
    RowVersion ROWVERSION,
    CONSTRAINT FK_ErpCatalogItems_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT UQ_ErpCatalogItems_TenantID UNIQUE (TenantID, ItemID),
    CONSTRAINT UQ_ErpCatalogItems_SKU UNIQUE (TenantID, SKU),
    CONSTRAINT CK_ErpCatalogItems_Amounts CHECK (UnitCost >= 0 AND UnitPrice >= 0 AND ReorderPoint >= 0 AND ReorderQty >= 0)
);
CREATE INDEX IX_ErpCatalogItems_Search ON dbo.ErpCatalogItems(TenantID, IsActive, SKU) INCLUDE (ItemName, Category);

CREATE TABLE dbo.ErpStockBalances (
    BalanceID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpStockBalances PRIMARY KEY,
    TenantID INT NOT NULL,
    ItemID INT NOT NULL,
    WarehouseID INT NOT NULL,
    BinLocation VARCHAR(50) NOT NULL,
    QuantityOnHand INT NOT NULL CONSTRAINT DF_ErpStockBalances_Quantity DEFAULT 0,
    ReservedQuantity INT NOT NULL CONSTRAINT DF_ErpStockBalances_Reserved DEFAULT 0,
    UpdatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpStockBalances_Updated DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_ErpStockBalances_Bin UNIQUE (TenantID, ItemID, WarehouseID, BinLocation),
    CONSTRAINT FK_ErpStockBalances_Item FOREIGN KEY (TenantID, ItemID) REFERENCES dbo.ErpCatalogItems(TenantID, ItemID),
    CONSTRAINT FK_ErpStockBalances_Warehouse FOREIGN KEY (TenantID, WarehouseID) REFERENCES dbo.ErpWarehouses(TenantID, WarehouseID),
    CONSTRAINT CK_ErpStockBalances_Quantity CHECK (QuantityOnHand >= 0 AND ReservedQuantity >= 0 AND ReservedQuantity <= QuantityOnHand)
);
CREATE INDEX IX_ErpStockBalances_Warehouse ON dbo.ErpStockBalances(TenantID, WarehouseID, ItemID);

CREATE TABLE dbo.ErpStockMovements (
    MovementID BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpStockMovements PRIMARY KEY,
    TenantID INT NOT NULL,
    ItemID INT NOT NULL,
    WarehouseID INT NOT NULL,
    BinLocation VARCHAR(50) NOT NULL,
    MovementType VARCHAR(20) NOT NULL,
    QuantityChange INT NOT NULL,
    QuantityBefore INT NOT NULL,
    QuantityAfter INT NOT NULL,
    ReferenceDoc VARCHAR(80) NOT NULL,
    Notes NVARCHAR(300) NOT NULL CONSTRAINT DF_ErpStockMovements_Notes DEFAULT '',
    PerformedBy NVARCHAR(120) NOT NULL,
    UserID INT NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpStockMovements_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ErpStockMovements_Item FOREIGN KEY (TenantID, ItemID) REFERENCES dbo.ErpCatalogItems(TenantID, ItemID),
    CONSTRAINT FK_ErpStockMovements_Warehouse FOREIGN KEY (TenantID, WarehouseID) REFERENCES dbo.ErpWarehouses(TenantID, WarehouseID),
    CONSTRAINT FK_ErpStockMovements_User FOREIGN KEY (UserID) REFERENCES dbo.ErpUsers(UserID),
    CONSTRAINT CK_ErpStockMovements_Type CHECK (MovementType IN ('RECEIPT', 'SHIPMENT', 'ADJUSTMENT')),
    CONSTRAINT CK_ErpStockMovements_Quantities CHECK (
        QuantityBefore >= 0 AND QuantityAfter >= 0 AND QuantityChange <> 0
        AND CAST(QuantityBefore AS BIGINT) + QuantityChange = QuantityAfter
        AND (MovementType <> 'RECEIPT' OR QuantityChange > 0)
        AND (MovementType <> 'SHIPMENT' OR QuantityChange < 0)
    )
);
CREATE INDEX IX_ErpStockMovements_History ON dbo.ErpStockMovements(TenantID, CreatedAt DESC, MovementID DESC);

-- The application writes both legs of each journal inside the same transaction as
-- its originating workflow. Reversals are new journals; posted rows are immutable.
CREATE TABLE dbo.ErpFinanceLedger (
    LedgerID BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpFinanceLedger PRIMARY KEY,
    TenantID INT NOT NULL,
    JournalNumber UNIQUEIDENTIFIER NOT NULL,
    AccountCode VARCHAR(30) NOT NULL,
    EntryType VARCHAR(10) NOT NULL,
    Amount DECIMAL(18,2) NOT NULL,
    ReferenceDoc VARCHAR(80) NOT NULL,
    Memo NVARCHAR(250) NOT NULL CONSTRAINT DF_ErpFinanceLedger_Memo DEFAULT '',
    PostedBy NVARCHAR(120) NOT NULL,
    PostedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpFinanceLedger_Posted DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ErpFinanceLedger_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT CK_ErpFinanceLedger_Type CHECK (EntryType IN ('DEBIT', 'CREDIT')),
    CONSTRAINT CK_ErpFinanceLedger_Amount CHECK (Amount >= 0)
);
CREATE INDEX IX_ErpFinanceLedger_Journal ON dbo.ErpFinanceLedger(TenantID, JournalNumber) INCLUDE (EntryType, Amount);
CREATE INDEX IX_ErpFinanceLedger_Posted ON dbo.ErpFinanceLedger(TenantID, PostedAt DESC, LedgerID DESC);

CREATE TABLE dbo.ErpCustomers (
    CustomerID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpCustomers PRIMARY KEY,
    TenantID INT NOT NULL,
    CustomerCode VARCHAR(30) NOT NULL,
    CustomerName NVARCHAR(150) NOT NULL,
    Email VARCHAR(150) NOT NULL CONSTRAINT DF_ErpCustomers_Email DEFAULT '',
    IsActive BIT NOT NULL CONSTRAINT DF_ErpCustomers_Active DEFAULT 1,
    CONSTRAINT FK_ErpCustomers_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT UQ_ErpCustomers_TenantID UNIQUE (TenantID, CustomerID),
    CONSTRAINT UQ_ErpCustomers_Code UNIQUE (TenantID, CustomerCode)
);

CREATE TABLE dbo.ErpSalesOrders (
    OrderID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpSalesOrders PRIMARY KEY,
    TenantID INT NOT NULL,
    OrderNumber VARCHAR(50) NOT NULL,
    CustomerID INT NOT NULL,
    CustomerName NVARCHAR(150) NOT NULL,
    Status VARCHAR(20) NOT NULL CONSTRAINT DF_ErpSalesOrders_Status DEFAULT 'PENDING',
    OrderTotal DECIMAL(18,2) NOT NULL,
    WarehouseID INT NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpSalesOrders_Created DEFAULT SYSUTCDATETIME(),
    RowVersion ROWVERSION,
    CONSTRAINT FK_ErpSalesOrders_Customer FOREIGN KEY (TenantID, CustomerID) REFERENCES dbo.ErpCustomers(TenantID, CustomerID),
    CONSTRAINT FK_ErpSalesOrders_Warehouse FOREIGN KEY (TenantID, WarehouseID) REFERENCES dbo.ErpWarehouses(TenantID, WarehouseID),
    CONSTRAINT UQ_ErpSalesOrders_TenantID UNIQUE (TenantID, OrderID),
    CONSTRAINT UQ_ErpSalesOrders_Number UNIQUE (TenantID, OrderNumber),
    CONSTRAINT CK_ErpSalesOrders_Status CHECK (Status IN ('PENDING', 'ALLOCATED', 'SHIPPED', 'CANCELLED')),
    CONSTRAINT CK_ErpSalesOrders_Total CHECK (OrderTotal >= 0)
);
CREATE INDEX IX_ErpSalesOrders_Pipeline ON dbo.ErpSalesOrders(TenantID, Status, CreatedAt DESC);

CREATE TABLE dbo.ErpSalesOrderLines (
    LineID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpSalesOrderLines PRIMARY KEY,
    TenantID INT NOT NULL,
    OrderID INT NOT NULL,
    ItemID INT NOT NULL,
    BinLocation VARCHAR(50) NOT NULL,
    Quantity INT NOT NULL,
    UnitPrice DECIMAL(18,2) NOT NULL,
    CONSTRAINT FK_ErpSalesOrderLines_Order FOREIGN KEY (TenantID, OrderID) REFERENCES dbo.ErpSalesOrders(TenantID, OrderID),
    CONSTRAINT FK_ErpSalesOrderLines_Item FOREIGN KEY (TenantID, ItemID) REFERENCES dbo.ErpCatalogItems(TenantID, ItemID),
    CONSTRAINT UQ_ErpSalesOrderLines_ItemBin UNIQUE (TenantID, OrderID, ItemID, BinLocation),
    CONSTRAINT CK_ErpSalesOrderLines_Amounts CHECK (Quantity > 0 AND UnitPrice >= 0)
);

CREATE TABLE dbo.ErpEmployees (
    EmployeeID INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpEmployees PRIMARY KEY,
    TenantID INT NOT NULL,
    EmpCode VARCHAR(30) NOT NULL,
    FullName NVARCHAR(120) NOT NULL,
    JobTitle NVARCHAR(120) NOT NULL,
    Department NVARCHAR(80) NOT NULL,
    Location NVARCHAR(80) NOT NULL,
    AnnualSalary DECIMAL(18,2) NOT NULL,
    Status VARCHAR(20) NOT NULL CONSTRAINT DF_ErpEmployees_Status DEFAULT 'ACTIVE',
    RowVersion ROWVERSION,
    CONSTRAINT FK_ErpEmployees_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT UQ_ErpEmployees_Code UNIQUE (TenantID, EmpCode),
    CONSTRAINT CK_ErpEmployees_Status CHECK (Status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT CK_ErpEmployees_Salary CHECK (AnnualSalary >= 0)
);
CREATE INDEX IX_ErpEmployees_Directory ON dbo.ErpEmployees(TenantID, Status, FullName);

CREATE TABLE dbo.ErpAudit (
    AuditID BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ErpAudit PRIMARY KEY,
    TenantID INT NOT NULL,
    UserID INT NOT NULL,
    Action VARCHAR(60) NOT NULL,
    Entity VARCHAR(60) NOT NULL,
    EntityID VARCHAR(100) NOT NULL,
    Detail NVARCHAR(MAX) NOT NULL CONSTRAINT DF_ErpAudit_Detail DEFAULT '{}',
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpAudit_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_ErpAudit_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT FK_ErpAudit_User FOREIGN KEY (UserID) REFERENCES dbo.ErpUsers(UserID),
    CONSTRAINT CK_ErpAudit_Json CHECK (ISJSON(Detail) = 1)
);
CREATE INDEX IX_ErpAudit_Timeline ON dbo.ErpAudit(TenantID, CreatedAt DESC, AuditID DESC);

CREATE TABLE dbo.ErpIdempotency (
    TenantID INT NOT NULL,
    RequestKey VARCHAR(100) NOT NULL,
    PayloadHash CHAR(64) NOT NULL,
    ResponseJson NVARCHAR(MAX) NOT NULL,
    CreatedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpIdempotency_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT PK_ErpIdempotency PRIMARY KEY (TenantID, RequestKey),
    CONSTRAINT FK_ErpIdempotency_Tenant FOREIGN KEY (TenantID) REFERENCES dbo.ErpTenants(TenantID),
    CONSTRAINT CK_ErpIdempotency_Json CHECK (ISJSON(ResponseJson) = 1)
);
CREATE INDEX IX_ErpIdempotency_Created ON dbo.ErpIdempotency(CreatedAt);
