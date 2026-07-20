// ═══════════════════════════════════════════
// /api/line-remind.js  (REMIND-v1)
// 前日リマインダー: 毎日定時(vercel.jsonのcron設定・既定19:00 JST)に自動実行され、
// 「明日」に予約があるLINE連携済みのお客様へ確認メッセージをpushする
//
// 設計:
//   ・文面/ON-OFFはsettingsテーブルの lineRemind ({enabled, text}) を参照。
//     未設定なら既定文面で送信(ON扱い)。差し込みタグ: {お名前} {日付} {時間} {メニュー}
//   ・二重送信防止: appointments.line_reminded を送信後にtrueへ(1列のみのPATCH)。
//     手動でURLを叩かれても、送信済みの予約には二度と送られない
//   ・LINE未連携のお客様はスキップ
//   ・1件でも送ったらオーナーへ送信結果のサマリーをLINE通知
// ═══════════════════════════════════════════

const VERSION = "REMIND-v1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const DEFAULT_TEXT = "{お名前}様\n明日 {日付} {時間}〜 ご予約をお受けしております✂️\nご来店お待ちしております！\n\n変更・キャンセルの際はお電話にてご連絡ください。";

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const conf = await getMessageConfig("lineRemind");
    if (conf.enabled === false) return res.status(200).json({ ok: true, sent: 0, reason: "disabled" });

    const tomorrow = jstDateStr(1);
    const appts = await sbFetch(
      `appointments?date=eq.${tomorrow}&select=id,customer_id,date,time,menu_ids,line_reminded&order=time.asc`
    );
    if (!appts || appts.length === 0) return res.status(200).json({ ok: true, sent: 0, reason: "no_appointments" });

    // お客様情報をまとめて取得
    const customers = await sbFetch("customers?select=id,name,line_user_id");
    const custMap = {};
    (customers || []).forEach((c) => { custMap[c.id] = c; });

    // メニュー名の解決用(全件1回だけ取得)
    let menus = [];
    try { menus = (await sbFetch("menus?select=id,name")) || []; } catch (e) {}

    let sent = 0, skippedNoLine = 0, skippedDone = 0, failed = 0;
    const sentNames = [];
    for (const a of appts) {
      if (a.line_reminded) { skippedDone++; continue; }
      const cust = custMap[a.customer_id];
      if (!cust || !cust.line_user_id) { skippedNoLine++; continue; }
      try {
        const message = buildMessage(conf.text || DEFAULT_TEXT, a, cust, menus);
        await pushLine(cust.line_user_id, message);
        // 【1列のみのPATCH】二重送信防止フラグ
        await sbFetch(`appointments?id=eq.${a.id}`, { method: "PATCH", body: JSON.stringify({ line_reminded: true }) });
        sent++;
        sentNames.push(`${String(a.time || "").slice(0, 5)} ${cust.name || "不明"}様`);
      } catch (e) {
        console.error(`[${VERSION}] push failed appt=${a.id}:`, e);
        failed++;
      }
    }

    if (sent > 0 || failed > 0) {
      await notifyOwner(
        `⏰ [${VERSION}] 明日(${formatDateJP(tomorrow)})の予約リマインダーを送信しました\n\n送信 ${sent}件${sentNames.length ? `\n・${sentNames.join("\n・")}` : ""}${skippedNoLine ? `\nLINE未連携のためスキップ ${skippedNoLine}件` : ""}${failed ? `\n⚠️送信失敗 ${failed}件(トークを確認してください)` : ""}`
      ).catch((e) => console.error(`[${VERSION}] owner notify:`, e));
    }

    return res.status(200).json({ ok: true, sent, skippedNoLine, skippedDone, failed });
  } catch (e) {
    console.error(`[${VERSION}] fatal:`, e);
    return res.status(200).json({ ok: false });
  }
};

// ---------- 共通部品 ----------
async function getMessageConfig(key) {
  try {
    const rows = await sbFetch(`settings?key=eq.${key}&select=key,value`);
    const raw = rows && rows[0] && rows[0].value;
    if (!raw) return { enabled: true, text: null };
    const v = JSON.parse(raw);
    return { enabled: v.enabled !== false, text: v.text || null };
  } catch (e) {
    return { enabled: true, text: null };
  }
}

function buildMessage(template, appt, cust, menus) {
  let menuText = "ー";
  if (appt.menu_ids && appt.menu_ids.length > 0) {
    const names = appt.menu_ids
      .map((id) => (menus || []).find((m) => m.id === Number(id)))
      .filter(Boolean)
      .map((m) => m.name);
    if (names.length > 0) menuText = names.join("、");
  }
  return String(template)
    .split("{お名前}").join(cust.name || "お客")
    .split("{日付}").join(formatDateJP(appt.date))
    .split("{時間}").join(String(appt.time || "").slice(0, 5))
    .split("{メニュー}").join(menuText);
}

function jstDateStr(addDays) {
  const t = new Date(Date.now() + 9 * 3600 * 1000 + (addDays || 0) * 86400 * 1000);
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
  if (!res.ok) throw new Error(`Supabase ${res.status} (${path}): ${await res.text()}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

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
  cachedToken = { token: data.access_token, expiresAt: Date.now() + Math.max((data.expires_in - 60) * 1000, 60000) };
  return cachedToken.token;
}

async function pushLine(to, text) {
  const token = await getAccessToken();
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ to, messages: [{ type: "text", text }] }),
  });
  if (!res.ok) throw new Error(`push ${res.status}: ${await res.text()}`);
}

async function notifyOwner(message) {
  if (!process.env.OWNER_LINE_USER_ID) return;
  await pushLine(process.env.OWNER_LINE_USER_ID, message);
}
