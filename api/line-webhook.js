// ═══════════════════════════════════════════
// /api/line-webhook.js  (LINE-v1)
// LINE Messaging API Webhook: 署名検証 → 会話フロー → appointments INSERT → 通知
//
// 必要な環境変数（Vercelダッシュボード → Settings → Environment Variables）:
//   LINE_CHANNEL_ID           … OA ManagerのMessaging API画面のChannel ID
//   LINE_CHANNEL_SECRET       … 同画面のChannel secret
//   （LINE_CHANNEL_ACCESS_TOKEN … 任意。設定されていればそれを優先使用。
//     未設定ならID+secretからステートレストークンを自動発行するので不要）
//   SUPABASE_URL              … 例 https://xxxx.supabase.co
//   SUPABASE_KEY              … anonキー（RLS導入後はservice roleへ差し替え）
//   OWNER_LINE_USER_ID        … オーナー通知用（後述の「ID」コマンドで取得）※任意
//   RESEND_API_KEY            … メール通知用（resend.com）※任意
//   OWNER_EMAIL               … メール通知の宛先 ※任意
//   MAIL_FROM                 … 送信元（未設定なら onboarding@resend.dev）※任意
//   SALON_NAME                … 未設定なら「Amber」
//   SALON_PHONE               … 設定するとメッセージに電話番号を併記 ※任意
// ═══════════════════════════════════════════

const crypto = require("crypto");
const B = require("./_lib/booking.js");

const VERSION = "LINE-v2";
const SALON_NAME = process.env.SALON_NAME || "Amber";
const PHONE_NOTE = process.env.SALON_PHONE ? `（TEL: ${process.env.SALON_PHONE}）` : "";
const TIME_PAGE_SIZE = 12; // Quick Replyは最大13個。12件+「もっと見る」

// 受付停止判定（settings.lineBookingEnabled）
// アプリ保存(JSON文字列"false")・SQL直接投入(false/"false")のどちらでも判定できるようにする。
// 未設定(undefined)は「受付中」扱い。
function bookingDisabled(settings) {
  const v = settings && settings.lineBookingEnabled;
  return v === false || String(v).trim() === "false";
}

const PAUSED_MESSAGE = `申し訳ありません、ただいまLINEでのご予約受付を一時停止しております。\nお手数ですがお電話にてお問い合わせください${PHONE_NOTE}。`;

// ---------- エントリポイント ----------
module.exports = async (req, res) => {
  // GET: 疎通・環境変数チェック用（秘密情報は返さない）
  if (req.method === "GET") {
    // ?test=token を付けるとトークン自動発行のテストも行う（トークン自体は返さない）
    let tokenTest = "skipped";
    if (req.query && req.query.test === "token") {
      try {
        await getAccessToken();
        tokenTest = "OK";
      } catch (e) {
        tokenTest = `NG: ${String(e).slice(0, 200)}`;
      }
    }
    return res.status(200).json({
      ok: true,
      version: VERSION,
      tokenTest,
      // 期待値: idLen=10, secretLen=32（trim後）。違っていたら値の貼り間違い
      idLen: (process.env.LINE_CHANNEL_ID || "").trim().length,
      secretLen: (process.env.LINE_CHANNEL_SECRET || "").trim().length,
      env: {
        LINE_CHANNEL_ID: !!process.env.LINE_CHANNEL_ID,
        LINE_CHANNEL_ACCESS_TOKEN: !!process.env.LINE_CHANNEL_ACCESS_TOKEN,
        LINE_CHANNEL_SECRET: !!process.env.LINE_CHANNEL_SECRET,
        SUPABASE_URL: !!process.env.SUPABASE_URL,
        SUPABASE_KEY: !!process.env.SUPABASE_KEY,
        OWNER_LINE_USER_ID: !!process.env.OWNER_LINE_USER_ID,
        RESEND_API_KEY: !!process.env.RESEND_API_KEY,
        OWNER_EMAIL: !!process.env.OWNER_EMAIL,
      },
    });
  }
  if (req.method !== "POST") return res.status(405).end();

  // 署名検証（channel secret）
  const raw = await getRawBody(req);
  if (!verifySignature(raw, req.headers["x-line-signature"])) {
    return res.status(401).json({ error: "invalid signature" });
  }

  let body;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ error: "invalid body" });
  }

  // イベントごとに処理（1件の失敗が他を巻き込まないようtry/catch）
  for (const event of body.events || []) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error(`[${VERSION}] event error:`, e);
      // 原則⑤: 処理不能時はお客様を放置しない＋オーナーへ通知
      try {
        if (event.replyToken) {
          await reply(event.replyToken, [
            text(
              `申し訳ありません、システムエラーが発生しました。\nお手数ですがお電話にてご連絡ください${PHONE_NOTE}。`
            ),
          ]);
        }
        await notifyOwner(`⚠️ [${VERSION}] エラーが発生しました\n${String(e).slice(0, 300)}`);
      } catch (e2) {
        console.error(`[${VERSION}] fallback error:`, e2);
      }
    }
  }
  // LINEには常に200を返す（非200だとLINE側が再送を繰り返すため）
  return res.status(200).json({ ok: true });
};

// ---------- rawボディ取得と署名検証 ----------
async function getRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  if (chunks.length > 0) return Buffer.concat(chunks).toString("utf8");
  // ランタイムが先にbodyを消費していた場合のフォールバック
  if (req.body !== undefined && req.body !== null) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }
  return "";
}

function verifySignature(raw, signature) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret || !signature) return false;
  const mac = crypto.createHmac("sha256", secret).update(raw).digest("base64");
  const a = Buffer.from(mac);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- イベント処理 ----------
async function handleEvent(event) {
  const userId = event.source && event.source.userId;

  // 友だち追加
  if (event.type === "follow") {
    return reply(event.replyToken, [
      {
        ...text(
          `友だち追加ありがとうございます✂️\n${SALON_NAME}のLINE予約です。\n下のボタン、または「予約」と送信すると空き枠をご案内します。`
        ),
        quickReply: qr([msgItem("予約する", "予約")]),
      },
    ]);
  }

  // テキストメッセージ
  if (event.type === "message" && event.message && event.message.type === "text") {
    const t = (event.message.text || "").trim();

    // オーナー用: 自分のuserIdを確認するコマンド（OWNER_LINE_USER_ID設定用）
    if (/^(id|myid|ＩＤ)$/i.test(t)) {
      return reply(event.replyToken, [text(`あなたのLINE userId:\n${userId}`)]);
    }

    if (t.includes("予約") || /よやく/.test(t)) {
      return startFlow(event.replyToken, userId);
    }

    // 原則⑤: ボットが処理できないメッセージ → スタッフ確認＋オーナー通知
    const profile = await getProfile(userId);
    await notifyOwner(
      `📩 [要対応] LINEメッセージが届きました\n${profile.displayName}:\n「${t.slice(0, 500)}」\n\nLINE公式アカウントの管理画面から返信してください。`
    );
    return reply(event.replyToken, [
      {
        ...text(
          `メッセージありがとうございます。\nスタッフが確認して対応いたします。\n\nご予約は下のボタンからどうぞ。お急ぎの場合はお電話ください${PHONE_NOTE}。`
        ),
        quickReply: qr([msgItem("予約する", "予約")]),
      },
    ]);
  }

  // ボタン操作（postback）
  if (event.type === "postback") {
    const p = new URLSearchParams(event.postback.data || "");
    const a = p.get("a");
    if (a === "d") return showTimes(event.replyToken, userId, p.get("v"), 0);
    if (a === "more") return showTimes(event.replyToken, userId, p.get("d"), Number(p.get("o")) || 0);
    if (a === "t") return confirmStep(event.replyToken, userId, p.get("d"), p.get("v"));
    if (a === "yes") return finalize(event.replyToken, userId, p.get("d"), p.get("v"));
    if (a === "no") {
      await B.clearSession(userId);
      return reply(event.replyToken, [
        {
          ...text("かしこまりました。予約は確定していません。\nやり直す場合は下のボタンからどうぞ。"),
          quickReply: qr([msgItem("予約する", "予約")]),
        },
      ]);
    }
  }
  // それ以外のイベント（スタンプ等）は無応答でOK
}

// ---------- 会話フロー ----------
// Step 1: 空きのある日を最大4件提示＋カレンダーページへの本人専用リンク
async function startFlow(replyToken, userId) {
  const settings = await B.getSettings();
  // 受付停止スイッチ（アプリのLINE予約設定でOFFの場合）
  if (bookingDisabled(settings)) {
    return reply(replyToken, [text(PAUSED_MESSAGE)]);
  }
  // 14日以内に本当に空きが無いかの概算チェック（メニュー選択前なので一律デフォルト時間で判定）
  const dates = await B.findAvailableDates(settings, B.DEFAULT_DURATION);
  if (dates.length === 0) {
    return reply(replyToken, [
      text(
        `申し訳ありません、ただいま14日以内に空きがございません。\nお手数ですがお電話にてご相談ください${PHONE_NOTE}。`
      ),
    ]);
  }
  // カレンダーページ用の一時トークン（30分有効・本人専用）
  const webToken = crypto.randomBytes(16).toString("hex");
  await B.saveSession(userId, {
    step: "date",
    webToken,
    webTokenExp: Date.now() + 30 * 60 * 1000,
  });
  const base = (process.env.BOOKING_URL || "https://salon-manager-sigma.vercel.app/booking.html").trim();
  // LIFF登録済み（liff-setup実行済み）ならモーダル表示のLIFF URL、未登録なら通常URL
  const bookingUrl = settings.liffBookingId
    ? `https://liff.line.me/${settings.liffBookingId}?t=${webToken}`
    : `${base}?t=${webToken}`;
  // STEKiNA同様「カード1枚→ボタン1つ→即モーダル」の導線に統一（旧・日付ごとのテキストボタンは廃止）
  return reply(replyToken, [
    {
      type: "flex",
      altText: "空き状況を確認する",
      contents: {
        type: "bubble",
        body: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#FAF8F5",
          paddingAll: "24px",
          contents: [
            {
              type: "text",
              text: "Amber",
              weight: "bold",
              size: "xl",
              color: "#A8865A",
              align: "center",
            },
            { type: "separator", margin: "lg", color: "#E8E2DA" },
            {
              type: "text",
              text: "メニューと空き状況を確認して\nそのままご予約いただけます。",
              wrap: true,
              margin: "lg",
              size: "sm",
              color: "#3D3833",
              align: "center",
            },
          ],
        },
        footer: {
          type: "box",
          layout: "vertical",
          backgroundColor: "#FAF8F5",
          paddingAll: "16px",
          paddingTop: "0px",
          contents: [
            {
              type: "button",
              style: "primary",
              height: "md",
              color: "#A8865A",
              action: { type: "uri", label: "📅 空き状況を確認する", uri: bookingUrl },
            },
          ],
        },
      },
    },
  ]);
}

// Step 2: その日の空き時間を提示（12件＋もっと見る）
async function showTimes(replyToken, userId, dateStr, offset) {
  if (!dateStr) return startFlow(replyToken, userId);
  const settings = await B.getSettings();
  const slots = await B.getSlotsForDate(dateStr, settings);
  if (slots.length === 0) {
    // 選んでいる間に埋まった場合 → 日付選択からやり直し
    const dates = await B.findAvailableDates(settings);
    const items = dates.map((d) => pbItem(B.formatDateJP(d.date), `a=d&v=${d.date}`));
    return reply(replyToken, [
      {
        ...text(
          `申し訳ありません、${B.formatDateJP(dateStr)}は空きがなくなりました。\n他の日はいかがですか？`
        ),
        quickReply: qr(items),
      },
    ]);
  }
  await B.saveSession(userId, { step: "time", date: dateStr });
  const page = slots.slice(offset, offset + TIME_PAGE_SIZE);
  const items = page.map((t) => pbItem(`${t}〜`, `a=t&d=${dateStr}&v=${t}`));
  if (offset + TIME_PAGE_SIZE < slots.length) {
    items.push(pbItem("▶ もっと見る", `a=more&d=${dateStr}&o=${offset + TIME_PAGE_SIZE}`));
  }
  return reply(replyToken, [
    {
      ...text(`${B.formatDateJP(dateStr)} のご希望時間をお選びください。`),
      quickReply: qr(items),
    },
  ]);
}

// Step 3: 確認（Confirmテンプレート）
async function confirmStep(replyToken, userId, dateStr, time) {
  if (!dateStr || !time) return startFlow(replyToken, userId);
  await B.saveSession(userId, { step: "confirm", date: dateStr, time });
  return reply(replyToken, [
    {
      type: "template",
      altText: `${B.formatDateJP(dateStr)} ${time}〜 の予約確認`,
      template: {
        type: "confirm",
        text: `${B.formatDateJP(dateStr)} ${time}〜 で予約してよろしいですか？\n（施術時間目安: ${B.DEFAULT_DURATION}分）`,
        actions: [
          { type: "postback", label: "はい", data: `a=yes&d=${dateStr}&v=${time}`, displayText: "はい" },
          { type: "postback", label: "いいえ", data: "a=no", displayText: "いいえ" },
        ],
      },
    },
  ]);
}

// Step 4: 直前再チェック → INSERT → 完了通知＋オーナー通知
async function finalize(replyToken, userId, dateStr, time) {
  if (!dateStr || !time) return startFlow(replyToken, userId);
  const settings = await B.getSettings();

  // 受付停止スイッチ（操作の途中で停止された場合もここで確定を止める）
  if (bookingDisabled(settings)) {
    await B.clearSession(userId);
    return reply(replyToken, [text(PAUSED_MESSAGE)]);
  }

  // 原則③: 確定直前に空きを必ず再チェック
  const free = await B.isSlotFree(dateStr, time, settings);
  if (!free) {
    const slots = await B.getSlotsForDate(dateStr, settings);
    const items = slots
      .slice(0, TIME_PAGE_SIZE)
      .map((t) => pbItem(`${t}〜`, `a=t&d=${dateStr}&v=${t}`));
    if (items.length === 0) {
      const dates = await B.findAvailableDates(settings);
      return reply(replyToken, [
        {
          ...text("申し訳ありません、たった今その時間が埋まってしまいました。\n他の日はいかがですか？"),
          quickReply: qr(dates.map((d) => pbItem(B.formatDateJP(d.date), `a=d&v=${d.date}`))),
        },
      ]);
    }
    return reply(replyToken, [
      {
        ...text("申し訳ありません、たった今その時間が埋まってしまいました。\n他の時間はいかがですか？"),
        quickReply: qr(items),
      },
    ]);
  }

  const profile = await getProfile(userId);
  const { customer, isNew } = await B.findOrCreateCustomer(userId, profile.displayName);
  await B.createBooking({
    customerId: customer.id,
    dateStr,
    time,
    userId,
    displayName: profile.displayName,
    isNew,
  });
  await B.clearSession(userId);

  await reply(replyToken, [
    text(
      `ご予約を承りました✂️\n\n📅 ${B.formatDateJP(dateStr)} ${time}〜\n\n変更・キャンセルはお電話にてお願いいたします${PHONE_NOTE}。\nご来店お待ちしております！`
    ),
  ]);

  // オーナー通知（LINE push＋メール）。サロンボードの手動ブロックを促す
  await notifyOwner(
    `🔔 [${VERSION}] LINE予約が入りました\n\n📅 ${B.formatDateJP(dateStr)} ${time}〜\n👤 ${profile.displayName}${isNew ? "（新規・空カルテ自動作成）" : ""}\n\n★サロンボード（HPB）側の同時間帯を手動でブロックしてください`
  );
}

// ---------- アクセストークン ----------
// LINE_CHANNEL_ACCESS_TOKENがあればそれを使用。無ければChannel ID+secretから
// ステートレストークン（有効15分・発行数無制限）を自動発行してキャッシュする。
// これによりLINE Developersコンソールへのアクセスが不要になる。
let cachedToken = null; // { token, expiresAt }

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
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`token issue failed ${res.status}: ${t}`);
  }
  const data = await res.json(); // { access_token, expires_in, token_type }
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in - 60) * 1000, 60000),
  };
  return cachedToken.token;
}

// ---------- LINE API ----------
async function lineApi(path, payload) {
  const token = await getAccessToken();
  const res = await fetch(`https://api.line.me/v2/bot/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LINE API ${res.status} (${path}): ${t}`);
  }
}

function reply(replyToken, messages) {
  return lineApi("message/reply", { replyToken, messages });
}

function push(to, messages) {
  return lineApi("message/push", { to, messages });
}

async function getProfile(userId) {
  try {
    const token = await getAccessToken();
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.error(`[${VERSION}] getProfile error:`, e);
  }
  return { displayName: "LINEのお客様" };
}

// ---------- オーナー通知（LINE push＋メール、未設定分はスキップ） ----------
async function notifyOwner(message) {
  const results = [];
  if (process.env.OWNER_LINE_USER_ID) {
    results.push(
      push(process.env.OWNER_LINE_USER_ID, [text(message)]).catch((e) =>
        console.error(`[${VERSION}] owner push error:`, e)
      )
    );
  }
  if (process.env.RESEND_API_KEY && process.env.OWNER_EMAIL) {
    results.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || "onboarding@resend.dev",
          to: [process.env.OWNER_EMAIL],
          subject: `[${SALON_NAME}] LINE予約通知`,
          text: message,
        }),
      }).catch((e) => console.error(`[${VERSION}] email error:`, e))
    );
  }
  await Promise.all(results);
}

// ---------- メッセージ部品 ----------
function text(t) {
  return { type: "text", text: t };
}

function qr(items) {
  return { items };
}

function pbItem(label, data) {
  return {
    type: "action",
    action: { type: "postback", label: label.slice(0, 20), data, displayText: label },
  };
}

function msgItem(label, msgText) {
  return { type: "action", action: { type: "message", label, text: msgText } };
}
