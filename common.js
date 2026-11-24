// Спільні частини для сторінки аукціону та адмін-панелі.
import { CONFIG } from "./config.js";

const FB = "https://www.gstatic.com/firebasejs/13.4.0/";

export const configured = Boolean(CONFIG.firebase.apiKey && CONFIG.firebase.projectId);

export let fb = null; // { app, auth, db, fs: firestore module, au: auth module }

export async function initFirebase() {
  if (!configured) return null;
  const [appMod, au, fs] = await Promise.all([
    import(FB + "firebase-app.js"),
    import(FB + "firebase-auth.js"),
    import(FB + "firebase-firestore.js"),
  ]);
  const app = appMod.initializeApp(CONFIG.firebase);
  const auth = au.getAuth(app);
  const db = fs.getFirestore(app);
  if (window.__AUCTION_EMULATOR__) {
    au.connectAuthEmulator(auth, window.__AUCTION_EMULATOR__.auth, { disableWarnings: true });
    fs.connectFirestoreEmulator(db, "127.0.0.1", window.__AUCTION_EMULATOR__.firestore);
  }
  fb = { app, auth, db, fs, au };
  return fb;
}

// ---------- Час сервера ----------
// Таймери рахуються від часу сервера, а не від годинника на телефоні учасника.
let clockOffset = 0;
export const now = () => Date.now() + clockOffset;
export async function syncClock() {
  try {
    const t0 = Date.now();
    const r = await fetch(location.href.split("#")[0], { method: "HEAD", cache: "no-store" });
    const d = Date.parse(r.headers.get("date") || "");
    if (!Number.isNaN(d)) clockOffset = d + 500 - (t0 + Date.now()) / 2;
    if (Math.abs(clockOffset) < 1500) clockOffset = 0;
  } catch { /* лишаємо годинник пристрою */ }
}

// ---------- Форматування ----------
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const nf = new Intl.NumberFormat("uk-UA");
export const money = (n) => `${nf.format(n)} ${CONFIG.currency}`;

export const ms = (ts) => (ts && typeof ts.toMillis === "function" ? ts.toMillis() : ts ? +ts : 0);

export function fmtLeft(msLeft) {
  if (msLeft <= 0) return "завершено";
  const s = Math.floor(msLeft / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (x) => String(x).padStart(2, "0");
  if (d > 0) return `${d} д ${p(h)}:${p(m)}:${p(sec)}`;
  return `${p(h)}:${p(m)}:${p(sec)}`;
}

const dtf = new Intl.DateTimeFormat("uk-UA", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Kyiv" });
export const fmtDate = (t) => dtf.format(new Date(t));
const tf = new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "Europe/Kyiv" });
export const fmtTime = (t) => tf.format(new Date(t));

// ---------- Телефон ----------
// Приймає 0961234567, 380961234567, +38 (096) 123-45-67 тощо. Повертає +380961234567 або "".
export function normalizePhone(raw) {
  let d = String(raw || "").replace(/[^\d+]/g, "");
  const plus = d.startsWith("+");
  d = d.replace(/\D/g, "");
  if (!plus) {
    if (/^0\d{9}$/.test(d)) d = "38" + d;
    else if (/^80\d{9}$/.test(d)) d = "3" + d;
  }
  if (/^380\d{9}$/.test(d)) return "+" + d;
  if (plus && /^\d{10,15}$/.test(d)) return "+" + d;
  return "";
}
export const prettyPhone = (p) => {
  const m = /^\+380(\d{2})(\d{3})(\d{2})(\d{2})$/.exec(p || "");
  return m ? `+380 ${m[1]} ${m[2]} ${m[3]} ${m[4]}` : p || "";
};
export const maskedBidder = (name, tail) => `${name} · ••${tail || ""}`;

// ---------- Лот ----------
export function lotState(lot) {
  const left = ms(lot.endsAt) - now();
  if (left <= 0) return { key: "ended", label: "Завершено", left };
  if (left < 10 * 60 * 1000) return { key: "soon", label: "Скоро завершення", left };
  return { key: "live", label: "Триває", left };
}

// Мінімальна і максимальна можлива ставка зараз
export function bidRange(lot) {
  const hasLeader = Boolean(lot.leaderUid);
  const min = hasLeader ? lot.currentPrice + lot.minStep : lot.startPrice;
  const max = (hasLeader ? lot.currentPrice : lot.startPrice) + lot.maxStep;
  return { min, max, hasLeader };
}
