import crypto from "crypto";
import db from "../db/init";

const MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN;
const PASSWORD_1 = process.env.ROBOKASSA_PASSWORD_1 || "";
const PASSWORD_2 = process.env.ROBOKASSA_PASSWORD_2 || "";
const AMOUNT = 50;
const IS_TEST = process.env.ROBOKASSA_TEST === "true";
const BASE_URL = IS_TEST 
  ? "https://auth.robokassa.ru/Merchant/Index.aspx"
  : "https://auth.robokassa.ru/Merchant/Index.aspx";

export function createPayment(telegramId: number): { invoiceId: number; paymentUrl: string } | null {
  // Проверяем наличие MerchantLogin
  if (!MERCHANT_LOGIN) {
    console.error("❌ ROBOKASSA_MERCHANT_LOGIN is not set");
    return null;
  }
  
  if (!PASSWORD_1) {
    console.error("❌ ROBOKASSA_PASSWORD_1 is not set");
    return null;
  }
  
  // Сначала создаём платеж в БД
  const stmt = db.prepare(`
    INSERT INTO payments (telegram_id, amount, status, created_at)
    VALUES (?, ?, 'pending', ?)
  `);
  const result = stmt.run(String(telegramId), AMOUNT, new Date().toISOString());
  
  // Используем ID из БД как InvId
  const invoiceId = result.lastInsertRowid as number;
  
  // Проверяем, что InvId валидный
  if (!invoiceId || invoiceId <= 0) {
    console.error("❌ Invalid invoiceId:", invoiceId);
    return null;
  }
  
  // OutSum должен быть строкой с 2 знаками после запятой
  const outSum = Number(AMOUNT).toFixed(2);
  
  // Генерируем подпись по документации RoboKassa: md5(MerchantLogin:OutSum:InvId:Password#1)
  const signatureString = `${MERCHANT_LOGIN}:${outSum}:${invoiceId}:${PASSWORD_1}`;
  const signature = crypto.createHash("md5").update(signatureString).digest("hex").toLowerCase();
  
  // Отладка (временно)
  console.log("🔍 RoboKassa payment signature:", {
    merchantLogin: MERCHANT_LOGIN,
    outSum,
    invId: invoiceId,
    signature,
    signatureString
  });
  
  // Формируем URL с обязательными параметрами для Telegram-магазина
  const description = "Подписка на 30 дней";
  const params = new URLSearchParams({
    MerchantLogin: MERCHANT_LOGIN!,
    OutSum: outSum,
    InvId: invoiceId.toString(),
    Description: description,
    SignatureValue: signature,
    Culture: "ru",
    Email: "user@telegram.local"
  });
  
  // Добавляем IsTest, если нужно
  if (IS_TEST) {
    params.append("IsTest", "1");
  }
  
  const paymentUrl = `${BASE_URL}?${params.toString()}`;
  
  return { invoiceId, paymentUrl };
}

export function verifySignature(
  amount: number,
  invoiceId: number,
  signature: string
): boolean {
  const signatureString = `${amount}:${invoiceId}:${PASSWORD_2}`;
  const calculatedSignature = crypto.createHash("md5").update(signatureString).digest("hex").toUpperCase();
  
  return calculatedSignature === signature.toUpperCase();
}

export function findPaymentById(id: number): { telegram_id: string; status: string } | null {
  const stmt = db.prepare("SELECT telegram_id, status FROM payments WHERE id = ?");
  const row = stmt.get(id) as { telegram_id: string; status: string } | undefined;
  
  return row || null;
}

export function updatePaymentStatus(id: number, status: string): void {
  const stmt = db.prepare("UPDATE payments SET status = ? WHERE id = ?");
  stmt.run(status, id);
}

