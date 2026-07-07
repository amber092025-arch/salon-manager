// ═══════════════════════════════════════════
// /api/booking-slots.js  (LINE-v1)
// カレンダー予約ページ用: 14日分の空き状況を返す
// GET /api/booking-slots?t={webToken}
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
    const settings = await B.getSettings();
    const grid = await B.buildGrid(settings);
    return res.status(200).json({
      ok: true,
      salonName: process.env.SALON_NAME || "Amber",
      ...grid,
    });
  } catch (e) {
    console.error("booking-slots error:", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
