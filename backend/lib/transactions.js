"use strict";
const crypto = require("node:crypto");
const { sql } = require("./db");
const { HttpError, integer, text, movementDelta } = require("./security");
function request(tx, tenantId) {
  return tx.request().input("tenant", sql.Int, tenantId);
}
async function transaction(pool, work) {
  const tx = new sql.Transaction(pool);
  await tx.begin(sql.ISOLATION_LEVEL.SERIALIZABLE);
  try {
    const result = await work(tx);
    await tx.commit();
    return result;
  } catch (e) {
    try {
      await tx.rollback();
    } catch {}
    throw e;
  }
}
async function audit(tx, req, action, entity, id, detail = {}) {
  await request(tx, req.tenantId)
    .input("actor", sql.Int, req.user.userId)
    .input("action", sql.VarChar(60), action)
    .input("entity", sql.VarChar(60), entity)
    .input("id", sql.VarChar(100), String(id))
    .input("detail", sql.NVarChar(sql.MAX), JSON.stringify(detail))
    .query(
      "INSERT INTO ErpAudit (TenantID,UserID,Action,Entity,EntityID,Detail) VALUES (@tenant,@actor,@action,@entity,@id,@detail)",
    );
}
async function idempotent(pool, req, work) {
  const key = text(req.get("X-Idempotency-Key"), "X-Idempotency-Key", 100);
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        user: req.user.userId,
        method: req.method,
        path: req.path,
        body: req.body,
      }),
    )
    .digest("hex");
  return transaction(pool, async (tx) => {
    const previous = await request(tx, req.tenantId)
      .input("key", sql.VarChar(100), key)
      .query(
        "SELECT PayloadHash, ResponseJson FROM ErpIdempotency WITH (UPDLOCK,HOLDLOCK) WHERE TenantID=@tenant AND RequestKey=@key",
      );
    if (previous.recordset[0]) {
      if (previous.recordset[0].PayloadHash !== hash)
        throw new HttpError(
          409,
          "Idempotency key was already used for another request",
        );
      return JSON.parse(previous.recordset[0].ResponseJson);
    }
    const result = await work(tx);
    await request(tx, req.tenantId)
      .input("key", sql.VarChar(100), key)
      .input("hash", sql.Char(64), hash)
      .input("result", sql.NVarChar(sql.MAX), JSON.stringify(result))
      .query(
        "INSERT INTO ErpIdempotency (TenantID,RequestKey,PayloadHash,ResponseJson) VALUES (@tenant,@key,@hash,@result)",
      );
    return result;
  });
}
async function journal(
  tx,
  req,
  { debit, credit, amount, referenceDoc = "", memo = "" },
) {
  if (debit === credit)
    throw new HttpError(400, "Debit and credit accounts must differ");
  const id = crypto.randomUUID();
  // Both sides use the exact same SQL DECIMAL amount in the same transaction.
  await request(tx, req.tenantId)
    .input("journal", sql.UniqueIdentifier, id)
    .input("debit", sql.VarChar(30), debit)
    .input("credit", sql.VarChar(30), credit)
    .input("amount", sql.VarChar(40), String(amount))
    .input("ref", sql.VarChar(80), referenceDoc)
    .input("memo", sql.NVarChar(250), memo)
    .input("actor", sql.NVarChar(120), req.user.fullName)
    .query(`INSERT INTO ErpFinanceLedger (TenantID,JournalNumber,AccountCode,EntryType,Amount,ReferenceDoc,Memo,PostedBy)
      VALUES (@tenant,@journal,@debit,'DEBIT',CONVERT(decimal(18,2),@amount),@ref,@memo,@actor),(@tenant,@journal,@credit,'CREDIT',CONVERT(decimal(18,2),@amount),@ref,@memo,@actor)`);
  return id;
}
async function move(tx, req, body, consumeReservation = false) {
  const itemId = integer(body.itemId, "itemId"),
    warehouseId = integer(body.warehouseId, "warehouseId");
  const bin = text(body.binLocation, "binLocation", 50).toUpperCase();
  const delta = movementDelta(body.movementType, body.quantity);
  const reference = text(
    body.referenceDoc || crypto.randomUUID(),
    "referenceDoc",
    80,
  );
  const notes = text(body.notes || "", "notes", 300, false);
  const item = await request(tx, req.tenantId)
    .input("item", sql.Int, itemId)
    .input("wh", sql.Int, warehouseId)
    .query(`SELECT i.ItemID, CONVERT(varchar(40),i.UnitCost) AS UnitCost FROM ErpCatalogItems i WITH(UPDLOCK,HOLDLOCK)
      WHERE i.TenantID=@tenant AND i.ItemID=@item AND i.IsActive=1
      AND EXISTS(SELECT 1 FROM ErpWarehouses WHERE TenantID=@tenant AND WarehouseID=@wh AND IsActive=1)`);
  if (!item.recordset[0])
    throw new HttpError(404, "Item or warehouse does not exist in this tenant");
  const balance = await request(tx, req.tenantId)
    .input("item", sql.Int, itemId)
    .input("wh", sql.Int, warehouseId)
    .input("bin", sql.VarChar(50), bin)
    .query(`SELECT BalanceID,QuantityOnHand,ReservedQuantity FROM ErpStockBalances WITH(UPDLOCK,HOLDLOCK)
      WHERE TenantID=@tenant AND ItemID=@item AND WarehouseID=@wh AND BinLocation=@bin`);
  const row = balance.recordset[0],
    before = row?.QuantityOnHand || 0,
    reserved = row?.ReservedQuantity || 0;
  const after = before + delta;
  if (
    after > 2147483647 ||
    after < 0 ||
    (!consumeReservation && after < reserved) ||
    (consumeReservation && reserved < -delta)
  )
    throw new HttpError(409, "Insufficient available stock");
  await request(tx, req.tenantId)
    .input("item", sql.Int, itemId)
    .input("wh", sql.Int, warehouseId)
    .input("bin", sql.VarChar(50), bin)
    .input("qty", sql.Int, after)
    .input(
      "reserved",
      sql.Int,
      consumeReservation ? reserved + delta : reserved,
    )
    .query(
      row
        ? `UPDATE ErpStockBalances SET QuantityOnHand=@qty,ReservedQuantity=@reserved,UpdatedAt=SYSUTCDATETIME()
      WHERE TenantID=@tenant AND ItemID=@item AND WarehouseID=@wh AND BinLocation=@bin`
        : "INSERT INTO ErpStockBalances (TenantID,ItemID,WarehouseID,BinLocation,QuantityOnHand,ReservedQuantity) VALUES (@tenant,@item,@wh,@bin,@qty,@reserved)",
    );
  const movement = await request(tx, req.tenantId)
    .input("item", sql.Int, itemId)
    .input("wh", sql.Int, warehouseId)
    .input("bin", sql.VarChar(50), bin)
    .input("type", sql.VarChar(30), body.movementType)
    .input("delta", sql.Int, delta)
    .input("before", sql.Int, before)
    .input("after", sql.Int, after)
    .input("ref", sql.VarChar(80), reference)
    .input("notes", sql.NVarChar(300), notes)
    .input("actor", sql.NVarChar(120), req.user.fullName)
    .input("user", sql.Int, req.user.userId)
    .query(`INSERT INTO ErpStockMovements (TenantID,ItemID,WarehouseID,BinLocation,MovementType,QuantityChange,QuantityBefore,QuantityAfter,ReferenceDoc,Notes,PerformedBy,UserID)
      OUTPUT INSERTED.MovementID VALUES (@tenant,@item,@wh,@bin,@type,@delta,@before,@after,@ref,@notes,@actor,@user)`);
  const cents =
    BigInt(item.recordset[0].UnitCost.replace(".", "")) *
    BigInt(Math.abs(delta));
  if (cents > 999999999999999999n)
    throw new HttpError(400, "Movement value exceeds ledger capacity");
  const amount = `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
  const adjustment = body.movementType === "ADJUSTMENT";
  const journalId = await journal(tx, req, {
    debit: delta > 0 ? "1400-INV" : adjustment ? "5100-ADJ" : "5000-COGS",
    credit: delta < 0 ? "1400-INV" : adjustment ? "5100-ADJ" : "2100-AP",
    amount,
    referenceDoc: reference,
    memo: `${body.movementType}: item ${itemId}, bin ${bin}`,
  });
  const id = movement.recordset[0].MovementID;
  await audit(tx, req, "STOCK_MOVEMENT", "movement", id, {
    itemId,
    warehouseId,
    bin,
    delta,
    before,
    after,
    journalId,
  });
  return {
    movementId: id,
    quantityBefore: before,
    quantityAfter: after,
    journalId,
  };
}
module.exports = { request, transaction, audit, idempotent, journal, move };
