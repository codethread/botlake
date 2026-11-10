---
name: botlake-ops
description: Use for authoring Botlake CLI ops.
---

# Botlake ops

- Keep default payloads minimal: value agent context and progressively disclose detail.
- Paginate collections that can enumerate more than ~30 items; expose continuation and completeness.
- Use `--show-*` flags to include specific details, for both single-item and paginated results.
- Keep op source lines within 180 characters, including help text and primers.
- Keep sentences intact: tighten wording to fit, and use arrays of complete sentences joined with `.join(" ")` for longer prose.
