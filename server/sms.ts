// SMS delivery for OTP verification.
//
// Provider is selected by SMS_PROVIDER. The only real provider wired up is
// SMS.RU (SMS_PROVIDER=smsru, key in SMSRU_API_ID). When no provider is
// configured we fall back to a dev mode that logs the code instead of sending
// it — this keeps local development and CI smoke tests working without a key
// and without spending SMS quota. Production MUST set SMS_PROVIDER=smsru.

import { log } from "./index";

export interface SmsSendResult {
  // Whether the OTP should be echoed back to the client. Only true in dev
  // fallback, where there is no real SMS channel — never in production.
  devEcho: boolean;
}

export function smsProvider(): string {
  return (process.env.SMS_PROVIDER || "").trim().toLowerCase();
}

export function isDevSmsFallback(): boolean {
  // Dev fallback only when no real provider is selected. If SMS_PROVIDER is set
  // (e.g. "smsru") we always attempt the real send and surface failures.
  return smsProvider() === "";
}

export function otpMessage(code: string): string {
  return `BaltCircle: код подтверждения ${code}. Никому не сообщайте код.`;
}

// Sends the OTP SMS. Throws a user-friendly (Russian) Error on failure so the
// route can return it directly. Returns whether the code may be echoed to the
// client (dev fallback only).
export async function sendOtpSms(phone: string, code: string): Promise<SmsSendResult> {
  const provider = smsProvider();

  if (provider === "smsru") {
    await sendViaSmsRu(phone, code);
    return { devEcho: false };
  }

  if (provider === "" ) {
    // Dev / local fallback: no provider configured. Log the code so a developer
    // can complete the flow; the route echoes it to the client as well.
    log(`[sms:dev] OTP for ${phone}: ${code}`, "sms");
    return { devEcho: true };
  }

  // An unknown provider was configured — fail loudly rather than silently
  // dropping the SMS.
  throw new Error("SMS-провайдер не настроен. Обратитесь в поддержку.");
}

// SMS.RU JSON API: https://sms.ru/api/send
// We use the `json=1` endpoint so we can parse a structured status. The API id
// is the account key from SMSRU_API_ID (never logged).
async function sendViaSmsRu(phone: string, code: string): Promise<void> {
  const apiId = (process.env.SMSRU_API_ID || "").trim();
  if (!apiId) {
    throw new Error("SMS-сервис временно недоступен. Попробуйте позже.");
  }

  const params = new URLSearchParams({
    api_id: apiId,
    to: phone,
    msg: otpMessage(code),
    json: "1",
  });

  let data: any;
  try {
    const res = await fetch("https://sms.ru/sms/send", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    data = await res.json();
  } catch {
    throw new Error("Не удалось отправить SMS. Проверьте соединение и попробуйте позже.");
  }

  // Top-level status: "OK" means the request was accepted. Per-recipient status
  // lives under sms[phone].status_code (100 = queued/accepted).
  if (data?.status !== "OK") {
    log(`[sms:smsru] request rejected: ${data?.status_code ?? "?"} ${data?.status_text ?? ""}`, "sms");
    throw new Error(smsRuError(Number(data?.status_code)));
  }

  const recipient = data?.sms?.[phone];
  if (recipient && recipient.status !== "OK") {
    log(`[sms:smsru] recipient rejected: ${recipient.status_code} ${recipient.status_text ?? ""}`, "sms");
    throw new Error(smsRuError(Number(recipient.status_code)));
  }
}

// Map a handful of common SMS.RU error codes to friendly Russian messages.
// Anything unmapped gets a generic retry message so we never leak provider
// internals to the rider.
function smsRuError(code: number): string {
  switch (code) {
    case 200: // wrong api_id
    case 201: // not enough funds
      return "SMS-сервис временно недоступен. Попробуйте позже.";
    case 202: // wrong recipient
      return "Не удалось отправить SMS на этот номер. Проверьте номер телефона.";
    case 203: // no message text
    case 204: // sender not approved
    case 207: // can't send to this number
      return "Не удалось отправить SMS на этот номер.";
    case 230: // daily limit per number
    case 231: // same message to same number limit
      return "Слишком много SMS на этот номер. Попробуйте позже.";
    default:
      return "Не удалось отправить SMS. Попробуйте позже.";
  }
}
