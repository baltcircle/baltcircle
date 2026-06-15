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
