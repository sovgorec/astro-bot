import express, { type Request, type Response } from "express";
import { bot } from "./bot";
import { verifySignature, findPaymentById, updatePaymentStatus, SUBSCRIPTION_DAYS } from "./services/robokassa";
import { activateSubscription } from "./db/subscriptionRepository";
import { getUserByTelegramId, createUserIfNotExists } from "./db/userRepository";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Webhook для RoboKassa
app.post("/webhook/robokassa", async (req: Request, res: Response) => {
  try {
    const { OutSum, InvId, SignatureValue } = req.body;
    
    if (!OutSum || !InvId || !SignatureValue) {
      return res.status(400).send("Missing required parameters");
    }

    const amount = parseFloat(OutSum);
    const invoiceId = Number(InvId);
    const signature = SignatureValue;

    // Проверяем, что InvId - валидное число
    if (isNaN(invoiceId) || invoiceId <= 0) {
      return res.status(400).send("Invalid InvId");
    }

    // Проверяем подпись
    if (!verifySignature(amount, invoiceId, signature)) {
      return res.status(400).send("Invalid signature");
    }

    // Находим платеж по ID
    const payment = findPaymentById(invoiceId);
    if (!payment) {
      console.error(`❌ Платёж не найден: invoiceId=${invoiceId}`);
      return res.status(404).send("Payment not found");
    }

    console.log(`🔍 Найден платёж: invoiceId=${invoiceId}, telegramId=${payment.telegram_id}, status=${payment.status}`);

    // Проверяем, не оплачен ли уже
    if (payment.status === "paid") {
      console.log(`ℹ️ Платёж уже обработан: invoiceId=${invoiceId}`);
      return res.send(`OK${invoiceId}`);
    }

    // ВАЖНО: Извлекаем telegram_id из платежа
    const telegramId = parseInt(payment.telegram_id);
    if (isNaN(telegramId) || telegramId <= 0) {
      console.error(`❌ Невалидный telegram_id в платеже: ${payment.telegram_id}`);
      return res.status(400).send("Invalid telegram_id in payment");
    }

    // ВАЖНО: Убеждаемся, что пользователь существует в БД
    let user = getUserByTelegramId(telegramId);
    if (!user) {
      console.log(`📝 Создаём пользователя ${telegramId} из webhook`);
      user = createUserIfNotExists(telegramId, {
        onboardingCompleted: false
      });
    }

    // Обновляем статус платежа
    updatePaymentStatus(invoiceId, "paid");
    console.log(`✅ Статус платежа обновлён: invoiceId=${invoiceId}, status=paid`);

    // Активируем подписку для этого telegram_id
    activateSubscription(telegramId, SUBSCRIPTION_DAYS);
    console.log(`✅ Подписка активирована: telegramId=${telegramId}, days=${SUBSCRIPTION_DAYS}`);

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        telegramId,
        `✅ Подписка активирована на ${SUBSCRIPTION_DAYS} дней`
      );
      console.log(`📨 Уведомление отправлено пользователю: telegramId=${telegramId}`);
    } catch (err: any) {
      console.error(`❌ Ошибка отправки уведомления пользователю ${telegramId}:`, err?.message || err);
      // Не прерываем процесс, подписка уже активирована
    }

    // Возвращаем OK с invoice_id
    res.send(`OK${invoiceId}`);
  } catch (err) {
    console.error("Ошибка обработки webhook:", err);
    res.status(500).send("Internal server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ HTTP сервер запущен на порту ${PORT}`);
});

