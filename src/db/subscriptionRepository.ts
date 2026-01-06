import db from "./init";

export function hasActiveSubscription(telegramId: number): boolean {
  // ВАЖНО: telegram_id хранится как TEXT в БД, поэтому конвертируем в строку
  // БД - единственный источник истины для проверки подписки
  const telegramIdStr = String(telegramId);
  const stmt = db.prepare("SELECT * FROM subscriptions WHERE telegram_id = ? AND status = 'active'");
  const row = stmt.get(telegramIdStr) as { expires_at: string } | undefined;
  
  if (!row) {
    return false;
  }
  
  const expiresAt = new Date(row.expires_at);
  const now = new Date();
  
  return expiresAt > now;
}

export function activateSubscription(telegramId: number, days: number = 30): void {
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
  console.log(`✅ Подписка активирована в БД: telegramId=${telegramIdStr}, expiresAt=${expiresAtStr}, days=${days}`);
}



