/**
 * Check a run you were given the ID of.
 *
 * This is the page for someone who has been handed a run ID and wants to know
 * whether it is real. It does the one check a browser honestly can — refolding
 * the receipts and comparing against what the chain sealed — and then hands
 * over the command that checks the rest.
 *
 * The verification content used to be a block at the bottom of the run list,
 * where nobody looking for it would find it.
 */

import { useState } from 'react';
import { api, type RunDetail } from '../api.js';
import { short } from '../format.js';
import { checkChainRoot } from '../verify.js';
import { Command, Section } from '../components/ui.js';

const RUN_ID = /^0x[0-9a-fA-F]{64}$/;

type Result =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; runId: string; detail: RunDetail };

export function VerifyPage() {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result>({ kind: 'idle' });

  async function check(event: React.FormEvent) {
    event.preventDefault();
    const runId = input.trim();
    if (!RUN_ID.test(runId)) {
      setResult({
        kind: 'error',
        message: 'A run ID is 66 characters: 0x followed by 64 hex digits.',
      });
      return;
    }
    setResult({ kind: 'checking' });
    try {
      const detail = await api<RunDetail>(`/api/runs/${runId}`);
      setResult({ kind: 'done', runId, detail });
    } catch (failure) {
      setResult({
        kind: 'error',
        message:
          (failure as { status?: number }).status === 404
            ? 'No run with that ID has been recorded on this network.'
            : (failure as Error).message,
      });
    }
  }

  return (
    <>
      <header className="hero enter">
        <h1>
          Check a job <span className="quiet">for yourself.</span>
        </h1>
        <p className="lede">
          Paste a run ID and this page will re-do the maths in your browser: it fetches the receipts,
          recombines them, and compares the result against what was recorded on the blockchain. If
          they disagree, someone is wrong — possibly us.
        </p>
      </header>

      <form onSubmit={check} className="panel enter" style={{ animationDelay: '60ms' }}>
        <label className="field">
          <span className="label">Run ID</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="0x…"
            spellCheck={false}
          />
        </label>
        <button type="submit" className="pill primary" disabled={result.kind === 'checking'}>
          {result.kind === 'checking' ? 'Checking…' : 'Check this run'}
        </button>
      </form>

      {result.kind === 'error' && (
        <div className="panel bad" style={{ marginTop: 16 }}>
          <p>
            <strong className="bad">{result.message}</strong>
          </p>
        </div>
      )}

      {result.kind === 'done' && <Verdict runId={result.runId} detail={result.detail} />}

      <Section title="Check it without this website">
        <div className="panel">
          <p className="muted">
            This page can only check part of it — the rest of the evidence lives on 0G Storage, which
            a browser cannot reach. The command below checks all of it, on your machine, and tells
            you plainly what it could not confirm rather than rounding up to a tick.
          </p>
          <Command>{`npx @0gflow/verify <runId>`}</Command>
          <p className="dim" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            It reads from the blockchain directly, so it works whether or not this site is up.
          </p>
        </div>
      </Section>
    </>
  );
}

function Verdict({ runId, detail }: { runId: string; detail: RunDetail }) {
  const check = checkChainRoot(detail.steps, detail.run.chainRoot);
  const { run } = detail;

  const panel =
    check.kind === 'match'
      ? {
          tone: 'ok',
          title: 'The receipts match what was recorded on chain.',
          body:
            run.stepCount === 1
              ? `Its single step gives ${short(check.computed, 12)}, which is exactly what this run recorded on the blockchain. Your browser worked that out — it did not ask this site whether it was true.`
              : `All ${run.stepCount} steps combine to ${short(check.computed, 12)}, which is exactly what this run recorded on the blockchain. Your browser worked that out — it did not ask this site whether it was true.`,
        }
      : check.kind === 'mismatch'
        ? {
            tone: 'bad',
            title: 'These receipts do not match what was recorded.',
            body: `The steps combine to ${short(check.computed, 12)} but the blockchain says ${short(check.sealed, 12)}. Do not rely on this run, and do not rely on this page — run the command below.`,
          }
        : check.kind === 'unsealed'
          ? {
              tone: 'warn',
              title: 'This job has not finished.',
              body: 'Steps have been recorded but the run has not been sealed, so there is no final result to compare against yet. It may still be running.',
            }
          : {
              tone: 'warn',
              title: 'Not enough was recorded to check this.',
              body: check.reason,
            };

  return (
    <div style={{ marginTop: 18 }}>
      <div className={`panel ${panel.tone}`}>
        <p>
          <strong className={panel.tone}>{panel.title}</strong>
        </p>
        <p className="muted">{panel.body}</p>
        <p style={{ marginTop: 14, marginBottom: 0 }}>
          <a className="pill" href={`#/run/${runId}`}>
            See every step
          </a>
        </p>
      </div>
    </div>
  );
}
