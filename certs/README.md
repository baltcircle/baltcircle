# Russian Trusted CA certificates

These two PEM files are the Russian government CA chain issued by the
Ministry of Digital Development ("НУЦ Минцифры") that T-Bank (Tinkoff) is
migrating its acquiring/payment API TLS certificates to. See the official
migration guide:
https://developer.tbank.ru/eacq/intro/certificates/migration-russian-trusted-ca

Once T-Bank switches `securepay.tinkoff.ru` (our configured
`TBANK_API_BASE`, see `server/tbank.ts`) from its current GlobalSign
certificate to a cert chained through these CAs, our Node.js backend needs
both certificates in its trust store or every outgoing HTTPS request to the
T-Bank API will fail with `certificate verify failed` /
`unable to get local issuer certificate` / `PKIX path building failed`.

Node.js does **not** use the OS trust store by default, so the `Dockerfile`
both runs `update-ca-certificates` (Debian-based base image) at build time
and sets `NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt` so the
Node process also picks these certs up.

## Files

- `russian_trusted_root_ca.pem` — root, self-signed, `CN=Russian Trusted Root CA`,
  valid until 2032-02-27.
  sha256 fingerprint: `D2:6D:2D:02:31:B7:C3:9F:92:CC:73:85:12:BA:54:10:35:19:E4:40:5D:68:B5:BD:70:3E:97:88:CA:8E:CF:31`
- `russian_trusted_sub_ca.pem` — intermediate, signed by the root,
  `CN=Russian Trusted Sub CA`, valid until 2027-03-06.
  sha256 fingerprint: `BB:BD:E2:10:3E:79:0B:99:9E:C6:2B:D0:3C:F6:25:A5:A2:E7:C3:16:E1:0A:FE:6A:49:0E:ED:EA:D8:B3:FD:9B`

Both were fetched from the official Gosuslugi CDN (`gu-st.ru`) and verified
with `openssl x509 -noout -subject -issuer -dates`. Do not re-download or
modify their contents without re-verifying the fingerprints above against
the official source.

## Verifying trust once T-Bank switches

```bash
openssl s_client -connect securepay.tinkoff.ru:443 -servername securepay.tinkoff.ru -showcerts </dev/null \
  | openssl x509 -noout -issuer -dates
```

Until T-Bank actually flips the switch, this will still show the current
GlobalSign issuer — that's expected. The chain will change automatically
on their side once they cut over; no further action is needed here as long
as these two CA certs remain trusted by the image.
