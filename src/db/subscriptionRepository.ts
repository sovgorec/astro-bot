import db from "./init";

export function hasActiveSubscription(telegramId: number): boolean {
  const stmt = db.prepare("SELECT * FROM subscriptions WHERE telegram_id = ? AND status = 'active'");
  const row = stmt.get(String(telegramId)) as { expires_at: string } | undefined;
  
  if (!row) return false;
  
  const expiresAt = new Date(row.expires_at);
  const now = new Date();
  
  return expiresAt > now;
}

export function activateSubscription(telegramId: number, days: number = 30): void {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  const expiresAtStr = expiresAt.toISOString();
  
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO subscriptions (telegram_id, status, expires_at)
    VALUES (?, 'active', ?)
  `);
  
  stmt.run(String(telegramId), expiresAtStr);
}


