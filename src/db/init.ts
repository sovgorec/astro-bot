import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "db.sqlite");
const db = new Database(dbPath);

// Включаем foreign keys
db.pragma("foreign_keys = ON");

// Создаём таблицу users
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    sign TEXT,
    daily_index INTEGER DEFAULT 0,
    weekly_index INTEGER DEFAULT 0,
    timezone TEXT,
    daily_hour INTEGER DEFAULT 9,
    weekly_hour INTEGER DEFAULT 21,
    weekly_dow INTEGER DEFAULT 0,
    last_lunar_day INTEGER,
    last_daily_date TEXT,
    last_daily_text TEXT,
    last_weekly_date TEXT,
    last_weekly_text TEXT,
    daily_task_index INTEGER DEFAULT 0,
    current_test_id TEXT,
    current_question_index INTEGER DEFAULT 0,
    current_test_score INTEGER DEFAULT 0,
    birth_date TEXT,
    arcans TEXT,
    awaiting_birth_date INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT (unixepoch()),
    updated_at INTEGER DEFAULT (unixepoch())
  )
`);

// Создаём таблицу subscriptions
db.exec(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    telegram_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )
`);

// Создаём таблицу payments
// Проверяем структуру существующей таблицы и мигрируем при необходимости
try {
  const tableInfo = db.prepare("PRAGMA table_info(payments)").all() as Array<{ name: string; type: string; pk: number }>;
  const hasOldStructure = tableInfo.some(col => col.name === "invoice_id" && col.pk === 1);
  
  if (hasOldStructure) {
    // Старая структура: пересоздаём таблицу
    db.exec(`
      DROP TABLE IF EXISTS payments;
      CREATE TABLE payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  } else {
    // Новая структура или таблица не существует
    db.exec(`
      CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }
} catch (err) {
  // Если таблицы нет, создаём новую
  db.exec(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
}

export default db;

