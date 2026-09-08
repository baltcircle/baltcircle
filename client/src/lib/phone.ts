// Работа с российским номером в поле ввода: в состоянии храним только 10 цифр
// без кода страны, а разделители добавляем при отображении.

// Если после очистки от нецифр получилось ровно 11 цифр и строка начинается с
// "7" или "8" (вставили "+79114765700" или "89114765700") — это полный номер
// вместе с кодом страны, ведущую цифру отбрасываем.
export function normalizePhoneDigits(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && (digits[0] === "7" || digits[0] === "8")) {
    return digits.slice(1);
  }
  return digits.slice(0, 10);
}

// 9001234567 → "900 123-45-67". Форматируем по мере набора, поэтому неполные
// значения тоже должны выглядеть корректно и без висящих разделителей.
export function formatPhoneDigits(digits: string): string {
  const d = digits.replace(/\D/g, "").slice(0, 10);
  const parts = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)].filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts[0]} ${parts.slice(1).join("-")}`;
}

// Backspace на разделителе стирает пробел или тире, а не цифру: набор цифр не
// меняется, поле «залипает». Ловим этот случай по укоротившейся строке ввода и
// снимаем последнюю цифру сами.
export function applyPhoneInput(raw: string, previousDigits: string): string {
  const digits = normalizePhoneDigits(raw);
  if (digits === previousDigits && raw.length < formatPhoneDigits(previousDigits).length) {
    return digits.slice(0, -1);
  }
  return digits;
}
