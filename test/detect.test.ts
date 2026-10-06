import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectClaudePlan, detectCodexPlan } from '../src/detect/subscriptions.js';
import { readCodexModels, claudeModels } from '../src/detect/agents.js';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const env = {
  claudeJson: path.join(fixtures, 'claude.json'),
  codexHome: path.join(fixtures, 'codex-home'),
};

describe('subscriptions', () => {
  it('reads the Claude tier and maps it to a label, without exposing the account', async () => {
    const plan = await detectClaudePlan(env.claudeJson);
    expect(plan).toEqual({ agent: 'claude', raw: 'default_claude_max_5x', label: 'Claude Max 5x', source: 'measured' });
    expect(JSON.stringify(plan)).not.toContain('example.com');
  });

  it('reads the Codex plan from the most recent rollout', async () => {
    const plan = await detectCodexPlan(env.codexHome);
    expect(plan).toMatchObject({ agent: 'codex', raw: 'pro', label: 'ChatGPT Pro', source: 'measured' });
  });

  it('does not fall back to an older session, which may belong to another account', async () => {
    const plan = await detectCodexPlan(path.join(fixtures, 'codex-home-switched'));
    expect(plan).toMatchObject({ raw: null, label: 'unknown' });
  });

  it('reports unknown when nothing is readable', async () => {
    expect(await detectClaudePlan('/nonexistent/claude.json')).toMatchObject({ raw: null, label: 'unknown' });
    expect(await detectCodexPlan('/nonexistent')).toMatchObject({ raw: null, label: 'unknown' });
  });
});

describe('models', () => {
  it('lists the Codex models the account can pick, hiding internal ones', async () => {
    expect(await readCodexModels(env.codexHome)).toEqual(['gpt-6-astra', 'gpt-6-luna']);
  });

  it('lists Claude models from the price table', () => {
    const models = claudeModels();
    expect(models).toContain('claude-opus-5-5');
    expect(models).toContain('claude-opus-5');
    expect(models.every((m) => m.startsWith('claude-'))).toBe(true);
  });
});
