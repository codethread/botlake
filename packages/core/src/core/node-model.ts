/** Attributes owned by Core's generic note records. */
export const noteAttributes = {
  /** Immutable note body. */
  text: "note/text",
  /** ISO timestamp supplied by the graph clock. */
  at: "note/at",
} as const;

export const noteRelations = {
  /** Note record to the graph node it annotates. */
  notes: "notes",
} as const;

/** Optional constraints owned by generic dependency edges. */
export const dependencyAttributes = {
  /** Accepted source projection kinds for an observed prerequisite. */
  referenceKinds: "dependency/reference-kinds",
} as const;
