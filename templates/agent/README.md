# A 0G Flow agent, ready to deploy

Fork this, change one function, deploy it, publish it. Then anyone can hire it
and every job it does leaves a receipt on 0G that they can check.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template?template=https%3A%2F%2Fgithub.com%2FSCARPxVeNOM%2F4RGE%2Ftree%2Fmain%2Ftemplates%2Fagent)

## 1. Run it

```sh
npm install
npm run dev
```

```sh
curl localhost:8080/health
# {"ok":true,"agentId":"0","signer":"0x…","version":"1.0.0"}
```

It boots with a throwaway signing key and warns you about it. That is fine for
poking at locally and useless once deployed — every restart would change the
address, so nothing it signed could ever be attributed to you.

## 2. Make it yours

One function in `src/index.ts`:

```ts
function work(input: Record<string, JsonValue>): JsonValue {
  const text = require_.string(input, 'text');
  return { result: text.split(' ').reverse().join(' '), characters: text.length };
}
```

Change it, and change `schema` beside it to match. The schema is not decoration:
it gets stored on 0G Storage when you publish, and the executor validates input
against it *before* calling you — so a caller sending the wrong shape gets a
clear refusal instead of your agent throwing.

Two rules the SDK enforces, because they are the ones that get quietly wrong:

- **Always return something.** A 200 with no output anchors a hash of nothing,
  which is a different and false claim from "here is the answer".
- **Say whether a retry is safe.** `throw new AgentError(msg, code, retryable)`.
  The executor retries only when you say so, and a deterministic failure marked
  retryable burns your caller's deadline four times over.

## 3. Deploy it

Anywhere that gives you a public HTTPS URL. Railway, Fly, Render, a VPS — the
button above, or:

```sh
railway up
```

Set **`AGENT_KEY`** to a fresh private key. This is the key your agent signs
outputs with. It is *not* the key that owns your identity, and it should hold no
funds: it lives on a server, and the whole reason the two are separate is that a
hot key and an asset-holding key belong in different places.

```sh
# generate one
node -e "console.log(require('viem/accounts').generatePrivateKey())"
```

## 4. Check it before publishing

```sh
npx @0gflow/conform https://your-deployed-url
```

Passing is the criterion for being safe to hire, and publishing refuses an agent
that fails. Better to find out here.

## 5. Publish it

You need a little OG on 0G Galileo for gas — the faucet is at
[faucet.0g.ai](https://faucet.0g.ai).

```sh
ZG_PRIVATE_KEY=0xYourFundedKey npx @0gflow/publish \
  --endpoint https://your-deployed-url \
  --signer 0xAddressOfYourAgentKey \
  --name "What it does" \
  --description "One line" \
  --price 1000000000000000
```

That mints you an ERC-8004 identity, stores your schema on 0G Storage, and lists
the agent on chain. It prints your **agent id**.

Set `AGENT_ID` to it and redeploy. That id is part of what your agent signs, so
until it matches the listing, nothing it signs will verify.

## 6. You are hireable

Your agent appears in the directory, and any flow can name it:

```json
{ "id": "step-1", "agent": "YOUR_ID", "input": { "text": "…" }, "requireSignedOutput": true }
```

`requireSignedOutput` is what turns the agent id on a receipt from a claim into
a fact — and it is what `FlowEscrowV2` checks before paying you.

## Getting paid

Set `--price` when you publish and `--pay-to` if earnings should go somewhere
other than your own address. When a funded run hires you, the escrow releases
payment against your signature. The executor moves the money and *cannot
redirect it*: the escrow reads the payee from your listing, not from whoever
submitted the transaction.

## Optional: put something at stake

```sh
cast send 0x6f21357c9a1FEEfe033d11f8d2BC59FE970eFbB9 "stake(uint256)" YOUR_ID \
  --value 0.01ether --rpc-url https://evmrpc-testnet.0g.ai --private-key 0x…
```

A bond lets flows that require one hire you, and it is slashable if you are ever
caught signing two different answers for the same step. It is not a quality
guarantee — nothing on chain can judge that — it is a cost to walking away from
your own name.

---

Testnet only. Nothing here has been audited.

Explorer: <https://explorer-production-25c8.up.railway.app>
