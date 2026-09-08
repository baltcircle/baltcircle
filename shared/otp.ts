// Единственный источник правды по длине одноразового кода.
//
// Длину дублировали три места: генератор на сервере (server/storage/otp.ts),
// zod-схемы в shared/schema.ts и UI-помощники клиента. Расхождение между ними
// не ловится ни типами, ни тестами и проявляется только в проде: сервер шлёт
// код одной длины, схема требует другой, кнопка «Подтвердить» не включается
// (та самая ошибка с SigmaSMS). Поэтому длина живёт здесь, а все три места её
// импортируют.
export const OTP_CODE_LENGTH = 4;

export const OTP_CODE_REGEX = new RegExp(`^\\d{${OTP_CODE_LENGTH}}$`);

export const OTP_CODE_MESSAGE = `Код состоит из ${OTP_CODE_LENGTH} цифр`;

// Убирает всё, кроме цифр, и обрезает по длине кода. Вешается на onChange, что
// покрывает и набор с клавиатуры, и вставку, и автоподстановку из SMS — все
// они приходят в тот же обработчик целой строкой.
export function sanitizeOtpInput(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, OTP_CODE_LENGTH);
}

// Полон ли код и можно ли его отправлять — гейт для disabled у кнопки.
export function isCompleteOtp(code: string): boolean {
  return sanitizeOtpInput(code).length === OTP_CODE_LENGTH;
}
