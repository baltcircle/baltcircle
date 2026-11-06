import { describe, expect, it } from "vitest";
import { encodeQr, qrToSvg } from "./qrcode";

const payload = "https://takeride.ru/bike/BC-001";

function textNumber(svg: string, attribute: string): number {
  const text = svg.match(/<text\b[^>]*>/)?.[0];
  const match = text?.match(new RegExp(`\\b${attribute}="([^"]+)"`));
  if (!match) throw new Error(`Missing text attribute: ${attribute}`);
  return Number(match[1]);
}

function qrGroup(svg: string): string {
  const group = svg.match(/<g\b[^>]*>[\s\S]*?<\/g>/)?.[0];
  if (!group) throw new Error("Missing QR module group");
  return group;
}

describe("QR bike label spacing", () => {
  it("leaves a small gap of 0.70 modules before the label", () => {
    const size = 512;
    const moduleSize = size * 0.935 / (encodeQr(payload).length + 8);
    const darkBottom = size * 0.935 - 4 * moduleSize;
    const svg = qrToSvg(payload, { size, label: "BC-001" });
    const labelTop = textNumber(svg, "y") - size * 0.0949 * 0.85;
    expect(Math.abs(labelTop - darkBottom - moduleSize * 0.70)).toBeLessThan(0.02);
  });

  it("preserves sticker dimensions, QR scale, font and cut-guide frame", () => {
    const svg = qrToSvg(payload, { size: 512, label: "BC-001", physicalSize: "31mm" });
    expect(svg).toContain('width="31mm" height="31mm" viewBox="0 0 512 512"');
    expect(svg).toContain('style="width:31mm;height:31mm"');
    expect(svg).toContain('translate(16.640,0) scale(12.938378)');
    expect(svg).toContain('font-family="monospace" font-weight="bold" font-size="48.59"');
    expect(textNumber(svg, "x")).toBe(256);
    expect(textNumber(svg, "y")).toBe(477.32);
    expect(svg).toContain('<rect x="3.58" y="3.58" width="504.83" height="504.83" fill="none" stroke="#000000" stroke-width="7.17"/>');
  });

  it("keeps the QR module group independent of the printed bike label", () => {
    const a = qrToSvg(payload, { size: 512, label: "BC-001" });
    const b = qrToSvg(payload, { size: 512, label: "BC-002" });
    expect(qrGroup(a)).toBe(qrGroup(b));
  });

  it("does not add a label or frame for absent or blank labels", () => {
    const plain = qrToSvg(payload, { size: 512 });
    expect(plain).not.toContain("<text");
    expect(plain).not.toContain('fill="none"');
    expect(plain).toContain("translate(0.000,0)");
    for (const label of ["", "   "]) {
      expect(qrToSvg(payload, { size: 512, label })).toBe(plain);
    }
  });

  it("scales spacing with the canvas without changing the font fraction", () => {
    for (const size of [256, 512, 1024]) {
      const svg = qrToSvg(payload, { size, label: "BC-001" });
      const moduleSize = size * 0.935 / (encodeQr(payload).length + 8);
      const labelTop = textNumber(svg, "y") - size * 0.0949 * 0.85;
      const gap = labelTop - (size * 0.935 - 4 * moduleSize);
      expect(Math.abs(gap - moduleSize * 0.70)).toBeLessThan(0.02);
      expect(Math.abs(textNumber(svg, "font-size") - size * 0.0949)).toBeLessThan(0.01);
    }
  });

  it("preserves XML escaping for the printed label", () => {
    const svg = qrToSvg(payload, { label: "<BC&\"'>" });
    expect(svg).toContain("&lt;BC&amp;&quot;&#39;&gt;</text>");
  });
});
