# Local Anchor Platform (testnet, dev only)

A self-hosted [Stellar Anchor Platform](https://github.com/stellar/anchor-platform)
(v4.6.0) for developing SupportMe's SEP-24 deposit/withdraw flow against a
reliable local anchor — instead of the public `testanchor.stellar.org`, which
periodically errors server-side.

> **This is throwaway developer infrastructure. It is not part of the SupportMe
> product and never ships.** On mainnet, SupportMe points at a real regulated
> anchor by setting `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN` / `NEXT_PUBLIC_ANCHOR_ASSET_CODE`
> — no code change. This directory just gives you an always-up anchor for local
> development.

## What it runs

Six containers (adapted from the official `quick-run/` compose): the Anchor
Platform SEP + platform servers, the Kotlin reference backend (KYC form +
settlement), the SEP-24 reference UI, Kafka, and two Postgres databases. Expect
a multi-GB image pull on first run.

It serves **its own testnet USDC** — an issuer keypair we generate and fund, so
the distribution account actually holds USDC and can settle deposits and
withdrawals. (SDF's demo USDC can't settle for us: we don't hold its issuing
key.)

## Prerequisites

- Docker with Compose
- [Stellar CLI](https://github.com/stellar/stellar-cli) (`stellar`) — key gen + funding
- Node.js — runs `issue-usdc.mjs` (uses `@stellar/stellar-sdk`, already a repo dep)

## Run

```bash
cd anchor
chmod +x setup.sh        # first time only
./setup.sh
```

`setup.sh` is re-runnable and idempotent: it reuses existing keypairs, so
re-running won't re-fund or re-mint. It generates + funds three testnet
keypairs (SEP-10 host, distribution, USDC issuer), issues local USDC, renders
the config templates, and starts the stack.

Verify:

```bash
curl http://localhost:8080/.well-known/stellar.toml            # TOML with USDC
curl http://localhost:8080/sep24/info | jq '.deposit.USDC'     # USDC enabled
```

Stop / reset:

```bash
docker compose down        # stop
docker compose down -v     # stop + wipe DB volumes (fresh start)
```

## Point the frontend at it

Set in `frontend/.env.local`:

```
NEXT_PUBLIC_ANCHOR_HOME_DOMAIN=localhost:8080
NEXT_PUBLIC_ANCHOR_ASSET_CODE=USDC
```

The frontend discovers the USDC issuer from this anchor's TOML
(`frontend/lib/anchor.js` → `loadAnchorConfig`), so nothing else changes.

> **HTTP note:** this anchor is served over plain `http://localhost:8080`.
> `@stellar/stellar-sdk`'s TOML resolver defaults to HTTPS; loading a
> `localhost` domain may require passing `allowHttp: true` (and `httpFetch`
> options). If the frontend can't fetch the TOML, that's the cause — see the
> "allowHttp" handling in `lib/anchor.js`.

## Required environment

| Where | What | Notes |
|-------|------|-------|
| Tools | Docker + Compose, `stellar` CLI, Node.js | checked by `setup.sh`, which exits with an install hint if one is missing |
| Keys | `ap-sep10-account`, `ap-distribution-account`, `ap-usdc-issuer` | created and funded on testnet by `setup.sh` in your Stellar CLI keystore; re-runs reuse them |
| Frontend | `NEXT_PUBLIC_ANCHOR_HOME_DOMAIN=localhost:8080` | which anchor the frontend talks to |
| Frontend | `NEXT_PUBLIC_ANCHOR_ASSET_CODE=USDC` | asset the anchor serves |

Ports used on your machine: `8080` (SEP server), `8085` (platform API), `8091`
(reference server), `3001` (SEP-24 interactive UI).

## Complete a SEP-24 withdrawal locally

1. Start the anchor: `cd anchor && ./setup.sh`. Note the **USDC issuer** it prints.
2. Put the two `NEXT_PUBLIC_ANCHOR_*` values above in `frontend/.env.local`, then
   start the backend and frontend as described in the root README.
3. Use a testnet wallet that has a trustline to that USDC issuer and holds some
   of the local USDC (for example by running a SEP-24 *deposit* through this
   same anchor first).
4. Sign in as a creator and open the cash-out flow from `/settings`.
5. Approve the SEP-10 sign-in in your wallet. The frontend then opens the
   anchor's interactive form (served on `http://localhost:3001`) in a popup or
   tab; allow it if your browser blocks it.
6. Fill in the KYC/bank form the reference server shows and submit.
7. Approve the on-chain USDC transfer to the anchor when your wallet asks. The
   frontend polls the anchor and shows the withdrawal moving to completed.

If the frontend can't read the anchor's TOML, see the HTTP note above.

> **Dev only.** This anchor exists so contributors can test cash-out locally.
> It uses throwaway keys and its own USDC, has no real fiat rails, and must
> never be deployed or pointed at production.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yaml` | the six services, pinned to `stellar/anchor-platform:4.6.0` |
| `dev.env` | Anchor Platform SEP config (dev constants; real secret injected at runtime) |
| `setup.sh` | keypair gen + funding + USDC issuance + template render + `up` |
| `issue-usdc.mjs` | establishes trustline + mints local USDC to the distribution account |
| `config/*.template` | config templates; `setup.sh` renders them to gitignored real files |

Rendered `config/*.yaml` and `config/stellar.localhost.toml` contain the
distribution account's **secret seed** and are gitignored. Never commit them.
