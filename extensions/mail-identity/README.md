# Mail–Identity composition

Explicitly select Identity, Mail and `@botlake/extension-mail-identity` (or a local module exporting `mailIdentity()` from it). Importing the package activates nothing. Mail itself remains independent of Identity and Agents.

This composition adds outgoing `mail/sent-by` and `mail/sent-to` edges from message nodes to registered Identity nodes. It resolves the message's core identity strings, links new mail, backfills when an identity registers later, and reconciles existing mail at lake startup. It protects these derived relations from generic writes and reconciles them to the immutable sender/recipient attributes. It does not create identities for arbitrary address strings.

The named queries `mail-sent-by-node` and `mail-received-by-node` accept `{identityNode: NODE_ID}` and return associated message nodes. They compose with graph queries and Batteries await. Sender/recipient string queries remain available when no Identity node exists.

These edges describe addressing. They are not delivery receipts or process-custody claims. Existing Identity-to-run relationships can be traversed separately; explicit `mail/about` links describe message context without claiming which run handled it.
