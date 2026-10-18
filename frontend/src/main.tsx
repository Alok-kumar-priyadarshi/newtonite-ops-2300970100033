import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ApiError } from './api/client';
import { App } from './App';
import { ToastProvider } from './components/Toasts';
import './index.css';

/** Any 401 means the session ended: go to login and come back afterwards. */
function onAuthError(err: unknown) {
  if (err instanceof ApiError && err.status === 401 && !location.pathname.startsWith('/login')) {
    queryClient.clear();
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: {
      retry: (count, err) => err instanceof ApiError && err.retryable && count < 2,
      refetchOnWindowFocus: true,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
