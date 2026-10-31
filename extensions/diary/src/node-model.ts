/** Attribute namespace reserved for Diary-owned node state. */
export const diaryNamespace = "diary/" as const;

export const diaryAttributes = {
  /** Marks an immutable diary entry node. */
  entry: "diary/entry",
} as const;
