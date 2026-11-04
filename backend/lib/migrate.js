"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const sql = require("mssql");

/**
 * Apply immutable, numbered SQL migrations. A database-scoped application lock
 * serializes EC2 instances starting simultaneously during an ASG refresh. DDL and
 * the version row commit together; failures never leave a partially applied file.
 * Run this with a migration principal; the normal runtime principal needs only
 * application DML permissions when automatic migration is disabled.
 */
async function migrate(pool) {
  const directory = path.join(__dirname, "..", "migrations");
  const files = (await fs.readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  const transaction = new sql.Transaction(pool);
  let began = false;
  let rolledBack = false;
  transaction.on("rollback", () => {
    rolledBack = true;
  });
  try {
    await transaction.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
    began = true;
    const lock = await new sql.Request(transaction).query(`
      SET XACT_ABORT ON;
      DECLARE @result INT;
      EXEC @result = sys.sp_getapplock
        @Resource = N'enterprise-erp-schema-migration', @LockMode = 'Exclusive',
        @LockOwner = 'Transaction', @LockTimeout = 60000;
      SELECT @result AS LockResult;
    `);
    if (lock.recordset[0].LockResult < 0)
      throw new Error("Could not acquire ERP schema migration lock");
    await new sql.Request(transaction).query(`
      IF OBJECT_ID(N'dbo.ErpSchemaMigrations', N'U') IS NULL
      BEGIN
        IF OBJECT_ID(N'dbo.ErpTenants', N'U') IS NOT NULL
          THROW 51000, 'Legacy unversioned ERP schema detected; use a new database or a reviewed data migration.', 1;
        CREATE TABLE dbo.ErpSchemaMigrations (
          Version VARCHAR(100) NOT NULL CONSTRAINT PK_ErpSchemaMigrations PRIMARY KEY,
          Checksum CHAR(64) NOT NULL,
          AppliedAt DATETIME2(3) NOT NULL CONSTRAINT DF_ErpSchemaMigrations_Applied DEFAULT SYSUTCDATETIME()
        );
      END;
    `);
    const applied = await new sql.Request(transaction).query(
      "SELECT Version, Checksum FROM dbo.ErpSchemaMigrations",
    );
    const versions = new Map(
      applied.recordset.map((row) => [row.Version, row.Checksum]),
    );
    for (const version of versions.keys()) {
      if (!files.includes(version))
        throw new Error(
          `Applied migration is missing from this release: ${version}`,
        );
    }
    for (const file of files) {
      const source = await fs.readFile(path.join(directory, file), "utf8");
      const checksum = crypto.createHash("sha256").update(source).digest("hex");
      if (versions.has(file)) {
        if (versions.get(file) !== checksum)
          throw new Error(`Applied migration checksum changed: ${file}`);
        continue;
      }
      // Migration files contain ordinary T-SQL batches, not sqlcmd GO directives.
      await new sql.Request(transaction).batch(source);
      await new sql.Request(transaction)
        .input("version", sql.VarChar(100), file)
        .input("checksum", sql.Char(64), checksum)
        .query(
          "INSERT INTO dbo.ErpSchemaMigrations (Version, Checksum) VALUES (@version, @checksum)",
        );
    }
    await transaction.commit();
  } catch (error) {
    if (began && !rolledBack) {
      try {
        await transaction.rollback();
      } catch {
        /* Preserve the original error. */
      }
    }
    throw error;
  }
}

module.exports = { migrate };
