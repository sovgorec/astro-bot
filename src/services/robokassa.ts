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
  // Проверяем наличие MerchantLogin (строго из process.env, без модификаций)
  if (!MERCHANT_LOGIN) {
    console.error("❌ ROBOKASSA_MERCHANT_LOGIN is not set");
    return null;
  }
  
  if (!PASSWORD_1) {
    console.error("❌ ROBOKASSA_PASSWORD_1 is not set");
    return null;
  }
  
  // Генерируем уникальный InvId используя Date.now()
  const invoiceId = Date.now();
  
  // Проверяем, что InvId валидный
  if (!invoiceId || invoiceId <= 0) {
    console.error("❌ Invalid invoiceId:", invoiceId);
    return null;
  }
  
  // OutSum должен быть строкой с 2 знаками после запятой
  const outSum = Number(AMOUNT).toFixed(2);
  
  // MerchantLogin используется одинаково в подписи и URL (строго из process.env, без модификаций)
  const merchantLogin = MERCHANT_LOGIN;
  
  // Генерируем подпись строго по формуле: MerchantLogin:OutSum:InvId:Password#1
  const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${PASSWORD_1}`;
  const signature = crypto.createHash("md5").update(signatureString).digest("hex").toLowerCase();
  
  // Подробное логирование всех параметров перед редиректом
  console.log("🔍 RoboKassa payment parameters:");
  console.log("  merchantLogin:", merchantLogin);
  console.log("  outSum:", outSum);
  console.log("  invId:", invoiceId);
  console.log("  signatureString:", signatureString);
  console.log("  signature:", signature);
  
  // Формируем URL с обязательными параметрами для Telegram-магазина
  // MerchantLogin используется БЕЗ модификаций (URLSearchParams правильно закодирует для URL)
  const description = "Подписка на 30 дней";
  const params = new URLSearchParams({
    MerchantLogin: merchantLogin,
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
  
  // Сохраняем платеж в БД с invoiceId (Date.now())
  const stmt = db.prepare(`
    INSERT INTO payments (id, telegram_id, amount, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  try {
    stmt.run(invoiceId, String(telegramId), AMOUNT, new Date().toISOString());
  } catch (err: any) {
    // Если id уже существует (крайне маловероятно для Date.now()), генерируем новый с добавлением миллисекунд
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      console.warn("⚠️ Collision detected for invoiceId, generating new one");
      const invoiceIdWithRandom = Date.now() + Math.floor(Math.random() * 1000);
      const signatureString2 = `${merchantLogin}:${outSum}:${invoiceIdWithRandom}:${PASSWORD_1}`;
      const signature2 = crypto.createHash("md5").update(signatureString2).digest("hex").toLowerCase();
      
      params.set("InvId", invoiceIdWithRandom.toString());
      params.set("SignatureValue", signature2);
      
      stmt.run(invoiceIdWithRandom, String(telegramId), AMOUNT, new Date().toISOString());
      
      const paymentUrl2 = `${BASE_URL}?${params.toString()}`;
      
      console.log("🔍 RoboKassa payment parameters (retry after collision):");
      console.log("  merchantLogin:", merchantLogin);
      console.log("  outSum:", outSum);
      console.log("  invId:", invoiceIdWithRandom);
      console.log("  signatureString:", signatureString2);
      console.log("  signature:", signature2);
      
      return { invoiceId: invoiceIdWithRandom, paymentUrl: paymentUrl2 };
    }
    throw err;
  }
  
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

