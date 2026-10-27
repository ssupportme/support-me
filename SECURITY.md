# Security Policy

SupportMe handles wallet authentication, recurring payments, and Soroban smart
contracts. We appreciate responsible reports that help keep those systems and
their users safe.

## Supported versions

Security fixes are applied to the latest commit on `main` and the currently
deployed production release. Older commits and forks are not supported.

## Reporting a vulnerability

**Do not open a public GitHub issue for a suspected vulnerability.**

Use GitHub's private vulnerability reporting flow:

1. Open the repository's **Security** tab.
2. Select **Report a vulnerability**.
3. Include enough detail for us to reproduce and assess the issue.

The direct reporting link is
<https://github.com/ssupportme/support-me/security/advisories/new>. If that link
is unavailable, open a minimal public issue asking the maintainers to enable a
private reporting channel; do not include exploit details, credentials, user
data, or other sensitive information in that issue.

Please include, where applicable:

- a description of the vulnerability and its potential impact;
- the affected path, contract, endpoint, or deployment;
- reproduction steps or a minimal proof of concept;
- the commit, version, or environment where it was observed;
- any suggested mitigation or fix;
- whether you intend to disclose the issue publicly and on what timeline.

## Scope

In scope:

- Soroban contracts in `contracts/`, including donation, subscription, and
  creator-registry logic;
- the backend API in `backend/`, including authentication, authorization,
  payment handling, and data access;
- the Next.js application in `frontend/`, including wallet and donation flows;
- repository automation that could affect releases or security controls.

Out of scope:

- vulnerabilities in third-party services, wallets, or Stellar network
  infrastructure that are not caused by code in this repository;
- spam, volumetric denial of service, and social engineering with no
  application-level security impact;
- findings that require compromised maintainer credentials or physical access;
- testnet-only secrets and intentionally public sample configuration.

Our September 2026 contract review is available in
[`docs/security/contract-security-review-2026-09.md`](docs/security/contract-security-review-2026-09.md).

## Response expectations

- We aim to acknowledge a report within **2 business days**.
- We aim to provide an initial assessment within **5 business days**.
- We will provide status updates at least every **7 days** while the report is
  under investigation.
- We ask that you give us **90 days** to investigate and release a fix before
  public disclosure, unless we agree on a different timeline. We will credit
  reporters who request it and coordinate disclosure with them.

SupportMe does not currently operate a paid bug bounty program.

## Safe harbor

We will not pursue legal action for good-faith security research that follows
this policy, avoids privacy violations, data destruction, service disruption,
and access beyond what is necessary to demonstrate the issue. If you are unsure
whether an action is authorized, contact us privately before proceeding.
