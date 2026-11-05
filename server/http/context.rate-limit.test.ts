import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const configs = vi.hoisted(() => [] as Array<{
  skip: () => boolean;
  max: number;
  windowMs: number;
}>);

vi.mock("../storage", () => ({ storage: {} }));
vi.mock("express-rate-limit", () => ({
  default: vi.fn((options: { skip: () => boolean; max: number; windowMs: number }) => {
    configs.push(options);
    return vi.fn();
  }),
}));

beforeAll(async () => {
  await import("./context");
});
afterEach(() => vi.unstubAllEnvs());

describe("shared HTTP rate-limit bypass policy", () => {
  it("applies the same policy to all six limiters", () => {
    expect(configs).toHaveLength(6);
    expect(new Set(configs.map((config) => config.skip)).size).toBe(1);
  });

  it("preserves all existing limits and windows", () => {
    expect(configs.map(({ max, windowMs }) => [max, windowMs])).toEqual([
      [5, 600000],
      [8, 600000],
      [20, 300000],
      [10, 300000],
      [20, 600000],
      [600, 60000],
    ]);
  });

  it.each([
    { env: "production", flag: "1", skip: false },
    { env: "production", flag: "0", skip: false },
    { env: "production", flag: undefined, skip: false },
    { env: "production", flag: "true", skip: false },
    { env: "development", flag: "1", skip: true },
    { env: "test", flag: "1", skip: true },
    { env: "staging", flag: "1", skip: true },
    { env: undefined, flag: "1", skip: true },
    { env: "development", flag: "0", skip: false },
    { env: "test", flag: undefined, skip: false },
  ])("NODE_ENV=$env DISABLE_RATE_LIMIT=$flag yields skip=$skip", ({ env, flag, skip }) => {
    vi.stubEnv("NODE_ENV", env);
    vi.stubEnv("DISABLE_RATE_LIMIT", flag);
    expect(configs).toHaveLength(6);
    for (const config of configs) expect(config.skip()).toBe(skip);
  });
});
