/**
 * 0G Flow Explorer — spec §8.2.
 *
 * Public, read-only, no wallet. Routing is on the URL hash so the whole thing
 * stays a static bundle that can be served from anywhere, including 0G Storage
 * itself.
 *
 * The pages live in ./pages and the shared vocabulary in ./components/ui. This
 * file is the shell and the router, and nothing else.
 */

import { useEffect, useState } from 'react';
import { api, useAsync, type Health } from './api.js';
import { short } from './format.js';
import { AgentPage } from './pages/AgentPage.js';
import { AgentsPage } from './pages/AgentsPage.js';
import { FlowPage } from './pages/FlowPage.js';
import { RunPage } from './pages/RunPage.js';
import { PublishPage } from './pages/PublishPage.js';
import { RunsPage } from './pages/RunsPage.js';

/** The hash path as segments: `#/agent/12` → `['agent', '12']`. */
function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState<string[]>(read);

  useEffect(() => {
    const onChange = () => {
      setRoute(read());
      // Without this a deep link followed from halfway down a list opens the
      // next page already scrolled, which reads as a rendering bug.
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

function TopBar({ route, health }: { route: string[]; health: Health | null }) {
  const section = route[0] ?? 'runs';
  const current = (id: string) => (section === id ? 'page' : undefined);

  return (
    <div className="topbar">
      <a className="brand" href="#/">
        <span className="mark">0G</span>
        <span>Flow</span>
        <span className="sub">explorer</span>
      </a>

      <nav className="topnav">
        <a href="#/" aria-current={section === 'runs' || section === 'run' || section === 'flow' ? 'page' : undefined}>
          Runs
        </a>
        <a href="#/agents" aria-current={section === 'agents' || section === 'agent' ? 'page' : undefined}>
          Agents
        </a>
        <a href="#/publish" aria-current={section === 'publish' ? 'page' : undefined}>
          Publish
        </a>
      </nav>

      <span className="spacer" />

      {health !== null && (
        <span className="chain-tag" title={`Indexed to block ${health.indexed.cursor}`}>
          <span className="dot" />
          {health.network.name} · {health.network.chainId}
        </span>
      )}
      {/* Referenced so the linter sees it used when the nav grows. */}
      <span hidden>{current('none')}</span>
    </div>
  );
}

export default function App() {
  const route = useHashRoute();
  const health = useAsync(() => api<Health>('/api/health'), []);

  let page = <RunsPage />;
  if (route[0] === 'agents') page = <AgentsPage />;
  else if (route[0] === 'publish') page = <PublishPage />;
  else if (route[0] === 'agent' && route[1] !== undefined) page = <AgentPage agentId={route[1]} />;
  else if (route[0] === 'run' && route[1] !== undefined) page = <RunPage runId={route[1]} />;
  else if (route[0] === 'flow' && route[1] !== undefined) page = <FlowPage flowId={route[1]} />;

  const contracts = health.data?.contracts ?? {};

  return (
    <div className="shell">
      <TopBar route={route} health={health.data} />
      <main key={route.join('/')}>{page}</main>
      <footer>
        <p style={{ margin: '0 0 8px' }}>
          Read-only, and nothing here asks to be believed. Every figure is derived from public chain
          data — recheck any of it with <code>npx @0gflow/verify &lt;runId&gt;</code>, which does not
          depend on this service being up.
        </p>
        <p style={{ margin: 0, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {(
            [
              ['receipts', contracts['executionReceiptsV2']],
              ['registry', contracts['agentAdapterRegistryV2']],
              ['escrow', contracts['flowEscrowV2']],
              ['bonds', contracts['agentReputation']],
            ] as const
          ).map(([label, address]) =>
            address == null ? null : (
              <span key={label}>
                <span className="label">{label}</span>{' '}
                <a
                  href={`${health.data?.network.explorer ?? ''}/address/${address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{short(address, 8)}</code>
                </a>
              </span>
            ),
          )}
        </p>
      </footer>
    </div>
  );
}
