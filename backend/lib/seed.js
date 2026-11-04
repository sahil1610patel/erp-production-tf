"use strict";
const { sql } = require("./db");
const { hashPassword } = require("./security");
/** Explicit development fixture. Never enables demo users in production. */
async function seed(pool) {
  if (process.env.NODE_ENV === "production")
    throw new Error("Demo seed forbidden in production");
  const password = process.env.DEMO_PASSWORD;
  const hash = hashPassword(password);
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await new sql.Request(tx).query(
      "DECLARE @r int; EXEC @r=sp_getapplock @Resource='erp-demo-seed',@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=30000; IF @r<0 THROW 51000,'Seed lock unavailable',1;",
    );
    const check = await new sql.Request(tx).query(
      "SELECT UserID FROM ErpUsers WHERE Email='admin@demo.erp'",
    );
    if (!check.recordset.length) {
      await new sql.Request(tx).input("hash", sql.VarChar(200), hash).query(`
        INSERT INTO ErpTenants(TenantCode,CompanyName,BaseCurrency) VALUES('DEMO-NA','Demo North America','CAD'),('DEMO-EMEA','Demo EMEA','EUR');
        DECLARE @t int=(SELECT TenantID FROM ErpTenants WHERE TenantCode='DEMO-NA');
        INSERT INTO ErpUsers(TenantID,Email,PasswordHash,FullName,Role) VALUES(@t,'admin@demo.erp',@hash,'Demo Administrator','ADMIN'),(@t,'operator@demo.erp',@hash,'Demo WMS Operator','OPERATOR'),(@t,'auditor@demo.erp',@hash,'Demo SOX Auditor','AUDITOR');
        INSERT INTO ErpWarehouses(TenantID,WarehouseCode,WarehouseName,City,Country) VALUES(@t,'YYZ-DEMO','Demo Toronto DC','Toronto','Canada');
        INSERT INTO ErpCustomers(TenantID,CustomerCode,CustomerName,Email) VALUES(@t,'DEMO-C001','Demo Retail Group','buyer@example.invalid');
        INSERT INTO ErpCatalogItems(TenantID,SKU,ItemName,Category,UnitCost,UnitPrice) VALUES(@t,'DEMO-001','Industrial Sensor','Electronics',45.50,79.99),(@t,'DEMO-002','Precision Bearing','Components',12.00,19.95);
        INSERT INTO ErpEmployees(TenantID,EmpCode,FullName,JobTitle,Department,Location,AnnualSalary) VALUES(@t,'DEMO-E001','Alex Morgan','Operations Manager','Logistics','Toronto',95000);
      `);
    }
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    throw e;
  }
}
module.exports = { seed };
