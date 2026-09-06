// ═══════════════════════════════════════════
// /api/register-customer.js  (REG-v1)
// LINEからのカルテ登録（新規作成 ＋ 既存カルテへの紐付け）
//
// 設計方針:
//  ・INSERT原則を維持する。既存カルテの値を上書きすることは一切しない。
//    既存カルテに書き込むのは「空欄の列だけ」（line_user_id を含む）。
//  ・自動で紐付けるのは「電話番号がちょうど1件一致・かつLINE未連携」の時のみ。
//    複数一致・他アカウント連携済みは保存せずオーナーへ通知して手動対応。
//  ・判断材料を外部に出さない（お客様への文言は一律にする）。
// ═══════════════════════════════════════════

const B = require("./_lib/booking.js");
const { getProfile, notifyOwner } = require("./_lib/line.js");

const VERSION = "REG-v1";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sb(path, opts = {}) {
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
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

const digits = (s) => String(s || "").replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, "");
const kataToHira = (s) => String(s || "").replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const isBlank = (v) => v === null || v === undefined || String(v).trim() === "";

module.exports = async (req, res) => {
  try {
    // 動作確認用
    if (req.method === "GET" && !req.query.t) {
      return res.status(200).json({ ok: true, version: VERSION });
    }

    const token = (req.query.t || (req.body && req.body.token) || "").toString();
    const session = await B.findSessionByToken(token);
    if (!session) {
      return res.status(200).json({ ok: false, error: "expired" });
    }
    const userId = session.line_user_id;

    // 既に連携済みかを先に確認する
    const linkedRows = await sb(`customers?line_user_id=eq.${encodeURIComponent(userId)}&select=id,name`);
    const alreadyLinked = linkedRows && linkedRows[0];

    // ── ページ表示用 ──
    if (req.method === "GET") {
      let displayName = "";
      try { displayName = (await getProfile(userId)).displayName || ""; } catch (e) {}
      return res.status(200).json({
        ok: true,
        version: VERSION,
        displayName,
        already: alreadyLinked ? { name: alreadyLinked.name } : null,
      });
    }

    if (req.method !== "POST") return res.status(405).json({ ok: false });

    if (alreadyLinked) {
      return res.status(200).json({ ok: true, status: "already", name: alreadyLinked.name });
    }

    // ── 入力の検証 ──
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const kana = kataToHira(String(body.kana || "").trim());
    const phone = digits(body.phone);
    const birthday = String(body.birthday || "").trim(); // YYYY-MM-DD or ""
    const gender = ["female", "male", "other"].includes(body.gender) ? body.gender : "female";

    if (!name) return res.status(200).json({ ok: false, error: "name" });
    if (!/^0\d{9,10}$/.test(phone)) return res.status(200).json({ ok: false, error: "phone" });
    if (birthday && !/^\d{4}-\d{2}-\d{2}$/.test(birthday)) {
      return res.status(200).json({ ok: false, error: "birthday" });
    }

    // ── 電話番号で既存カルテを照合 ──
    const rows = await sb("customers?select=id,name,kana,phone,birthday,gender,line_user_id,notes&phone=not.is.null");
    const hits = (rows || []).filter((c) => digits(c.phone) === phone);

    let profileName = "";
    try { profileName = (await getProfile(userId)).displayName || ""; } catch (e) {}

    // 複数一致・他アカウント連携済み → 保存せずオーナーへ通知
    if (hits.length > 1 || (hits.length === 1 && hits[0].line_user_id)) {
      await notifyOwner(
        `⚠️ [要対応] LINEからのカルテ登録を保留しました\n` +
        `LINE表示名: ${profileName}\n入力: ${name} / ${phone}\n` +
        `理由: ${hits.length > 1 ? "同じ電話番号のカルテが複数あります" : "そのカルテは既に別のLINEと連携済みです"}\n` +
        `アプリのカルテから手動でご確認ください。`
      );
      return res.status(200).json({ ok: true, status: "manual" });
    }

    // ちょうど1件一致・未連携 → 既存カルテに紐付け（空欄だけ補完）
    if (hits.length === 1) {
      const c = hits[0];
      const patch = { line_user_id: userId };
      if (isBlank(c.kana) && kana) patch.kana = kana;
      if (isBlank(c.birthday) && birthday) patch.birthday = birthday;
      await sb(`customers?id=eq.${c.id}`, { method: "PATCH", body: JSON.stringify(patch) });
      await notifyOwner(`🔗 LINEカルテ連携: ${c.name} 様（${profileName}）`);
      return res.status(200).json({ ok: true, status: "linked", name: c.name });
    }

    // 一致なし → 新規カルテを作成
    const today = B.jstNow().dateStr;
    const created = await sb("customers", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify([{
        name,
        kana: kana || null,
        phone,
        birthday: birthday || null,
        gender,
        notes: "[LINEから登録]",
        join_date: today,
        line_user_id: userId,
      }]),
    });
    const newC = created && created[0];
    await notifyOwner(`🆕 LINEから新しいカルテが登録されました\n${name} 様 / ${phone}（${profileName}）`);
    return res.status(200).json({ ok: true, status: "created", name: (newC && newC.name) || name });

  } catch (e) {
    console.error(`[${VERSION}]`, e);
    try { await notifyOwner(`⚠️ [${VERSION}] カルテ登録でエラー\n${String(e).slice(0, 300)}`); } catch (e2) {}
    return res.status(200).json({ ok: false, error: "server" });
  }
};
