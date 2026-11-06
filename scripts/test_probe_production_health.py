import contextlib
import io
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest import mock

import probe_production_health as probe


def outcome(kind="ok", url=probe.API_URLS[0], pmtiles=False):
    return {"url": url, "pmtiles": pmtiles, "healthy": kind == "ok", "kind": kind}


class ProbeTests(unittest.TestCase):
    def setUp(self):
        output = contextlib.redirect_stdout(io.StringIO())
        output.__enter__()
        self.addCleanup(output.__exit__, None, None, None)

    def test_response_classification(self):
        valid = {"status": "206", "curl_exit": 0, "body_bytes": 7,
                 "magic_hex": "504d54696c6573", "content_range": "bytes 0-6/100"}
        cases = [({}, "ok"), ({"status": "200"}, "http"), ({"status": "403"}, "http"),
                 ({"magic_hex": "000000"}, "content"), ({"body_bytes": 8}, "content"),
                 ({"content_range": None}, "content"), ({"content_range": "bytes 1-7/100"}, "content"),
                 ({"content_range": "bytes 0-6/5"}, "content"), ({"curl_exit": 18}, "transfer"),
                 ({"probe_error": "curl missing"}, "probe")]
        cases += [({"status": "000", "curl_exit": rc}, "network") for rc in (6, 7, 28, 60)]
        for patch, expected in cases:
            with self.subTest(patch=patch):
                self.assertEqual(probe.classify({**valid, **patch}, True), expected)
        for status, expected in (("200", "ok"), ("301", "http"), ("500", "http")):
            self.assertEqual(probe.classify({**valid, "status": status}, False), expected)

    def test_real_probe_parsing_bounds_and_no_stale_body(self):
        calls = []
        def curl(args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                Path(args[args.index("--output") + 1]).write_bytes(b"PMTiles")
                Path(args[args.index("--dump-header") + 1]).write_text(
                    "HTTP/1.1 206 Partial\r\nContent-Range: bytes 0-6/100\r\n")
                return subprocess.CompletedProcess(args, 0, "206\n203.0.113.1\n0.01\n0.02\n0.03\n0.04", "")
            return subprocess.CompletedProcess(args, 28, "000\n\n0\n0\n0\n10", "connection timeout")
        with mock.patch.object(probe.subprocess, "run", side_effect=curl):
            good = probe.probe_once(probe.PMTILES_URLS[0], True)
            bad = probe.probe_once(probe.PMTILES_URLS[0], True)
        self.assertTrue(good["healthy"])
        self.assertEqual((bad["kind"], bad["body_bytes"], bad["magic_hex"]), ("network", 0, ""))
        self.assertEqual((bad["curl_exit"], bad["curl_error"]), (28, "connection timeout"))
        for args in calls:
            self.assertEqual(args[1], "--disable")
            self.assertIn("--show-error", args)
            self.assertEqual(args[args.index("--range") + 1], "0-6")
            self.assertEqual(args[args.index("--max-filesize") + 1], "128")
            self.assertEqual(args[args.index("--proto") + 1], "=https")
            for flag in ("--insecure", "-k", "--location", "--ipv4", "--ipv6"):
                self.assertNotIn(flag, args)
        self.assertNotEqual(calls[0][calls[0].index("--output") + 1], calls[1][calls[1].index("--output") + 1])

    def test_missing_executable_is_probe_error(self):
        with mock.patch.object(probe.subprocess, "run", side_effect=FileNotFoundError("curl missing")):
            result = probe.probe_once(probe.API_URLS[0])
        self.assertEqual(result["kind"], "probe")
        self.assertFalse(result["healthy"])

    def test_successful_retry(self):
        with mock.patch.object(probe, "probe_once", side_effect=[outcome("network"), outcome()]) as request, mock.patch.object(probe.time, "sleep") as pause:
            result = probe.check_endpoint(probe.API_URLS[0])
        self.assertTrue(result["healthy"])
        self.assertEqual((len(result["attempts"]), request.call_count), (2, 2))
        pause.assert_called_once_with(10)

    def test_family_diagnostics_never_hide_primary_failure(self):
        sequence = [outcome("network")] * 3 + [outcome(), outcome("network")]
        with mock.patch.object(probe, "probe_once", side_effect=sequence) as request, mock.patch.object(probe.time, "sleep") as pause:
            result = probe.check_endpoint(probe.API_URLS[0])
        self.assertFalse(result["healthy"])
        self.assertEqual(result["kind"], "network")
        self.assertEqual((len(result["attempts"]), request.call_count, pause.call_count), (3, 5, 2))
        self.assertEqual(request.call_args_list[3].args[2], "ipv4")
        self.assertEqual(request.call_args_list[4].args[2], "ipv6")

    def test_summary_outputs_all_targets_and_failure_kinds(self):
        for fail in (False, True):
            results = [outcome("network" if fail else "ok", probe.API_URLS[0]), outcome(url=probe.API_URLS[1])]
            results += [outcome("http" if fail and i == 1 else "ok", url, True) for i, url in enumerate(probe.PMTILES_URLS)]
            with tempfile.TemporaryDirectory() as root:
                output = Path(root) / "outputs"
                with mock.patch.object(probe, "collect_environment"), mock.patch.object(probe, "check_endpoint", side_effect=results) as request, mock.patch.dict(os.environ, {"GITHUB_OUTPUT": str(output)}):
                    summary = probe.main()
                self.assertEqual(request.call_count, 5)
                self.assertEqual(summary["healthy"], int(not fail))
                self.assertEqual(summary["network_problem"], int(fail))
                self.assertEqual(summary["pmtiles_response_problem"], int(fail))
                self.assertIn("healthy=" + str(int(not fail)) + "\n", output.read_text())
                if fail:
                    self.assertIn("network: " + probe.API_URLS[0], summary["failure_summary"])
                    self.assertIn("http: " + probe.PMTILES_URLS[1], summary["failure_summary"])
        self.assertEqual(probe.PMTILES_URLS[-1], "https://takeride.ru/addresses-v2.pmtiles")
        self.assertIn("https://takeride.ru/addresses.pmtiles", probe.PMTILES_URLS)


if __name__ == "__main__":
    unittest.main()
