import db from "./init";

export interface UserData {
  sign?: string | null;
  dailyIndex?: number;
  weeklyIndex?: number;
  timezone?: string | null;
  dailyHour?: number;
  weeklyHour?: number;
  weeklyDow?: number;
  lastLunarDay?: number | null;
  lastDailyDate?: string | null;
  lastDailyText?: string | null;
  lastWeeklyDate?: string | null;
  lastWeeklyText?: string | null;
  dailyTaskIndex?: number;
  currentTestId?: string | null;
  currentQuestionIndex?: number;
  currentTestScore?: number;
  birthDate?: string | null;
  arcans?: { main: number; relations: number; money: number; purpose: number; weak: number } | null;
  awaitingBirthDate?: boolean;
}

export interface User extends UserData {
  telegramId: number;
}

// Преобразование данных из БД в объект пользователя
function rowToUser(row: any): User | null {
  if (!row) return null;

  return {
    telegramId: row.telegram_id,
    sign: row.sign || null,
    dailyIndex: row.daily_index ?? 0,
    weeklyIndex: row.weekly_index ?? 0,
    timezone: row.timezone || null,
    dailyHour: row.daily_hour ?? 9,
    weeklyHour: row.weekly_hour ?? 21,
    weeklyDow: row.weekly_dow ?? 0,
    lastLunarDay: row.last_lunar_day ?? null,
    lastDailyDate: row.last_daily_date || null,
    lastDailyText: row.last_daily_text || null,
    lastWeeklyDate: row.last_weekly_date || null,
    lastWeeklyText: row.last_weekly_text || null,
    dailyTaskIndex: row.daily_task_index ?? 0,
    currentTestId: row.current_test_id || null,
    currentQuestionIndex: row.current_question_index ?? 0,
    currentTestScore: row.current_test_score ?? 0,
    birthDate: row.birth_date || null,
    arcans: row.arcans ? JSON.parse(row.arcans) : null,
    awaitingBirthDate: row.awaiting_birth_date === 1,
  };
}

// Получить пользователя по telegram_id
export function getUserByTelegramId(telegramId: number): User | null {
  const stmt = db.prepare("SELECT * FROM users WHERE telegram_id = ?");
  const row = stmt.get(telegramId);
  return rowToUser(row);
}

// Создать пользователя, если его нет
export function createUserIfNotExists(telegramId: number, userData: UserData = {}): User {
  const existing = getUserByTelegramId(telegramId);
  if (existing) {
    return existing;
  }

  const stmt = db.prepare(`
    INSERT INTO users (
      telegram_id, sign, daily_index, weekly_index, timezone,
      daily_hour, weekly_hour, weekly_dow, last_lunar_day,
      last_daily_date, last_daily_text, last_weekly_date, last_weekly_text,
      daily_task_index, current_test_id, current_question_index, current_test_score,
      birth_date, arcans, awaiting_birth_date, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
  `);

  stmt.run(
    telegramId,
    userData.sign || null,
    userData.dailyIndex ?? 0,
    userData.weeklyIndex ?? 0,
    userData.timezone || null,
    userData.dailyHour ?? 9,
    userData.weeklyHour ?? 21,
    userData.weeklyDow ?? 0,
    userData.lastLunarDay ?? null,
    userData.lastDailyDate || null,
    userData.lastDailyText || null,
    userData.lastWeeklyDate || null,
    userData.lastWeeklyText || null,
    userData.dailyTaskIndex ?? 0,
    userData.currentTestId || null,
    userData.currentQuestionIndex ?? 0,
    userData.currentTestScore ?? 0,
    userData.birthDate || null,
    userData.arcans ? JSON.stringify(userData.arcans) : null,
    userData.awaitingBirthDate ? 1 : 0
  );

  return getUserByTelegramId(telegramId)!;
}

// Обновить данные пользователя
export function updateUser(telegramId: number, patch: Partial<UserData>): void {
  const updates: string[] = [];
  const values: any[] = [];

  if (patch.sign !== undefined) {
    updates.push("sign = ?");
    values.push(patch.sign || null);
  }
  if (patch.dailyIndex !== undefined) {
    updates.push("daily_index = ?");
    values.push(patch.dailyIndex);
  }
  if (patch.weeklyIndex !== undefined) {
    updates.push("weekly_index = ?");
    values.push(patch.weeklyIndex);
  }
  if (patch.timezone !== undefined) {
    updates.push("timezone = ?");
    values.push(patch.timezone || null);
  }
  if (patch.dailyHour !== undefined) {
    updates.push("daily_hour = ?");
    values.push(patch.dailyHour);
  }
  if (patch.weeklyHour !== undefined) {
    updates.push("weekly_hour = ?");
    values.push(patch.weeklyHour);
  }
  if (patch.weeklyDow !== undefined) {
    updates.push("weekly_dow = ?");
    values.push(patch.weeklyDow);
  }
  if (patch.lastLunarDay !== undefined) {
    updates.push("last_lunar_day = ?");
    values.push(patch.lastLunarDay ?? null);
  }
  if (patch.lastDailyDate !== undefined) {
    updates.push("last_daily_date = ?");
    values.push(patch.lastDailyDate || null);
  }
  if (patch.lastDailyText !== undefined) {
    updates.push("last_daily_text = ?");
    values.push(patch.lastDailyText || null);
  }
  if (patch.lastWeeklyDate !== undefined) {
    updates.push("last_weekly_date = ?");
    values.push(patch.lastWeeklyDate || null);
  }
  if (patch.lastWeeklyText !== undefined) {
    updates.push("last_weekly_text = ?");
    values.push(patch.lastWeeklyText || null);
  }
  if (patch.dailyTaskIndex !== undefined) {
    updates.push("daily_task_index = ?");
    values.push(patch.dailyTaskIndex);
  }
  if (patch.currentTestId !== undefined) {
    updates.push("current_test_id = ?");
    values.push(patch.currentTestId || null);
  }
  if (patch.currentQuestionIndex !== undefined) {
    updates.push("current_question_index = ?");
    values.push(patch.currentQuestionIndex);
  }
  if (patch.currentTestScore !== undefined) {
    updates.push("current_test_score = ?");
    values.push(patch.currentTestScore);
  }
  if (patch.birthDate !== undefined) {
    updates.push("birth_date = ?");
    values.push(patch.birthDate || null);
  }
  if (patch.arcans !== undefined) {
    updates.push("arcans = ?");
    values.push(patch.arcans ? JSON.stringify(patch.arcans) : null);
  }
  if (patch.awaitingBirthDate !== undefined) {
    updates.push("awaiting_birth_date = ?");
    values.push(patch.awaitingBirthDate ? 1 : 0);
  }

  if (updates.length === 0) return;

  updates.push("updated_at = unixepoch()");
  values.push(telegramId);

  const stmt = db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE telegram_id = ?`);
  stmt.run(...values);
}

// Получить всех пользователей
export function getAllUsers(): User[] {
  const stmt = db.prepare("SELECT * FROM users");
  const rows = stmt.all() as any[];
  return rows.map(row => rowToUser(row)!).filter(Boolean);
}


