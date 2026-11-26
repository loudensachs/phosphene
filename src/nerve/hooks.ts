// Extension points for asynchronous services (ML inference and the like).
/** Awaited by the offline renderer after every cooked frame, so async results land deterministically one frame later. */
export const exportSettle: (() => Promise<void>)[] = [];
