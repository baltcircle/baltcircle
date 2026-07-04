#!/usr/bin/env python3
import re, sys

files = sys.argv[1:]

for fp in files:
    with open(fp, "r", encoding="utf-8") as f:
        src = f.read()

    # 1. handlers -> async  (only inline arrow handlers, not already async)
    src = re.sub(r'(?<!async )\((req|_req), res\) =>', r'async (\1, res) =>', src)

    # 2. storage.method( -> await storage.method(   (skip if already awaited)
    src = re.sub(r'(?<!await )(?<!\.)\bstorage\.', r'await storage.', src)
    # fix double-await if any pre-existing await got doubled
    src = src.replace('await await storage.', 'await storage.')

    # 3. actorName(req) -> (await actorName(req))
    src = re.sub(r'(?<!await )\bactorName\(req\)', r'(await actorName(req))', src)

    # 4. isStaffSession(req) standalone assignment -> await isStaffSession(req)
    src = re.sub(r'(?<!await )(?<!\()\bisStaffSession\(req\)', r'await isStaffSession(req)', src)

    with open(fp, "w", encoding="utf-8") as f:
        f.write(src)
    print("transformed", fp)
