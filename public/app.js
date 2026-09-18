const exampleInstruction = {
  phone_number: '+4930123456',
  language: 'de',
  my_name: 'Example User',
  objective: 'Ask what the opening hours are tomorrow.',
  allowed_times: [],
  forbidden_times: [],
  facts_agent_may_disclose: [],
  actions_agent_may_take: ['ask questions and report the answer'],
  actions_requiring_confirmation: ['agree to fees', 'make an appointment'],
  dry_run: true,
};

const terminalStates = new Set(['completed', 'failed', 'cancelled']);

export function deriveControls(state) {
  return {
    canStart: !state.activeRun,
    canEnd: Boolean(state.activeRun),
    canDownload: Boolean(state.latestRun && terminalStates.has(state.latestRun.status)),
  };
}

export function formatValidationIssues(issues = []) {
  return issues.map(({ path, message }) => `${path}: ${message}`).join('\n');
}

if (typeof document !== 'undefined') initialize();

function initialize() {
  const elements = {
    instruction: document.querySelector('#instruction'),
    start: document.querySelector('#start-call'),
    end: document.querySelector('#end-call'),
    download: document.querySelector('#download-run'),
    status: document.querySelector('#status'),
    transcript: document.querySelector('#transcript'),
    summary: document.querySelector('#summary'),
    errors: document.querySelector('#validation-errors'),
  };
  let state = { activeRun: null, latestRun: null };

  elements.instruction.value = localStorage.getItem('calling-agent-draft')
    ?? JSON.stringify(exampleInstruction, null, 2);
  elements.instruction.addEventListener('input', () => {
    localStorage.setItem('calling-agent-draft', elements.instruction.value);
  });

  const render = (nextState) => {
    state = nextState;
    const run = state.activeRun ?? state.latestRun;
    const controls = deriveControls(state);
    elements.start.disabled = !controls.canStart;
    elements.end.disabled = !controls.canEnd;
    elements.download.disabled = !controls.canDownload;
    elements.status.textContent = run?.status ?? 'idle';
    elements.status.dataset.status = run?.status ?? 'idle';
    renderTranscript(elements.transcript, run?.transcript ?? []);
    elements.summary.textContent = run?.summary || 'The machine-generated call summary will appear here.';
  };

  elements.start.addEventListener('click', async () => {
    elements.errors.textContent = '';
    let instruction;
    try {
      instruction = JSON.parse(elements.instruction.value);
    } catch (error) {
      elements.errors.textContent = `JSON: ${error.message}`;
      return;
    }
    const response = await fetch('/api/calls', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(instruction),
    });
    const body = await response.json();
    if (!response.ok) elements.errors.textContent = formatValidationIssues(body.issues) || body.error;
  });

  elements.end.addEventListener('click', async () => {
    if (!state.activeRun) return;
    const response = await fetch(`/api/calls/${encodeURIComponent(state.activeRun.id)}/hangup`, {
      method: 'POST',
    });
    if (!response.ok) {
      const body = await response.json();
      elements.errors.textContent = body.error;
    }
  });

  elements.download.addEventListener('click', () => {
    if (!state.latestRun) return;
    const blob = new Blob([`${JSON.stringify(state.latestRun, null, 2)}\n`], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `${state.latestRun.id}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  fetch('/api/state').then((response) => response.json()).then(render).catch(showDisconnected);
  const events = new EventSource('/api/events');
  events.addEventListener('state', (event) => render(JSON.parse(event.data)));
  events.onerror = showDisconnected;

  function showDisconnected() {
    elements.status.textContent = 'disconnected';
    elements.status.dataset.status = 'failed';
  }
}

function renderTranscript(container, transcript) {
  container.replaceChildren();
  if (transcript.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No conversation yet.';
    container.append(empty);
    return;
  }
  for (const entry of transcript) {
    const row = document.createElement('li');
    row.dataset.speaker = entry.speaker;
    const label = document.createElement('span');
    label.className = 'speaker';
    label.textContent = entry.speaker;
    const text = document.createTextNode(entry.text);
    row.append(label, text);
    container.append(row);
  }
}
