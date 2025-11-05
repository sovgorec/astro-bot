import { Telegraf, Markup } from "telegraf";
import dotenv from "dotenv";
import { zodiacList } from "./zodiac.js";

dotenv.config();
const bot = new Telegraf(process.env.BOT_TOKEN!);

bot.start((ctx) => {
  const buttons = zodiacList.map((z) => [
    Markup.button.callback(`${z.emoji} ${z.name}`, `zodiac_${z.key}`)
  ]);

  ctx.reply(
    "🌟 Привет! Я астробот.\nВыбери свой знак Зодиака:",
    Markup.inlineKeyboard(buttons)
  );
});

bot.action(/zodiac_(.+)/, async (ctx) => {
  const sign = ctx.match[1];
  await ctx.answerCbQuery();
  await ctx.reply(`Ваш знак — ${sign} 🔮`);
});

bot.launch();
console.log("✅ Astro-bot запущен!");
