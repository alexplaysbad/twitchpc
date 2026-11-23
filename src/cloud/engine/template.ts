import type { Action, TwitchEvent } from '../../shared/types.js';

function contextFor(event: TwitchEvent): Record<string, unknown> {
  return {
    event: {
      id: event.id,
      type: event.type,
      receivedAt: event.receivedAt
    },
    broadcaster: event.broadcaster,
    user: event.user,
    data: event.data
  };
}

function resolvePath(context: Record<string, unknown>, path: string): unknown {
  let current: unknown = context;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function renderTemplate(template: string, event: TwitchEvent): string {
  const context = contextFor(event);
  return template.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, rawPath: string) => {
    const value = resolvePath(context, rawPath.trim());
    return value === undefined || value === null ? '' : String(value);
  });
}

/** Returns a copy of the action with every template placeholder resolved. */
export function renderAction(action: Action, event: TwitchEvent): Action {
  const r = (value: string): string => renderTemplate(value, event);

  switch (action.type) {
    case 'exec':
      return {
        ...action,
        command: r(action.command),
        args: action.args.map(r),
        cwd: action.cwd === undefined ? undefined : r(action.cwd)
      };
    case 'hotkey':
      return {
        ...action,
        keys: r(action.keys),
        windowTitle: action.windowTitle === undefined ? undefined : r(action.windowTitle)
      };
    case 'obs_scene':
      return { ...action, sceneName: r(action.sceneName) };
    case 'obs_source':
      return {
        ...action,
        sourceName: r(action.sourceName),
        sceneName: action.sceneName === undefined ? undefined : r(action.sceneName)
      };
    case 'webhook':
      return {
        ...action,
        url: r(action.url),
        headers: Object.fromEntries(Object.entries(action.headers).map(([key, value]) => [r(key), r(value)])),
        body: r(action.body)
      };
  }
}
