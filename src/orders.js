// Normalizes DigiKey Order Status V4 responses into the small shape the page uses.
// Deliberately drops contact emails, phone numbers and street addresses: the page
// doesn't need them, so they never leave the Worker.

const str = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);

/** Name and city/state/country only (no street, phone or email). */
function shipTo(a) {
  if (!a) return "";
  const who = str(a.CompanyName).trim() || [a.FirstName, a.LastName].map(str).filter(Boolean).join(" ");
  return [who, a.City, a.State, a.IsoCode].map((s) => str(s).trim()).filter(Boolean).join(", ");
}

export function normalizeLineItem(li) {
  return {
    dkpn: str(li.DigiKeyProductNumber),
    mpn: str(li.ManufacturerProductNumber),
    description: str(li.Description),
    packType: str(li.PackType),
    ordered: num(li.QuantityOrdered),
    shipped: num(li.QuantityShipped),
    backOrder: num(li.QuantityBackOrder),
    unitPrice: num(li.UnitPrice),
    reference: str(li.CustomerReference),
    shipments: list(li.ItemShipments).map((s) => ({
      quantity: num(s.QuantityShipped),
      date: str(s.ShippedDate),
      tracking: str(s.TrackingNumber),
      expected: str(s.ExpectedDeliveryDate),
    })),
  };
}

/** Accepts a SalesOrder object, or one wrapped as { SalesOrder: {...} }. */
export function normalizeSalesOrder(raw) {
  const so = raw?.SalesOrder ?? raw ?? {};
  return {
    id: num(so.SalesOrderId),
    orderNumber: num(so.OrderNumber),
    date: str(so.DateEntered),
    status: str(so.Status?.SalesOrderStatus),
    statusText: str(so.Status?.ShortDescription),
    po: str(so.PurchaseOrder),
    total: num(so.TotalPrice),
    currency: str(so.Currency),
    shipMethod: str(so.ShipMethod),
    shipTo: shipTo(so.ShippingAddress),
    items: list(so.LineItems).map(normalizeLineItem),
  };
}

/** SearchOrders response -> { total, orders }. */
export function normalizeOrders(raw) {
  const orders = list(raw?.Orders).map((o) => {
    const salesOrders = list(o.SalesOrders).map((s) => normalizeSalesOrder(s));
    const totals = salesOrders.map((s) => s.total).filter((t) => t !== null);
    return {
      orderNumber: num(o.OrderNumber),
      date: str(o.DateEntered),
      currency: str(o.Currency),
      po: str(o.PONumber),
      status: str(o.EntireOrderStatus?.OrderStatus),
      statusText: str(o.EntireOrderStatus?.ShortDescription),
      total: totals.length ? Math.round(totals.reduce((a, b) => a + b, 0) * 100) / 100 : null,
      salesOrders,
    };
  });
  return { total: num(raw?.TotalOrders) ?? orders.length, orders };
}
