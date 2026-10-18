import type { AssistantReply } from '@nops/shared';
import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { api, ApiError, get } from '../api/client';
import { Button, Spinner } from './ui';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  references?: AssistantReply['references'];
  steps?: AssistantReply['steps'];
  error?: boolean;
}

const SUGGESTIONS = [
  'What needs my attention today?',
  'Which P1 items are unassigned?',
  'What is Meera Pillai working on?',
  'What has the team done in the last few hours?',
  'Which items are blocked, and by what?',
];

const storageKey = (projectId?: string) => `nops-chat:${projectId ?? 'all'}`;
const load = (projectId?: string): Turn[] => {
  try {
    return JSON.parse(sessionStorage.getItem(storageKey(projectId)) ?? '[]');
  } catch {
    return [];
  }
};

/**
 * "Ask" panel: questions answered by the server-side assistant, which looks things up with the
 * user's own permissions (docs/13-assistant.md). The conversation is kept for this browser tab.
 */
export function AssistantDrawer({ projectId, onOpenItem, onClose }: { projectId?: string; onOpenItem: (id: string) => void; onClose: () => void }) {
  const status = useQuery({ queryKey: ['assistant-status'], queryFn: () => get<{ enabled: boolean; model: string }>('/assistant/status'), staleTime: 60_000 });
  const [turns, setTurns] = useState<Turn[]>(() => load(projectId));
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(storageKey(projectId), JSON.stringify(turns.slice(-30)));
    } catch {
      /* storage unavailable: the conversation just isn't kept */
    }
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    const history = [...turns.filter((t) => !t.error), { role: 'user' as const, content: q }];
    setTurns((t) => [...t, { role: 'user', content: q }]);
    setInput('');
    setBusy(true);
    try {
      const reply = await api<AssistantReply>('POST', '/assistant/chat', {
        messages: history.slice(-10).map((t) => ({ role: t.role, content: t.content.slice(0, 2000) })),
        projectId,
      });
      setTurns((t) => [...t, { role: 'assistant', content: reply.answer, references: reply.references, steps: reply.steps }]);
    } catch (err) {
      setTurns((t) => [...t, { role: 'assistant', content: err instanceof ApiError ? err.message : 'Something went wrong.', error: true }]);
    } finally {
      setBusy(false);
    }
  };

  const disabled = status.data && !status.data.enabled;

  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-2xl" role="dialog" aria-label="Ask assistant">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
        <span className="text-lg">✨</span>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold leading-tight">Ask</h2>
          <p className="text-xs text-slate-500">Answers from items you can see. Read-only.</p>
        </div>
        {turns.length > 0 && (
          <Button variant="ghost" onClick={() => setTurns([])} title="Start a new conversation">
            Clear
          </Button>
        )}
        <button className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {disabled && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            The assistant isn’t set up yet. Add <code className="rounded bg-white px-1">GROQ_API_KEY=…</code> to the
            <code className="rounded bg-white px-1">backend/.env</code> file and restart the server.
          </div>
        )}
        {turns.length === 0 && !disabled && (
          <div className="space-y-2">
            <p className="text-sm text-slate-600">Try asking:</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} className="block w-full rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-brand-500 hover:bg-brand-50" onClick={() => ask(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div key={i} className="ml-8 rounded-2xl rounded-br-sm bg-brand-600 px-3 py-2 text-sm text-white">
              {t.content}
            </div>
          ) : (
            <div key={i} className="mr-4 space-y-1.5">
              {t.steps && t.steps.length > 0 && (
                <ul className="space-y-0.5 text-xs text-slate-400">
                  {t.steps.map((s, j) => (
                    <li key={j}>🔎 {s.label}</li>
                  ))}
                </ul>
              )}
              <div className={`rounded-2xl rounded-bl-sm px-3 py-2 text-sm ${t.error ? 'bg-red-50 text-red-900' : 'bg-slate-100 text-slate-900'}`}>
                <Answer text={t.content} references={t.references ?? []} onOpenItem={onOpenItem} />
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner size={14} /> Looking it up…
          </div>
        )}
        <div ref={bottom} />
      </div>

      <form
        className="flex gap-2 border-t border-slate-200 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              ask(input);
            }
          }}
          rows={2}
          maxLength={2000}
          disabled={disabled}
          placeholder="e.g. What did Ravi approve today?"
          className="min-w-0 flex-1 resize-none rounded-md border border-slate-300 px-3 py-2 text-sm"
          autoFocus
        />
        <Button type="submit" variant="primary" disabled={!input.trim() || disabled} busy={busy}>
          Ask
        </Button>
      </form>
    </div>
  );
}

/** Minimal, safe formatting: paragraphs, "- " bullets, **bold**, and clickable item keys. */
function Answer({ text, references, onOpenItem }: { text: string; references: AssistantReply['references']; onOpenItem: (id: string) => void }) {
  const byKey = new Map(references.map((r) => [r.key, r]));
  // Item keys become buttons that open the item; works inside **bold** too.
  const linkKeys = (text: string, key: string): ReactNode[] =>
    text.split(/(\b[A-Z]{2,5}-\d+\b)/g).map((part, i) => {
      const ref = byKey.get(part);
      return ref ? (
        <button key={`${key}-${i}`} className="font-mono text-brand-700 underline decoration-dotted hover:text-brand-600" title={ref.title} onClick={() => onOpenItem(ref.id)}>
          {part}
        </button>
      ) : (
        part
      );
    });
  const inline = (line: string, key: string): ReactNode[] =>
    line.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      /^\*\*[^*]+\*\*$/.test(part) ? <strong key={`${key}-b${i}`}>{linkKeys(part.slice(2, -2), `${key}-b${i}`)}</strong> : linkKeys(part, `${key}-t${i}`),
    );

  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length) {
      const items = bullets;
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-0.5">
          {items.map((b, i) => (
            <li key={i}>{inline(b, `li-${blocks.length}-${i}`)}</li>
          ))}
        </ul>,
      );
      bullets = [];
    }
  };
  text.split('\n').forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(line);
    if (bullet) return void bullets.push(bullet[1]);
    flush();
    if (line.trim()) blocks.push(<p key={`p-${i}`}>{inline(line, `p-${i}`)}</p>);
  });
  flush();
  return <div className="space-y-1.5">{blocks}</div>;
}
