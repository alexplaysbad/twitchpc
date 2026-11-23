import { describe, expect, it } from 'vitest';
import { renderAction, renderTemplate } from '../src/cloud/engine/template.ts';
import { simulateEvent } from '../src/cloud/twitch/normalize.ts';

const broadcaster = { id: 'bc', login: 'streamer' };

describe('templates', () => {
  const event = simulateEvent(
    'cheer',
    { bits: 250, message: 'go!', user_login: 'viewer', user_name: 'Viewer' },
    broadcaster
  );

  it('resolves dotted paths', () => {
    expect(renderTemplate('{{user.login}} cheered {{data.bits}}', event)).toBe('viewer cheered 250');
    expect(renderTemplate('{{missing.path}}end', event)).toBe('end');
  });

  it('renders webhook fields', () => {
    const action = {
      id: 'a1',
      label: 'Alert',
      type: 'webhook' as const,
      target: 'cloud' as const,
      url: 'https://example.test/{{user.login}}',
      method: 'POST' as const,
      headers: { 'X-Viewer': '{{user.displayName}}' },
      body: '{"bits": {{data.bits}}}'
    };
    expect(renderAction(action, event)).toEqual({
      ...action,
      url: 'https://example.test/viewer',
      headers: { 'X-Viewer': 'Viewer' },
      body: '{"bits": 250}'
    });
  });
});
