/**
 * Runs — every workflow this indexer has seen anchored.
 *
 * The word "verified" is used carefully. This page knows whether a run sealed
 * successfully, which is not the same as whether it verifies: that needs the
 * traces re-fetched from 0G Storage and the linkage re-derived, which a
 * browser cannot do. So the pills say "succeeded" and the page points at the
 * command that can say more.
 */

import { useMemo, useState } from 'react';
import { api, useAsync, type Health, type RunSummary } from '../api.js';
import { count, short } from '../format.js';
import {
  Chip,
  Command,
  Empty,
  ErrorNote,
  Loading,
  Pills,
  Section,
  Stat,
  StatRow,
  type FilterOption,
  type Tone,
} from '../components/ui.js';

type Filter = 'all' | 'succeeded' | 'unsuccessful' | 'unsealed';

const FILTERS: readonly FilterOption<Filter>[] = [
  { id: 'all', label: 'All' },
  { id: 'succeeded', label: 'Succeeded' },
  { id: 'unsuccessful', label: 'Not a success' },
  { id: 'unsealed', label: 'Unsealed' },
];

/**
 * A run's outcome as a chip.
 *
 * An unsealed run is deliberately not "failed". It may still be executing, and
 * §1.3's whole point is that an absent conclusion and a negative one are
 * different claims.
 */
function outcome(run: RunSummary): { text: string; tone: Tone } {
  if (!run.sealed) return { text: 'unsealed', tone: 'muted' };
  if (run.succeeded) return { text: 'ok', tone: 'ok' };
  return { text: run.outcomeName ?? 'not a success', tone: run.outcomeName === 'failed' ? 'bad' : 'warn' };
}

function RunCard({ run }: { run: RunSummary }) {
  const state = outcome(run);
  return (
    <a className="card run-card" href={`#/run/${run.runId}`}>
      <div className="top">
        <span>block {run.lastBlock}</span>
        <Chip tone={state.tone}>{state.text}</Chip>
      </div>

      <div className="rid mono">{short(run.runId, 14)}</div>

      <div className="metaline" style={{ marginTop: 6 }}>
        <span>flow {short(run.flowId, 6)}</span>
        <span className="sep">/</span>
        <span>
          {run.stepCount} step{run.stepCount === 1 ? '' : 's'}
        </span>
      </div>

      {/* One mark per step: the shape of the run before you open it. */}
      <div className="steps-bar" aria-hidden="true">
        {Array.from({ length: Math.max(run.stepCount, 1) }, (_, i) => (
          <i key={i} className={run.succeeded ? 'ok' : run.sealed ? 'warn' : ''} />
        ))}
      </div>

      <div className="foot">
        <span className="label">chain root</span>
        <code>{run.chainRoot === null ? '—' : short(run.chainRoot, 8)}</code>
      </div>
    </a>
  );
}

export function RunsPage() {
  const [filter, setFilter] = useState<Filter>('all');
  const runs = useAsync(() => api<{ runs: RunSummary[] }>('/api/runs?limit=60'), []);
  const health = useAsync(() => api<Health>('/api/health'), []);

  const all = useMemo(() => runs.data?.runs ?? [], [runs.data]);

  const counts = useMemo(
    () => ({
      all: all.length,
      succeeded: all.filter((r) => r.succeeded).length,
      unsuccessful: all.filter((r) => r.sealed && !r.succeeded).length,
      unsealed: all.filter((r) => !r.sealed).length,
    }),
    [all],
  );

  const shown = useMemo(() => {
    switch (filter) {
      case 'succeeded':
        return all.filter((r) => r.succeeded);
      case 'unsuccessful':
        return all.filter((r) => r.sealed && !r.succeeded);
      case 'unsealed':
        return all.filter((r) => !r.sealed);
      default:
        return all;
    }
  }, [all, filter]);

  const indexed = health.data?.indexed;

  return (
    <>
      <header className="hero enter">
        <h1>
          Work that leaves a receipt <span className="quiet">anyone can check.</span>
        </h1>
        <p className="lede">
          Every run below is anchored on 0G: a receipt per step, folded into one chain root and
          sealed. Nothing here is taken on this page's word — the receipt hashes and the chain root
          are recomputed in your browser, and the rest is one command away.
        </p>

        <StatRow>
          <Stat label="Runs indexed" value={count(indexed?.runs ?? 0)} />
          <Stat label="Steps anchored" value={count(indexed?.steps ?? 0)} />
          <Stat label="Agents seen" value={count(indexed?.agents ?? 0)} />
          <Stat
            label="Followed to block"
            value={count(indexed?.cursor ?? 0)}
            note={health.data === null ? undefined : health.data.network.name}
          />
        </StatRow>
      </header>

      <div className="toolbar enter" style={{ animationDelay: '60ms' }}>
        <Pills
          options={FILTERS.map((f) => ({ ...f, count: counts[f.id] }))}
          value={filter}
          onChange={setFilter}
        />
      </div>

      {runs.loading && <Loading rows={6} />}
      {runs.error !== null && <ErrorNote what="the run list" error={runs.error} />}

      {!runs.loading && runs.error === null && (
        <>
          {shown.length === 0 ? (
            <Empty>
              {all.length === 0 ? 'No runs anchored yet.' : 'No runs match that filter.'}
            </Empty>
          ) : (
            <div className="grid four enter" style={{ animationDelay: '110ms' }}>
              {shown.map((run) => (
                <RunCard key={run.runId} run={run} />
              ))}
            </div>
          )}

          <Section title="Check any of it yourself">
            <div className="panel">
              <p className="muted">
                The verifier is a single dependency-free file. It reads the receipts from chain, the
                traces from 0G Storage, re-derives every hash and the linkage between steps, and
                tells you plainly what it could <em>not</em> check.
              </p>
              <Command>{`npx @0gflow/verify <runId> --contract 0x5368974B886D04aC90ffB6f385e494FdF13E055b --adapters 0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66`}</Command>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
