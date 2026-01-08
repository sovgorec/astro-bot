import crypto from "crypto";
import db from "../db/init";
import { getUserByTelegramId, createUserIfNotExists } from "../db/userRepository";
import { hasActiveSubscription } from "../db/subscriptionRepository";

/**
 * RoboKassa Merchant API интеграция
 * 
 * ВАЖНО: Ошибка 29 "магазин недоступен" может быть связана с типом магазина RoboKassa.
 * Если MerchantLogin имеет формат @botname, это указывает на Telegram-магазин.
 * RoboKassa может требовать специальной настройки магазина для работы с Telegram-ботами.
 * Это административное ограничение, а не ошибка в коде/подписи.
 * 
 * ПРИМЕЧАНИЕ ДЛЯ БУДУЩЕГО: 
 * Для переключения на Telegram Payments (sendInvoice) потребуется:
 * 1. Создать альтернативную функцию createTelegramPayment(telegramId) в этом же файле
 * 2. Изменить showPaymentMessage в bot.ts для использования новой функции
 * 3. Логика подписок (subscriptionRepository) остается без изменений
 * 4. Webhook для Telegram Payments обрабатывается через bot.on('pre_checkout_query') и bot.on('successful_payment')
 */

// Тип возвращаемого значения для платежной системы (общий для RoboKassa и будущего Telegram Payments)
export interface PaymentResult {
  invoiceId: number;
  paymentUrl?: string; // Для RoboKassa - URL редиректа
  // Для Telegram Payments можно добавить invoice payload или другие поля
}

// Константы подписки
export const SUBSCRIPTION_PRICE = 149; // Цена подписки в рублях
export const SUBSCRIPTION_DAYS = 30; // Срок подписки в днях

const MERCHANT_LOGIN = process.env.ROBOKASSA_MERCHANT_LOGIN;
const PASSWORD_1 = process.env.ROBOKASSA_PASSWORD_1 || "";
const PASSWORD_2 = process.env.ROBOKASSA_PASSWORD_2 || "";
const AMOUNT = SUBSCRIPTION_PRICE;
const IS_TEST = process.env.ROBOKASSA_TEST === "true";
const BASE_URL = IS_TEST 
  ? "https://auth.robokassa.ru/Merchant/Index.aspx"
  : "https://auth.robokassa.ru/Merchant/Index.aspx";

/**
 * Создает платеж через RoboKassa Merchant API
 * 
 * Формула подписи: MerchantLogin:OutSum:InvId:Password#1 (НЕ МЕНЯТЬ)
 * InvId: Date.now() для уникальности (НЕ МЕНЯТЬ)
 * OutSum: toFixed(2) формат (НЕ МЕНЯТЬ)
 * 
 * @param telegramId - ID пользователя Telegram
 * @returns PaymentResult с invoiceId и paymentUrl, или null при ошибке
 */
export function createPayment(telegramId: number): PaymentResult | null {
  // ШАГ 4: Проверяем активную подписку
  if (hasActiveSubscription(telegramId)) {
    console.log(`[PAY] subscription already active → payment blocked | User: ${telegramId}`);
    return null;
  }
  
  // ШАГ 2: Проверяем наличие pending платежа
  const pendingPayment = findPendingPaymentByTelegramId(telegramId);
  if (pendingPayment) {
    console.log(`[PAY] pending payment found → reuse invoiceId=${pendingPayment.id} | User: ${telegramId}`);
    
    // Пересоздаём paymentUrl для существующего invoiceId
    const outSum = Number(AMOUNT).toFixed(2);
    const merchantLogin = MERCHANT_LOGIN!;
    const signatureString = `${merchantLogin}:${outSum}:${pendingPayment.id}:${PASSWORD_1}`;
    const signature = crypto.createHash("md5").update(signatureString).digest("hex").toLowerCase();
    
    const description = `Подписка на ${SUBSCRIPTION_DAYS} дней`;
    const params = new URLSearchParams({
      MerchantLogin: merchantLogin,
      OutSum: outSum,
      InvId: pendingPayment.id.toString(),
      Description: description,
      SignatureValue: signature,
      Culture: "ru",
      Email: "user@telegram.local"
    });
    
    if (IS_TEST) {
      params.append("IsTest", "1");
    }
    
    const paymentUrl = `${BASE_URL}?${params.toString()}`;
    
    return { invoiceId: pendingPayment.id, paymentUrl };
  }
  
  // ВАЖНО: Убеждаемся, что пользователь существует в БД перед созданием платежа
  let user = getUserByTelegramId(telegramId);
  if (!user) {
    console.log(`📝 Создаём пользователя ${telegramId} при создании платежа`);
    user = createUserIfNotExists(telegramId, {
      onboardingCompleted: false
    });
  }
  
  // Проверяем наличие MerchantLogin (строго из process.env, без модификаций)
  if (!MERCHANT_LOGIN) {
    console.error("❌ ROBOKASSA_MERCHANT_LOGIN is not set");
    return null;
  }
  
  // ВАЖНО: Если MerchantLogin имеет формат @botname, это Telegram-магазин
  // Ошибка 29 может быть административным ограничением (магазин не настроен для Telegram)
  if (MERCHANT_LOGIN.startsWith("@")) {
    console.warn("⚠️ MerchantLogin имеет формат @botname (Telegram-магазин)");
    console.warn("⚠️ Если возникает ошибка 29, проверьте настройки магазина в личном кабинете RoboKassa");
  }
  
  if (!PASSWORD_1) {
    console.error("❌ ROBOKASSA_PASSWORD_1 is not set");
    return null;
  }
  
  console.log(`[PAY] creating new payment → invoiceId will be generated | User: ${telegramId}`);
  
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
  // ВАЖНО: Формула корректна, НЕ МЕНЯТЬ
  const signatureString = `${merchantLogin}:${outSum}:${invoiceId}:${PASSWORD_1}`;
  const signature = crypto.createHash("md5").update(signatureString).digest("hex").toLowerCase();
  
  // Подробное логирование всех параметров перед редиректом
  console.log("🔍 RoboKassa payment parameters:");
  console.log("  merchantLogin:", merchantLogin);
  console.log("  outSum:", outSum);
  console.log("  invId:", invoiceId);
  console.log("  signatureString:", signatureString);
  console.log("  signature:", signature);
  
  // ВАЖНО: Если RoboKassa возвращает ошибку 29 "магазин недоступен":
  // - Это НЕ ошибка подписи (подпись рассчитана корректно)
  // - Это административное ограничение (магазин не настроен/не активен для Telegram)
  // - Проверьте настройки магазина в личном кабинете RoboKassa
  
  // Формируем URL с обязательными параметрами для Telegram-магазина
  // MerchantLogin используется БЕЗ модификаций (URLSearchParams правильно закодирует для URL)
  const description = `Подписка на ${SUBSCRIPTION_DAYS} дней`;
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
  // ВАЖНО: telegram_id сохраняется как строка для согласованности с subscriptions
  const stmt = db.prepare(`
    INSERT INTO payments (id, telegram_id, amount, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `);
  try {
    const telegramIdStr = String(telegramId);
    stmt.run(invoiceId, telegramIdStr, AMOUNT, new Date().toISOString());
    console.log(`[PAY] ✅ new payment created → invoiceId=${invoiceId}, telegramId=${telegramIdStr}, amount=${AMOUNT}`);
  } catch (err: any) {
    // Если id уже существует (крайне маловероятно для Date.now()), генерируем новый с добавлением миллисекунд
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      console.warn("⚠️ Collision detected for invoiceId, generating new one");
      const invoiceIdWithRandom = Date.now() + Math.floor(Math.random() * 1000);
      const signatureString2 = `${merchantLogin}:${outSum}:${invoiceIdWithRandom}:${PASSWORD_1}`;
      const signature2 = crypto.createHash("md5").update(signatureString2).digest("hex").toLowerCase();
      
      params.set("InvId", invoiceIdWithRandom.toString());
      params.set("SignatureValue", signature2);
      
      const telegramIdStr = String(telegramId);
      stmt.run(invoiceIdWithRandom, telegramIdStr, AMOUNT, new Date().toISOString());
      console.log(`[PAY] ✅ new payment created (retry after collision) → invoiceId=${invoiceIdWithRandom}, telegramId=${telegramIdStr}, amount=${AMOUNT}`);
      
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

/**
 * Проверяет подпись RoboKassa для Result URL (webhook)
 * 
 * Официальная формула: md5(OutSum:InvId:Password2)
 * 
 * ВАЖНО:
 * - OutSum используется КАК ЕСТЬ из webhook (например, "149.000000")
 * - НЕ преобразовывать OutSum в number и обратно в строку
 * - RoboKassa подписывает именно ту строку, которую отправляет
 * - InvId - число (invoiceId)
 * - Password2 - второй пароль из настроек RoboKassa
 * - Сравнение подписи case-insensitive (приводим к UPPERCASE)
 * 
 * @param outSum - Сумма платежа как строка из webhook (например "149.000000")
 * @param invoiceId - ID инвойса (InvId)
 * @param signature - Подпись от RoboKassa (SignatureValue)
 * @returns true если подпись валидна, false иначе
 */
export function verifySignature(
  outSum: string,
  invoiceId: number,
  signature: string
): boolean {
  // ВАЖНО: Используем OutSum КАК ЕСТЬ, без преобразований
  // Формула: md5(OutSum:InvId:Password2)
  const signatureString = `${outSum}:${invoiceId}:${PASSWORD_2}`;
  const expectedSignature = crypto.createHash("md5").update(signatureString).digest("hex").toUpperCase();
  const receivedSignature = signature.toUpperCase();
  
  const isValid = expectedSignature === receivedSignature;
  
  if (isValid) {
    console.log(`✅ Signature valid | OutSum=${outSum}, InvId=${invoiceId}`);
  } else {
    console.error("❌ Invalid signature");
    console.error(`   Expected: ${expectedSignature}`);
    console.error(`   Received: ${receivedSignature}`);
    console.error(`   OutSum: ${outSum}, InvId: ${invoiceId}`);
    console.error(`   Signature string: ${signatureString}`);
  }
  
  return isValid;
}

export function findPaymentById(id: number): { telegram_id: string; status: string } | null {
  const stmt = db.prepare("SELECT telegram_id, status FROM payments WHERE id = ?");
  const row = stmt.get(id) as { telegram_id: string; status: string } | undefined;
  
  return row || null;
}

/**
 * Находит последний pending-платёж для пользователя
 * @param telegramId - ID пользователя Telegram
 * @returns Информация о последнем pending платеже (id, amount) или null
 */
export function findPendingPaymentByTelegramId(telegramId: number): { id: number; amount: number } | null {
  const telegramIdStr = String(telegramId);
  const stmt = db.prepare(`
    SELECT id, amount 
    FROM payments 
    WHERE telegram_id = ? AND status = 'pending' 
    ORDER BY id DESC 
    LIMIT 1
  `);
  const row = stmt.get(telegramIdStr) as { id: number; amount: number } | undefined;
  
  return row || null;
}

/**
 * Находит последний оплаченный платёж для пользователя
 * @param telegramId - ID пользователя Telegram
 * @returns Информация о последнем оплаченном платеже или null
 */
export function findLastPaidPayment(telegramId: number): { id: number; created_at: string } | null {
  const telegramIdStr = String(telegramId);
  const stmt = db.prepare(`
    SELECT id, created_at 
    FROM payments 
    WHERE telegram_id = ? AND status = 'paid' 
    ORDER BY id DESC 
    LIMIT 1
  `);
  const row = stmt.get(telegramIdStr) as { id: number; created_at: string } | undefined;
  
  return row || null;
}

export function updatePaymentStatus(id: number, status: string): void {
  const stmt = db.prepare("UPDATE payments SET status = ? WHERE id = ?");
  stmt.run(status, id);
}

/**
 * БУДУЩАЯ РЕАЛИЗАЦИЯ: Telegram Payments (sendInvoice)
 * 
 * Пример реализации для переключения с RoboKassa на Telegram Payments:
 * 
 * export async function createTelegramPayment(
 *   bot: Telegraf,
 *   telegramId: number
 * ): Promise<PaymentResult | null> {
 *   const invoiceId = Date.now();
 *   
 *   // Сохраняем платеж в БД
 *   const stmt = db.prepare(`
 *     INSERT INTO payments (id, telegram_id, amount, status, created_at)
 *     VALUES (?, ?, ?, 'pending', ?)
 *   `);
 *   stmt.run(invoiceId, String(telegramId), AMOUNT, new Date().toISOString());
 *   
 *   // Отправляем invoice через Telegram Bot API
 *   try {
 *     await bot.telegram.sendInvoice(telegramId, {
 *       title: `Подписка на ${SUBSCRIPTION_DAYS} дней`,
 *       description: "Полный доступ ко всем функциям бота",
 *       payload: String(invoiceId),
 *       provider_token: process.env.TELEGRAM_PAYMENT_PROVIDER_TOKEN!,
 *       currency: "RUB",
 *       prices: [{ label: "Подписка", amount: SUBSCRIPTION_PRICE * 100 }] // в копейках
 *     });
 *     
 *     return { invoiceId }; // paymentUrl не нужен для Telegram Payments
 *   } catch (err) {
 *     console.error("Ошибка отправки invoice:", err);
 *     return null;
 *   }
 * }
 * 
 * Обработчики в bot.ts:
 * 
 * bot.on('pre_checkout_query', async (ctx) => {
 *   const invoiceId = Number(ctx.preCheckoutQuery.invoice_payload);
 *   const payment = findPaymentById(invoiceId);
 *   if (payment && payment.status === 'pending') {
 *     await ctx.answerPreCheckoutQuery(true);
 *   } else {
 *     await ctx.answerPreCheckoutQuery(false, { error_message: 'Payment not found' });
 *   }
 * });
 * 
 * bot.on('successful_payment', async (ctx) => {
 *   const invoiceId = Number(ctx.message.successful_payment.invoice_payload);
 *   const payment = findPaymentById(invoiceId);
 *   if (payment && payment.status !== 'paid') {
 *     updatePaymentStatus(invoiceId, 'paid');
 *     activateSubscription(Number(payment.telegram_id), SUBSCRIPTION_DAYS);
 *     await ctx.reply(`✅ Подписка активирована на ${SUBSCRIPTION_DAYS} дней`);
 *   }
 * });
 */

