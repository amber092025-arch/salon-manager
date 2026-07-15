// ═══════════════════════════════════════════
// /api/liff-setup.js  (LINE-v1)
// LIFFアプリ（tallサイズ＝STEKiNA風モーダル）をAPI経由で登録する実験用エンドポイント
// 使い方: ブラウザで /api/liff-setup?s={LINE_CHANNEL_SECRET} を開く（1回だけでOK）
// 成功: {ok:true, liffId:"xxxx-yyyy"} → settingsにliffBookingIdとして自動保存され、
//       以降のwebhookの予約ボタンがLIFF URL（モーダル表示）に切り替わる
// 失敗: {ok:false, step, status, body} → Messaging APIチャネルではLIFF登録不可の可能性
//       （その場合は現行の全画面表示のまま。何も壊れない）
// ═══════════════════════════════════════════

const B = require("./_lib/booking.js");
const L = require("./_lib/line.js");

module.exports = async (req, res) => {
  try {
    // 簡易ガード: channel secretを知っているオーナーのみ実行可能
    const s = (req.query && req.query.s) || "";
    if (!s || s !== (process.env.LINE_CHANNEL_SECRET || "").trim()) {
      return res.status(401).json({ ok: false, error: "auth" });
    }

    const token = await L.getAccessToken();
    const base = (process.env.BOOKING_URL || "https://salon-manager-sigma.vercel.app/booking.html").trim();

    // 1. 既存のLIFFアプリ一覧を確認（404=まだ1つも無い、は正常）
    const listRes = await fetch("https://api.line.me/liff/v1/apps", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listText = await listRes.text();
    if (!listRes.ok && listRes.status !== 404) {
      return res.status(200).json({
        ok: false,
        step: "list",
        status: listRes.status,
        body: listText.slice(0, 300),
      });
    }
    let apps = [];
    try {
      apps = JSON.parse(listText).apps || [];
    } catch (e) { /* 404等でJSONでない場合は空扱い */ }

    let existing = apps.find((a) => a.view && a.view.url === base);
    let liffId = existing && existing.liffId;
    let created = false;

    // 2. 無ければtallサイズ（STEKiNA風の高さのモーダル）で新規登録
    if (!liffId) {
      const createRes = await fetch("https://api.line.me/liff/v1/apps", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          view: { type: "tall", url: base },
          description: "Amber LINE予約",
          permanentLinkPattern: "concat",
        }),
      });
      const createText = await createRes.text();
      if (!createRes.ok) {
        return res.status(200).json({
          ok: false,
          step: "create",
          status: createRes.status,
          body: createText.slice(0, 300),
        });
      }
      liffId = JSON.parse(createText).liffId;
      created = true;
    }

    // 3. settingsに保存 → webhookが自動的にLIFF URLを使い始める
    await B.saveSetting("liffBookingId", liffId);

    return res.status(200).json({
      ok: true,
      liffId,
      created,
      liffUrl: `https://liff.line.me/${liffId}`,
      note: "webhookは次の「予約」からLIFF URL（モーダル表示）を使います",
    });
  } catch (e) {
    console.error("liff-setup error:", e);
    return res.status(500).json({ ok: false, error: String(e).slice(0, 300) });
  }
};
