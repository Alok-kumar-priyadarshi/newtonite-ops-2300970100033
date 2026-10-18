import type { CanvasData, ItemCard } from '@nops/shared';
import { describe, expect, it } from 'vitest';
import { applyItemChanges } from './applyChanges';

const card = (id: string, stage: string, over: Partial<ItemCard> = {}): ItemCard =>
  ({ id, stage: { id: stage, name: stage, kind: 'active' }, priority: 3, dueAt: null, version: 1, ...over }) as ItemCard;

const data = (stages: Record<string, ItemCard[]>): CanvasData =>
  ({ stages: Object.entries(stages).map(([stageId, items]) => ({ stageId, count: items.length, items })) }) as CanvasData;

describe('applyItemChanges', () => {
  it('moves a card from its old stage to its new one, in priority order, with server counts', () => {
    const prev = data({ open: [card('a', 'open'), card('b', 'open')], prog: [card('c', 'prog', { priority: 4 })] });
    const next = applyItemChanges(prev, [card('a', 'prog', { version: 2, priority: 1 })], { open: 1, prog: 2 });
    expect(next.stages[0].items.map((i) => i.id)).toEqual(['b']);
    expect(next.stages[1].items.map((i) => i.id)).toEqual(['a', 'c']);
    expect(next.stages.map((s) => s.count)).toEqual([1, 2]);
  });

  it('removes deleted cards and ignores older versions than what is shown', () => {
    const prev = data({ open: [card('a', 'open', { version: 5 }), card('b', 'open')] });
    const next = applyItemChanges(prev, [card('a', 'prog', { version: 4 }), { ...card('b', 'open', { version: 2 }), deleted: true }], { open: 1 });
    expect(next.stages[0].items.map((i) => i.id)).toEqual(['a']);
    expect(next.stages[0].items[0].version).toBe(5);
  });
});
