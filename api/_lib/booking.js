// ═══════════════════════════════════════════
// /api/_lib/booking.js  (LINE-v2)
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

// 2つの日付文字列の日数差（b - a）。b>=aの前提で使用
function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86400000);
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
    lineBookingConfirmMode: map.lineBookingConfirmMode === "manual" ? "manual" : "auto", // LINE予約の確定方法(auto=即確定/manual=仮予約)
    lineBookingEnabled: map.lineBookingEnabled,    // 受付停止スイッチ（未設定undefined=受付中扱い）
    advanceDays: Number(map.bookingAdvanceDays) > 0 ? Number(map.bookingAdvanceDays) : SEARCH_DAYS,       // 何日先まで受け付けるか（未設定ならSEARCH_DAYS=14）
    cutoffMinutes: (map.bookingCutoffMinutes !== undefined && map.bookingCutoffMinutes !== null && map.bookingCutoffMinutes !== "") ? Number(map.bookingCutoffMinutes) : LEAD_MINUTES, // 何分前まで受け付けるか（未設定ならLEAD_MINUTES=60）
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

// プライベート予定が指定日に発生するか（繰り返し設定を考慮。index.html側の同名ロジックと揃える）
function privateEventOccursOn(e, dateStr) {
  if (e.date === dateStr) return true;
  if (!e.recurrence || e.recurrence === "none") return false;
  if (dateStr < e.date) return false;
  if (e.recurrence_until && dateStr > e.recurrence_until) return false;
  if (e.recurrence === "daily") return true;
  const [sy, sm, sd] = e.date.split("-").map(Number);
  const [cy, cm, cd] = dateStr.split("-").map(Number);
  if (e.recurrence === "weekly") {
    const startDow = new Date(Date.UTC(sy, sm - 1, sd)).getUTCDay();
    const curDow = new Date(Date.UTC(cy, cm - 1, cd)).getUTCDay();
    return startDow === curDow;
  }
  if (e.recurrence === "monthly") return sd === cd;
  return false;
}

// 指定期間の各日に適用されるプライベート予定を展開して返す: { "YYYY-MM-DD": [event,...] }
async function getPrivateEventsExpanded(fromDate, toDate) {
  const rows = await sbFetch(
    `private_events?select=date,time,end_time,recurrence,recurrence_until&date=lte.${toDate}`
  );
  const byDate = {};
  let d = fromDate;
  while (d <= toDate) {
    byDate[d] = (rows || []).filter((r) => privateEventOccursOn(r, d));
    d = addDays(d, 1);
  }
  return byDate;
}

// その日の空きスロット(開始時刻 "HH:MM" の配列)を計算
// peForDate: その日に適用されるプライベート予定（あれば容量に関係なくその時間帯を除外＝完全ブロック）
function calcSlots(dateStr, settings, apptsForDate, duration, peForDate) {
  const dur = Number(duration) > 0 ? Number(duration) : DEFAULT_DURATION;
  const biz = getBizForDate(dateStr, settings);
  if (biz.isHoliday) return [];
  const open = toMin(biz.open);
  const close = toMin(biz.close);
  const lastStart = close - dur; // 閉店までに施術が終わる枠のみ
  const now = jstNow();
  const cutoffMin = Number.isFinite(settings.cutoffMinutes) ? settings.cutoffMinutes : LEAD_MINUTES;
  const daysDiff = daysBetween(now.dateStr, dateStr); // dateStrは常にtoday以降の前提
  const appts = (apptsForDate || []).map(normalizeAppt);
  const blocks = (peForDate || []).map(normalizeAppt);

  const slots = [];
  for (let s = open; s <= lastStart; s += settings.slotUnit) {
    // 「今からcutoffMin分後」より前の枠は除外。日をまたぐ長いカットオフ(数時間〜24時間等)にも対応
    if (daysDiff * 1440 + s - now.minutes < cutoffMin) continue;
    const blocked = blocks.some((b) => b.start < s + dur && b.end > s);
    if (blocked) continue;
    const overlapping = appts.filter((a) => a.start < s + dur && a.end > s).length;
    if (overlapping < settings.capacity) slots.push(toHHMM(s));
  }
  return slots;
}

// 今日〜設定日数先で空きのある日を最大4件返す: [{date, slots}]
async function findAvailableDates(settings, duration) {
  const searchDays = Number(settings.advanceDays) > 0 ? Number(settings.advanceDays) : SEARCH_DAYS;
  const today = jstNow().dateStr;
  const endDate = addDays(today, searchDays - 1);
  const rows = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=gte.${today}&date=lte.${endDate}`
  );
  const byDate = {};
  for (const r of rows || []) (byDate[r.date] = byDate[r.date] || []).push(r);
  const peByDate = await getPrivateEventsExpanded(today, endDate);

  const result = [];
  for (let i = 0; i < searchDays && result.length < MAX_DATE_CHOICES; i++) {
    const dateStr = addDays(today, i);
    const slots = calcSlots(dateStr, settings, byDate[dateStr], duration, peByDate[dateStr]);
    if (slots.length > 0) result.push({ date: dateStr, slots });
  }
  return result;
}

// 指定日の空きスロットを再取得（最新のDB状態で）
async function getSlotsForDate(dateStr, settings, duration) {
  const rows = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=eq.${dateStr}`
  );
  const peByDate = await getPrivateEventsExpanded(dateStr, dateStr);
  return calcSlots(dateStr, settings, rows, duration, peByDate[dateStr]);
}

// 確定直前の空き再チェック（リスクヘッジ原則③）
async function isSlotFree(dateStr, time, settings, duration) {
  const slots = await getSlotsForDate(dateStr, settings, duration);
  return slots.includes(time);
}

// ---------- 顧客の検索/作成 ----------
// このLINEアカウントが既にカルテと連携済みか(予約ページで電話番号入力を出すかの判定用)
async function isKnownUser(userId) {
  const found = await sbFetch(
    `customers?line_user_id=eq.${encodeURIComponent(userId)}&select=id`
  );
  return !!(found && found.length > 0);
}

async function findOrCreateCustomer(userId, displayName, phone) {
  const found = await sbFetch(
    `customers?line_user_id=eq.${encodeURIComponent(userId)}&select=id,name`
  );
  if (found && found.length > 0) return { customer: found[0], isNew: false, linked: false };

  // 電話番号で既存カルテを照合(ハイフン・空白の揺れを吸収して数字だけで比較)
  const normPhone = String(phone || "").replace(/[^0-9]/g, "");
  if (normPhone.length >= 10) {
    const rows = await sbFetch("customers?select=id,name,phone,line_user_id&phone=not.is.null");
    const hits = (rows || []).filter(
      (c) => String(c.phone || "").replace(/[^0-9]/g, "") === normPhone
    );
    // ちょうど1件一致、かつそのカルテが他のLINEアカウントと未連携の場合のみ自動連携する(誤連携防止)
    if (hits.length === 1 && !hits[0].line_user_id) {
      // 【INSERT原則の唯一の例外】空欄のline_user_idに1列だけ書き込み、以降このLINEアカウントと紐付ける
      await sbFetch(`customers?id=eq.${hits[0].id}`, {
        method: "PATCH",
        body: JSON.stringify({ line_user_id: userId }),
      });
      return { customer: hits[0], isNew: false, linked: true };
    }
  }

  const today = jstNow().dateStr;
  const customer = await sbInsert("customers", {
    name: displayName || "LINEのお客様",
    kana: null,
    phone: normPhone.length >= 10 ? normPhone : null,
    birthday: null,
    gender: "female", // 本体アプリのデフォルトに合わせる
    notes: "[LINE予約で自動作成]",
    join_date: today,
    line_user_id: userId,
  });
  return { customer, isNew: true, linked: false };
}

// ---------- 予約INSERT（appointments + 空カルテvisits） ----------
// リスクヘッジ原則②: INSERTのみ。UPDATE/DELETEは行わない
// menus(複数)対応。menu(単数)も従来どおり受け付ける(line-webhook.jsとの互換維持)
async function createBooking({ customerId, dateStr, time, userId, displayName, isNew, customerMessage, menu, menus, pending }) {
  const list = (menus && menus.length) ? menus : (menu ? [menu] : []);
  const dur = list.reduce((s, m) => s + (Number(m.duration) > 0 ? Number(m.duration) : 0), 0) || DEFAULT_DURATION;
  const totalPrice = list.reduce((s, m) => s + (m.price || 0), 0);
  const endTime = toHHMM(toMin(time) + dur);
  const customerType = isNew ? "new" : "existing";
  let notes = `[LINE予約] ${displayName || ""} (${userId})`;
  if (list.length > 0) notes += `\nメニュー: ${list.map((m) => m.name).join("、")}`;
  if (customerMessage) notes += `\n【お客様メッセージ】${String(customerMessage).slice(0, 500)}`;

  // 出所タグ原則④: notesに[LINE予約]+userId、専用色
  const appt = await sbInsert("appointments", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    end_time: endTime,
    duration: dur,
    menu_ids: list.map((m) => m.id).filter(Boolean),
    notes: notes,
    color: LINE_COLOR,
    paid: false,
    shimeika: "shimeika",
    customer_type: customerType,
    booking_status: pending ? "pending" : "confirmed", // 手動確定モードでは仮予約として登録
  });

  // UI予約と同じく空カルテを自動作成（appointment_idで紐付け・toDb.visitと同じ形）
  await sbInsert("visits", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    menus: list.map((m) => ({ menuId: m.id, name: m.name, price: m.price || 0 })),
    products: [],
    drug_cost: 0,
    payment_method: "cash",
    total: totalPrice,
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
  // imageカラムは含めない(重いので別API getMenuImages で後追い取得)
  const rows = await sbFetch("menus?select=id,name,price,duration,category,sort_order,menu_kind,target_customer,is_bookable&order=sort_order.asc");
  return (rows || [])
    .filter((m) => m.category !== "業務" && m.is_bookable !== false)
    .map((m) => ({
      id: m.id,
      name: m.name,
      price: m.price || 0,
      duration: Math.max(Number(m.duration) || DEFAULT_DURATION, settingsSlotFloor()),
      category: m.category || "",
      kind: m.menu_kind === "coupon" ? "coupon" : "menu",   // クーポン=メイン専用 / メニュー=追加にも使える
      target: m.target_customer || "all",                    // all | new | repeat (バッジ表示用)
    }));
}
function settingsSlotFloor() { return 15; } // 極端に短いdurationの防止

// メニュー画像だけを返す(予約ページが後追いで取得して合流する)
async function getMenuImages() {
  const rows = await sbFetch("menus?select=id,image&image=not.is.null");
  return (rows || []).filter((r) => r.image).map((r) => ({ id: r.id, image: r.image }));
}

// ---------- カレンダー予約用（booking.html） ----------
// 設定日数分の空き状況グリッドを構築: { rows: ["10:00",...], days: [{date, w, holiday, avail: [...]}] }
// duration省略時はDEFAULT_DURATION(60分)。メニュー選択に応じて呼び出し側から渡す
async function buildGrid(settings, duration) {
  const dur = Number(duration) > 0 ? Number(duration) : DEFAULT_DURATION;
  const searchDays = Number(settings.advanceDays) > 0 ? Number(settings.advanceDays) : SEARCH_DAYS;
  const today = jstNow().dateStr;
  const endDate = addDays(today, searchDays - 1);
  const rows14 = await sbFetch(
    `appointments?select=date,time,end_time,duration&date=gte.${today}&date=lte.${endDate}`
  );
  const byDate = {};
  for (const r of rows14 || []) (byDate[r.date] = byDate[r.date] || []).push(r);
  const peByDate = await getPrivateEventsExpanded(today, endDate);

  let minOpen = Infinity;
  let maxClose = -Infinity;
  const days = [];
  for (let i = 0; i < searchDays; i++) {
    const dateStr = addDays(today, i);
    const biz = getBizForDate(dateStr, settings);
    const slots = calcSlots(dateStr, settings, byDate[dateStr], dur, peByDate[dateStr]);
    if (!biz.isHoliday) {
      minOpen = Math.min(minOpen, toMin(biz.open));
      maxClose = Math.max(maxClose, toMin(biz.close));
    }
    days.push({ date: dateStr, w: weekdayJP(dateStr), holiday: biz.isHoliday, avail: slots });
  }
  // 行は営業時間の全枠を常に表示する(施術時間の長さで行を削らない)。
  // 合計時間内に収まらない開始時刻はavailに含まれないため、ページ側で×表示になる
  const rows = [];
  if (minOpen !== Infinity) {
    for (let t = minOpen; t <= maxClose - settings.slotUnit; t += settings.slotUnit) rows.push(toHHMM(t));
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
  getMenuImages,
  findAvailableDates,
  getSlotsForDate,
  isSlotFree,
  findOrCreateCustomer,
  isKnownUser,
  createBooking,
  saveSession,
  clearSession,
  buildGrid,
  findSessionByToken,
};
