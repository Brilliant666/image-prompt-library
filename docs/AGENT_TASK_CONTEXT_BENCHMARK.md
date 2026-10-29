# Agent task-context benchmark

This benchmark measures local context construction and a mocked Responses POST. It does not measure provider latency, upload throughput, model reasoning, token cost, or provider cache behavior.

The candidate passes all image-coverage checks: unrelated completed image tasks no longer add pixels to A, all genuinely necessary images remain in B, and text-only Prompt iteration sends no pixels in C. B intentionally continues to grow with the necessary images.

At 200 rounds, A shrinks the wire JSON from 7,716,194 to 90,199 bytes and cuts image reads from 201 to 2. B still carries all 200 necessary images and has a higher local cold Mock POST median (3,467.99 to 4,261.61 ms). C sends no pixels, but retains 27,624 bytes of task state plus required text history; its cold Mock POST median also rises (137.44 to 285.20 ms). The results establish the image-scope improvement and expose the remaining local overhead in B and C.

## Reproducibility

- Baseline B0: commit `f09f4865869e606490d4ac7728dc9bf3af0610b8`, clean working tree; backend/source content SHA256 `dcf2fc254934994f0c11d9e4f7be6c0f8d384a18c2a24de0372085bf4a991c70` (69 files).
- Candidate: base commit `f09f4865869e606490d4ac7728dc9bf3af0610b8` plus an uncommitted working-tree snapshot; backend/source content SHA256 `7e1d4a6fdf70ea277a7d6822c24228b3047f2a79f10373a0ce96926f21721eb1` (71 files). These results identify that snapshot, rather than a later commit.
- The candidate runs from a minimal frozen source export. Its content fingerprint matched the development tree before and after copying, and the benchmark verifies that exported source remains unchanged during measurement. Only backend source/resources, the required diagnostic script and dependency metadata are copied; installed environments and frontend dependencies are not copied.
- Benchmark script SHA256: `e9f4ba457d825a56ae49bdcfc9b55226277801a607cae393b5557bdfab00631f`. Dependency lock SHA256: `3ac3626e3638cd8e897b392c86368b87a7bd9e3804fde5a448d0651a90006a62`.
- Same interpreter SHA256: `f4a67edaec8fcced809ffc49a31df1dad753f723d02bd1925a828c95bd305427`. Python 3.11.16 on Windows; httpx 0.28.1, fastapi 0.136.1, pillow 12.2.0, pydantic 2.13.4.
- Aggregate report SHA256: B0 `98e7b95eac4686cf8d4d59cd92fe5a8411a5de2d1ebb199df73a7414df8433c7`; candidate `48389e56a95c6666535a5a53439433583b848125db9e950a0e06c48df10f5906`. Raw reports remain local and are not committed.
- Synthetic images are deterministic 96 × 96 RGB noise PNGs. Both runs use the same assets, prompts, interpreter, dependencies, checkpoints, mock response, and script. The candidate adapter additionally expresses the same task intent through its new public task-state API.
- Cold clears the process image-encoding cache before each sample. Warm primes that cache before sampling. OS filesystem caches are not flushed. Every temperature has three uninstrumented timing samples; operation counts come from separate restored calls at the same temperature.
- Background machine load is not isolated. Use the recorded ranges and exact wire/work counts when interpreting the timings; small timing differences are not evidence of a service-level speedup.
- Socket connections are blocked. Production `prepare_context` and `call_responses` construct the actual HTTPX request body, captured by MockTransport. Image counts and coverage come from decoding its image data URLs and comparing pixel hashes, rather than inspecting Python objects.

Run the same interpreter sequentially against the two source trees, storing output outside tracked files:

```text
python scripts/benchmark_agent_task_context.py --source-root <baseline-checkout> --rounds 5 25 50 100 200 --repeats 3 --output <local-only-B0.json>
python scripts/benchmark_agent_task_context.py --source-root <candidate-checkout> --rounds 5 25 50 100 200 --repeats 3 --output <local-only-candidate.json>
```

## Scenarios and actual wire content

A starts a distinct editing task each round. Every measurement needs only its current target and one fixed lighting auxiliary; older tasks are finished. The same auxiliary also occurred at earlier checkpoints, explaining repeated image occurrences in B0. Candidate task boundaries and image roles are set through the public task-context API.

B introduces one additional reference each round and explicitly requests the full branch because every image is necessary. C starts with an image-analysis turn, then creates a text-only Prompt task with an original and selected Prompt. Later textual additions are preserved conservatively as history dependencies; no extra model state-reconciliation calls are simulated.

Wire bytes include the complete serialized HTTP JSON, including instructions and tool schemas. Coverage is distinct required pixel payloads present / distinct required payloads. For C, 0/0 means no image pixels are required. Task-state bytes count the frozen `taskContext` JSON only; B0 may have a legacy `editingTask`, which is outside that counter but remains included in its full wire bytes when transmitted.

| Scenario | Rounds | B0 JSON bytes | Candidate JSON bytes | B0 / candidate image occurrences | Candidate required coverage | Candidate task-state bytes | Candidate reason |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A | 5 | 237,201 | 90,192 | 6 / 2 | 2/2 | 1,437 | none |
| A | 25 | 1,026,208 | 90,195 | 27 / 2 | 2/2 | 1,437 | none |
| A | 50 | 2,003,169 | 90,196 | 53 / 2 | 2/2 | 1,438 | none |
| A | 100 | 3,919,882 | 90,199 | 104 / 2 | 2/2 | 1,438 | none |
| A | 200 | 7,716,194 | 90,199 | 205 / 2 | 2/2 | 1,438 | none |
| B | 5 | 198,765 | 202,486 | 5 / 5 | 5/5 | 1,430 | user_selected_full_branch |
| B | 25 | 951,101 | 954,823 | 25 / 25 | 25/25 | 2,251 | user_selected_full_branch |
| B | 50 | 1,891,526 | 1,895,248 | 50 / 50 | 50/50 | 3,276 | user_selected_full_branch |
| B | 100 | 3,772,377 | 3,776,100 | 100 / 100 | 100/100 | 5,327 | user_selected_full_branch |
| B | 200 | 7,534,177 | 7,537,900 | 200 / 200 | 200/200 | 9,427 | user_selected_full_branch |
| C | 5 | 49,764 | 16,436 | 1 / 0 | 0/0 | 1,882 | required_history_evidence |
| C | 25 | 57,444 | 26,097 | 1 / 0 | 0/0 | 4,523 | required_history_evidence |
| C | 50 | 67,044 | 38,172 | 1 / 0 | 0/0 | 7,823 | required_history_evidence |
| C | 100 | 86,244 | 62,323 | 1 / 0 | 0/0 | 14,424 | required_history_evidence |
| C | 200 | 124,644 | 110,623 | 1 / 0 | 0/0 | 27,624 | required_history_evidence |

The candidate has zero unnecessary unique images at every checkpoint. B0 has rounds minus one unnecessary unique images in A and one unnecessary old image in C. B0 has no new `taskContext` projection; its reported compatibility reason is `legacy_missing_task_state`. Candidate `user_selected_full_branch` is an explicit user scope; `required_history_evidence` retains unreconciled text sources rather than claiming a complete summary.

## Local timings

Milliseconds are median [minimum, maximum] from three samples. Build includes loading the frozen request and real `prepare_context`. Mock POST includes the production request path, local serialization, persistence, and consumption of an empty mocked response. Fixture creation, task-state API updates, and round creation are outside these timing windows. These timings are local measurements and do not establish real service latency or cache savings.

| Scenario | Rounds | Source | Build cold ms | Build warm ms | Mock POST cold ms | Mock POST warm ms |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| A | 5 | B0 | 60.87 [57.69, 61.49] | 57.98 [56.85, 58.51] | 158.71 [155.42, 162.12] | 153.11 [151.78, 156.09] |
| A | 5 | candidate | 21.89 [21.38, 22.11] | 20.15 [19.29, 23.76] | 106.42 [99.66, 106.54] | 156.70 [123.43, 165.95] |
| A | 25 | B0 | 449.31 [441.69, 455.38] | 448.78 [447.09, 482.49] | 516.11 [500.90, 852.40] | 506.36 [488.08, 519.39] |
| A | 25 | candidate | 38.93 [38.22, 41.65] | 40.91 [40.28, 41.64] | 171.74 [167.06, 176.77] | 160.62 [157.18, 166.55] |
| A | 50 | B0 | 502.96 [497.33, 510.43] | 508.86 [491.22, 565.67] | 918.43 [898.39, 920.85] | 902.16 [892.03, 905.88] |
| A | 50 | candidate | 40.35 [38.42, 48.38] | 38.09 [37.94, 38.47] | 163.71 [157.76, 177.86] | 160.79 [160.75, 165.97] |
| A | 100 | B0 | 1046.73 [998.87, 1228.75] | 1079.95 [1052.24, 1111.24] | 1749.30 [1718.61, 1778.36] | 1769.63 [1745.57, 1786.54] |
| A | 100 | candidate | 114.92 [54.67, 120.70] | 63.12 [61.55, 106.26] | 213.90 [190.51, 288.27] | 188.97 [181.74, 190.00] |
| A | 200 | B0 | 2050.09 [2046.64, 2052.68] | 2092.01 [2052.72, 2165.51] | 3404.76 [3373.59, 3418.86] | 3355.08 [3325.34, 3424.07] |
| A | 200 | candidate | 26.35 [25.51, 27.12] | 26.79 [26.52, 27.88] | 132.20 [122.10, 144.95] | 128.20 [126.95, 147.95] |
| B | 5 | B0 | 51.57 [51.13, 52.25] | 52.52 [50.06, 53.08] | 145.98 [140.53, 155.70] | 141.28 [141.05, 206.98] |
| B | 5 | candidate | 61.97 [58.79, 64.09] | 54.52 [53.47, 56.49] | 159.40 [152.36, 167.93] | 154.08 [151.20, 158.87] |
| B | 25 | B0 | 248.68 [243.70, 263.73] | 245.79 [244.35, 246.76] | 478.69 [462.29, 537.23] | 471.73 [470.54, 472.15] |
| B | 25 | candidate | 275.07 [267.94, 324.85] | 263.74 [257.71, 266.94] | 484.99 [483.59, 504.83] | 497.84 [481.98, 498.15] |
| B | 50 | B0 | 526.40 [498.68, 541.06] | 534.67 [524.43, 749.36] | 947.37 [909.91, 1131.37] | 922.59 [915.72, 939.34] |
| B | 50 | candidate | 520.80 [497.02, 549.95] | 517.62 [511.84, 539.36] | 957.46 [899.46, 1039.71] | 1516.75 [898.86, 2982.54] |
| B | 100 | B0 | 1002.70 [1000.04, 1015.77] | 1411.98 [1018.60, 1743.52] | 1777.55 [1743.86, 1803.95] | 1708.39 [1689.96, 1810.59] |
| B | 100 | candidate | 1729.46 [1684.40, 1733.22] | 1706.84 [1705.20, 1749.28] | 1739.25 [1630.17, 3051.57] | 1670.16 [1648.59, 1683.96] |
| B | 200 | B0 | 2035.86 [2033.23, 2083.36] | 2019.94 [1983.76, 2119.87] | 3467.99 [3374.64, 3558.32] | 3465.42 [3388.42, 3538.76] |
| B | 200 | candidate | 3893.88 [3881.78, 3906.84] | 2334.70 [2320.43, 2519.63] | 4261.61 [3940.96, 4451.56] | 3747.89 [3554.37, 6919.13] |
| C | 5 | B0 | 14.25 [14.04, 14.31] | 13.60 [12.96, 14.87] | 92.01 [89.95, 108.16] | 97.72 [94.65, 118.33] |
| C | 5 | candidate | 2.24 [2.05, 2.36] | 2.17 [2.02, 2.51] | 68.30 [64.62, 70.02] | 64.29 [61.29, 72.01] |
| C | 25 | B0 | 12.50 [12.26, 13.43] | 11.80 [11.49, 14.46] | 81.36 [80.44, 88.71] | 82.23 [80.30, 83.80] |
| C | 25 | candidate | 2.17 [2.15, 2.49] | 2.60 [2.25, 3.61] | 76.74 [74.45, 100.69] | 76.36 [74.12, 83.08] |
| C | 50 | B0 | 12.10 [10.88, 13.62] | 11.92 [11.79, 12.11] | 80.61 [80.14, 81.95] | 81.90 [81.25, 83.94] |
| C | 50 | candidate | 3.24 [3.24, 3.70] | 3.79 [3.26, 4.33] | 89.52 [86.97, 129.38] | 83.45 [82.17, 84.92] |
| C | 100 | B0 | 12.45 [12.16, 14.54] | 12.51 [12.48, 12.91] | 86.46 [82.69, 97.40] | 82.85 [81.76, 84.86] |
| C | 100 | candidate | 5.98 [5.93, 6.06] | 5.69 [5.45, 17.12] | 106.89 [104.07, 180.40] | 109.47 [99.84, 111.47] |
| C | 200 | B0 | 24.44 [23.37, 24.97] | 23.55 [22.72, 23.56] | 137.44 [136.23, 150.57] | 143.12 [133.75, 145.15] |
| C | 200 | candidate | 13.90 [13.21, 14.68] | 16.15 [14.56, 16.21] | 285.20 [274.26, 288.08] | 275.99 [249.88, 280.44] |

## Independently observed work

Each value below is median [minimum, maximum]. Validation counts distinguish file-version preflight checks from byte-content image validation. Reads, encodes, SQLite connections and SELECT statements are observed by instrumenting their actual operations in a separate call. SQL is not estimated from source text. Each cell shows cold / warm.

| Scenario | Rounds | Source | Operation | Image reads | Version validations | Content validations | Base64 encodes | SQL connections | SQL statements | SQL SELECTs | Mock calls |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 5 | B0 | build | 6 [6, 6] / 6 [6, 6] | 18 [18, 18] / 18 [18, 18] | 6 [6, 6] / 6 [6, 6] | 6 [6, 6] / 6 [6, 6] | 13 [13, 13] / 13 [13, 13] | 28 [28, 28] / 28 [28, 28] | 15 [15, 15] / 15 [15, 15] | 0 [0, 0] / 0 [0, 0] |
| A | 5 | B0 | mock_post | 6 [6, 6] / 6 [6, 6] | 24 [24, 24] / 24 [24, 24] | 6 [6, 6] / 6 [6, 6] | 6 [6, 6] / 6 [6, 6] | 41 [41, 41] / 41 [41, 41] | 169 [169, 169] / 169 [169, 169] | 62 [62, 62] / 62 [62, 62] | 1 [1, 1] / 1 [1, 1] |
| A | 5 | candidate | build | 2 [2, 2] / 2 [2, 2] | 6 [6, 6] / 6 [6, 6] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 5 [5, 5] / 5 [5, 5] | 12 [12, 12] / 12 [12, 12] | 7 [7, 7] / 7 [7, 7] | 0 [0, 0] / 0 [0, 0] |
| A | 5 | candidate | mock_post | 2 [2, 2] / 2 [2, 2] | 8 [8, 8] / 8 [8, 8] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 25 [25, 25] / 25 [25, 25] | 137 [137, 137] / 137 [137, 137] | 46 [46, 46] / 46 [46, 46] | 1 [1, 1] / 1 [1, 1] |
| A | 25 | B0 | build | 26 [26, 26] / 26 [26, 26] | 79 [79, 79] / 79 [79, 79] | 26 [26, 26] / 26 [26, 26] | 26 [26, 26] / 26 [26, 26] | 54 [54, 54] / 54 [54, 54] | 110 [110, 110] / 110 [110, 110] | 56 [56, 56] / 56 [56, 56] | 0 [0, 0] / 0 [0, 0] |
| A | 25 | B0 | mock_post | 26 [26, 26] / 26 [26, 26] | 105 [105, 105] / 105 [105, 105] | 26 [26, 26] / 26 [26, 26] | 26 [26, 26] / 26 [26, 26] | 122 [122, 122] / 122 [122, 122] | 331 [331, 331] / 331 [331, 331] | 143 [143, 143] / 143 [143, 143] | 1 [1, 1] / 1 [1, 1] |
| A | 25 | candidate | build | 2 [2, 2] / 2 [2, 2] | 6 [6, 6] / 6 [6, 6] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 5 [5, 5] / 5 [5, 5] | 12 [12, 12] / 12 [12, 12] | 7 [7, 7] / 7 [7, 7] | 0 [0, 0] / 0 [0, 0] |
| A | 25 | candidate | mock_post | 2 [2, 2] / 2 [2, 2] | 8 [8, 8] / 8 [8, 8] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 25 [25, 25] / 25 [25, 25] | 137 [137, 137] / 137 [137, 137] | 46 [46, 46] / 46 [46, 46] | 1 [1, 1] / 1 [1, 1] |
| A | 50 | B0 | build | 51 [51, 51] / 51 [51, 51] | 155 [155, 155] / 155 [155, 155] | 51 [51, 51] / 51 [51, 51] | 51 [51, 51] / 51 [51, 51] | 105 [105, 105] / 105 [105, 105] | 212 [212, 212] / 212 [212, 212] | 107 [107, 107] / 107 [107, 107] | 0 [0, 0] / 0 [0, 0] |
| A | 50 | B0 | mock_post | 51 [51, 51] / 51 [51, 51] | 206 [206, 206] / 206 [206, 206] | 51 [51, 51] / 51 [51, 51] | 51 [51, 51] / 51 [51, 51] | 223 [223, 223] / 223 [223, 223] | 533 [533, 533] / 533 [533, 533] | 244 [244, 244] / 244 [244, 244] | 1 [1, 1] / 1 [1, 1] |
| A | 50 | candidate | build | 2 [2, 2] / 2 [2, 2] | 6 [6, 6] / 6 [6, 6] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 5 [5, 5] / 5 [5, 5] | 12 [12, 12] / 12 [12, 12] | 7 [7, 7] / 7 [7, 7] | 0 [0, 0] / 0 [0, 0] |
| A | 50 | candidate | mock_post | 2 [2, 2] / 2 [2, 2] | 8 [8, 8] / 8 [8, 8] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 25 [25, 25] / 25 [25, 25] | 137 [137, 137] / 137 [137, 137] | 46 [46, 46] / 46 [46, 46] | 1 [1, 1] / 1 [1, 1] |
| A | 100 | B0 | build | 101 [101, 101] / 101 [101, 101] | 306 [306, 306] / 306 [306, 306] | 101 [101, 101] / 101 [101, 101] | 101 [101, 101] / 101 [101, 101] | 206 [206, 206] / 206 [206, 206] | 414 [414, 414] / 414 [414, 414] | 208 [208, 208] / 208 [208, 208] | 0 [0, 0] / 0 [0, 0] |
| A | 100 | B0 | mock_post | 101 [101, 101] / 101 [101, 101] | 407 [407, 407] / 407 [407, 407] | 101 [101, 101] / 101 [101, 101] | 101 [101, 101] / 101 [101, 101] | 424 [424, 424] / 424 [424, 424] | 935 [935, 935] / 935 [935, 935] | 445 [445, 445] / 445 [445, 445] | 1 [1, 1] / 1 [1, 1] |
| A | 100 | candidate | build | 2 [2, 2] / 2 [2, 2] | 6 [6, 6] / 6 [6, 6] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 5 [5, 5] / 5 [5, 5] | 12 [12, 12] / 12 [12, 12] | 7 [7, 7] / 7 [7, 7] | 0 [0, 0] / 0 [0, 0] |
| A | 100 | candidate | mock_post | 2 [2, 2] / 2 [2, 2] | 8 [8, 8] / 8 [8, 8] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 25 [25, 25] / 25 [25, 25] | 137 [137, 137] / 137 [137, 137] | 46 [46, 46] / 46 [46, 46] | 1 [1, 1] / 1 [1, 1] |
| A | 200 | B0 | build | 201 [201, 201] / 201 [201, 201] | 607 [607, 607] / 607 [607, 607] | 201 [201, 201] / 201 [201, 201] | 201 [201, 201] / 201 [201, 201] | 407 [407, 407] / 407 [407, 407] | 816 [816, 816] / 816 [816, 816] | 409 [409, 409] / 409 [409, 409] | 0 [0, 0] / 0 [0, 0] |
| A | 200 | B0 | mock_post | 201 [201, 201] / 201 [201, 201] | 808 [808, 808] / 808 [808, 808] | 201 [201, 201] / 201 [201, 201] | 201 [201, 201] / 201 [201, 201] | 825 [825, 825] / 825 [825, 825] | 1737 [1737, 1737] / 1737 [1737, 1737] | 846 [846, 846] / 846 [846, 846] | 1 [1, 1] / 1 [1, 1] |
| A | 200 | candidate | build | 2 [2, 2] / 2 [2, 2] | 6 [6, 6] / 6 [6, 6] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 5 [5, 5] / 5 [5, 5] | 12 [12, 12] / 12 [12, 12] | 7 [7, 7] / 7 [7, 7] | 0 [0, 0] / 0 [0, 0] |
| A | 200 | candidate | mock_post | 2 [2, 2] / 2 [2, 2] | 8 [8, 8] / 8 [8, 8] | 2 [2, 2] / 2 [2, 2] | 2 [2, 2] / 2 [2, 2] | 25 [25, 25] / 25 [25, 25] | 137 [137, 137] / 137 [137, 137] | 46 [46, 46] / 46 [46, 46] | 1 [1, 1] / 1 [1, 1] |
| B | 5 | B0 | build | 5 [5, 5] / 5 [5, 5] | 15 [15, 15] / 15 [15, 15] | 5 [5, 5] / 5 [5, 5] | 5 [5, 5] / 5 [5, 5] | 11 [11, 11] / 11 [11, 11] | 24 [24, 24] / 24 [24, 24] | 13 [13, 13] / 13 [13, 13] | 0 [0, 0] / 0 [0, 0] |
| B | 5 | B0 | mock_post | 5 [5, 5] / 5 [5, 5] | 20 [20, 20] / 20 [20, 20] | 5 [5, 5] / 5 [5, 5] | 5 [5, 5] / 5 [5, 5] | 37 [37, 37] / 37 [37, 37] | 161 [161, 161] / 161 [161, 161] | 58 [58, 58] / 58 [58, 58] | 1 [1, 1] / 1 [1, 1] |
| B | 5 | candidate | build | 5 [5, 5] / 5 [5, 5] | 15 [15, 15] / 15 [15, 15] | 5 [5, 5] / 5 [5, 5] | 5 [5, 5] / 5 [5, 5] | 11 [11, 11] / 11 [11, 11] | 24 [24, 24] / 24 [24, 24] | 13 [13, 13] / 13 [13, 13] | 0 [0, 0] / 0 [0, 0] |
| B | 5 | candidate | mock_post | 5 [5, 5] / 5 [5, 5] | 20 [20, 20] / 20 [20, 20] | 5 [5, 5] / 5 [5, 5] | 5 [5, 5] / 5 [5, 5] | 37 [37, 37] / 37 [37, 37] | 161 [161, 161] / 161 [161, 161] | 58 [58, 58] / 58 [58, 58] | 1 [1, 1] / 1 [1, 1] |
| B | 25 | B0 | build | 25 [25, 25] / 25 [25, 25] | 75 [75, 75] / 75 [75, 75] | 25 [25, 25] / 25 [25, 25] | 25 [25, 25] / 25 [25, 25] | 51 [51, 51] / 51 [51, 51] | 104 [104, 104] / 104 [104, 104] | 53 [53, 53] / 53 [53, 53] | 0 [0, 0] / 0 [0, 0] |
| B | 25 | B0 | mock_post | 25 [25, 25] / 25 [25, 25] | 100 [100, 100] / 100 [100, 100] | 25 [25, 25] / 25 [25, 25] | 25 [25, 25] / 25 [25, 25] | 117 [117, 117] / 117 [117, 117] | 321 [321, 321] / 321 [321, 321] | 138 [138, 138] / 138 [138, 138] | 1 [1, 1] / 1 [1, 1] |
| B | 25 | candidate | build | 25 [25, 25] / 25 [25, 25] | 75 [75, 75] / 75 [75, 75] | 25 [25, 25] / 25 [25, 25] | 25 [25, 25] / 25 [25, 25] | 51 [51, 51] / 51 [51, 51] | 104 [104, 104] / 104 [104, 104] | 53 [53, 53] / 53 [53, 53] | 0 [0, 0] / 0 [0, 0] |
| B | 25 | candidate | mock_post | 25 [25, 25] / 25 [25, 25] | 100 [100, 100] / 100 [100, 100] | 25 [25, 25] / 25 [25, 25] | 25 [25, 25] / 25 [25, 25] | 117 [117, 117] / 117 [117, 117] | 321 [321, 321] / 321 [321, 321] | 138 [138, 138] / 138 [138, 138] | 1 [1, 1] / 1 [1, 1] |
| B | 50 | B0 | build | 50 [50, 50] / 50 [50, 50] | 150 [150, 150] / 150 [150, 150] | 50 [50, 50] / 50 [50, 50] | 50 [50, 50] / 50 [50, 50] | 101 [101, 101] / 101 [101, 101] | 204 [204, 204] / 204 [204, 204] | 103 [103, 103] / 103 [103, 103] | 0 [0, 0] / 0 [0, 0] |
| B | 50 | B0 | mock_post | 50 [50, 50] / 50 [50, 50] | 200 [200, 200] / 200 [200, 200] | 50 [50, 50] / 50 [50, 50] | 50 [50, 50] / 50 [50, 50] | 217 [217, 217] / 217 [217, 217] | 521 [521, 521] / 521 [521, 521] | 238 [238, 238] / 238 [238, 238] | 1 [1, 1] / 1 [1, 1] |
| B | 50 | candidate | build | 50 [50, 50] / 50 [50, 50] | 150 [150, 150] / 150 [150, 150] | 50 [50, 50] / 50 [50, 50] | 50 [50, 50] / 50 [50, 50] | 101 [101, 101] / 101 [101, 101] | 204 [204, 204] / 204 [204, 204] | 103 [103, 103] / 103 [103, 103] | 0 [0, 0] / 0 [0, 0] |
| B | 50 | candidate | mock_post | 50 [50, 50] / 50 [50, 50] | 200 [200, 200] / 200 [200, 200] | 50 [50, 50] / 50 [50, 50] | 50 [50, 50] / 50 [50, 50] | 217 [217, 217] / 217 [217, 217] | 521 [521, 521] / 521 [521, 521] | 238 [238, 238] / 238 [238, 238] | 1 [1, 1] / 1 [1, 1] |
| B | 100 | B0 | build | 100 [100, 100] / 100 [100, 100] | 300 [300, 300] / 300 [300, 300] | 100 [100, 100] / 100 [100, 100] | 100 [100, 100] / 100 [100, 100] | 201 [201, 201] / 201 [201, 201] | 404 [404, 404] / 404 [404, 404] | 203 [203, 203] / 203 [203, 203] | 0 [0, 0] / 0 [0, 0] |
| B | 100 | B0 | mock_post | 100 [100, 100] / 100 [100, 100] | 400 [400, 400] / 400 [400, 400] | 100 [100, 100] / 100 [100, 100] | 100 [100, 100] / 100 [100, 100] | 417 [417, 417] / 417 [417, 417] | 921 [921, 921] / 921 [921, 921] | 438 [438, 438] / 438 [438, 438] | 1 [1, 1] / 1 [1, 1] |
| B | 100 | candidate | build | 100 [100, 100] / 100 [100, 100] | 300 [300, 300] / 300 [300, 300] | 100 [100, 100] / 100 [100, 100] | 100 [100, 100] / 100 [100, 100] | 201 [201, 201] / 201 [201, 201] | 404 [404, 404] / 404 [404, 404] | 203 [203, 203] / 203 [203, 203] | 0 [0, 0] / 0 [0, 0] |
| B | 100 | candidate | mock_post | 100 [100, 100] / 100 [100, 100] | 400 [400, 400] / 400 [400, 400] | 100 [100, 100] / 100 [100, 100] | 100 [100, 100] / 100 [100, 100] | 417 [417, 417] / 417 [417, 417] | 921 [921, 921] / 921 [921, 921] | 438 [438, 438] / 438 [438, 438] | 1 [1, 1] / 1 [1, 1] |
| B | 200 | B0 | build | 200 [200, 200] / 200 [200, 200] | 600 [600, 600] / 600 [600, 600] | 200 [200, 200] / 200 [200, 200] | 200 [200, 200] / 200 [200, 200] | 401 [401, 401] / 401 [401, 401] | 804 [804, 804] / 804 [804, 804] | 403 [403, 403] / 403 [403, 403] | 0 [0, 0] / 0 [0, 0] |
| B | 200 | B0 | mock_post | 200 [200, 200] / 200 [200, 200] | 800 [800, 800] / 800 [800, 800] | 200 [200, 200] / 200 [200, 200] | 200 [200, 200] / 200 [200, 200] | 817 [817, 817] / 817 [817, 817] | 1721 [1721, 1721] / 1721 [1721, 1721] | 838 [838, 838] / 838 [838, 838] | 1 [1, 1] / 1 [1, 1] |
| B | 200 | candidate | build | 200 [200, 200] / 200 [200, 200] | 600 [600, 600] / 600 [600, 600] | 200 [200, 200] / 200 [200, 200] | 200 [200, 200] / 200 [200, 200] | 401 [401, 401] / 401 [401, 401] | 804 [804, 804] / 804 [804, 804] | 403 [403, 403] / 403 [403, 403] | 0 [0, 0] / 0 [0, 0] |
| B | 200 | candidate | mock_post | 200 [200, 200] / 200 [200, 200] | 800 [800, 800] / 800 [800, 800] | 200 [200, 200] / 200 [200, 200] | 200 [200, 200] / 200 [200, 200] | 817 [817, 817] / 817 [817, 817] | 1721 [1721, 1721] / 1721 [1721, 1721] | 838 [838, 838] / 838 [838, 838] | 1 [1, 1] / 1 [1, 1] |
| C | 5 | B0 | build | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 8 [8, 8] / 8 [8, 8] | 5 [5, 5] / 5 [5, 5] | 0 [0, 0] / 0 [0, 0] |
| C | 5 | B0 | mock_post | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 21 [21, 21] / 21 [21, 21] | 129 [129, 129] / 129 [129, 129] | 42 [42, 42] / 42 [42, 42] | 1 [1, 1] / 1 [1, 1] |
| C | 5 | candidate | build | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 3 [3, 3] / 3 [3, 3] | 0 [0, 0] / 0 [0, 0] |
| C | 5 | candidate | mock_post | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 17 [17, 17] / 17 [17, 17] | 121 [121, 121] / 121 [121, 121] | 38 [38, 38] / 38 [38, 38] | 1 [1, 1] / 1 [1, 1] |
| C | 25 | B0 | build | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 8 [8, 8] / 8 [8, 8] | 5 [5, 5] / 5 [5, 5] | 0 [0, 0] / 0 [0, 0] |
| C | 25 | B0 | mock_post | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 21 [21, 21] / 21 [21, 21] | 129 [129, 129] / 129 [129, 129] | 42 [42, 42] / 42 [42, 42] | 1 [1, 1] / 1 [1, 1] |
| C | 25 | candidate | build | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 3 [3, 3] / 3 [3, 3] | 0 [0, 0] / 0 [0, 0] |
| C | 25 | candidate | mock_post | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 17 [17, 17] / 17 [17, 17] | 121 [121, 121] / 121 [121, 121] | 38 [38, 38] / 38 [38, 38] | 1 [1, 1] / 1 [1, 1] |
| C | 50 | B0 | build | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 8 [8, 8] / 8 [8, 8] | 5 [5, 5] / 5 [5, 5] | 0 [0, 0] / 0 [0, 0] |
| C | 50 | B0 | mock_post | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 21 [21, 21] / 21 [21, 21] | 129 [129, 129] / 129 [129, 129] | 42 [42, 42] / 42 [42, 42] | 1 [1, 1] / 1 [1, 1] |
| C | 50 | candidate | build | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 3 [3, 3] / 3 [3, 3] | 0 [0, 0] / 0 [0, 0] |
| C | 50 | candidate | mock_post | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 17 [17, 17] / 17 [17, 17] | 121 [121, 121] / 121 [121, 121] | 38 [38, 38] / 38 [38, 38] | 1 [1, 1] / 1 [1, 1] |
| C | 100 | B0 | build | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 8 [8, 8] / 8 [8, 8] | 5 [5, 5] / 5 [5, 5] | 0 [0, 0] / 0 [0, 0] |
| C | 100 | B0 | mock_post | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 21 [21, 21] / 21 [21, 21] | 129 [129, 129] / 129 [129, 129] | 42 [42, 42] / 42 [42, 42] | 1 [1, 1] / 1 [1, 1] |
| C | 100 | candidate | build | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 3 [3, 3] / 3 [3, 3] | 0 [0, 0] / 0 [0, 0] |
| C | 100 | candidate | mock_post | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 17 [17, 17] / 17 [17, 17] | 121 [121, 121] / 121 [121, 121] | 38 [38, 38] / 38 [38, 38] | 1 [1, 1] / 1 [1, 1] |
| C | 200 | B0 | build | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 3 [3, 3] / 3 [3, 3] | 8 [8, 8] / 8 [8, 8] | 5 [5, 5] / 5 [5, 5] | 0 [0, 0] / 0 [0, 0] |
| C | 200 | B0 | mock_post | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 1 [1, 1] / 1 [1, 1] | 1 [1, 1] / 1 [1, 1] | 21 [21, 21] / 21 [21, 21] | 129 [129, 129] / 129 [129, 129] | 42 [42, 42] / 42 [42, 42] | 1 [1, 1] / 1 [1, 1] |
| C | 200 | candidate | build | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 1 [1, 1] / 1 [1, 1] | 4 [4, 4] / 4 [4, 4] | 3 [3, 3] / 3 [3, 3] | 0 [0, 0] / 0 [0, 0] |
| C | 200 | candidate | mock_post | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 0 [0, 0] / 0 [0, 0] | 17 [17, 17] / 17 [17, 17] | 121 [121, 121] / 121 [121, 121] | 38 [38, 38] / 38 [38, 38] | 1 [1, 1] / 1 [1, 1] |

A build makes zero model submissions; the measured POST makes exactly one MockTransport submission in both versions. The comparison adds no model classification round. Warm encoding does not bypass source integrity checks. Original synthetic asset hashes are unchanged in every scenario.

See the [benchmark script](../scripts/benchmark_agent_task_context.py) for the reproducible fixture and [actual-wire regressions](../tests/test_agent_task_context_projection.py) covering current image roles, Prompt provenance, selected history, incomplete-state fallback, and legacy compatibility.
