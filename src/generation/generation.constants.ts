/** BullMQ queue for AI answer-set generation (one job covers a whole bank). */
export const GENERATION_QUEUE = 'generation';

/** Job name for the "generate answer sets for a bank" task. */
export const GENERATE_BANK_JOB = 'generate-bank';

/**
 * Payload of a generate-bank job; consumed by the generation worker (task
 * 0041). questionIds are the bank's questions that still need an answer set.
 */
export interface GenerateBankJobData {
  bankId: string;
  questionIds: string[];
}

/** Job name for the "regenerate a single answer set" task. */
export const REGENERATE_SET_JOB = 'regenerate-set';

/**
 * Payload of a regenerate-set job: the same per-question pipeline as
 * generate-bank, but for one answer set (task 0041 consumes it too).
 */
export interface RegenerateSetJobData {
  answerSetId: string;
  questionId: string;
}

/** Redis key holding the id of the last generation job of a bank. */
export function bankJobKey(bankId: string): string {
  return `generation:bank:${bankId}`;
}
