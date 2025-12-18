import fs from "fs";
import db from "./init";
import { createUserIfNotExists } from "./userRepository";

export function migrateUsersFromJson(): void {
  const usersJsonPath = "./data/users.json";
  
  // Проверяем, существует ли файл
  if (!fs.existsSync(usersJsonPath)) {
    console.log("📄 users.json не найден, миграция не требуется");
    return;
  }

  // Проверяем, есть ли уже пользователи в БД
  const existingUsers = db.prepare("SELECT COUNT(*) as count FROM users").get() as { count: number };
  if (existingUsers.count > 0) {
    console.log("✅ В БД уже есть пользователи, миграция не требуется");
    return;
  }

  try {
    // Читаем users.json
    const usersJson = JSON.parse(fs.readFileSync(usersJsonPath, "utf8"));
    const users = usersJson as Record<string, any>;

    let migrated = 0;
    let errors = 0;

    // Мигрируем каждого пользователя
    for (const [telegramIdStr, userData] of Object.entries(users)) {
      try {
        const telegramId = Number(telegramIdStr);
        if (isNaN(telegramId)) {
          console.warn(`⚠️ Пропущен невалидный telegram_id: ${telegramIdStr}`);
          errors++;
          continue;
        }

        // Преобразуем данные из JSON формата в формат репозитория
        const migratedData = {
          sign: userData.sign || null,
          dailyIndex: userData.dailyIndex ?? 0,
          weeklyIndex: userData.weeklyIndex ?? 0,
          timezone: userData.timezone || null,
          dailyHour: userData.dailyHour ?? 9,
          weeklyHour: userData.weeklyHour ?? 21,
          weeklyDow: userData.weeklyDow ?? 0,
          lastLunarDay: userData.lastLunarDay ?? null,
          lastDailyDate: userData.lastDailyDate || null,
          lastDailyText: userData.lastDailyText || null,
          lastWeeklyDate: userData.lastWeeklyDate || null,
          lastWeeklyText: userData.lastWeeklyText || null,
          dailyTaskIndex: userData.dailyTaskIndex ?? 0,
          currentTestId: userData.currentTestId || null,
          currentQuestionIndex: userData.currentQuestionIndex ?? 0,
          currentTestScore: userData.currentTestScore ?? 0,
          birthDate: userData.birthDate || null,
          arcans: userData.arcans || null,
          awaitingBirthDate: userData.awaitingBirthDate ?? false,
        };

        createUserIfNotExists(telegramId, migratedData);
        migrated++;
      } catch (err) {
        console.error(`❌ Ошибка при миграции пользователя ${telegramIdStr}:`, err);
        errors++;
      }
    }

    console.log(`✅ Миграция завершена: ${migrated} пользователей перенесено, ${errors} ошибок`);
  } catch (err) {
    console.error("❌ Ошибка при чтении users.json:", err);
  }
}

