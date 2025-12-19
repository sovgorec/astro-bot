import crypto from "crypto";
import db from "../db/init";

const MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN || "";
const PASSWORD_1 = process.env.ROBOKASSA_PASSWORD_1 || "";
const PASSWORD_2 = process.env.ROBOKASSA_PASSWORD_2 || "";
const AMOUNT = 149;
const IS_TEST = process.env.ROBOKASSA_TEST === "true";
const BASE_URL = IS_TEST 
  ? "https://auth.robokassa.ru/Merchant/Index.aspx"
  : "https://auth.robokassa.ru/Merchant/Index.aspx";

export function generateInvoiceId(telegramId: number): string {
  const timestamp = Date.now();
  return `invoice_${telegramId}_${timestamp}`;
}

export function createPayment(telegramId: number): { invoiceId: string; paymentUrl: string } {
  const invoiceId = generateInvoiceId(telegramId);
  
  // Сохраняем платеж в БД
  const stmt = db.prepare(`
    INSERT INTO payments (invoice_id, telegram_id, amount, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  stmt.run(invoiceId, String(telegramId), AMOUNT, new Date().toISOString());
  
  // Генерируем подпись
  const signatureString = `${MERCHANT_LOGIN}:${AMOUNT}:${invoiceId}:${PASSWORD_1}`;
  const signature = crypto.createHash("md5").update(signatureString).digest("hex");
  
  // Формируем URL
  const params = new URLSearchParams({
    MerchantLogin: MERCHANT_LOGIN,
    OutSum: String(AMOUNT),
    InvId: invoiceId,
    SignatureValue: signature,
    Description: "Подписка на 30 дней",
    IsTest: IS_TEST ? "1" : "0"
  });
  
  const paymentUrl = `${BASE_URL}?${params.toString()}`;
  
  return { invoiceId, paymentUrl };
}

export function verifySignature(
  amount: number,
  invoiceId: string,
  signature: string
): boolean {
  const signatureString = `${amount}:${invoiceId}:${PASSWORD_2}`;
  const calculatedSignature = crypto.createHash("md5").update(signatureString).digest("hex").toUpperCase();
  
  return calculatedSignature === signature.toUpperCase();
}

export function findPaymentByInvoiceId(invoiceId: string): { telegram_id: string; status: string } | null {
  const stmt = db.prepare("SELECT telegram_id, status FROM payments WHERE invoice_id = ?");
  const row = stmt.get(invoiceId) as { telegram_id: string; status: string } | undefined;
  
  return row || null;
}

export function updatePaymentStatus(invoiceId: string, status: string): void {
  const stmt = db.prepare("UPDATE payments SET status = ? WHERE invoice_id = ?");
  stmt.run(status, invoiceId);
}

