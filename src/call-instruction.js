import { z } from 'zod';

const text = z.string().trim().min(1);
const textList = z.array(text).default([]);

const callInstructionSchema = z.strictObject({
  phone_number: z.string().trim().regex(/^\+[1-9]\d{7,14}$/, 'Must be an E.164 phone number'),
  language: z.enum(['de', 'en', 'auto']),
  my_name: text,
  objective: text,
  allowed_times: textList,
  forbidden_times: textList,
  facts_agent_may_disclose: textList,
  actions_agent_may_take: textList,
  actions_requiring_confirmation: textList,
  dry_run: z.boolean().default(false),
});

export class ValidationError extends Error {
  constructor(issues) {
    super('Call instruction is invalid');
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export function validateCallInstruction(value) {
  const result = callInstructionSchema.safeParse(value);
  if (result.success) return result.data;

  const issues = result.error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : unknownKey(issue),
    message: issue.message,
  }));
  throw new ValidationError(issues);
}

function unknownKey(issue) {
  if (issue.code === 'unrecognized_keys' && issue.keys?.length) {
    return String(issue.keys[0]);
  }
  return '$';
}
