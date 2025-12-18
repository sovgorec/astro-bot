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

export default db;

