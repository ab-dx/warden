import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from './api.js';
import { Bench } from './bench.js';
import { Lab } from './lab.js';
import { Mandates } from './mandates.js';
import { Activity, Approvals, Evidence, Login, Today } from './screens.js';

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

export function App() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: ['me'], queryFn: api.me, retry: false });
  const pending = useQuery({
    queryKey: ['approvals'],
    queryFn: api.approvals,
    refetchInterval: 2000,
    enabled: me.isSuccess,
  });
  const hash = useHash();
  if (me.isPending) return null;
  if (me.isError) return <Login />;

  const callId = /^#\/calls\/(.+)$/.exec(hash)?.[1];
  const page = callId
    ? 'call'
    : hash === '#/mandates'
      ? 'mandates'
      : hash === '#/bench'
        ? 'bench'
        : hash === '#/lab'
          ? 'lab'
          : 'home';
  const tab = (href: string, label: string, here: boolean, count = 0) => (
    <a
      href={href}
      aria-current={here ? 'page' : undefined}
      className={`flex items-center gap-2 pb-1 ${here ? 'border-b-2 border-ink font-semibold' : 'text-ink-soft hover:text-ink'}`}
    >
      {label}
      {count > 0 && (
        <span className="rounded-full bg-held px-2 text-sm font-semibold text-sheet">
          {count}
          <span className="sr-only"> waiting</span>
        </span>
      )}
    </a>
  );
  const waiting = pending.data?.length ?? 0;

  return (
    <div className="mx-auto max-w-[960px] px-4 pb-24 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pt-8 pb-3">
        <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
          <h1 className="text-2xl font-bold tracking-tight">Warden</h1>
          <nav className="flex gap-4 sm:gap-6">
            {tab('#/', 'Payments', page === 'home' || page === 'call', waiting)}
            {tab('#/mandates', 'Mandates', page === 'mandates')}
            {tab('#/lab', 'Try it', page === 'lab')}
            {tab('#/bench', 'Benchmark', page === 'bench')}
          </nav>
        </div>
        <button
          type="button"
          onClick={async () => {
            await api.logout();
            qc.invalidateQueries({ queryKey: ['me'] });
          }}
          className="text-sm text-ink-soft hover:text-ink"
        >
          Sign out {me.data.user}
        </button>
      </header>
      <main className="mt-8 space-y-12">
        {page === 'call' && callId && <Evidence id={callId} back={() => (location.hash = '#/')} />}
        {page === 'mandates' && <Mandates />}
        {page === 'bench' && <Bench />}
        {page === 'lab' && <Lab />}
        {page === 'home' && (
          <>
            <Today />
            <Approvals />
            <Activity open={(id) => (location.hash = `#/calls/${id}`)} />
          </>
        )}
      </main>
    </div>
  );
}
