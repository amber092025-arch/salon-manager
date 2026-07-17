// ═══════════════════════════════════════════
// /api/hpb-mail.js  (HPB-v1)
// HPB(サロンボード)予約通知メール取り込み: CloudMailin → 解析 → appointments INSERT → 通知
//
// 経路: HPB予約通知メール → メールの自動転送 → CloudMailin(JSON Normalized)
//       → POST https://salon-manager-sigma.vercel.app/api/hpb-mail?token=XXXX
//
// 方針(Phase 4初期版・設計書どおり):
//   ・新規予約メールのみ自動登録。キャンセル/変更は通知のみ(手動対応)
//   ・重複防止: notesに[HPB]予約番号を記録し、INSERT前に存在チェック
//   ・解析失敗時は本文を添えてオーナーへLINE通知(手動登録できるように)
//   ・INSERTのみ。UPDATE/DELETEなし(リスクヘッジ原則②)
//
// 必要な環境変数:
//   HPB_MAIL_TOKEN     … 推測不能なランダム文字列(偽メールPOST対策)。CloudMailinの宛先URLの?token=に同じ値を付ける
//   SUPABASE_URL / SUPABASE_KEY … 既存
//   LINE_CHANNEL_ID / LINE_CHANNEL_SECRET … 既存(オーナー通知用トークン自動発行)
//   OWNER_LINE_USER_ID … 既存(オーナー通知先)
//   SALON_PHONE        … 任意
// ═══════════════════════════════════════════

const VERSION = "HPB-v1";
const HPB_COLOR = "#f25c05"; // ホットペッパーオレンジ(出所タグ原則④)
const DEFAULT_DURATION = 120; // 施術時間目安が読めなかった場合の既定(分)

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

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
  const { subject, text } = mail;
  const excerpt = (subject ? `件名: ${subject}\n` : "") + text.slice(0, 600);

  // キャンセル・変更メール(書式未確認) → 通知のみ・手動対応
  if (/キャンセル|取消|取り消し|変更/.test(subject) || /予約(が|を)?(キャンセル|取消|取り消し|変更)/.test(text)) {
    await notifyOwner(`📩 [${VERSION}] HPBのキャンセル/変更メールを受信しました(自動処理対象外)\n予約表とサロンボードを確認して手動で対応してください。\n\n${excerpt}`);
    return "cancel-or-change-notified";
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
  const dtM = text.match(/■来店日時\s*\n\s*(\d{4})年(\d{1,2})月(\d{1,2})日.*?(\d{1,2}):(\d{2})/);
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

  // ---------- appointments INSERT(出所タグ: notesに[HPB]+予約番号、HPBオレンジ) ----------
  let notes = `${dupTag}\n${name || "氏名不明"}${kana ? `（${kana}）` : ""}`;
  if (menuName) notes += `\nメニュー: ${menuName}`;
  if (total !== null) notes += `\n金額: ${total.toLocaleString()}円`;
  notes += `\n(HPBメール自動取り込み)`;

  await sbInsert("appointments", {
    customer_id: customerId,
    date: dateStr,
    time: time,
    end_time: endTime,
    duration: duration,
    menu_ids: [],
    notes: notes,
    color: HPB_COLOR,
    paid: false,
    shimeika: "shimeika",
    customer_type: isNew ? "new" : "existing",
  });

  await notifyOwner(
    `🟠 [${VERSION}] HPB予約を予約表に自動登録しました\n\n📅 ${formatDateJP(dateStr)} ${time}〜${endTime}\n👤 ${name || "氏名不明"}${kana ? `（${kana}）` : ""}${isNew ? "（新規・仮カルテ自動作成）" : matchedName ? `（既存カルテ: ${matchedName}）` : ""}\n💇 ${menuName || "メニュー不明"}${total !== null ? `\n💰 ${total.toLocaleString()}円` : ""}\n予約番号: ${bookingNo}`
  );
  return "inserted";
}

function pick(text, re) {
  const m = text.match(re);
  return m ? m[1].trim() : null;
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
