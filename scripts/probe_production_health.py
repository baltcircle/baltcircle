#!/usr/bin/env python3
"""External read-only health probe. Exit status is not the health decision:
GITHUB_OUTPUT controls the workflow's incident and final failure steps.
Diagnostic family probes never override a failed normal request.
"""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time

API_URLS = ("https://takeride.ru/api/bikes", "https://www.takeride.ru/api/bikes")
PMTILES_URLS = tuple("https://takeride.ru/" + name for name in
                    ("kaliningrad.pmtiles", "addresses.pmtiles", "addresses-v2.pmtiles"))
WRITE_OUT = "\n".join(("%{http_code}", "%{remote_ip}", "%{time_namelookup}",
                        "%{time_connect}", "%{time_appconnect}", "%{time_total}"))


def emit(event):
    print(json.dumps(event, ensure_ascii=True), flush=True)


def classify(result, pmtiles):
    if result.get("probe_error"):
        return "probe"
    if result["status"] == "000":
        return "network"
    if result["status"] != ("206" if pmtiles else "200"):
        return "http"
    if result["curl_exit"] != 0:
        return "transfer"
    if pmtiles:
        span = re.fullmatch(r"bytes 0-6/([1-9][0-9]*)", result["content_range"] or "")
        if (result["body_bytes"] != 7 or result["magic_hex"] != "504d54696c6573" or
                not span or int(span[1]) < 7):
            return "content"
    return "ok"


def read_headers(text):
    headers = {}
    for line in text.splitlines():
        if line.startswith("HTTP/"):
            headers = {}
        elif ":" in line:
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
    return headers


def probe_once(url, pmtiles=False, family=None):
    result = {"url": url, "family": family or "auto", "status": "000", "curl_exit": None,
              "body_bytes": 0, "magic_hex": "", "content_range": None}
    with tempfile.TemporaryDirectory(prefix="uptime-probe-") as directory:
        root = Path(directory)
        body, headers_file = root / "body", root / "headers"
        cmd = ["curl", "--disable", "--silent", "--show-error", "--max-time", "10", "--proto", "=https",
               "--dump-header", str(headers_file), "--output", str(body) if pmtiles else os.devnull,
               "--write-out", WRITE_OUT]
        if pmtiles:
            cmd += ["--range", "0-6", "--max-filesize", "128"]
        if family:
            cmd += ["--" + family, "--connect-timeout", "5"]
        try:
            response = subprocess.run(cmd + [url], capture_output=True, text=True,
                                      errors="replace", timeout=12)
            result["curl_exit"] = response.returncode
            fields = response.stdout.splitlines()
            names = ("status", "remote_ip", "dns_seconds", "connect_seconds", "tls_seconds", "total_seconds")
            result.update({name: value for name, value in zip(names, fields)})
            if not re.fullmatch(r"[0-9]{3}", result["status"]):
                result["status"] = "000"
            result["curl_error"] = response.stderr[:2000]
        except (OSError, subprocess.TimeoutExpired) as exc:
            result["probe_error"] = str(exc)
        if headers_file.exists():
            headers = read_headers(headers_file.read_text(errors="replace"))
            result["content_range"] = headers.get("content-range")
            result["content_type"] = headers.get("content-type")
        if pmtiles and body.exists():
            result["body_bytes"] = body.stat().st_size
            with body.open("rb") as stream:
                result["magic_hex"] = stream.read(7).hex()
    result["kind"] = classify(result, pmtiles)
    result["healthy"] = result["kind"] == "ok"
    return result


def check_endpoint(url, pmtiles=False):
    attempts = []
    for attempt in range(1, 4):
        result = probe_once(url, pmtiles)
        attempts.append(result)
        emit({"event": "probe", "attempt": attempt, **result})
        if result["healthy"]:
            break
        if attempt < 3:
            time.sleep(10)
    final = attempts[-1]
    if not final["healthy"] and final["kind"] == "network":
        for family in ("ipv4", "ipv6"):
            diagnostic = probe_once(url, pmtiles, family)
            emit({"event": "family_diagnostic", **diagnostic})
    return {"url": url, "pmtiles": pmtiles, "healthy": final["healthy"],
            "kind": final["kind"], "attempts": attempts}


def collect_environment():
    commands = [["curl", "--version"]]
    for host in ("takeride.ru", "www.takeride.ru"):
        commands += [["getent", "ahostsv4", host], ["getent", "ahostsv6", host]]
    for command in commands:
        try:
            result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=3)
            emit({"event": "network_context", "command": command, "exit": result.returncode,
                  "stdout": result.stdout[:2000], "stderr": result.stderr[:1000]})
        except (OSError, subprocess.TimeoutExpired) as exc:
            emit({"event": "network_context", "command": command, "error": str(exc)})


def main():
    collect_environment()
    results = [check_endpoint(url) for url in API_URLS]
    results += [check_endpoint(url, True) for url in PMTILES_URLS]
    api = [r for r in results if not r["pmtiles"]]
    maps = [r for r in results if r["pmtiles"]]
    outputs = {
        "healthy": int(all(r["healthy"] for r in results)),
        "api_healthy": int(all(r["healthy"] for r in api)),
        "pmtiles_healthy": int(all(r["healthy"] for r in maps)),
        "network_problem": int(any(r["kind"] == "network" for r in results)),
        "probe_problem": int(any(r["kind"] == "probe" for r in results)),
        "pmtiles_response_problem": int(any(r["kind"] in ("http", "transfer", "content") for r in maps)),
        "failure_summary": "; ".join(r["kind"] + ": " + r["url"] for r in results if not r["healthy"]),
    }
    emit({"event": "health_summary", **outputs})
    output_path = os.environ.get("GITHUB_OUTPUT")
    if output_path:
        with open(output_path, "a", encoding="utf-8") as stream:
            for name, value in outputs.items():
                stream.write(str(name) + "=" + str(value) + "\n")
    return outputs


if __name__ == "__main__":
    main()
