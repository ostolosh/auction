import { CONFIG } from "./config.js";
import {
  configured, initFirebase, syncClock, now, esc, money, ms, fmtLeft, fmtDate, fmtTime,
  normalizePhone, maskedBidder, lotState, bidRange,
} from "./common.js";

const $ = (s) => document.querySelector(s);
const state = {
  fb: null,
  uid: null,
  me: undefined,      // профіль учасника: undefined — ще завантажується, null — не зареєстрований
  lots: new Map(),
  lotsLoaded: false,
  openId: null,
  bids: [],
  media: new Map(),   // lotId -> [фото]
  photoIdx: 0,
  unsubBids: null,
  busy: false,
  pending: null,      // ставка, яку робитимемо одразу після реєстрації
};

// ---------- Тексти ----------
$("#title").textContent = CONFIG.title;
document.title = CONFIG.brand ? `${CONFIG.title} — ${CONFIG.brand}` : CONFIG.title;
$("#brand").textContent = CONFIG.brand || "Онлайн-аукціон";
$("#subtitle").textContent = CONFIG.subtitle;
const cd = CONFIG.bidCooldownSec;
$("#rulesList").innerHTML = [
  "Щоб робити ставки, вкажіть ім'я та номер телефону. Їх бачить лише організатор.",
  "Кожна наступна ставка має бути більшою за попередню щонайменше на мінімальний крок лота.",
  "Підняти ціну одразу занадто високо не можна: для кожного лота є максимальне підвищення за одну ставку.",
  "Не можна перебивати власну ставку, поки вона лідирує.",
  `Між вашими ставками має минути щонайменше ${cd} с.`,
  "Якщо ставку зроблено в останні хвилини, час лота подовжується, щоб інші учасники встигли відповісти.",
  "Ставку не можна скасувати. Перемагає найвища ставка на момент завершення таймера, і саме за цим учасником лот залишається.",
  "Організатор телефонує переможцю для підтвердження. Якщо номер вигаданий або учасник відмовляється, ставку анулюють, і лот переходить до попереднього учасника.",
].map((t) => `<li>${esc(t)}</li>`).join("");
$("#footer").innerHTML = `Питання щодо аукціону: <a href="tel:${esc(CONFIG.contactPhone.replace(/[^\d+]/g, ""))}">${esc(CONFIG.contactPhone)}</a>`;

function notice(html, err = false) {
  const n = $("#notice");
  n.innerHTML = html;
  n.classList.toggle("err", err);
  n.hidden = !html;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4000);
}

// ---------- Список лотів ----------
function visibleLots() {
  return [...state.lots.values()]
    .filter((l) => !l.hidden)
    .sort((a, b) => {
      const ea = lotState(a).key === "ended", eb = lotState(b).key === "ended";
      if (ea !== eb) return ea ? 1 : -1;
      return ea ? ms(b.endsAt) - ms(a.endsAt) : ms(a.endsAt) - ms(b.endsAt);
    });
}

function renderGrid() {
  const g = $("#grid");
  if (!state.lotsLoaded) { g.innerHTML = `<div class="empty">Завантаження…</div>`; return; }
  const lots = visibleLots();
  if (!lots.length) { g.innerHTML = `<div class="empty">Лотів поки немає. Загляньте трохи пізніше.</div>`; return; }
  g.innerHTML = lots.map((l) => {
    const st = lotState(l);
    const img = l.cover ? `<img src="${esc(l.cover)}" alt="" loading="lazy">` : `<div class="noimg">Без фото</div>`;
    const priceLabel = st.key === "ended" ? (l.leaderUid ? "Продано за" : "Без ставок") : (l.leaderUid ? "Поточна ставка" : "Стартова ціна");
    return `<a class="card" href="#lot=${encodeURIComponent(l.id)}">
      <div class="thumb">${img}<span class="badge ${st.key}" data-badge="${esc(l.id)}">${st.label}</span></div>
      <div class="card-body">
        <h2 class="card-title">${esc(l.title)}</h2>
        <div class="card-row">
          <div><div class="k">${priceLabel}</div><div class="price">${money(l.leaderUid ? l.currentPrice : l.startPrice)}</div></div>
          <div style="text-align:right"><div class="k">${st.key === "ended" ? "Завершено" : "До кінця"}</div>
            <div class="timer ${st.key}" data-ends="${ms(l.endsAt)}">${st.key === "ended" ? fmtDate(ms(l.endsAt)) : fmtLeft(st.left)}</div></div>
        </div>
        <div class="k">${l.bidCount ? `Ставок: ${l.bidCount}` : "Ставок ще немає"}</div>
      </div>
    </a>`;
  }).join("");
}

// ---------- Сторінка лота ----------
function route() {
  const m = /^#lot=(.+)$/.exec(location.hash);
  const id = m ? decodeURIComponent(m[1]) : null;
  if (id !== state.openId) {
    state.openId = id;
    state.photoIdx = 0;
    state.bids = [];
    if (state.unsubBids) { state.unsubBids(); state.unsubBids = null; }
    if (id && state.fb) subscribeBids(id);
    if (id && state.fb) loadMedia(id);
    window.scrollTo(0, 0);
  }
  $("#listView").hidden = Boolean(id);
  $("#lotView").hidden = !id;
  render();
}

function render() {
  if (!state.openId) { renderGrid(); return; }
  const lot = state.lots.get(state.openId);
  if (!lot || lot.hidden) {
    if (state.lotsLoaded) { $("#panel").innerHTML = `<p>Лот не знайдено.</p>`; $("#galleryMain").innerHTML = ""; $("#galleryThumbs").innerHTML = ""; $("#lotDesc").hidden = true; }
    return;
  }
  renderGallery(lot);
  const d = $("#lotDesc");
  d.hidden = !lot.description;
  d.innerHTML = `<h2>Опис</h2>${esc(lot.description || "")}`;
  renderPanel(lot);
}

function renderGallery(lot) {
  const photos = state.media.get(lot.id) || (lot.cover ? [lot.cover] : []);
  const i = Math.min(state.photoIdx, Math.max(photos.length - 1, 0));
  $("#galleryMain").innerHTML = photos.length ? `<img src="${esc(photos[i])}" alt="${esc(lot.title)}">` : `<span class="k">Без фото</span>`;
  $("#galleryThumbs").hidden = photos.length < 2;
  $("#galleryThumbs").innerHTML = photos.map((p, k) => `<button type="button" data-photo="${k}" aria-current="${k === i}" aria-label="Фото ${k + 1}"><img src="${esc(p)}" alt=""></button>`).join("");
}

function cooldownLeft() {
  const last = ms(state.me?.lastBidAt);
  return last ? Math.max(0, last + cd * 1000 - now()) : 0;
}

function renderPanel(lot) {
  const st = lotState(lot);
  const { min, max, hasLeader } = bidRange(lot);
  const iLead = hasLeader && lot.leaderUid === state.uid;
  const ended = st.key === "ended";

  let status = "";
  let controls = "";
  if (ended) {
    if (!hasLeader) status = `<div class="state info">Аукціон за цим лотом завершено. Ставок не було.</div>`;
    else if (iLead) status = `<div class="state ok">Вітаємо! Ви виграли цей лот за ${money(lot.currentPrice)}. Організатор зателефонує вам найближчим часом.</div>`;
    else status = `<div class="state info">Аукціон завершено. Переможець: <b>${esc(maskedBidder(lot.leaderName, lot.leaderPhoneTail))}</b> — ${money(lot.currentPrice)}.</div>`;
  } else if (!state.fb) {
    controls = "";
  } else if (state.me === undefined) {
    controls = `<p class="hint">Завантаження…</p>`;
  } else if (state.me && state.me.blocked) {
    status = `<div class="state warn">Вашу участь в аукціоні призупинено організатором. Зателефонуйте: ${esc(CONFIG.contactPhone)}.</div>`;
  } else {
    if (iLead) status = `<div class="state ok">Ваша ставка лідирує. Якщо її переб'ють, тут з'явиться повідомлення.</div>`;
    else if (state.me && state.bids.some((b) => b.uid === state.uid && !b.cancelled)) status = `<div class="state warn">Вашу ставку перебили. Можете підняти ціну.</div>`;

    if (iLead) {
      controls = state.me ? `<div class="me-box"><span>Ви берете участь як <b>${esc(state.me.name)}</b></span></div>` : "";
    } else {
    const quick = [];
    const steps = hasLeader ? [1, 2, 5] : [0, 1, 3];
    for (const k of steps) {
      const amt = (hasLeader ? lot.currentPrice : lot.startPrice) + k * lot.minStep;
      if (amt >= min && amt <= max && !quick.includes(amt)) quick.push(amt);
    }
    const cdl = cooldownLeft();
    const dis = iLead || state.busy || cdl > 0 ? "disabled" : "";
    controls = `
      <div class="quick">${quick.map((a) => `<button class="btn ${a === min ? "primary" : ""}" type="button" data-bid="${a}" ${dis}>${money(a)}<small>${a === lot.startPrice && !hasLeader ? "старт" : "+" + money(a - (hasLeader ? lot.currentPrice : lot.startPrice))}</small></button>`).join("")}</div>
      <form class="field" id="customBid">
        <label for="customAmt">Своя сума</label>
        <div class="row">
          <input class="input" id="customAmt" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" placeholder="від ${min} до ${max}" ${dis}>
          <button class="btn dark" type="submit" ${dis}>Поставити</button>
        </div>
        <span class="hint">Мінімум ${money(min)}, максимум ${money(max)} за одну ставку.${cdl > 0 ? ` Наступна ставка через <span data-cooldown>${Math.ceil(cdl / 1000)}</span> с.` : ""}</span>
      </form>
      ${state.me
        ? `<div class="me-box"><span>Ви берете участь як <b>${esc(state.me.name)}</b></span>${state.me.lastBidAt ? "" : `<a href="#" data-edit-me>Змінити дані</a>`}</div>`
        : `<p class="hint" style="margin:0">Перед першою ставкою потрібно вказати ім'я та телефон.</p>`}
    `;
    }
  }

  const leaderLine = hasLeader
    ? `<div class="leader">Лідирує: <b>${esc(maskedBidder(lot.leaderName, lot.leaderPhoneTail))}</b>${iLead ? " (ви)" : ""}</div>`
    : `<div class="leader">Ставок ще немає — будьте першим.</div>`;

  const history = state.bids.length ? `
    <div class="history"><h2>Історія ставок</h2><ol>${state.bids.map((b) => `
      <li class="${b.cancelled ? "cancelled" : ""} ${b.uid === state.uid ? "me" : ""}">
        <b>${esc(maskedBidder(b.name, b.phoneTail))}</b><span class="amt">${money(b.amount)}</span>
        <span class="when">${b.createdAt ? fmtTime(ms(b.createdAt)) : ""}${b.cancelled ? " · анульовано" : ""}</span>
      </li>`).join("")}</ol></div>` : "";

  // Зберігаємо введену суму, щоб таймер не стирав її
  const prevAmt = $("#customAmt")?.value;
  $("#panel").innerHTML = `
    <h1>${esc(lot.title)}</h1>
    <div class="stats">
      <div class="stat"><span class="k">${ended ? (hasLeader ? "Фінальна ціна" : "Стартова ціна") : hasLeader ? "Поточна ставка" : "Стартова ціна"}</span><span class="price">${money(hasLeader ? lot.currentPrice : lot.startPrice)}</span></div>
      <div class="stat"><span class="k">${ended ? "Завершено" : "До завершення"}</span><span class="timer ${st.key}" data-ends="${ms(lot.endsAt)}">${ended ? "—" : fmtLeft(st.left)}</span></div>
      <div class="stat wide"><span class="k">Старт ${money(lot.startPrice)} · крок від ${money(lot.minStep)} · ${ended ? "завершився" : "завершення"} ${fmtDate(ms(lot.endsAt))}${lot.antiSnipeSec && !ended ? ` · ставка в останні ${Math.round(lot.antiSnipeSec / 60)} хв подовжує час` : ""}</span></div>
    </div>
    ${leaderLine}
    ${status}
    ${controls}
    ${history}
  `;
  if (prevAmt && $("#customAmt")) $("#customAmt").value = prevAmt;
}

// ---------- Таймер ----------
const lastKey = new Map();
function tick() {
  let needRender = false;
  document.querySelectorAll("[data-ends]").forEach((el) => {
    const left = +el.dataset.ends - now();
    if (left > 0) el.textContent = fmtLeft(left);
    el.classList.toggle("soon", left > 0 && left < 10 * 60 * 1000);
  });
  for (const l of state.lots.values()) {
    const k = lotState(l).key;
    if (lastKey.has(l.id) && lastKey.get(l.id) !== k) needRender = true;
    lastKey.set(l.id, k);
  }
  const cdEl = document.querySelector("[data-cooldown]");
  if (cdEl) {
    const left = cooldownLeft();
    if (left <= 0) needRender = true; else cdEl.textContent = Math.ceil(left / 1000);
  }
  if (needRender) render();
}

// ---------- Firebase ----------
function subscribeBids(lotId) {
  const { fs, db } = state.fb;
  const q = fs.query(fs.collection(db, "lots", lotId, "bids"), fs.orderBy("amount", "desc"), fs.limit(100));
  state.unsubBids = fs.onSnapshot(q, (snap) => {
    state.bids = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (+b.id) - (+a.id));
    render();
  }, (e) => console.error(e));
}

async function loadMedia(lotId) {
  if (state.media.has(lotId)) return;
  const { fs, db } = state.fb;
  try {
    const s = await fs.getDoc(fs.doc(db, "lotMedia", lotId));
    if (s.exists() && Array.isArray(s.data().photos) && s.data().photos.length) {
      state.media.set(lotId, s.data().photos);
      if (state.openId === lotId) render();
    }
  } catch (e) { console.error(e); }
}

async function placeBid(lot, amount) {
  const { fs, db } = state.fb;
  const lotRef = fs.doc(db, "lots", lot.id);
  const meRef = fs.doc(db, "bidders", state.uid);
  state.busy = true; render();
  try {
    await fs.runTransaction(db, async (tx) => {
      const [ls, msnap] = await Promise.all([tx.get(lotRef), tx.get(meRef)]);
      if (!ls.exists()) throw new UserError("Лот не знайдено.");
      if (!msnap.exists()) throw new UserError("Спершу зареєструйтесь.");
      const L = ls.data(), me = msnap.data();
      if (me.blocked) throw new UserError("Вашу участь призупинено організатором.");
      const end = ms(L.endsAt);
      if (end <= now()) throw new UserError("Час для ставок за цим лотом вичерпано.");
      if (L.leaderUid === state.uid) throw new UserError("Ваша ставка вже лідирує.");
      const r = bidRange(L);
      if (amount < r.min) throw new UserError(`Ціна вже змінилась. Мінімальна ставка зараз ${money(r.min)}.`);
      if (amount > r.max) throw new UserError(`Максимальна ставка зараз ${money(r.max)}.`);
      const last = ms(me.lastBidAt);
      if (last && now() - last < cd * 1000) throw new UserError(`Зачекайте ${Math.ceil((last + cd * 1000 - now()) / 1000)} с перед наступною ставкою.`);

      const seq = (L.bidCount || 0) + 1;
      let endsAt = L.endsAt;
      const snipe = (L.antiSnipeSec || 0) * 1000;
      if (snipe && end - now() < snipe) endsAt = fs.Timestamp.fromMillis(Math.max(end + 1000, now() + snipe));

      tx.update(lotRef, {
        currentPrice: amount, bidCount: seq, leaderUid: state.uid, leaderName: me.name,
        leaderPhoneTail: me.phoneTail, lastBidAt: fs.serverTimestamp(), endsAt,
      });
      tx.set(fs.doc(db, "lots", lot.id, "bids", String(seq)), {
        uid: state.uid, name: me.name, phoneTail: me.phoneTail, amount,
        createdAt: fs.serverTimestamp(), cancelled: false,
      });
      tx.update(meRef, { lastBidAt: fs.serverTimestamp() });
    });
    toast(`Ставку ${money(amount)} прийнято!`);
  } catch (e) {
    console.error(e);
    if (e instanceof UserError) toast(e.message);
    else if (e?.code === "permission-denied") toast("Ставку не прийнято: ціна або час уже змінились. Перевірте суму і спробуйте ще раз.");
    else if (e?.code === "unavailable" || e?.code === "failed-precondition") toast("Немає зв'язку із сервером. Перевірте інтернет і спробуйте ще раз.");
    else toast("Не вдалося зробити ставку. Спробуйте ще раз.");
  } finally {
    state.busy = false; render();
  }
}
class UserError extends Error {}

// ---------- Дії користувача ----------
document.addEventListener("click", (e) => {
  const ph = e.target.closest("[data-photo]");
  if (ph) { state.photoIdx = +ph.dataset.photo; render(); return; }
  const b = e.target.closest("[data-bid]");
  if (b) { askBid(+b.dataset.bid); return; }
  if (e.target.closest("[data-edit-me]")) { e.preventDefault(); openReg(); return; }
  if (e.target.closest("[data-close]")) { e.target.closest("dialog").close(); }
});
document.addEventListener("submit", (e) => {
  if (e.target.id !== "customBid") return;
  e.preventDefault();
  const v = Math.round(Number($("#customAmt").value));
  const lot = state.lots.get(state.openId);
  if (!lot || !v) return;
  const { min, max } = bidRange(lot);
  if (v < min || v > max) { toast(`Сума має бути від ${money(min)} до ${money(max)}.`); return; }
  askBid(v);
});
$("#backBtn").addEventListener("click", () => { location.hash = ""; });

function askBid(amount) {
  const lot = state.lots.get(state.openId);
  if (!lot) return;
  if (!state.me) { state.pending = amount; openReg(); return; }
  $("#bidLotName").textContent = lot.title;
  $("#bidAmount").textContent = money(amount);
  const dlg = $("#bidDlg");
  dlg.returnValue = "";
  dlg.onclose = () => { if (dlg.returnValue === "ok") placeBid(lot, amount); };
  dlg.showModal();
}

function openReg() {
  $("#regName").value = state.me?.name || "";
  $("#regPhone").value = state.me?.phone || "";
  $("#regAgree").checked = Boolean(state.me);
  $("#regErr").hidden = true;
  $("#regDlg").showModal();
}

$("#regForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#regName").value.trim().replace(/\s+/g, " ");
  const phone = normalizePhone($("#regPhone").value);
  const err = (m) => { $("#regErr").textContent = m; $("#regErr").hidden = false; };
  if (name.length < 2) return err("Вкажіть ім'я та прізвище.");
  if (!phone) return err("Вкажіть правильний номер телефону, наприклад 096 123 45 67.");
  if (!$("#regAgree").checked) return err("Потрібно погодитись з умовами.");
  const { fs, db } = state.fb;
  const ref = fs.doc(db, "bidders", state.uid);
  $("#regSubmit").disabled = true;
  try {
    const data = { name, phone, phoneTail: phone.slice(-2) };
    if (state.me) await fs.updateDoc(ref, data);
    else await fs.setDoc(ref, { ...data, createdAt: fs.serverTimestamp(), lastBidAt: null });
    state.me = { ...(state.me || {}), ...data, lastBidAt: state.me?.lastBidAt ?? null };
    $("#regDlg").close();
    toast("Дані збережено.");
    if (state.pending) { const a = state.pending; state.pending = null; askBid(a); }
  } catch (ex) {
    console.error(ex);
    err("Не вдалося зберегти. Перевірте інтернет і спробуйте ще раз.");
  } finally {
    $("#regSubmit").disabled = false;
  }
});
$("#regDlg").addEventListener("close", () => { if (!state.me) state.pending = null; });

// ---------- Старт ----------
window.addEventListener("hashchange", route);
setInterval(tick, 1000);
route();

(async () => {
  if (!configured) {
    state.lotsLoaded = true;
    notice("Аукціон ще не налаштовано. Адміністратору: заповніть <code>auction/config.js</code> за інструкцією в <code>auction/README.md</code>.", true);
    render();
    return;
  }
  try {
    await syncClock();
    const fb = await initFirebase();
    state.fb = fb;
    const { fs, au, db, auth } = fb;

    fs.onSnapshot(fs.collection(db, "lots"), (snap) => {
      state.lots = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
      state.lotsLoaded = true;
      render();
    }, (e) => { console.error(e); notice("Не вдалося завантажити лоти. Оновіть сторінку.", true); });

    let unsubMe = null;
    au.onAuthStateChanged(auth, (user) => {
      if (unsubMe) { unsubMe(); unsubMe = null; }
      state.uid = user ? user.uid : null;
      state.me = undefined;
      if (!user) { au.signInAnonymously(auth).catch((e) => { console.error(e); notice("Не вдалося підключитись до аукціону. Оновіть сторінку.", true); }); return; }
      unsubMe = fs.onSnapshot(fs.doc(db, "bidders", user.uid), (s) => {
        state.me = s.exists() ? s.data() : null;
        render();
      }, () => { state.me = null; render(); });
    });

    if (state.openId) { subscribeBids(state.openId); loadMedia(state.openId); }
  } catch (e) {
    console.error(e);
    notice("Не вдалося підключитись до аукціону. Оновіть сторінку.", true);
  }
})();
