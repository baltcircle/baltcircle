// Реэкспорт общих OTP-помощников: длина кода задаётся в shared/otp.ts, чтобы
// сервер, zod-схемы и UI не расходились. Файл оставлен ради существующих
// импортов из компонентов.
export { OTP_CODE_LENGTH, OTP_CODE_REGEX, OTP_CODE_MESSAGE, sanitizeOtpInput, isCompleteOtp } from "@shared/otp";
