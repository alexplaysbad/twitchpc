const $ = (id) => document.getElementById(id);

const EVENT_LABELS = {
  channel_points: 'Channel points',
  subscription: 'Subscription',
  gift_subscription: 'Gift subs',
  cheer: 'Bits / cheer',
  chat_command: 'Chat command'
};

const ACTION_LABELS = {
  exec: 'Run a program',
  cmd: 'Run a CMD command',
  hotkey: 'Send a hotkey',
  obs_scene: 'OBS scene',
  obs_source: 'OBS source',
  webhook: 'Webhook'
};

const TIER_LABELS = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };

const COMMON_VARIABLES = [
  ['user.login', 'Username'],
  ['user.displayName', 'Display name'],
  ['broadcaster.login', 'Channel'],
  ['event.type', 'Event type'],
  ['event.id', 'Event ID']
];

const EVENT_VARIABLES = {
  chat_command: [['data.command', 'Command'], ['data.message', 'Full message'], ['data.args', 'Arguments']],
  channel_points: [['data.rewardTitle', 'Reward title'], ['data.rewardId', 'Reward ID'], ['data.userInput', 'User input']],
  subscription: [['data.months', 'Months'], ['data.tier', 'Tier'], ['data.message', 'Sub message']],
  gift_subscription: [['data.amount', 'Gift amount'], ['data.total', 'Gift total'], ['data.tier', 'Tier']],
  cheer: [['data.bits', 'Bits'], ['data.message', 'Cheer message']]
};

function variablesForTrigger(type) {
  return [...(EVENT_VARIABLES[type] ?? []), ...COMMON_VARIABLES];
}

let lastTemplateTarget = null;

const state = {
  automations: [],
  agents: [],
  agentTokens: [],
  system: { automationsEnabled: true, eventSubEnabled: true, chatEnabled: true },
  editing: null,
  logs: [],
  commands: []
};

function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function getPath(obj, path, fallback = '') {
  let current = obj;
  for (const part of String(path).split('.')) {
    if (current === null || typeof current !== 'object') return fallback;
    current = current[part];
  }
  return current === undefined || current === null ? fallback : current;
}

function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = /^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i];
    if (current[key] === undefined || current[key] === null) current[key] = {};
    current = current[key];
  }
  const last = parts[parts.length - 1];
  current[/^\d+$/.test(last) ? Number(last) : last] = value;
}

async function api(path, options = {}) {
  const token = $('admin-token').value.trim();
  const headers = {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(options.headers ?? {})
  };
  if (options.body !== undefined && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(path, { ...options, headers });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      if (data?.error) message = data.error;
    } catch {
      // Response was not JSON; keep the status text.
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function defaultAction(type) {
  switch (type) {
    case 'exec':
      return { id: uid(), type: 'exec', target: 'agent', command: '', args: [], cwd: '' };
    case 'cmd':
      return { id: uid(), type: 'cmd', target: 'agent', command: '', cwd: '' };
    case 'hotkey':
      return { id: uid(), type: 'hotkey', target: 'agent', keys: '^a', windowTitle: '' };
    case 'obs_scene':
      return { id: uid(), type: 'obs_scene', target: 'agent', sceneName: '' };
    case 'obs_source':
      return { id: uid(), type: 'obs_source', target: 'agent', sourceName: '', sceneName: '', visible: true };
    case 'webhook':
      return { id: uid(), type: 'webhook', target: 'cloud', url: '', method: 'POST', headers: {}, body: '' };
    default:
      return { id: uid(), type: 'hotkey', target: 'agent', keys: '^a', windowTitle: '' };
  }
}

function defaultAutomation() {
  return {
    name: 'New automation',
    enabled: true,
    trigger: { type: 'chat_command', filters: { command: 'test' } },
    actions: [defaultAction('hotkey')],
    cooldownSeconds: 0,
    cooldownPerUserSeconds: 0
  };
}

function defaultFilters(type) {
  if (type === 'chat_command') return { command: 'test' };
  if (type === 'channel_points') return { rewardTitle: '' };
  if (type === 'cheer') return { minBits: 100 };
  if (type === 'subscription') return { minMonths: 1 };
  return {};
}

function triggerSummary(trigger) {
  const f = trigger?.filters ?? {};
  const tiers = (f.tiers ?? []).map((tier) => TIER_LABELS[tier] ?? tier).join(', ');
  switch (trigger?.type) {
    case 'chat_command':
      return `someone types !${f.command || '…'}${f.username ? ` as ${f.username}` : ''}`;
    case 'channel_points':
      return `reward “${f.rewardTitle || f.rewardId || '…'}” is redeemed${f.username ? ` by ${f.username}` : ''}`;
    case 'subscription':
      return `a sub happens${f.minMonths ? ` (${f.minMonths}+ months)` : ''}${tiers ? ` · ${tiers}` : ''}`;
    case 'gift_subscription':
      return `gift subs are given${tiers ? ` · ${tiers}` : ''}`;
    case 'cheer':
      return `${f.minBits || 0}+ bits are cheered`;
    default:
      return trigger?.type ?? 'unknown trigger';
  }
}

function actionSummary(action) {
  if (!action) return 'unknown action';
  switch (action.type) {
    case 'exec':
      return `Run ${action.command || 'program'}${action.args?.length ? ` ${action.args.join(' ')}` : ''}`;
    case 'cmd':
      return `Run cmd.exe /c ${action.command || '…'}`;
    case 'hotkey':
      return `Send hotkey ${action.keys || '…'}${action.windowTitle ? ` in “${action.windowTitle}”` : ''}`;
    case 'obs_scene':
      return `Switch OBS to “${action.sceneName || '…'}”`;
    case 'obs_source':
      return `${action.visible === false ? 'Hide' : 'Show'} source “${action.sourceName || '…'}”${action.sceneName ? ` in ${action.sceneName}` : ''}`;
    case 'webhook':
      return `Send ${action.method || 'POST'} webhook to ${action.url || '…'}`;
    default:
      return action.type;
  }
}

function automationName(id) {
  return state.automations.find((automation) => automation.id === id)?.name ?? `Unknown (${String(id).slice(0, 8)})`;
}

function cleanAutomation(automation) {
  const filters = {};
  for (const [key, value] of Object.entries(automation.trigger?.filters ?? {})) {
    if (value === '' || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    filters[key] = value;
  }

  const actions = (automation.actions ?? []).map((action) => {
    const next = { ...action };
    for (const [key, value] of Object.entries(next)) {
      if (typeof value === 'string' && value === '' && !['type', 'target', 'id'].includes(key)) delete next[key];
    }
    if (next.type === 'exec') next.args = Array.isArray(next.args) ? next.args : [];
    if (next.type === 'webhook') {
      next.headers = next.headers && typeof next.headers === 'object' ? next.headers : {};
      next.method = next.method || 'POST';
      next.body = typeof next.body === 'string' ? next.body : '';
    }
    return next;
  });

  return {
    ...automation,
    name: String(automation.name ?? '').trim(),
    enabled: Boolean(automation.enabled),
    trigger: { type: automation.trigger?.type, filters },
    actions,
    cooldownSeconds: Math.max(0, Number(automation.cooldownSeconds) || 0),
    cooldownPerUserSeconds: Math.max(0, Number(automation.cooldownPerUserSeconds) || 0)
  };
}

function setEditorStatus(message, isError = false) {
  const element = $('editor-status');
  element.textContent = message;
  element.style.color = isError ? 'var(--red)' : '';
}

/* ---------- Automations list ---------- */

function renderAutomations() {
  $('automation-count').textContent = String(state.automations.length);
  const container = $('automations');

  if (!state.automations.length) {
    container.innerHTML = `
      <div class="empty">
        <strong>No automations yet</strong>
        Create your first one — pick a Twitch event, then pick what should happen on the PC.
        <div class="row" style="justify-content:center;">
          <button class="btn primary" data-new="1">+ Create automation</button>
        </div>
      </div>`;
    return;
  }

  container.innerHTML = state.automations.map((automation) => `
    <article class="automation-card ${automation.enabled ? '' : 'is-disabled'}">
      <div class="automation-main">
        <label class="switch" title="${automation.enabled ? 'Click to disable' : 'Click to enable'}">
          <input type="checkbox" data-toggle="${esc(automation.id)}" ${automation.enabled ? 'checked' : ''} />
          <span></span>
        </label>
        <div>
          <h3>${esc(automation.name)}</h3>
          <p class="trigger-line">When ${esc(triggerSummary(automation.trigger))}</p>
          <p>Then ${esc((automation.actions ?? []).map(actionSummary).join(' · ') || 'nothing yet')}</p>
          ${automation.triggerCount ? `<p class="muted small">Triggered ${esc(automation.triggerCount)} time(s)${automation.lastTriggeredAt ? ` · last ${esc(fmtTime(automation.lastTriggeredAt))}` : ''}</p>` : ''}
        </div>
      </div>
      <div class="automation-actions">
        ${automation.cooldownSeconds ? `<span class="chip">⏱ ${esc(automation.cooldownSeconds)}s cooldown</span>` : ''}
        ${automation.cooldownPerUserSeconds ? `<span class="chip">👤 ${esc(automation.cooldownPerUserSeconds)}s user cooldown</span>` : ''}
        <button class="btn ghost" data-edit="${esc(automation.id)}">Edit</button>
        <button class="btn ghost" data-duplicate="${esc(automation.id)}">Duplicate</button>
        <button class="btn danger-ghost" data-delete="${esc(automation.id)}">Delete</button>
      </div>
    </article>`).join('');
}

async function loadAutomations() {
  state.automations = await api('/api/automations');
  renderAutomations();
  if (state.editing) updatePreview();
}

$('automations').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;

  if (button.dataset.new) {
    openBuilder(defaultAutomation());
    return;
  }

  const id = button.dataset.edit ?? button.dataset.duplicate ?? button.dataset.delete;
  if (!id) return;
  const automation = state.automations.find((item) => item.id === id);
  if (!automation) return;

  if (button.dataset.edit) {
    openBuilder(automation);
  } else if (button.dataset.duplicate) {
    const copy = JSON.parse(JSON.stringify(automation));
    delete copy.id;
    copy.name = `${automation.name} (copy)`;
    copy.actions = (copy.actions ?? []).map((action) => ({ ...action, id: uid() }));
    openBuilder(copy);
  } else if (button.dataset.delete) {
    if (!confirm(`Delete “${automation.name}”?`)) return;
    await api(`/api/automations/${id}`, { method: 'DELETE' });
    if (state.editing?.id === id) closeBuilder();
    await loadAutomations();
  }
});

$('automations').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-toggle]');
  if (!input) return;
  await api(`/api/automations/${input.dataset.toggle}/toggle`, { method: 'PATCH' });
  await loadAutomations();
});

/* ---------- Automation builder ---------- */

function openBuilder(automation) {
  state.editing = JSON.parse(JSON.stringify(automation));
  $('builder-card').classList.remove('hidden');
  $('builder-title').textContent = automation.id ? `Edit: ${automation.name}` : 'New automation';
  setEditorStatus('');
  renderBuilder();
  $('builder-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeBuilder() {
  $('builder-card').classList.add('hidden');
  state.editing = null;
}

function tiersField(filters) {
  const selected = filters?.tiers ?? [];
  return `
    <div class="field">
      <span>Sub tiers (optional)</span>
      <div class="check-row">
        ${Object.entries(TIER_LABELS).map(([value, label]) => `
          <label class="check-chip">
            <input type="checkbox" data-tier="${value}" ${selected.includes(value) ? 'checked' : ''} /> ${label}
          </label>`).join('')}
      </div>
    </div>`;
}

function triggerFields(trigger) {
  const f = trigger.filters ?? {};
  const user = `<label class="field"><span>From user (optional)</span><input data-path="trigger.filters.username" value="${esc(f.username ?? '')}" placeholder="e.g. viewer123" /></label>`;

  switch (trigger.type) {
    case 'chat_command':
      return `
        <label class="field"><span>Command (without !)</span><input data-path="trigger.filters.command" value="${esc(f.command ?? '')}" placeholder="e.g. reboot" /></label>
        ${user}`;
    case 'channel_points':
      return `
        <label class="field"><span>Reward title</span><input data-path="trigger.filters.rewardTitle" value="${esc(f.rewardTitle ?? '')}" placeholder="e.g. Switch Scene" /></label>
        <label class="field"><span>Reward ID (optional)</span><input data-path="trigger.filters.rewardId" value="${esc(f.rewardId ?? '')}" /></label>
        ${user}`;
    case 'subscription':
      return `
        <label class="field"><span>Minimum months (optional)</span><input type="number" min="0" data-path="trigger.filters.minMonths" value="${esc(f.minMonths ?? '')}" /></label>
        ${tiersField(f)}
        ${user}`;
    case 'gift_subscription':
      return `${tiersField(f)}${user}`;
    case 'cheer':
      return `
        <label class="field"><span>Minimum bits</span><input type="number" min="0" data-path="trigger.filters.minBits" value="${esc(f.minBits ?? '')}" placeholder="e.g. 100" /></label>
        ${user}`;
    default:
      return user;
  }
}

function agentField(action, index) {
  const options = [`<option value="" ${action.agentId ? '' : 'selected'}>First online agent</option>`];
  for (const agent of state.agents) {
    if (!agent.enabled) continue;
    options.push(`<option value="${esc(agent.id)}" ${action.agentId === agent.id ? 'selected' : ''}>${esc(agent.id)}${agent.connected ? ' (online)' : ' (offline)'}</option>`);
  }
  if (action.agentId && !state.agents.some((agent) => agent.id === action.agentId)) {
    options.push(`<option value="${esc(action.agentId)}" selected>${esc(action.agentId)} (unknown)</option>`);
  }
  return `<label class="field"><span>Agent</span><select data-path="actions.${index}.agentId">${options.join('')}</select></label>`;
}

function actionCard(action, index) {
  const p = `actions.${index}`;
  let fields = '';

  switch (action.type) {
    case 'exec':
      fields = `
        ${agentField(action, index)}
        <label class="field"><span>Program</span><input data-path="${p}.command" value="${esc(action.command ?? '')}" placeholder="notepad.exe" /></label>
        <label class="field"><span>Arguments (one per line)</span><textarea data-path="${p}.args" rows="3" placeholder="first argument&#10;second argument">${esc((action.args ?? []).join('\n'))}</textarea></label>
        <label class="field"><span>Working folder (optional)</span><input data-path="${p}.cwd" value="${esc(action.cwd ?? '')}" /></label>`;
      break;
    case 'cmd':
      fields = `
        ${agentField(action, index)}
        <label class="field wide"><span>CMD command</span><input data-path="${p}.command" value="${esc(action.command ?? '')}" placeholder="shutdown /s /t 0" /></label>
        <p class="muted small hotkey-hint">
          Runs as <code>cmd.exe /d /s /c "&lt;command&gt;"</code>. The final command must exactly match
          <code>CMD_ALLOWLIST</code> in the agent's .env or tray settings. Variables are resolved before that check.
        </p>
        <label class="field"><span>Working folder (optional)</span><input data-path="${p}.cwd" value="${esc(action.cwd ?? '')}" /></label>`;
      break;
    case 'hotkey':
      fields = `
        ${agentField(action, index)}
        <label class="field wide"><span>Keys</span><input data-path="${p}.keys" value="${esc(action.keys ?? '')}" placeholder="%{F4}" /></label>
        <p class="muted small hotkey-hint">
          Modifiers: <code>%</code> = Alt, <code>^</code> = Ctrl, <code>+</code> = Shift.
          Examples: <code>%{F4}</code> = Alt+F4, <code>^%t</code> = Ctrl+Alt+T, <code>+{F1}</code> = Shift+F1.
        </p>
        <label class="field"><span>Window title (optional)</span><input data-path="${p}.windowTitle" value="${esc(action.windowTitle ?? '')}" placeholder="OBS" /></label>`;
      break;
    case 'obs_scene':
      fields = `${agentField(action, index)}
        <label class="field"><span>Scene name</span><input data-path="${p}.sceneName" value="${esc(action.sceneName ?? '')}" placeholder="e.g. BRB" /></label>`;
      break;
    case 'obs_source':
      fields = `
        ${agentField(action, index)}
        <label class="field"><span>Source name</span><input data-path="${p}.sourceName" value="${esc(action.sourceName ?? '')}" /></label>
        <label class="field"><span>Scene (optional)</span><input data-path="${p}.sceneName" value="${esc(action.sceneName ?? '')}" /></label>
        <label class="check-chip" style="align-self:end;"><input type="checkbox" data-path="${p}.visible" ${action.visible !== false ? 'checked' : ''} /> Visible</label>`;
      break;
    case 'webhook':
      fields = `
        <label class="field"><span>URL</span><input data-path="${p}.url" value="${esc(action.url ?? '')}" placeholder="https://example.com/hook" /></label>
        <label class="field"><span>Method</span><select data-path="${p}.method">
          ${['POST', 'GET', 'PUT'].map((method) => `<option value="${method}" ${action.method === method ? 'selected' : ''}>${method}</option>`).join('')}
        </select></label>
        <label class="field wide"><span>Body (supports {{event.user.login}} templates)</span><textarea data-path="${p}.body" rows="3">${esc(action.body ?? '')}</textarea></label>
        <label class="field wide"><span>Headers (JSON, optional)</span><textarea data-path="${p}.headers" rows="3" placeholder='{"Content-Type":"application/json"}'>${esc(JSON.stringify(action.headers ?? {}, null, 2))}</textarea></label>`;
      break;
  }

  return `
    <div class="action-card">
      <div class="action-head">
        <strong>${esc(ACTION_LABELS[action.type] ?? action.type)}</strong>
        <div class="row" style="margin:0;">
          <button type="button" class="btn tiny ghost" data-move-action="${index}" data-direction="-1" ${index === 0 ? 'disabled' : ''} title="Move up">↑</button>
          <button type="button" class="btn tiny ghost" data-move-action="${index}" data-direction="1" title="Move down">↓</button>
          <button type="button" class="btn tiny danger-ghost" data-remove-action="${index}">Remove</button>
        </div>
      </div>
      <div class="action-fields">
        <label class="field wide"><span>Action type</span>
          <select data-path="${p}.type">
            ${Object.entries(ACTION_LABELS).map(([value, label]) => `<option value="${value}" ${action.type === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        ${fields}
      </div>
    </div>`;
}

function renderBuilder() {
  const automation = state.editing;
  if (!automation) return;

  $('builder').innerHTML = `
    <div class="field-grid">
      <label class="field"><span>Name</span><input data-path="name" value="${esc(automation.name ?? '')}" placeholder="e.g. Reward switches scene" /></label>
      <label class="field"><span>Cooldown (seconds)</span><input type="number" min="0" data-path="cooldownSeconds" value="${esc(automation.cooldownSeconds ?? 0)}" /></label>
      <label class="field"><span>Per-user cooldown (seconds)</span><input type="number" min="0" data-path="cooldownPerUserSeconds" value="${esc(automation.cooldownPerUserSeconds ?? 0)}" /></label>
      <label class="check-chip" style="align-self:end;"><input type="checkbox" data-path="enabled" ${automation.enabled ? 'checked' : ''} /> Enabled</label>
    </div>

    <div class="template-helper">
      <span>Insert into the last focused text field:</span>
      <select id="variable-select">
        <option value="">Choose a variable…</option>
        ${variablesForTrigger(automation.trigger?.type).map(([path, label]) => `<option value="${esc(path)}">${esc(label)} — {{${esc(path)}}}</option>`).join('')}
      </select>
      <button type="button" class="btn tiny ghost" id="insert-variable">Insert</button>
    </div>

    <div class="builder-grid">
      <div class="step">
        <h3><span class="step-num">1</span> When this happens</h3>
        <label class="field" style="margin-bottom:12px;"><span>Trigger</span>
          <select data-path="trigger.type">
            ${Object.entries(EVENT_LABELS).map(([value, label]) => `<option value="${value}" ${automation.trigger?.type === value ? 'selected' : ''}>${label}</option>`).join('')}
          </select>
        </label>
        <div class="field-grid">${triggerFields(automation.trigger ?? { type: 'chat_command', filters: {} })}</div>
      </div>

      <div class="step">
        <h3><span class="step-num">2</span> Do this</h3>
        <div>${(automation.actions ?? []).map((action, index) => actionCard(action, index)).join('')}</div>
        <div class="add-action">
          <select id="new-action-type">
            ${Object.entries(ACTION_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
          <button type="button" class="btn ghost" id="add-action">+ Add action</button>
        </div>
      </div>
    </div>

    <details class="advanced">
      <summary>Preview generated JSON</summary>
      <pre id="json-preview"></pre>
    </details>`;

  updatePreview();
}

function updatePreview() {
  const preview = $('json-preview');
  if (preview && state.editing) preview.textContent = JSON.stringify(cleanAutomation(state.editing), null, 2);
}

$('builder').addEventListener('input', (event) => {
  const input = event.target;
  const path = input.dataset.path;
  if (!path || !state.editing) return;

  if (path.endsWith('.args')) {
    setPath(state.editing, path, input.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  } else if (path.endsWith('.headers')) {
    try {
      const parsed = JSON.parse(input.value || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be an object');
      const headers = {};
      for (const [key, value] of Object.entries(parsed)) headers[key] = String(value);
      setPath(state.editing, path, headers);
      delete input.dataset.invalid;
      input.classList.remove('invalid');
    } catch {
      input.dataset.invalid = '1';
      input.classList.add('invalid');
    }
  } else if (input.type === 'checkbox') {
    setPath(state.editing, path, input.checked);
  } else if (input.type === 'number') {
    setPath(state.editing, path, input.value === '' ? 0 : Number(input.value));
  } else {
    setPath(state.editing, path, input.value);
  }
  updatePreview();
});

$('builder').addEventListener('change', (event) => {
  const input = event.target;
  if (!state.editing) return;

  if (input.dataset.tier) {
    const tier = input.dataset.tier;
    const selected = new Set(state.editing.trigger.filters?.tiers ?? []);
    if (input.checked) selected.add(tier);
    else selected.delete(tier);
    state.editing.trigger.filters.tiers = [...selected];
    updatePreview();
    return;
  }

  const path = input.dataset.path;
  if (!path) return;

  if (path === 'trigger.type') {
    state.editing.trigger = { type: input.value, filters: defaultFilters(input.value) };
    renderBuilder();
  } else if (/^actions\.\d+\.type$/.test(path)) {
    const index = Number(path.split('.')[1]);
    const previous = state.editing.actions[index];
    const next = defaultAction(input.value);
    next.id = previous?.id ?? uid();
    state.editing.actions[index] = next;
    renderBuilder();
  }
});

$('builder').addEventListener('focusin', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) lastTemplateTarget = target;
});

$('builder').addEventListener('click', (event) => {
  if (!state.editing) return;

  if (event.target.closest('#insert-variable')) {
    const path = $('variable-select').value;
    if (!path) return;
    const target = lastTemplateTarget;
    if (!target || !document.body.contains(target)) {
      alert('Click a text field first, then choose a variable.');
      return;
    }
    const token = `{{${path}}}`;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    target.value = target.value.slice(0, start) + token + target.value.slice(end);
    target.focus();
    target.setSelectionRange(start + token.length, start + token.length);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  if (event.target.closest('#add-action')) {
    state.editing.actions.push(defaultAction($('new-action-type').value));
    renderBuilder();
    return;
  }

  const move = event.target.closest('[data-move-action]');
  if (move) {
    const index = Number(move.dataset.moveAction);
    const direction = Number(move.dataset.direction);
    const target = index + direction;
    const actions = state.editing.actions;
    if (target < 0 || target >= actions.length) return;
    [actions[index], actions[target]] = [actions[target], actions[index]];
    renderBuilder();
    return;
  }

  const remove = event.target.closest('[data-remove-action]');
  if (remove) {
    state.editing.actions.splice(Number(remove.dataset.removeAction), 1);
    renderBuilder();
  }
});

function validateAutomation(automation) {
  if (!automation.name?.trim()) return 'Give the automation a name.';
  if (!automation.trigger?.type) return 'Choose a trigger.';

  const f = automation.trigger.filters ?? {};
  if (automation.trigger.type === 'chat_command' && !f.command?.trim()) return 'Enter the chat command (without !).';
  if (automation.trigger.type === 'channel_points' && !f.rewardTitle?.trim() && !f.rewardId?.trim()) {
    return 'Enter a reward title or reward ID.';
  }
  if (!automation.actions?.length) return 'Add at least one action.';

  for (const [index, action] of automation.actions.entries()) {
    if (action.type === 'exec' && !action.command?.trim()) return `Action ${index + 1}: enter a program.`;
    if (action.type === 'cmd' && !action.command?.trim()) return `Action ${index + 1}: enter a CMD command.`;
    if (action.type === 'hotkey' && !action.keys?.trim()) return `Action ${index + 1}: enter a hotkey.`;
    if (action.type === 'obs_scene' && !action.sceneName?.trim()) return `Action ${index + 1}: enter a scene name.`;
    if (action.type === 'obs_source' && !action.sourceName?.trim()) return `Action ${index + 1}: enter a source name.`;
    if (action.type === 'webhook' && !action.url?.trim()) return `Action ${index + 1}: enter a webhook URL.`;
  }

  if ($('builder').querySelector('[data-invalid]')) return 'Fix the highlighted headers JSON first.';
  return null;
}

async function saveAutomation() {
  if (!state.editing) return;
  const problem = validateAutomation(state.editing);
  if (problem) {
    setEditorStatus(problem, true);
    return;
  }

  try {
    const payload = cleanAutomation(state.editing);
    const saved = payload.id
      ? await api(`/api/automations/${payload.id}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await api('/api/automations', { method: 'POST', body: JSON.stringify(payload) });
    state.editing = saved;
    $('builder-title').textContent = `Edit: ${saved.name}`;
    updatePreview();
    setEditorStatus('Saved ✓');
    await loadAutomations();
  } catch (error) {
    setEditorStatus(`Error: ${error.message}`, true);
  }
}

$('new-automation').onclick = () => openBuilder(defaultAutomation());
$('builder-close').onclick = closeBuilder;
$('save-automation').onclick = () => void saveAutomation();

$('export-automations').onclick = () => {
  const blob = new Blob([JSON.stringify(state.automations, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `twitchpc-automations-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
};

$('import-automations').onclick = () => $('import-file').click();
$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const automations = Array.isArray(parsed) ? parsed : [parsed];
    if (!automations.length) throw new Error('No automations found in file.');
    if (!confirm(`Import ${automations.length} automation(s)? They will be added as new automations.`)) return;
    const result = await api('/api/automations/import', {
      method: 'POST',
      body: JSON.stringify(automations)
    });
    await loadAutomations();
    alert(`Imported ${result.imported} automation(s).`);
  } catch (error) {
    alert(`Import failed: ${error.message}`);
  }
});

/* ---------- Event simulator ---------- */

function simFields(type) {
  const user = `<label class="field"><span>Username</span><input data-sim-path="user_login" value="viewer123" /></label>`;

  switch (type) {
    case 'chat_command':
      return `
        <label class="field"><span>Chat message</span><input data-sim-path="message" value="!test" placeholder="!reboot" /></label>
        ${user}
        <p class="muted small" style="grid-column:1/-1;">The command is taken from the first word after !.</p>`;
    case 'channel_points':
      return `
        <label class="field"><span>Reward title</span><input data-sim-path="rewardTitle" value="Switch Scene" /></label>
        <label class="field"><span>Reward ID (optional)</span><input data-sim-path="rewardId" value="" /></label>
        <label class="field"><span>User input (optional)</span><input data-sim-path="userInput" value="" /></label>
        ${user}`;
    case 'subscription':
      return `
        <label class="field"><span>Tier</span><select data-sim-path="tier">
          ${Object.entries(TIER_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select></label>
        <label class="field"><span>Months</span><input type="number" min="1" data-sim-path="months" value="1" /></label>
        <label class="field"><span>Streak months</span><input type="number" min="0" data-sim-path="streak_months" value="0" /></label>
        <label class="field"><span>Message</span><input data-sim-path="message" value="Hello!" /></label>
        ${user}`;
    case 'gift_subscription':
      return `
        <label class="field"><span>Tier</span><select data-sim-path="tier">
          ${Object.entries(TIER_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
        </select></label>
        <label class="field"><span>How many</span><input type="number" min="1" data-sim-path="amount" value="1" /></label>
        ${user}`;
    case 'cheer':
      return `
        <label class="field"><span>Bits</span><input type="number" min="1" data-sim-path="bits" value="100" /></label>
        <label class="field"><span>Message</span><input data-sim-path="message" value="Let's go!" /></label>
        ${user}`;
    default:
      return user;
  }
}

function renderSimFields() {
  $('sim-fields').innerHTML = simFields($('sim-type').value);
}

function buildSimPayload() {
  const payload = {};
  for (const input of $('sim-fields').querySelectorAll('[data-sim-path]')) {
    let value = input.value;
    if (input.type === 'number') value = value === '' ? 0 : Number(value);
    setPath(payload, input.dataset.simPath, value);
  }
  return payload;
}

function eventSummary(event) {
  const data = event?.data ?? {};
  const user = event?.user?.login || 'someone';
  switch (event?.type) {
    case 'chat_command':
      return `${data.message || '!command'} from ${user}`;
    case 'channel_points':
      return `“${data.rewardTitle || data.rewardId || 'reward'}” redeemed by ${user}`;
    case 'subscription':
      return `${TIER_LABELS[data.tier] ?? data.tier ?? 'Sub'} · ${data.months ?? 1} month(s)`;
    case 'gift_subscription': {
      const tier = TIER_LABELS[data.tier] ?? data.tier;
      return `${data.amount ?? 1} gift sub(s)${tier ? ` · ${tier}` : ''}`;
    }
    case 'cheer':
      return `${data.bits ?? 0} bits${data.message ? ` · ${data.message}` : ''}`;
    default:
      return event?.type ?? 'event';
  }
}

function renderSimResult(response, execute) {
  const { event, result } = response;
  const names = (result.matched ?? []).map(automationName);

  let html = `
    <div class="result-head">
      <span class="pill ${execute ? 'run' : 'preview'}">${execute ? 'Ran' : 'Preview'}</span>
      <strong>${esc(eventSummary(event))}</strong>
    </div>`;

  if (!names.length) {
    html += `<p class="empty-small">No enabled automation matched this event. Check your trigger filters.</p>`;
  } else {
    html += `<p class="result-label">Matched automations</p><ul>${names.map((name) => `<li>${esc(name)}</li>`).join('')}</ul>`;
    if (result.commands?.length) {
      html += `<p class="result-label">${execute ? 'Actions sent' : 'Actions that would run'}</p>
        <ul>${result.commands.map((command) => `<li><strong>${esc(command.automationName)}</strong> → ${esc(actionSummary(command.action))}</li>`).join('')}</ul>`;
    }
    if (result.cooldownSkipped?.length) {
      html += `<p class="result-label">Skipped because of cooldown</p>
        <ul>${result.cooldownSkipped.map((id) => `<li>${esc(automationName(id))}</li>`).join('')}</ul>`;
    }
  }

  html += `<p class="muted small">${execute
    ? 'Actions were queued. Check Recent commands for status.'
    : 'Nothing was sent — this was only a preview.'}</p>`;

  $('sim-result').innerHTML = `<div class="result-body">${html}</div>`;
  $('sim-raw').textContent = JSON.stringify(response, null, 2);
}

async function simulate(execute) {
  if (execute && !confirm('This will actually run the matching actions. Continue?')) return;
  try {
    const response = await api('/api/simulate', {
      method: 'POST',
      body: JSON.stringify({ type: $('sim-type').value, payload: buildSimPayload(), execute })
    });
    renderSimResult(response, execute);
    await loadActivity();
  } catch (error) {
    $('sim-result').innerHTML = `<div class="result-body"><span class="status-tag failed">Error: ${esc(error.message)}</span></div>`;
  }
}

$('sim-type').addEventListener('change', renderSimFields);
$('simulate').onclick = () => void simulate(false);
$('simulate-execute').onclick = () => void simulate(true);

$('logs').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-replay]');
  if (!button) return;
  const execute = button.dataset.execute === 'true';
  if (execute && !confirm('Replay this event and actually run matching actions?')) return;
  try {
    const response = await api(`/api/events/${button.dataset.replay}/replay`, {
      method: 'POST',
      body: JSON.stringify({ execute })
    });
    renderSimResult(response, execute);
    $('sim-result').scrollIntoView({ behavior: 'smooth', block: 'center' });
    await loadActivity();
  } catch (error) {
    alert(`Replay failed: ${error.message}`);
  }
});

/* ---------- Activity ---------- */

function fmtTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function logSummary(entry) {
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  switch (entry.type) {
    case 'chat_command':
      return getPath(payload, 'message') || getPath(payload, 'raw.message') || payload.command || 'Chat message';
    case 'channel_points':
      return getPath(payload, 'reward.title') || payload.rewardTitle || payload.rewardId || 'Reward redeemed';
    case 'subscription':
      return `${TIER_LABELS[payload.tier] ?? payload.tier ?? 'Sub'} · ${payload.months ?? 1} month(s)`;
    case 'gift_subscription': {
      const tier = TIER_LABELS[payload.tier] ?? payload.tier;
      return `${payload.amount ?? 1} gift sub(s)${tier ? ` · ${tier}` : ''}`;
    }
    case 'cheer':
      return `${payload.bits ?? 0} bits${payload.message ? ` · ${payload.message}` : ''}`;
    default:
      return entry.type;
  }
}

function logUser(entry) {
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : {};
  return payload.user_login || payload.user_name || payload.username || getPath(payload, 'raw.username') || '—';
}

function renderLogs() {
  const rows = state.logs.map((entry) => {
    const matched = (entry.matched ?? []).map((id) => `<span class="chip">${esc(automationName(id))}</span>`).join(' ') || '—';
    return `
      <tr>
        <td>${esc(fmtTime(entry.createdAt))}</td>
        <td><span class="type-tag">${esc(EVENT_LABELS[entry.type] ?? entry.type)}</span></td>
        <td>${esc(logSummary(entry))}</td>
        <td>${esc(logUser(entry))}</td>
        <td>${matched}</td>
        <td>
          <button class="btn tiny ghost" data-replay="${esc(entry.id)}" data-execute="false">Replay</button>
          <button class="btn tiny danger-ghost" data-replay="${esc(entry.id)}" data-execute="true">+ Run</button>
        </td>
      </tr>`;
  }).join('');

  $('logs').innerHTML = `
    <table>
      <thead><tr><th>When</th><th>Event</th><th>Details</th><th>User</th><th>Matched</th><th>Replay</th></tr></thead>
      <tbody>${rows || '<tr class="empty-row"><td colspan="6">No events yet</td></tr>'}</tbody>
    </table>`;
}

function renderCommands() {
  const rows = state.commands.map((command) => `
    <tr>
      <td>${esc(fmtTime(command.createdAt))}</td>
      <td>${esc(command.automationName || '—')}</td>
      <td>${esc(actionSummary(command.action))}</td>
      <td>
        <span class="status-tag ${esc(command.status)}">${esc(command.status)}</span>
        ${command.error ? `<span class="error-text">${esc(command.error)}</span>` : ''}
      </td>
    </tr>`).join('');

  $('commands').innerHTML = `
    <table>
      <thead><tr><th>When</th><th>Automation</th><th>Action</th><th>Status</th></tr></thead>
      <tbody>${rows || '<tr class="empty-row"><td colspan="4">No commands yet</td></tr>'}</tbody>
    </table>`;
}

async function loadActivity() {
  const [logs, commands] = await Promise.all([
    api('/api/logs?limit=20'),
    api('/api/commands?limit=20')
  ]);
  state.logs = logs;
  state.commands = commands;
  renderLogs();
  renderCommands();
}

async function loadSystem() {
  state.system = await api('/api/system');
  renderSystem();
}

function renderSystem() {
  const enabled = Boolean(state.system?.automationsEnabled);
  const input = $('master-enabled');
  const label = $('master-label');
  const wrap = input?.closest('.master-switch');
  if (input) input.checked = enabled;
  if (label) label.textContent = enabled ? 'System on' : 'System off';
  if (wrap) wrap.classList.toggle('off', !enabled);
}

$('master-enabled').addEventListener('change', async (event) => {
  const enabled = event.target.checked;
  try {
    state.system = await api('/api/system', {
      method: 'PATCH',
      body: JSON.stringify({
        automationsEnabled: enabled,
        eventSubEnabled: enabled,
        chatEnabled: enabled
      })
    });
    renderSystem();
  } catch (error) {
    event.target.checked = !enabled;
    alert(`Could not update system: ${error.message}`);
  }
});

async function loadAgents() {
  const [agents, tokens] = await Promise.all([
    api('/api/agents'),
    api('/api/agents/tokens')
  ]);
  state.agents = agents;
  state.agentTokens = tokens;
  renderAgentManager();

  const active = agents.filter((agent) => agent.enabled);
  const online = active.filter((agent) => agent.connected);
  const badge = $('agent-status');
  badge.textContent = !agents.length
    ? 'No agent paired'
    : !active.length
      ? 'All agents disabled'
      : online.length
        ? `Agent online${online.length > 1 ? ` (${online.length})` : ''}`
        : 'Agent offline';
  badge.className = `status-pill ${online.length ? 'online' : 'offline'}`;
}

function renderAgentManager() {
  const container = $('agent-manager');
  if (!container) return;

  const tokens = new Map(state.agentTokens.map((token) => [token.agentId, token]));
  const rows = state.agents.map((agent) => {
    const token = tokens.get(agent.id);
    const status = !agent.enabled ? 'Disabled' : agent.connected ? 'Online' : 'Offline';
    const statusClass = !agent.enabled ? 'skipped' : agent.connected ? 'done' : 'failed';
    return `
      <tr>
        <td><strong>${esc(agent.id)}</strong></td>
        <td><span class="status-tag ${statusClass}">${status}</span></td>
        <td>${esc(fmtTime(agent.lastSeen))}</td>
        <td>${token
          ? `Paired · last used ${esc(fmtTime(token.lastUsedAt))}`
          : '<span class="muted">No token (shared fallback)</span>'}</td>
        <td>
          <label class="switch" title="${agent.enabled ? 'Disable agent' : 'Enable agent'}">
            <input type="checkbox" data-agent-enabled="${esc(agent.id)}" ${agent.enabled ? 'checked' : ''} />
            <span></span>
          </label>
        </td>
        <td>
          <button class="btn tiny danger-ghost" data-agent-revoke-token="${esc(agent.id)}">Revoke token</button>
          <button class="btn tiny danger-ghost" data-agent-delete="${esc(agent.id)}">Delete</button>
        </td>
      </tr>`;
  }).join('');

  container.innerHTML = `
    <table>
      <thead><tr><th>Agent</th><th>Status</th><th>Last seen</th><th>Token</th><th>Enabled</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr class="empty-row"><td colspan="6">No agents paired yet</td></tr>'}</tbody>
    </table>`;
}

$('agent-manager').addEventListener('change', async (event) => {
  const input = event.target.closest('input[data-agent-enabled]');
  if (!input) return;
  const id = input.dataset.agentEnabled;
  const enabled = input.checked;
  if (!enabled && !confirm(`Disable agent “${id}”? It will be disconnected and blocked until re-enabled.`)) {
    input.checked = true;
    return;
  }
  try {
    await api(`/api/agents/${encodeURIComponent(id)}/enabled`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled })
    });
    await loadPairing();
  } catch (error) {
    input.checked = !enabled;
    alert(`Agent update failed: ${error.message}`);
  }
});

$('agent-manager').addEventListener('click', async (event) => {
  const button = event.target.closest('button[data-agent-revoke-token], button[data-agent-delete]');
  if (!button) return;

  try {
    if (button.dataset.agentRevokeToken) {
      const id = button.dataset.agentRevokeToken;
      if (!confirm(`Revoke the token for “${id}”? It will be disconnected immediately.`)) return;
      await api(`/api/agents/${encodeURIComponent(id)}/token`, { method: 'DELETE' });
    } else if (button.dataset.agentDelete) {
      const id = button.dataset.agentDelete;
      if (!confirm(`Delete agent “${id}”? Its token and pending codes are removed and the ID cannot reconnect until you pair a new agent.`)) return;
      await api(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }
    await loadPairing();
  } catch (error) {
    alert(`Agent update failed: ${error.message}`);
  }
});

async function refreshAll() {
  try {
    await Promise.all([loadSystem(), loadAutomations(), loadActivity(), loadAgents()]);
  } catch (error) {
    if (/admin token|401/i.test(error.message)) {
      const badge = $('agent-status');
      badge.textContent = 'Add your admin token in Settings';
      badge.className = 'status-pill offline';
    }
    console.error('Refresh failed:', error);
  }
}

/* ---------- Pairing & theme ---------- */

let lastPairing = null;

function pairingSnippet() {
  if (!lastPairing) return '';
  return [
    `AGENT_ID=${lastPairing.agentId}`,
    `PAIRING_CODE=${lastPairing.code}`
  ].join('\n');
}

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall back to the old select + copy path below.
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const ok = document.execCommand('copy');
  input.remove();
  return ok;
}

function showPairingCode(result) {
  lastPairing = result;
  $('pairing-code').textContent = result.code;
  $('pairing-result').classList.remove('hidden');
  $('pairing-instructions').textContent =
    `Agent ID: ${result.agentId}. Paste this code into the tray app when it asks, ` +
    `or add the snippet to the .env file next to twitchpc-agent.exe. ` +
    `It expires at ${fmtTime(result.expiresAt)} and works once.`;
}

async function loadPairing() {
  const codes = await api('/api/pairing');
  await loadAgents();
  const tokens = state.agentTokens;

  const rows = [
    ...codes.map((code) => `
      <div class="pairing-item">
        <div><strong>${esc(code.agentId)}</strong> <span class="chip">unused code</span>
          <div class="muted small">Expires ${esc(fmtTime(code.expiresAt))}</div>
        </div>
        <button class="btn tiny danger-ghost" data-revoke-code="${esc(code.code)}">Revoke code</button>
      </div>`),
    ...tokens.map((token) => `
      <div class="pairing-item">
        <div><strong>${esc(token.agentId)}</strong> <span class="chip">paired</span>
          <div class="muted small">Last used ${esc(fmtTime(token.lastUsedAt))}</div>
        </div>
        <button class="btn tiny danger-ghost" data-revoke-token="${esc(token.agentId)}">Revoke token</button>
      </div>`)
  ];

  $('pairing-list').innerHTML = rows.join('') ||
    '<p class="muted small">No pairing codes or agent tokens yet.</p>';
}

async function generatePairing() {
  const status = $('pairing-instructions');
  try {
    status.textContent = 'Generating code…';
    const agentId = $('pair-agent-id').value.trim();
    const result = await api('/api/pairing', {
      method: 'POST',
      body: JSON.stringify(agentId ? { agentId } : {})
    });
    showPairingCode(result);
    await loadPairing();
  } catch (error) {
    status.textContent = `Could not generate a code: ${error.message}`;
  }
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('theme-toggle').textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
  $('theme-toggle').setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
  try {
    localStorage.setItem('twitchpc-theme', theme);
  } catch {
    // Theme still applies for this session.
  }
}

/* ---------- Boot ---------- */

const tokenInput = $('admin-token');
tokenInput.value = localStorage.getItem('twitchpc-admin-token') ?? '';
tokenInput.addEventListener('change', () => {
  localStorage.setItem('twitchpc-admin-token', tokenInput.value);
  void refreshAll();
});

$('refresh').onclick = () => void refreshAll();

try {
  applyTheme(localStorage.getItem('twitchpc-theme') === 'dark' ? 'dark' : 'light');
} catch {
  applyTheme('light');
}
$('theme-toggle').onclick = () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
};

$('pair-agent').onclick = () => {
  $('pairing-card').classList.remove('hidden');
  $('pairing-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  void loadPairing().catch((error) => {
    $('pairing-instructions').textContent = `Could not load pairing status: ${error.message}`;
  });
};
$('pairing-close').onclick = () => $('pairing-card').classList.add('hidden');
$('generate-pairing').onclick = () => void generatePairing();
$('copy-pairing').onclick = async () => {
  const ok = await copyText(pairingSnippet());
  $('pairing-instructions').textContent = ok
    ? 'Code copied. Paste it into the tray app prompt, or add the snippet to the agent .env and restart it.'
    : 'Copy failed; select the code above and paste it into the tray prompt manually.';
};
$('pairing-list').addEventListener('click', async (event) => {
  const target = event.target instanceof Element ? event.target : null;
  const button = target?.closest('button[data-revoke-code], button[data-revoke-token]');
  if (!button) return;
  try {
    if (button.dataset.revokeCode) {
      await api(`/api/pairing/${encodeURIComponent(button.dataset.revokeCode)}`, { method: 'DELETE' });
    } else {
      await api(`/api/agents/${encodeURIComponent(button.dataset.revokeToken)}/token`, { method: 'DELETE' });
    }
    await loadPairing();
    await loadAgents();
  } catch (error) {
    $('pairing-instructions').textContent = `Could not revoke: ${error.message}`;
  }
});

renderSimFields();
void refreshAll();
setInterval(() => {
  void Promise.allSettled([loadSystem(), loadAgents(), loadActivity()]);
}, 5000);
