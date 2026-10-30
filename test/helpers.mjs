// Fakes shared by the tests.

/** @returns {import('../plugins/trace/scripts/lib/docs.mjs').Reads} the reads of an agent whose reads cannot be known */
export const noReads = () => ({ records: () => null, add() {}, clear() {} })
