import express, { type Request, type Response } from "express";
import { bot } from "./bot";
import { verifySignature, findPaymentById, updatePaymentStatus } from "./services/robokassa";
import { activateSubscription } from "./db/subscriptionRepository";

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
      return res.status(404).send("Payment not found");
    }

    // Проверяем, не оплачен ли уже
    if (payment.status === "paid") {
      return res.send(`OK${invoiceId}`);
    }

    // Обновляем статус платежа
    updatePaymentStatus(invoiceId, "paid");

    // Активируем подписку
    const telegramId = parseInt(payment.telegram_id);
    activateSubscription(telegramId, 30);

    // Отправляем уведомление пользователю
    try {
      await bot.telegram.sendMessage(
        telegramId,
        "✅ Подписка активирована на 30 дней"
      );
    } catch (err) {
      console.error("Ошибка отправки уведомления:", err);
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

