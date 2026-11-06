import assert from "node:assert/strict";
import { normalizeOrders, normalizeSalesOrder } from "../src/orders.js";
import { encrypt, decrypt, encryptionConfigured } from "../src/crypto.js";

// Shapes follow DigiKey's Order Status V4 spec (SearchOrders / RetrieveSalesOrder).
const address = {
  FirstName: "Sam", LastName: "Tester", CompanyName: "", AddressLine1: "1 Secret Street", AddressLine2: "Apt 9",
  City: "Austin", State: "TX", ZipCode: "78701", IsoCode: "US", Phone: "555-0100",
};
const contact = { FirstName: "Sam", LastName: "Tester", Email: "sam@example.com" };
const sales = (id, total, extra = {}) => ({
  SalesOrderId: id, CustomerId: 1, Contact: contact, Status: { SalesOrderStatus: "Shipped", ShortDescription: "Shipped", LongDescription: "x" },
  PurchaseOrder: "BOM-1", TotalPrice: total, DateEntered: "2026-10-20T15:04:05Z", OrderNumber: 900001,
  ShipMethod: "UPS Ground", Currency: "USD", ShippingAddress: address, LineItems: [], ...extra,
});

export const ORDERS = {
  TotalOrders: 27,
  Orders: [
    { OrderNumber: 900001, CustomerId: 1, DateEntered: "2026-10-20T15:04:05Z", Currency: "USD", PONumber: "BOM-1",
      EntireOrderStatus: { OrderStatus: "Shipped", ShortDescription: "Shipped", LongDescription: "Your order has shipped" },
      SalesOrders: [sales(700001, 12.34)] },
    { OrderNumber: 900002, CustomerId: 1, DateEntered: "2026-10-25T09:00:00Z", Currency: "USD", PONumber: "",
      EntireOrderStatus: { OrderStatus: "Processing", ShortDescription: "Processing" },
      SalesOrders: [sales(700002, 5.5, { OrderNumber: 900002 }), sales(700003, 3.25, { OrderNumber: 900002 })] },
  ],
};

export const SALES = sales(700001, 12.34, {
  LineItems: [{
    SalesOrderId: 700001, DetailId: 1, TotalPrice: 1.0, PurchaseOrder: "BOM-1", CustomerReference: "R1",
    DigiKeyProductNumber: "311-10.0KCRCT-ND", ManufacturerProductNumber: "RC0603FR-0710KL",
    Description: "RES 10K OHM 1% 1/10W 0603", PackType: "CutTape",
    QuantityOrdered: 10, QuantityShipped: 8, QuantityBackOrder: 2, UnitPrice: 0.1,
    ItemShipments: [{ QuantityShipped: 8, InvoiceId: 5, ShippedDate: "2026-10-22T00:00:00Z", TrackingNumber: "1Z999AA10123456784", ExpectedDeliveryDate: "2026-10-26" }],
  }],
});

// ---- search results ----
const n = normalizeOrders(ORDERS);
assert.equal(n.total, 27);
assert.equal(n.orders.length, 2);
assert.equal(n.orders[0].orderNumber, 900001);
assert.equal(n.orders[0].status, "Shipped");
assert.equal(n.orders[0].total, 12.34);
assert.equal(n.orders[0].po, "BOM-1");
assert.equal(n.orders[1].status, "Processing");
assert.equal(n.orders[1].total, 8.75, "order total is the sum of its sales orders");
assert.equal(n.orders[1].salesOrders.length, 2);
assert.equal(n.orders[0].salesOrders[0].id, 700001);
assert.equal(n.orders[0].salesOrders[0].shipMethod, "UPS Ground");
assert.equal(n.orders[0].salesOrders[0].shipTo, "Sam Tester, Austin, TX, US");

// contact details and street addresses never leave the Worker
const dump = JSON.stringify(n);
for (const secret of ["Secret Street", "Apt 9", "555-0100", "sam@example.com", "78701"]) {
  assert.ok(!dump.includes(secret), `${secret} must not be in the normalized output`);
}

// ---- one sales order, with line items ----
const so = normalizeSalesOrder(SALES);
assert.equal(so.items.length, 1);
const it = so.items[0];
assert.deepEqual([it.dkpn, it.mpn, it.packType], ["311-10.0KCRCT-ND", "RC0603FR-0710KL", "CutTape"]);
assert.deepEqual([it.ordered, it.shipped, it.backOrder, it.unitPrice], [10, 8, 2, 0.1]);
assert.deepEqual(it.shipments, [{ quantity: 8, date: "2026-10-22T00:00:00Z", tracking: "1Z999AA10123456784", expected: "2026-10-26" }]);
assert.deepEqual(normalizeSalesOrder({ SalesOrder: SALES }), so, "wrapped responses are accepted");

// ---- junk in, empty out ----
assert.deepEqual(normalizeOrders({}), { total: 0, orders: [] });
assert.deepEqual(normalizeOrders(null), { total: 0, orders: [] });
assert.equal(normalizeOrders({ Orders: [{}] }).orders[0].total, null);
assert.deepEqual(normalizeSalesOrder(undefined).items, []);

// ---- token encryption ----
const env = { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
assert.equal(encryptionConfigured(env), true);
assert.equal(encryptionConfigured({}), false);
assert.equal(encryptionConfigured({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(5).toString("base64") }), false, "wrong length");
assert.equal(encryptionConfigured({ TOKEN_ENCRYPTION_KEY: "!!!not base64" }), false);

const blob = await encrypt(env, "secret-token", "u1:access");
assert.ok(!blob.includes("secret-token"));
assert.equal(await decrypt(env, blob, "u1:access"), "secret-token");
assert.notEqual(await encrypt(env, "secret-token", "u1:access"), blob, "a fresh random IV every time");
await assert.rejects(decrypt(env, blob, "u2:access"), "bound to its owner");
await assert.rejects(decrypt(env, blob, "u1:refresh"), "bound to its purpose");
await assert.rejects(decrypt({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64") }, blob, "u1:access"), "wrong key");

console.log("orders tests passed");
