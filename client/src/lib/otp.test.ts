import { describe, it, expect } from "vitest";
import { OTP_CODE_LENGTH, sanitizeOtpInput, isCompleteOtp } from "./otp";

// Regression coverage for the "Подтвердить" (Confirm) button staying disabled
// even after a correct SigmaSMS code is entered.
//
// Root cause: the backend issues a 6-digit, zero-padded OTP (see
// server/storage.ts `generateOtp` — randomInt(0, 1_000_000).padStart(6, "0"),
// and the `/^\d{6}$/` schemas in shared/schema.ts), but the confirm button in
// RegistrationModal / PhoneChangeModal / EmailChangeModal disabled itself with
// `code.trim().length !== 4` — a stale check left over from an earlier 4-digit
// OTP format. A correctly typed OR pasted/autofilled 6-digit code could never
// satisfy `length !== 4`, so the button stayed permanently disabled.

// The input's onChange handler is the single choke point for every way a rider
// can get a code into the field: keystroke-by-keystroke typing, a full paste
// (Ctrl+V), or a mobile browser's SMS autofill. All three deliver the complete
// string via the same `onChange`/`e.target.value` path — there is no separate
// paste handler — so exercising the sanitizer/gating logic with the full string
// (paste/autofill) and one character at a time (typing) covers both.
function typeIntoField(chars: string[]): string {
  let value = "";
  for (const ch of chars) {
    value = sanitizeOtpInput(value + ch);
  }
  return value;
}

function pasteIntoField(pasted: string): string {
  // Simulates a paste or SMS-autofill event, where the browser sets the whole
  // string in one go rather than one keystroke at a time.
  return sanitizeOtpInput(pasted);
}

describe("OTP_CODE_LENGTH", () => {
  it("matches the backend's 6-digit code format", () => {
    expect(OTP_CODE_LENGTH).toBe(6);
  });
});

describe("sanitizeOtpInput", () => {
  it("keeps only digits and caps at 6 characters", () => {
    expect(sanitizeOtpInput("123456")).toBe("123456");
    expect(sanitizeOtpInput("12-34 56")).toBe("123456");
    expect(sanitizeOtpInput("1234567890")).toBe("123456");
  });

  it("handles a zero-padded code (e.g. 000123) without dropping leading zeros", () => {
    expect(sanitizeOtpInput("000123")).toBe("000123");
  });
});

describe("isCompleteOtp — regression for disabled confirm button", () => {
  it("BUG: a full 6-digit code typed one keystroke at a time must enable the button", () => {
    const typed = typeIntoField(["1", "2", "3", "4", "5", "6"]);
    expect(typed).toBe("123456");
    expect(isCompleteOtp(typed)).toBe(true);
  });

  it("BUG: a full 6-digit code delivered via paste/SMS-autofill must enable the button", () => {
    const pasted = pasteIntoField("123456");
    expect(pasted).toBe("123456");
    expect(isCompleteOtp(pasted)).toBe(true);
  });

  it("BUG: a zero-padded 6-digit code (e.g. 004821) from SigmaSMS must enable the button", () => {
    // This is the exact shape produced by generateOtp() in server/storage.ts.
    const typed = typeIntoField("004821".split(""));
    expect(isCompleteOtp(typed)).toBe(true);

    const pasted = pasteIntoField("004821");
    expect(isCompleteOtp(pasted)).toBe(true);
  });

  it("keeps the button disabled while the code is incomplete", () => {
    expect(isCompleteOtp("")).toBe(false);
    expect(isCompleteOtp("1")).toBe(false);
    expect(isCompleteOtp("1234")).toBe(false); // the old (wrong) threshold
    expect(isCompleteOtp("12345")).toBe(false);
  });

  it("does not enable the button for more than 6 digits (sanitized/truncated first)", () => {
    expect(isCompleteOtp("1234567")).toBe(true); // truncates to "123456"
  });

  it("ignores non-digit characters when checking completeness", () => {
    expect(isCompleteOtp("123 456")).toBe(true);
    expect(isCompleteOtp("12-34")).toBe(false);
  });
});
