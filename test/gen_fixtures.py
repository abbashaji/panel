#!/usr/bin/env python3
"""Generate test/fixtures.json.gz from the Python reference (blueprint-kit/tools/blueprintlib.py).

The TypeScript port in src/plan.ts must give identical results. Run this only when the Python rules change:
    python test/gen_fixtures.py --kit ../blueprint-kit
The generated fixtures.json.gz is committed so `npm test` works without the kit.
"""
import argparse
import copy
import itertools
import json
import random
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--kit", default="../blueprint-kit")
ap.add_argument("--out", default=str(Path(__file__).with_name("fixtures.json.gz")))
ap.add_argument("--seed", type=int, default=20261030)
ap.add_argument("--cases", type=int, default=400)
args = ap.parse_args()

kit = Path(args.kit).resolve()
sys.path.insert(0, str(kit / "tools"))
import blueprintlib as bl  # noqa: E402

rng = random.Random(args.seed)
CFG = {"main_branch": "main", "lease_minutes": 60, "max_ci_minutes": 45, "bottleneck_threshold": 4,
       "max_cell_files": 8, "acceptance_timeout_s": 60, "protected_paths": list(bl.DEFAULT_PROTECTED),
       "owners": {"pyproject.toml": "C-000"}}


def cell(cid, paths, inputs=(), after=(), provides=(), **kw):
    c = {"id": cid, "title": f"t {cid}", "goal": "g", "inputs": list(inputs), "after": list(after),
         "provides": list(provides), "allowed_paths": list(paths),
         "outputs": [p for p in paths if "*" not in p] or [paths[0].replace("/**", "/x.py")],
         "acceptance": [{"cmd": "true"}]}
    c.update(kw)
    return c


def impl(src):
    return {"from": src, "kind": "implementation", "contract": "iface"}


def con(src):
    return {"from": src, "kind": "contract", "contract": "iface"}


def base_graph():
    return {
        "C-000": cell("C-000", ["pyproject.toml", "src/app/__init__.py"], provides=["pkg"]),
        "C-001": cell("C-001", ["src/app/config.py"], [impl("C-000")], provides=["cfg"]),
        "C-002": cell("C-002", ["src/app/db/**"], [impl("C-000")], provides=["db"]),
        "C-003": cell("C-003", ["src/app/auth/**"], [impl("C-001"), con("C-002")], provides=["auth"]),
        "C-004": cell("C-004", ["src/app/api/**"], [impl("C-001"), con("C-003")]),
        "C-005": cell("C-005", ["tests/integration/**"], [impl("C-004")], after=["C-002", "C-003"], type="integration"),
    }


def example_graph():
    cells, errs = bl.load_cells(kit / "examples" / "cells")
    assert not errs, errs
    return cells


PATHS = ["src/app/**", "src/app/config.py", "src/app/db/**", "src/app/db/users.py", "src/*.py", "src/a*.py",
         "src/*b.py", "tests/", "tests/**", "tests/a.py", "**", "**/c.py", "docs/*.md", "docs/decisions.md",
         "tools/x.py", "cells/a.yaml", ".github/workflows/a.yml", "blueprint.yaml", "pyproject.toml",
         "src/[ab].py", "src/a?.py", "./src/app/x.py", "a/b/c.py", "src/app/auth/token.py"]
IDS = ["C-000", "C-001", "C-002", "C-003", "C-004", "C-005", "C-099", "X-1"]


def mutate(cells, cfg):
    ids = list(cells)
    for _ in range(rng.randint(1, 4)):
        cid = rng.choice(ids)
        c = cells[cid]
        kind = rng.choice(["del", "type", "after", "paths", "input", "lease", "prio", "fan", "cfg", "out", "text"])
        if kind == "del":
            c.pop(rng.choice(["title", "goal", "allowed_paths", "outputs", "acceptance", "inputs", "provides"]), None)
        elif kind == "type":
            c["type"] = rng.choice(["normal", "skeleton", "integration", "bogus", None])
        elif kind == "after":
            c["after"] = c.get("after", []) + [rng.choice(IDS)]
        elif kind == "paths":
            c["allowed_paths"] = rng.sample(PATHS, rng.randint(1, 3))
            c["outputs"] = [p for p in c["allowed_paths"] if "*" not in p and not p.endswith("/")][:2]
        elif kind == "input":
            c.setdefault("inputs", []).append({"from": rng.choice(IDS), "kind": rng.choice(["implementation", "contract", "bad"]),
                                               "contract": rng.choice(["iface", "", None])})
        elif kind == "lease":
            c["lease_minutes"] = rng.choice([0, -1, 15, "x", True, 5])
        elif kind == "prio":
            c["priority"] = rng.choice([1, 5, "x", None, True, -2])
        elif kind == "fan":
            for other in rng.sample(ids, min(len(ids), 4)):
                if other != cid:
                    cells[other].setdefault("inputs", []).append(impl(cid))
        elif kind == "cfg":
            cfg["owners"] = rng.choice([{}, {"pyproject.toml": "C-000"}, {"src/app/config.py": "C-001"}, {"x.py": "C-077"}])
            cfg["max_cell_files"] = rng.choice([1, 2, 8])
            cfg["bottleneck_threshold"] = rng.choice([2, 3, 4, 9])
        elif kind == "out":
            c["outputs"] = rng.choice([["src/app/*.py"], ["nowhere/x.py"], ["src/app/config.py", "src/app/config.py"], "notalist", []])
        elif kind == "text":
            c["acceptance"] = rng.choice([[], ["true"], [{"cmd": ""}], [{"cmd": "pytest"}, "x"], [5]])
            c["goal"] = rng.choice(["", "ok", None])
    return cells, cfg


def acyclic(cells):
    return bl.find_cycle(bl.hard_graph(cells)) is None


def case_validate(cells, cfg, label):
    e, w = bl.validate(cells, cfg)
    return {"label": label, "cells": cells, "cfg": cfg, "errors": e, "warnings": w}


out = {"glob_match": [], "overlap": [], "validate": [], "state": [], "runs": [], "waves": [], "yaml": [], "subjects": []}

# --- globs
pats = [p for p in PATHS if not p.startswith("./")] + ["src/**", "src/", "docs/**"]
paths = ["src/app/config.py", "src/app/db/users.py", "src/a.py", "src/ab.py", "src/b.py", "tests/a.py", "tests/x/y/z.py",
         "c.py", "a/b/c.py", "docs/decisions.md", "docs/other.md", "tools/x.py", "cells/a.yaml", "blueprint.yaml",
         ".github/workflows/a.yml", "pyproject.toml", "srcx/a.py", "src/auth.py", "src/auth/x.py", "src/app/x.py"]
for p in paths:
    out["glob_match"].append({"path": p, "patterns": pats, "expected": [bl.matches(p, [q]) for q in pats]})
for a, b in itertools.product(pats, pats):
    out["overlap"].append({"a": a, "b": b, "expected": bl.may_overlap(a, b)})

# --- validation (base graph, example project, and seeded mutations of both)
out["validate"].append(case_validate(base_graph(), copy.deepcopy(CFG), "base"))
ex = example_graph()
ex_cfg = copy.deepcopy(CFG)
out["validate"].append(case_validate(copy.deepcopy(ex), ex_cfg, "example"))
for n in range(args.cases):
    start = copy.deepcopy(rng.choice([base_graph(), ex]))
    cells, cfg = mutate(start, copy.deepcopy(CFG))
    out["validate"].append(case_validate(cells, cfg, f"mut{n}"))

# --- readiness / render / waves
# waves: every acyclic case. State: only plans that pass validation (next_cell refuses to run on an invalid
# plan, and the Python reference itself raises on e.g. priority: "x"), plus extra valid-typed mutations.
def valid_mutation(cells):
    ids = list(cells)
    for _ in range(rng.randint(1, 4)):
        c = cells[rng.choice(ids)]
        k = rng.choice(["prio", "lease", "type", "after", "fan"])
        if k == "prio":
            c["priority"] = rng.choice([1, 5, -2, 0])
        elif k == "lease":
            c["lease_minutes"] = rng.choice([5, 15, 30, 120])
        elif k == "type":
            c["type"] = rng.choice(["normal", "skeleton", "integration"])
        elif k == "after":
            c["after"] = c.get("after", []) + [rng.choice(ids)]
        elif k == "fan":
            src = rng.choice(ids)
            for other in rng.sample(ids, min(len(ids), 4)):
                if other != src:
                    cells[other].setdefault("inputs", []).append(impl(src))
    return cells


def add_state(cells_i, merged, claims, ci, lease, thr, released, opts, attempts=None, max_attempts=3, feedback=None):
    attempts, feedback = dict(attempts or {}), list(feedback or [])
    st = bl.compute_state(cells_i, merged, claims, lease, ci, 45, thr, released=released, attempts=attempts,
                          max_attempts=max_attempts, feedback=feedback, **opts)
    out["state"].append({"cells": cells_i, "merged": merged + ["C-404"], "claims": claims, "ci": ci, "lease": lease,
                         "threshold": thr, "released": released, "options": opts, "attempts": attempts,
                         "max_attempts": max_attempts, "feedback": feedback, "expected": st,
                         "render": bl.render(st), "render3": bl.render(st, 3)})


state_cases = [c["cells"] for c in out["validate"] if not c["errors"]]
for _ in range(150):
    cand = valid_mutation(copy.deepcopy(rng.choice([base_graph(), ex])))
    if acyclic(cand):
        state_cases.append(cand)
for case in out["validate"]:
    if acyclic(case["cells"]) and case["cells"]:
        out["waves"].append({"cells": case["cells"], "expected": {str(k): v for k, v in bl.waves(case["cells"]).items()}})
for cells in state_cases:
    ids = list(cells)
    for _ in range(4):
        cells_i = copy.deepcopy(cells)
        for i in rng.sample(ids, rng.randint(0, 2)):
            cells_i[i]["type"] = "skeleton"
        merged = rng.sample(ids, rng.randint(0, len(ids)))
        claims = {i: rng.choice([0, 3, 14.5, 15, 20, 59.5, 60, 90, 119.5, 120, 130, 200])
                  for i in rng.sample(ids, rng.randint(0, 4))}
        ci = {i: rng.choice([0.5, 5, 44.5, 45, 50]) for i in rng.sample(ids, rng.randint(0, 3))}
        lease = rng.choice([15, 60])
        thr = rng.choice([1, 2, 4])
        released = rng.sample(sorted(claims), rng.randint(0, len(claims)))
        opts = {"critical_chain_threshold": rng.choice([1, 2, 3, 5]),
                "critical_transitive_threshold": rng.choice([1, 3, 5, 99]),
                "critical_lease_minutes": rng.choice([5, 15, 30]),
                "park_max_minutes": rng.choice([30, 120, 500])}
        add_state(cells_i, merged, claims, ci, lease, thr, released, opts)

# --- rules 2: attempts / feedback / supersedes
def mutate_supersedes(cells):
    ids = list(cells)
    for _ in range(rng.randint(1, 3)):
        cid = rng.choice(ids)
        c = cells[cid]
        kind = rng.choice(["valid", "valid", "self", "unknown", "cycle", "badtype", "overlap", "provides"])
        if kind == "valid":
            c["supersedes"] = rng.sample([i for i in ids if i != cid], rng.randint(1, 2))
        elif kind == "self":
            c["supersedes"] = [cid]
        elif kind == "unknown":
            c["supersedes"] = [rng.choice(["C-099", "X-1", ids[0]])]
        elif kind == "cycle":
            other = rng.choice([i for i in ids if i != cid])
            c["supersedes"] = [other]
            cells[other]["supersedes"] = [cid]
        elif kind == "badtype":
            c["supersedes"] = rng.choice(["C-001", [5], None, [["C-001"]]])
        elif kind == "overlap":
            other = rng.choice([i for i in ids if i != cid])
            c["supersedes"] = [other]
            c["allowed_paths"] = list(cells[other]["allowed_paths"])
            c["outputs"] = list(cells[other]["outputs"])
        else:
            other = rng.choice([i for i in ids if i != cid])
            c["supersedes"] = [other]
            c["provides"] = rng.choice([[], list(cells[other].get("provides") or []), ["other"]])
    return cells


n_before = len(out["validate"])
for n in range(args.cases // 2):
    cells = mutate_supersedes(copy.deepcopy(rng.choice([base_graph(), ex])))
    out["validate"].append(case_validate(cells, copy.deepcopy(CFG), f"sup{n}"))
for n in range(args.cases // 4):  # supersedes mixed with the older mutations
    cells, cfg = mutate(mutate_supersedes(copy.deepcopy(rng.choice([base_graph(), ex]))), copy.deepcopy(CFG))
    out["validate"].append(case_validate(cells, cfg, f"supmut{n}"))

for cells in [copy.deepcopy(c["cells"]) for c in out["validate"][n_before:] if not c["errors"]] + \
        [mutate_supersedes(valid_mutation(copy.deepcopy(rng.choice([base_graph(), ex])))) for _ in range(150)]:
    if not cells or not acyclic(cells):
        continue
    ids = list(cells)
    for _ in range(4):
        cells_i = copy.deepcopy(cells)
        merged = rng.sample(ids, rng.randint(0, len(ids)))
        claims = {i: rng.choice([0, 3, 14.5, 20, 59.5, 60, 90, 130, 200]) for i in rng.sample(ids, rng.randint(0, 4))}
        ci = {i: rng.choice([0.5, 5, 44.5, 50]) for i in rng.sample(ids, rng.randint(0, 2))}
        released = rng.sample(sorted(claims), rng.randint(0, len(claims)))
        attempts = {i: rng.choice([0, 1, 2, 3, 4, 7]) for i in rng.sample(ids, rng.randint(0, len(ids)))}
        feedback = rng.sample(ids + ["C-404"], rng.randint(0, 2))
        opts = {"critical_chain_threshold": rng.choice([2, 3, 5]), "critical_transitive_threshold": rng.choice([3, 5, 99]),
                "critical_lease_minutes": rng.choice([5, 15]), "park_max_minutes": rng.choice([30, 120])}
        add_state(cells_i, merged, claims, ci, rng.choice([15, 60]), rng.choice([2, 4]), released, opts,
                  attempts, rng.choice([1, 2, 3]), feedback)

# --- runs
NOW = 1793268000.0  # fixed clock
import time as _t  # noqa: E402


def iso(minutes_ago):
    return _t.strftime("%Y-%m-%dT%H:%M:%SZ", _t.gmtime(NOW - minutes_ago * 60))


titles = ["gate cell/C-001", "preflight C-002", "docs fix", "gate C-003", "Preflight C-004", "gate cell/C-12", "x preflight  cell/C-005 y"]
statuses = ["queued", "in_progress", "completed", "waiting", "pending", "requested", "cancelled"]
for n in range(60):
    runs = []
    for _ in range(rng.randint(0, 8)):
        runs.append({"status": rng.choice(statuses), "headBranch": rng.choice(["main", "cell/C-006", "cell/x", "", None]),
                     "displayTitle": rng.choice(titles + [None]),
                     "createdAt": rng.choice([iso(rng.randint(0, 100)), "garbage", None, iso(0)])})
    exp = bl.parse_runs(runs, NOW)
    out["runs"].append({"now_ms": NOW * 1000, "runs": runs, "expected": exp})

# --- yaml (YAML 1.1 behaviour of safe_load, on real files and tricky scalars)
# Known, accepted difference NOT covered here: exponent-only floats such as `1e3` are strings in PyYAML but numbers
# in the JS yaml library. No cell field has such a value.
import yaml  # noqa: E402

texts = [p.read_text() for p in sorted((kit / "examples" / "cells").glob("C-*.yaml"))]
texts += [(kit / "examples" / "blueprint.yaml").read_text(), (kit / "blueprint.yaml").read_text(),
          "id: C-001\nflag: yes\nother: no\nn: 010\nv: 1.5\ns: 'x'\nl: [a, b]\n",
          "id: C-001\ny: n\nflag: Yes\nb: off\nneg: -5\ncolon: a:b\nver: 1.2.3\nnull1: ~\nnull2: null\nt: True\n",
          "id: C-001\nhex: 0x1F\nunder: 1_000\nzero: 00\nplain: C-002\n",
          "id: C-001\ngoal: |\n  multi\n  line\nacceptance:\n  - cmd: \"pytest -q\"\n", "- a\n- b\n", "just a string\n", ""]
for t in texts:
    try:
        out["yaml"].append({"text": t, "value": yaml.safe_load(t)})
    except yaml.YAMLError:
        out["yaml"].append({"text": t, "error": True})

# --- subjects
subs = ["cell(C-001): config (#3)", "cell(C-002):x", "fix cell(C-003): y", "cell(C-04): short", "Merge cell(C-005)",
        "cell(C-0006): long id", "cell(C-007)"]
out["subjects"].append({"subjects": subs, "expected": sorted(bl.SUBJECT_RE.match(s).group(1) for s in subs if bl.SUBJECT_RE.match(s))})

import gzip  # noqa: E402
with gzip.open(args.out, "wt", encoding="utf-8", compresslevel=9) as f:
    json.dump(out, f, ensure_ascii=False)
print({k: len(v) for k, v in out.items()}, "->", args.out)
