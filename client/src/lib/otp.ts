// Shared OTP (one-time SMS/email code) validation helpers.
//
// The backend issues a 6-digit, zero-padded numeric code (see
// server/storage.ts `generateOtp` and the `otpVerifySchema` /
// `phoneChangeVerifySchema` / `emailChangeVerifySchema` regexes in
// shared/schema.ts, all `/^\d{6}$/`). Every OTP-entry UI (registration, phone
// change, email change) must agree with that length when deciding whether the
// "Подтвердить" button is enabled — otherwise a correctly typed/pasted code
// can never enable the button (see the SigmaSMS disabled-button bug).
export const OTP_CODE_LENGTH = 6;

// Strips everything but digits and caps the length — used in the input's
// onChange (covers typing) and is also safe to apply to a pasted/autofilled
// value, since paste/autofill events land in the same onChange handler with
// the full pasted string as e.target.value.
export function sanitizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_CODE_LENGTH);
}

// Whether a code (already sanitized or not) is a complete, submittable OTP.
// Used to gate the confirm button's `disabled` prop.
export function isCompleteOtp(code: string): boolean {
  return sanitizeOtpInput(code).length === OTP_CODE_LENGTH;
}
