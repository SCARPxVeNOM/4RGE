/**
 * One flow, and the runs of it.
 *
 * A flow may have runs without ever having been published — `FlowPublished` is
 * emitted once and an indexer that started later never saw it. The page says
 * so rather than showing an empty name, because "we did not see it" and "it
 * does not exist" are different statements.
 */

import { api, useAsync, type FlowDetail, type RunSummary } from '../api.js';
import { count, short } from '../format.js';
import { Chip, Copyable, Empty, ErrorNote, Loading, Section, Stat, StatRow, type Tone } from '../components/ui.js';

function RunLine({ run }: { run: RunSummary }) {
  const tone: Tone = run.succeeded ? 'ok' : run.sealed ? 'bad' : 'muted';
  return (
    <tr>
      <td>
        <a href={`#/run/${run.runId}`}>
          <code>{short(run.runId, 14)}</code>
        </a>
      </td>
      <td className="num">{run.stepCount}</td>
      <td>
        <Chip tone={tone}>{run.sealed ? (run.outcomeName ?? 'sealed') : 'unsealed'}</Chip>
      </td>
      <td>
        <code>{run.chainRoot === null ? '—' : short(run.chainRoot, 8)}</code>
      </td>
      <td className="num dim">{run.lastBlock}</td>
    </tr>
  );
}

export function FlowPage({ flowId }: { flowId: string }) {
  const { data, error, loading } = useAsync(() => api<FlowDetail>(`/api/flows/${flowId}`), [flowId]);

  if (loading) return <Loading rows={3} />;
  if (error !== null) return <ErrorNote what="this flow" error={error} />;

  const { flow, runs } = data!;
  const succeeded = runs.filter((r) => r.succeeded).length;

  return (
    <>
      <header className="hero enter" style={{ paddingBottom: 8 }}>
        <div className="label" style={{ marginBottom: 10 }}>
          Flow
        </div>
        <h1 style={{ fontSize: 30, margin: '0 0 8px' }}>
          {flow?.name ?? <span className="mono">{short(flowId, 18)}</span>}
        </h1>
        <p className="lede" style={{ fontSize: 13 }}>
          {flow === null ? (
            <>
              No <code>FlowPublished</code> event was indexed for this flow, so its name, owner and
              spec root are unknown here. The runs below reference it regardless — a flow that was
              published before this indexer started looks exactly like this.
            </>
          ) : (
            <>
              The flowId is the hash of the workflow specification, so two runs of the same flow
              are provably runs of the same thing.
            </>
          )}
        </p>

        <StatRow>
          <Stat label="Runs" value={count(runs.length)} />
          <Stat label="Succeeded" value={count(succeeded)} accent={succeeded === runs.length && succeeded > 0} />
          <Stat label="Sealed" value={count(runs.filter((r) => r.sealed).length)} />
        </StatRow>
      </header>

      {flow !== null && (
        <Section title="Published">
          <div className="panel">
            <dl className="kv">
              <dt>Owner</dt>
              <dd>
                <Copyable text={flow.owner} keep={18} />
              </dd>
              <dt title="0G Storage root of the canonical specification">Spec root</dt>
              <dd>
                <Copyable text={flow.specRoot} keep={18} />
              </dd>
              <dt>Flow</dt>
              <dd>
                <Copyable text={flowId} keep={22} />
              </dd>
            </dl>
          </div>
        </Section>
      )}

      <Section title={`Runs (${runs.length})`}>
        {runs.length === 0 ? (
          <Empty>No runs of this flow have been indexed.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Run</th>
                  <th className="num">Steps</th>
                  <th>Outcome</th>
                  <th>Chain root</th>
                  <th className="num">Block</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <RunLine key={run.runId} run={run} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </>
  );
}
