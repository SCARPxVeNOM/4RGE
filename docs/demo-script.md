# Demo script — 0G Bridge Buildathon

About five minutes, covering every surface of the product. Written to be **read
aloud over the screen recording** at a normal speaking pace, with the pauses
left in. There is a three-minute cut at the bottom if you need one.

Everything named here is live on 0G Aristotle mainnet. Nothing in the recording
is mocked:

- the two conformance scenes make real calls to real agents and write to 0G
  Storage, which is why they take the better part of a minute each;
- the terminal at the end is not a transcript. The recorder spawns the real
  `npx @0gflow/verify` and streams that process's stdout into the frame as it
  arrives. Had the verifier failed, the failure is what you would see.

---

## 0:00 — 0:25 · The problem

> When you hire an AI agent today, you get an answer and a bill.
>
> You cannot check that the agent you paid is the one that did the work. You
> cannot check that the output wasn't swapped afterwards. Every agent
> marketplace answers this the same way — with a dashboard that says *trust us*.
>
> That's the trust model of a centralised API, wearing a blockchain hat.

**On screen:** the landing page, scrolling slowly through *how it works*.

---

## 0:25 — 0:50 · What we built

> 0G Flow is a marketplace where every job leaves a receipt anyone can check.
>
> Agents list themselves — nobody approves them. Anyone can hire them. Each
> step is anchored on 0G Chain, signed by the agent that did it, and paid only
> against that signature.
>
> Six contracts, live on 0G mainnet.

**On screen:** still the landing page — the contract addresses in the footer.

---

## 0:50 — 1:15 · The directory

> These agents are listed on 0G mainnet right now. Each one registered itself:
> minted an identity, wrote its schema to 0G Storage, and published its price
> and its signing key on chain.
>
> This page reads all of that from the blockchain. It stores nothing of its own.

**On screen:** the agents directory.

---

## 1:15 — 1:40 · One agent, in full

> Here's a single agent. Its owner, the key it signs with, the hash of the
> schema it declared, and its record — with the denominator shown, because
> "100% success" over one job is not a track record.
>
> The one figure you *can't* verify is the health probe. That's our observation,
> from one machine, at one moment. So it's labelled differently and always shows
> its age. Everything else you can recompute yourself.

**On screen:** the agent page for Publisher.

---

## 1:40 — 2:00 · Jobs

> Every job that has run, and how it went.

**On screen:** the jobs list. Keep this one brief — it's a bridge.

---

## 2:00 — 2:45 · A job, and its evidence

> Here's one on mainnet. Four steps, four different agents.
>
> Each row shows the input hash, the output hash, and the receipt — and those
> receipt codes are computed *in your browser* from the values next to them, so
> you can match them against the blockchain without trusting this page.
>
> Your browser also recombines all four receipts and compares the result to what
> the run sealed on chain. That check passed.
>
> And the page says plainly what it *couldn't* check. The full trace lives on 0G
> Storage, which a browser can't reach — so it tells you, and gives you the
> command that can.

**On screen:** the run page — steps table, then the chain-root panel, then
*what this page could not check*.

---

## 2:45 — 3:10 · Check one yourself

> Paste any run ID here and the page redoes the maths in front of you. It
> fetches the receipts, recombines them, and compares against the chain.
>
> If they disagreed, it would say so — including if the thing that was wrong
> was us.

**On screen:** the verify page, typing the run ID, then the verdict.

---

## 3:10 — 3:50 · Listing an agent: the refusal

> Publishing needs no permission from us. Paste your agent's URL and we call it —
> ten checks against the adapter contract, live, right now.
>
> This one fails. So publishing is refused.
>
> That's deliberate. An agent that mishandles the contract produces receipts
> nobody can verify, and the person harmed isn't the agent — it's whoever hires
> it. A gate you only ever see open isn't evidence of a gate, which is why this
> is the first thing we're showing you.

**On screen:** the publish page with `/agents/always-fails`, the checks
appearing one by one, then NOT CONFORMANT.

---

## 3:50 — 4:25 · Listing an agent: the pass

> Now a good one. Same ten checks, live.
>
> It passes. Its schema goes to 0G Storage, and two transactions from *your own
> wallet* mint the identity and write the listing. This page never sees your key.

**On screen:** the publish page with `/agents/publish` → CONFORMANT → the
listing form.

---

## 4:25 — 5:10 · The part that matters

> Now the important bit.
>
> This runs on your machine. It reads 0G and nothing else — not our servers, not
> our database, not our website. It works if we disappear entirely.

**On screen:** the terminal. First run, no flow spec:

> Four steps. Four agents. Every signature recovers to the key that agent
> registered on chain. The chain root matches the seal.
>
> And it will not tell you it's verified. Without the flow specification it
> can't re-derive how each step's input came from the last, so it says
> INCOMPLETE and names exactly what was missing.
>
> Any system can print a green tick. Refusing to is the harder thing — and the
> reason to trust the green one when it comes.

**On screen:** the second run, with `--spec`, ending in `VERIFIED — 4 steps ·
4 agents`. Give this a moment of silence.

---

## 5:10 — 5:30 · Close

> Six contracts on 0G mainnet. 0G Chain for receipts, escrow and identity. 0G
> Storage for traces and schemas. 0G Compute for TEE-attested inference —
> anchored on 0G's own signer registry, not a vendor's certificate.
>
> It's unaudited, and we say so on every page.
>
> And when it can't prove something, it says so. That last part is the whole
> project.

**On screen:** back to the landing page.

---

## The three-minute cut

Drop scenes 4 (jobs list), 7 (verify page) and 9's first half. Keep: problem →
directory → run evidence → the publish refusal → `VERIFIED` in the terminal.
The refusal and the terminal are the two moments that do the persuading; keep
both even if nothing else survives.

---

## Notes for recording

**The strongest single moment** is the verifier printing `VERIFIED — 4 steps ·
4 agents`. Give it room. If you cut anything, cut earlier.

**Warm the npx cache before you start**, or a 25-second download sits in your
recording:

```sh
ZG_NETWORK=aristotle npx @0gflow/verify --help
```

**Don't apologise for the INCOMPLETE verdict.** It is the feature.

**Say "unaudited" once.** Judges notice honesty about limitations, and it costs
nothing to be the team that mentioned it.

## Reproducing the recording

```sh
node record-full.mjs     # scratchpad/demo — Playwright, ~6 min, writes out-full/
```

It drives production. If a scene ever fails to find its selector the script
throws rather than recording a blank frame, which is the behaviour you want:
a silently wrong demo is worse than no demo.
