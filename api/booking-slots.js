// ═══════════════════════════════════════════
// /api/booking-slots.js  (LINE-v1)
// カレンダー予約ページ用:
//   ?t={webToken}                → メニュー一覧のみ返す（①メニュー選択用）
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

