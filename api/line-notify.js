// ═══════════════════════════════════════════
// /api/line-notify.js  (NOTIFY-v1)
// アプリで予約を登録した直後の「次回予約メモ」LINE自動送信
// POST { apptId } → 該当予約のお客様にLINE連携があれば確認メッセージをpush
//
// 設計:
//   ・文面/ON-OFFはsettingsテーブルの lineNotifyBooked ({enabled, text}) を参照。
//     未設定なら既定文面で送信(ON扱い)。差し込みタグ: {お名前} {日付} {時間} {メニュー}
//   ・二重送信防止: appointments.line_notified を送信後にtrueへ(1列のみのPATCH)。
//     既にtrueなら何もしない → 認証なしでも悪用余地がほぼ無い(送れるのは各予約1回・定型文のみ)
//   ・LINE未連携のお客様は静かにスキップ(エラーにしない)
// ═══════════════════════════════════════════

const VERSION = "NOTIFY-v1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const DEFAULT_TEXT = "{お名前}様\nご予約ありがとうございます✂️\n\n📅 {日付} {時間}〜\nメニュー: {メニュー}\n\nご来店お待ちしております！";

module.exports = async (req, res) => {
  if (req.method === "GET") {
    return res.status(200).json({ ok: true, version: VERSION });
  }
  if (req.method !== "POST") return res.status(405).end();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const apptId = Number(body.apptId);
    if (!apptId) return res.status(400).json({ ok: false, error: "bad_request" });

    const appts = await sbFetch(`appointments?id=eq.${apptId}&select=id,customer_id,date,time,menu_ids,line_notified,notes`);
    const appt = appts && appts[0];
    if (!appt) return res.status(404).json({ ok: false, error: "not_found" });
    if (appt.line_notified) return res.status(200).json({ ok: true, sent: false, reason: "already" });

    // 設定(ON/OFF・文面)を読む。未設定なら既定でON
    const conf = await getMessageConfig("lineNotifyBooked");
    if (conf.enabled === false) return res.status(200).json({ ok: true, sent: false, reason: "disabled" });

    const custs = await sbFetch(`customers?id=eq.${appt.customer_id}&select=id,name,line_user_id`);
    const cust = custs && custs[0];
    if (!cust || !cust.line_user_id) return res.status(200).json({ ok: true, sent: false, reason: "no_line" });

    const message = await buildMessage(conf.text || DEFAULT_TEXT, appt, cust);
    await pushLine(cust.line_user_id, message);

    // 【1列のみのPATCH】二重送信防止フラグ
    await sbFetch(`appointments?id=eq.${appt.id}`, { method: "PATCH", body: JSON.stringify({ line_notified: true }) });

    return res.status(200).json({ ok: true, sent: true });
  } catch (e) {
    console.error(`[${VERSION}] error:`, e);
    return res.status(200).json({ ok: false }); // アプリ側の予約処理は既に完了しているため、通知失敗でエラー扱いにしない
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

async function buildMessage(template, appt, cust) {
  let menuText = "ー";
  try {
    if (appt.menu_ids && appt.menu_ids.length > 0) {
      const menus = await sbFetch("menus?select=id,name");
      const names = appt.menu_ids
        .map((id) => (menus || []).find((m) => m.id === Number(id)))
        .filter(Boolean)
        .map((m) => m.name);
      if (names.length > 0) menuText = names.join("、");
    }
  } catch (e) {}
  return String(template)
    .split("{お名前}").join(cust.name || "お客")
    .split("{日付}").join(formatDateJP(appt.date))
    .split("{時間}").join(String(appt.time || "").slice(0, 5))
    .split("{メニュー}").join(menuText);
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

function weekdayJP(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return ["日", "月", "火", "水", "木", "金", "土"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}
function formatDateJP(dateStr) {
  const [, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${weekdayJP(dateStr)})`;
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
