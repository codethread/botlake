# Migrate a dependency seam

## 1. Map the consumed contract

Find every in-scope caller, operation, output shape and failure. Recover quirks from tests, comments and documentation. Record where each behavior is used and how parity will be verified. Limit the contract to consumed or deliberately exposed operations.

## 2. Shape the interface

Use named methods and typed arguments for the chosen domain interface, following the relevant I/O guide. Show the proposed interface with representative before/after call sites before spreading it across consumers.

Keep the interface, protocol translation, parsing, adapters and contract tests in one module. Leave application policy with consumers. Supply memory through the same injected interface as the live adapter.

## 3. Supply a faithful test adapter

Reuse a maintained stand-in when it satisfies the contract. Otherwise implement the consumed operations directly on isolated in-memory state. Preserve the dependency's observable filtering, ordering, mutation and failure rules, including state after refused writes and whether returned values share mutable state. Simulated competing writes can test application decisions; actual locking, crash durability and physical I/O need live tests.

## 4. Prove parity at the seam

Run shared scenarios against live and memory adapters using isolated fixtures. Cover exposed operations, interacting options, competing mutations and known quirks and failures. Normalize generated values only where necessary, preserving relationships and meaningful changes such as revisions.

Keep live contracts independently selectable. Verify selection includes changes to either adapter, the interface, parsers, contract tests and fixtures, relevant runtime configuration and dependency version. Consumer-only edits should normally rely on the validated memory adapter.

## 5. Migrate consumers and verify the result

Migrate every in-scope consumer through the injected interface while preserving application behavior. Move behavior tests to the shared adapter. Compare coverage before and after, accounting for lost live coverage before removing bespoke dependency fakes or duplicated dependency tests. Preserve application interactions and genuine I/O coverage.

Audit each migrated consumer's tests for tautologies and assertions replaced by trusted types. Explain removals through the coverage or type guarantee that replaces them; retain external parsing and nuanced behavior checks.

Keep precise usage beside the maintained interface. Explain why the dependency is used and any persistence or synchronization responsibilities consumers retain. Preserve useful operational guidance while removing duplicated mechanics. Run the project's checks and report contract changes, coverage gained or lost, and any inventoried behavior still unverified.
