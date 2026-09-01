import type { PaymentMethod, PublicPaymentMethod } from "@shared/schema";

// Audit LOW: `rebillId` and `accountToken` are charge-capable bearer tokens
// (whoever holds them can pull money from the rider's card/account via the
// acquirer's recurring-charge API — see shared/schema.ts comments), and
// `rebillIdHash`/`accountTokenHash`/`customerKey` are internal correlation
// material the client never needs. No frontend code reads the raw token
// value — `RentalStartModal.tsx` only ever checked truthiness — so every
// client-facing PaymentMethod response is projected through this helper
// instead of returning the raw DB row. `hasRebillId`/`hasAccountToken` give
// the client the same information it actually uses.
export function toPublicPaymentMethod(m: PaymentMethod): PublicPaymentMethod {
  const { rebillId, accountToken, rebillIdHash, accountTokenHash, customerKey, ...safe } = m;
  return { ...safe, hasRebillId: !!rebillId, hasAccountToken: !!accountToken };
}

export function toPublicPaymentMethodOrNull(
  m: PaymentMethod | undefined | null,
): PublicPaymentMethod | null {
  return m ? toPublicPaymentMethod(m) : null;
}
