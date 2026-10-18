import { useParams } from 'react-router-dom';
import { ItemDetailView } from '../components/ItemDetailView';

export function ItemPage() {
  const { itemId } = useParams();
  return (
    <div className="mx-auto h-full max-w-4xl bg-white md:my-4 md:h-[calc(100%-2rem)] md:rounded-xl md:border md:border-slate-200">
      <ItemDetailView key={itemId} itemId={itemId!} />
    </div>
  );
}
