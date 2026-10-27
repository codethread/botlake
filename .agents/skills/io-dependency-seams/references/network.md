# Network calls

For APIs organized by paths, typically expose a named service method per endpoint operation. Put request parameters in a typed options object passed to that method. Represent nested paths with named operations rather than chains of sub-methods.

Keep request construction, transport and response parsing inside the live adapter.
