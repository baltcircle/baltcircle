import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));

describe("external uptime probe", () => {
  it("passes the isolated Python regression suite without network access", () => {
    expect(() => execFileSync("python3", [
      "-m", "unittest", "discover", "-s", "scripts", "-p", "test_probe_production_health.py",
    ], {
      cwd: root,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
      encoding: "utf8",
      stdio: "pipe",
      timeout: 20_000,
    })).not.toThrow();
  }, 30_000);

  it("restricts incident mutations to main and isolates diagnostic concurrency", () => {
    const workflow = readFileSync(new URL("../.github/workflows/uptime-monitor.yml", import.meta.url), "utf8");
    const steps = workflow.split(/^      - name:/m);
    for (const command of ["gh label create", "gh issue create", "gh issue comment", "gh issue close"]) {
      const step = steps.find((block) => block.includes(command));
      expect(step).toBeDefined();
      expect(step).toMatch(/^        if:.*github\.ref == 'refs\/heads\/main'/m);
    }
    expect(workflow).toContain("group: uptime-monitor-${{ github.ref }}");
  });
});
