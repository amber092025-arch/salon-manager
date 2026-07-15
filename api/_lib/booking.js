// ═══════════════════════════════════════════
// /api/_lib/booking.js  (LINE-v1)
// 空き枠計算・Supabaseアクセスの共通ライブラリ
// ※ _lib フォルダ内のファイルはVercelのエンドポイントにはならない
// ※ 既存アプリ(index.html等)には一切手を入れない。新規ファイルのみで完結
// ═══════════════════════════════════════════

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const DEFAULT_DURATION = 60;   // Phase 1: メニュー選択なし・施術時間は一律60分
const LEAD_MINUTES = 60;       // 当日予約は「今から60分後」以降の枠のみ提示
const SEARCH_DAYS = 14;        // 今日〜14日先まで探索
const MAX_DATE_CHOICES = 4;    // 日付候補は最大4件（Quick Reply）
const LINE_COLOR = "#06c755";  // LINE予約の専用色（出所タグ原則④）

// ---------- Supabase REST ----------
async function sbFetch(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Supabase ${res.status} (${path}): ${t}`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function sbInsert(table, row) {
  const rows = await sbFetch(table, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  return rows && rows[0];
}

// ---------- 日付・時刻ユーティリティ（JST基準・toISOString禁止ルール準拠） ----------
function jstNow() {
  const t = new Date(Date.now() + 9 * 3600 * 1000); // UTC+9
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return {
    dateStr: `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    minutes: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function weekdayJP(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const idx = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  return ["日", "月", "火", "水", "木", "金", "土"][idx];
}

function formatDateJP(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${weekdayJP(dateStr)})`;
}

function toMin(hhmm) {
  const [h, m] = String(hhmm).slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function toHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ---------- settings ----------
// index.htmlのgetBizForDateと同じロジック（本体は無改変・こちらに移植）
async function getSettings() {
  const rows = await sbFetch("settings?select=key,value");
  const map = {};
  for (const r of rows || []) {
    try { map[r.key] = JSON.parse(r.value); } catch (e) { map[r.key] = r.value; }
  }
  return {
    bizHours: map.bizHours || null,
    closedDaysOfWeek: map.closedDaysOfWeek || [],
    personalHolidays: map.personalHolidays || [],
    slotUnit: Number(map.bookingSlotUnit) || 30,   // 未設定なら30分
    capacity: Number(map.bookingCapacity) || 1,    // 未設定なら1（1人サロン）
    liffBookingId: map.liffBookingId || null,      // LIFF登録済みならモーダル表示に使う
  };
}

// settingsに1キーだけ保存（upsert）。既存キーには触らない
async function saveSetting(key, value) {
  await sbFetch("settings?on_conflict=key", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value: JSON.stringify(value) }]),
  });
}

function getBizForDate(dateStr, settings) {
  const { bizHours, closedDaysOfWeek, personalHolidays } = settings;
  if (!bizHours) return { open: "10:00", close: "20:00", isHoliday: false };
  const [y, m, d] = dateStr.split("-").map(Number);
  const dayIdx = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0=日
  const dayKeys = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const jp = ["日", "月", "火", "水", "木", "金", "土"][dayIdx];
  const dayHours = bizHours[dayKeys[dayIdx]] || { open: "10:00", close: "20:00", closed: false };
  const isHoliday =
    (personalHolidays || []).includes(dateStr) ||
    (closedDaysOfWeek || []).includes(jp) ||
    dayHours.closed;
  return { open: dayHours.open, close: dayHours.close, isHoliday };
}

// ---------- 空き枠計算 ----------
function normalizeAppt(r) {
  const start = toMin(r.time || "00:00");
  const end = r.end_time ? toMin(r.end_time) : start + (r.duration || DEFAULT_DURATION);
  return { start, end };
}

// その日の空きスロット(開始時刻 "HH:MM" の配列)を計算
function calcSlots(dateStr, settings, apptsForDate, duration) {
  const dur = Number(duration) > 0 ? Number(duration) : DEFAULT_DURATION;
  const biz = getBizForDate(dateStr, settings);
  if (biz.isHoliday) return [];
  const open = toMin(biz.open);
  const close = toMin(biz.close);
  const lastStart = close - dur; // 閉店までに施術が終わる枠のみ
  const now = jstNow();
  const minStart = dateStr === now.dateStr ? now.minutes + LEAD_MINUTES : -1;
  const appts = (apptsForDate || []).map(normalizeAppt);

  const slots = [];
  for (let s = open; s <= lastStart; s += settings.slotUnit) {
    if (s < minStart) continue;
    const overlapping = appts.filter((a) => a.start < s + dur && a.end > s).length;
    if (overlapping < settings.capacity) slots.push(toHHMM(s));
  }
  return slots;
}

// 今日〜14日先で空きのある日を最大4件返す: [{date, slots}]
async function findAvailableDates(settings, duration) {
  const today = jstNow().dateStr;
  const endDate = addDays(today, SEARCH_DAYS - 1);
  const rows = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=gte.${today}&date=lte.${endDate}`
  );
  const byDate = {};
  for (const r of rows || []) (byDate[r.date] = byDate[r.date] || []).push(r);

  const result = [];
  for (let i = 0; i < SEARCH_DAYS && result.length < MAX_DATE_CHOICES; i++) {
    const dateStr = addDays(today, i);
    const slots = calcSlots(dateStr, settings, byDate[dateStr], duration);
    if (slots.length > 0) result.push({ date: dateStr, slots });
  }
  return result;
}

// 指定日の空きスロットを再取得（最新のDB状態で）
async function getSlotsForDate(dateStr, settings, duration) {
  const rows = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=eq.${dateStr}`
  );
  return calcSlots(dateStr, settings, rows, duration);
}

// 確定直前の空き再チェック（リスクヘッジ原則③）
async function isSlotFree(dateStr, time, settings, duration) {
  const slots = await getSlotsForDate(dateStr, settings, duration);
  return slots.includes(time);
}

// ---------- 顧客の検索/作成 ----------
async function findOrCreateCustomer(userId, displayName) {
  const found = await sbFetch(
    `customers?line_user_id=eq.${encodeURIComponent(userId)}&select=id,name`
  );
  if (found && found.length > 0) return { customer: found[0], isNew: false };

  const today = jstNow().dateStr;
  const customer = await sbInsert("customers", {
    name: displayName || "LINEのお客様",
    kana: null,
    phone: null,
    birthday: null,
    gender: "female", // 本体アプリのデフォルトに合わせる
    notes: "[LINE予約で自動作成]",
    join_date: today,
    line_user_id: userId,
  });
  return { customer, isNew: true };
}

// ---------- 予約INSERT（appointments + 空カルテvisits） ----------
// リスクヘッジ原則②: INSERTのみ。UPDATE/DELETEは行わない
async function createBooking({ customerId, dateStr, time, userId, displayName, isNew, customerMessage, menu }) {
  const dur = menu && Number(menu.duration) > 0 ? Number(menu.duration) : DEFAULT_DURATION;
  const endTime = toHHMM(toMin(time) + dur);
  const customerType = isNew ? "new" : "existing";
  let notes = `[LINE予約] ${displayName || ""} (${userId})`;
  if (menu && menu.name) notes += `\nメニュー: ${menu.name}`;
  if (customerMessage) notes += `\n【お客様メッセージ】${String(customerMessage).slice(0, 500)}`;

  // 出所タグ原則④: notesに[LINE予約]+userId、専用色
  const appt = await sbInsert("appointments", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    end_time: endTime,
    duration: dur,
    menu_ids: menu && menu.id ? [menu.id] : [],
    notes: notes,
    color: LINE_COLOR,
    paid: false,
    shimeika: "shimeika",
    customer_type: customerType,
  });

  // UI予約と同じく空カルテを自動作成（appointment_idで紐付け・toDb.visitと同じ形）
  await sbInsert("visits", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    menus: menu && menu.id ? [{ menuId: menu.id, name: menu.name, price: menu.price || 0 }] : [],
    products: [],
    drug_cost: 0,
    payment_method: "cash",
    total: menu && menu.price ? menu.price : 0,
    notes: null,
    images: [],
    customer_type: customerType,
    hpb_point: 0,
    paid: false,
    duration: dur,
    appointment_id: appt.id,
    tags: [],
    style_name: null,
    style_comment: null,
    is_public: false,
    paid_at: null,
  });

  return appt;
}

// ---------- 会話セッション（line_sessionsテーブル） ----------
async function saveSession(userId, state) {
  await sbFetch("line_sessions?on_conflict=line_user_id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([
      { line_user_id: userId, state, updated_at: new Date().toISOString() },
    ]),
  });
}

async function clearSession(userId) {
  // セッションは会話状態のメモであり顧客データではないためDELETE可
  await sbFetch(`line_sessions?line_user_id=eq.${encodeURIComponent(userId)}`, {
    method: "DELETE",
  });
}

// ---------- メニュー一覧（カレンダー予約ページ用） ----------
async function getMenus() {
  // photosカラムは無いのでSELECT負荷なし。業務カテゴリ(裏)は除外し表示用のみ
  const rows = await sbFetch("menus?select=id,name,price,duration,category,sort_order&order=sort_order.asc");
  return (rows || [])
    .filter((m) => m.category !== "業務")
    .map((m) => ({
      id: m.id,
      name: m.name,
      price: m.price || 0,
      duration: Math.max(Number(m.duration) || DEFAULT_DURATION, settingsSlotFloor()),
    }));
}
function settingsSlotFloor() { return 15; } // 極端に短いdurationの防止

// ---------- カレンダー予約用（booking.html） ----------
// 14日分の空き状況グリッドを構築: { rows: ["10:00",...], days: [{date, w, holiday, avail: [...]}] }
// duration省略時はDEFAULT_DURATION(60分)。メニュー選択に応じて呼び出し側から渡す
async function buildGrid(settings, duration) {
  const dur = Number(duration) > 0 ? Number(duration) : DEFAULT_DURATION;
  const today = jstNow().dateStr;
  const endDate = addDays(today, SEARCH_DAYS - 1);
  const rows14 = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=gte.${today}&date=lte.${endDate}`
  );
  const byDate = {};
  for (const r of rows14 || []) (byDate[r.date] = byDate[r.date] || []).push(r);

  let minOpen = Infinity;
  let maxLastStart = -Infinity;
  const days = [];
  for (let i = 0; i < SEARCH_DAYS; i++) {
    const dateStr = addDays(today, i);
    const biz = getBizForDate(dateStr, settings);
    const slots = calcSlots(dateStr, settings, byDate[dateStr], dur);
    if (!biz.isHoliday) {
      minOpen = Math.min(minOpen, toMin(biz.open));
      maxLastStart = Math.max(maxLastStart, toMin(biz.close) - dur);
    }
    days.push({ date: dateStr, w: weekdayJP(dateStr), holiday: biz.isHoliday, avail: slots });
  }
  const rows = [];
  if (minOpen !== Infinity) {
    for (let t = minOpen; t <= maxLastStart; t += settings.slotUnit) rows.push(toHHMM(t));
  }
  return { rows, days, slotUnit: settings.slotUnit, duration: dur };
}

// webToken（カレンダーページ用の一時トークン）からセッションを検索
async function findSessionByToken(token) {
  if (!token || !/^[a-f0-9]{32}$/.test(token)) return null;
  const rows = await sbFetch(
    `line_sessions?select=line_user_id,state&state->>webToken=eq.${token}`
  );
  const s = rows && rows[0];
  if (!s) return null;
  const exp = s.state && s.state.webTokenExp;
  if (!exp || Date.now() > exp) return null;
  return s; // { line_user_id, state }
}

module.exports = {
  DEFAULT_DURATION,
  MAX_DATE_CHOICES,
  jstNow,
  formatDateJP,
  getSettings,
  saveSetting,
  getMenus,
  findAvailableDates,
  getSlotsForDate,
  isSlotFree,
  findOrCreateCustomer,
  createBooking,
  saveSession,
  clearSession,
  buildGrid,
  findSessionByToken,
};
