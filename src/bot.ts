// КРИТИЧНО: Загружаем env в самом начале, ДО всех импортов
import dotenv from "dotenv";
dotenv.config();

require('./server');
import { Telegraf, Markup, session } from "telegraf";
import cron from "node-cron";
import fs from "fs";
import { zodiacList, zodiacMap } from "./zodiac";
import db from "./db/init";
import { getUserByTelegramId, createUserIfNotExists, updateUser, getAllUsers, User } from "./db/userRepository";
import { migrateUsersFromJson } from "./db/migrate";
import { hasActiveSubscription } from "./db/subscriptionRepository";
import { createPayment, SUBSCRIPTION_PRICE, SUBSCRIPTION_DAYS } from "./services/robokassa";

// Инициализация БД и миграция данных
migrateUsersFromJson();

/* =========================
   Общие утилиты
========================= */

function readJSON(file: string) {
  try {
    return JSON.parse(fs.readFileSync(`./data/${file}`, "utf8"));
  } catch {
    return Array.isArray(file) ? [] : {};
  }
}

function writeJSON(file: string, data: any) {
  fs.writeFileSync(`./data/${file}`, JSON.stringify(data, null, 2), "utf8");
}

function escapeHTML(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/* =========================
   Данные
========================= */

let daily = readJSON("daily.json");
let weekly = readJSON("weekly.json");
let compatibility = readJSON("compatibility.json");
let moon = readJSON("moon.json");

// Задания дня — массив строк или объектов { text }
let dailyTasks: any = readJSON("daily_tasks.json");
if (!Array.isArray(dailyTasks)) dailyTasks = [];

// Тесты: единый файл tests.json
let testsList: any = readJSON("tests.json");
if (!Array.isArray(testsList)) testsList = [];

// Поиск теста по id
function loadTestById(id: string) {
  return testsList.find((t: any) => t.id === id) || null;
}

// Маппинг названий разделов бота → названия разделов в JSON
// JSON: { "general": {...}, "love": {...}, "money": {...}, "purpose": {...}, "shadow": {...}, "advice": {...} }
const MATRIX_SECTION_MAP: Record<string, string> = {
  general: "general",
  relations: "love",
  money: "money",
  purpose: "purpose",
  weak: "shadow",
  recommendations: "advice"
};

// Матрица судьбы — интерпретации по арканам
// Структура файла data/matrix_texts.json:
// {
//   "general": { "1": "текст...", "2": "...", "default": "..." },
//   "love": { ... },
//   "money": { ... },
//   "purpose": { ... },
//   "shadow": { ... },
//   "advice": { ... }
// }
let matrixData: any = readJSON("matrix_texts.json");

function ensureUserDefaults(u: User): User {
  const updates: Partial<User> = {};
  
  if (u.dailyTaskIndex == null) updates.dailyTaskIndex = 0;
  if (u.currentTestId === undefined) updates.currentTestId = null;
  if (u.currentQuestionIndex == null) updates.currentQuestionIndex = 0;
  if (u.currentTestScore == null) updates.currentTestScore = 0;

  // Матрица судьбы
  if (u.birthDate === undefined) updates.birthDate = null;
  if (u.arcans === undefined) updates.arcans = null;
  if (u.awaitingBirthDate === undefined) updates.awaitingBirthDate = false;

  if (Object.keys(updates).length > 0) {
    updateUser(u.telegramId, updates);
    Object.assign(u, updates);
  }

  return u;
}

/**
 * Показывает сообщение с предложением оплаты подписки
 * 
 * ТЕКУЩАЯ РЕАЛИЗАЦИЯ: RoboKassa Merchant API (редирект на внешний URL)
 * 
 * ДЛЯ БУДУЩЕГО ПЕРЕКЛЮЧЕНИЯ НА TELEGRAM PAYMENTS:
 * 1. Заменить createPayment() на createTelegramPayment() из services/robokassa.ts
 * 2. Использовать ctx.replyWithInvoice() вместо replyWithHTML + button.url
 * 3. Добавить обработчики:
 *    - bot.on('pre_checkout_query', ...) для подтверждения платежа
 *    - bot.on('successful_payment', ...) для активации подписки (вызов activateSubscription)
 * 4. Логика подписок (subscriptionRepository) остается БЕЗ ИЗМЕНЕНИЙ
 */
async function showPaymentMessage(ctx: any): Promise<void> {
  const telegramId = ctx.from!.id;
  const payment = createPayment(telegramId);
  
  if (!payment) {
    await ctx.reply(
      "⚠️ Оплата временно недоступна. Попробуйте позже."
    );
    return;
  }
  
  // RoboKassa: редирект на внешний URL
  await ctx.replyWithHTML(
    "🔒 <b>Эта функция доступна по подписке</b>\n\n" +
    `Подписка на ${SUBSCRIPTION_DAYS} дней — <b>${SUBSCRIPTION_PRICE} ₽</b>\n\n` +
    "Полный доступ ко всем функциям бота.",
    Markup.inlineKeyboard([
      [Markup.button.url("💳 Оплатить", payment.paymentUrl!)]
    ])
  );
  
  // Для Telegram Payments будет:
  // await ctx.replyWithInvoice({
  //   title: `Подписка на ${SUBSCRIPTION_DAYS} дней`,
  //   description: "Полный доступ ко всем функциям бота",
  //   payload: String(payment.invoiceId),
  //   provider_token: "...", // из env
  //   currency: "RUB",
  //   prices: [{ label: "Подписка", amount: SUBSCRIPTION_PRICE * 100 }] // в копейках
  // });
}

/* =========================
   Telegram Bot + главное меню
========================= */

export const bot = new Telegraf(process.env.BOT_TOKEN!);
bot.use(session());

// ============================================
// ГЛОБАЛЬНАЯ ЗАЩИТА ОТ КРАШЕЙ
// ============================================
bot.catch((err, ctx) => {
  console.error('❌ Telegraf error:', err);
  console.error('   Update:', ctx.update?.update_id);
  console.error('   User:', ctx.from?.id);
  
  // Пытаемся ответить пользователю, если это возможно
  if (ctx.message || ctx.callbackQuery) {
    try {
      if (ctx.callbackQuery) {
        ctx.answerCbQuery().catch(() => {});
      }
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {
      // Игнорируем ошибки при отправке сообщения об ошибке
    }
  }
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
  console.error('   Promise:', promise);
});

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
  // НЕ завершаем процесс, чтобы бот продолжал работать
});

// ============================================
// ГЛОБАЛЬНОЕ ЛОГИРОВАНИЕ ВСЕХ АПДЕЙТОВ (ДЛЯ ОТЛАДКИ)
// ============================================
bot.use((ctx, next) => {
  const update = ctx.update;
  const updateId = update.update_id;
  
  // Логируем message.text
  if ('message' in update && update.message && 'text' in update.message) {
    console.log(`📨 [UPDATE ${updateId}] MESSAGE.TEXT: "${update.message.text}"`);
    console.log(`   User: ${ctx.from?.id} (@${ctx.from?.username || 'no-username'})`);
  }
  
  // Логируем callback_query.data
  if ('callback_query' in update && update.callback_query) {
    const cb = update.callback_query;
    if ('data' in cb && cb.data) {
      console.log(`🔘 [UPDATE ${updateId}] CALLBACK_QUERY.DATA: "${cb.data}"`);
      console.log(`   User: ${cb.from?.id} (@${cb.from?.username || 'no-username'})`);
    }
  }
  
  // Логируем другие типы апдейтов
  if (!('message' in update) && !('callback_query' in update)) {
    console.log(`📦 [UPDATE ${updateId}] OTHER TYPE:`, Object.keys(update).filter(k => k !== 'update_id').join(', '));
  }
  
  return next();
});



const mainMenu = Markup.keyboard([
  ["🌞 Прогноз на сегодня", "🪐 Прогноз на неделю"],
  ["🌕 Лунный день", "💞 Совместимость"],
  ["🎯 Задание дня", "📋 Тесты"],
  ["🔮 Матрица судьбы"],
  ["⚙️ Настройки"]
]).resize();

bot.telegram.setMyCommands([
  { command: "start", description: "Начать" },
  { command: "mydaily", description: "Прогноз на сегодня 🌞" },
  { command: "myweekly", description: "Прогноз на неделю 🪐" },
  { command: "compatibility", description: "Совместимость ❤️" },
  { command: "moon", description: "Лунный день 🌕" },
  { command: "change_sign", description: "Сменить знак ♻️" },
  { command: "timezone", description: "Часовой пояс 🌍" },
  { command: "settings", description: "Настройки ⏰" },
  { command: "task", description: "Задание дня 🎯" },
  { command: "tests", description: "Психологические тесты 📋" },
  { command: "matrix", description: "Матрица судьбы 🔮" },
  { command: "tariffs", description: "Тарифы и оплата 💳" }
]);

/* =========================
   /start и выбор знака
========================= */


bot.command("change_sign", (ctx) => {
  try {
    sendZodiacSelection(ctx);
  } catch (err: any) {
    console.error('❌ Error in /change_sign:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

function sendZodiacSelection(ctx: any) {
  const rows: any[] = zodiacList.map((z) => [
    Markup.button.callback(`${z.emoji} ${z.name}`, `zodiac_${z.name.replace(/\s+/g, "_")}`)
  ]);
  ctx.reply("🌟 <b>Выбери свой знак Зодиака:</b>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(rows),
  });
}

bot.action(/zodiac_(.+)/, async (ctx) => {
  try {
    const signRu = ctx.match[1].replace(/_/g, " ");
    const signEn = zodiacMap[signRu];
    if (!signEn) {
      await ctx.answerCbQuery("Не смог распознать знак", { show_alert: true });
      return;
    }

    const telegramId = ctx.from!.id;
    
    // Обновляем или создаём пользователя с выбранным знаком и помечаем onboarding как завершённый
    const existingUser = getUserByTelegramId(telegramId);
    if (existingUser) {
      updateUser(telegramId, {
        sign: signRu,
        onboardingCompleted: true
      });
    } else {
    createUserIfNotExists(telegramId, {
      sign: signRu,
      dailyIndex: 0,
      weeklyIndex: 0,
      timezone: null,
      dailyHour: 9,
      weeklyHour: 21,
      weeklyDow: 0, // вс
      lastLunarDay: null,
      lastDailyDate: null,
      lastDailyText: null,
      lastWeeklyDate: null,
      lastWeeklyText: null,
      dailyTaskIndex: 0,
      currentTestId: null,
      currentQuestionIndex: 0,
      currentTestScore: 0,
      birthDate: null,
      arcans: null,
        awaitingBirthDate: false,
        onboardingCompleted: true
    });
    }

    const user = getUserByTelegramId(telegramId)!;
    const text = getDailyText(signEn, user);
    
    await ctx.answerCbQuery();
    
    // Удаляем inline keyboard (редактируем сообщение)
    try {
      await ctx.editMessageReplyMarkup(undefined);
    } catch (e) {
      // Игнорируем ошибки, если сообщение уже было отредактировано
    }
    
    // Отправляем сообщение с главным меню (reply keyboard)
    await ctx.replyWithHTML(
      `<b>${getEmojiBySign(signRu)} Твой знак — ${escapeHTML(signRu)}</b>\n\n` +
      `🔮 ${escapeHTML(text)}\n\n` +
      `Теперь выбери свой <b>часовой пояс</b>, чтобы прогнозы приходили вовремя.`,
      mainMenu
    );

    showTimezoneRegions(ctx);
  } catch (err: any) {
    console.error('❌ Error in zodiac action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Выбор часового пояса
========================= */

type TzItem = { name: string; id: string };

const timezoneRegions: Record<string, TzItem[]> = {
  "🇷🇺 Россия": [
    { name: "Москва (GMT+3)", id: "Europe/Moscow" },
    { name: "Екатеринбург (GMT+5)", id: "Asia/Yekaterinburg" },
    { name: "Омск (GMT+6)", id: "Asia/Omsk" },
    { name: "Новосибирск (GMT+7)", id: "Asia/Novosibirsk" },
    { name: "Владивосток (GMT+10)", id: "Asia/Vladivostok" },
    { name: "Камчатка (GMT+12)", id: "Asia/Kamchatka" },
  ],
  "🌍 Европа": [
    { name: "Мадрид (GMT+1)", id: "Europe/Madrid" },
    { name: "Берлин (GMT+1)", id: "Europe/Berlin" },
    { name: "Лондон (GMT+0)", id: "Europe/London" },
  ],
  "🌏 Азия": [
    { name: "Токио (GMT+9)", id: "Asia/Tokyo" },
    { name: "Сеул (GMT+9)", id: "Asia/Seoul" },
    { name: "Дубай (GMT+4)", id: "Asia/Dubai" },
  ],
  "🌎 Америка": [
    { name: "Буэнос-Айрес (GMT−3)", id: "America/Buenos_Aires" },
    { name: "Нью-Йорк (GMT−5)", id: "America/New_York" },
    { name: "Лос-Анджелес (GMT−8)", id: "America/Los_Angeles" },
  ],
};

bot.command("timezone", (ctx) => showTimezoneRegions(ctx));

function showTimezoneRegions(ctx: any) {
  ctx.reply("🌍 <b>Выбери свой регион:</b>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard([
      [Markup.button.callback("🇷🇺 Россия", "tz_region_Россия")],
      [Markup.button.callback("🌍 Европа", "tz_region_Европа"), Markup.button.callback("🌏 Азия", "tz_region_Азия")],
      [Markup.button.callback("🌎 Америка", "tz_region_Америка")],
    ]),
  });
}

bot.action(/tz_region_(.+)/, async (ctx) => {
  try {
  const region = ctx.match[1];
  const list =
    timezoneRegions[`🇷🇺 ${region}`] ||
    timezoneRegions[`🌍 ${region}`] ||
    timezoneRegions[`🌏 ${region}`] ||
    timezoneRegions[`🌎 ${region}`];

    if (!list) {
      await ctx.answerCbQuery("Не нашёл города", { show_alert: true });
      return;
    }

  const buttons = list.map((tz: TzItem) => [Markup.button.callback(tz.name, `tz_select_${tz.id}`)]);
  buttons.push([Markup.button.callback("⬅️ Назад", "tz_back")]);

  await ctx.answerCbQuery();
  await ctx.reply(`<b>🕒 Выбери город (${escapeHTML(region)}):</b>`, {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(buttons),
  });
  } catch (err: any) {
    console.error('❌ Error in tz_region action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("tz_back", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  showTimezoneRegions(ctx);
  } catch (err: any) {
    console.error('❌ Error in tz_back action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/tz_select_(.+)/, async (ctx) => {
  try {
  const tz = ctx.match[1];
  const uid = ctx.from!.id;
  let user = getUserByTelegramId(uid);
    if (!user) {
      await ctx.answerCbQuery();
      await ctx.reply("Сначала выбери знак через /start 🔮");
      return;
    }
  updateUser(uid, { timezone: tz });
  user = ensureUserDefaults(getUserByTelegramId(uid)!);

  const local = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const timeNow = local.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `✅ Часовой пояс установлен: <b>${escapeHTML(tz)}</b>\n🕐 Сейчас: <b>${escapeHTML(timeNow)}</b>`,
    mainMenu
  );
  } catch (err: any) {
    console.error('❌ Error in tz_select action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Основные команды (кнопки и slash)
========================= */

// Slash-команды
bot.command("mydaily", async (ctx) => {
  try {
    await sendDaily(ctx);
  } catch (err: any) {
    console.error('❌ Error in /mydaily:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.command("myweekly", async (ctx) => {
  try {
    await sendWeekly(ctx);
  } catch (err: any) {
    console.error('❌ Error in /myweekly:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.command("compatibility", (ctx) => {
  try {
    askCompatibility(ctx);
  } catch (err: any) {
    console.error('❌ Error in /compatibility:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.command("moon", async (ctx) => {
  try {
    await sendMoon(ctx);
  } catch (err: any) {
    console.error('❌ Error in /moon:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.command("settings", (ctx) => {
  try {
    showSettings(ctx);
  } catch (err: any) {
    console.error('❌ Error in /settings:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.command("task", (ctx) => {
  try {
    sendDailyTask(ctx);
  } catch (err: any) {
    console.error('❌ Error in /task:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.command("tests", (ctx) => {
  try {
    showTestsMenu(ctx);
  } catch (err: any) {
    console.error('❌ Error in /tests:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.command("matrix", (ctx) => {
  try {
    openMatrix(ctx);
  } catch (err: any) {
    console.error('❌ Error in /matrix:', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.command("tariffs", async (ctx) => {
  try {
    await ctx.replyWithHTML(
    `💳 <b>Тарифы и оплата</b>\n\n` +
    `Информация о тарифах и способах оплаты:\n\n` +
    `<a href="https://docs.google.com/document/d/1Q53-21nSGnMPqVktqlfyrXHEHr9teB2Q1jyk-SGiQAw/edit?usp=sharing">Открыть документ с тарифами</a>`,
    mainMenu
  );
  } catch (err: any) {
    console.error('❌ Error in /tariffs:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Кнопки основного меню (reply keyboard)
========================= */
bot.hears("🌞 Прогноз на сегодня", async (ctx) => {
  try {
    await sendDaily(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Прогноз на сегодня":', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.hears("🪐 Прогноз на неделю", async (ctx) => {
  try {
    await sendWeekly(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Прогноз на неделю":', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.hears("🌕 Лунный день", async (ctx) => {
  try {
    await sendMoon(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Лунный день":', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.hears("💞 Совместимость", (ctx) => {
  try {
    askCompatibility(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Совместимость":', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.hears("🎯 Задание дня", (ctx) => {
  try {
    sendDailyTask(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Задание дня":', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.hears("📋 Тесты", (ctx) => {
  try {
    showTestsMenu(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Тесты":', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.hears("🔮 Матрица судьбы", (ctx) => {
  try {
    openMatrix(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Матрица судьбы":', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

bot.hears("⚙️ Настройки", (ctx) => {
  try {
    showSettings(ctx);
  } catch (err: any) {
    console.error('❌ Error in "Настройки":', err);
    try {
      ctx.reply("Произошла ошибка, попробуй ещё раз").catch(() => {});
    } catch (e) {}
  }
});

// Обработчик выбора знака зодиака через reply keyboard (для старых сообщений)
// ВРЕМЕННО: ЗАКОММЕНТИРОВАН ДЛЯ ОТЛАДКИ, чтобы не перехватывать клики по кнопкам главного меню
// Раскомментировать после отладки
/*
const zodiacReplyButtons = ["♈ Овен", "♉ Телец", "♊ Близнецы", "♋ Рак", "♌ Лев", "♍ Дева", 
  "♎ Весы", "♏ Скорпион", "♐ Стрелец", "♑ Козерог", "♒ Водолей", "♓ Рыбы"];

bot.hears(zodiacReplyButtons, async (ctx) => {
  console.log("🔍 [ZODIAC HEARS] Обработчик знака зодиака вызван");
  const text = (ctx.message as any).text;
  // Извлекаем название знака (убираем эмодзи)
  const signRu = text.replace(/^[^\s]+\s+/, "").trim();
  const signEn = zodiacMap[signRu];
  
  if (!signEn) {
    await ctx.reply("Не смог распознать знак. Попробуй ещё раз.");
    return;
  }

  const telegramId = ctx.from!.id;
  
  // Обновляем или создаём пользователя с выбранным знаком и помечаем onboarding как завершённый
  const existingUser = getUserByTelegramId(telegramId);
  if (existingUser) {
    updateUser(telegramId, {
      sign: signRu,
      onboardingCompleted: true
    });
  } else {
    createUserIfNotExists(telegramId, {
      sign: signRu,
      dailyIndex: 0,
      weeklyIndex: 0,
      timezone: null,
      dailyHour: 9,
      weeklyHour: 21,
      weeklyDow: 0,
      lastLunarDay: null,
      lastDailyDate: null,
      lastDailyText: null,
      lastWeeklyDate: null,
      lastWeeklyText: null,
      dailyTaskIndex: 0,
      currentTestId: null,
      currentQuestionIndex: 0,
      currentTestScore: 0,
      birthDate: null,
      arcans: null,
      awaitingBirthDate: false,
      onboardingCompleted: true
    });
  }

  const user = getUserByTelegramId(telegramId)!;
  const dailyText = getDailyText(signEn, user);
  
  // Удаляем reply keyboard и показываем главное меню
  await ctx.replyWithHTML(
    `<b>${getEmojiBySign(signRu)} Твой знак — ${escapeHTML(signRu)}</b>\n\n` +
    `🔮 ${escapeHTML(dailyText)}\n\n` +
    `Теперь выбери свой <b>часовой пояс</b>, чтобы прогнозы приходили вовремя.`,
    Markup.removeKeyboard() // Удаляем reply keyboard
  );
  
  // Показываем главное меню
  await ctx.replyWithHTML("Выбери раздел:", mainMenu);
  
  showTimezoneRegions(ctx);
});
*/

/* =========================
   Матрица судьбы — вход и разделы
========================= */

async function openMatrix(ctx: any) {
  const u = getUserOrAsk(ctx);
  if (!u) return;
  ensureUserDefaults(u);

  const telegramId = ctx.from!.id;
  if (!hasActiveSubscription(telegramId)) {
    await showPaymentMessage(ctx);
    return;
  }

  // Если дата рождения ещё не указана — просим ввести
  if (!u.birthDate || !u.arcans) {
    updateUser(u.telegramId, { awaitingBirthDate: true });

    ctx.replyWithHTML(
      "🔮 <b>Матрица судьбы</b>\n\n" +
      "Чтобы рассчитать матрицу, введи дату рождения в формате <b>ДД.ММ.ГГГГ</b>.\n\n" +
      "Например: <code>19.10.1989</code>",
      { parse_mode: "HTML" }
    );
    return;
  }

  // Если всё есть — показываем меню разделов
  showMatrixSections(ctx, u);
}

function showMatrixSections(ctx: any, u: any) {
  const bdate = u.birthDate ? String(u.birthDate) : "не указана";

  ctx.replyWithHTML(
    `🔮 <b>Твоя матрица судьбы</b>\n` +
    `Дата рождения: <b>${escapeHTML(bdate)}</b>\n\n` +
    `Выбери раздел, который хочешь посмотреть:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("🧬 Общая характеристика", "matrix_general")],
      [Markup.button.callback("❤️ Отношения", "matrix_relations")],
      [Markup.button.callback("💰 Деньги", "matrix_money")],
      [Markup.button.callback("🧭 Предназначение", "matrix_purpose")],
      [Markup.button.callback("⚠️ Слабые зоны", "matrix_weak")],
      [Markup.button.callback("✨ Рекомендации", "matrix_reco")]
    ])
  );
}

bot.action("matrix_general", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "general");
  } catch (err: any) {
    console.error('❌ Error in matrix_general action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_relations", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "relations");
  } catch (err: any) {
    console.error('❌ Error in matrix_relations action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_money", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "money");
  } catch (err: any) {
    console.error('❌ Error in matrix_money action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_purpose", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "purpose");
  } catch (err: any) {
    console.error('❌ Error in matrix_purpose action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_weak", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "weak");
  } catch (err: any) {
    console.error('❌ Error in matrix_weak action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_reco", async (ctx) => {
  try {
  await ctx.answerCbQuery();
  await sendMatrixSection(ctx, "recommendations");
  } catch (err: any) {
    console.error('❌ Error in matrix_reco action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("matrix_back", async (ctx) => {
  try {
  const u = getUserByTelegramId(ctx.from!.id);
  if (!u) {
      await ctx.answerCbQuery();
      await ctx.reply("Сначала выбери знак через /start 🔮");
      return;
  }
  ensureUserDefaults(u);
    await ctx.answerCbQuery();
  showMatrixSections(ctx, getUserByTelegramId(ctx.from!.id)!);
  } catch (err: any) {
    console.error('❌ Error in matrix_back action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

async function sendMatrixSection(ctx: any, section: string) {
  const u = getUserOrAsk(ctx);
  if (!u) return;
  ensureUserDefaults(u);

  if (!u.birthDate || !u.arcans) {
    updateUser(u.telegramId, { awaitingBirthDate: true });
    await ctx.replyWithHTML(
      "Чтобы показать этот раздел, мне нужна твоя дата рождения.\n" +
      "Введи её в формате <b>ДД.ММ.ГГГГ</b>."
    );
    return;
  }

  // Получаем номер аркана
  if (!u.arcans) {
    return ctx.reply("Матрица не рассчитана.");
  }
  let arcanNum: number | null = null;
  if (section === "general") arcanNum = u.arcans.main;
  if (section === "relations") arcanNum = u.arcans.relations;
  if (section === "money") arcanNum = u.arcans.money;
  if (section === "purpose") arcanNum = u.arcans.purpose;
  if (section === "weak") arcanNum = u.arcans.weak;
  if (section === "recommendations") arcanNum = u.arcans.main;

  const key = String(arcanNum).padStart(2, "0"); // ← ВАЖНО! "1" → "01"

  // Ищем текст в формате matrix["01"]["general"]
  const arcanData = matrixData[key];

  if (!arcanData) {
    return ctx.reply("Нет данных по этому аркану.");
  }

  const field = MATRIX_SECTION_MAP[section]; // general / love / money / purpose / shadow / advice
  const text = arcanData[field] || "Описание пока отсутствует.";

  const titles: any = {
    general: "🧬 Общая характеристика",
    relations: "❤️ Отношения",
    money: "💰 Деньги",
    purpose: "🧭 Предназначение",
    weak: "⚠️ Слабые зоны",
    recommendations: "✨ Рекомендации"
  };

  await ctx.replyWithHTML(
    `${titles[section]}\n\n${escapeHTML(text)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", "matrix_back")],
    ])
  );
}

/* =========================
   Прогнозы день / неделя
========================= */

async function sendDaily(ctx: any) {
  const u = getUserOrAsk(ctx);
  if (!u || !u.sign) return;

  const signEn = zodiacMap[u.sign];
  const text = getDailyText(signEn, u);

  await ctx.replyWithHTML(
    `🌞 <b>Прогноз на сегодня для ${escapeHTML(u.sign)}:</b>\n\n${escapeHTML(text)}`,
    mainMenu
  );
}

async function sendWeekly(ctx: any) {
  const u = getUserOrAsk(ctx);
  if (!u || !u.sign) return;

  const telegramId = ctx.from!.id;
  if (!hasActiveSubscription(telegramId)) {
    await showPaymentMessage(ctx);
    return;
  }

  const signEn = zodiacMap[u.sign];
  const text = getWeeklyText(signEn, u);

  await ctx.replyWithHTML(
    `🪐 <b>Прогноз на неделю для ${escapeHTML(u.sign)}:</b>\n\n${escapeHTML(text)}`,
    mainMenu
  );
}

/* =========================
   Совместимость
========================= */

function askCompatibility(ctx: any) {
  const u = getUserOrAsk(ctx);
  if (!u) return;

  const rows: any[] = zodiacList.map((z) => [
    Markup.button.callback(`${z.emoji} ${z.name}`, `compat_${z.name.replace(/\s+/g, "_")}`)
  ]);

  ctx.reply("💞 <b>Выбери знак партнёра:</b>", {
    parse_mode: "HTML",
    ...Markup.inlineKeyboard(rows),
  });
}

bot.action(/compat_(.+)/, async (ctx) => {
  try {
  const partnerRu = ctx.match[1].replace(/_/g, " ");
  const u = getUserByTelegramId(ctx.from!.id);

    if (!u?.sign) {
      await ctx.answerCbQuery();
      sendZodiacSelection(ctx);
      return;
    }

  const sign1 = zodiacMap[u.sign];
  const sign2 = zodiacMap[partnerRu];

  const match = compatibility.find((r: any) =>
    (r.sign1 === sign1 && r.sign2 === sign2) ||
    (r.sign1 === sign2 && r.sign2 === sign1)
  );

  const text = match ? match.text : "Информация о совместимости не найдена 😅";

    await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    `💞 <b>Совместимость ${escapeHTML(u.sign)} + ${escapeHTML(partnerRu)}:</b>\n\n${escapeHTML(text)}`,
    mainMenu
  );
  } catch (err: any) {
    console.error('❌ Error in compat action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Луна
========================= */

async function sendMoon(ctx: any) {
  try {
    const lunarDay = getLunarDay();

    if (!Array.isArray(moon)) {
      return ctx.reply("⚠️ Ошибка данных о Луне 🌙");
    }

    const desc: any = moon.find((d: any) => Number(d.day) === Number(lunarDay));

    if (!desc) {
      return ctx.reply("🌙 Информация о лунном дне временно недоступна 😅");
    }

    desc.name = desc.name || `Лунный день ${lunarDay}`;
    desc.description = desc.description || "Описание отсутствует.";
    desc.energy = desc.energy || "Без данных.";
    desc.phase = desc.phase || getMoonPhase(lunarDay);
    desc.symbol = desc.symbol || "—";
    desc.advice = desc.advice || "Доверься интуиции.";

    const user = getUserByTelegramId(ctx.from!.id);
    const tz = user?.timezone || "Europe/Moscow";
    const lunarLengthMs = 24.83 * 60 * 60 * 1000;
    const base = new Date(Date.UTC(2000, 0, 6, 18, 14));

    const dayStart = new Date(base.getTime() + (lunarDay - 1) * lunarLengthMs);
    const dayEnd = new Date(dayStart.getTime() + lunarLengthMs);

    const startStr = dayStart.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });
    const endStr = dayEnd.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: tz });

    const msg =
`🌕 <b>${escapeHTML(desc.phase)}</b>
Сегодня <b>${lunarDay}-й лунный день</b> — ${escapeHTML(desc.name)}

📅 <b>Начало:</b> ${startStr}
📅 <b>Окончание:</b> ${endStr}

✨ ${escapeHTML(desc.description)}

💫 <b>Энергия:</b> ${escapeHTML(desc.energy)}
🔖 <b>Символ:</b> ${escapeHTML(desc.symbol)}
💡 <b>Совет:</b> ${escapeHTML(desc.advice)}
`;

    await ctx.replyWithHTML(msg, mainMenu);

  } catch (err) {
    console.error("Ошибка в /moon:", err);
    ctx.reply("Ошибка загрузки данных о Луне 🌙");
  }
}

/* =========================
   Настройки
========================= */

function showSettings(ctx: any) {
  const u = getUserByTelegramId(ctx.from!.id);
  if (!u?.sign) return sendZodiacSelection(ctx);
  ensureUserDefaults(u);

  const tzText = u.timezone || "не выбран";
  const bday = u.birthDate || "не указана";

  const keyboard = [
    [Markup.button.callback("🌍 Часовой пояс", "settings_tz")],
    [Markup.button.callback("⏰ Ежедневное время", "settings_daily")],
    [Markup.button.callback("🪐 Еженедельное время", "settings_weekly")],
    [Markup.button.callback("📅 Изменить дату рождения", "settings_birthdate")],
    [{ text: "💳 Тарифы и оплата", url: "https://docs.google.com/document/d/1Q53-21nSGnMPqVktqlfyrXHEHr9teB2Q1jyk-SGiQAw/edit?usp=sharing" }]
  ];

  ctx.replyWithHTML(
    `⚙️ <b>Текущие настройки</b>\n\n` +
    `🌍 Часовой пояс: <b>${escapeHTML(tzText)}</b>\n` +
    `🌞 Daily: <b>${u.dailyHour}:00</b>\n` +
    `🪐 Weekly: <b>${u.weeklyDow}</b> день, <b>${u.weeklyHour}:00</b>\n` +
    `📅 Дата рождения: <b>${escapeHTML(bday)}</b>`,
    Markup.inlineKeyboard(keyboard)
  );
}

bot.action("settings_tz", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  showTimezoneRegions(ctx);
  } catch (err: any) {
    console.error('❌ Error in settings_tz action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("settings_daily", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
    "⏰ <b>Выбери время ежедневного уведомления</b>",
    Markup.inlineKeyboard([
      [Markup.button.callback("07:00", "daily_7"), Markup.button.callback("09:00", "daily_9")],
      [Markup.button.callback("11:00", "daily_11"), Markup.button.callback("18:00", "daily_18")],
      [Markup.button.callback("⬅️ Назад", "settings_back")],
    ])
  );
  } catch (err: any) {
    console.error('❌ Error in settings_daily action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/daily_(\d+)/, async (ctx) => {
  try {
  const hour = Number(ctx.match[1]);
  const u = getUserByTelegramId(ctx.from!.id);
    if (!u?.sign) {
      await ctx.answerCbQuery();
      sendZodiacSelection(ctx);
      return;
    }
  ensureUserDefaults(u);

  updateUser(ctx.from!.id, { dailyHour: hour });

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(`✅ Установлено: <b>${hour}:00</b>`, mainMenu);
  } catch (err: any) {
    console.error('❌ Error in daily action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("settings_weekly", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.replyWithHTML(
    "🗓 <b>Выбери день и время еженедельного уведомления</b>",
    Markup.inlineKeyboard([
      [Markup.button.callback("Вс 21:00", "weekly_0_21"), Markup.button.callback("Пн 09:00", "weekly_1_9")],
      [Markup.button.callback("Пт 18:00", "weekly_5_18")],
      [Markup.button.callback("⬅️ Назад", "settings_back")],
    ])
  );
  } catch (err: any) {
    console.error('❌ Error in settings_weekly action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("settings_birthdate", async (ctx) => {
  try {
  const uid = ctx.from!.id;
  const u = getUserByTelegramId(uid);

    if (!u) {
      await ctx.answerCbQuery();
      await ctx.reply("Сначала выбери знак 🌟", mainMenu);
      return;
    }

  ensureUserDefaults(u);

  updateUser(uid, { awaitingBirthDate: true });

  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    "📅 <b>Изменение даты рождения</b>\n\n" +
    "Введи дату в формате <b>ДД.ММ.ГГГГ</b>\n" +
    "Например: <code>19.10.1989</code>",
    { parse_mode: "HTML" }
  );
  } catch (err: any) {
    console.error('❌ Error in settings_birthdate action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/weekly_(\d+)_(\d+)/, async (ctx) => {
  try {
  const dow = Number(ctx.match[1]);
  const hour = Number(ctx.match[2]);

  const u = getUserByTelegramId(ctx.from!.id);
    if (!u?.sign) {
      await ctx.answerCbQuery();
      sendZodiacSelection(ctx);
      return;
    }

  ensureUserDefaults(u);

  updateUser(ctx.from!.id, { weeklyDow: dow, weeklyHour: hour });

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(`✅ Установлено: <b>${dow}</b> день, <b>${hour}:00</b>`, mainMenu);
  } catch (err: any) {
    console.error('❌ Error in weekly action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("settings_back", async (ctx) => {
  try {
    await ctx.answerCbQuery();
  showSettings(ctx);
  } catch (err: any) {
    console.error('❌ Error in settings_back action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Задание дня
========================= */

async function sendDailyTask(ctx: any) {
  const u = getUserOrAsk(ctx);
  if (!u) return;
  ensureUserDefaults(u);

  if (!Array.isArray(dailyTasks) || dailyTasks.length === 0) {
    return ctx.reply("Пока заданий нет 💫", mainMenu);
  }

  const taskIndex = u.dailyTaskIndex ?? 0;
  const index = taskIndex % dailyTasks.length;
  const raw = dailyTasks[index];
  const text = typeof raw === "string" ? raw : raw.text;

  const newIndex = (taskIndex + 1) % dailyTasks.length;
  updateUser(u.telegramId, { dailyTaskIndex: newIndex });

  await ctx.replyWithHTML(
    `🎯 <b>Задание дня</b>\n\n${escapeHTML(text)}`,
    mainMenu
  );
}

/* =========================
   Тесты
========================= */

function showTestsMenu(ctx: any) {
  if (!Array.isArray(testsList) || testsList.length === 0) {
    return ctx.reply("Пока нет тестов 💫", mainMenu);
  }

  const buttons = testsList.map((t: any) => [
    Markup.button.callback(t.title, `test_open_${t.id}`)
  ]);

  buttons.push([Markup.button.callback("🏠 Главное меню", "tests_home")]);

  ctx.replyWithHTML(
    "📋 <b>Тесты</b>\n\nВыбери тест:",
    Markup.inlineKeyboard(buttons)
  );
}

bot.action("tests_home", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    await ctx.reply("Главное меню:", mainMenu);
  } catch (err: any) {
    console.error('❌ Error in tests_home action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action("tests_menu", async (ctx) => {
  try {
    await ctx.answerCbQuery();
    showTestsMenu(ctx);
  } catch (err: any) {
    console.error('❌ Error in tests_menu action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/test_open_(.+)/, async (ctx) => {
  try {
    const id = ctx.match[1];
    const test = loadTestById(id);

    if (!test || !Array.isArray(test.questions) || test.questions.length === 0) {
      await ctx.answerCbQuery();
      await ctx.reply("Не удалось загрузить тест.");
      return;
    }

    const total = test.meta?.questions || test.questions.length;

    const intro =
      `<b>${escapeHTML(test.title)}</b>\n\n` +
      `${escapeHTML(test.description || "")}\n\n` +
      `🧭 <b>${total} вопросов</b>\n` +
      `Отвечай честно — нет правильных ответов.`;

    await ctx.answerCbQuery();
    await ctx.replyWithHTML(intro, Markup.inlineKeyboard([
      [Markup.button.callback("▶️ Начать", `test_start_${id}`)],
      [Markup.button.callback("📋 Назад", "tests_menu")],
      [Markup.button.callback("🏠 Меню", "tests_home")]
    ]));
  } catch (err: any) {
    console.error('❌ Error in test_open action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/test_start_(.+)/, async (ctx) => {
  try {
    const id = ctx.match[1];
    const uid = ctx.from!.id;

    let u = getUserByTelegramId(uid);
    if (!u || !u.sign) {
      await ctx.answerCbQuery();
      sendZodiacSelection(ctx);
      return;
    }
    ensureUserDefaults(u);

    const test = loadTestById(id);
    if (!test || !Array.isArray(test.questions)) {
      await ctx.answerCbQuery();
      await ctx.reply("Ошибка загрузки теста.");
      return;
    }

    updateUser(uid, {
      currentTestId: id,
      currentQuestionIndex: 0,
      currentTestScore: 0
    });
    u = getUserByTelegramId(uid)!;

    await ctx.answerCbQuery();
    await sendTestQuestion(ctx, u, test);
  } catch (err: any) {
    console.error('❌ Error in test_start action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

bot.action(/answer_(\d+)_(\d+)/, async (ctx) => {
  try {
    const qIndex = Number(ctx.match[1]);
    const answerNum = Number(ctx.match[2]);
    const uid = ctx.from!.id;

    let u = getUserByTelegramId(uid);
    if (!u || !u.currentTestId) {
      await ctx.answerCbQuery("Тест не найден", { show_alert: true });
      return;
    }
    ensureUserDefaults(u);

    const test = loadTestById(u.currentTestId);
    if (!test) {
      await ctx.answerCbQuery("Ошибка теста", { show_alert: true });
      return;
    }

    if (qIndex !== u.currentQuestionIndex) {
      await ctx.answerCbQuery();
      return;
    }

    const q = test.questions[qIndex];
    const scores: number[] = q.scores || [];
    const score = scores[answerNum - 1] || 0;

    const currentScore = u.currentTestScore ?? 0;
    const currentQuestionIndex = u.currentQuestionIndex ?? 0;
    const newScore = currentScore + score;
    const newQuestionIndex = currentQuestionIndex + 1;
    updateUser(uid, {
      currentTestScore: newScore,
      currentQuestionIndex: newQuestionIndex
    });
    u = getUserByTelegramId(uid)!;

    await ctx.answerCbQuery();

    const updatedQuestionIndex = u.currentQuestionIndex ?? 0;
    if (updatedQuestionIndex >= test.questions.length) {
      const totalScore = u.currentTestScore ?? 0;
      const result = getTestResult(test, totalScore);

      updateUser(uid, {
        currentTestId: null,
        currentQuestionIndex: 0,
        currentTestScore: 0
      });

      let msg =
        `🧾 <b>${escapeHTML(test.title)}</b>\n\n` +
        `Твой результат: <b>${escapeHTML(result.title)}</b>\n\n` +
        `${escapeHTML(result.text || "")}`;

      if (result.advice) {
        msg += `\n\n💡 Рекомендация:\n${escapeHTML(result.advice)}`;
      }

      await ctx.replyWithHTML(msg, Markup.inlineKeyboard([
        [Markup.button.callback("📋 Тесты", "tests_menu")],
        [Markup.button.callback("🏠 Меню", "tests_home")]
      ]));
    } else {
      await sendTestQuestion(ctx, u, test);
    }
  } catch (err: any) {
    console.error('❌ Error in answer action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

function getTestResult(test: any, totalScore: number) {
  if (!Array.isArray(test.results)) {
    return {
      title: "Результат",
      text: "Интерпретация не найдена.",
      advice: ""
    };
  }

  const found = test.results.find(
    (r: any) => totalScore >= r.min && totalScore <= r.max
  );

  return found || test.results[test.results.length - 1];
}

async function sendTestQuestion(ctx: any, user: any, test: any) {
  const index = user.currentQuestionIndex;
  const q = test.questions[index];
  const total = test.meta?.questions || test.questions.length;

  const answersText = q.answers
    .map((a: string, i: number) => `${i + 1}) ${escapeHTML(a)}`)
    .join("\n");

  const msg =
    `📌 <b>Вопрос ${index + 1} из ${total}:</b>\n\n` +
    `${escapeHTML(q.text)}\n\n` +
    answersText;

  await ctx.replyWithHTML(msg, {
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback("1️⃣", `answer_${index}_1`),
        Markup.button.callback("2️⃣", `answer_${index}_2`)
      ],
      [
        Markup.button.callback("3️⃣", `answer_${index}_3`),
        Markup.button.callback("4️⃣", `answer_${index}_4`)
      ]
    ])
  });
}

/* =========================
   Матрица судьбы — типы и расчёты
========================= */

export type MatrixArcans = {
  main: number;
  relations: number;
  money: number;
  purpose: number;
  weak: number;
};

// 🔢 Приводим число к диапазону 1–22
function reduceTo22(num: number): number {
  while (num > 22) {
    num = String(num)
      .split("")
      .reduce((s, d) => s + Number(d), 0);
  }
  if (num === 0) return 22;
  return num;
}

// 📅 Парсим дату рождения "ДД.ММ.ГГГГ"
function parseBirthDate(input: string): { ok: boolean; date?: Date; display?: string } {
  const m = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return { ok: false };

  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);

  if (mm < 1 || mm > 12) return { ok: false };
  if (dd < 1 || dd > 31) return { ok: false };

  const d = new Date(yyyy, mm - 1, dd);

  if (
    d.getFullYear() !== yyyy ||
    d.getMonth() !== mm - 1 ||
    d.getDate() !== dd
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    date: d,
    display: `${m[1]}.${m[2]}.${m[3]}`
  };
}

// 🔮 Расчёт пяти арканов
function calculateMatrixArcans(parsed: { date: Date | undefined }): MatrixArcans {
  if (!parsed.date) {
    throw new Error("calculateMatrixArcans: date is undefined");
  }

  const d = parsed.date;

  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();

  const sum = day + month + year;

  const main = reduceTo22(sum);
  const relations = reduceTo22(main + day);
  const money = reduceTo22(main + month);
  const purpose = reduceTo22(main + year);
  const weak = reduceTo22(main + relations);

  return { main, relations, money, purpose, weak };
}

/* =========================
   Обработка ввода даты рождения (матрица)
========================= */

/* =========================
   Обработка ввода даты рождения (только когда ожидаем)
   ВАЖНО: Этот обработчик НЕ должен перехватывать reply-кнопки меню
========================= */
bot.on("text", async (ctx, next) => {
  try {
    const uid = ctx.from?.id;
    if (!uid) return next();

    const u = getUserByTelegramId(uid);

    // Если НЕ ждём дату рождения — пропускаем дальше (к fallback или другим обработчикам)
    if (!u || !u.awaitingBirthDate) {
      return next();
    }

    // Обрабатываем ввод даты рождения только если awaitingBirthDate = true
    const raw = (ctx.message as any).text.trim();
    const parsed = parseBirthDate(raw);

    if (!parsed.ok) {
      try {
        await ctx.reply(
          "Я не понял дату 😅\n" +
          "Введи формат <b>ДД.ММ.ГГГГ</b>.\n" +
          "Например: 05.03.1992",
          { parse_mode: "HTML" }
        );
      } catch (e) {
        console.error('❌ Error sending date format message:', e);
      }
      return;
    }

    // Сохраняем и считаем
    const arcans = calculateMatrixArcans({ date: parsed.date });
    updateUser(uid, {
      birthDate: parsed.display,
      arcans: arcans,
      awaitingBirthDate: false
    });
    const updatedUser = getUserByTelegramId(uid)!;

    try {
      await ctx.replyWithHTML(
        `✅ Дата рождения сохранена: <b>${escapeHTML(updatedUser.birthDate!)}</b>\n` +
        `Матрица рассчитана.\n\n` +
        `Теперь выбери раздел 👇`,
        mainMenu
      );
    } catch (e) {
      console.error('❌ Error sending birthdate confirmation:', e);
    }

    try {
      showMatrixSections(ctx, updatedUser);
    } catch (e) {
      console.error('❌ Error showing matrix sections:', e);
    }
  } catch (err: any) {
    console.error('❌ Error in birthdate text handler:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Fallback-обработчик для неизвестных текстовых сообщений
   ВАЖНО: Должен быть в самом конце, после всех специфичных обработчиков
========================= */
bot.on("text", async (ctx) => {
  try {
    // Игнорируем команды (они обрабатываются bot.command)
    if ((ctx.message as any).text?.startsWith("/")) {
      return;
    }
    
    // Игнорируем, если ожидаем дату рождения (это обрабатывается выше)
    const uid = ctx.from?.id;
    if (uid) {
      const u = getUserByTelegramId(uid);
      if (u?.awaitingBirthDate) {
        return; // Уже обработано выше
      }
    }
    
    // Для всех остальных текстовых сообщений показываем подсказку
    await ctx.reply("Выбери раздел из меню 👇", mainMenu);
  } catch (err: any) {
    console.error('❌ Error in fallback text handler:', err);
    // Не отвечаем пользователю, чтобы не создавать цикл ошибок
  }
});

/* =========================
   Доменная логика дня/недели
========================= */

// Прогноз на день — фиксируется на календарные сутки
function getDailyText(signEn: string, user: User): string {
  const match = daily.find((r: any) => r.sign === signEn);
  if (!match) return "Нет данных 😔";

  const tz = user.timezone || "Europe/Moscow";
  const today = new Date(new Date().toLocaleString("en-US", { timeZone: tz }))
    .toISOString()
    .slice(0, 10);

  // если уже показывали сегодня — возвращаем сохранённый текст
  if (user.lastDailyDate === today && user.lastDailyText) {
    return user.lastDailyText;
  }

  // иначе берём следующий по индексу
  const dailyIndex = user.dailyIndex ?? 0;
  const textObj = match.texts[dailyIndex % match.texts.length];
  const newIndex = (dailyIndex + 1) % match.texts.length;
  const text = textObj.text || textObj;

  updateUser(user.telegramId, {
    dailyIndex: newIndex,
    lastDailyDate: today,
    lastDailyText: text
  });

  return text;
}

// Прогноз на неделю — фиксируется по неделе
function getWeeklyText(signEn: string, user: User): string {
  const match = weekly.find((r: any) => r.sign === signEn);
  if (!match) return "Нет данных 😔";

  const tz = user.timezone || "Europe/Moscow";
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: tz }));
  const weekId = getWeekId(now);

  if (user.lastWeeklyDate === weekId && user.lastWeeklyText) {
    return user.lastWeeklyText;
  }

  const weeklyIndex = user.weeklyIndex ?? 0;
  const textObj = match.texts[weeklyIndex % match.texts.length];
  const newIndex = (weeklyIndex + 1) % match.texts.length;
  const text = textObj.text || textObj;

  updateUser(user.telegramId, {
    weeklyIndex: newIndex,
    lastWeeklyDate: weekId,
    lastWeeklyText: text
  });

  return text;
}

// вычисляем номер недели ISO
function getWeekId(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);

  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));

  const week =
    1 +
    Math.round(
      ((date.getTime() - firstThursday.getTime()) / 86400000 -
        3 +
        ((firstThursday.getUTCDay() + 6) % 7)) /
        7
    );

  return `${date.getUTCFullYear()}-W${week}`;
}

/* =========================
   Луна — расчёты
========================= */

function getLunarDay(): number {
  const base = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const now = new Date();
  const diff = (now.getTime() - base.getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(diff % 29.53) + 1;
}

function getLunarDayTZ(timezone: string): number {
  const base = new Date(Date.UTC(2000, 0, 6, 18, 14));
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: timezone }));
  const diff = (now.getTime() - base.getTime()) / (1000 * 60 * 60 * 24);
  return Math.floor(diff % 29.53) + 1;
}

function getMoonPhase(day: number): string {
  if (day === 1) return "🌑 Новолуние";
  if (day < 8) return "🌒 Растущая Луна";
  if (day === 8) return "🌓 Первая четверть";
  if (day < 15) return "🌔 Растущая";
  if (day === 15) return "🌕 Полнолуние";
  if (day < 22) return "🌖 Убывающая";
  if (day === 22) return "🌗 Последняя четверть";
  if (day < 29) return "🌘 Стареющая Луна";
  return "🌑 Новолуние";
}

function getEmojiBySign(signRu: string): string {
  const found = zodiacList.find((z) => z.name === signRu);
  return found ? found.emoji : "✨";
}

/* =========================
   Рассылки каждые 10 минут
========================= */

cron.schedule(
  "*/10 * * * *",
  async () => {
    const allUsers = getAllUsers();
    for (const u of allUsers) {
      try {
        if (!u?.sign) continue;
        ensureUserDefaults(u);

        const tz = u.timezone || "Europe/Moscow";
        const local = new Date(
          new Date().toLocaleString("en-US", { timeZone: tz })
        );

        const hour = local.getHours();
        const minute = local.getMinutes();
        const dow = local.getDay();

        // 🌞 Daily
        if (hour === u.dailyHour && minute < 10) {
          try {
            const signEn = zodiacMap[u.sign];
            const text = getDailyText(signEn, u);
            await bot.telegram.sendMessage(
              u.telegramId,
              `🌞 Прогноз на сегодня для ${u.sign}:\n\n${text}`
            );
          } catch (err: any) {
            if (err?.response?.error_code === 403) {
              console.warn(`⚠️ User ${u.telegramId} blocked the bot (daily forecast)`);
              // Продолжаем работу, не ломаем процесс
            } else {
              console.error(`❌ Error sending daily forecast to ${u.telegramId}:`, err?.message || err);
            }
          }
        }

        // 🪐 Weekly
        if (dow === u.weeklyDow && hour === u.weeklyHour && minute < 10) {
          try {
            const signEn = zodiacMap[u.sign];
            const text = getWeeklyText(signEn, u);
            await bot.telegram.sendMessage(
              u.telegramId,
              `🪐 Прогноз на неделю для ${u.sign}:\n\n${text}`
            );
          } catch (err: any) {
            if (err?.response?.error_code === 403) {
              console.warn(`⚠️ User ${u.telegramId} blocked the bot (weekly forecast)`);
              // Продолжаем работу, не ломаем процесс
            } else {
              console.error(`❌ Error sending weekly forecast to ${u.telegramId}:`, err?.message || err);
            }
          }
        }

        // 🌕 Lunar Day Push
        const lunarDay = getLunarDayTZ(tz);
        if (u.lastLunarDay !== lunarDay) {
          const desc: any =
            Array.isArray(moon) &&
            moon.find((d: any) => Number(d.day) === lunarDay);

          if (desc) {
            try {
              await bot.telegram.sendMessage(
                u.telegramId,
                `${desc.phase || getMoonPhase(lunarDay)}\n` +
                  `Сегодня ${lunarDay}-й лунный день — ${desc.name}\n\n` +
                  `Описание: ${desc.description}\n\n` +
                  `Совет: ${desc.advice}`
              );
              updateUser(u.telegramId, { lastLunarDay: lunarDay });
            } catch (err: any) {
              if (err?.response?.error_code === 403) {
                console.warn(`⚠️ User ${u.telegramId} blocked the bot (lunar day)`);
                // Обновляем lastLunarDay, чтобы не повторять попытку
                updateUser(u.telegramId, { lastLunarDay: lunarDay });
              } else {
                console.error(`❌ Error sending lunar day to ${u.telegramId}:`, err?.message || err);
              }
            }
          } else {
            // Если описания нет, всё равно обновляем день
            updateUser(u.telegramId, { lastLunarDay: lunarDay });
          }
        }
      } catch (err) {
        console.error("Ошибка рассылки:", err);
      }
    }
  },
  { timezone: "UTC" }
);

/* =========================
   Помощники
========================= */

function getUserOrAsk(ctx: any): User | null {
  const u = getUserByTelegramId(ctx.from!.id);

  if (!u || !u.sign || !zodiacMap[u.sign]) {
    ctx.reply("Похоже, данных нет. Выбери знак заново:");
    sendZodiacSelection(ctx);
    return null;
  }

  ensureUserDefaults(u);
  return getUserByTelegramId(ctx.from!.id);
}

/* =========================
   Запуск
========================= */
/* =========================
   Онбординг: приветствие + соглашение
========================= */

const welcomeText = [
  "✨ Привет! Я астро-бот.",
  "",
  "Я умею:",
  "• показывать прогноз на сегодня и на неделю;",
  "• подсказывать лунный день и давать рекомендации;",
  "• считать совместимость;",
  "• давать задания дня и тесты.",
  "",
  "📂 Все описания форматов и примеры: https://clck.ru/3QdpS2",
  "",
  "Нажимая «Принять и продолжить», ты подтверждаешь, что понимаешь: бот не заменяет врача, психолога и юридические консультации."
].join("\n");

const zodiacFirstMenu = Markup.keyboard([
  ["♈ Овен", "♉ Телец"],
  ["♊ Близнецы", "♋ Рак"],
  ["♌ Лев", "♍ Дева"],
  ["♎ Весы", "♏ Скорпион"],
  ["♐ Стрелец", "♑ Козерог"],
  ["♒ Водолей", "♓ Рыбы"],
]).resize();

/**
 * Старт: проверяем onboarding статус из БД.
 * Если пользователь уже завершил onboarding — показываем главное меню.
 * Если нет — показываем приветствие или выбор знака.
 * ВАЖНО: telegram_id - единственный идентификатор пользователя, БД - единственный источник истины.
 */
bot.start(async (ctx) => {
  try {
    const telegramId = ctx.from!.id;
    
    // ВАЖНО: Всегда получаем пользователя из БД, не используем session
    let user = getUserByTelegramId(telegramId);
    
    // Если пользователя нет в БД — создаём его
    if (!user) {
      user = createUserIfNotExists(telegramId, {
        onboardingCompleted: false
      });
    }

    // Если пользователь уже завершил onboarding и имеет знак — показываем главное меню
    if (user.onboardingCompleted && user.sign) {
      try {
        await ctx.replyWithHTML(
          "✨ <b>Добро пожаловать обратно!</b>\n\nВыбери раздел:",
          mainMenu
        );
      } catch (e: any) {
        console.error('❌ Error sending welcome back message:', e);
      }
      return;
    }

    // Если пользователь существует, но не завершил onboarding
    if (!user.onboardingCompleted) {
      // Проверяем, есть ли у пользователя знак (старые пользователи из миграции)
      if (user.sign) {
        // У старых пользователей есть знак, но нет флага onboarding — помечаем как завершённый
        updateUser(telegramId, { onboardingCompleted: true });
        try {
          await ctx.replyWithHTML(
            "✨ <b>Добро пожаловать обратно!</b>\n\nВыбери раздел:",
            mainMenu
          );
        } catch (e: any) {
          console.error('❌ Error sending welcome back message:', e);
        }
        return;
      }
      // Если знака нет — показываем приветствие
      try {
        await ctx.reply(
          welcomeText,
          Markup.inlineKeyboard([
            [Markup.button.callback("✅ Принять и продолжить", "accept_terms")],
          ])
        );
      } catch (e: any) {
        console.error('❌ Error sending welcome text:', e);
      }
      return;
    }

    // Если onboarding завершён, но знака нет (не должно быть, но на всякий случай)
    if (user.onboardingCompleted && !user.sign) {
      try {
        await ctx.reply("✨ Выбери свой знак Зодиака:", {
          parse_mode: "HTML",
          ...Markup.inlineKeyboard(
            zodiacList.map((z) => [
              Markup.button.callback(`${z.emoji} ${z.name}`, `zodiac_${z.name.replace(/\s+/g, "_")}`)
            ])
          ),
        });
      } catch (e: any) {
        console.error('❌ Error sending zodiac selection:', e);
      }
      return;
    }

    // Новый пользователь без onboarding — показываем приветствие
    try {
      await ctx.reply(
        welcomeText,
        Markup.inlineKeyboard([
          [Markup.button.callback("✅ Принять и продолжить", "accept_terms")],
        ])
      );
    } catch (e: any) {
      console.error('❌ Error sending welcome text:', e);
    }
  } catch (err: any) {
    console.error('❌ Error in /start command:', err);
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/**
 * Нажатие на «Принять и продолжить»
 * ВАЖНО: Сохраняем в БД, не используем session
 */
bot.action("accept_terms", async (ctx) => {
  try {
    const telegramId = ctx.from!.id;
    
    // ВАЖНО: Создаём или обновляем пользователя в БД
    let user = getUserByTelegramId(telegramId);
    if (!user) {
      user = createUserIfNotExists(telegramId, {
        onboardingCompleted: false
      });
    } else {
      // Обновляем существующего пользователя
      updateUser(telegramId, {
        onboardingCompleted: false
      });
    }

    await ctx.answerCbQuery();
    try {
      await ctx.editMessageText("Отлично, поехали! ✨");
    } catch (e) {
      console.error('❌ Error editing message:', e);
    }

    // Показываем выбор знака через inline keyboard (не reply keyboard)
    try {
      sendZodiacSelection(ctx);
    } catch (e) {
      console.error('❌ Error showing zodiac selection:', e);
    }
  } catch (err: any) {
    console.error('❌ Error in accept_terms action:', err);
    try {
      await ctx.answerCbQuery();
    } catch (e) {}
    try {
      await ctx.reply("Произошла ошибка, попробуй ещё раз");
    } catch (e) {}
  }
});

/* =========================
   Запуск бота (в самом конце, после всех обработчиков)
========================= */

let botStarted = false;

async function startBot() {
  if (botStarted) {
    console.warn("⚠️ Bot already started, ignoring duplicate launch");
    return;
  }
  
  botStarted = true;
  
  try {
    // КРИТИЧНО: Удаляем webhook перед запуском polling
    await bot.telegram.deleteWebhook({ drop_pending_updates: true });
    console.log("🧹 Telegram webhook deleted, pending updates dropped");
    
    // Запускаем бота в режиме polling
    await bot.launch();
    console.log("🤖 Bot started in polling mode");
    console.log("✅ AstroGuide запущен: меню, матрица, тесты, Луна, прогнозы, рассылки!");
  } catch (err) {
    console.error("❌ Ошибка запуска бота:", err);
    botStarted = false;
    throw err;
  }
}

// Корректное завершение
process.once("SIGINT", () => {
  console.log("SIGINT received, stopping bot...");
  bot.stop("SIGINT");
  process.exit(0);
});

process.once("SIGTERM", () => {
  console.log("SIGTERM received, stopping bot...");
  bot.stop("SIGTERM");
  process.exit(0);
});

// Запускаем бота
startBot();
