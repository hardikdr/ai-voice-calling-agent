import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const terminalStates = new Set(['completed', 'failed', 'cancelled']);
const transitions = new Map([
  ['validating', new Set(['dialing', 'failed', 'cancelled'])],
  ['dialing', new Set(['connected', 'failed', 'cancelled'])],
  ['connected', new Set(['completed', 'failed', 'cancelled'])],
]);

export class ActiveCallError extends Error {
  constructor() {
    super('A call is already active');
    this.name = 'ActiveCallError';
  }
}

export class RunStore {
  #runs = new Map();
  #private = new Map();
  #storagePath;
  #clock;
  #idFactory;
  #latestRunId = null;

  constructor({ storagePath, clock = () => new Date(), idFactory = randomUUID }) {
    this.#storagePath = storagePath;
    this.#clock = clock;
    this.#idFactory = idFactory;
  }

  start(instruction, privateValues = {}) {
    if (this.#activeRun()) throw new ActiveCallError();

    const now = this.#timestamp();
    const run = {
      id: this.#idFactory(),
      status: 'validating',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      instruction: structuredClone(instruction),
      transcript: [],
      summary: '',
      providerCallId: null,
      error: null,
    };
    this.#runs.set(run.id, run);
    this.#private.set(run.id, { ...privateValues });
    this.#latestRunId = run.id;
    return run;
  }

  transition(runId, nextStatus, changes = {}) {
    const run = this.#require(runId);
    if (!transitions.get(run.status)?.has(nextStatus)) {
      throw new Error(`Cannot transition run from ${run.status} to ${nextStatus}`);
    }
    Object.assign(run, changes, {
      status: nextStatus,
      updatedAt: this.#timestamp(),
    });
    return run;
  }

  appendTranscript(runId, speaker, text) {
    const run = this.#require(runId);
    if (!['assistant', 'human'].includes(speaker)) {
      throw new Error(`Unsupported transcript speaker: ${speaker}`);
    }
    const normalized = String(text).trim();
    if (!normalized) return run;
    run.transcript.push({
      timestamp: this.#timestamp(),
      speaker,
      text: normalized,
    });
    run.updatedAt = this.#timestamp();
    return run;
  }

  async finish(runId, { status, summary = '', error = null }) {
    if (!terminalStates.has(status)) {
      throw new Error(`Expected terminal run status, received ${status}`);
    }
    const run = this.transition(runId, status, {
      summary: String(summary).trim(),
      error: error ? String(error) : null,
      completedAt: this.#timestamp(),
    });
    await this.#persist(run);
    this.#private.delete(runId);
    return run;
  }

  cancel(runId, reason = 'Cancelled') {
    return this.finish(runId, { status: 'cancelled', summary: reason });
  }

  getRun(runId) {
    return this.#runs.get(runId) ?? null;
  }

  getPrivate(runId) {
    return this.#private.get(runId) ?? null;
  }

  setPrivate(runId, values) {
    const current = this.#private.get(runId);
    if (!current) throw new Error(`Private state is unavailable for run ${runId}`);
    Object.assign(current, values);
  }

  publicState() {
    const activeRun = this.#activeRun();
    const latestRun = this.#latestRunId ? this.#runs.get(this.#latestRunId) : null;
    return {
      activeRun: activeRun ? publicRun(activeRun) : null,
      latestRun: latestRun ? publicRun(latestRun) : null,
    };
  }

  #activeRun() {
    return [...this.#runs.values()].find((run) => !terminalStates.has(run.status)) ?? null;
  }

  #require(runId) {
    const run = this.#runs.get(runId);
    if (!run) throw new Error(`Unknown run: ${runId}`);
    return run;
  }

  #timestamp() {
    return this.#clock().toISOString();
  }

  async #persist(run) {
    await mkdir(this.#storagePath, { recursive: true });
    const destination = join(this.#storagePath, `${run.id}.json`);
    const temporary = `${destination}.tmp`;
    await writeFile(temporary, `${JSON.stringify(publicRun(run), null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, destination);
  }
}

function publicRun(run) {
  return structuredClone({
    id: run.id,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
    instruction: run.instruction,
    transcript: run.transcript,
    summary: run.summary,
    providerCallId: run.providerCallId,
    error: run.error,
  });
}
