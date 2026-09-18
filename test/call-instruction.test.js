import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ValidationError,
  validateCallInstruction,
} from '../src/call-instruction.js';

const completeInstruction = {
  phone_number: '+4930123456',
  language: 'de',
  my_name: 'Ada',
  objective: 'Ask for opening hours.',
  allowed_times: [],
  forbidden_times: [],
  facts_agent_may_disclose: [],
  actions_agent_may_take: ['ask questions'],
  actions_requiring_confirmation: ['accept fees'],
  dry_run: true,
};

test('accepts and normalizes an explicit call instruction', () => {
  const result = validateCallInstruction(completeInstruction);

  assert.deepEqual(result, completeInstruction);
});

test('defaults optional authority lists and dry-run mode', () => {
  const result = validateCallInstruction({
    phone_number: '+4930123456',
    language: 'auto',
    my_name: ' Ada ',
    objective: ' Ask for opening hours. ',
  });

  assert.deepEqual(result, {
    phone_number: '+4930123456',
    language: 'auto',
    my_name: 'Ada',
    objective: 'Ask for opening hours.',
    allowed_times: [],
    forbidden_times: [],
    facts_agent_may_disclose: [],
    actions_agent_may_take: [],
    actions_requiring_confirmation: [],
    dry_run: false,
  });
});

test('rejects malformed and unknown instruction fields with paths', () => {
  assert.throws(
    () => validateCallInstruction({
      phone_number: '030',
      language: 'fr',
      my_name: 'Ada',
      objective: '',
      allowed_times: 'afternoon',
      surprise: true,
    }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      const paths = error.issues.map((issue) => issue.path);
      assert.ok(paths.includes('phone_number'));
      assert.ok(paths.includes('language'));
      assert.ok(paths.includes('objective'));
      assert.ok(paths.includes('allowed_times'));
      assert.ok(paths.includes('surprise'));
      return true;
    },
  );
});
