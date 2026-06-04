// Test/MVP payment configuration.
// QR points to an SBP/card transfer. Verification is MANUAL — there is no
// real acquiring or automatic confirmation. No sensitive data is stored.

// Local copy of the QR image (served from client/public). Used by default so
// the page keeps working if the external link expires.
export const TEST_PAYMENT_QR_LOCAL = "./payment/test-qr.jpg";

// Original external QR image provided for the test payment. Kept as a
// configurable fallback / "open in new tab" target.
export const TEST_PAYMENT_QR_REMOTE =
  "https://sun9-13.userapi.com/s/v1/ig2/ot8V-Qzmfcd_uZ1yGnTyaB9J4UCiZqd8GoyPNDihnZ1dt_P_0oY2rTGD8u76NrcqtU-4O3TxQ_iAllUxrRi2GHt5.jpg?quality=95&as=32x27,48x41,72x61,108x92,160x136,240x203,360x305,480x407,540x458,640x542,720x610,1080x915,1083x918&from=bu&u=afwHTH7k3LG_G6hug8mayfJZcw7hWxevGs22XQG6Roo&cs=640x0";
