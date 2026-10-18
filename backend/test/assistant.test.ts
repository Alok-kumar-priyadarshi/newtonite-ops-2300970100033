import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { loadActor } from '../src/http/auth';
import { runAssistant } from '../src/services/assistant';
import { as, createItem, type Fixture, fixture, sql } from './helpers';

let f: Fixture;
beforeEach(async () => {
  f = await fixture();
});
afterAll(() => sql.end());

/**
 * A fake Groq endpoint: replays scripted model replies and records every request,
 * so we can check what the server sent back to the model (tool results).
 */
function fakeGroq(replies: object[]) {
  const requests: any[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const reply = replies.shift() ?? { role: 'assistant', content: 'done' };
    return new Response(JSON.stringify({ choices: [{ message: reply }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const toolCall = (name: string, args: object) => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});

const lastToolResult = (req: any) => JSON.parse(req.messages.filter((m: any) => m.role === 'tool').at(-1).content);

describe('assistant', () => {
  it('is switched off without an API key (503)', async () => {
    const res = await as(f.users.member).post('/api/assistant/chat', { messages: [{ role: 'user', content: 'hi' }] }, null);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ASSISTANT_DISABLED');
    const status = await as(f.users.member).get('/api/assistant/status');
    expect(status.body.enabled).toBe(false);
  });

  it('answers "what is X doing" by calling a tool as the user and returning the result to the model', async () => {
    const item = await createItem(f.users.member2, f.pay.id, { title: 'Refund for ACME', assigneeId: f.users.member2 });
    const groq = fakeGroq([
      toolCall('get_person_activity', { name: 'Member2' }),
      { role: 'assistant', content: `Member2 User last created ${item.key} (Refund for ACME).` },
    ]);
    const actor = (await loadActor(f.users.lead))!;
    const reply = await runAssistant(
      actor,
      { messages: [{ role: 'user', content: 'What is Member2 doing?' }], projectId: f.pay.id },
      { apiKey: 'test', fetch: groq.impl },
    );

    expect(groq.requests).toHaveLength(2);
    expect(groq.requests[0].model).toBe('openai/gpt-oss-120b');
    expect(groq.requests[0].tools.map((t: any) => t.function.name)).toContain('get_person_activity');
    const toolResult = lastToolResult(groq.requests[1]);
    expect(toolResult.person).toMatch(/Member2 User/);
    expect(toolResult.recentActions[0]).toMatchObject({ what: `created ${item.key}`, item: `${item.key} Refund for ACME` });
    expect(reply.answer).toContain(item.key);
    expect(reply.references).toEqual([{ id: item.id, key: item.key, title: 'Refund for ACME' }]);
    expect(reply.steps[0].tool).toBe('get_person_activity');
  });

  it('cannot see projects the user is not a member of', async () => {
    await createItem(f.users.member, f.pay.id, { title: 'Zebracorn secret refund' });
    const groq = fakeGroq([
      toolCall('search_items', { text: 'Zebracorn', allProjects: true }),
      toolCall('get_person_activity', { name: 'Member User' }),
      { role: 'assistant', content: 'Nothing found.' },
    ]);
    const outsider = (await loadActor(f.users.outsider))!;
    await runAssistant(
      outsider,
      // A PAY project id sent by the browser must be ignored for an outsider.
      { messages: [{ role: 'user', content: 'Find Zebracorn' }], projectId: f.pay.id },
      { apiKey: 'test', fetch: groq.impl },
    );
    expect(lastToolResult(groq.requests[1])).toEqual({ total: 0, items: [] });
    expect(lastToolResult(groq.requests[2]).error).toMatch(/No one called/);
    // The prompt lists only the outsider's own project, and not the one the browser claimed.
    const prompt: string = groq.requests[0].messages[0].content;
    expect(prompt).toContain('OTH project (OTH)');
    expect(prompt).not.toContain('PAY project');
  });

  it('turns tool errors and bad arguments into messages the model can recover from', async () => {
    const groq = fakeGroq([
      { role: 'assistant', content: null, tool_calls: [{ id: 'x', type: 'function', function: { name: 'get_item', arguments: '{not json' } }] },
      toolCall('get_item', { key: 'PAY-99999' }),
      { role: 'assistant', content: 'That item does not exist.' },
    ]);
    const actor = (await loadActor(f.users.member))!;
    const reply = await runAssistant(actor, { messages: [{ role: 'user', content: 'Show PAY-99999' }] }, { apiKey: 'test', fetch: groq.impl });
    expect(lastToolResult(groq.requests[1]).error).toBeTruthy();
    expect(lastToolResult(groq.requests[2]).error).toMatch(/not found/);
    expect(reply.answer).toBe('That item does not exist.');
  });

  it('links item keys even when the model writes them with a typographic hyphen', async () => {
    const item = await createItem(f.users.member, f.pay.id, { title: 'Hyphen test' });
    const fancy = item.key.replace('-', '‑'); // non-breaking hyphen, as gpt-oss often writes
    const groq = fakeGroq([toolCall('get_item', { key: item.key }), { role: 'assistant', content: `See **${fancy}**.` }]);
    const actor = (await loadActor(f.users.member))!;
    const reply = await runAssistant(actor, { messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'test', fetch: groq.impl });
    expect(reply.answer).toBe(`See **${item.key}**.`);
    expect(reply.references.map((r) => r.key)).toEqual([item.key]);
  });

  it('retries once when the provider is busy (429)', async () => {
    let calls = 0;
    const busyOnce = (async () => {
      calls++;
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'retry-after': '0' } })
        : new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const actor = (await loadActor(f.users.member))!;
    const reply = await runAssistant(actor, { messages: [{ role: 'user', content: 'x' }] }, { apiKey: 'test', fetch: busyOnce });
    expect(reply.answer).toBe('ok');
    expect(calls).toBe(2);
  });

  it('reports a rejected API key clearly', async () => {
    const actor = (await loadActor(f.users.member))!;
    const bad = (async () => new Response('{"error":"invalid key"}', { status: 401 })) as unknown as typeof fetch;
    await expect(
      runAssistant(actor, { messages: [{ role: 'user', content: 'hi' }] }, { apiKey: 'wrong', fetch: bad }),
    ).rejects.toMatchObject({ code: 'ASSISTANT_FAILED' });
  });
});
