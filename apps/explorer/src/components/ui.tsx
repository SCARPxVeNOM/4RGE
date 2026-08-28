/**
 * The shared vocabulary of the interface.
 *
 * Small, unopinionated pieces. Anything that decides what a value *means* —
 * whether a step counts as verified, what a health probe is worth — lives with
 * the page that shows it, so the judgement sits next to the words explaining
 * it rather than being buried in a component.
 */

import { useState, type ReactNode } from 'react';
import { agentColors, short } from '../format.js';

export type Tone = 'ok' | 'bad' | 'warn' | 'info' | 'muted';

export function Chip({
  tone = 'muted',
  children,
  plain = false,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  /** Drops the leading dot, for chips that are labels rather than states. */
  plain?: boolean;
  title?: string;
}) {
  return (
    <span className={`chip ${tone}${plain ? ' plain' : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Stat({
  label,
  value,
  note,
  accent = false,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="stat">
      <span className="label">{label}</span>
      <div className={`value${accent ? ' accent' : ''}`}>{value}</div>
      {note !== undefined && <div className="note">{note}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="statrow">{children}</div>;
}

export interface FilterOption<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly count?: number;
}

export function Pills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly FilterOption<T>[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          className="pill"
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.label}
          {option.count !== undefined && <span className="n">{option.count}</span>}
        </button>
      ))}
    </>
  );
}

/**
 * An agent's mark, generated from its token id.
 *
 * Deliberately not an uploaded image: fetching a URL named in a stranger's
 * listing would let any publisher point every visitor's browser at a server of
 * their choosing.
 */
export function Avatar({ agentId, name }: { agentId: string; name?: string | undefined }) {
  const { from, to } = agentColors(agentId);
  const initials = (name ?? `#${agentId}`)
    .replace(/[^A-Za-z0-9 ]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join('');

  return (
    <div className="avatar" style={{ background: `linear-gradient(140deg, ${from}, ${to})` }}>
      {initials.length > 0 ? initials : agentId.slice(0, 2)}
    </div>
  );
}

export function Copyable({ text, keep = 10 }: { text: string; keep?: number }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="copyable">
      <code title={text}>{short(text, keep)}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        }}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return (
    <div className="grid" aria-busy="true" aria-label="loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i} />
      ))}
    </div>
  );
}

export function ErrorNote({ what, error }: { what: string; error: string }) {
  return (
    <div className="panel bad">
      <p>
        <strong className="bad">Could not load {what}.</strong>
      </p>
      <p className="muted">
        <code>{error}</code>
      </p>
      <p className="dim">
        The explorer is a convenience. Everything it shows can be read straight from chain with{' '}
        <code>npx @0gflow/verify</code>, which does not depend on this service being up.
      </p>
    </div>
  );
}

/** A shell command, with the flags picked out so it can be read at a glance. */
export function Command({ children }: { children: string }) {
  return (
    <pre className="cmd">
      {children.split(/(\s--[a-z-]+)/).map((part, i) =>
        part.trim().startsWith('--') ? (
          <span className="flag" key={i}>
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </pre>
  );
}
