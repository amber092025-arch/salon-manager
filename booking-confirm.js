// ═══════════════════════════════════════════
// /api/booking-confirm.js  (LINE-v1)
// カレンダー予約ページ用: 予約確定
// POST /api/booking-confirm  body: { t, date, time, message }
// 直前再チェック → appointments+visits INSERT → お客様/オーナーへLINE通知
// ═══════════════════════════════════════════

const B = require("./_lib/booking.js");
const L = require("./_lib/line.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { t, date, time, message, menuId } = body;

    const session = await B.findSessionByToken(t);
    if (!session) return res.status(401).json({ ok: false, error: "expired" });
    const userId = session.line_user_id;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const menus = await B.getMenus();
    const menu = menus.find((m) => m.id === Number(menuId));
    if (!menu) return res.status(400).json({ ok: false, error: "bad_menu" });

    const settings = await B.getSettings();

    // リスクヘッジ原則③: 確定直前に空きを必ず再チェック（選択メニューのdurationで）
    const free = await B.isSlotFree(date, time, settings, menu.duration);
    if (!free) return res.status(409).json({ ok: false, error: "taken" });

    const profile = await L.getProfile(userId);
    const { customer, isNew } = await B.findOrCreateCustomer(userId, profile.displayName);
    await B.createBooking({
      customerId: customer.id,
      dateStr: date,
      time,
      userId,
      displayName: profile.displayName,
      isNew,
      customerMessage: message,
      menu,
    });
    await B.clearSession(userId);

    const phoneNote = process.env.SALON_PHONE ? `（TEL: ${process.env.SALON_PHONE}）` : "";

    // お客様のLINEトークにも確認を残す
    await L.push(userId, [
      L.text(
        `ご予約を承りました✂️\n\n📅 ${B.formatDateJP(date)} ${time}〜\nメニュー: ${menu.name}\n\n変更・キャンセルはお電話にてお願いいたします${phoneNote}。\nご来店お待ちしております！`
      ),
    ]).catch((e) => console.error("customer push:", e));

    // オーナー通知（LINE push＋メール）
    await L.notifyOwner(
      `🔔 [LINE-v1] カレンダー予約が入りました\n\n📅 ${B.formatDateJP(date)} ${time}〜\nメニュー: ${menu.name}（${menu.price}円・約${menu.duration}分）\n👤 ${profile.displayName}${isNew ? "（新規・空カルテ自動作成）" : ""}${message ? `\n💬 ${String(message).slice(0, 200)}` : ""}\n\n★サロンボード（HPB）側の同時間帯を手動でブロックしてください`
    );

    return res.status(200).json({ ok: true, date, time, dateLabel: B.formatDateJP(date), menu });
  } catch (e) {
    console.error("booking-confirm error:", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
