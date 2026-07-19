// ═══════════════════════════════════════════
// /api/booking-slots.js  (LINE-v2)
// カレンダー予約ページ用:
//   ?t={webToken}                → メニュー一覧のみ返す（①メニュー選択用・画像なしで軽量）
//   ?t={webToken}&images=1      → メニュー画像だけ返す（ページ表示後に後追い取得・失敗しても予約は可能）
//   ?t={webToken}&menuId={id}    → 選択メニューのdurationで14日分の空き状況を返す（②日時選択用）
// ═══════════════════════════════════════════

const B = require("./_lib/booking.js");

module.exports = async (req, res) => {
  if (req.method !== "GET") return res.status(405).end();
  try {
    const token = (req.query && req.query.t) || "";
    const session = await B.findSessionByToken(token);
    if (!session) {
      return res.status(401).json({ ok: false, error: "expired" });
    }

    // メニュー画像の後追い取得（軽量一覧とは分離。ここが失敗しても予約フローは動く）
    if (req.query && req.query.images) {
      const images = await B.getMenuImages();
      return res.status(200).json({ ok: true, images });
    }

    const menus = await B.getMenus();
    const menuId = req.query && req.query.menuId ? Number(req.query.menuId) : null;

    if (!menuId) {
      // ①メニュー選択ステップ: メニュー一覧のみ返す（グリッド計算はしない・軽量）
      return res.status(200).json({
        ok: true,
        salonName: process.env.SALON_NAME || "Amber",
        menus,
      });
    }

    const menu = menus.find((m) => m.id === menuId);
    if (!menu) return res.status(400).json({ ok: false, error: "bad_menu" });

    const settings = await B.getSettings();
    const grid = await B.buildGrid(settings, menu.duration);
    return res.status(200).json({
      ok: true,
      salonName: process.env.SALON_NAME || "Amber",
      menu,
      ...grid,
    });
  } catch (e) {
    console.error("booking-slots error:", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
