// ═══════════════════════════════════════════
// /api/_lib/line.js  (LINE-v1)
// LINE APIヘルパー（カレンダー予約用の新APIから使用）
// ═══════════════════════════════════════════

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
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + Math.max((data.expires_in - 60) * 1000, 60000),
  };
  return cachedToken.token;
}

async function push(to, messages) {
  const token = await getAccessToken();
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to, messages }),
  });
  if (!res.ok) throw new Error(`LINE push ${res.status}: ${await res.text()}`);
}

async function getProfile(userId) {
  try {
    const token = await getAccessToken();
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok) return await res.json();
  } catch (e) {
    console.error("getProfile error:", e);
  }
  return { displayName: "LINEのお客様" };
}

function text(t) {
  return { type: "text", text: t };
}

// オーナー通知（LINE push＋メール、未設定分はスキップ）
async function notifyOwner(message) {
  const jobs = [];
  if (process.env.OWNER_LINE_USER_ID) {
    jobs.push(push(process.env.OWNER_LINE_USER_ID.trim(), [text(message)]).catch((e) => console.error("owner push:", e)));
  }
  if (process.env.RESEND_API_KEY && process.env.OWNER_EMAIL) {
    jobs.push(
      fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        },
        body: JSON.stringify({
          from: process.env.MAIL_FROM || "onboarding@resend.dev",
          to: [process.env.OWNER_EMAIL],
          subject: `[${process.env.SALON_NAME || "Amber"}] LINE予約通知`,
          text: message,
        }),
      }).catch((e) => console.error("owner email:", e))
    );
  }
  await Promise.all(jobs);
}

module.exports = { getAccessToken, push, getProfile, text, notifyOwner };
