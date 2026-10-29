// The files Easy Ecom takes in, built from Hub orders. Column names and order follow Easy Ecom's
// own templates exactly (sample_order_import_format.csv, uploadOrderItemTemplate.csv, the
// "Add Wholesale Orders in Bulk" template and the "B2B Customers" sheet).
import { isBulkPack } from './match'

export interface EeLine {
  line_no: number; sku: string; qty: number; rate: number | null; value: number; mrp: number | null
  ean: string | null; gst_rate: number | null; hsn: string | null; tally_name: string | null; product_name: string | null
}
export interface EeCustomer { code: string; ee_customer_code: string | null; in_easy_ecom: boolean }
export interface EeOrder {
  id: string; order_no: string; order_date: string; channel: string; stage: string; salesperson_id: string | null
  customer_id: string | null; customer_name: string; contact_name: string | null; phone: string | null; email: string | null; gstin: string | null; fssai: string | null
  billing_address: string | null; billing_city: string | null; billing_state: string | null; billing_pin: string | null
  same_as_billing: boolean; delivery_name: string | null; delivery_address: string | null; delivery_city: string | null; delivery_state: string | null
  delivery_pin: string | null; delivery_gstin: string | null; delivery_phone: string | null
  po_number: string | null; po_date: string | null; payment_type: string | null; payment_terms: string | null; notes: string | null
  invoice_no: string | null; invoice_date: string | null; invoice_value: number | null; shared_with: string | null
  dispatch_date: string | null; courier: string | null; tracking_no: string | null; ee_uploaded_at: string | null; estimate_value: number
  shipping_charge: number
  order_lines: EeLine[]
  customer: EeCustomer | null
}

/** One cell → CSV text, quoted only when needed, like Easy Ecom's own files. New lines become ", ". */
const cell = (v: unknown) => {
  const t = String(v ?? '').replace(/\r?\n/g, ', ')
  return /[",]|^\s|\s$/.test(t) ? `"${t.replace(/"/g, '""')}"` : t
}
export const toCsv = (rows: unknown[][]) => rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'

/** The address the parcel went to. */
export function shipTo(o: EeOrder) {
  return o.same_as_billing || !o.delivery_address
    ? { name: o.customer_name, address: o.billing_address, city: o.billing_city, state: o.billing_state, pin: o.billing_pin, phone: o.phone }
    : { name: o.delivery_name || o.customer_name, address: o.delivery_address, city: o.delivery_city, state: o.delivery_state, pin: o.delivery_pin, phone: o.delivery_phone || o.phone }
}

/** September's B2B orders went into Easy Ecom as "B2B/<Tally invoice no.>". */
export const referenceFor = (o: EeOrder) => (o.invoice_no ? `B2B/${o.invoice_no}` : o.order_no)

const price = (n: number | null | undefined) => (n == null ? '' : Number(n).toFixed(2))

// ---------- What would make Easy Ecom reject an order ----------
export function problems(o: EeOrder, eeSkus: Set<string>): string[] {
  const p: string[] = []
  const bad = o.order_lines.filter((l) => !eeSkus.has(l.sku)).map((l) => l.sku)
  if (bad.length) p.push(`Not in Easy Ecom: ${bad.join(', ')}`)
  if (!o.invoice_no) p.push('No invoice')
  if (!shipTo(o).pin) p.push('No PIN')
  if (!o.customer?.ee_customer_code) p.push('No Easy Ecom customer code')
  return p
}

// ---------- 1. Wholesale bulk (+ → Add Wholesale Orders in Bulk) ----------
// Exactly Easy Ecom's bulkOrdersTemplate.csv. Like its sample, dates and barcodes start with ` so Excel
// doesn't change them. Payment is only Prepaid or COD here: credit, cheque and FOC orders go as Prepaid.
// EAN stays empty: Easy Ecom refuses a row that has both a SKU and an EAN ("provide only one").
export const WHOLESALE_HEAD = ['CustomerCode*', 'ReferenceNum*', 'OrderItemId', 'Sku*', 'Quantity*', 'Price', 'OrderDate*', 'PaymentMode', 'EAN', 'MRP']

export function wholesaleRows(orders: EeOrder[]): unknown[][] {
  const rows: unknown[][] = [WHOLESALE_HEAD]
  for (const o of orders) for (const l of o.order_lines) {
    rows.push([o.customer?.ee_customer_code ?? '', referenceFor(o), `${o.order_no}-${l.line_no}`, l.sku, l.qty, price(l.rate),
      `\`${o.invoice_date ?? o.order_date}`, o.payment_type === 'COD' ? 'COD' : 'Prepaid', '', isBulkPack(l.product_name) ? '' : price(l.mrp)])
  }
  return rows
}

// ---------- 2. Offline order import (Orders → Importing Wizard → EasyEcom format) ----------
export const OFFLINE_HEAD = ['Channel Name*', 'Sale Order Item Code*', 'Display Order Code*', 'Total Price*', 'Shipping Charges', 'Gift Wrap Charges', 'Total Discount',
  'Packet Number*', 'Date("YYYY-MM-DD")*', 'Item SKU Code*', 'Market Shipped*', 'Shipping provider', 'Shipping Address Name', 'Shipping Address Phone', 'Email',
  'Shipping Address Line 1', 'Shipping Address Line 2', 'Shipping Address City', 'Shipping Address State', 'Shipping Address Country', 'Shipping Address Pincode*',
  'Shipping Country Code', 'Billing Address Name', 'Billing Address Line 1', 'Billing Address Line 2', 'Billing Address City', 'Billing Address State',
  'Billing Address Country', 'Billing Address Pincode', 'Billing Address Phone', 'Invoice Code', 'Tracking Number', 'Payment Type*', 'Shipping Method',
  'Buyer GST Number', 'Use Default Currency(Yes/No)', 'Collectable Amount']

/** This import only knows COD, Prepaid and FOC. Credit and cheque orders are already paid for or billed, so Prepaid. */
const offlinePayment = (t: string | null) => (t === 'COD' ? 'COD' : t === 'FOC' ? 'FOC' : 'Prepaid')

/** The import has no quantity column: each row is one unit, so 10 packs = 10 rows with their own item code. */
export function offlineRows(orders: EeOrder[]): unknown[][] {
  const rows: unknown[][] = [OFFLINE_HEAD]
  for (const o of orders) {
    const s = shipTo(o)
    const pay = offlinePayment(o.payment_type)
    for (const l of o.order_lines) for (let u = 1; u <= l.qty; u++) {
      const ship = l === o.order_lines[0] && u === 1 && Number(o.shipping_charge) > 0 ? price(o.shipping_charge) : '' // once per order
      rows.push(['Offline', `\`${o.order_no}-${l.line_no}-${u}`, o.order_no, price(l.rate ?? 0), ship, '', '', 1, o.order_date, l.sku, 'N', o.courier ?? '',
        s.name, s.phone ?? '', o.email ?? '', s.address ?? '', '', s.city ?? '', s.state ?? '', 'India', s.pin ?? '', '',
        o.customer_name, o.billing_address ?? '', '', o.billing_city ?? '', o.billing_state ?? '', 'India', o.billing_pin ?? '', o.phone ?? '',
        o.invoice_no ?? '', o.tracking_no ?? '', pay, '', o.gstin ?? '', 'Yes', pay === 'COD' ? price(l.rate ?? 0) : ''])
    }
  }
  return rows
}

// ---------- 3. One item file per order (B2B order screen → upload items) ----------
export const ITEM_HEAD = ['Sku', 'Quantity', 'Price', 'EAN']
export const itemRows = (o: EeOrder): unknown[][] => [ITEM_HEAD, ...o.order_lines.map((l) => [l.sku, l.qty, price(l.rate), ''])] // SKU only, as above

// ---------- 4. New customers (Easy Ecom "B2B Customers" layout) ----------
export const CUSTOMER_HEAD = ['Company Name', 'Email', 'Password', 'Tax Identification Number/ GST', 'Ship To GSTIN', 'Contact Number', 'Country', 'Billing_Name',
  'Billing_State', 'Billing_Street', 'Billing_City', 'Billing_Postal Code', 'Currency', 'Description', 'Dispatch_Name', 'Dispatch_State', 'Dispatch_Street',
  'Dispatch_City', 'Dispatch_Postal Code', 'Invoice_Group_Id', 'Shelf_Life', 'TCS Rate(Only for Indian Clients)', 'ERP CUSTOMER ID', 'Dl Number', 'Dl Expiry',
  'Fssai Number', 'Fssai Expiry', 'Route Code', 'B2B Order Validity (days)', 'Send Email Upon Invoice Generation', 'Cancel if partially fulfilled (Yes/No)']

/** Customers on these orders that Easy Ecom doesn't know yet (one row each). */
export function newCustomerRows(orders: EeOrder[]): unknown[][] {
  const rows: unknown[][] = [CUSTOMER_HEAD]
  const seen = new Set<string>()
  for (const o of orders) {
    if (!o.customer || o.customer.in_easy_ecom || o.customer.ee_customer_code || seen.has(o.customer_id!)) continue
    seen.add(o.customer_id!)
    const s = shipTo(o)
    // The team's existing sheet uses dummy@gmail.com / 1234 when there is no email (Easy Ecom wants both).
    rows.push([o.customer_name, o.email || 'dummy@gmail.com', 1234, o.gstin ?? '', o.delivery_gstin ?? '', o.phone ?? '', 'India', o.customer_name,
      o.billing_state ?? '', o.billing_address ?? '', o.billing_city ?? '', o.billing_pin ?? '', 'Indian Rupee', '', s.name, s.state ?? '', s.address ?? '',
      s.city ?? '', s.pin ?? '', '', '', '', o.customer.code, '', '', o.fssai ?? '', '', '', '', '', ''])
  }
  return rows
}

// ---------- 5. Master list (one row per product line) ----------
export function masterRows(orders: EeOrder[], people: Map<string, string>): Record<string, unknown>[] {
  return orders.flatMap((o) => {
    const s = shipTo(o)
    return o.order_lines.map((l) => ({
      'Order no.': o.order_no, 'Order date': o.order_date, 'Channel': o.channel, 'Salesperson': people.get(o.salesperson_id ?? '') ?? '', 'Stage': o.stage,
      'Customer': o.customer_name, 'Customer code': o.customer?.code ?? '', 'Easy Ecom code': o.customer?.ee_customer_code ?? '', 'GSTIN': o.gstin ?? '',
      'Billing address': [o.billing_address, o.billing_city, o.billing_state, o.billing_pin].filter(Boolean).join(', '),
      'Delivery address': [s.name, s.address, s.city, s.state, s.pin].filter(Boolean).join(', '),
      'PO no.': o.po_number ?? '', 'PO date': o.po_date ?? '', 'Payment': o.payment_type ?? '', 'Terms': o.payment_terms ?? '',
      'SKU': l.sku, 'Product': l.product_name ?? '', 'Tally item': l.tally_name ?? '', 'HSN': l.hsn ?? '', 'Qty': l.qty, 'Rate (incl. GST)': l.rate ?? '',
      'GST %': l.gst_rate ?? '', 'Line value': Number(l.value), 'MRP': isBulkPack(l.product_name) ? '' : l.mrp ?? '',
      'Shipping (order)': l === o.order_lines[0] ? Number(o.shipping_charge) || '' : '',
      'Invoice no.': o.invoice_no ?? '', 'Invoice date': o.invoice_date ?? '', 'Invoice value': o.invoice_value ?? '',
      'Dispatch date': o.dispatch_date ?? '', 'Courier': o.courier ?? '', 'Tracking': o.tracking_no ?? '', 'In Easy Ecom': o.ee_uploaded_at ? 'Yes' : 'No',
    }))
  })
}
