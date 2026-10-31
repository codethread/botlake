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
