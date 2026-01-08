import express, { type Request, type Response } from "express";
import { bot } from "./bot";
import {
  verifySignature,
  findPaymentById,
  updatePaymentStatus,
  SUBSCRIPTION_DAYS,
} from "./services/robokassa";
import { activateSubscription } from "./db/subscriptionRepository";
import {
  getUserByTelegramId,
  createUserIfNotExists,
} from "./db/userRepository";
import { safeSendMessage } from "./utils/safeTelegram";

const app = express();

/**
 * 🔴 КРИТИЧНО ДЛЯ ROBOKASSA
 * Она шлёт application/x-www-form-urlencoded
 */
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ===============================
// RoboKassa webhook
// ===============================
app.post("/webhook/robokassa", async (req: Request, res: Response) => {
  try {
    console.log("📩 RoboKassa webhook HIT");
    console.log("📦 HEADERS:", JSON.stringify(req.headers, null, 2));
    console.log("📦 QUERY:", JSON.stringify(req.query, null, 2));
    console.log("📦 BODY:", JSON.stringify(req.body, null, 2));

    // RoboKassa может присылать параметры через query string ИЛИ body
    // Объединяем оба источника, query имеет приоритет
    const params = { ...req.query, ...req.body };
    console.log("📦 MERGED PARAMS:", JSON.stringify(params, null, 2));

    const OutSum = params.OutSum;
    const InvId = params.InvId;
    const SignatureValue = params.SignatureValue;

    if (!OutSum || !InvId || !SignatureValue) {
      console.error("❌ Missing required parameters");
      console.error("   OutSum:", OutSum);
      console.error("   InvId:", InvId);
      console.error("   SignatureValue:", SignatureValue ? "present" : "missing");
      return res.status(400).send("Missing required parameters");
    }

    // ВАЖНО: OutSum используем как строку БЕЗ преобразований
    // RoboKassa подписывает именно ту строку, которую отправляет (например "149.000000")
    const outSumRaw = String(OutSum);
    const invoiceId = Number(InvId);
    const signature = String(SignatureValue);

    // Проверяем, что InvId - валидное число
    if (isNaN(invoiceId) || invoiceId <= 0) {
      console.error("❌ Invalid InvId:", InvId);
      return res.status(400).send("Invalid InvId");
    }

    // Проверяем подпись (передаём OutSum как строку)
    if (!verifySignature(outSumRaw, invoiceId, signature)) {
      console.error("❌ Invalid signature");
      console.error("   OutSum:", outSumRaw);
      console.error("   invoiceId:", invoiceId);
      console.error("   signature:", signature);
      return res.status(400).send("Invalid signature");
    }

    // Находим платеж по ID
    const payment = findPaymentById(invoiceId);
    if (!payment) {
      console.error("[WEBHOOK] ❌ Payment not found:", invoiceId);
      return res.status(404).send("Payment not found");
    }

    console.log(`[WEBHOOK] payment found | InvoiceId: ${invoiceId}, TelegramId: ${payment.telegram_id}, Status: ${payment.status}`);

    // ШАГ 3: Проверяем, не оплачен ли уже (идемпотентность)
    if (payment.status === "paid") {
      console.log(`[WEBHOOK] payment already paid → skip | InvoiceId: ${invoiceId}`);
      return res.send(`OK${invoiceId}`);
    }

    // ВАЖНО: Извлекаем telegram_id из платежа
    const telegramId = parseInt(payment.telegram_id);
    if (isNaN(telegramId) || telegramId <= 0) {
      console.error("❌ Invalid telegram_id in payment:", payment.telegram_id);
      return res.status(400).send("Invalid telegram_id in payment");
    }

    // ВАЖНО: Убеждаемся, что пользователь существует в БД
    let user = getUserByTelegramId(telegramId);
    if (!user) {
      console.log("📝 Creating user from webhook:", telegramId);
      user = createUserIfNotExists(telegramId, {
        onboardingCompleted: false,
      });
    }

    // Обновляем статус платежа
    updatePaymentStatus(invoiceId, "paid");
    console.log(`[WEBHOOK] ✅ payment status updated to 'paid' | InvoiceId: ${invoiceId}`);

    // ШАГ 3: Активируем подписку для этого telegram_id через webhook
    // Это работает для ЛЮБОГО pending invoice, не только последнего
    activateSubscription(telegramId, SUBSCRIPTION_DAYS, 'webhook');
    console.log(`[SUB] subscription activated | User: ${telegramId}, InvoiceId: ${invoiceId}`);

    // Отправляем уведомление пользователю
    await safeSendMessage(
      telegramId,
      `✅ Подписка активирована на ${SUBSCRIPTION_DAYS} дней`,
      bot
    );

    // Возвращаем OK с invoice_id
    return res.send(`OK${invoiceId}`);
  } catch (err: any) {
    console.error("[ERR] ❌ Webhook error:", err);
    console.error("[ERR]    Stack:", err?.stack);
    return res.status(500).send("Internal server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ HTTP сервер запущен на порту ${PORT}`);
});