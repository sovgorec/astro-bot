import type { Context } from "telegraf";

/**
 * Безопасный ответ на callback query.
 * Гарантирует, что callback всегда закрывается, даже при ошибках.
 * 
 * @param ctx - Telegraf context
 * @param text - Текст ответа (по умолчанию "⏳ Обрабатываю...")
 * @returns Promise, который всегда резолвится
 */
export async function safeAnswerCallback(
  ctx: Context,
  text: string = "⏳ Обрабатываю..."
): Promise<void> {
  try {
    // Проверяем, что это действительно callback query
    if (!ctx.callbackQuery) {
      return;
    }

    // Проверяем, что callback ещё не протух
    // Если callback слишком старый, Telegram вернёт ошибку
    if (ctx.callbackQuery && 'date' in ctx.callbackQuery && typeof ctx.callbackQuery.date === 'number') {
      const now = Date.now() / 1000; // Unix timestamp в секундах
      const callbackDate = ctx.callbackQuery.date;
      const ageSeconds = now - callbackDate;
      
      // Telegram требует ответ в течение ~60 секунд
      // Если callback старше 55 секунд - не пытаемся отвечать
      if (ageSeconds > 55) {
        console.warn(`[CB] ⚠️ Callback too old (${Math.round(ageSeconds)}s), skipping answer`);
        return;
      }
    }

    await ctx.answerCbQuery(text);
  } catch (e: any) {
    // Игнорируем ошибки "query is too old" и другие сетевые проблемы
    const errorMessage = e?.message || String(e);
    if (errorMessage.includes("query is too old") || 
        errorMessage.includes("QUERY_ID_INVALID") ||
        errorMessage.includes("Bad Request: query is too old")) {
      console.warn(`[CB] ⚠️ Callback expired, skipping answer`);
      return;
    }
    console.error(`[ERR] ❌ answerCbQuery failed:`, errorMessage);
  }
}

/**
 * Безопасная отправка сообщения через Telegram API.
 * При ошибке отправки пытается отправить fallback-сообщение пользователю.
 * 
 * @param ctx - Telegraf context
 * @param sendFn - Функция отправки (например, () => ctx.reply("..."))
 * @param fallbackText - Текст fallback-сообщения при ошибке
 * @returns Promise, который всегда резолвится
 */
export async function safeSend(
  ctx: Context,
  sendFn: () => Promise<any>,
  fallbackText: string = "⚠️ Не удалось отправить сообщение. Попробуйте ещё раз."
): Promise<void> {
  try {
    await sendFn();
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    const errorCode = e?.response?.error_code;
    
    // Логируем ошибку с контекстом
    console.error(`[ERR] ❌ Telegram send failed:`, {
      error: errorMessage,
      code: errorCode,
      userId: ctx.from?.id,
      chatId: ctx.chat?.id
    });

    // Игнорируем ошибки блокировки бота пользователем
    if (errorCode === 403 || errorMessage.includes("bot was blocked")) {
      console.warn(`[ERR] ⚠️ Bot blocked by user ${ctx.from?.id}`);
      return; // Не пытаемся отправлять fallback при блокировке
    }

    // Игнорируем ошибки удалённых чатов
    if (errorCode === 400 && errorMessage.includes("chat not found")) {
      console.warn(`[ERR] ⚠️ Chat not found for user ${ctx.from?.id}`);
      return;
    }

    // Игнорируем ошибки сетевых таймаутов - они уже произошли
    if (errorMessage.includes("timeout") || 
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("ETIMEDOUT")) {
      console.warn(`[ERR] ⚠️ Network timeout, skipping fallback to avoid cascade`);
      return;
    }

    // Для остальных ошибок пытаемся отправить fallback
    try {
      // Если это callback query, отвечаем через answerCbQuery
      if (ctx.callbackQuery) {
        await safeAnswerCallback(ctx, "⚠️ Ошибка отправки");
      } else {
        // Если это обычное сообщение, пытаемся отправить fallback
        // Используем setTimeout, чтобы избежать повторного таймаута
        setTimeout(async () => {
          try {
            await ctx.reply(fallbackText);
          } catch (fallbackError) {
            console.error(`[ERR] ❌ Fallback send also failed:`, fallbackError);
          }
        }, 100);
      }
    } catch (fallbackError) {
      console.error(`[ERR] ❌ Fallback send failed:`, fallbackError);
    }
  }
}

/**
 * Безопасное редактирование сообщения.
 * Используется для редактирования сообщений с inline-кнопками.
 * 
 * @param ctx - Telegraf context
 * @param editFn - Функция редактирования (например, () => ctx.editMessageText("..."))
 * @returns Promise, который всегда резолвится
 */
export async function safeEdit(
  ctx: Context,
  editFn: () => Promise<any>
): Promise<void> {
  try {
    await editFn();
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    
    // Игнорируем ошибки "message not modified" и "message to edit not found"
    if (errorMessage.includes("message is not modified") ||
        errorMessage.includes("message to edit not found") ||
        errorMessage.includes("MESSAGE_NOT_MODIFIED")) {
      console.warn(`[ERR] ⚠️ Message edit skipped: ${errorMessage}`);
      return;
    }

    console.error(`[ERR] ❌ Telegram edit failed:`, errorMessage);
  }
}

/**
 * Безопасное удаление reply markup (inline keyboard).
 * Используется для скрытия кнопок после нажатия.
 * 
 * @param ctx - Telegraf context
 * @returns Promise, который всегда резолвится
 */
export async function safeRemoveKeyboard(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup(undefined);
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    
    // Игнорируем ошибки "message not modified" и "message to edit not found"
    if (errorMessage.includes("message is not modified") ||
        errorMessage.includes("message to edit not found") ||
        errorMessage.includes("MESSAGE_NOT_MODIFIED")) {
      // Это нормально, игнорируем
      return;
    }

    console.warn(`[ERR] ⚠️ Remove keyboard failed:`, errorMessage);
  }
}

/**
 * Безопасная отправка сообщения через bot.telegram.sendMessage (для cron и других случаев без ctx).
 * Используется для рассылок и уведомлений.
 * 
 * @param telegramId - ID пользователя Telegram
 * @param text - Текст сообщения
 * @param bot - Экземпляр Telegraf бота
 * @returns Promise, который всегда резолвится
 */
export async function safeSendMessage(
  telegramId: number,
  text: string,
  bot: any
): Promise<void> {
  try {
    await bot.telegram.sendMessage(telegramId, text);
  } catch (e: any) {
    const errorMessage = e?.message || String(e);
    const errorCode = e?.response?.error_code;

    // Игнорируем ошибки блокировки бота пользователем
    if (errorCode === 403 || errorMessage.includes("bot was blocked")) {
      console.warn(`[ERR] ⚠️ Bot blocked by user ${telegramId}`);
      return;
    }

    // Игнорируем ошибки удалённых чатов
    if (errorCode === 400 && errorMessage.includes("chat not found")) {
      console.warn(`[ERR] ⚠️ Chat not found for user ${telegramId}`);
      return;
    }

    // Игнорируем ошибки сетевых таймаутов
    if (errorMessage.includes("timeout") ||
        errorMessage.includes("ECONNRESET") ||
        errorMessage.includes("ETIMEDOUT")) {
      console.warn(`[ERR] ⚠️ Network timeout sending to ${telegramId}`);
      return;
    }

    // Логируем остальные ошибки
    console.error(`[ERR] ❌ Telegram sendMessage failed:`, {
      error: errorMessage,
      code: errorCode,
      userId: telegramId
    });
  }
}

