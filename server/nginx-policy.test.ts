import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync(new URL("../deploy/nginx/baltcircle.conf", import.meta.url), "utf8");
const block = (header: string) => {
  const start = config.indexOf(`${header} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  const close = `\n${header.match(/^ */)![0]}}`;
  return config.slice(start, config.indexOf(close, start) + close.length);
};

describe("nginx shared-NAT payment policy", () => {
  it("exempts only saved-method GET/HEAD from the payment write bucket", () => {
    const writes = block('map "$request_method:$uri" $payment_write_key');
    const reads = block('map "$request_method:$uri" $payment_methods_read_key');
    expect(writes).toContain('default $binary_remote_addr;');
    expect(writes).toContain('~^(GET|HEAD):/api/payment-methods/?$ "";');
    expect(reads).toContain('default "";');
    expect(reads).toContain('~^(GET|HEAD):/api/payment-methods/?$ $binary_remote_addr;');
    const exempt = /^(GET|HEAD):\/api\/payment-methods\/?$/;
    for (const path of ["GET:/api/payment-methods", "HEAD:/api/payment-methods/"]) {
      expect(exempt.test(path)).toBe(true);
    }
    for (const path of ["POST:/api/payment-methods", "DELETE:/api/payment-methods/1",
      "GET:/api/payment-methods/1/refresh", "POST:/api/payments/tbank/bind-card"]) {
      expect(exempt.test(path)).toBe(false);
    }
  });

  it("keeps bounded reads and the original mutation rate/concurrency ceilings", () => {
    expect(config).toContain("limit_req_zone $payment_write_key zone=payment_write_limit:10m rate=60r/m;");
    expect(config).toContain("limit_req_zone $payment_methods_read_key zone=payment_methods_read:10m rate=20r/s;");
    expect(config).toContain("limit_conn_zone $payment_write_key zone=payment_methods_write_conn:10m;");
    const methods = block("    location /api/payment-methods");
    expect(methods).toContain("limit_req zone=payment_write_limit burst=30 nodelay;");
    expect(methods).toContain("limit_req zone=payment_methods_read burst=100 nodelay;");
    expect(methods).toContain("limit_conn conn_limit 200;");
    expect(methods).toContain("limit_conn payment_methods_write_conn 20;");
    for (const prefix of ["/api/payments/", "/api/wallet/"]) {
      const policy = block(`    location ${prefix}`);
      expect(policy).toContain("limit_req zone=payment_write_limit burst=30 nodelay;");
      expect(policy).toContain("limit_conn conn_limit 20;");
    }
  });
});
