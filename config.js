// ===================== НАЛАШТУВАННЯ АУКЦІОНУ =====================
// Інструкція з підключення — у файлі README.md у цій самій папці.

export const CONFIG = {
  // 1) Вставте сюди налаштування з Firebase Console → Project settings → Your apps → Web app.
  //    Поки тут порожньо, сайт показує повідомлення «Аукціон ще не налаштовано».
const firebaseConfig = {
  apiKey: "AIzaSyDAdovrquPpYRHXLE1jlSGQt1YDyRMf39M",
  authDomain: "ostauction.firebaseapp.com",
  projectId: "ostauction",
  storageBucket: "ostauction.firebasestorage.app",
  messagingSenderId: "188801239244",
  appId: "1:188801239244:web:c128d191e2d91866121a69"
};

  // 2) Пошта адміністратора (та сама, що у firestore.rules). Під нею ви входите на admin.html.
  adminEmails: ["ostolosh@gmail.com "],

  // Хто проводить аукціон (показується над заголовком). Можна залишити порожнім.
  brand: "",

  // Назва та короткий опис на головній сторінці аукціону
  title: "Аукціон",
  subtitle: "Ставки приймаються онлайн. Перемагає найвища ставка на момент завершення таймера.",

  // Телефон організатора для питань
  contactPhone: "+380673705263",

  currency: "₴",

  // Пауза між ставками одного учасника, секунди (має збігатися з firestore.rules → cooldown)
  bidCooldownSec: 10,

  // Значення за замовчуванням для нового лота (адміністратор може змінити для кожного лота)
  defaults: {
    minStep: 50,         // мінімальне підвищення
    maxStepMultiplier: 10, // максимальне підвищення за раз = мінімальний крок × це число
    antiSnipeMin: 2,     // ставка в останні N хвилин подовжує лот до N хвилин
  },
};
