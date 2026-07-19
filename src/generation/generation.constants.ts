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

/** Redis key holding the id of the last generation job of a bank. */
export function bankJobKey(bankId: string): string {
  return `generation:bank:${bankId}`;
}
