import { useEffect } from 'react';
import { ItemDetailView } from './ItemDetailView';

/** Item detail as a right-side panel; the page behind stays in place. */
export function ItemDrawer({ itemId, onClose }: { itemId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === 'Escape' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-y-0 right-0 z-40 flex w-full max-w-2xl flex-col border-l border-slate-200 bg-white shadow-2xl">
      <ItemDetailView key={itemId} itemId={itemId} onClose={onClose} />
    </div>
  );
}
