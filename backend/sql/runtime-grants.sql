/*
  Run once after migrations as the deployment database administrator, connected to
  ERP_DB (or your configured DB_NAME). Provision erp_app_login through your secure
  credential-management process first. This script deliberately contains no
  CREATE LOGIN password literal, sqlcmd password variable, or secret output.

  Edit only @RuntimeLogin / @RuntimeUser below if your managed names differ.
  No database-wide db_datareader/db_datawriter or schema-wide DML grants are used.
*/
SET NOCOUNT ON;
SET XACT_ABORT ON;

DECLARE @RuntimeLogin SYSNAME = N'erp_app_login';
DECLARE @RuntimeUser SYSNAME = N'erp_app';
DECLARE @Role SYSNAME = N'erp_runtime';
DECLARE @Sql NVARCHAR(MAX);

IF DB_NAME() IN (N'master', N'model', N'msdb', N'tempdb')
    THROW 51010, 'Connect to the ERP application database before granting access.', 1;
IF OBJECT_ID(N'dbo.ErpSchemaMigrations', N'U') IS NULL
    THROW 51011, 'Apply the versioned ERP migrations first.', 1;
IF SUSER_ID(@RuntimeLogin) IS NULL
    THROW 51012, 'Provision the dedicated SQL login securely before running this script.', 1;
IF IS_SRVROLEMEMBER(N'sysadmin', @RuntimeLogin) = 1
    THROW 51013, 'The runtime SQL login must not be a sysadmin.', 1;

BEGIN TRY
    BEGIN TRANSACTION;
    IF DATABASE_PRINCIPAL_ID(@Role) IS NULL
    BEGIN
        SET @Sql = N'CREATE ROLE ' + QUOTENAME(@Role) + N' AUTHORIZATION dbo;';
        EXEC sys.sp_executesql @Sql;
    END;
    IF DATABASE_PRINCIPAL_ID(@RuntimeUser) IS NULL
    BEGIN
        SET @Sql = N'CREATE USER ' + QUOTENAME(@RuntimeUser) + N' FOR LOGIN ' + QUOTENAME(@RuntimeLogin) + N';';
        EXEC sys.sp_executesql @Sql;
    END;
    IF EXISTS (SELECT 1 FROM sys.database_principals WHERE name = @RuntimeUser AND sid <> SUSER_SID(@RuntimeLogin))
        THROW 51014, 'An existing runtime database user maps to a different login.', 1;
    IF IS_ROLEMEMBER(N'db_owner', @RuntimeUser) = 1
       OR IS_ROLEMEMBER(N'db_datawriter', @RuntimeUser) = 1
       OR IS_ROLEMEMBER(N'db_ddladmin', @RuntimeUser) = 1
       OR IS_ROLEMEMBER(N'db_securityadmin', @RuntimeUser) = 1
       OR IS_ROLEMEMBER(N'db_accessadmin', @RuntimeUser) = 1
        THROW 51015, 'Remove broad database role membership from the dedicated runtime user first.', 1;

    IF IS_ROLEMEMBER(@Role, @RuntimeUser) <> 1
    BEGIN
        SET @Sql = N'ALTER ROLE ' + QUOTENAME(@Role) + N' ADD MEMBER ' + QUOTENAME(@RuntimeUser) + N';';
        EXEC sys.sp_executesql @Sql;
    END;

    GRANT CONNECT TO erp_runtime;

    -- Mutable business records are archived through IsActive/Status; SQL DELETE
    -- is deliberately absent so associated financial history remains intact.
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpTenants TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpUsers TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpSessions TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpWarehouses TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpCatalogItems TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpStockBalances TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpCustomers TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpSalesOrders TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpSalesOrderLines TO erp_runtime;
    GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.ErpEmployees TO erp_runtime;

    -- Journals, movements and audit events are append-only for runtime identity.
    GRANT SELECT, INSERT ON OBJECT::dbo.ErpStockMovements TO erp_runtime;
    GRANT SELECT, INSERT ON OBJECT::dbo.ErpFinanceLedger TO erp_runtime;
    GRANT SELECT, INSERT ON OBJECT::dbo.ErpAudit TO erp_runtime;
    GRANT SELECT, INSERT ON OBJECT::dbo.ErpIdempotency TO erp_runtime;
    GRANT SELECT ON OBJECT::dbo.ErpSchemaMigrations TO erp_runtime;

    DENY UPDATE, DELETE ON OBJECT::dbo.ErpStockMovements TO erp_runtime;
    DENY UPDATE, DELETE ON OBJECT::dbo.ErpFinanceLedger TO erp_runtime;
    DENY UPDATE, DELETE ON OBJECT::dbo.ErpAudit TO erp_runtime;
    DENY UPDATE, DELETE ON OBJECT::dbo.ErpIdempotency TO erp_runtime;
    DENY INSERT, UPDATE, DELETE ON OBJECT::dbo.ErpSchemaMigrations TO erp_runtime;
    DENY DELETE ON SCHEMA::dbo TO erp_runtime;
    DENY ALTER ON SCHEMA::dbo TO erp_runtime;
    DENY CREATE TABLE, CREATE VIEW, CREATE PROCEDURE, CREATE FUNCTION TO erp_runtime;
    COMMIT TRANSACTION;
END TRY
BEGIN CATCH
    IF XACT_STATE() <> 0 ROLLBACK TRANSACTION;
    THROW;
END CATCH;
