# SupportMe Smart Contract Governance: Multi-Signature & Timelock Administration

This runbook documents the multi-signature (M-of-N) threshold and timelock governance mechanisms for managing sensitive administrative actions across the SupportMe Soroban smart contracts (`donation` and `creator-registry`).

---

## 1. Governance Overview

To protect user funds and creator registry records against single-key compromise or unauthorized parameter changes, high-risk administrative operations require:
1. **Multi-Signature Approval**: Proposals require a configurable threshold ($M$-of-$N$) of authorized admin signatures before execution.
2. **Timelock Delay**: A mandatory delay period ($\text{ETA} = \text{creation\_timestamp} + \text{delay\_secs}$) before an approved proposal can be executed on-chain.
3. **Emergency Circuit Breaker**: Any single authorized admin can execute an immediate `emergency_pause` to freeze contract state in response to an active threat.

---

## 2. High-Risk Administrative Actions

The following contract actions are gated behind multi-signature approval:
- `SetExecutor`: Configures or rotates the off-chain auto-charge executor address.
- `SetDonationContract`: Updates the primary donation contract address bound to the creator registry.
- `AddAdmin`: Adds a new trusted address to the contract admin list.
- `RemoveAdmin`: Revokes admin privileges from an address.
- `SetThreshold`: Adjusts the signature threshold ($M$).
- `Pause` / `Unpause`: Suspends or resumes contract transfers and subscription operations.

---

## 3. Operations Runbook

### Step 1: Propose an Administrative Action
An authorized admin constructs and submits a proposal transaction:

```bash
soroban contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_1_KEY> \
  --network testnet \
  -- \
  propose_admin_action \
  --proposer <ADMIN_1_ADDRESS> \
  --action '{"SetExecutor": {"target": "<NEW_EXECUTOR_ADDRESS>"}}'
```

*Output:* Returns the `proposal_id` (e.g. `0`) and emits a `ProposalCreatedEvent`.

---

### Step 2: Co-Signers Approve the Proposal
Additional admins review the proposal on-chain and submit approvals until the required signature threshold ($M$) is reached:

```bash
soroban contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_2_KEY> \
  --network testnet \
  -- \
  approve_admin_action \
  --admin <ADMIN_2_ADDRESS> \
  --proposal_id 0
```

---

### Step 3: Execute the Proposal After Timelock
Once the threshold is satisfied and the ledger timestamp reaches $\ge \text{ETA}$, any authorized admin triggers execution:

```bash
soroban contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ADMIN_1_KEY> \
  --network testnet \
  -- \
  execute_admin_action \
  --executor <ADMIN_1_ADDRESS> \
  --proposal_id 0
```

---

## 4. Emergency Procedures

### Immediate Emergency Pause
In the event of a suspected security event or anomaly:
```bash
soroban contract invoke \
  --id <DONATION_CONTRACT_ID> \
  --source-account <ANY_ADMIN_KEY> \
  --network testnet \
  -- \
  emergency_pause \
  --admin <ADMIN_ADDRESS>
```

### Unpausing the Contract
Resuming operations requires the full multi-sig proposal and execution flow (`propose_admin_action` with `Unpause`).
