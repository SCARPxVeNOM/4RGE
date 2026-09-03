# Demo script — 0G Bridge Buildathon

Under three minutes. Written to be **read aloud over the screen recording**,
at a normal speaking pace with the pauses left in.

Everything named here is live on 0G Aristotle mainnet. Nothing in the recording
is mocked — the conformance check at 1:45 makes ten real calls to a real agent
and writes to 0G Storage while you watch, which is why it takes a moment.

---

## 0:00 — 0:20 · The problem

> When you hire an AI agent today, you get an answer and a bill.
>
> You cannot check that the agent you paid is the one that did the work. You
> cannot check that the output wasn't swapped afterwards. Every agent
> marketplace answers this the same way — with a dashboard that says *trust us*.
>
> That's the trust model of a centralised API, wearing a blockchain hat.

**On screen:** the landing page.

---

## 0:20 — 0:40 · What we built

> 0G Flow is a marketplace where every job leaves a receipt anyone can check.
>
> Agents list themselves — nobody approves them. Anyone can hire them. Each
> step is anchored on 0G Chain, signed by the agent that did it, and paid only
> against that signature.

**On screen:** scroll through *how it works* — hire, sign, anchor, check.

---

## 0:40 — 1:05 · The directory

> These five agents are listed on 0G mainnet right now. Each one registered
> itself: minted an identity, wrote its schema to 0G Storage, and published its
> price and its signing key on chain.
>
> This page reads all of that from the blockchain. It stores nothing of its own.
>
> The one figure you *can't* verify is the health probe — that's our
> observation, from one machine, at one moment. So it's labelled differently
> and always shows its age. Everything else on this page you can recompute
> yourself.

**On screen:** the agents directory.

---

## 1:05 — 1:45 · A job, and its evidence

> Here's a job that ran on mainnet. Four steps, four different agents.
>
> Each row shows the input hash, the output hash, and the receipt — and those
> receipt codes are computed *in your browser* from the values next to them, so
> you can match them against the blockchain without trusting this page.
>
> Your browser also recombines all four receipts and compares the result to
> what the run sealed on chain. That check passed.
>
> And the page says plainly what it *couldn't* check. The full trace lives on
> 0G Storage, which a browser can't reach — so it tells you, and gives you the
> command that can.

**On screen:** the run page — steps table, then the chain-root panel, then
*what this page could not check*.

---

## 1:45 — 2:15 · Anyone can list an agent

> Publishing needs no permission from us.
>
> Paste your agent's URL and we call it — ten checks against the adapter
> contract, live, right now.
>
> If it fails, you find out here. Publishing is refused, because an agent that
> mishandles the contract produces receipts nobody can verify, and the person
> harmed is whoever hired it.
>
> It passes. Its schema goes to 0G Storage, and two transactions from *your own
> wallet* mint the identity and write the listing. This page never sees your
> key.

**On screen:** the publish page — type the URL, click check, the ten checks
appear one after another, then CONFORMANT and the listing form.

---

## 2:15 — 2:45 · The part that matters

> Now the important bit.
>
> This runs on your machine. It reads 0G and nothing else — not our servers,
> not our database, not our website. It works if we disappear entirely.

**On screen:** switch to a terminal and run it live:

```sh
ZG_NETWORK=aristotle npx @0gflow/verify \
  0xd57a33da3eb401e06f18feaf23d6eccf07f56b6b01ed3e2823f44505a535edea \
  --spec artifacts/runs/0xd57a33da…json
```

> Four steps. Four agents. Every signature recovers to the key that agent
> registered on chain.
>
> That's the difference between a receipt that *names* an agent and a receipt
> that *proves* one.

---

## 2:45 — 3:00 · Close

> Six contracts on 0G mainnet. 0G Chain for receipts, escrow and identity. 0G
> Storage for traces and schemas. 0G Compute for TEE-attested inference —
> anchored on 0G's own signer registry, not a vendor's certificate.
>
> And when it can't prove something, it says so.
>
> That last part is the whole project.

**On screen:** back to the landing page, or the README.

---

## Notes for recording

**The strongest single moment** is the verifier printing `VERIFIED — 4 steps ·
4 agents` in a terminal. Give it room. If you cut anything, cut earlier.

**Have this ready before you start**, or the 25-second npm fetch will sit in
your recording:

```sh
cd 4RGE && npx @0gflow/verify --help    # warms the npx cache
```

**Don't apologise for the INCOMPLETE verdict** if you show it. It is the
feature. Any system can print a green tick; refusing to is the harder thing and
the reason to trust the green one.

**Say "unaudited" once.** Judges notice honesty about limitations, and it costs
you nothing to be the team that mentioned it.
