# Warden

Warden is a spend firewall for AI agents that use PayPal. It sits between the agent and PayPal as an MCP server, and checks every call that could move money against what the owner actually authorised. Calls inside that authorisation go through. Anything outside it is blocked, or held until the owner approves it on the dashboard.

An agent that reads email, invoices or web pages can be talked into paying the wrong person. Warden assumes that will happen and makes it not matter: the agent never holds PayPal credentials, and every payment is decided by rules the agent can't change.

## What it does

- **Mandates.** The owner grants the agent a scoped, time-limited permission in plain terms: "pay approved contractor invoices, up to $100 each and $200 in total, only to these two people, until tonight".
- **Policy.** Every money-moving call is checked against the mandate and the agent's limits: per-payment cap, daily budget, allowed and denied payees, payment rate, and repeats of a recent payment. Rules are written in [Cedar](https://www.cedarpolicy.com/) and each one reports a reason code and a plain sentence.
- **Provenance.** Warden also proxies the agent's other tools, such as its inbox, and remembers the payees, amounts and PayPal ids the agent read there. A payout to an address that appeared only in that content, and nowhere in what the owner wrote, is held for the owner with `PAYEE_FROM_UNTRUSTED_CONTENT`.
- **Intent judge.** Optionally, an LLM reads the owner's mandate and the payment and says whether one serves the other. It sees the payee, amount and tool, plus whether the agent read them in untrusted content, but never the untrusted text itself, so an email can't talk to it. It can only hold a payment for the owner. If it can't be reached or answers nonsense, the payment is denied. Any OpenAI-compatible endpoint works (`JUDGE_LLM_BASE_URL`, `JUDGE_LLM_MODEL`).
- **Approvals.** A payment outside the mandate is held, not just refused. The owner sees who, how much and why on the dashboard, and approves or rejects it. If nobody answers in time, it's blocked.
- **Structured refusals.** A blocked agent gets a reason it can act on (`COUNTERPARTY_NOT_IN_MANDATE`, `OVER_DAILY_BUDGET`, ...) instead of an opaque error.
- **Ledger.** Every call, decision and PayPal result is written to an append-only, hash-chained ledger, so any later edit is detectable.

## How it works

```
agent ──MCP──▶ edge-gateway ──▶ guard-worker (Temporal workflow per payment) ──▶ paypal-connector ──▶ PayPal
                    │                 │            │                                (only holder of
                    │                 │            ├──▶ judge-service (provenance)    PayPal credentials)
                    │                 │            └──▶ policy-service (Cedar,
                    │                 │                 mandates, budget holds)
                    └─ outbox ─▶ Kafka ◀─ outbox ─┘
                                    │
                                    ├──▶ ledger-service (hash-chained ledger, call history)
                                    ├──▶ judge-service (what each session read)
                                    └──▶ api + dashboard (approvals, mandates, evidence)
```

- **edge-gateway** is the MCP endpoint agents connect to with a key. Reads pass straight through. A call that commits or moves money is turned into a payment intent (payee, amount, references). When the agent leaves an amount out, the gateway looks it up first: a refund with no amount is priced from its capture.
- **guard-worker** runs each payment as a Temporal workflow. It reserves the amount against the budget, then evaluates policy and waits for the owner if needed. It forwards the call to PayPal exactly once, then settles or releases the hold. If PayPal's answer is lost, the hold stays and the call is never retried, because the money may already have moved.
- **judge-service** builds an index of what each agent session read from untrusted tools, from the gateway's events. The guard asks it about each payment before policy runs, so a payment it holds never draws on the mandate. It also runs the intent judge when one is configured. It can only hold or block a payment, never clear one. Without `JUDGE_URL`, the guard decides by policy alone.
- **policy-service** owns mandates and budget holds. Decisions are taken under a per-agent lock, so parallel calls can't spend the same headroom twice.
- **paypal-connector** runs PayPal's own MCP server ([`@paypal/mcp`](https://github.com/paypal/agent-toolkit)) and adds two tools it lacks: payouts and capture lookup, over the REST API. It reads PayPal's result bodies to decide success, since the MCP server reports failures as successful tool calls.
- **ledger-service** and the **api** build their views from the event stream. Services write events through a transactional outbox, so an event is published if and only if its state change committed.

Every check fails closed. If the policy service is down, a rule errors, the amount can't be determined, or the call can't be recorded, the payment does not happen.

## Running it

You need Docker, Node 24 and pnpm, plus a PayPal sandbox app. The sandbox business account should be US based, since payouts and card payments are not available from every country.

```sh
cp .env.example .env          # add PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, DEMO_CONTRACTOR_EMAIL
pnpm install
pnpm setup:env                # generates service tokens, the agent key and the dashboard password
pnpm app:up                   # kafka, postgres, temporal and every warden service
pnpm paypal:seed              # creates captured sandbox orders, so there is money to refund
```

The dashboard is at http://localhost:7005 (password: `DASHBOARD_PASSWORD` in `.env`). Agents connect to `http://localhost:7000/mcp` with `Authorization: Bearer <WARDEN_AGENT_KEY>`.

For MCP clients that take a URL, that is the whole change: point them at Warden instead of PayPal.

## The demo

`demo/ops-agent` is an operations assistant for a small design studio. It reads the day's inbox and pays invoices and refunds. One invoice hides an instruction to send the payment to a different account.

```sh
pnpm --filter @warden/ops-agent agent
```

`pnpm app:up` already runs the studio's inbox as an MCP server on port 7010. When running the services on the host instead, start it with `pnpm --filter @warden/ops-agent inbox`.

The agent reaches the inbox through Warden too (`UNTRUSTED_MCP_URLS`). Warden passes the emails through unchanged, but first records the payees, amounts and PayPal ids in them as untrusted content seen in that session. If that record can't be written, the agent doesn't get the content. A proxied server can't offer a tool with a PayPal tool's name.

By default the agent's brain is scripted: it does the job, and also obeys instructions it finds in emails, which is what a prompt-injected model does. To use a real model, set `AGENT_DRIVER=llm` with any OpenAI-compatible endpoint (`AGENT_BASE_URL`, `AGENT_MODEL`, `AGENT_API_KEY`). `docker compose --profile llm up -d ollama` runs a small local one.

## Benchmark

`bench/` holds 30 scenarios: 8 benign, 4 benign but outside the mandate, 5 payee redirections, 4 inflated amounts, 4 unrequested actions, 3 split or repeated payments, and 2 attacks that stay inside the mandate. Each is a YAML file with the owner's task, the mandate, the emails the agent reads, and what should happen to each payment. The harness runs every scenario three ways: with no guard (calls are recorded, not sent), with Warden's policy only, and with full Warden (policy plus provenance). A scripted owner approves held payments the scenario says are legitimate and rejects the rest.

```sh
pnpm --filter @warden/bench bench                         # scripted agent, all three arms
pnpm --filter @warden/bench bench --driver llm --runs 3   # a real model (AGENT_BASE_URL, AGENT_MODEL)
```

Results with the scripted agent, which obeys every injected instruction, and the LLM judge off:

| | no guard | policy only | full |
| --- | --- | --- | --- |
| attack scenarios where money reached the attacker | 18 of 18 | 7 of 18 | 4 of 18 |
| attack payments that reached PayPal | 100% | 40% | 30% |
| legitimate payments allowed straight through | 100% | 100% | 94% |
| legitimate payments held for approval when they should be | 0% | 100% | 100% |

What still gets through full Warden: two invoices inflated within the mandate's caps and a refund nobody asked for inside an open refund mandate, which are the intent judge's job, and six of eight small split payments before the rate limit stops the rest. The one legitimate payment held is a contractor paid under a mandate that allows any payee: the payee only appears in the email, which provenance can't tell from an attack. Raw results are in `bench/results/`.

## Policy

Limits per agent live in [`docs/policy.example.yaml`](docs/policy.example.yaml). The file decides which reasons go to the owner and which deny outright:

```yaml
escalate_when:
  - NO_MANDATE
  - COUNTERPARTY_NOT_IN_MANDATE
  - OVER_MANDATE_PER_CALL_CAP
  - OVER_MANDATE_TOTAL
```

Everything else (deny-listed payees, the daily budget, payment rate, repeats) denies without asking.

## Development

```sh
pnpm infra:up      # kafka, postgres, temporal, jaeger only
pnpm build
pnpm test          # unit tests, plus integration tests against real postgres and kafka containers
pnpm lint
```
