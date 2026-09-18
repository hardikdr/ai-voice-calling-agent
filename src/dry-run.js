const wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, milliseconds);
  const abort = () => {
    clearTimeout(timer);
    reject(new DOMException('Dry run aborted', 'AbortError'));
  };
  if (signal.aborted) return abort();
  signal.addEventListener('abort', abort, { once: true });
});

export async function runDryCall({ runStore, runId, signal, delayMs = 150, onChange = () => {} }) {
  try {
    runStore.transition(runId, 'dialing');
    onChange();
    await wait(delayMs, signal);

    runStore.transition(runId, 'connected');
    onChange();
    await wait(delayMs, signal);

    runStore.appendTranscript(
      runId,
      'assistant',
      'Guten Tag, ich bin eine digitale Assistenz und führe einen sicheren Testanruf durch.',
    );
    onChange();
    await wait(delayMs, signal);

    runStore.appendTranscript(
      runId,
      'human',
      'Der Testanruf wurde verstanden. Es wurden keine externen Systeme verwendet.',
    );
    onChange();
    await runStore.finish(runId, {
      status: 'completed',
      summary: 'Dry run completed successfully without contacting Twilio or OpenAI.',
    });
    onChange();
  } catch (error) {
    if (error?.name === 'AbortError') return;
    const run = runStore.getRun(runId);
    if (run && !['completed', 'failed', 'cancelled'].includes(run.status)) {
      await runStore.finish(runId, {
        status: 'failed',
        summary: 'Dry run failed.',
        error: error.message,
      });
      onChange();
    }
  }
}
