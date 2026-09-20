"""Safety regression checks for production maintenance (no network access)."""
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]


class OpsSafety(unittest.TestCase):
    def test_cache_cleanup_is_scoped_and_guarded(self):
        text = (ROOT / ".github/workflows/clean-build-cache.yml").read_text()
        self.assertIn("environment: production", text)
        self.assertIn("group: baltcircle-production", text)
        self.assertIn("cancel-in-progress: false", text)
        self.assertIn("docker builder prune --all --force --keep-storage 3GB", text)
        for forbidden in ["docker system prune", "docker image prune", "docker volume prune",
                          "docker container prune", "docker compose up", "docker restart"]:
            self.assertNotIn(forbidden, text)
        prune = text.index("docker builder prune")
        self.assertLess(text.index('snapshot > "$BEFORE"'), prune)
        self.assertGreater(text.index('diff -u "$BEFORE" "$AFTER"'), prune)
        self.assertIn('docker image inspect "$ROLLBACK"', text)

    def test_monitor_recovers_label_before_opening_incident(self):
        text = (ROOT / ".github/workflows/uptime-monitor.yml").read_text()
        self.assertLess(text.index("gh label create incident"), text.index("gh issue create"))
        self.assertIn("always() && steps.probe.outputs.healthy == '0'", text)
        self.assertNotIn("Add follow-up comment on continued outage", text)
        self.assertIn('timeout-minutes: 8', text)


if __name__ == "__main__":
    unittest.main()
