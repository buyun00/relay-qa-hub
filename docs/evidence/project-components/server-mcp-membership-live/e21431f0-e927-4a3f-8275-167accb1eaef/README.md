# Server MCP: project membership actual run

The real server MCP run passed 59 checks from `2026-09-09T02:43:12.061Z` to `02:43:15.556Z`. It issued 35 JSON-RPC requests to 4421 and one separate proxy health GET. [Original proof](proof.json) SHA-256: `55ac6023679282fb4a7a0a985ff79db0a2718999f1869e41fe60b25e569834e5`. [Root artifact review](review.json) passed 14 checks without new network or process calls.

Two fresh projects remain: A `5c28c343-ba43-43c3-a180-d0bde0e845fa` and B `4234d5f0-8544-40af-938f-69ffb7d5edf3`. Their A-only and shared employees use unique run names. The shared employee ID is `4f4e5d93-5cb7-4a62-836d-7b21080a51e9`.

The actual MCP flow established a new employee through name login, repeated the same login with the same user ID, and verified an exact A-only directory. A second employee first joined A, then B under the same identity. Each project had one corresponding member entry; the A-only employee was absent from B.

MCP disabled only the shared employee's A membership. A name login returned `PROJECT_MEMBERSHIP_DISABLED`/403, and an old A token's Bug read returned `PROJECT_NOT_ACCESSIBLE`/403. B login and Bug reads continued to work, its membership fields/version/roles were unchanged, and its project directory contained only B. MCP restored A, after which the original employee ID and exact A/B directory returned. Final A membership version was 3, with one disable and one activation management event; neither event occurred in B.

All four component observations showed all five components off. Both final Bug lists were empty. API PID 22852 and MCP PID 15736 retained their original start times. No native client, local EXE MCP, browser, Android, external component, service deployment or production inventory was operated. Project and membership records, generated sessions, audit and evidence remain; no cleanup ran.

The request ledger preserves recursive redactions and response length/hash, not verbatim authentication bodies. Therefore the authentication response hashes cannot be independently recomputed from retained public content. The nested MCP tool denials arrived inside HTTP200 JSON-RPC responses and retain their actual 403 codes. This run supports the recorded server-MCP portions of baselines 01/02/04; it does not prove imported historical-name aliases, every error combination, any native client or local EXE MCP. The whole matrix is not promoted by this proof alone.
