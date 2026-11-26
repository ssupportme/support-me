# SupportMe Donation Smart Contract

A Soroban smart contract for handling creator donations and profiles on the Stellar blockchain.

## Overview

The `DonationContract` enables creators to register public profiles and receive donations from supporters. All donations are recorded immutably on the blockchain, creating a transparent donation history.

## Key Features

- **Creator Registration**: Creators can register profiles with usernames
- **Donation Tracking**: Donations are recorded with donor, creator, amount, fee amount, memo, and timestamp
- **Creator Profiles**: Total donations and donation count are stored on each creator's profile
- **Event Logging**: All actions emit events for monitoring and indexing
- **Auth Integration**: Uses Soroban's native auth for secure operations
- **Recurring Donations**: Supporters can subscribe to a creator; an executor charges each interval against a token allowance
- **Multi-token Donations**: Donations are made in an allowlisted token

## Contract Structure

### Data Types

#### `DonationRecord`
Records one donation (a one-off `donate` or a subscription charge). `amount` is the
gross amount the donor sent; the creator receives `amount - fee_amount` and the
platform fee address receives `fee_amount`.
```rust
pub struct DonationRecord {
    pub donor: Address,
    pub creator: Address,
    pub amount: i128,
    pub fee_amount: i128,
    pub memo: String,
    pub timestamp: u64,
}
```


#### `CreatorProfile`
Creator account information:
```rust
pub struct CreatorProfile {
    pub address: Address,         // Creator's wallet address
    pub username: String,         // Public username
    pub total_donations: i128,    // Total XLM received
    pub donation_count: u32,      // Number of donations
    pub created_at: u64,         // Registration timestamp
}
```
#### `Subscription`
A recurring donation. The supporter grants the donation contract a token allowance
(via the token contract's `approve`) covering `amount` per `interval_secs`; the
contract draws on it once per interval, on or after `next_charge_at`.
```rust
pub struct Subscription {
    pub supporter: Address,
    pub creator: Address,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub next_charge_at: u64,
    pub active: bool,
}
```
`AdminAction` and `AdminProposal` (used by the multi-sig functions) are also defined
in the `common` crate.

### Methods

#### Creators
| Method | Returns |
|---|---|
| `register_creator(env, creator: Address, username: String)` | `CreatorProfile` |
| `get_creator(env, creator: Address)` | `Option<CreatorProfile>` |

#### Donations
| Method | Returns |
|---|---|
| `donate(env, donor: Address, creator: Address, token: Address, amount: i128, memo: String)` | `DonationRecord` |
| `get_donation(env, index: u32)` | `Option<DonationRecord>` |
| `get_total_donations_count(env)` | `u32` |

`donate` requires the donor's authorization and fails with `DonationError::Paused`
while the contract is paused.

#### Subscriptions
| Method | Returns |
|---|---|
| `subscribe(env, supporter: Address, creator: Address, token: Address, amount: i128, interval_secs: u64)` | `u64` (subscription id) |
| `charge_subscription(env, executor: Address, subscription_id: u64)` | `Result<DonationRecord, ChargeError>` |
| `cancel_subscription(env, supporter: Address, subscription_id: u64)` | none |
| `get_subscription(env, subscription_id: u64)` | `Option<Subscription>` |
| `get_committed_amount(env, supporter: Address, token: Address)` | `i128` |
| `bump_subscription(env, subscription_id: u64)` | none |

#### Goals
| Method | Returns |
|---|---|
| `set_goal(env, creator: Address, goal_amount: i128)` | none |
| `get_goal(env, creator: Address)` | `Option<i128>` |

#### Configuration and admin
| Method | Returns |
|---|---|
| `initialize(env, admin: Address, registry: Address)` | none |
| `initialize_multisig(env, admins: Vec<Address>, threshold: u32, timelock_delay: u64, registry: Address)` | none |
| `bump(env)` | none |
| `is_admin(env, address: Address)` | `bool` |
| `is_paused(env)` | `bool` |
| `emergency_pause(env, admin: Address)` | none |
| `set_executor(env, executor: Address)` | none |
| `add_allowed_token(env, token: Address)` | none |
| `remove_allowed_token(env, token: Address)` | none |
| `is_token_allowed(env, token: Address)` | `bool` |
| `set_min_donation(env, min_amount: i128)` | none |
| `get_min_donation(env)` | `i128` |
| `set_max_donation(env, max_amount: i128)` | none |
| `get_max_donation(env)` | `i128` |

#### Multi-sig proposals
| Method | Returns |
|---|---|
| `propose_admin_action(env, proposer: Address, action: AdminAction)` | `u64` (proposal id) |
| `approve_admin_action(env, admin: Address, proposal_id: u64)` | none |
| `cancel_admin_action(env, caller: Address, proposal_id: u64)` | none |
| `execute_admin_action(env, executor: Address, proposal_id: u64)` | none |
| `get_proposal(env, proposal_id: u64)` | `Option<AdminProposal>` |

## Usage Flow

### For Creators

1. Register a profile with `register_creator(creator, username)`.
2. Read your profile and totals with `get_creator(creator)`.
3. Optionally set a donation goal with `set_goal`.
4. Share your creator address or username with supporters.

### For Supporters

1. Look up the creator's address (`get_creator` confirms they are registered).
2. Send a one-off donation with `donate(donor, creator, token, amount, memo)`, or
   approve an allowance on the token and call `subscribe(...)` for a recurring one.
3. Read back a record with `get_donation(index)` or a subscription with
   `get_subscription(subscription_id)`.

## Storage Model

- **Permanent Storage**: Creator profiles (persistent across ledger resets)
- **Persistent Storage**: Donation records with counter-based indexing
- **Key Format**: Donations stored as "don{counter}" for efficient retrieval

## Events



### Donated Event
```
Emitted when a donation or subscription charge is made
Data: DonatedEvent {
    donor: Address,          // topic
    creator: Address,        // topic
    donation_id: u32,
    token: Address,
    amount: i128,
    fee_amount: i128,
    memo: String,
    timestamp: u64,
    subscription_id: Option<u64>,
}
```

## Error Codes

The contracts use typed, discriminant-backed errors instead of untyped panics.
Codes are only unique within one enum.

### `ChargeError` (`contracts/donation`)
| Code | Error Variant | Description |
|---|---|---|
| 1 | `InsufficientAllowance` | Allowance is insufficient to complete the subscription charge |
| 2 | `InsufficientBalance` | Supporter balance is insufficient |
| 3 | `TokenNotAllowed` | The subscription's token was removed from the allowlist |
| 4 | `AmountOutOfBounds` | The amount no longer satisfies the current min/max donation bounds |

### `DonationError` (`contracts/donation`)
| Code | Error Variant |
|---|---|
| 3 | `NotInitialized` |
| 4 | `AlreadyInitialized` |
| 5 | `Paused` |
| 6 | `Unauthorized` |
| 7 | `TokenNotAllowed` |
| 8 | `MemoTooLong` |
| 10 | `AmountTooLow` |
| 11 | `AmountTooHigh` |
| 12 | `NotDue` |
| 13 | `SubscriptionNotActive` |
| 14 | `SubscriptionNotFound` |
| 15 | `InvalidAmount` |
| 16 | `InvalidInterval` |
| 17 | `InvalidThreshold` |
| 18 | `EmptyAdminList` |
| 19 | `ProposalNotFound` |
| 20 | `ProposalAlreadyExecuted` |
| 21 | `AlreadyApproved` |
| 22 | `TimelockNotElapsed` |
| 23 | `ThresholdExceedsAdmins` |
| 24 | `CannotRemoveAllAdmins` |
| 25 | `MultiSigRequired` |
| 26 | `ExecutorNotSet` |
| 27 | `Overflow` |
| 28 | `ProposalCancelled` |
| 29 | `ProposalExpired` |
| 30 | `AdminAlreadyExists` |
| 31 | `AdminNotFound` |
| 32 | `InvalidDonationLimits` |
| 33 | `SelfDonation` |

Code 9 is not used.

### `RegistryError` (`contracts/creator-registry`)
| Code | Error Variant |
|---|---|
| 1 | `NotInitialized` |
| 2 | `AlreadyInitialized` |
| 3 | `Unauthorized` |
| 4 | `AlreadyRegistered` |
| 5 | `InvalidAmount` |
| 6 | `InvalidThreshold` |
| 7 | `EmptyAdminList` |
| 8 | `ProposalNotFound` |
| 9 | `ProposalAlreadyExecuted` |
| 10 | `AlreadyApproved` |
| 11 | `TimelockNotElapsed` |
| 12 | `ThresholdExceedsAdmins` |
| 13 | `CannotRemoveAllAdmins` |
| 14 | `MultiSigRequired` |
| 15 | `CallerNotAuthorized` |
| 16 | `InvalidGoal` |
| 17 | `Overflow` |
| 18 | `EmptyUsername` |
| 19 | `UsernameTooLong` |
| 20 | `InvalidUsernameChars` |
| 21 | `UsernameTaken` |
| 22 | `UnsupportedAction` |

## Security Considerations

1. **Authentication**: All state-changing operations require auth
2. **Validation**: Amounts must be positive
3. **No self-donations**: `donate` and `subscribe` reject calls where the donor/supporter address equals the creator address (`DonationError::SelfDonation`). This prevents a creator from inflating their own registry stats and leaderboard standing at the cost of only the network fee.
4. **Creator Flexibility**: Creators don't need to pre-register to receive donations
5. **Immutability**: All donation records are immutable once recorded

## Deployment and initialization

The donation contract has no `__constructor`. It is configured after deployment by
calling `initialize(admin, registry)`, or
`initialize_multisig(admins, threshold, timelock_delay, registry)` for a multi-admin
setup. The executor that may call `charge_subscription` is set with `set_executor`.

The `creator-registry` contract can be configured the same way, with
`initialize(admin, donation_contract)` or
`initialize_multisig(...)`, or atomically at deploy time through
`__constructor(admins, threshold, timelock_delay, donation_contract)`. The admin set
must be non-empty and free of duplicates, and `threshold` must be between 1 and the
number of admins.

[`scripts/deploy-testnet.sh`](../../scripts/deploy-testnet.sh) (`make deploy-testnet`)
builds both contracts, deploys them to testnet, calls `initialize` on each so they
reference one another, sets the executor, and records the addresses in
`deployments/testnet.json`. See
[`docs/contract-deploy-workflow.md`](../../docs/contract-deploy-workflow.md) for the
manual CLI steps and verification.

## Keeping the contract live

Admins, threshold, registry, executor, the pause flag and the token allowlist
live in instance storage. Every state-changing call extends the instance TTL
to ~30 days whenever less than ~29 days remain (`INSTANCE_BUMP_AMOUNT` /
`INSTANCE_LIFETIME_THRESHOLD` in the `common` crate). During quiet periods,
call the permissionless `bump()` on both contracts on a schedule so they are
not archived.

## Building

```bash
make build
```

## Testing

```bash
make test
```

## Future Enhancements

- Batch donations
- Donation search/filtering
- Creator tiers and perks
- Donation escrow with milestone-based release
- Integration with payment channels
- Creator rankings and leaderboards
