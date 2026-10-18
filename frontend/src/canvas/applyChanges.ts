import { type CanvasData, type ItemCard, LIMITS } from '@nops/shared';

/** Same order the server uses for a stage's cards: priority, then due date (none last), then id. */
export function cardOrder(a: ItemCard, b: ItemCard): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const da = a.dueAt ? Date.parse(a.dueAt) : Infinity;
  const db = b.dueAt ? Date.parse(b.dueAt) : Infinity;
  if (da !== db) return da - db;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Applies changed cards from the changes feed to the canvas data in place of a full reload:
 * a moved card leaves its old stage and joins its new one (if it ranks in the top N shown),
 * deleted cards disappear, edited cards are replaced, and stage counts come from the server.
 * A card only replaces a cached copy with an equal or higher version.
 */
export function applyItemChanges(prev: CanvasData, changed: ItemCard[], stageCounts: Record<string, number>): CanvasData {
  const byId = new Map(changed.map((c) => [c.id, c]));
  return {
    ...prev,
    stages: prev.stages.map((s) => {
      let items = s.items
        .filter((i) => {
          const c = byId.get(i.id);
          return !c || c.version < i.version || (!c.deleted && c.stage.id === s.stageId);
        })
        .map((i) => {
          const c = byId.get(i.id);
          return c && c.version >= i.version ? c : i;
        });
      for (const c of changed) {
        if (!c.deleted && c.stage.id === s.stageId && !items.some((i) => i.id === c.id)) items.push(c);
      }
      items = items.sort(cardOrder).slice(0, LIMITS.stageCardsOnCanvas);
      return { ...s, items, count: stageCounts[s.stageId] ?? 0 };
    }),
  };
}
