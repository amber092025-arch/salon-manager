// ═══════════════════════════════════════════
// /api/booking-slots.js  (LINE-v3)
// カレンダー予約ページ用:
//   ?t={webToken}                  → メニュー一覧のみ返す（①メニュー選択用・画像なしで軽量）
//   ?t={webToken}&images=1        → メニュー画像だけ返す（後追い取得・失敗しても予約は可能）
//   ?t={webToken}&menuIds=1,2,3    → 選択メニュー合計のdurationで14日分の空き状況を返す（複数メニュー対応）
//   ?t={webToken}&menuId={id}      → 旧形式(単数)。menuIdsと同じ扱い
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
    const idsParam = (req.query && (req.query.menuIds || req.query.menuId)) || null;

    if (!idsParam) {
      // ①メニュー選択ステップ: メニュー一覧のみ返す（グリッド計算はしない・軽量）
      // known: このLINEアカウントが既にカルテ連携済みか(未連携の人にだけ確認画面で電話番号を聞く)
      const known = await B.isKnownUser(session.line_user_id);
      return res.status(200).json({
        ok: true,
        salonName: process.env.SALON_NAME || "Amber",
        known,
        menus,
      });
    }

    const ids = String(idsParam).split(",").map(Number).filter(Boolean);
    const selected = ids.map((id) => menus.find((m) => m.id === id)).filter(Boolean);
    if (selected.length === 0 || selected.length !== ids.length) {
      return res.status(400).json({ ok: false, error: "bad_menu" });
    }

    const totalDuration = selected.reduce((s, m) => s + m.duration, 0);
    const totalPrice = selected.reduce((s, m) => s + (m.price || 0), 0);

    const settings = await B.getSettings();
    const grid = await B.buildGrid(settings, totalDuration);
    return res.status(200).json({
      ok: true,
      salonName: process.env.SALON_NAME || "Amber",
      menus: selected,
      totalPrice,
      ...grid, // rows / days / slotUnit / duration(=合計時間)
    });
  } catch (e) {
    console.error("booking-slots error:", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
