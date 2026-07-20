// ═══════════════════════════════════════════
// /api/hpb-mail.js  (HPB-v5)
// HPB(サロンボード)予約通知メール取り込み: CloudMailin → 解析 → appointments INSERT/DELETE → 通知
//
// 経路: HPB予約通知メール → メールの自動転送 → CloudMailin(JSON Normalized)
//       → POST https://salon-manager-sigma.vercel.app/api/hpb-mail?token=XXXX
//
// 方針:
//   ・新規予約メール: 自動登録(INSERT)。メニューは登録済みメニュー(menusテーブル)と
//     名称照合し、一意に一致した項目だけmenu_idsに紐付ける(確定確認時にカルテへ反映される)
//   ・キャンセル連絡メール: 予約番号が一致する1件だけ自動削除(DELETE)。
//     複数一致/不一致/番号読み取り不可の場合は削除せず通知のみ(手動対応)
//   ・変更メール(書式未確認のため): 通知のみ・手動対応
//   ・重複防止: notesに[HPB]予約番号を記録し、新規登録前に存在チェック
//   ・解析失敗時は本文を添えてオーナーへLINE通知(手動登録/削除できるように)
//
// 必要な環境変数:
//   HPB_MAIL_TOKEN     … 推測不能なランダム文字列(偽メールPOST対策)。CloudMailinの宛先URLの?token=に同じ値を付ける
//   SUPABASE_URL / SUPABASE_KEY … 既存
//   LINE_CHANNEL_ID / LINE_CHANNEL_SECRET … 既存(オーナー通知用トークン自動発行)
//   OWNER_LINE_USER_ID … 既存(オーナー通知先)
//   SALON_PHONE        … 任意
// ═══════════════════════════════════════════

const VERSION = "HPB-v5";
const HPB_COLOR = "#f25c05"; // ホットペッパーオレンジ(出所タグ原則④)
const DEFAULT_DURATION = 120; // 施術時間目安が読めなかった場合の既定(分)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
// 来店日時の行: 新規予約メールは半角括弧「(月)」、キャンセル連絡メールは全角括弧「（日）」のため両対応
const DATETIME_RE = /■来店日時\s*\n\s*(\d{4})年(\d{1,2})月(\d{1,2})日[（(].*?[）)]\s*(\d{1,2}):(\d{2})/;

// ---------- エントリポイント ----------
module.exports = async (req, res) => {
  // GET: 疎通・環境変数チェック(秘密情報は返さない)
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      version: VERSION,
      env: {
        HPB_MAIL_TOKEN: !!process.env.HPB_MAIL_TOKEN,
        SUPABASE_URL: !!SUPABASE_URL,
        SUPABASE_KEY: !!SUPABASE_KEY,
        LINE_CHANNEL_ID: !!process.env.LINE_CHANNEL_ID,
        LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
        OWNER_LINE_USER_ID: !!process.env.OWNER_LINE_USER_ID,
      },
    });
  }
  if (req.method !== "POST") return res.status(405).end();

  // トークン検証(第三者からの偽メールPOSTを弾く)
  const token = (req.query && req.query.token) || "";
  if (!process.env.HPB_MAIL_TOKEN || token !== process.env.HPB_MAIL_TOKEN) {
    return res.status(401).json({ error: "invalid token" });
  }

  try {
    const mail = await readMail(req);
    const result = await handleMail(mail);
    // CloudMailinには常に200を返す(非200だと再送を繰り返すため。失敗時も通知済みなら200)
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error(`[${VERSION}] fatal:`, e);
    try {
      await notifyOwner(`⚠️ [${VERSION}] HPBメール取り込みでエラーが発生しました\n${String(e).slice(0, 300)}\n\nHPBの通知メールを確認し、必要なら予約表へ手動登録してください。`);
    } catch (e2) { console.error(`[${VERSION}] notify fail:`, e2); }
    return res.status(200).json({ ok: false });
  }
};

// ---------- メール受信(CloudMailin JSON Normalized) ----------
async function readMail(req) {
  let body = req.body;
  if (!body || typeof body === "string") {
    const raw = typeof body === "string" ? body : await getRawBody(req);
    try { body = JSON.parse(raw); } catch (e) { body = { plain: raw }; }
  }
  const headers = body.headers || {};
  const subject = headers.subject || headers.Subject || "";
  // 本文: plain優先。無ければhtmlのタグを除去
  let text = body.plain || body.reply_plain || "";
  if (!text && body.html) text = String(body.html).replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "");
  return { subject: String(subject), text: String(text || "") };
}

async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString("utf8");
}

// ---------- メイン処理 ----------
async function handleMail(mail) {
  const { subject } = mail;
  // 転送メールの引用記号(行頭の「> 」)を除去してから解析する(手動転送でも解析できるように)
  const text = String(mail.text || "")
    .split("\n")
    .map((l) => l.replace(/^(\s*>\s?)+/, ""))
    .join("\n");
  const excerpt = (subject ? `件名: ${subject}\n` : "") + text.slice(0, 600);

  // キャンセル連絡メール → 予約番号が一致すれば自動削除。曖昧な場合のみ手動対応へ
  if (/キャンセル連絡/.test(subject) || /■予約番号/.test(text) && /キャンセル/.test(subject + text)) {
    return handleCancellation(text, subject, excerpt);
  }

  // 変更メール(書式未確認) → 通知のみ・手動対応
  if (/変更/.test(subject) || /予約(が|を)?変更/.test(text)) {
    await notifyOwner(`📩 [${VERSION}] HPBの予約変更メールを受信しました(自動処理対象外)\n予約表とサロンボードを確認して手動で対応してください。\n\n${excerpt}`);
    return "change-notified";
  }

  // 予約通知メールでなければ通知だけして終了
  if (!/■予約番号/.test(text)) {
    await notifyOwner(`📩 [${VERSION}] HPB取り込みアドレスに解析対象外のメールが届きました\n\n${excerpt}`);
    return "not-a-booking-mail";
  }

  // ---------- 解析(確認済みサンプルの書式: ■ラベル行の次行に値) ----------
  const bookingNo = pick(text, /■予約番号\s*\n\s*(\S+)/);
  const nameM = text.match(/■氏名\s*\n\s*(.+?)[（(](.+?)[）)]/);
  const name = nameM ? nameM[1].trim() : null;
  const kana = nameM ? nameM[2].trim() : null;
  const dtM = text.match(DATETIME_RE);
  const menuName = pick(text, /■メニュー\s*\n\s*(.+)/);
  const totalM = text.match(/お支払い予定金額\s*([\d,]+)\s*円/);
  const durM = text.match(/施術時間目安[：:]\s*(?:(\d+)\s*時間)?\s*(?:(\d+)\s*分)?/);

  // 必須項目(予約番号・日時)が取れなければ手動対応へ
  if (!bookingNo || !dtM) {
    await notifyOwner(`⚠️ [${VERSION}] HPB予約メールの解析に失敗しました(書式が想定と異なる可能性)\n予約表へ手動登録してください。\n\n${excerpt}`);
    return "parse-failed";
  }

  const dateStr = `${dtM[1]}-${String(dtM[2]).padStart(2, "0")}-${String(dtM[3]).padStart(2, "0")}`;
  const time = `${String(dtM[4]).padStart(2, "0")}:${dtM[5]}`;
  let duration = DEFAULT_DURATION;
  if (durM && (durM[1] || durM[2])) {
    duration = (Number(durM[1]) || 0) * 60 + (Number(durM[2]) || 0);
    if (!(duration > 0)) duration = DEFAULT_DURATION;
  }
  const endTime = minToHHMM(hhmmToMin(time) + duration);
  const total = totalM ? Number(totalM[1].replace(/,/g, "")) : null;

  // ---------- 重複防止(同メール2回転送でも1件のまま) ----------
  const dupTag = `[HPB] 予約番号${bookingNo}`;
  const dup = await sbFetch(
    `appointments?select=id&notes=like.${encodeURIComponent("*" + dupTag + "*")}`
  );
  if (dup && dup.length > 0) {
    console.log(`[${VERSION}] duplicate skipped: ${bookingNo}`);
    return "duplicate-skipped";
  }

  // ---------- 顧客照合(ふりがな→ひらがな正規化して一意に一致した場合のみ紐付け) ----------
  const { customerId, isNew, matchedName } = await matchOrCreateCustomer(name, kana);

  // ---------- メニュー照合 ----------
  // 精度優先: まず「■ご利用クーポン」のクーポン名を丸ごと登録メニューと照合(メニュー名はHPBと揃えてある前提)。
  // クーポンで一致しなければ従来どおり「■メニュー」を+で分解して個別照合
  const couponName = extractCouponName(text);
  const pointM = text.match(/今回の利用ポイント\s*([\d,]+)\s*ポイント/);
  const hpbPoint = pointM ? Number(pointM[1].replace(/,/g, "")) : 0;
  const { resolved, unresolved, via } = await resolveMenus(menuName, couponName);
  const menuIds = resolved.map((m) => m.id);

  // ---------- appointments INSERT(出所タグ: notesに[HPB]+予約番号、HPBオレンジ) ----------
  let notes = `${dupTag}\n${name || "氏名不明"}${kana ? `（${kana}）` : ""}`;
  if (couponName) notes += `\nクーポン: ${couponName}`;
  if (menuName) notes += `\nメニュー: ${menuName}`;
  if (total !== null) notes += `\n金額: ${total.toLocaleString()}円`;
  if (hpbPoint > 0) notes += `\nHPBポイント利用: ${hpbPoint.toLocaleString()}pt`;
  if (unresolved.length > 0) notes += `\n⚠️未登録メニュー(要手動確認): ${unresolved.join("、")}`;
  notes += `\n(HPBメール自動取り込み)`;

  await sbInsert("appointments", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    end_time: endTime,
    duration: duration,
    menu_ids: menuIds,
    notes: notes,
    color: HPB_COLOR,
    paid: false,
    shimeika: "shimeika",
    customer_type: isNew ? "new" : "existing",
    hpb_point: hpbPoint,
  });

  const menuLine = resolved.length > 0
    ? resolved.map((m) => m.name).join("、") + (via === "coupon" ? "（クーポン名で一致）" : "") + (unresolved.length > 0 ? `　+未登録: ${unresolved.join("、")}` : "")
    : (couponName || menuName || "メニュー不明") + "（登録メニューと一致せず・要手動設定）";

  await notifyOwner(
    `🟠 [${VERSION}] HPB予約を予約表に自動登録しました\n\n📅 ${formatDateJP(dateStr)} ${time}〜${endTime}\n👤 ${name || "氏名不明"}${kana ? `（${kana}）` : ""}${isNew ? "（新規・仮カルテ自動作成）" : matchedName ? `（既存カルテ: ${matchedName}）` : ""}\n💇 ${menuLine}${total !== null ? `\n💰 ${total.toLocaleString()}円` : ""}${hpbPoint > 0 ? `\n🅿️ ポイント利用 ${hpbPoint.toLocaleString()}pt（確定確認時にカルテへ自動転記）` : ""}\n予約番号: ${bookingNo}`
  );
  return "inserted";
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

// ---------- メニュー照合 ----------
// 「■ご利用クーポン」ブロックからクーポン名を1行取り出す([全員]等の対象行と説明行は除外、末尾の価格表記は除去)
function extractCouponName(text) {
  const m = text.match(/■ご利用クーポン\s*\n([\s\S]*?)(?=\n\s*\n|\n■|$)/);
  if (!m) return null;
  const lines = m[1].split("\n").map((s) => s.trim()).filter(Boolean);
  for (const line of lines) {
    if (/^[\[［].*[\]］]$/.test(line)) continue; // [全員][新規]等の対象行はスキップ
    return line.replace(/[\\￥¥]\s*[\d,]+円?\s*$/, "").trim();
  }
  return null;
}

// 照合用の正規化: 括弧書き・空白・価格表記(\19000 / ¥13,500 / 13500円)を除去して比較
// ※「ヘッドスパ25分」のような時間表記の数字は消さない(価格の形をした数字だけ除去)
function normalizeMenuText(s) {
  return String(s || "")
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[\\￥¥]\s*[\d,]{3,}/g, "")
    .replace(/[\d,]{4,}円/g, "")
    .replace(/[\s　]/g, "")
    .toLowerCase();
}

async function resolveMenus(menuName, couponName) {
  let catalog = [];
  try {
    const rows = await sbFetch("menus?select=id,name,price,duration,category&order=sort_order.asc");
    catalog = (rows || []).filter((m) => m.category !== "業務");
  } catch (e) {
    console.error(`[${VERSION}] menu catalog fetch error:`, e);
    return { resolved: [], unresolved: [couponName || menuName].filter(Boolean), via: null };
  }

  // ①クーポン名の丸ごと照合を最優先(メニュー名をHPBのクーポン名と揃えてある前提で最も精度が高い)
  if (couponName) {
    const normC = normalizeMenuText(couponName);
    if (normC) {
      const exact = catalog.filter((m) => normalizeMenuText(m.name) === normC);
      if (exact.length === 1) return { resolved: [exact[0]], unresolved: [], via: "coupon" };
      if (exact.length === 0) {
        const partial = catalog.filter((m) => {
          const mn = normalizeMenuText(m.name);
          return mn && (mn.includes(normC) || normC.includes(mn));
        });
        if (partial.length === 1) return { resolved: [partial[0]], unresolved: [], via: "coupon" };
      }
    }
  }

  // ②フォールバック: ■メニュー欄を+/＋/、で分解して個別照合(完全一致優先→候補1件のみの部分一致)
  if (!menuName) return { resolved: [], unresolved: [couponName].filter(Boolean), via: null };
  const parts = menuName.split(/[+＋、,]/).map((s) => s.trim()).filter(Boolean);
  const resolved = [];
  const unresolved = [];
  for (const part of parts) {
    const norm = normalizeMenuText(part);
    if (!norm) continue;
    const exactHits = catalog.filter((m) => normalizeMenuText(m.name) === norm);
    if (exactHits.length === 1) { resolved.push(exactHits[0]); continue; }
    if (exactHits.length > 1) { unresolved.push(part); continue; }
    const hits = catalog.filter((m) => {
      const mn = normalizeMenuText(m.name);
      return mn && (mn.includes(norm) || norm.includes(mn));
    });
    if (hits.length === 1) resolved.push(hits[0]);
    else unresolved.push(part);
  }
  return { resolved, unresolved, via: "menu" };
}

// ---------- キャンセル連絡メール: 予約番号が一致する1件だけ自動削除 ----------
async function handleCancellation(text, subject, excerpt) {
  const bookingNo = pick(text, /■予約番号\s*\n\s*(\S+)/);
  const nameM = text.match(/■氏名\s*\n\s*(.+?)[（(](.+?)[）)]/);
  const name = nameM ? nameM[1].trim() : null;

  if (!bookingNo) {
    await notifyOwner(`⚠️ [${VERSION}] キャンセルメールから予約番号を読み取れませんでした\n予約表を確認し、該当の予約があれば手動で削除してください。\n\n${excerpt}`);
    return "cancel-parse-failed";
  }

  // 新規登録時と同じタグ([HPB] 予約番号xxxx)で該当の予約を検索
  const dupTag = `[HPB] 予約番号${bookingNo}`;
  const matches = await sbFetch(
    `appointments?select=id,date,time,notes&notes=like.${encodeURIComponent("*" + dupTag + "*")}`
  );

  if (!matches || matches.length === 0) {
    await notifyOwner(`📩 [${VERSION}] HPBキャンセル連絡を受信しましたが、対応する予約が予約表に見つかりませんでした\n(既に削除済み、または手動登録されたものと思われます)\n\n予約番号: ${bookingNo}${name ? `\n氏名: ${name}` : ""}`);
    return "cancel-no-match";
  }
  if (matches.length > 1) {
    // 同じ予約番号が複数ヒットする状況は本来起きないはずだが、誤削除を避けるため必ず手動対応にする
    await notifyOwner(`⚠️ [${VERSION}] キャンセル対象の予約が複数見つかったため、安全のため自動削除を見送りました\n予約表から該当の予約を手動で削除してください。\n\n予約番号: ${bookingNo}${name ? `\n氏名: ${name}` : ""}`);
    return "cancel-multiple-match";
  }

  const appt = matches[0];

  // 念のための安全弁: この予約に空でないカルテ(来店記録)が紐づいていたら自動削除せず手動対応にする
  // (通常HPB取り込みの予約に空カルテは作られないが、後から手動で紐付けられていた場合に備える)
  const visits = await sbFetch(`visits?select=id,paid,total,notes,photo_data,images&appointment_id=eq.${appt.id}`);
  const visit = visits && visits[0];
  const visitHasData = visit && (
    visit.paid || (visit.total && visit.total > 0) || visit.notes ||
    (visit.photo_data && visit.photo_data !== "{}") ||
    (visit.images && visit.images.length > 0)
  );
  if (visitHasData) {
    await notifyOwner(`⚠️ [${VERSION}] HPBキャンセル連絡を受信しましたが、該当のカルテに記録があるため自動削除を見送りました\n内容をご確認のうえ、手動で対応してください。\n\n📅 ${formatDateJP(appt.date)} ${appt.time}\n予約番号: ${bookingNo}${name ? `\n氏名: ${name}` : ""}`);
    return "cancel-visit-not-empty";
  }

  if (visit) await sbDelete("visits", visit.id);
  await sbDelete("appointments", appt.id);

  await notifyOwner(`🗑️ [${VERSION}] HPBキャンセル連絡により予約表から削除しました\n\n📅 ${formatDateJP(appt.date)} ${appt.time}\n予約番号: ${bookingNo}${name ? `\n氏名: ${name}` : ""}\n\n★サロンボード側は既にキャンセル済みのはずですが念のためご確認ください`);
  return "cancelled";
}

async function sbDelete(table, id) {
  await sbFetch(`${table}?id=eq.${id}`, { method: "DELETE" });
}

// ---------- 顧客照合 ----------
// ふりがな(カタカナ)をひらがなに正規化し、customersのkana/nameと突合。
// ちょうど1件一致 → その顧客に紐付け。0件 or 複数件 → 仮カルテを新規作成(誤紐付け防止)
async function matchOrCreateCustomer(name, kana) {
  const norm = (s) =>
    String(s || "")
      .replace(/[\u30a1-\u30f6]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60)) // カタカナ→ひらがな
      .replace(/[\s　]/g, "")
      .toLowerCase();
  const targetKana = norm(kana);
  const targetName = norm(name);

  try {
    const rows = await sbFetch("customers?select=id,name,kana");
    const hits = (rows || []).filter((c) => {
      const ck = norm(c.kana);
      const cn = norm(c.name);
      return (targetKana && ck && ck === targetKana) || (targetName && cn && cn === targetName);
    });
    if (hits.length === 1) {
      return { customerId: hits[0].id, isNew: false, matchedName: hits[0].name };
    }
  } catch (e) {
    console.error(`[${VERSION}] customer match error:`, e);
  }

  // 一意に決まらない → 仮カルテ新規作成(既存の流儀に合わせる)
  const customer = await sbInsert("customers", {
    name: name || "HPBのお客様",
    kana: kana || null,
    phone: null,
    birthday: null,
    gender: "female",
    notes: "[HPB予約で自動作成]",
    join_date: jstToday(),
    line_user_id: null,
  });
  return { customerId: customer.id, isNew: true, matchedName: null };
}

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

// ---------- 日付ユーティリティ(JST・toISOString禁止ルール準拠) ----------
function jstToday() {
  const t = new Date(Date.now() + 9 * 3600 * 1000);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

function weekdayJP(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ["日", "月", "火", "水", "木", "金", "土"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function formatDateJP(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${weekdayJP(dateStr)})`;
}

function hhmmToMin(hhmm) {
  const [h, m] = String(hhmm).slice(0, 5).split(":").map(Number);
  return h * 60 + m;
}

function minToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

// ---------- オーナー通知(LINE push・トークン自動発行はwebhookと同方式) ----------
let cachedToken = null;

async function getAccessToken() {
  if (process.env.LINE_CHANNEL_ACCESS_TOKEN) return process.env.LINE_CHANNEL_ACCESS_TOKEN.trim();
  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.token;
  const res = await fetch("https://api.line.me/oauth2/v3/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: (process.env.LINE_CHANNEL_ID || "").trim(),
      client_secret: (process.env.LINE_CHANNEL_SECRET || "").trim(),
    }).toString(),
  });
  if (!res.ok) throw new Error(`token issue failed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in - 60) * 1000, 60000),
  };
  return cachedToken.token;
}

async function notifyOwner(message) {
  if (!process.env.OWNER_LINE_USER_ID) return;
  const token = await getAccessToken();
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      to: process.env.OWNER_LINE_USER_ID,
      messages: [{ type: "text", text: message }],
    }),
  });
  if (!res.ok) console.error(`[${VERSION}] owner push ${res.status}: ${await res.text()}`);
}
