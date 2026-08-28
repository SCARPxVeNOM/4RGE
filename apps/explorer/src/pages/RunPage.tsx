/**
 * One run, and the evidence for it.
 *
 * The page performs the checks it honestly can — folding the receipts into a
 * chain root and recomputing each receipt hash, both in the browser using the
 * same frozen `@0gflow/core` the executor and the verifier use — and states
 * plainly what it cannot: the traces live on 0G Storage, so the linkage
 * invariant and the attestation binding are beyond it.
 *
 * A page about provenance that asked to be believed would be the joke telling
 * itself.
 */

import { api, useAsync, type RunDetail } from '../api.js';
import { agoSeconds, count, short } from '../format.js';
import { checkChainRoot, receiptHashOf, type ApiStep, type ChainRootCheck } from '../verify.js';
import {
  Chip,
  Command,
  Copyable,
  ErrorNote,
  Loading,
  Section,
  Stat,
  StatRow,
  type Tone,
} from '../components/ui.js';

const STATUS_TONE: Record<string, Tone> = {
  ok: 'ok',
  failed: 'bad',
  skipped: 'muted',
  unattested: 'warn',
};

/**
 * What the browser managed to establish about the chain root.
 *
 * Four outcomes, each said in full. "Verified" here means one specific thing —
 * the receipts fold to the root the chain sealed — and the panel says which
 * thing rather than showing a tick.
 */
function ChainRootPanel({ check }: { check: ChainRootCheck }) {
  if (check.kind === 'match') {
    return (
      <div className="panel ok">
        <p>
          <strong className="ok">Chain root checked in your browser.</strong>
        </p>
        <p className="muted">
          The indexed receipts fold to <code>{short(check.computed, 14)}</code>, which is the root
          this run sealed on chain. The page did not take the API's word for that — it recomputed
          the fold here.
        </p>
      </div>
    );
  }
  if (check.kind === 'mismatch') {
    return (
      <div className="panel bad">
        <p>
          <strong className="bad">These receipts do not fold to the sealed root.</strong>
        </p>
        <p className="muted">
          Computed <code>{short(check.computed, 14)}</code>, sealed{' '}
          <code>{short(check.sealed, 14)}</code>. Either the index is wrong or the run is. Do not
          rely on this page — check it with the verifier.
        </p>
      </div>
    );
  }
  if (check.kind === 'unsealed') {
    return (
      <div className="panel warn">
        <p>
          <strong className="warn">Not sealed on chain.</strong>
        </p>
        <p className="muted">
          The receipts indexed so far fold to <code>{short(check.computed, 14)}</code>, but no{' '}
          <code>RunSealed</code> event has been seen, so there is nothing to compare it against. The
          run may still be executing.
        </p>
      </div>
    );
  }
  return (
    <div className="panel warn">
      <p>
        <strong className="warn">The chain root could not be computed.</strong>
      </p>
      <p className="muted">{check.reason}</p>
    </div>
  );
}

function StepRow({ step }: { step: ApiStep }) {
  return (
    <tr>
      <td className="num dim">{step.stepIndex}</td>
      <td>
        <a href={`#/agent/${step.agentId}`}>#{step.agentId}</a>
      </td>
      <td>
        <Chip tone={STATUS_TONE[step.statusName] ?? 'muted'}>{step.statusName}</Chip>
      </td>
      <td>
        {step.attested ? (
          <span className="info">recorded</span>
        ) : (
          <span className="dim">none anchored</span>
        )}
      </td>
      <td>
        <code title={step.inputHash}>{short(step.inputHash, 6)}</code>
        <span className="dim"> → </span>
        <code title={step.outputHash}>{short(step.outputHash, 6)}</code>
      </td>
      <td>
        <code title={step.traceRoot}>{short(step.traceRoot, 6)}</code>
      </td>
      <td>
        {/* Computed here from the fields in the row, so it can be compared
            against the StepAnchored log directly. */}
        <code title={receiptHashOf(step)}>{short(receiptHashOf(step), 6)}</code>
      </td>
      <td className="dim num">{agoSeconds(step.startedAt)}</td>
      <td>
        <a href={step.explorerTx} target="_blank" rel="noreferrer" title={step.txHash}>
          tx ↗
        </a>
      </td>
    </tr>
  );
}

export function RunPage({ runId }: { runId: string }) {
  const { data, error, loading } = useAsync(() => api<RunDetail>(`/api/runs/${runId}`), [runId]);

  if (loading) return <Loading rows={3} />;
  if (error !== null) return <ErrorNote what="this run" error={error} />;

  const { run, steps } = data!;
  const check = checkChainRoot(steps, run.chainRoot);
  const ok = steps.filter((s) => s.statusName === 'ok').length;
  const attested = steps.filter((s) => s.attested).length;

  return (
    <>
      <header className="hero enter" style={{ paddingBottom: 8 }}>
        <div className="label" style={{ marginBottom: 10 }}>
          Run
        </div>
        <h1 style={{ fontSize: 26, letterSpacing: '-0.02em', maxWidth: 'none' }}>
          <span className="mono">{short(runId, 20)}</span>
        </h1>
        <div className="metaline" style={{ marginTop: 6 }}>
          <a href={`#/flow/${run.flowId}`}>flow {short(run.flowId, 8)}</a>
          <span className="sep">/</span>
          <Chip tone={run.succeeded ? 'ok' : run.sealed ? 'bad' : 'muted'}>
            {run.sealed ? (run.outcomeName ?? 'sealed') : 'unsealed'}
          </Chip>
        </div>

        <StatRow>
          <Stat label="Steps" value={count(run.stepCount)} />
          <Stat label="Succeeded" value={count(ok)} accent={ok === run.stepCount && ok > 0} />
          <Stat label="With an attestation" value={count(attested)} />
          <Stat label="Sealed at block" value={count(run.lastBlock)} />
        </StatRow>
      </header>

      <div className="enter" style={{ animationDelay: '60ms', marginTop: 26 }}>
        <ChainRootPanel check={check} />
      </div>

      <Section title="Steps">
        <div className="table-wrap enter" style={{ animationDelay: '110ms' }}>
          <table>
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Attestation</th>
                <th>Input → output</th>
                <th>Trace</th>
                <th>Receipt</th>
                <th>Started</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {steps.map((step) => (
                <StepRow key={step.stepIndex} step={step} />
              ))}
            </tbody>
          </table>
        </div>
        <p className="dim" style={{ fontSize: 12, marginTop: 10 }}>
          Receipt hashes are computed in this page from the fields beside them, so each one can be
          compared against its <code>StepAnchored</code> log without trusting the API.
        </p>
      </Section>

      <Section title="What this page did not check">
        <div className="panel">
          <p className="muted">
            The traces live on 0G Storage, so a browser cannot re-derive the linkage between steps,
            re-check an attestation binding, or confirm that an agent's signature matches the key it
            published. Those need the verifier, which reads all of it and reports what it could not
            establish rather than rounding up.
          </p>
          <Command>{`npx @0gflow/verify ${runId} --contract 0x5368974B886D04aC90ffB6f385e494FdF13E055b --adapters 0xB9b587D30740DD1197f6bC0E2FF56ee82E6C8a66`}</Command>
        </div>
      </Section>

      <Section title="Identifiers">
        <div className="panel">
          <dl className="kv">
            <dt>Run</dt>
            <dd>
              <Copyable text={run.runId} keep={22} />
            </dd>
            <dt>Flow</dt>
            <dd>
              <Copyable text={run.flowId} keep={22} />
            </dd>
            <dt>Chain root</dt>
            <dd>
              {run.chainRoot === null ? (
                <span className="dim">not sealed</span>
              ) : (
                <Copyable text={run.chainRoot} keep={22} />
              )}
            </dd>
          </dl>
        </div>
      </Section>
    </>
  );
}
