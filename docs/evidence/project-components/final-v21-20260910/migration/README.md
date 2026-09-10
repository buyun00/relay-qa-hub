# QA Hub v2.1 isolated migration and rollback drill

Status: **PASS**

- Schema/API sequence: 19 -> 20 -> 19.
- MCP tool catalog sequence: 94 -> 96 -> 94.
- The same employee, project, and 5 Bugs were read through real HTTP and MCP in all phases.
- Logical project, membership, Bug, comment, attachment, workflow, and verification rows stayed identical.
- 5 evidence/quarantine files stayed byte-identical.
- The v19-to-v20 migration backup is byte-identical to the canonical schema19 DB (d860506b3a9e6de28fda1d301edc8d23af2b53221046e375d1c6619acf467567).
- Every phase ran in its own copied runtime and its exact owned PIDs were stopped afterward.
- The original schema19 source runtime, production, daily clients, and existing preview instances were not modified.
