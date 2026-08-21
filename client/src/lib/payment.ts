// Payment configuration.
//
// Real card payments go through T-Bank (T-Kassa) classic acquiring: card data
// is entered only on T-Bank's hosted PaymentURL — never in our app.

// React Query key for the public T-Bank config probe. The endpoint reports only
// whether the terminal credentials are configured (never the key/password).
export const TBANK_CONFIG_KEY = ["/api/payments/tbank/config"] as const;
export interface TbankConfigResponse {
  configured: boolean;
}

// React Query key for the rider's linked payment methods. Used to detect a saved
// T-Bank card (active + RebillId) so the rental flow can offer a one-tap charge.
export const PAYMENT_METHODS_KEY = ["/api/payment-methods"] as const;

// React Query key for the rider's own active reservation ("бронь"), shared
// between the rental modal (booking button) and the map page (timer banner)
// so both stay in sync via the same cache entry.
export const RESERVATION_ACTIVE_KEY = ["/api/reservations/active"] as const;
