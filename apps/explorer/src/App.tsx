/**
 * 0G Flow Explorer — spec §8.2.
 *
 * Public, read-only, no wallet connection. Routing is hash-based so the whole
 * thing is a static bundle that can be served from anywhere, including 0G
 * Storage once uploads work again.
 */

import { useEffect, useState } from 'react';
import { checkChainRoot, receiptHashOf, type ApiStep, type ChainRootCheck } from './verify.js';

// ---------------------------------------------------------------------------
// data
// ---------------------------------------------------------------------------

interface RunSummary {
  runId: string;
  flowId: string;
  stepCount: number;
  sealed: boolean;
  chainRoot: string | null;
  outcome: number | null;
  outcomeName: string | null;
  succeeded: boolean;
  lastBlock: string;
}

interface Health {
  network: { name: string; chainId: number; explorer: string };
  contracts: Record<string, string | null>;
  indexed: { runs: number; steps: number; agents: number; cursor: string };
}

const api = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
};

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  useEffect(() => {
    let live = true;
    setState({ data: null, error: null, loading: true });
    fn().then(
      (data) => live && setState({ data, error: null, loading: false }),
      (error: unknown) => live && setState({ data: null, error: (error as Error).message, loading: false }),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

const short = (h: string, n = 8) => (h.length > n + 6 ? `${h.slice(0, n + 2)}…${h.slice(-4)}` : h);

function StatusPill({ name }: { name: string | null }) {
  const tone =
    name === 'ok' ? 'ok' : name === 'failed' ? 'bad' : name === 'unattested' ? 'warn' : 'muted';
  return <span className={`pill ${tone}`}>{name ?? 'unsealed'}</span>;
}

function Copyable({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="copyable">
      <code>{text}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}

/**
 * The verification panel. It reports exactly what the browser checked and
 * exactly what it did not, because a page that shows a single green tick
 * teaches people to trust the page instead of the chain.
 */
function ChainRootPanel({ check, runId }: { check: ChainRootCheck; runId: string }) {
  const body = {
    match: (
      <>
        <strong className="ok">Chain root verified in your browser.</strong>
        <p>
          The {check.kind === 'match' ? '' : ''}receipts served by this API fold to{' '}
          <code>{short((check as { computed: string }).computed, 14)}</code>, which is the root
          sealed on chain. Recomputed here with the same <code>@0gflow/core</code> the executor and
          verifier use — this page did not take the API's word for it.
        </p>
      </>
    ),
    mismatch: (
      <>
        <strong className="bad">Chain root does NOT match.</strong>
        <p>
          These receipts fold to <code>{short((check as { computed: string }).computed, 14)}</code>{' '}
          but the on-chain seal records{' '}
          <code>{short((check as { sealed: string }).sealed ?? '', 14)}</code>. Either the index is
          wrong or the run is. Do not trust this page — run the verifier.
        </p>
      </>
    ),
    unsealed: (
      <>
        <strong className="warn">Not sealed yet.</strong>
        <p>
          The receipts fold to <code>{short((check as { computed: string }).computed, 14)}</code>,
          but no <code>RunSealed</code> event has been indexed, so there is nothing to compare it
          against. An unsealed run is not a pending success — it is simply unproven.
        </p>
      </>
    ),
    incomputable: (
      <>
        <strong className="warn">Cannot fold a chain root.</strong>
        <p>{(check as { reason: string }).reason}</p>
      </>
    ),
  }[check.kind];

  return (
    <section className="panel">
      <h3>Client-side verification</h3>
      {body}
      <p className="muted">
        This checks the chain root only. Re-deriving the linkage invariant (§4.1) needs the
        execution traces, which the browser does not fetch. For the full check, run:
      </p>
      <Copyable text={`npx @0gflow/verify ${runId}`} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------

function RunList() {
  const { data, error, loading } = useAsync(
    () => api<{ runs: RunSummary[] }>('/api/runs?limit=50'),
    [],
  );
  if (loading) return <p className="muted">loading runs…</p>;
  if (error !== null) return <p className="bad">could not load runs: {error}</p>;
  if (data!.runs.length === 0) return <p className="muted">No runs indexed yet.</p>;

  return (
    <table>
      <thead>
        <tr>
          <th>Run</th>
          <th>Steps</th>
          <th>Outcome</th>
          <th>Block</th>
        </tr>
      </thead>
      <tbody>
        {data!.runs.map((run) => (
          <tr key={run.runId}>
            <td>
              <a href={`#/run/${run.runId}`}>
                <code>{short(run.runId, 12)}</code>
              </a>
            </td>
            <td>{run.stepCount}</td>
            <td>
              <StatusPill name={run.sealed ? run.outcomeName : null} />
            </td>
            <td className="muted">{run.lastBlock}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface AgentListing {
  agentId: string;
  owner: string;
  kind: number;
  endpoint: string;
  version: number;
  active: boolean;
  payTo: string;
  signer: string;
  pricePerCall: string;
  metadata: { name?: string; description?: string } | null;
  stepCount: number;
  okCount: number;
  runCount: number;
  successRate: number | null;
}

const KIND_NAMES = ['http', 'contract', '0g-compute', 'flow'];

/** Wei as OG, for display only. Never used in a comparison. */
function og(wei: string): string {
  const value = Number(wei) / 1e18;
  if (value === 0) return 'free';
  return `${value.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} OG`;
}

function AgentList() {
  const { data, error, loading } = useAsync(
    () => api<{ agents: AgentListing[]; registry: string | null }>('/api/agents?limit=50'),
    [],
  );
  if (loading) return <p className="muted">loading agents…</p>;
  if (error !== null) return <p className="bad">could not load agents: {error}</p>;

  const { agents, registry } = data!;

  return (
    <>
      <h2>Agents</h2>
      <p className="muted">
        Published to{' '}
        {registry === null ? 'the adapter registry' : <code>{short(registry, 12)}</code>} by their
        owners. Anyone can list one with <code>npx @0gflow/publish</code>.
      </p>

      {agents.length === 0 ? (
        <p className="muted">No agents published yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Endpoint</th>
              <th>Kind</th>
              <th>Price</th>
              <th>Record</th>
            </tr>
          </thead>
          <tbody>
            {agents.map((agent) => (
              <tr key={agent.agentId}>
                <td>
                  <a href={`#/agent/${agent.agentId}`}>
                    {agent.metadata?.name ?? `#${agent.agentId}`}
                  </a>
                  <div className="muted">#{agent.agentId} · v{agent.version}</div>
                </td>
                <td>
                  <code>{short(agent.endpoint, 34)}</code>
                </td>
                <td className="muted">{KIND_NAMES[agent.kind] ?? agent.kind}</td>
                <td className="muted">{og(agent.pricePerCall)}</td>
                <td className="muted">
                  {/* A rate with no denominator is not a track record. An agent
                      that has never run says so, rather than showing 0%. */}
                  {agent.stepCount === 0
                    ? 'no runs yet'
                    : `${agent.okCount}/${agent.stepCount} steps ok`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

interface RunDetail {
  run: RunSummary & { computedChainRoot: string | null; chainRootMatches: boolean | null };
  steps: ApiStep[];
  verification: { command: string; note: string };
}

function RunPage({ runId }: { runId: string }) {
  const { data, error, loading } = useAsync(() => api<RunDetail>(`/api/runs/${runId}`), [runId]);
  if (loading) return <p className="muted">loading run…</p>;
  if (error !== null) return <p className="bad">could not load run: {error}</p>;

  const { run, steps } = data!;
  // Computed here, in the browser, from the receipt fields — not read from the
  // API's own verdict.
  const check = checkChainRoot(steps, run.chainRoot);

  return (
    <>
      <h2>
        Run <code>{short(runId, 16)}</code>
      </h2>
      <p className="muted">
        flow <a href={`#/flow/${run.flowId}`}><code>{short(run.flowId, 12)}</code></a> · {run.stepCount}{' '}
        step{run.stepCount === 1 ? '' : 's'} · <StatusPill name={run.sealed ? run.outcomeName : null} />
      </p>

      <ChainRootPanel check={check} runId={runId} />

      <h3>Steps</h3>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Agent</th>
            <th>Status</th>
            <th>Attestation</th>
            <th>Trace</th>
            <th>Receipt hash</th>
            <th>Tx</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((step) => (
            <tr key={step.stepIndex}>
              <td>{step.stepIndex}</td>
              <td>
                <a href={`#/agent/${step.agentId}`}>#{step.agentId}</a>
              </td>
              <td>
                <StatusPill name={step.statusName} />
              </td>
              <td>{step.attested ? <span className="ok">recorded</span> : <span className="muted">none</span>}</td>
              <td>
                <code title={step.traceRoot}>{short(step.traceRoot)}</code>
              </td>
              <td>
                <code title={receiptHashOf(step)}>{short(receiptHashOf(step))}</code>
              </td>
              <td>
                <a href={step.explorerTx} target="_blank" rel="noreferrer">
                  {short(step.txHash)}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted">
        Receipt hashes are computed in your browser from the fields above, so they can be compared
        against the <code>StepAnchored</code> logs directly.
      </p>
    </>
  );
}

function AgentPage({ agentId }: { agentId: string }) {
  const { data, error, loading } = useAsync(
    () =>
      api<{
        agent: {
          agentId: string;
          stepCount: number;
          okCount: number;
          attestedCount: number;
          runCount: number;
          successRate: number | null;
          attestationRate: number | null;
          identityRegistry: string | null;
        };
        runs: RunSummary[];
      }>(`/api/agents/${agentId}`),
    [agentId],
  );
  if (loading) return <p className="muted">loading agent…</p>;
  if (error !== null) return <p className="bad">could not load agent: {error}</p>;

  const { agent, runs } = data!;
  const pct = (r: number | null) => (r === null ? '—' : `${Math.round(r * 100)}%`);

  return (
    <>
      <h2>Agent #{agent.agentId}</h2>
      <p className="muted">
        ERC-721 token id in the identity registry{' '}
        <code>{short(agent.identityRegistry ?? 'unset', 10)}</code>
      </p>
      <section className="panel">
        {/* Rates always shown with their denominator: "100% attested" over one
            step is not the same claim as over a hundred. */}
        <p>
          <strong>{pct(agent.successRate)}</strong> ok ({agent.okCount}/{agent.stepCount} steps) ·{' '}
          <strong>{pct(agent.attestationRate)}</strong> attested ({agent.attestedCount}/
          {agent.stepCount}) · {agent.runCount} run{agent.runCount === 1 ? '' : 's'}
        </p>
      </section>
      <h3>Runs</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.runId}>
            <a href={`#/run/${r.runId}`}><code>{short(r.runId, 12)}</code></a>{' '}
            <StatusPill name={r.sealed ? r.outcomeName : null} />
          </li>
        ))}
      </ul>
    </>
  );
}

function FlowPage({ flowId }: { flowId: string }) {
  const { data, error, loading } = useAsync(
    () =>
      api<{
        flow: { name: string; owner: string; specRoot: string } | null;
        runs: RunSummary[];
      }>(`/api/flows/${flowId}`),
    [flowId],
  );
  if (loading) return <p className="muted">loading flow…</p>;
  if (error !== null) return <p className="bad">could not load flow: {error}</p>;

  const { flow, runs } = data!;
  return (
    <>
      <h2>Flow {flow === null ? <code>{short(flowId, 16)}</code> : flow.name}</h2>
      <p className="muted">
        <code>{flowId}</code>
      </p>
      {flow === null ? (
        <p className="muted">
          No <code>FlowPublished</code> event indexed for this flow, so its spec root and owner are
          unknown. The runs below reference it regardless.
        </p>
      ) : (
        <section className="panel">
          <p>
            owner <code>{short(flow.owner, 10)}</code> · spec root{' '}
            <code>{short(flow.specRoot, 12)}</code>
          </p>
        </section>
      )}
      <h3>Runs</h3>
      <ul>
        {runs.map((r) => (
          <li key={r.runId}>
            <a href={`#/run/${r.runId}`}><code>{short(r.runId, 12)}</code></a>{' '}
            <StatusPill name={r.sealed ? r.outcomeName : null} /> · {r.stepCount} steps
          </li>
        ))}
      </ul>
    </>
  );
}

// ---------------------------------------------------------------------------
// shell
// ---------------------------------------------------------------------------

function useHashRoute(): string[] {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

export default function App() {
  const route = useHashRoute();
  const health = useAsync(() => api<Health>('/api/health'), []);

  let page = <RunList />;
  if (route[0] === 'agents') page = <AgentList />;
  if (route[0] === 'run' && route[1] !== undefined) page = <RunPage runId={route[1]} />;
  else if (route[0] === 'agent' && route[1] !== undefined) page = <AgentPage agentId={route[1]} />;
  else if (route[0] === 'flow' && route[1] !== undefined) page = <FlowPage flowId={route[1]} />;

  return (
    <div className="shell">
      <header>
        <a href="#/" className="brand">
          0G Flow <span className="muted">Explorer</span>
        </a>
        <nav>
          <a href="#/">Runs</a>
          <a href="#/agents">Agents</a>
        </nav>
        <span className="muted">
          {health.data === null
            ? ''
            : `${health.data.network.name} (${health.data.network.chainId}) · ${health.data.indexed.runs} runs · ${health.data.indexed.steps} steps · block ${health.data.indexed.cursor}`}
        </span>
      </header>
      <main>{page}</main>
      <footer className="muted">
        Read-only. No wallet required. Everything here is derived from public chain data — verify it
        yourself with <code>npx @0gflow/verify &lt;runId&gt;</code>.
      </footer>
    </div>
  );
}
