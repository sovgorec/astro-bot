import db from "./init";
import { findLastPaidPayment } from "../services/robokassa";
import { SUBSCRIPTION_DAYS } from "../services/robokassa";

/**
 * Проверяет наличие активной подписки с автоматическим восстановлением из оплаченных платежей.
 * 
 * FALLBACK-ЛОГИКА:
 * Если активной подписки нет, но есть оплаченный платёж (status = 'paid'),
 * автоматически активирует подписку на основе последнего оплаченного платежа.
 * 
 * Это защищает от ситуаций, когда webhook не пришёл, но платёж уже оплачен.
 * 
 * @param telegramId - ID пользователя Telegram
 * @returns true если подписка активна, false если нет и нет оплаченных платежей
 */
export function hasActiveSubscription(telegramId: number): boolean {
  // ВАЖНО: telegram_id хранится как TEXT в БД, поэтому конвертируем в строку
  // БД - единственный источник истины для проверки подписки
  const telegramIdStr = String(telegramId);
  const stmt = db.prepare("SELECT * FROM subscriptions WHERE telegram_id = ? AND status = 'active'");
  const row = stmt.get(telegramIdStr) as { expires_at: string } | undefined;
  
  // Если подписка есть и она активна - возвращаем результат
  if (row) {
    const expiresAt = new Date(row.expires_at);
    const now = new Date();
    
    if (expiresAt > now) {
      return true;
    }
    // Подписка истекла, продолжаем проверку fallback
  }
  
  // FALLBACK: Проверяем, есть ли оплаченные платежи
  const lastPaidPayment = findLastPaidPayment(telegramId);
  
  if (lastPaidPayment) {
    // Найден оплаченный платёж - автоматически активируем подписку
    console.log(`🔄 [FALLBACK] Восстановление подписки из оплаченного платежа:`, {
      telegramId: telegramIdStr,
      paymentId: lastPaidPayment.id,
      paymentDate: lastPaidPayment.created_at
    });
    
    // Активируем подписку на стандартный срок через fallback
    activateSubscription(telegramId, SUBSCRIPTION_DAYS, 'fallback');
    
    console.log(`✅ [FALLBACK] Подписка автоматически активирована:`, {
      telegramId: telegramIdStr,
      days: SUBSCRIPTION_DAYS
    });
    
    // Возвращаем true, так как подписка теперь активна
    return true;
  }
  
  // Нет ни активной подписки, ни оплаченных платежей
  return false;
}

/**
 * Активирует подписку для пользователя.
 * Идемпотентна: повторный вызов обновит expires_at на новый срок.
 * 
 * @param telegramId - ID пользователя Telegram
 * @param days - Количество дней подписки (по умолчанию 30)
 * @param source - Источник активации для логирования ('webhook' | 'fallback' | 'manual')
 */
export function activateSubscription(
  telegramId: number, 
  days: number = 30,
  source: 'webhook' | 'fallback' | 'manual' = 'manual'
): void {
  // ВАЖНО: telegram_id хранится как TEXT в БД, поэтому конвертируем в строку
  const telegramIdStr = String(telegramId);
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  const expiresAtStr = expiresAt.toISOString();
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (telegram_id, status, expires_at)
    VALUES (?, 'active', ?)
  `);
  
  stmt.run(telegramIdStr, expiresAtStr);
  
  console.log(`✅ [${source.toUpperCase()}] Подписка активирована:`, {
    telegramId: telegramIdStr,
    expiresAt: expiresAtStr,
    days: days,
    source: source
  });
}



