// Email delivery for OTP verification (email change flow).
//
// Provider: RuSender external mail API. When RUSENDER_API_KEY / RUSENDER_KEY_ID
// are not set we fall back to a dev mode that logs the code — same pattern as
// sms.ts. Production MUST set both.
//
// Docs: https://rusender.ru/developer/api/email/

function log(message: string, source = "email"): void {
  const time = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true,
  });
  console.log(`${time} [${source}] ${message}`);
}

export interface EmailSendResult {
  // Only true in dev fallback where there is no real email channel.
  devEcho: boolean;
  provider?: string;
  providerMessageId?: string;
}

function emailProvider(): string {
  return process.env.RUSENDER_API_KEY && process.env.RUSENDER_KEY_ID ? "rusender" : "";
}

export function isDevEmailFallback(): boolean {
  return emailProvider() === "";
}

export function getEmailDiagnostics() {
  return {
    provider: emailProvider() || "(none)",
    configured: !!emailProvider(),
    fromEmail: (process.env.EMAIL_FROM || "").trim() || "(none)",
    fromName: (process.env.EMAIL_FROM_NAME || "").trim() || "(none)",
    apiKeyLength: (process.env.RUSENDER_API_KEY || "").length,
    keyId: (process.env.RUSENDER_KEY_ID || "").trim() || "(none)",
  };
}

function otpSubject(): string {
  return "Код подтверждения TakeRide";
}

function otpHtml(code: string): string {
  return `<!DOCTYPE html><html lang="ru"><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f7f8;margin:0;padding:24px;">
<div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px 28px;">
  <div style="font-size:14px;color:#61B5C4;letter-spacing:.12em;text-transform:uppercase;font-weight:600;">TakeRide</div>
  <h1 style="font-size:22px;font-weight:600;color:#111;margin:16px 0 8px;">Подтверждение email</h1>
  <p style="font-size:15px;color:#4a5560;line-height:1.55;margin:0 0 24px;">Введите этот код в приложении, чтобы подтвердить новый адрес электронной почты:</p>
  <div style="font-family:'SF Mono',Menlo,Consolas,monospace;font-size:36px;letter-spacing:.5em;font-weight:700;color:#111;text-align:center;background:#f5f7f8;border-radius:12px;padding:20px 12px 20px 32px;">${code}</div>
  <p style="font-size:13px;color:#8a95a2;line-height:1.55;margin:24px 0 0;">Код действителен 5 минут. Если вы не запрашивали смену email — просто проигнорируйте это письмо.</p>
</div>
<p style="max-width:480px;margin:16px auto 0;font-size:12px;color:#8a95a2;text-align:center;">TakeRide · Калининград · <a href="https://takeride.ru" style="color:#61B5C4;text-decoration:none;">takeride.ru</a></p>
</body></html>`;
}

function otpText(code: string): string {
  return `TakeRide: код подтверждения email — ${code}. Код действителен 5 минут. Если вы не запрашивали смену email, просто проигнорируйте это письмо.`;
}

// Sends the OTP email. Throws a user-friendly Russian Error on failure.
export async function sendOtpEmail(email: string, code: string): Promise<EmailSendResult> {
  const provider = emailProvider();

  if (provider === "") {
    // Dev fallback — log the code and echo it back to the client.
    log(`[email:dev] OTP for ${email}: ${code}`, "email");
    return { devEcho: true };
  }

  const apiKey = (process.env.RUSENDER_API_KEY || "").trim();
  const keyId = (process.env.RUSENDER_KEY_ID || "").trim();
  const fromEmail = (process.env.EMAIL_FROM || "no-reply@takeride.ru").trim();
  const fromName = (process.env.EMAIL_FROM_NAME || "TakeRide").trim();

  const url = `https://api.rusender.ru/api/v1/external-mails/send/${encodeURIComponent(keyId)}`;
  const idempotencyKey = `otp-${email}-${code}-${Date.now()}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mail: {
          to: { email, name: email },
          from: { email: fromEmail, name: fromName },
          subject: otpSubject(),
          html: otpHtml(code),
          text: otpText(code),
        },
        idempotencyKey,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    log(`[rusender] network error: ${err?.message ?? err}`, "email");
    throw new Error("Не удалось отправить письмо. Попробуйте позже.");
  }

  if (!resp.ok) {
    let body = "";
    try { body = await resp.text(); } catch { /* ignore */ }
    log(`[rusender] http ${resp.status}: ${body.slice(0, 300)}`, "email");
    if (resp.status === 429) {
      throw new Error("Слишком часто. Повторите попытку через минуту.");
    }
    throw new Error("Не удалось отправить письмо. Попробуйте позже.");
  }

  let providerMessageId: string | undefined;
  try {
    const data = await resp.json() as any;
    providerMessageId = data?.uuid || data?.id || undefined;
  } catch {
    /* body is not JSON — accepted anyway (200) */
  }

  return { devEcho: false, provider, providerMessageId };
}
