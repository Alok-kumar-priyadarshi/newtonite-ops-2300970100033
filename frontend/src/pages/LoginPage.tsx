import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, get } from '../api/client';
import { Button, inputCls, labelCls } from '../components/ui';

const DEMO_PASSWORD = 'Demo@1234';

export function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const demo = useQuery({
    queryKey: ['demo-users'],
    queryFn: () => get<{ email: string; fullName: string; designation: string; roles: string }[]>('/auth/demo-users'),
    retry: false,
  });

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError(null);
    try {
      const me = await api('POST', '/auth/login', { email: e, password: p });
      qc.setQueryData(['me'], me);
      // Only same-site paths: "/x" yes; "//evil.com" and "/\evil.com" (open redirects) no.
      const next = params.get('next');
      const safe = next && /^\/(?![/\\])/.test(next) && !next.includes('\\');
      navigate(safe ? next : '/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-slate-50 p-4">
      <div className="grid w-full max-w-4xl gap-6 md:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-6 flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-600 font-bold text-white">N</span>
            <div>
              <h1 className="text-lg font-semibold">Newtonite Ops</h1>
              <p className="text-sm text-slate-500">Coordinate operational work reliably.</p>
            </div>
          </div>
          <form
            className="space-y-4"
            onSubmit={(ev) => {
              ev.preventDefault();
              signIn(email, password);
            }}
          >
            <label className={labelCls}>
              Email
              <input className={`${inputCls} mt-1`} type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label className={labelCls}>
              Password
              <input className={`${inputCls} mt-1`} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
            <Button type="submit" variant="primary" className="w-full" busy={busy}>
              Sign in
            </Button>
          </form>
        </div>

        {demo.data && (
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="font-semibold">Sign in as…</h2>
            <p className="mb-3 text-sm text-slate-500">
              Demo accounts. Password for all: <code className="rounded bg-slate-100 px-1">{DEMO_PASSWORD}</code>
            </p>
            <ul className="max-h-[420px] divide-y divide-slate-100 overflow-y-auto">
              {demo.data.map((u) => (
                <li key={u.email}>
                  <button
                    className="flex w-full items-center justify-between gap-3 px-2 py-2 text-left hover:bg-slate-50 disabled:opacity-50"
                    disabled={busy}
                    onClick={() => signIn(u.email, DEMO_PASSWORD)}
                  >
                    <span>
                      <span className="block text-sm font-medium">{u.fullName}</span>
                      <span className="block text-xs text-slate-500">{u.designation}</span>
                    </span>
                    <span className="text-right text-xs text-slate-500">{u.roles}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
