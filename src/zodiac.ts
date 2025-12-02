// src/zodiac.ts

export const zodiacList = [
  { key: "♈ Овен", name: "Овен", emoji: "♈" },
  { key: "♉ Телец", name: "Телец", emoji: "♉" },
  { key: "♊ Близнецы", name: "Близнецы", emoji: "♊" },
  { key: "♋ Рак", name: "Рак", emoji: "♋" },
  { key: "♌ Лев", name: "Лев", emoji: "♌" },
  { key: "♍ Дева", name: "Дева", emoji: "♍" },
  { key: "♎ Весы", name: "Весы", emoji: "♎" },
  { key: "♏ Скорпион", name: "Скорпион", emoji: "♏" },
  { key: "♐ Стрелец", name: "Стрелец", emoji: "♐" },
  { key: "♑ Козерог", name: "Козерог", emoji: "♑" },
  { key: "♒ Водолей", name: "Водолей", emoji: "♒" },
  { key: "♓ Рыбы", name: "Рыбы", emoji: "♓" }
];

// Маппинг для сопоставления русских и английских названий
export const zodiacMap: Record<string, string> = {
  "Овен": "aries",
  "Телец": "taurus",
  "Близнецы": "gemini",
  "Рак": "cancer",
  "Лев": "leo",
  "Дева": "virgo",
  "Весы": "libra",
  "Скорпион": "scorpio",
  "Стрелец": "sagittarius",
  "Козерог": "capricorn",
  "Водолей": "aquarius",
  "Рыбы": "pisces"
};
