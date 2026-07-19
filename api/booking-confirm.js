// ═══════════════════════════════════════════
// /api/booking-confirm.js  (LINE-v3)
// カレンダー予約ページ用: 予約確定（複数メニュー対応）
// POST /api/booking-confirm  body: { t, date, time, message, menuIds:[..] }（旧形式menuIdも受付）
// 受付停止チェック → 直前再チェック(合計時間) → appointments+visits INSERT → お客様/オーナーへLINE通知
// ═══════════════════════════════════════════

const B = require("./_lib/booking.js");
const L = require("./_lib/line.js");

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).end();
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const { t, date, time, message, menuId, menuIds } = body;

    const session = await B.findSessionByToken(t);
    if (!session) return res.status(401).json({ ok: false, error: "expired" });
    const userId = session.line_user_id;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || !/^\d{2}:\d{2}$/.test(time || "")) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const settings = await B.getSettings();

    // 受付停止スイッチ（停止前に発行済みのリンクからの確定もここで止める）
    const enabled = settings.lineBookingEnabled;
    if (enabled === false || String(enabled).trim() === "false") {
      return res.status(403).json({ ok: false, error: "paused" });
    }

    const menus = await B.getMenus();
    const ids = (Array.isArray(menuIds) && menuIds.length ? menuIds : (menuId ? [menuId] : []))
      .map(Number).filter(Boolean);
    const selected = ids.map((id) => menus.find((m) => m.id === id)).filter(Boolean);
    if (selected.length === 0 || selected.length !== ids.length) {
      return res.status(400).json({ ok: false, error: "bad_menu" });
    }
    const totalDuration = selected.reduce((s, m) => s + m.duration, 0);
    const totalPrice = selected.reduce((s, m) => s + (m.price || 0), 0);

    // リスクヘッジ原則③: 確定直前に空きを必ず再チェック（合計施術時間で）
    const free = await B.isSlotFree(date, time, settings, totalDuration);
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
      menus: selected,
    });
    await B.clearSession(userId);

    const phoneNote = process.env.SALON_PHONE ? `（TEL: ${process.env.SALON_PHONE}）` : "";
    const menuNames = selected.map((m) => m.name).join("\n・");

    // お客様のLINEトークにも確認を残す
    await L.push(userId, [
      L.text(
        `ご予約を承りました✂️\n\n📅 ${B.formatDateJP(date)} ${time}〜\nメニュー:\n・${menuNames}\n合計: ¥${totalPrice.toLocaleString()}（約${totalDuration}分）\n\n変更・キャンセルはお電話にてお願いいたします${phoneNote}。\nご来店お待ちしております！`
      ),
    ]).catch((e) => console.error("customer push:", e));

    // オーナー通知（LINE push＋メール）
    await L.notifyOwner(
      `🔔 [LINE-v3] カレンダー予約が入りました\n\n📅 ${B.formatDateJP(date)} ${time}〜\nメニュー:\n・${menuNames}\n合計: ¥${totalPrice.toLocaleString()}・約${totalDuration}分\n👤 ${profile.displayName}${isNew ? "（新規・空カルテ自動作成）" : ""}${message ? `\n💬 ${String(message).slice(0, 200)}` : ""}\n\n★サロンボード（HPB）側の同時間帯を手動でブロックしてください`
    );

    return res.status(200).json({
      ok: true, date, time, dateLabel: B.formatDateJP(date),
      menus: selected, totalPrice, totalDuration,
    });
  } catch (e) {
    console.error("booking-confirm error:", e);
    return res.status(500).json({ ok: false, error: "server" });
  }
};
