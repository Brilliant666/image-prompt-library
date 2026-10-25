"""Offline baseline for freezing prior Agent output images into later requests.

Run: python scripts/diagnose_agent_result_snapshots.py
Each round stages one deterministic 64x64 noise PNG directly into a local job.
No queue worker or provider is dispatched. All data lives in a temporary library,
network connections are blocked, and stdout contains aggregate measurements only.
"""
from __future__ import annotations

import argparse
import gc
from io import BytesIO
import json
from pathlib import Path
import platform
import random
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.diagnose_agent_context import (
    asset_inventory, body_metrics, capture, isolated_repository, measure,
)
from backend.agent_schemas import AgentRoundCreate
from backend.db import connect
from backend.services.agent_execution import build_input, create_image_job, refs_for_request
from backend.services.agent_repository import encoded
from PIL import Image


def synthetic_png(seed):
    buffer = BytesIO()
    Image.frombytes("RGB", (64, 64), random.Random(seed).randbytes(64 * 64 * 3)).save(buffer, format="PNG")
    return buffer.getvalue()


def run(checkpoints=(5, 25, 50, 100), repeats=3):
    rows = []
    with tempfile.TemporaryDirectory(prefix="ipl-agent-result-diagnostic-") as temporary:
        with isolated_repository(Path(temporary)) as repo:
            parent = None
            previous_files = set()
            cumulative_new_files = 0
            for n in range(1, max(checkpoints) + 1):
                request_id = f"synthetic-result-{n}"
                payload = AgentRoundCreate.model_validate({
                    "requestId": request_id,
                    "expectedRevision": repo.snapshot("synthetic")["revision"],
                    "parentRoundId": parent,
                    "prompt": f"Synthetic geometric output, round {n}.",
                    "configRevision": repo.config()["revision"],
                    "authorization": {"scope": "this_request", "allowImageGeneration": True,
                                      "maxImageJobs": 1, "maxToolRounds": 1},
                })
                # Mutating creation is measured exactly once. Repeating it would
                # measure request-ID replay rather than history freezing.
                (snapshot, _), creation = measure(lambda: repo.create_round("synthetic", payload), 1)
                inventory, current_files = asset_inventory(repo)
                new_files = len(current_files - previous_files)
                cumulative_new_files += new_files
                previous_files = current_files
                parent = snapshot["conversation"]["activeRoundId"]
                if n in checkpoints:
                    request = repo.request(request_id)
                    fixed_refs = refs_for_request(repo, request)
                    _, build_cost = measure(lambda: build_input(repo, request, fixed_refs), repeats)
                    # Capture before staging this round's output: this is the
                    # first model request, with n - 1 historical result images.
                    body, wire_bytes = capture(repo, request_id)
                image = synthetic_png(n)
                job = create_image_job(repo, request_id, 1, "synthetic-output", "single",
                                       "Synthetic noise fixture", {}, native=True)
                repo.jobs.stage_result(job.id, image, "synthetic.png")
                repo.update(request_id, state="completed", text="Synthetic result stored locally.", outcome="known")
                if n not in checkpoints:
                    continue
                snapshot, cost = measure(lambda: repo.snapshot(request_id=request_id), repeats)
                with connect(repo.library) as conn:
                    history_bytes = conn.execute("SELECT sum(length(CAST(history AS BLOB))) FROM agent_requests").fetchone()[0]
                conn.close()
                (_, created_again), replay_cost = measure(lambda: repo.create_round("synthetic", payload), 1)
                replay_inventory, replay_files = asset_inventory(repo)
                assert not created_again and replay_inventory == inventory
                result_files = list((repo.library / "generation-results").rglob("result-*.png"))
                rows.append({
                    "rounds": n, "completed_output_jobs": n, "synthetic_png_bytes_per_result": len(image),
                    **inventory, **body_metrics(body, wire_bytes),
                    "new_frozen_original_files_this_round": new_files,
                    "cumulative_new_frozen_original_files": cumulative_new_files,
                    "request_replay_new_files": len(replay_files - current_files),
                    "result_original_files": len(result_files),
                    "result_original_file_bytes": sum(path.stat().st_size for path in result_files),
                    "stored_history_json_bytes_all_requests": history_bytes,
                    "database_file_bytes": (repo.library / "db.sqlite").stat().st_size,
                    "create_round_once": creation, "snapshot": cost,
                    "build_input_only": build_cost, "request_replay": replay_cost,
                    "snapshot_json_bytes": len(encoded(snapshot).encode()),
                })
        # sqlite3's transaction context manager does not close the handle.
        # Collect unreferenced repository handles before Windows removes the
        # temporary database; this does not alter the measured operations.
        gc.collect()
    return {"schema": 2, "environment": {"os": platform.system(), "python": platform.python_version()},
            "repeats": repeats, "network": "blocked; no provider or queue dispatch",
            "scenario": "one distinct synthetic output image per round; no input images",
            "provider_cache": "not measured", "rows": rows}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rounds", type=int, nargs="+", default=[5, 25, 50, 100])
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    if not 1 <= args.repeats <= 10 or any(not 1 <= n <= 100 for n in args.rounds):
        parser.error("Use 1..100 rounds and 1..10 repeats")
    print(json.dumps(run(tuple(sorted(set(args.rounds))), args.repeats), ensure_ascii=False, indent=2))
