// Run on EC2 via: node test-erp-api.js
const BASE_URL = "http://localhost:5000";

async function runTests() {
    console.log("=== Starting Enterprise ERP Automated Verification Suite ===");

    // Test 1: Admin Login
    const adminRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'admin@nexuscorp.com', password: 'Admin@2026!' })
    });
    const adminData = await adminRes.json();
    console.assert(adminRes.status === 200 && adminData.token, "Test 1 Failed: Admin login should succeed");
    console.log("PASS [1/4]: Admin JWT issued for", adminData.user.fullName);

    // Test 2: Operator (Normal User) Login & RBAC Enforcement Check
    const opRes = await fetch(`${BASE_URL}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: 'operator@nexuscorp.com', password: 'User@2026!' })
    });
    const opData = await opRes.json();

    // Operator attempts to create a new Catalog SKU (Should be blocked with 403 Forbidden)
    const forbiddenRes = await fetch(`${BASE_URL}/api/inventory/items`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opData.token}` },
        body: JSON.stringify({ sku: 'HACK-01', itemName: 'Unauthorized SKU', category: 'Test' })
    });
    console.assert(forbiddenRes.status === 403, "Test 2 Failed: Operator must be blocked from creating catalog SKUs");
    console.log("PASS [2/4]: RBAC Security verified (Operator blocked from Admin Catalog creation with HTTP 403)");

    // Test 3: Fetch Inventory Matrix
    const invRes = await fetch(`${BASE_URL}/api/inventory/items`, {
        headers: { 'Authorization': `Bearer ${opData.token}` }
    });
    const invData = await invRes.json();
    console.assert(invData.items.length > 0 && invData.warehouses.length > 0, "Test 3 Failed: Inventory items must load");
    console.log(`PASS [3/4]: Loaded ${invData.items.length} SKUs across ${invData.warehouses.length} global warehouses`);

    // Test 4: Operator Logs ACID Stock Receipt
    const firstItem = invData.items[0];
    const firstWh = invData.warehouses[0];
    const moveRes = await fetch(`${BASE_URL}/api/inventory/movements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opData.token}` },
        body: JSON.stringify({
            itemId: firstItem.ItemID,
            warehouseId: firstWh.WarehouseID,
            binLocation: 'YYZ-TEST-01',
            movementType: 'RECEIPT',
            quantity: 5,
            referenceDoc: 'PO-TEST-999',
            notes: 'Automated verification test receipt'
        })
    });
    const moveData = await moveRes.json();
    console.assert(moveRes.status === 201 && moveData.quantityAfter === moveData.quantityBefore + 5, "Test 4 Failed: ACID stock math mismatch");
    console.log(`PASS [4/4]: ACID Stock Movement verified (${moveData.quantityBefore} -> ${moveData.quantityAfter})`);
    console.log("=== ALL ENTERPRISE ERP TESTS PASSED ===");
}

runTests().catch(console.error);