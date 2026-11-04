"use strict";
const sql = require("mssql");
const fs = require("node:fs");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { migrate } = require("./migrate");
const { hashPassword } = require("./security");
async function loadConfig(env = process.env) {
  const client = new SecretsManagerClient({
    region: env.AWS_REGION || "ca-central-1",
  });
  const secret = async (id) =>
    JSON.parse(
      (await client.send(new GetSecretValueCommand({ SecretId: id })))
        .SecretString,
    );
  const db =
    env.NODE_ENV !== "production" && env.DB_CONFIG_JSON
      ? JSON.parse(env.DB_CONFIG_JSON)
      : await secret(env.SECRET_ID);
  const app = env.APP_SECRET_ID
    ? await secret(env.APP_SECRET_ID)
    : { jwtSecret: env.JWT_SECRET, bootstrapPassword: env.BOOTSTRAP_PASSWORD };
  if (
    typeof app.jwtSecret !== "string" ||
    Buffer.byteLength(app.jwtSecret) < 32
  )
    throw new Error("A JWT secret of at least 32 bytes is required");
  if (env.NODE_ENV === "production" && env.ENABLE_DEMO_SEED === "true")
    throw new Error("Demo seeding is forbidden in production");
  const runtime = env.DB_RUNTIME_SECRET_ID
    ? await secret(env.DB_RUNTIME_SECRET_ID)
    : null;
  return {
    jwtSecret: app.jwtSecret,
    bootstrapPassword: app.bootstrapPassword,
    runtimeCredentials: runtime,
    db: {
      server: env.DB_HOST || db.host,
      port: Number(env.DB_PORT || db.port || 1433),
      user: db.username,
      password: db.password,
      database: env.DB_NAME || "ERP_DB",
      connectionTimeout: 15000,
      requestTimeout: 30000,
      pool: { max: 20, min: 0, idleTimeoutMillis: 30000 },
      options: {
        encrypt: true,
        trustServerCertificate:
          env.NODE_ENV !== "production" && env.DB_TRUST_CERT === "true",
        enableArithAbort: true,
        abortTransactionOnError: true,
        ...(env.DB_CA_BUNDLE
          ? {
              cryptoCredentialsDetails: {
                ca: fs.readFileSync(env.DB_CA_BUNDLE, "utf8"),
              },
            }
          : {}),
      },
    },
  };
}
async function bootstrap(pool, config, env = process.env) {
  if (!env.BOOTSTRAP_ADMIN_EMAIL || !config.bootstrapPassword) return;
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    await new sql.Request(tx).query(
      "DECLARE @r int; EXEC @r=sp_getapplock @Resource='erp-bootstrap', @LockMode='Exclusive', @LockOwner='Transaction', @LockTimeout=30000; IF @r<0 THROW 51000,'Bootstrap lock unavailable',1;",
    );
    const count = await new sql.Request(tx).query(
      "SELECT COUNT(*) AS n FROM ErpUsers",
    );
    if (!count.recordset[0].n) {
      const r = new sql.Request(tx)
        .input(
          "email",
          sql.VarChar(150),
          env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(),
        )
        .input(
          "hash",
          sql.VarChar(200),
          hashPassword(config.bootstrapPassword),
        );
      await r.query(`INSERT INTO ErpTenants (TenantCode,CompanyName,BaseCurrency) VALUES ('NA','North America','CAD');
        DECLARE @t int=SCOPE_IDENTITY();
        INSERT INTO ErpUsers (TenantID,Email,PasswordHash,FullName,Role) VALUES (@t,@email,@hash,'Enterprise Administrator','ADMIN');
        INSERT INTO ErpWarehouses (TenantID,WarehouseCode,WarehouseName,City,Country) VALUES (@t,'YYZ-DC01','Toronto Distribution Centre','Toronto','Canada');`);
    }
    await tx.commit();
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    throw e;
  }
}
async function connect(config) {
  if (process.env.CREATE_DATABASE === "true") {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config.db.database))
      throw new Error("Invalid DB_NAME");
    const admin = await new sql.ConnectionPool({
      ...config.db,
      database: "master",
    }).connect();
    try {
      await admin
        .request()
        .query(
          `IF DB_ID(N'${config.db.database}') IS NULL CREATE DATABASE [${config.db.database}]`,
        );
    } finally {
      await admin.close();
    }
  }
  const pool = await new sql.ConnectionPool(config.db).connect();
  try {
    if (process.env.AUTO_MIGRATE !== "false") await migrate(pool);
    await bootstrap(pool, config);
    if (process.env.ENABLE_DEMO_SEED === "true")
      await require("./seed").seed(pool);
    if (config.runtimeCredentials) {
      await pool.close();
      return await new sql.ConnectionPool({
        ...config.db,
        user: config.runtimeCredentials.username,
        password: config.runtimeCredentials.password,
      }).connect();
    }
    return pool;
  } catch (e) {
    await pool.close();
    throw e;
  }
}
module.exports = { sql, loadConfig, connect, bootstrap };
