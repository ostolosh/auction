import { CONFIG } from "./config.js";
import {
  configured, initFirebase, syncClock, now, esc, money, ms, fmtDate, fmtTime, fmtLeft,
  prettyPhone, lotState,
} from "./common.js";

const $ = (s) => document.querySelector(s);
const S = {
  fb: null,
  lots: new Map(),
  bids: new Map(),      // lotId -> [ставки]
  bidSubs: new Map(),   // lotId -> unsubscribe
  bidders: new Map(),   // uid -> профіль
  open: new Set(),      // лоти з розгорнутою таблицею ставок
  editing: null,        // id лота, що редагується, або "new"
  photos: [],           // фото у формі (data URL)
  unsubs: [],
};

function notice(html, err = false) { const n = $("#notice"); n.innerHTML = html; n.classList.toggle("err", err); n.hidden = !html; }
let tt;
function toast(m) { const t = $("#toast"); t.textContent = m; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), 4000); }
const isAdminEmail = (email) => CONFIG.adminEmails.map((e) => e.trim().toLowerCase()).includes(String(email || "").toLowerCase());

// ---------- Вхід ----------
$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const { au, auth } = S.fb;
  $("#loginErr").hidden = true;
  try {
    await au.signInWithEmailAndPassword(auth, $("#email").value.trim(), $("#password").value);
  } catch (ex) {
    console.error(ex);
    $("#loginErr").textContent = "Неправильна пошта або пароль.";
    $("#loginErr").hidden = false;
  }
});
$("#logoutBtn").addEventListener("click", () => S.fb.au.signOut(S.fb.auth));

// ---------- Підписки ----------
function startData() {
  const { fs, db } = S.fb;
  S.unsubs.push(fs.onSnapshot(fs.collection(db, "lots"), (snap) => {
    S.lots = new Map(snap.docs.map((d) => [d.id, { id: d.id, ...d.data() }]));
    for (const id of S.lots.keys()) if (!S.bidSubs.has(id)) {
      S.bidSubs.set(id, fs.onSnapshot(fs.collection(db, "lots", id, "bids"), (bs) => {
        S.bids.set(id, bs.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => +b.id - +a.id));
        renderAll();
      }));
    }
    for (const [id, un] of S.bidSubs) if (!S.lots.has(id)) { un(); S.bidSubs.delete(id); S.bids.delete(id); }
    renderAll();
  }, (e) => { console.error(e); notice("Немає доступу до бази. Перевірте, що ваша пошта вказана у firestore.rules.", true); }));
  S.unsubs.push(fs.onSnapshot(fs.collection(db, "bidders"), (snap) => {
    S.bidders = new Map(snap.docs.map((d) => [d.id, { uid: d.id, ...d.data() }]));
    renderAll();
  }, (e) => console.error(e)));
}
function stopData() {
  S.unsubs.forEach((u) => u()); S.unsubs = [];
  S.bidSubs.forEach((u) => u()); S.bidSubs.clear();
  S.lots.clear(); S.bids.clear(); S.bidders.clear();
}

// ---------- Відображення ----------
const phoneLink = (p) => p ? `<a href="tel:${esc(p)}">${esc(prettyPhone(p))}</a>` : "—";
function dupPhones() {
  const c = new Map();
  for (const b of S.bidders.values()) c.set(b.phone, (c.get(b.phone) || 0) + 1);
  return c;
}

function renderAll() { renderLots(); renderResults(); renderBidders(); }

function sortedLots() {
  return [...S.lots.values()].sort((a, b) => ms(a.endsAt) - ms(b.endsAt));
}

function renderLots() {
  const el = $("#lotsList");
  const lots = sortedLots();
  if (!lots.length) { el.innerHTML = `<p class="hint">Лотів ще немає. Натисніть «Новий лот».</p>`; return; }
  el.innerHTML = lots.map((l) => {
    const st = lotState(l);
    const leader = l.leaderUid ? S.bidders.get(l.leaderUid) : null;
    const bids = S.bids.get(l.id) || [];
    const img = l.cover ? `<img src="${esc(l.cover)}" alt="">` : `<div class="noimg"></div>`;
    const leaderHtml = l.leaderUid
      ? `${st.key === "ended" ? "Переможець" : "Лідирує"}: <b>${esc(leader?.name || l.leaderName)}</b> ${phoneLink(leader?.phone)} — <b>${money(l.currentPrice)}</b>`
      : "Ставок немає";
    return `<div class="admin-lot" style="padding:14px 0;border-top:1px solid var(--line)">
      ${img}
      <div>
        <h3>${esc(l.title)} ${l.hidden ? `<span class="tag">приховано</span>` : ""}</h3>
        <div class="meta">
          <span>${st.key === "ended" ? "Завершено" : "Триває"} · <b data-ends="${ms(l.endsAt)}">${st.key === "ended" ? "—" : fmtLeft(st.left)}</b></span>
          <span>до ${fmtDate(ms(l.endsAt))}</span>
          <span>старт ${money(l.startPrice)} · крок ${money(l.minStep)}…${money(l.maxStep)}</span>
          <span>ставок: ${bids.filter((b) => !b.cancelled).length}${bids.some((b) => b.cancelled) ? ` (+${bids.filter((b) => b.cancelled).length} анульов.)` : ""}</span>
        </div>
        <div class="${st.key === "ended" && l.leaderUid ? "winner" : "meta"}" style="margin-top:8px">${leaderHtml}</div>
        <div class="actions-row">
          <button class="btn small" data-act="bids" data-id="${esc(l.id)}">${S.open.has(l.id) ? "Сховати ставки" : "Ставки"}</button>
          <button class="btn small" data-act="edit" data-id="${esc(l.id)}">Редагувати</button>
          <button class="btn small" data-act="hide" data-id="${esc(l.id)}">${l.hidden ? "Показати" : "Приховати"}</button>
          <button class="btn small danger" data-act="del" data-id="${esc(l.id)}">Видалити</button>
        </div>
        ${S.open.has(l.id) ? bidsTable(l, bids) : ""}
      </div>
    </div>`;
  }).join("");
}

function bidsTable(lot, bids) {
  if (!bids.length) return `<p class="hint">Ставок ще немає.</p>`;
  return `<div class="scroll" style="margin-top:10px"><table class="t">
    <tr><th>#</th><th>Час</th><th>Учасник</th><th>Телефон</th><th class="n">Сума</th><th></th></tr>
    ${bids.map((b) => {
      const p = S.bidders.get(b.uid);
      return `<tr class="${b.cancelled ? "cancelled" : ""}">
        <td>${esc(b.id)}</td><td>${b.createdAt ? fmtTime(ms(b.createdAt)) : ""}</td>
        <td>${esc(p?.name || b.name)}${p?.blocked ? ` <span class="tag">заблок.</span>` : ""}</td>
        <td>${phoneLink(p?.phone)}</td>
        <td class="n">${money(b.amount)}</td>
        <td style="white-space:nowrap">
          <button class="btn small" data-act="${b.cancelled ? "restore" : "cancel"}" data-id="${esc(lot.id)}" data-bid="${esc(b.id)}">${b.cancelled ? "Відновити" : "Анулювати"}</button>
          <button class="btn small" data-act="block" data-uid="${esc(b.uid)}">${p?.blocked ? "Розблок." : "Заблок."}</button>
        </td></tr>`;
    }).join("")}
  </table></div>`;
}

function renderResults() {
  const ended = sortedLots().filter((l) => lotState(l).key === "ended");
  const el = $("#results");
  if (!ended.length) { el.innerHTML = `<p class="hint">Тут з'являться переможці, коли лоти завершаться.</p>`; return; }
  el.innerHTML = `<div class="scroll"><table class="t">
    <tr><th>Лот</th><th>Переможець</th><th>Телефон</th><th class="n">Ціна</th></tr>
    ${ended.map((l) => {
      const p = l.leaderUid ? S.bidders.get(l.leaderUid) : null;
      return `<tr><td>${esc(l.title)}</td><td>${l.leaderUid ? esc(p?.name || l.leaderName) : "—"}</td><td>${phoneLink(p?.phone)}</td><td class="n">${l.leaderUid ? money(l.currentPrice) : "без ставок"}</td></tr>`;
    }).join("")}
  </table></div>
  <button class="btn small" style="margin-top:12px" id="copyResults" type="button">Копіювати підсумки</button>`;
}

function renderBidders() {
  const el = $("#bidders");
  const list = [...S.bidders.values()].sort((a, b) => ms(b.createdAt) - ms(a.createdAt));
  if (!list.length) { el.innerHTML = `<p class="hint">Ще ніхто не зареєструвався.</p>`; return; }
  const dup = dupPhones();
  const bidsBy = new Map();
  for (const arr of S.bids.values()) for (const b of arr) if (!b.cancelled) bidsBy.set(b.uid, (bidsBy.get(b.uid) || 0) + 1);
  el.innerHTML = `<table class="t">
    <tr><th>Ім'я</th><th>Телефон</th><th>Зареєстр.</th><th class="n">Ставок</th><th></th></tr>
    ${list.map((b) => `<tr>
      <td>${esc(b.name)} ${b.blocked ? `<span class="tag">заблок.</span>` : ""}</td>
      <td>${phoneLink(b.phone)} ${dup.get(b.phone) > 1 ? `<span class="tag">той самий номер ×${dup.get(b.phone)}</span>` : ""}</td>
      <td>${b.createdAt ? fmtTime(ms(b.createdAt)) : ""}</td>
      <td class="n">${bidsBy.get(b.uid) || 0}</td>
      <td><button class="btn small" data-act="block" data-uid="${esc(b.uid)}">${b.blocked ? "Розблокувати" : "Заблокувати"}</button></td>
    </tr>`).join("")}
  </table>`;
}

setInterval(() => {
  document.querySelectorAll("[data-ends]").forEach((el) => {
    const left = +el.dataset.ends - now();
    el.textContent = left > 0 ? fmtLeft(left) : "—";
  });
}, 1000);

// ---------- Дії ----------
document.addEventListener("click", async (e) => {
  if (e.target.id === "copyResults") { copyResults(); return; }
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const { act, id } = b.dataset;
  const { fs, db } = S.fb;
  try {
    if (act === "bids") { S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderLots(); }
    else if (act === "edit") openForm(id);
    else if (act === "hide") await fs.updateDoc(fs.doc(db, "lots", id), { hidden: !S.lots.get(id).hidden });
    else if (act === "del") {
      const l = S.lots.get(id);
      if (!confirm(`Видалити лот «${l.title}» разом з усіма ставками? Це не можна скасувати.`)) return;
      const bids = await fs.getDocs(fs.collection(db, "lots", id, "bids"));
      const batch = fs.writeBatch(db);
      bids.forEach((d) => batch.delete(d.ref));
      batch.delete(fs.doc(db, "lotMedia", id));
      batch.delete(fs.doc(db, "lots", id));
      await batch.commit();
      toast("Лот видалено.");
    }
    else if (act === "cancel" || act === "restore") {
      const msg = act === "cancel"
        ? "Анулювати цю ставку? Лідером стане попередній учасник із найвищою дійсною ставкою."
        : "Відновити цю ставку?";
      if (!confirm(msg)) return;
      await setBidCancelled(id, b.dataset.bid, act === "cancel");
      toast(act === "cancel" ? "Ставку анульовано." : "Ставку відновлено.");
    }
    else if (act === "block") {
      const uid = b.dataset.uid;
      const p = S.bidders.get(uid);
      if (!p) return;
      if (!p.blocked && !confirm(`Заблокувати ${p.name}? Учасник більше не зможе робити ставки. Його попередні ставки залишаться — анулюйте їх окремо, якщо потрібно.`)) return;
      await fs.updateDoc(fs.doc(db, "bidders", uid), { blocked: !p.blocked });
    }
  } catch (ex) {
    console.error(ex);
    toast(ex.userMessage || "Не вдалося виконати дію. Спробуйте ще раз.");
  }
});

// Анулювання/відновлення ставки з перерахунком лідера лота
async function setBidCancelled(lotId, bidId, cancelled) {
  const { fs, db } = S.fb;
  const lotRef = fs.doc(db, "lots", lotId);
  const all = await fs.getDocs(fs.collection(db, "lots", lotId, "bids"));
  const seenCount = all.size;
  await fs.runTransaction(db, async (tx) => {
    const ls = await tx.get(lotRef);
    const L = ls.data();
    if ((L.bidCount || 0) !== seenCount) {
      const err = new Error("stale"); err.userMessage = "Щойно з'явилась нова ставка. Спробуйте ще раз."; throw err;
    }
    const valid = all.docs.map((d) => ({ id: d.id, ...d.data() }))
      .map((x) => (x.id === bidId ? { ...x, cancelled } : x))
      .filter((x) => !x.cancelled)
      .sort((a, b) => b.amount - a.amount || +a.id - +b.id);
    const top = valid[0];
    tx.update(fs.doc(db, "lots", lotId, "bids", bidId), { cancelled });
    tx.update(lotRef, top
      ? { currentPrice: top.amount, leaderUid: top.uid, leaderName: top.name, leaderPhoneTail: top.phoneTail }
      : { currentPrice: L.startPrice, leaderUid: null, leaderName: null, leaderPhoneTail: null });
  });
}

function copyResults() {
  const lines = sortedLots().filter((l) => lotState(l).key === "ended").map((l) => {
    const p = l.leaderUid ? S.bidders.get(l.leaderUid) : null;
    return l.leaderUid
      ? `${l.title} — ${p?.name || l.leaderName}, ${prettyPhone(p?.phone || "")}, ${money(l.currentPrice)}`
      : `${l.title} — без ставок`;
  });
  navigator.clipboard.writeText(lines.join("\n")).then(() => toast("Скопійовано."), () => toast("Не вдалося скопіювати."));
}

// ---------- Форма лота ----------
const pad = (n) => String(n).padStart(2, "0");
const toLocalInput = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };

$("#newLotBtn").addEventListener("click", () => openForm(null));
$("#cancelLot").addEventListener("click", () => { $("#lotForm").hidden = true; S.editing = null; });

async function openForm(id) {
  const D = CONFIG.defaults;
  const l = id ? S.lots.get(id) : null;
  S.editing = id || "new";
  $("#lotFormTitle").textContent = l ? "Редагування лота" : "Новий лот";
  $("#fTitle").value = l?.title || "";
  $("#fDesc").value = l?.description || "";
  $("#fStart").value = l?.startPrice ?? "";
  $("#fMin").value = l?.minStep ?? D.minStep;
  $("#fMax").value = l?.maxStep ?? D.minStep * D.maxStepMultiplier;
  $("#fEnds").value = toLocalInput(l ? ms(l.endsAt) : now() + 3 * 86400000);
  $("#fSnipe").value = l ? Math.round((l.antiSnipeSec || 0) / 60) : D.antiSnipeMin;
  $("#fHidden").checked = Boolean(l?.hidden);
  $("#lotErr").hidden = true;
  S.photos = [];
  renderPhotos();
  $("#lotForm").hidden = false;
  $("#lotForm").scrollIntoView({ behavior: "smooth", block: "start" });
  if (l) {
    const { fs, db } = S.fb;
    const m = await fs.getDoc(fs.doc(db, "lotMedia", id));
    if (S.editing === id) { S.photos = m.exists() ? [...(m.data().photos || [])] : (l.cover ? [l.cover] : []); renderPhotos(); }
  }
}

function renderPhotos() {
  $("#fPhotos").innerHTML = S.photos.map((p, i) => `<div class="ph"><img src="${p}" alt="" data-cover="${i}" style="cursor:pointer">
    ${i === 0 ? `<span class="cover-tag">обкладинка</span>` : ""}<button type="button" data-rm="${i}" aria-label="Видалити фото">×</button></div>`).join("");
}
$("#fPhotos").addEventListener("click", (e) => {
  const rm = e.target.closest("[data-rm]");
  if (rm) { S.photos.splice(+rm.dataset.rm, 1); renderPhotos(); return; }
  const c = e.target.closest("[data-cover]");
  if (c) { const [p] = S.photos.splice(+c.dataset.cover, 1); S.photos.unshift(p); renderPhotos(); }
});
$("#fFiles").addEventListener("change", async (e) => {
  const files = [...e.target.files].slice(0, 6 - S.photos.length);
  e.target.value = "";
  for (const f of files) {
    try { S.photos.push(await shrink(f, 1280, 0.78)); renderPhotos(); }
    catch { toast(`Не вдалося прочитати ${f.name}`); }
  }
});

function loadImg(src) {
  return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
}
async function shrink(fileOrUrl, maxSide, q) {
  const url = typeof fileOrUrl === "string" ? fileOrUrl : URL.createObjectURL(fileOrUrl);
  const img = await loadImg(url);
  if (typeof fileOrUrl !== "string") URL.revokeObjectURL(url);
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", q);
}
// Firestore дозволяє до 1 МБ на документ, тож стискаємо фото, поки вони не вмістяться
async function fitPhotos(photos) {
  let out = photos, side = 1280, q = 0.78;
  while (out.reduce((s, p) => s + p.length, 0) > 950000 && side > 400) {
    side = Math.round(side * 0.8); q = Math.max(0.6, q - 0.05);
    out = await Promise.all(photos.map((p) => shrink(p, side, q)));
  }
  return out;
}

$("#lotForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = (m) => { $("#lotErr").textContent = m; $("#lotErr").hidden = false; };
  const title = $("#fTitle").value.trim();
  const description = $("#fDesc").value.trim();
  const startPrice = Math.round(+$("#fStart").value);
  const minStep = Math.round(+$("#fMin").value);
  const maxStep = Math.round(+$("#fMax").value);
  const endsMs = new Date($("#fEnds").value).getTime();
  const antiSnipeSec = Math.max(0, Math.round(+$("#fSnipe").value || 0)) * 60;
  const hidden = $("#fHidden").checked;
  if (!title) return err("Вкажіть назву лота.");
  if (!(startPrice >= 0)) return err("Вкажіть стартову ціну.");
  if (!(minStep >= 1)) return err("Мінімальний крок має бути щонайменше 1.");
  if (!(maxStep >= minStep)) return err("Макс. підвищення має бути не менше мінімального кроку.");
  if (!endsMs) return err("Вкажіть час завершення.");

  const { fs, db } = S.fb;
  const btn = $("#saveLot");
  btn.disabled = true; btn.textContent = "Збереження…";
  try {
    const photos = await fitPhotos(S.photos);
    const cover = photos[0] ? await shrink(photos[0], 560, 0.72) : null;
    const batch = fs.writeBatch(db);
    const base = { title, description, startPrice, minStep, maxStep, antiSnipeSec, hidden, cover, photoCount: photos.length, endsAt: fs.Timestamp.fromMillis(endsMs) };
    let id = S.editing;
    if (id === "new") {
      const ref = fs.doc(fs.collection(db, "lots"));
      id = ref.id;
      batch.set(ref, { ...base, currentPrice: startPrice, bidCount: 0, leaderUid: null, leaderName: null, leaderPhoneTail: null, lastBidAt: null, createdAt: fs.serverTimestamp() });
    } else {
      const old = S.lots.get(id);
      batch.update(fs.doc(db, "lots", id), old.leaderUid ? base : { ...base, currentPrice: startPrice });
    }
    batch.set(fs.doc(db, "lotMedia", id), { photos });
    await batch.commit();
    $("#lotForm").hidden = true;
    S.editing = null;
    toast("Лот збережено.");
  } catch (ex) {
    console.error(ex);
    err("Не вдалося зберегти лот. Спробуйте зменшити кількість фото.");
  } finally {
    btn.disabled = false; btn.textContent = "Зберегти";
  }
});

// ---------- Старт ----------
(async () => {
  if (!configured) { notice("Спершу заповніть <code>auction/config.js</code> — див. <code>auction/README.md</code>.", true); return; }
  try {
    await syncClock();
    S.fb = await initFirebase();
  } catch (e) {
    console.error(e);
    notice("Не вдалося підключитись до Firebase. Перевірте налаштування в <code>config.js</code> і оновіть сторінку.", true);
    return;
  }
  const { au, auth } = S.fb;
  au.onAuthStateChanged(auth, (user) => {
    stopData();
    const ok = user && !user.isAnonymous && isAdminEmail(user.email);
    $("#loginView").hidden = Boolean(ok);
    $("#adminView").hidden = !ok;
    notice(user && !user.isAnonymous && !ok ? "Ця пошта не має прав адміністратора." : "", true);
    if (ok) { $("#whoami").textContent = user.email; startData(); }
  });
})();
