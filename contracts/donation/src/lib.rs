#![no_std]

//! Donation contract: moves the donated token from donor to creator and
//! keeps a local, append-only log of donations. Creator profile state
//! (username, lifetime totals) lives in a separate `creator-registry`
//! contract — this contract talks to it exclusively through cross-contract
//! calls (`env.invoke_contract`), so the two contracts can be deployed,
//! upgraded, and audited independently.
//!
//! # Storage & Rent Tradeoffs
//!
//! To minimize Soroban state rent, the append-only donation log stored in
//! this contract operates without explicit `extend_ttl` calls. Over time, as
//! volume grows, old records may expire and disappear from `get_donation`.
//! This is an accepted design choice: the backend indexing `DonatedEvent`s
//! is the canonical source of long-term history. Future contract upgrades
//! should avoid relying on the complete on-chain history being present.
//! Successful state-changing entry points extend the contract instance TTL;
//! the donation-record TTL exception below applies only to old log entries.
//!
//! Multi-signature and timelock governance:
//! High-risk administrative operations (setting executor, rotating admins,
//! adjusting threshold, pausing operations) require multi-signature proposal,
//! approval threshold, and timelock delay before execution.
//!
//! Initialization happens atomically at deploy time through `__constructor`;
//! there is no separate public initializer that could be front-run.
//!
//! Unlike the donation log, instance storage (admins, registry, executor,
//! pause flag, token allowlist) *is* kept alive: every state-changing entry
//! point extends the instance TTL, and `bump()` lets anyone extend it during
//! idle periods. See the `common` crate docs for the TTL constants.

use common::{
    extend_instance_ttl, extend_persistent_ttl, extend_proposal_ttl, extend_subscription_ttl,
    validate_admin_set, AdminAction, AdminProposal, CreatorProfile, DonationRecord, Subscription,
    ADMIN_PROPOSAL_TTL_SECONDS,
};
use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, symbol_short, token, Address, Env,
    IntoVal, String, Symbol, Val, Vec,
};

const DONATIONS_KEY: Symbol = symbol_short!("donations");
const DONATION_COUNTER: Symbol = symbol_short!("counter");
const ADMIN_KEY: Symbol = symbol_short!("admin");
const ADMINS_KEY: Symbol = symbol_short!("admins");
const THRESHOLD_KEY: Symbol = symbol_short!("thresh");
const TIMELOCK_DELAY_KEY: Symbol = symbol_short!("delay");
const PROPOSAL_COUNTER_KEY: Symbol = symbol_short!("prop_ctr");
const PROPOSAL_KEY: Symbol = symbol_short!("proposal");
const APPROVAL_KEY: Symbol = symbol_short!("approval");
const CANCEL_KEY: Symbol = symbol_short!("cancel");
const PAUSED_KEY: Symbol = symbol_short!("paused");
const REGISTRY_KEY: Symbol = symbol_short!("registry");
const SUBSCRIPTIONS_KEY: Symbol = symbol_short!("subs");
const SUB_COUNTER: Symbol = symbol_short!("sub_ctr");
const EXECUTOR_KEY: Symbol = symbol_short!("executor");
const ALLOWED_TOKEN_KEY: Symbol = symbol_short!("allowed");
const MIN_DONATION_KEY: Symbol = symbol_short!("min_don");
const MAX_DONATION_KEY: Symbol = symbol_short!("max_don");
/// Persistent key, keyed further by `(supporter, token)`, tracking the sum of
/// `amount` across that supporter's currently-active subscriptions in that
/// token. See `cancel_subscription` for why this is needed: SAC allowances
/// are keyed by `(owner, spender)`, not per subscription, so cancelling one
/// subscription must only reduce the allowance by *that* subscription's
/// committed amount, never zero out a shared allowance still backing others.
const COMMITTED_KEY: Symbol = symbol_short!("commit");
pub const MAX_MEMO_LENGTH: u32 = 140;

/// Emitted whenever a donation is settled on-chain.
#[contractevent(topics = ["donated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonatedEvent {
    #[topic]
    pub donor: Address,
    #[topic]
    pub creator: Address,
    pub donation_id: u32,
    pub token: Address,
    pub amount: i128,
    pub memo: String,
    pub timestamp: u64,
    pub subscription_id: Option<u64>,
}

/// Emitted when a supporter starts a recurring donation. Carries `token`
/// and `next_charge_at` so the backend can create and reconcile schedules
/// directly from the event stream.
#[contractevent(topics = ["subscribed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscribedEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
    pub token: Address,
    pub amount: i128,
    pub interval_secs: u64,
    pub next_charge_at: u64,
}

/// Emitted when a supporter cancels a recurring donation. Indexed by both
/// supporter and creator so both dashboards can track cancellations.
#[contractevent(topics = ["sub_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionCancelledEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
}

/// Emitted when cancellation replaces a positive shared SAC allowance.
#[contractevent(topics = ["sub_allowance_updated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionAllowanceEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub token: Address,
    pub subscription_id: u64,
    pub live_until_ledger: u32,
}

/// Emitted when an admin proposal is created.
#[contractevent(topics = ["prop_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub proposal_id: u64,
    #[topic]
    pub proposer: Address,
    pub eta: u64,
    pub action: AdminAction,
}

/// Emitted when an admin proposal receives an approval.
#[contractevent(topics = ["prop_approved"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalApprovedEvent {
    pub proposal_id: u64,
    #[topic]
    pub admin: Address,
    pub approvals_count: u32,
}

/// Emitted when an admin proposal is executed.
#[contractevent(topics = ["prop_exec"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalExecutedEvent {
    pub proposal_id: u64,
    #[topic]
    pub executor: Address,
}

/// Emitted when an admin proposal is cancelled — either unilaterally by its
/// proposer or after `threshold` current admins requested the cancellation.
#[contractevent(topics = ["prop_cancelled"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCancelledEvent {
    pub proposal_id: u64,
    #[topic]
    pub cancelled_by: Address,
}

/// Emitted when an admin is added to the multisig set.
#[contractevent(topics = ["admin_added"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminAddedEvent {
    #[topic]
    pub admin: Address,
    pub total_admins: u32,
}

/// Emitted when an admin is removed from the multisig set.
#[contractevent(topics = ["admin_removed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminRemovedEvent {
    #[topic]
    pub admin: Address,
    pub total_admins: u32,
}

/// Emitted when the multisig approval threshold changes.
#[contractevent(topics = ["threshold_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThresholdChangedEvent {
    pub old_threshold: u32,
    pub new_threshold: u32,
}

/// Emitted when the registry / donation-contract address is repointed.
#[contractevent(topics = ["registry_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RegistryChangedEvent {
    pub old_registry: Option<Address>,
    #[topic]
    pub new_registry: Address,
}

#[contractevent(topics = ["goal_upd"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalUpdatedEvent {
    #[topic]
    pub creator: Address,
    pub goal_amount: i128,
    pub updated_at: u64,
}
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum ChargeError {
    InsufficientAllowance = 1,
    InsufficientBalance = 2,
    /// The subscription's token was removed from the allowlist (#465) since
    /// the subscription was created, or was never re-validated. An emergency
    /// token removal must stop an existing recurring charge, not just block
    /// new `subscribe`/`donate` calls.
    TokenNotAllowed = 3,
    /// The subscription's amount no longer satisfies the current min/max
    /// donation bounds (#465). This can only happen if the bounds were
    /// tightened after the subscription was created — `subscribe` itself
    /// rejects an out-of-bounds amount up front.
    AmountOutOfBounds = 4,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum DonationError {
    NotInitialized = 3,
    AlreadyInitialized = 4,
    Paused = 5,
    Unauthorized = 6,
    TokenNotAllowed = 7,
    MemoTooLong = 8,
    AmountTooLow = 10,
    AmountTooHigh = 11,
    NotDue = 12,
    SubscriptionNotActive = 13,
    SubscriptionNotFound = 14,
    InvalidAmount = 15,
    InvalidInterval = 16,
    InvalidThreshold = 17,
    EmptyAdminList = 18,
    ProposalNotFound = 19,
    ProposalAlreadyExecuted = 20,
    AlreadyApproved = 21,
    TimelockNotElapsed = 22,
    ThresholdExceedsAdmins = 23,
    CannotRemoveAllAdmins = 24,
    MultiSigRequired = 25,
    ExecutorNotSet = 26,
    Overflow = 27,
    /// The proposal was cancelled (by its proposer or by threshold admin
    /// cancellation requests) and can no longer be approved or executed.
    ProposalCancelled = 28,
    /// The proposal's lifetime (`created_at + ADMIN_PROPOSAL_TTL_SECONDS`)
    /// has elapsed and it can no longer be approved or executed.
    ProposalExpired = 29,
    /// `AddAdmin` targets an address that is already an admin (#560).
    AdminAlreadyExists = 30,
    /// `RemoveAdmin` targets an address that is not an admin (#560).
    AdminNotFound = 31,
    /// A proposed min/max donation would leave the minimum above the
    /// maximum while both are non-zero (#560).
    InvalidDonationLimits = 32,
    /// `donate` or `subscribe` was called with donor == creator.
    SelfDonation = 33,
}

#[contractevent(topics = ["sub_failed"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionChargeFailedEvent {
    #[topic]
    pub supporter: Address,
    #[topic]
    pub creator: Address,
    pub subscription_id: u64,
    pub reason: ChargeError,
}

/// Emitted whenever the token allowlist changes (#284), whether through a
/// multisig-approved `AdminAction` or the single-admin legacy shortcut.
#[contractevent(topics = ["allow_tok"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AllowedTokenChangedEvent {
    #[topic]
    pub token: Address,
    pub allowed: bool,
}

/// Emitted whenever the minimum donation guardrail changes (#284).
#[contractevent(topics = ["min_don"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MinDonationChangedEvent {
    pub old_min: i128,
    pub new_min: i128,
}

/// Emitted whenever the maximum donation guardrail changes (#284).
#[contractevent(topics = ["max_don"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaxDonationChangedEvent {
    pub old_max: i128,
    pub new_max: i128,
}

/// Emitted whenever the contract is paused or unpaused (#284). Covers both
/// the instant `emergency_pause` shortcut and the multisig `Pause`/`Unpause`
/// `AdminAction`s.
#[contractevent(topics = ["pause_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PauseChangedEvent {
    pub paused: bool,
}

/// Emitted whenever the authorized subscription-charge executor changes
/// (#284), whether via the multisig `SetExecutor` action or the single-admin
/// legacy `set_executor` shortcut. `old_executor` is `None` the first time
/// an executor is ever set.
#[contractevent(topics = ["exec_chg"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecutorChangedEvent {
    pub old_executor: Option<Address>,
    #[topic]
    pub new_executor: Address,
}

#[contract]
pub struct DonationContract;

#[contractimpl]
impl DonationContract {
    /// Runs atomically as part of deployment, so no one can race the deployer
    /// to claim the admin set. `admins[0]` is the primary admin used by the
    /// single-admin config shortcuts (`set_executor`, token allowlist, donation
    /// limits). A 1-of-1 deployment passes a single admin and threshold 1.
    pub fn __constructor(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
        registry: Address,
    ) {
        validate_admin_set(&admins, threshold);

        let primary_admin = admins.get(0).unwrap();
        env.storage().instance().set(&ADMIN_KEY, &primary_admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &threshold);
        env.storage()
            .instance()
            .set(&TIMELOCK_DELAY_KEY, &timelock_delay);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
        extend_instance_ttl(&env);
    }

    /// One-time single-admin setup: backwards compatible wrapper initializing 1-of-1 admin setup.
    pub fn initialize(env: Env, admin: Address, registry: Address) {
        admin.require_auth();
        if env.storage().instance().has(&ADMIN_KEY) || env.storage().instance().has(&ADMINS_KEY) {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyInitialized);
        }

        let mut admins = Vec::new(&env);
        admins.push_back(admin.clone());

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &1u32);
        env.storage().instance().set(&TIMELOCK_DELAY_KEY, &0u64);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
        extend_instance_ttl(&env);
    }

    /// One-time multi-sig setup: configures admin list, threshold, and timelock delay.
    pub fn initialize_multisig(
        env: Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
        registry: Address,
    ) {
        validate_admin_set(&admins, threshold);
        if env.storage().instance().has(&ADMIN_KEY) || env.storage().instance().has(&ADMINS_KEY) {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyInitialized);
        }

        for i in 0..admins.len() {
            admins.get(i).unwrap().require_auth();
        }

        let primary_admin = admins.get(0).unwrap();
        env.storage().instance().set(&ADMIN_KEY, &primary_admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &threshold);
        env.storage()
            .instance()
            .set(&TIMELOCK_DELAY_KEY, &timelock_delay);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
        extend_instance_ttl(&env);
    }

    /// Permissionless keep-alive: extends the instance TTL so the contract is
    /// not archived during long periods without other state-changing calls.
    /// Intended to be called on a schedule by the backend executor.
    pub fn bump(env: Env) {
        extend_instance_ttl(&env);
    }

    /// Returns whether a given address is an authorized contract admin.
    pub fn is_admin(env: Env, address: Address) -> bool {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| Vec::new(&env));
        Self::contains_address(&admins, &address)
    }

    /// Recounts `key` votes for `proposal_id` against the *current* admin set
    /// (`ADMINS_KEY`), so approvals (or cancellation requests) cast by an
    /// admin who has since been removed no longer count toward the threshold.
    /// Used at execution instead of trusting the cached `approvals_count`.
    fn count_current_admin_votes(env: &Env, key: Symbol, proposal_id: u64) -> u32 {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| Vec::new(env));
        let mut votes: u32 = 0;
        for i in 0..admins.len() {
            let admin = admins.get(i).unwrap();
            let voted: bool = env
                .storage()
                .persistent()
                .get(&(key.clone(), proposal_id, admin))
                .unwrap_or(false);
            if voted {
                votes = votes.checked_add(1).expect("vote count overflow");
            }
        }
        votes
    }

    /// Returns whether contract transfers/operations are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    /// Emergency pause: any authorized admin can instantly freeze contract operations.
    pub fn emergency_pause(env: Env, admin: Address) {
        admin.require_auth();
        if !Self::is_admin(env.clone(), admin) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        env.storage().instance().set(&PAUSED_KEY, &true);
        extend_instance_ttl(&env);
        PauseChangedEvent { paused: true }.publish(&env);
    }

    /// Proposes a multi-signature administrative action.
    pub fn propose_admin_action(env: Env, proposer: Address, action: AdminAction) -> u64 {
        proposer.require_auth();
        if !Self::is_admin(env.clone(), proposer.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        Self::validate_admin_action(&env, &action);

        let prop_id: u64 = env
            .storage()
            .persistent()
            .get(&PROPOSAL_COUNTER_KEY)
            .unwrap_or(0);
        let timelock: u64 = env
            .storage()
            .instance()
            .get(&TIMELOCK_DELAY_KEY)
            .unwrap_or(0);
        let now = env.ledger().timestamp();
        let eta = match now.checked_add(timelock) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        let expires_at = match now.checked_add(ADMIN_PROPOSAL_TTL_SECONDS) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };

        extend_instance_ttl(&env);
        let proposal = AdminProposal {
            id: prop_id,
            action,
            proposer: proposer.clone(),
            approvals_count: 1,
            created_at: now,
            eta,
            expires_at,
            executed: false,
            cancelled: false,
        };

        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, prop_id), &proposal);
        extend_proposal_ttl(&env, &(PROPOSAL_KEY, prop_id), timelock);
        env.storage()
            .persistent()
            .set(&(APPROVAL_KEY, prop_id, proposer.clone()), &true);
        extend_proposal_ttl(&env, &(APPROVAL_KEY, prop_id, proposer.clone()), timelock);
        let next_prop_id = match prop_id.checked_add(1) {
            Some(id) => id,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&PROPOSAL_COUNTER_KEY, &next_prop_id);
        extend_persistent_ttl(&env, &PROPOSAL_COUNTER_KEY);

        extend_instance_ttl(&env);
        ProposalCreatedEvent {
            proposal_id: prop_id,
            proposer,
            eta,
            action: proposal.action.clone(),
        }
        .publish(&env);

        prop_id
    }

    /// Approves an existing administrative proposal.
    pub fn approve_admin_action(env: Env, admin: Address, proposal_id: u64) {
        admin.require_auth();
        if !Self::is_admin(env.clone(), admin.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        extend_instance_ttl(&env);

        let mut proposal: AdminProposal =
            match env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id)) {
                Some(p) => p,
                None => soroban_sdk::panic_with_error!(&env, DonationError::ProposalNotFound),
            };
        if proposal.executed {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalCancelled);
        }
        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalExpired);
        }

        let has_approved: bool = env
            .storage()
            .persistent()
            .get(&(APPROVAL_KEY, proposal_id, admin.clone()))
            .unwrap_or(false);
        if has_approved {
            soroban_sdk::panic_with_error!(&env, DonationError::AlreadyApproved);
        }

        let timelock: u64 = env
            .storage()
            .instance()
            .get(&TIMELOCK_DELAY_KEY)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&(APPROVAL_KEY, proposal_id, admin.clone()), &true);
        extend_proposal_ttl(&env, &(APPROVAL_KEY, proposal_id, admin.clone()), timelock);
        proposal.approvals_count = match proposal.approvals_count.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);
        extend_proposal_ttl(&env, &(PROPOSAL_KEY, proposal_id), timelock);

        extend_instance_ttl(&env);
        ProposalApprovedEvent {
            proposal_id,
            admin,
            approvals_count: proposal.approvals_count,
        }
        .publish(&env);
    }

    /// Cancels an administrative proposal before it is executed. The proposer
    /// can cancel their own proposal unilaterally. Any other caller must be a
    /// current admin: each such admin records a cancellation request, counted
    /// against the *current* admin set exactly like approvals (requests from
    /// since-removed admins do not count), and the proposal is marked
    /// cancelled once `threshold` requests have been reached. Emits
    /// [`ProposalCancelledEvent`] when the proposal is marked cancelled.
    pub fn cancel_admin_action(env: Env, caller: Address, proposal_id: u64) {
        caller.require_auth();
        let mut proposal: AdminProposal = env
            .storage()
            .persistent()
            .get(&(PROPOSAL_KEY, proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed, "proposal already executed");
        assert!(!proposal.cancelled, "proposal already cancelled");
        extend_instance_ttl(&env);

        if caller != proposal.proposer {
            assert!(
                Self::is_admin(env.clone(), caller.clone()),
                "only the proposer or an admin can cancel a proposal"
            );
            let already_requested: bool = env
                .storage()
                .persistent()
                .get(&(CANCEL_KEY, proposal_id, caller.clone()))
                .unwrap_or(false);
            assert!(
                !already_requested,
                "admin has already requested cancellation"
            );
            let timelock: u64 = env
                .storage()
                .instance()
                .get(&TIMELOCK_DELAY_KEY)
                .unwrap_or(0);
            env.storage()
                .persistent()
                .set(&(CANCEL_KEY, proposal_id, caller.clone()), &true);
            extend_proposal_ttl(&env, &(CANCEL_KEY, proposal_id, caller.clone()), timelock);

            let requests = Self::count_current_admin_votes(&env, CANCEL_KEY, proposal_id);
            let threshold: u32 = env
                .storage()
                .instance()
                .get(&THRESHOLD_KEY)
                .expect("threshold not set");
            if requests < threshold {
                return;
            }
        }

        let timelock: u64 = env
            .storage()
            .instance()
            .get(&TIMELOCK_DELAY_KEY)
            .unwrap_or(0);
        proposal.cancelled = true;
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);
        extend_proposal_ttl(&env, &(PROPOSAL_KEY, proposal_id), timelock);

        ProposalCancelledEvent {
            proposal_id,
            cancelled_by: caller,
        }
        .publish(&env);
    }

    /// Executes an administrative proposal once signature threshold & timelock criteria are met.
    pub fn execute_admin_action(env: Env, executor: Address, proposal_id: u64) {
        executor.require_auth();
        if !Self::is_admin(env.clone(), executor.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        extend_instance_ttl(&env);

        let mut proposal: AdminProposal =
            match env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id)) {
                Some(p) => p,
                None => soroban_sdk::panic_with_error!(&env, DonationError::ProposalNotFound),
            };
        if proposal.executed {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalAlreadyExecuted);
        }
        if proposal.cancelled {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalCancelled);
        }

        let threshold: u32 = match env.storage().instance().get(&THRESHOLD_KEY) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::NotInitialized),
        };
        if Self::count_current_admin_votes(&env, APPROVAL_KEY, proposal_id) < threshold {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }

        let now = env.ledger().timestamp();
        if now > proposal.expires_at {
            soroban_sdk::panic_with_error!(&env, DonationError::ProposalExpired);
        }
        if now < proposal.eta {
            soroban_sdk::panic_with_error!(&env, DonationError::TimelockNotElapsed);
        }

        match proposal.action.clone() {
            AdminAction::SetExecutor(target) => {
                let old: Option<Address> = env.storage().instance().get(&EXECUTOR_KEY);
                env.storage().instance().set(&EXECUTOR_KEY, &target);
                ExecutorChangedEvent {
                    old_executor: old,
                    new_executor: target,
                }
                .publish(&env);
            }
            AdminAction::SetDonationContract(target) => {
                let old: Option<Address> = env.storage().instance().get(&REGISTRY_KEY);
                env.storage().instance().set(&REGISTRY_KEY, &target);
                RegistryChangedEvent {
                    old_registry: old,
                    new_registry: target,
                }
                .publish(&env);
            }
            // The admin set can change between proposal and execution, so an
            // Add/Remove that would now be a no-op fails instead of being
            // marked executed (#560).
            AdminAction::AddAdmin(new_admin) => {
                let mut admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if Self::contains_address(&admins, &new_admin) {
                    soroban_sdk::panic_with_error!(&env, DonationError::AdminAlreadyExists);
                }
                admins.push_back(new_admin.clone());
                env.storage().instance().set(&ADMINS_KEY, &admins);
                AdminAddedEvent {
                    admin: new_admin,
                    total_admins: admins.len(),
                }
                .publish(&env);
            }
            AdminAction::RemoveAdmin(old_admin) => {
                let admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if !Self::contains_address(&admins, &old_admin) {
                    soroban_sdk::panic_with_error!(&env, DonationError::AdminNotFound);
                }
                let mut new_admins = Vec::new(&env);
                for i in 0..admins.len() {
                    let a = admins.get(i).unwrap();
                    if a != old_admin {
                        new_admins.push_back(a);
                    }
                }
                if new_admins.is_empty() {
                    soroban_sdk::panic_with_error!(&env, DonationError::CannotRemoveAllAdmins);
                }
                let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap();
                if threshold > new_admins.len() {
                    soroban_sdk::panic_with_error!(&env, DonationError::ThresholdExceedsAdmins);
                }
                env.storage().instance().set(&ADMINS_KEY, &new_admins);
                AdminRemovedEvent {
                    admin: old_admin.clone(),
                    total_admins: new_admins.len(),
                }
                .publish(&env);

                // #284: a removed primary admin must lose every privilege
                // the legacy single-admin shortcuts (`set_executor`, token
                // allowlist, donation limits) gate on `ADMIN_KEY`, not just
                // its seat in `ADMINS_KEY`. Reassign `ADMIN_KEY` to the new
                // `admins.get(0)` exactly like `__constructor` picks the
                // initial primary admin, so those shortcuts keep working for
                // *some* current admin on a 1-of-1 deployment instead of
                // being permanently stuck pointing at a removed address.
                let current_primary: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
                if current_primary == old_admin {
                    env.storage()
                        .instance()
                        .set(&ADMIN_KEY, &new_admins.get(0).unwrap());
                }
            }
            AdminAction::SetThreshold(new_threshold) => {
                let admins: Vec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if new_threshold == 0 || new_threshold > admins.len() {
                    soroban_sdk::panic_with_error!(&env, DonationError::InvalidThreshold);
                }
                let old: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(0);
                env.storage().instance().set(&THRESHOLD_KEY, &new_threshold);
                ThresholdChangedEvent {
                    old_threshold: old,
                    new_threshold,
                }
                .publish(&env);
            }
            AdminAction::Pause => {
                env.storage().instance().set(&PAUSED_KEY, &true);
                PauseChangedEvent { paused: true }.publish(&env);
            }
            AdminAction::Unpause => {
                env.storage().instance().set(&PAUSED_KEY, &false);
                PauseChangedEvent { paused: false }.publish(&env);
            }
            AdminAction::AddAllowedToken(token) => {
                Self::set_allowed_token(&env, &token, true);
            }
            AdminAction::RemoveAllowedToken(token) => {
                Self::set_allowed_token(&env, &token, false);
            }
            AdminAction::SetMinDonation(min_amount) => {
                Self::apply_min_donation(&env, min_amount);
            }
            AdminAction::SetMaxDonation(max_amount) => {
                Self::apply_max_donation(&env, max_amount);
            }
        }

        let timelock: u64 = env
            .storage()
            .instance()
            .get(&TIMELOCK_DELAY_KEY)
            .unwrap_or(0);
        proposal.executed = true;
        env.storage()
            .persistent()
            .set(&(PROPOSAL_KEY, proposal_id), &proposal);
        extend_proposal_ttl(&env, &(PROPOSAL_KEY, proposal_id), timelock);

        extend_instance_ttl(&env);
        ProposalExecutedEvent {
            proposal_id,
            executor,
        }
        .publish(&env);
    }

    /// Legacy set_executor entry point. Functions directly when threshold is 1; enforces multi-sig proposals otherwise.
    pub fn set_executor(env: Env, executor: Address) {
        let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(1);
        if threshold == 1 {
            let admin: Address = match env.storage().instance().get(&ADMIN_KEY) {
                Some(a) => a,
                None => soroban_sdk::panic_with_error!(&env, DonationError::NotInitialized),
            };
            admin.require_auth();
            let old: Option<Address> = env.storage().instance().get(&EXECUTOR_KEY);
            env.storage().instance().set(&EXECUTOR_KEY, &executor);
            extend_instance_ttl(&env);
            ExecutorChangedEvent {
                old_executor: old,
                new_executor: executor,
            }
            .publish(&env);
        } else {
            soroban_sdk::panic_with_error!(&env, DonationError::MultiSigRequired);
        }
    }

    /// Cross-contract call: delegates creator registration to the CreatorRegistry contract.
    pub fn register_creator(env: Env, creator: Address, username: String) -> CreatorProfile {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        extend_instance_ttl(&env);
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator, username).into_val(&env);
        let profile = env.invoke_contract(&registry, &Symbol::new(&env, "register_creator"), args);
        extend_instance_ttl(&env);
        profile
    }

    /// Cross-contract call: reads a creator's profile from CreatorRegistry.
    pub fn get_creator(env: Env, creator: Address) -> Option<CreatorProfile> {
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_creator"), args)
    }

    /// Requires `require_auth` from the single primary admin, and panics if
    /// this deployment actually runs a multisig (`threshold > 1`). See
    /// `set_executor` for the pattern this mirrors: on a 1-of-1 deployment
    /// there is no multisig to bypass, so the legacy single-call setters
    /// below stay convenient; once `threshold > 1`, every one of them must
    /// go through `propose_admin_action` / `approve_admin_action` /
    /// `execute_admin_action` instead, or a single compromised or
    /// disagreeing key could unilaterally allowlist an arbitrary token or
    /// choke donations by setting `max_donation` to 1 stroop (#284).
    fn require_single_admin_mode(env: &Env, caller_panic_message: &str) -> Address {
        let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(1);
        assert!(threshold == 1, "{}", caller_panic_message);
        let admin: Address = env
            .storage()
            .instance()
            .get(&ADMIN_KEY)
            .expect("donation contract not initialized");
        admin.require_auth();
        admin
    }

    /// Admin-gated: adds a token address to the allowlist. Direct calls only
    /// work on a single-admin (threshold == 1) deployment — see
    /// `require_single_admin_mode`; otherwise propose `AddAllowedToken`.
    pub fn add_allowed_token(env: Env, token: Address) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the token allowlist",
        );
        Self::set_allowed_token(&env, &token, true);
    }

    /// Admin-gated: removes a token address from the allowlist. Direct calls
    /// only work on a single-admin (threshold == 1) deployment — see
    /// `require_single_admin_mode`; otherwise propose `RemoveAllowedToken`.
    ///
    /// # Effect on existing subscriptions (#465)
    ///
    /// This is an emergency control, so it takes effect immediately for
    /// every existing subscription in `token`, not just new `subscribe`
    /// calls: the next `charge_subscription` for any such subscription fails
    /// with `ChargeError::TokenNotAllowed` instead of silently going through.
    /// The subscription itself is left `active` (not auto-cancelled) — it
    /// simply cannot be charged again until the token is re-added or the
    /// supporter calls `cancel_subscription`. This mirrors `donate`'s own
    /// enforcement: removal is a hard stop, not a one-time gate checked only
    /// at creation.
    pub fn remove_allowed_token(env: Env, token: Address) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the token allowlist",
        );
        Self::set_allowed_token(&env, &token, false);
    }

    /// Shared allowlist mutation for both the legacy direct setters and the
    /// `AddAllowedToken`/`RemoveAllowedToken` `AdminAction` executor arms, so
    /// the storage write, TTL extension, and event are identical regardless
    /// of which path reached it.
    fn set_allowed_token(env: &Env, token: &Address, allowed: bool) {
        if allowed {
            env.storage()
                .instance()
                .set(&(ALLOWED_TOKEN_KEY, token), &true);
        } else {
            env.storage().instance().remove(&(ALLOWED_TOKEN_KEY, token));
        }
        extend_instance_ttl(env);
        AllowedTokenChangedEvent {
            token: token.clone(),
            allowed,
        }
        .publish(env);
    }

    /// Checks if a token is currently in the allowlist.
    pub fn is_token_allowed(env: Env, token: Address) -> bool {
        env.storage().instance().has(&(ALLOWED_TOKEN_KEY, token))
    }

    /// Admin-gated: sets the minimum donation amount guardrail (0 to
    /// disable). Direct calls only work on a single-admin (threshold == 1)
    /// deployment — see `require_single_admin_mode`; otherwise propose
    /// `SetMinDonation`.
    ///
    /// # Effect on existing subscriptions (#465)
    ///
    /// Tightening this bound above an existing subscription's amount makes
    /// its next `charge_subscription` fail with
    /// `ChargeError::AmountOutOfBounds`, the same hard-stop behavior as
    /// `remove_allowed_token` above. The subscription stays `active`; it
    /// simply cannot charge again until the bound is relaxed or the
    /// supporter cancels. `subscribe` itself already rejects a new
    /// subscription below the current minimum, so this only matters for
    /// subscriptions created before the bound was raised.
    pub fn set_min_donation(env: Env, min_amount: i128) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the minimum donation",
        );
        Self::apply_min_donation(&env, min_amount);
    }

    /// Returns the currently configured minimum donation amount (0 if unconstrained).
    pub fn get_min_donation(env: Env) -> i128 {
        env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0)
    }

    /// Admin-gated: sets the sanity-check maximum donation amount guardrail
    /// (0 to disable). Direct calls only work on a single-admin
    /// (threshold == 1) deployment — see `require_single_admin_mode`;
    /// otherwise propose `SetMaxDonation`.
    ///
    /// # Effect on existing subscriptions (#465)
    ///
    /// Same as `set_min_donation` above, mirrored for the upper bound:
    /// lowering this below an existing subscription's amount makes its next
    /// `charge_subscription` fail with `ChargeError::AmountOutOfBounds`
    /// rather than auto-cancelling it.
    pub fn set_max_donation(env: Env, max_amount: i128) {
        Self::require_single_admin_mode(
            &env,
            "multi-sig required: use propose_admin_action to change the maximum donation",
        );
        Self::apply_max_donation(&env, max_amount);
    }

    /// Returns the currently configured maximum donation amount (0 if unconstrained).
    pub fn get_max_donation(env: Env) -> i128 {
        env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0)
    }

    /// Rejects a proposal that is already invalid against current state
    /// (#560), so it fails when proposed instead of after the approvals and
    /// timelock. Execution keeps its own checks (`apply_min_donation`,
    /// `apply_max_donation` and the admin-set arms) because state can change
    /// between proposal and execution.
    fn validate_admin_action(env: &Env, action: &AdminAction) {
        let admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| Vec::new(env));
        match action {
            AdminAction::AddAdmin(new_admin) => {
                if Self::contains_address(&admins, new_admin) {
                    soroban_sdk::panic_with_error!(env, DonationError::AdminAlreadyExists);
                }
            }
            AdminAction::RemoveAdmin(old_admin) => {
                if !Self::contains_address(&admins, old_admin) {
                    soroban_sdk::panic_with_error!(env, DonationError::AdminNotFound);
                }
                let remaining = admins.len() - 1;
                if remaining == 0 {
                    soroban_sdk::panic_with_error!(env, DonationError::CannotRemoveAllAdmins);
                }
                let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap_or(1);
                if threshold > remaining {
                    soroban_sdk::panic_with_error!(env, DonationError::ThresholdExceedsAdmins);
                }
            }
            AdminAction::SetThreshold(new_threshold) => {
                if *new_threshold == 0 || *new_threshold > admins.len() {
                    soroban_sdk::panic_with_error!(env, DonationError::InvalidThreshold);
                }
            }
            AdminAction::SetMinDonation(min_amount) => {
                if *min_amount < 0 {
                    soroban_sdk::panic_with_error!(env, DonationError::InvalidAmount);
                }
                let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
                if max_amount != 0 && *min_amount > max_amount {
                    soroban_sdk::panic_with_error!(env, DonationError::InvalidDonationLimits);
                }
            }
            AdminAction::SetMaxDonation(max_amount) => {
                if *max_amount < 0 {
                    soroban_sdk::panic_with_error!(env, DonationError::InvalidAmount);
                }
                let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
                if *max_amount != 0 && min_amount > *max_amount {
                    soroban_sdk::panic_with_error!(env, DonationError::InvalidDonationLimits);
                }
            }
            AdminAction::SetExecutor(_)
            | AdminAction::SetDonationContract(_)
            | AdminAction::Pause
            | AdminAction::Unpause
            | AdminAction::AddAllowedToken(_)
            | AdminAction::RemoveAllowedToken(_) => {}
        }
    }

    /// Shared min-donation mutation for both the legacy direct setter and
    /// the `SetMinDonation` `AdminAction` executor arm. Validates `min <=
    /// max` whenever both are non-zero (#284), so neither path can leave the
    /// guardrails in a self-contradictory state where no donation could
    /// ever pass both checks.
    fn apply_min_donation(env: &Env, min_amount: i128) {
        assert!(min_amount >= 0, "minimum donation must be non-negative");
        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        assert!(
            max_amount == 0 || min_amount <= max_amount,
            "minimum donation cannot exceed the maximum donation"
        );
        let old_min: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        env.storage().instance().set(&MIN_DONATION_KEY, &min_amount);
        extend_instance_ttl(env);
        MinDonationChangedEvent {
            old_min,
            new_min: min_amount,
        }
        .publish(env);
    }

    /// Shared max-donation mutation for both the legacy direct setter and
    /// the `SetMaxDonation` `AdminAction` executor arm. See
    /// `apply_min_donation` for the `min <= max` invariant this also
    /// enforces.
    fn apply_max_donation(env: &Env, max_amount: i128) {
        assert!(max_amount >= 0, "maximum donation must be non-negative");
        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        assert!(
            max_amount == 0 || min_amount <= max_amount,
            "maximum donation cannot be less than the minimum donation"
        );
        let old_max: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        env.storage().instance().set(&MAX_DONATION_KEY, &max_amount);
        extend_instance_ttl(env);
        MaxDonationChangedEvent {
            old_max,
            new_max: max_amount,
        }
        .publish(env);
    }

    /// Transfer `amount` of `token` from `donor` to `creator`, record the
    /// donation locally, and notify the CreatorRegistry (cross-contract) so
    /// the creator's lifetime stats stay in sync.
    ///
    /// NOTE ON TTL: The donation record is stored with the network's default TTL.
    /// To minimize rent costs on an indefinitely growing append-only log, this
    /// contract does not call `extend_ttl` for old records. They are allowed to expire,
    /// with the backend relying on emitted `DonatedEvent`s for history instead.
    pub fn donate(
        env: Env,
        donor: Address,
        creator: Address,
        token: Address,
        amount: i128,
        memo: String,
    ) -> DonationRecord {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        extend_instance_ttl(&env);
        donor.require_auth();
        if donor == creator {
            soroban_sdk::panic_with_error!(&env, DonationError::SelfDonation);
        }
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidAmount);
        }

        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        if min_amount > 0 && amount < min_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooLow);
        }

        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        if max_amount > 0 && amount > max_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooHigh);
        }

        if memo.len() > MAX_MEMO_LENGTH {
            soroban_sdk::panic_with_error!(&env, DonationError::MemoTooLong);
        }
        if !Self::is_token_allowed(env.clone(), token.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::TokenNotAllowed);
        }

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &creator, &amount);

        let registry = Self::registry_address(&env);
        let record_args: Vec<Val> =
            (env.current_contract_address(), creator.clone(), amount).into_val(&env);
        let (): () = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "record_donation"),
            record_args,
        );

        let donation = DonationRecord {
            donor: donor.clone(),
            creator: creator.clone(),
            amount,
            memo: memo.clone(),
            timestamp: env.ledger().timestamp(),
        };

        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);

        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        let next_counter = match counter.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &next_counter);
        extend_persistent_ttl(&env, &DONATION_COUNTER);

        extend_instance_ttl(&env);
        DonatedEvent {
            donor,
            creator,
            donation_id: counter,
            token,
            amount,
            memo,
            timestamp: env.ledger().timestamp(),
            subscription_id: None,
        }
        .publish(&env);

        donation
    }

    /// Starts a recurring donation.
    pub fn subscribe(
        env: Env,
        supporter: Address,
        creator: Address,
        token: Address,
        amount: i128,
        interval_secs: u64,
    ) -> u64 {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        extend_instance_ttl(&env);
        supporter.require_auth();
        if supporter == creator {
            soroban_sdk::panic_with_error!(&env, DonationError::SelfDonation);
        }
        if amount <= 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidAmount);
        }
        if interval_secs == 0 {
            soroban_sdk::panic_with_error!(&env, DonationError::InvalidInterval);
        }

        // Same min/max donation guardrails `donate` enforces (#465) — a
        // recurring pledge must not be able to start below the minimum or
        // above the maximum any more than a one-off donation can.
        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        if min_amount > 0 && amount < min_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooLow);
        }
        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        if max_amount > 0 && amount > max_amount {
            soroban_sdk::panic_with_error!(&env, DonationError::AmountTooHigh);
        }

        if !Self::is_token_allowed(env.clone(), token.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::TokenNotAllowed);
        }

        let id: u64 = env.storage().persistent().get(&SUB_COUNTER).unwrap_or(0);
        let now = env.ledger().timestamp();
        let next_charge_at = match now.checked_add(interval_secs) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };

        let subscription = Subscription {
            supporter: supporter.clone(),
            creator: creator.clone(),
            token: token.clone(),
            amount,
            interval_secs,
            next_charge_at,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, id), &subscription);
        extend_subscription_ttl(&env, &(SUBSCRIPTIONS_KEY, id), interval_secs);
        let next_id = match id.checked_add(1) {
            Some(next) => next,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage().persistent().set(&SUB_COUNTER, &next_id);
        extend_persistent_ttl(&env, &SUB_COUNTER);

        Self::adjust_committed_amount(&env, &supporter, &token, amount);

        SubscribedEvent {
            supporter,
            creator,
            subscription_id: id,
            token,
            amount,
            interval_secs,
            next_charge_at,
        }
        .publish(&env);

        extend_instance_ttl(&env);
        id
    }

    /// Executes one due charge of a subscription by drawing on the SAC
    /// allowance the supporter granted this contract, then records and
    /// reports it exactly like a one-off `donate`. Callable only by the
    /// authorized executor (see `set_executor`).
    ///
    /// # Observability of a failed charge (#283)
    ///
    /// On `InsufficientAllowance`/`InsufficientBalance`, this publishes
    /// [`SubscriptionChargeFailedEvent`] and then returns `Err(ChargeError)`.
    /// Soroban rolls back *all* state changes and events from an invocation
    /// that returns an `Err` (confirmed by this crate's test snapshots,
    /// which mark that event `failed_call: true`), so the event is only
    /// ever visible in a local simulation's diagnostics, never to an
    /// indexer reading finalized ledgers. Rather than changing this
    /// function's return type to a non-reverting `Ok(Failed(reason))` variant
    /// (a breaking signature change for every caller and the ~15 existing
    /// tests asserting `Err(ChargeError::...)` via `try_charge_subscription`),
    /// the chosen fix keeps the `Err` return and has the backend
    /// (`subscriptionExecutor.ts`) decode the same `ChargeError` discriminant
    /// two other ways that *do* survive: directly from a simulation-time
    /// rejection's error string (`Error(Contract, #<code>)`), and from a
    /// submitted-but-reverted transaction's `diagnosticEventsXdr` (see
    /// `decodeChargeErrorReasonFromDiagnostics`). Both paths yield the exact
    /// same `InsufficientAllowance` vs `InsufficientBalance` distinction this
    /// event would have, without touching the Rust return type.
    pub fn charge_subscription(
        env: Env,
        executor: Address,
        subscription_id: u64,
    ) -> Result<DonationRecord, ChargeError> {
        if Self::is_paused(env.clone()) {
            soroban_sdk::panic_with_error!(&env, DonationError::Paused);
        }
        executor.require_auth();
        let authorized_executor: Address = match env.storage().instance().get(&EXECUTOR_KEY) {
            Some(e) => e,
            None => soroban_sdk::panic_with_error!(&env, DonationError::ExecutorNotSet),
        };
        if executor != authorized_executor {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        extend_instance_ttl(&env);

        let mut subscription: Subscription = match env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
        {
            Some(s) => s,
            None => soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotFound),
        };
        if !subscription.active {
            soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotActive);
        }

        let now = env.ledger().timestamp();
        if now < subscription.next_charge_at {
            soroban_sdk::panic_with_error!(&env, DonationError::NotDue);
        }

        // Re-validate the guardrails `subscribe` checked at creation time
        // (#465): an emergency token removal, or a tightened min/max bound,
        // must stop every future charge of an existing subscription, not
        // just block brand new `subscribe` calls. A subscription created
        // while its amount and token were valid can otherwise keep bypassing
        // whatever changed since.
        if !Self::is_token_allowed(env.clone(), subscription.token.clone()) {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::TokenNotAllowed,
            }
            .publish(&env);
            return Err(ChargeError::TokenNotAllowed);
        }
        let min_amount: i128 = env.storage().instance().get(&MIN_DONATION_KEY).unwrap_or(0);
        let max_amount: i128 = env.storage().instance().get(&MAX_DONATION_KEY).unwrap_or(0);
        let below_min = min_amount > 0 && subscription.amount < min_amount;
        let above_max = max_amount > 0 && subscription.amount > max_amount;
        if below_min || above_max {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::AmountOutOfBounds,
            }
            .publish(&env);
            return Err(ChargeError::AmountOutOfBounds);
        }

        let token_client = token::Client::new(&env, &subscription.token);

        let allowance =
            token_client.allowance(&subscription.supporter, &env.current_contract_address());
        if allowance < subscription.amount {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::InsufficientAllowance,
            }
            .publish(&env);
            return Err(ChargeError::InsufficientAllowance);
        }

        let balance = token_client.balance(&subscription.supporter);
        if balance < subscription.amount {
            SubscriptionChargeFailedEvent {
                supporter: subscription.supporter.clone(),
                creator: subscription.creator.clone(),
                subscription_id,
                reason: ChargeError::InsufficientBalance,
            }
            .publish(&env);
            return Err(ChargeError::InsufficientBalance);
        }

        subscription.next_charge_at = match now.checked_add(subscription.interval_secs) {
            Some(t) => t,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );

        token_client.transfer_from(
            &env.current_contract_address(),
            &subscription.supporter,
            &subscription.creator,
            &subscription.amount,
        );

        let registry = Self::registry_address(&env);
        let record_args: Vec<Val> = (
            env.current_contract_address(),
            subscription.creator.clone(),
            subscription.amount,
        )
            .into_val(&env);
        let (): () = env.invoke_contract(
            &registry,
            &Symbol::new(&env, "record_donation"),
            record_args,
        );

        let memo = String::from_str(&env, "recurring");
        let donation = DonationRecord {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            amount: subscription.amount,
            memo: memo.clone(),
            timestamp: now,
        };

        let counter: u32 = env
            .storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0);
        env.storage()
            .persistent()
            .set(&(DONATIONS_KEY, counter), &donation);
        let next_counter = match counter.checked_add(1) {
            Some(c) => c,
            None => soroban_sdk::panic_with_error!(&env, DonationError::Overflow),
        };
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &next_counter);
        extend_persistent_ttl(&env, &DONATION_COUNTER);

        DonatedEvent {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            donation_id: counter,
            token: subscription.token.clone(),
            amount: subscription.amount,
            memo,
            timestamp: now,
            subscription_id: Some(subscription_id),
        }
        .publish(&env);

        extend_instance_ttl(&env);
        Ok(donation)
    }

    /// Cancels a subscription and subtracts its committed amount from the
    /// supporter's shared SAC allowance for this token, clamping at zero.
    ///
    /// A positive remainder is approved through the current ledger plus the
    /// cancelled subscription's TTL bump. The SAC exposes only the allowance
    /// amount, so this can shorten or lengthen the previous expiry. The
    /// `sub_allowance_updated` event reports the replacement expiry so clients
    /// can warn supporters and offer to re-approve through their desired ledger.
    pub fn cancel_subscription(env: Env, supporter: Address, subscription_id: u64) {
        supporter.require_auth();

        let mut subscription: Subscription = match env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
        {
            Some(s) => s,
            None => soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotFound),
        };
        if subscription.supporter != supporter {
            soroban_sdk::panic_with_error!(&env, DonationError::Unauthorized);
        }
        if !subscription.active {
            soroban_sdk::panic_with_error!(&env, DonationError::SubscriptionNotActive);
        }
        extend_instance_ttl(&env);

        subscription.active = false;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );

        Self::adjust_committed_amount(&env, &supporter, &subscription.token, -subscription.amount);

        let token_client = token::Client::new(&env, &subscription.token);
        let current_allowance = token_client.allowance(&supporter, &env.current_contract_address());
        let reduced_allowance = (current_allowance - subscription.amount).max(0);
        let expiration_ledger = if reduced_allowance > 0 {
            let bump_ledgers = common::subscription_bump_amount(subscription.interval_secs);
            env.ledger().sequence().saturating_add(bump_ledgers)
        } else {
            0
        };
        token_client.approve(
            &supporter,
            &env.current_contract_address(),
            &reduced_allowance,
            &expiration_ledger,
        );

        if reduced_allowance > 0 {
            SubscriptionAllowanceEvent {
                supporter: supporter.clone(),
                token: subscription.token,
                subscription_id,
                live_until_ledger: expiration_ledger,
            }
            .publish(&env);
        }

        SubscriptionCancelledEvent {
            supporter,
            creator: subscription.creator,
            subscription_id,
        }
        .publish(&env);
    }

    /// Adjusts the supporter's tracked committed-amount counter for `token`
    /// by `delta` (positive on `subscribe`, negative on `cancel_subscription`),
    /// clamped at zero. See `COMMITTED_KEY` and `cancel_subscription`'s doc
    /// comment for why this tracking exists.
    fn adjust_committed_amount(env: &Env, supporter: &Address, token: &Address, delta: i128) {
        let key = (COMMITTED_KEY, supporter.clone(), token.clone());
        let current: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        let updated = (current + delta).max(0);
        env.storage().persistent().set(&key, &updated);
        extend_persistent_ttl(env, &key);
    }

    /// Returns the supporter's currently committed amount (sum of active
    /// subscription amounts) for `token`. Used by tests and available to the
    /// frontend/backend to compute how much allowance headroom is still
    /// needed before approving a new subscription.
    pub fn get_committed_amount(env: Env, supporter: Address, token: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&(COMMITTED_KEY, supporter, token))
            .unwrap_or(0)
    }

    /// Permissionless keep-alive for a subscription entry. Intervals longer
    /// than the maximum extension (e.g. annual) outlive a single bump, so the
    /// backend executor should call this between charges. Only extends the TTL
    /// (and only once it has dropped below the threshold); it changes no
    /// subscription data and moves no funds.
    pub fn bump_subscription(env: Env, subscription_id: u64) {
        extend_instance_ttl(&env);
        let subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        extend_subscription_ttl(
            &env,
            &(SUBSCRIPTIONS_KEY, subscription_id),
            subscription.interval_secs,
        );
    }

    /// Fetch a subscription by its ID.
    pub fn get_subscription(env: Env, subscription_id: u64) -> Option<Subscription> {
        env.storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
    }

    /// Cross-contract call: updates a creator's funding goal in the CreatorRegistry.
    pub fn set_goal(env: Env, creator: Address, goal_amount: i128) {
        creator.require_auth();
        extend_instance_ttl(&env);
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator, goal_amount).into_val(&env);
        let (): () = env.invoke_contract(&registry, &Symbol::new(&env, "set_goal"), args);
    }

    /// Cross-contract call: reads a creator's funding goal from CreatorRegistry.
    pub fn get_goal(env: Env, creator: Address) -> Option<i128> {
        let registry = Self::registry_address(&env);
        let args: Vec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_goal"), args)
    }

    /// Get all donations count (approximate, stored in counter)
    ///
    /// NOTE ON STORAGE GROWTH & TTL: The donations log is an append-only structure.
    /// It grows indefinitely, which means state rent accumulates over time.
    /// To avoid unbounded rent costs for the contract, we do not explicitly extend
    /// the TTL of old donation records. If old records expire due to un-extended
    /// TTLs, this function's counter remains valid, but `get_donation` may fail
    /// to find them. This is an accepted tradeoff since the emitted `DonatedEvent`s
    /// (indexed off-chain) are the canonical long-term record.
    pub fn get_total_donations_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0)
    }

    /// Fetch a single donation record by its counter-based index.
    ///
    /// NOTE: Donation records are subject to Soroban's state expiry.
    /// Because the on-chain donation log is append-only and grows indefinitely,
    /// the contract does not explicitly extend the TTL of these records to save
    /// on state rent. If a record has expired, this function will return `None`.
    /// Downstream applications should rely on off-chain indexed `DonatedEvent`s
    /// as the canonical historical record, rather than depending on this function
    /// for long-term historical data.
    pub fn get_donation(env: Env, index: u32) -> Option<DonationRecord> {
        env.storage().persistent().get(&(DONATIONS_KEY, index))
    }

    /// Fetch proposal by proposal_id.
    pub fn get_proposal(env: Env, proposal_id: u64) -> Option<AdminProposal> {
        env.storage().persistent().get(&(PROPOSAL_KEY, proposal_id))
    }

    fn registry_address(env: &Env) -> Address {
        env.storage()
            .instance()
            .get(&REGISTRY_KEY)
            .expect("donation contract not initialized")
    }

    fn contains_address(vec: &Vec<Address>, target: &Address) -> bool {
        for i in 0..vec.len() {
            if vec.get(i).unwrap() == *target {
                return true;
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    extern crate std;

    use super::*;
    use creator_registry::{CreatorRegistryContract, CreatorRegistryContractClient};
    use soroban_sdk::events::Event as _;
    use soroban_sdk::testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Events as _, Ledger,
    };
    use soroban_sdk::token::StellarAssetClient;

    fn instance_ttl(env: &Env, contract: &Address) -> u32 {
        env.as_contract(contract, || env.storage().instance().get_ttl())
    }

    fn persistent_ttl<K: IntoVal<Env, Val>>(env: &Env, contract: &Address, key: &K) -> u32 {
        env.as_contract(contract, || env.storage().persistent().get_ttl(key))
    }

    fn create_token_contract(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    fn deploy_pair(
        env: &Env,
        admins: Vec<Address>,
        threshold: u32,
        timelock_delay: u64,
    ) -> (
        DonationContractClient<'_>,
        CreatorRegistryContractClient<'_>,
    ) {
        let registry_id = Address::generate(env);
        let donation_id = env.register(
            DonationContract,
            (
                admins.clone(),
                threshold,
                timelock_delay,
                registry_id.clone(),
            ),
        );
        env.register_at(
            &registry_id,
            CreatorRegistryContract,
            (admins, threshold, timelock_delay, donation_id.clone()),
        );
        (
            DonationContractClient::new(env, &donation_id),
            CreatorRegistryContractClient::new(env, &registry_id),
        )
    }

    fn setup(
        env: &Env,
    ) -> (
        Address,
        DonationContractClient<'_>,
        CreatorRegistryContractClient<'_>,
    ) {
        let admin = Address::generate(env);
        let (donation_client, registry_client) =
            deploy_pair(env, Vec::from_array(env, [admin.clone()]), 1, 0);
        (admin, donation_client, registry_client)
    }

    fn lower_instance_ttl(env: &Env) {
        env.ledger().with_mut(|li| {
            li.sequence_number +=
                common::INSTANCE_BUMP_AMOUNT - common::INSTANCE_LIFETIME_THRESHOLD + 1
        });
    }

    fn assert_instance_ttl_is_low(env: &Env, contract: &Address) {
        assert!(instance_ttl(env, contract) < common::INSTANCE_LIFETIME_THRESHOLD);
    }

    fn assert_instance_ttl_was_extended(env: &Env, contract: &Address) {
        assert_eq!(instance_ttl(env, contract), common::INSTANCE_BUMP_AMOUNT);
    }

    #[test]
    fn test_constructor_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin = Address::generate(&env);
        let registry = Address::generate(&env);
        let contract_id = env.register(
            DonationContract,
            (Vec::from_array(&env, [admin]), 1u32, 0u64, registry),
        );

        assert_instance_ttl_was_extended(&env, &contract_id);
    }

    #[test]
    fn test_register_creator_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);
        let creator = Address::generate(&env);

        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"ttl_creator"));

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_donate_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &100);

        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, b"ttl"),
        );

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_subscribe_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.subscribe(&supporter, &creator, &token_address, &100, &1_000);

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_charge_subscription_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &100, &1_000);
        token::Client::new(&env, &token_address).approve(
            &supporter,
            &donation_client.address,
            &100,
            &100_000,
        );
        env.ledger().with_mut(|li| li.timestamp = 1_000);

        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.charge_subscription(&executor, &id);

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_propose_admin_action_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.propose_admin_action(&admin, &AdminAction::Pause);

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_approve_admin_action_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admins = Vec::from_array(&env, [admin1.clone(), admin2.clone()]);
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);
        let proposal_id = donation_client.propose_admin_action(&admin1, &AdminAction::Pause);

        env.as_contract(&donation_client.address, || {
            common::extend_persistent_ttl(&env, &(PROPOSAL_KEY, proposal_id));
        });
        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.approve_admin_action(&admin2, &proposal_id);

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_execute_admin_action_extends_instance_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let proposal_id = donation_client.propose_admin_action(&admin, &AdminAction::Pause);

        env.as_contract(&donation_client.address, || {
            common::extend_persistent_ttl(&env, &(PROPOSAL_KEY, proposal_id));
            common::extend_persistent_ttl(&env, &(APPROVAL_KEY, proposal_id, admin.clone()));
        });
        lower_instance_ttl(&env);
        assert_instance_ttl_is_low(&env, &donation_client.address);

        donation_client.execute_admin_action(&admin, &proposal_id);

        assert_instance_ttl_was_extended(&env, &donation_client.address);
    }

    #[test]
    fn test_register_creator_via_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let profile =
            donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        assert_eq!(profile.donation_count, 0);
        assert_eq!(profile.total_donations, 0);
    }

    #[test]
    fn test_multisig_proposal_approval_execution_flow() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let executor = Address::generate(&env);

        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());

        // 2-of-3 threshold with 100 seconds timelock delay
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 100);

        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::SetExecutor(executor.clone()));

        let prop = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop.approvals_count, 1);
        assert!(!prop.executed);

        donation_client.approve_admin_action(&admin2, &prop_id);

        let prop2 = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop2.approvals_count, 2);

        // Timelock has not elapsed yet (timestamp 0 < eta 100)
        env.ledger().with_mut(|li| li.timestamp = 150);

        donation_client.execute_admin_action(&admin1, &prop_id);

        let prop_exec = donation_client.get_proposal(&prop_id).unwrap();
        assert!(prop_exec.executed);
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        assert!(!donation_client.is_paused());
        donation_client.emergency_pause(&admin);
        assert!(donation_client.is_paused());
    }

    #[test]
    fn test_donate_updates_registry_cross_contract() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        env.ledger().with_mut(|li| li.sequence_number = 100);

        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

        let donation = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"Great work!"),
        );

        assert_eq!(donation.amount, 1000);
        assert_eq!(donation.donor, donor);
        assert_eq!(donation.creator, creator);
        assert_eq!(donation.memo, String::from_bytes(&env, b"Great work!"));
        assert_eq!(
            donation_client.get_donation(&0).unwrap().memo,
            donation.memo
        );

        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&creator), 1000);
        assert_eq!(token_client.balance(&donor), 9_000);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 1000);
        assert_eq!(stats.donation_count, 1);

        // And the donation contract's own view of the registry agrees.
        let stats_via_donation = donation_client.get_creator(&creator).unwrap();
        assert_eq!(stats_via_donation.total_donations, 1000);
    }

    #[test]
    fn test_donate_without_prior_registration_creates_profile() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &5_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &250,
            &String::from_bytes(&env, b"First!"),
        );

        assert!(registry_client.get_creator(&creator).is_none());

        donation_client.register_creator(&creator, &String::from_bytes(&env, b"new_dev"));

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 250);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    fn test_donate_rejects_non_positive_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &0,
            &String::from_bytes(&env, b"nope"),
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidAmount.into()
        );
    }

    #[test]
    #[should_panic]
    fn test_donate_rejects_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &1000,
            &String::from_bytes(&env, b"too much"),
        );
    }

    #[test]
    fn test_donate_rejects_oversized_memo() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);
        let oversized_memo = [b'x'; MAX_MEMO_LENGTH as usize + 1];

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, &oversized_memo),
        );
        assert_eq!(res.unwrap_err().unwrap(), DonationError::MemoTooLong.into());
    }

    #[test]
    fn test_multiple_donations_increment_counter_and_history() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, b"one"),
        );
        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &200,
            &String::from_bytes(&env, b"two"),
        );

        assert_eq!(donation_client.get_total_donations_count(), 2);
        assert_eq!(donation_client.get_donation(&0).unwrap().amount, 100);
        assert_eq!(donation_client.get_donation(&1).unwrap().amount, 200);
    }

    #[test]
    fn test_subscribe_records_schedule() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let id = donation_client.subscribe(&supporter, &creator, &token_address, &100, &2_592_000);
        let subscription = donation_client.get_subscription(&id).unwrap();

        assert_eq!(subscription.supporter, supporter);
        assert_eq!(subscription.creator, creator);
        assert_eq!(subscription.amount, 100);
        assert_eq!(subscription.interval_secs, 2_592_000);
        assert_eq!(subscription.next_charge_at, 1_000 + 2_592_000);
        assert!(subscription.active);
    }

    #[test]
    fn test_charge_subscription_draws_allowance_and_updates_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"dev"));

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id);

        assert_eq!(donation.amount, 500);
        assert_eq!(donation.donor, supporter);
        assert_eq!(token_client.balance(&creator), 500);
        assert_eq!(token_client.balance(&supporter), 9_500);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 500);
        assert_eq!(stats.donation_count, 1);

        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 2_000 + 1_000);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_unauthorized_executor() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let impostor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        donation_client.charge_subscription(&impostor, &id);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_before_due() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Still at timestamp 1_000, next_charge_at is 2_000 — too early.
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_cancel_subscription_deactivates_and_revokes_allowance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            500
        );

        donation_client.cancel_subscription(&supporter, &id);

        assert!(!donation_client.get_subscription(&id).unwrap().active);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            0
        );
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_cancelled() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        donation_client.cancel_subscription(&supporter, &id);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_set_and_get_creator_goal_cross_contract() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        assert_eq!(donation_client.get_goal(&creator), None);

        donation_client.set_goal(&creator, &2500);
        assert_eq!(donation_client.get_goal(&creator), Some(2500));
    }

    #[test]
    fn test_donate_rejects_unallowed_token() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = env.register_stellar_asset_contract_v2(admin).address();
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        let res = donation_client.try_donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, b"should fail"),
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::TokenNotAllowed.into()
        );
    }

    #[test]
    fn test_subscribe_rejects_unallowed_token() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);

        let token_address = env.register_stellar_asset_contract_v2(admin).address();

        env.ledger().with_mut(|li| li.timestamp = 1_000);

        let res =
            donation_client.try_subscribe(&supporter, &creator, &token_address, &100, &2_592_000);
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::TokenNotAllowed.into()
        );
    }

    #[test]
    fn test_charge_subscription_insufficient_allowance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        // Approve less than the required amount
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &100, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);

        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientAllowance
        );
    }

    #[test]
    fn test_charge_error_discriminants_are_stable_for_backend_decoding() {
        // #283: the backend decodes these exact numeric codes out of
        // `Error(Contract, #<code>)` text in a simulation error or a failed
        // transaction's diagnostic events (see subscriptionExecutor.ts's
        // `decodeChargeErrorReason`/`decodeChargeErrorReasonFromDiagnostics`).
        // Changing either discriminant without updating that backend mapping
        // would silently break the allowance-vs-balance distinction, so this
        // pins them down as a regression guard.
        assert_eq!(ChargeError::InsufficientAllowance as u32, 1);
        assert_eq!(ChargeError::InsufficientBalance as u32, 2);
        assert_eq!(ChargeError::TokenNotAllowed as u32, 3);
        assert_eq!(ChargeError::AmountOutOfBounds as u32, 4);
    }

    #[test]
    fn test_charge_subscription_insufficient_balance() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        // Mint less than the required amount
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        // Approve enough allowance
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &1000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);

        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientBalance
        );
    }

    // --- charge_subscription edge cases ---------------------------------

    /// Registers a token, mints `balance` to the supporter, sets an executor and
    /// creates a 500-per-1_000s subscription at t=1_000 with `allowance` approved.
    fn subscription_fixture(
        env: &Env,
        balance: i128,
        allowance: i128,
    ) -> (
        Address,
        DonationContractClient<'_>,
        Address,
        Address,
        Address,
        Address,
        u64,
    ) {
        let (admin, donation_client, _registry_client) = setup(env);
        let supporter = Address::generate(env);
        let creator = Address::generate(env);
        let executor = Address::generate(env);
        let token_address = create_token_contract(env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(env, &token_address).mint(&supporter, &balance);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        token::Client::new(env, &token_address).approve(
            &supporter,
            &donation_client.address,
            &allowance,
            &1_000,
        );
        (
            admin,
            donation_client,
            supporter,
            creator,
            executor,
            token_address,
            id,
        )
    }

    #[test]
    fn test_charge_subscription_succeeds_exactly_at_due_time() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        // next_charge_at is 1_000 + 1_000; a charge at exactly that timestamp is due.
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);

        assert_eq!(
            token::Client::new(&env, &token_address).balance(&creator),
            500
        );
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_cannot_charge_twice_in_one_period() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
        // Same ledger time: the schedule has moved to 3_000, so this must be rejected.
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_charge_subscription_late_charge_reschedules_from_now() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 500);

        // Executor is 5_000s late (due at 2_000); the next charge is measured
        // from the actual charge time, so missed periods are not back-charged.
        env.ledger().with_mut(|li| li.timestamp = 7_000);
        donation_client.charge_subscription(&executor, &id);

        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 7_000 + 1_000);
        assert!(subscription.active);
    }

    #[test]
    fn test_charge_subscription_failed_charge_leaves_schedule_and_balances_unchanged() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 100);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientAllowance
        );

        // A failed attempt must not advance the schedule, so it can be retried
        // as soon as the supporter fixes their allowance.
        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.next_charge_at, 2_000);
        assert!(subscription.active);
        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&supporter), 10_000);
        assert_eq!(token_client.balance(&creator), 0);
    }

    #[test]
    fn test_charge_subscription_retry_succeeds_after_allowance_topped_up() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, creator, executor, token_address, id) =
            subscription_fixture(&env, 10_000, 100);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        assert!(donation_client
            .try_charge_subscription(&executor, &id)
            .is_err());

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);
        donation_client.charge_subscription(&executor, &id);

        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_unknown_subscription() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _supporter, _creator, executor, _token, _id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.charge_subscription(&executor, &999);
    }

    #[test]
    #[should_panic]
    fn test_charge_subscription_rejects_while_paused() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _supporter, _creator, executor, _token, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.emergency_pause(&admin);
        env.ledger().with_mut(|li| li.timestamp = 2_000);
        donation_client.charge_subscription(&executor, &id);
    }

    #[test]
    fn test_subscribe_rejects_zero_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &0,
            &1_000,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidAmount.into()
        );
    }

    #[test]
    fn test_subscribe_rejects_zero_interval() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &500,
            &0,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::InvalidInterval.into()
        );
    }

    // ── #465: subscribe/charge_subscription guardrail parity with donate ──

    #[test]
    fn test_subscribe_rejects_amount_below_min_donation() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.set_min_donation(&200);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &100,
            &1_000,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::AmountTooLow.into()
        );
    }

    #[test]
    fn test_subscribe_rejects_amount_above_max_donation() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.set_max_donation(&100);

        let res = donation_client.try_subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &500,
            &1_000,
        );
        assert_eq!(
            res.unwrap_err().unwrap(),
            DonationError::AmountTooHigh.into()
        );
    }

    #[test]
    fn test_subscribe_allows_amount_within_min_max_bounds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.set_min_donation(&100);
        donation_client.set_max_donation(&1_000);

        let id = donation_client.subscribe(
            &Address::generate(&env),
            &Address::generate(&env),
            &token_address,
            &500,
            &1_000,
        );
        let subscription = donation_client.get_subscription(&id).unwrap();
        assert_eq!(subscription.amount, 500);
    }

    #[test]
    fn test_charge_subscription_fails_after_token_removed_from_allowlist() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Emergency removal happens AFTER the subscription was created with
        // a then-valid token.
        donation_client.remove_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(result.unwrap_err().unwrap(), ChargeError::TokenNotAllowed);

        // The subscription itself is left active (not auto-cancelled), and
        // no funds moved.
        let subscription = donation_client.get_subscription(&id).unwrap();
        assert!(subscription.active);
        assert_eq!(token_client.balance(&supporter), 10_000);
        assert_eq!(token_client.balance(&creator), 0);
    }

    #[test]
    fn test_charge_subscription_fails_when_amount_falls_below_tightened_min() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        // Valid at creation time: no min set yet.
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Admin raises the minimum above this subscription's amount.
        donation_client.set_min_donation(&600);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(result.unwrap_err().unwrap(), ChargeError::AmountOutOfBounds);
    }

    #[test]
    fn test_charge_subscription_fails_when_amount_exceeds_tightened_max() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        // Admin lowers the maximum below this subscription's amount.
        donation_client.set_max_donation(&400);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(result.unwrap_err().unwrap(), ChargeError::AmountOutOfBounds);
    }

    #[test]
    fn test_charge_subscription_succeeds_when_still_within_bounds_and_allowed() {
        // Regression guard: the new guardrail re-checks in
        // charge_subscription must not break the ordinary, unmodified-limits
        // charge path already covered by
        // test_charge_subscription_draws_allowance_and_updates_registry.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.set_min_donation(&100);
        donation_client.set_max_donation(&1_000);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);

        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id);
        assert_eq!(donation.amount, 500);
        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    fn test_cancel_subscription_does_not_break_other_active_subscriptions_same_token() {
        // #282: supporter subscribes to two creators in the same token;
        // cancelling one must not zero out the allowance backing the other.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);
        let supporter = Address::generate(&env);
        let creator_a = Address::generate(&env);
        let creator_b = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.set_executor(&executor);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let id_a = donation_client.subscribe(&supporter, &creator_a, &token_address, &500, &1_000);
        let id_b = donation_client.subscribe(&supporter, &creator_b, &token_address, &300, &1_000);

        // One shared allowance covering both subscriptions' combined need.
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &800, &1_000_000);

        donation_client.cancel_subscription(&supporter, &id_a);

        // The shared allowance should be reduced only by subscription A's
        // amount (500), leaving 300 — exactly what B still needs — instead
        // of being zeroed out.
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            300
        );

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let donation = donation_client.charge_subscription(&executor, &id_b);
        assert_eq!(donation.amount, 300);
        assert_eq!(token_client.balance(&creator_b), 300);
    }

    #[test]
    fn test_partial_cancel_replaces_a_long_allowance_expiry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let interval = 1_000;
        let cancelled_at = 100;
        let replacement_expiry = cancelled_at + common::subscription_bump_amount(interval);
        let original_expiry = replacement_expiry + 1_000;
        env.ledger().with_mut(|li| {
            li.timestamp = 1_000;
            li.sequence_number = cancelled_at;
            // Keep the SAC instance live when we advance past the new allowance expiry.
            li.min_persistent_entry_ttl = original_expiry;
            li.max_entry_ttl = original_expiry + 1_000;
        });

        let (admin, donation_client, _registry_client) = setup(&env);
        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        let token_client = token::Client::new(&env, &token_address);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &interval);
        donation_client.subscribe(
            &supporter,
            &Address::generate(&env),
            &token_address,
            &300,
            &interval,
        );
        token_client.approve(&supporter, &donation_client.address, &800, &original_expiry);

        donation_client.cancel_subscription(&supporter, &id);

        assert_eq!(
            env.events()
                .all()
                .filter_by_contract(&donation_client.address),
            [
                SubscriptionAllowanceEvent {
                    supporter: supporter.clone(),
                    token: token_address,
                    subscription_id: id,
                    live_until_ledger: replacement_expiry,
                }
                .to_xdr(&env, &donation_client.address),
                SubscriptionCancelledEvent {
                    supporter: supporter.clone(),
                    creator,
                    subscription_id: id,
                }
                .to_xdr(&env, &donation_client.address),
            ]
        );

        env.ledger()
            .with_mut(|li| li.sequence_number = replacement_expiry);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            300
        );
        env.ledger()
            .with_mut(|li| li.sequence_number = replacement_expiry + 1);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            0
        );
    }

    #[test]
    fn test_cancel_subscription_zeroes_allowance_when_no_siblings_remain() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, _creator, _executor, token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.cancel_subscription(&supporter, &id);

        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(
            token_client.allowance(&supporter, &donation_client.address),
            0
        );
    }

    #[test]
    #[should_panic]
    fn test_cancel_subscription_rejects_double_cancel() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, supporter, _creator, _executor, _token_address, id) =
            subscription_fixture(&env, 10_000, 500);

        donation_client.cancel_subscription(&supporter, &id);
        donation_client.cancel_subscription(&supporter, &id);
    }

    // =========================================================================
    // Property-Based & Invariant Fuzz Tests (#46)
    // =========================================================================

    #[test]
    fn property_test_total_donations_equals_sum_of_individual_donations() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"prop_creator"));

        // Multi-batch donation sequences
        let sequences: [&[i128]; 4] = [
            &[100, 250, 50, 1000, 5],
            &[1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
            &[500_000, 250_000, 1_000_000],
            &[10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
        ];

        let mut cumulative_sum = 0i128;
        let mut cumulative_count = 0u32;

        for seq in sequences {
            let needed: i128 = seq.iter().sum();
            StellarAssetClient::new(&env, &token_address).mint(&donor, &needed);

            for &amount in seq {
                let record = donation_client.donate(
                    &donor,
                    &creator,
                    &token_address,
                    &amount,
                    &String::from_bytes(&env, b"fuzz"),
                );
                assert_eq!(record.amount, amount);
                cumulative_sum += amount;
                cumulative_count += 1;

                let stats = registry_client.get_creator(&creator).unwrap();
                assert_eq!(stats.total_donations, cumulative_sum);
                assert_eq!(stats.donation_count, cumulative_count);
            }
        }
    }

    #[test]
    fn property_test_token_balance_conservation_invariant() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        let amounts = [42i128, 999, 15_000, 1, 750];
        let total: i128 = amounts.iter().sum();
        let initial_donor_balance = total + 5_000;

        StellarAssetClient::new(&env, &token_address).mint(&donor, &initial_donor_balance);
        let token_client = token::Client::new(&env, &token_address);

        assert_eq!(token_client.balance(&donor), initial_donor_balance);
        assert_eq!(token_client.balance(&creator), 0);
        assert_eq!(token_client.balance(&donation_client.address), 0);

        let mut donated_so_far = 0i128;
        for &amt in &amounts {
            let record = donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &amt,
                &String::from_bytes(&env, b"conservation"),
            );
            donated_so_far += amt;

            // Invariant 1: the stored record matches the donation exactly.
            // There is no fee: the creator receives the full amount, so the
            // record amount must equal the amount just donated.
            assert_eq!(record.amount, amt);

            // Invariant 3: Balances update exactly by transferred amount
            assert_eq!(
                token_client.balance(&donor),
                initial_donor_balance - donated_so_far
            );
            assert_eq!(token_client.balance(&creator), donated_so_far);
            // Invariant 4: No funds trapped in contract
            assert_eq!(token_client.balance(&donation_client.address), 0);
        }
    }

    #[test]
    fn property_test_unauthorized_callers_cannot_modify_config() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);
        // Drop the mocked auths so the privileged calls below run unauthorized.
        env.set_auths(&[]);

        let _unauthorized_caller = Address::generate(&env);
        let random_token = Address::generate(&env);
        let random_executor = Address::generate(&env);

        // Without mock_all_auths on the unauthorized caller, privileged calls must fail
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.add_allowed_token(&random_token);
        }))
        .is_err());

        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.set_executor(&random_executor);
        }))
        .is_err());

        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.emergency_pause(&_unauthorized_caller);
        }))
        .is_err());
    }

    // =========================================================================
    // #284: multisig gating for the token allowlist and donation limits
    // =========================================================================

    #[test]
    #[should_panic(expected = "multi-sig required")]
    fn test_add_allowed_token_rejects_direct_call_under_multisig() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());
        // 2-of-3 threshold: a single admin must not be able to bypass it.
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        donation_client.add_allowed_token(&Address::generate(&env));
    }

    #[test]
    #[should_panic(expected = "multi-sig required")]
    fn test_set_max_donation_rejects_direct_call_under_multisig() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        donation_client.set_max_donation(&1);
    }

    #[test]
    fn test_add_allowed_token_via_multisig_proposal_succeeds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        let token = Address::generate(&env);
        assert!(!donation_client.is_token_allowed(&token));

        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::AddAllowedToken(token.clone()));
        donation_client.approve_admin_action(&admin2, &prop_id);
        donation_client.execute_admin_action(&admin1, &prop_id);

        assert!(donation_client.is_token_allowed(&token));
    }

    #[test]
    fn test_set_min_and_max_donation_via_multisig_proposal() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        let max_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetMaxDonation(1_000));
        donation_client.approve_admin_action(&admin2, &max_prop);
        donation_client.execute_admin_action(&admin1, &max_prop);
        assert_eq!(donation_client.get_max_donation(), 1_000);

        let min_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetMinDonation(10));
        donation_client.approve_admin_action(&admin2, &min_prop);
        donation_client.execute_admin_action(&admin1, &min_prop);
        assert_eq!(donation_client.get_min_donation(), 10);
    }

    #[test]
    #[should_panic(expected = "minimum donation cannot exceed the maximum donation")]
    fn test_set_min_donation_rejects_min_above_existing_max() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        donation_client.set_max_donation(&100);
        donation_client.set_min_donation(&200);
    }

    #[test]
    #[should_panic(expected = "maximum donation cannot be less than the minimum donation")]
    fn test_set_max_donation_rejects_max_below_existing_min() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        donation_client.set_min_donation(&200);
        donation_client.set_max_donation(&100);
    }

    // ------------------------------------------------------------------
    // Proposal-time validation (#560)
    // ------------------------------------------------------------------

    /// Deploys the pair with `n` generated admins, `threshold` and no
    /// timelock. Returns (donation client, admins).
    fn deploy_with_admins(
        env: &Env,
        n: u32,
        threshold: u32,
    ) -> (DonationContractClient<'_>, Vec<Address>) {
        let mut admins = Vec::new(env);
        for _ in 0..n {
            admins.push_back(Address::generate(env));
        }
        let (donation_client, _registry_client) = deploy_pair(env, admins.clone(), threshold, 0);
        (donation_client, admins)
    }

    #[test]
    fn test_propose_rejects_invalid_admin_actions_with_typed_errors() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admins) = deploy_with_admins(&env, 2, 2);
        let proposer = admins.get(0).unwrap();

        let cases = [
            (
                AdminAction::SetThreshold(0),
                DonationError::InvalidThreshold,
            ),
            (
                AdminAction::SetThreshold(3),
                DonationError::InvalidThreshold,
            ),
            (
                AdminAction::AddAdmin(admins.get(1).unwrap()),
                DonationError::AdminAlreadyExists,
            ),
            (
                AdminAction::RemoveAdmin(Address::generate(&env)),
                DonationError::AdminNotFound,
            ),
            // 2-of-2: removing either admin would leave 1 admin below the threshold.
            (
                AdminAction::RemoveAdmin(admins.get(1).unwrap()),
                DonationError::ThresholdExceedsAdmins,
            ),
            (
                AdminAction::SetMinDonation(-1),
                DonationError::InvalidAmount,
            ),
            (
                AdminAction::SetMaxDonation(-1),
                DonationError::InvalidAmount,
            ),
        ];
        for (action, error) in cases {
            assert_eq!(
                client.try_propose_admin_action(&proposer, &action),
                Err(Ok(error.into()))
            );
        }

        // Nothing was stored: the next valid proposal still gets id 0.
        assert!(client.get_proposal(&0).is_none());
        assert_eq!(
            client.propose_admin_action(&proposer, &AdminAction::SetThreshold(1)),
            0
        );
    }

    #[test]
    fn test_propose_rejects_removing_the_last_admin() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, client, _registry_client) = setup(&env);

        assert_eq!(
            client.try_propose_admin_action(&admin, &AdminAction::RemoveAdmin(admin.clone())),
            Err(Ok(DonationError::CannotRemoveAllAdmins.into()))
        );
    }

    #[test]
    fn test_propose_checks_donation_limits_against_current_bounds() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, client, _registry_client) = setup(&env);
        client.set_max_donation(&1_000);
        client.set_min_donation(&10);

        for action in [
            AdminAction::SetMinDonation(1_001),
            AdminAction::SetMaxDonation(9),
        ] {
            assert_eq!(
                client.try_propose_admin_action(&admin, &action),
                Err(Ok(DonationError::InvalidDonationLimits.into()))
            );
        }

        // Equal bounds and zero (which disables a bound) are still allowed.
        let valid = [
            AdminAction::SetMinDonation(1_000),
            AdminAction::SetMaxDonation(10),
            AdminAction::SetMaxDonation(0),
            AdminAction::SetMinDonation(0),
        ];
        for (expected_id, action) in (0u64..).zip(valid) {
            assert_eq!(client.propose_admin_action(&admin, &action), expected_id);
        }
    }

    #[test]
    fn test_propose_accepts_admin_actions_at_the_limits() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admins) = deploy_with_admins(&env, 3, 1);
        let proposer = admins.get(0).unwrap();

        let valid = [
            AdminAction::SetThreshold(1),
            AdminAction::SetThreshold(3),
            AdminAction::AddAdmin(Address::generate(&env)),
            AdminAction::RemoveAdmin(admins.get(2).unwrap()),
        ];
        for (expected_id, action) in (0u64..).zip(valid) {
            assert_eq!(client.propose_admin_action(&proposer, &action), expected_id);
        }
    }

    #[test]
    fn test_execute_rejects_add_admin_that_became_a_noop() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, client, _registry_client) = setup(&env);
        let newcomer = Address::generate(&env);

        // Both are valid when proposed; the first one makes the second a no-op.
        let first = client.propose_admin_action(&admin, &AdminAction::AddAdmin(newcomer.clone()));
        let second = client.propose_admin_action(&admin, &AdminAction::AddAdmin(newcomer.clone()));
        client.execute_admin_action(&admin, &first);
        assert!(client.is_admin(&newcomer));

        assert_eq!(
            client.try_execute_admin_action(&admin, &second),
            Err(Ok(DonationError::AdminAlreadyExists.into()))
        );
        assert!(!client.get_proposal(&second).unwrap().executed);
    }

    #[test]
    fn test_execute_rejects_remove_admin_that_became_a_noop() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admins) = deploy_with_admins(&env, 3, 1);
        let proposer = admins.get(0).unwrap();
        let leaving = admins.get(2).unwrap();

        let first =
            client.propose_admin_action(&proposer, &AdminAction::RemoveAdmin(leaving.clone()));
        let second =
            client.propose_admin_action(&proposer, &AdminAction::RemoveAdmin(leaving.clone()));
        client.execute_admin_action(&proposer, &first);
        assert!(!client.is_admin(&leaving));

        assert_eq!(
            client.try_execute_admin_action(&proposer, &second),
            Err(Ok(DonationError::AdminNotFound.into()))
        );
        assert!(!client.get_proposal(&second).unwrap().executed);
    }

    #[test]
    fn test_execute_still_rechecks_state_that_changed_after_proposal() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (client, admins) = deploy_with_admins(&env, 3, 1);
        let proposer = admins.get(0).unwrap();

        // SetThreshold(3) is valid with 3 admins, but an admin is removed first.
        let raise = client.propose_admin_action(&proposer, &AdminAction::SetThreshold(3));
        let remove = client
            .propose_admin_action(&proposer, &AdminAction::RemoveAdmin(admins.get(2).unwrap()));
        client.execute_admin_action(&proposer, &remove);
        assert_eq!(
            client.try_execute_admin_action(&proposer, &raise),
            Err(Ok(DonationError::InvalidThreshold.into()))
        );

        // SetMinDonation(500) is valid with no maximum, but a maximum of 100 lands first.
        let min = client.propose_admin_action(&proposer, &AdminAction::SetMinDonation(500));
        let max = client.propose_admin_action(&proposer, &AdminAction::SetMaxDonation(100));
        client.execute_admin_action(&proposer, &max);
        assert!(client.try_execute_admin_action(&proposer, &min).is_err());
        assert_eq!(client.get_min_donation(), 0);
        assert!(!client.get_proposal(&min).unwrap().executed);
    }

    #[test]
    fn test_remove_admin_revokes_primary_admin_privileges() {
        // #284: a removed primary admin must lose ADMIN_KEY-gated powers,
        // not just their seat in ADMINS_KEY.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());
        // 2-of-3 threshold, dropping to 2 admins (still threshold 2) after removal.
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        // Remove admin1, the primary admin set at deploy time.
        let prop_id = donation_client
            .propose_admin_action(&admin2, &AdminAction::RemoveAdmin(admin1.clone()));
        donation_client.approve_admin_action(&admin3, &prop_id);
        donation_client.execute_admin_action(&admin2, &prop_id);

        assert!(!donation_client.is_admin(&admin1));

        // admin1 is no longer an admin at all, so even single-admin-mode
        // shortcuts (which still require threshold == 1, not met here) must
        // reject them — confirming ADMIN_KEY no longer resolves to a
        // removed/compromised key's privileges.
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.set_executor(&Address::generate(&env));
        }))
        .is_err());
    }

    #[test]
    fn test_remove_primary_admin_reassigns_admin_key_on_single_admin_deployment() {
        // On a deployment that drops back to threshold == 1, ADMIN_KEY must
        // be reassigned to the new primary admin, not left pointing at the
        // removed one, so the legacy single-admin shortcuts keep working.
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        let (donation_client, _registry_client) = deploy_pair(&env, admins, 2, 0);

        // Lower the threshold to 1 first so removing admin1 leaves a valid
        // 1-of-1 deployment.
        let threshold_prop =
            donation_client.propose_admin_action(&admin1, &AdminAction::SetThreshold(1));
        donation_client.approve_admin_action(&admin2, &threshold_prop);
        donation_client.execute_admin_action(&admin1, &threshold_prop);

        let remove_prop = donation_client
            .propose_admin_action(&admin2, &AdminAction::RemoveAdmin(admin1.clone()));
        donation_client.execute_admin_action(&admin2, &remove_prop);

        assert!(!donation_client.is_admin(&admin1));
        assert!(donation_client.is_admin(&admin2));

        // admin2 is now the sole admin and threshold is 1, so the legacy
        // direct setter must work for admin2 — proving ADMIN_KEY was
        // reassigned away from the removed admin1.
        donation_client.add_allowed_token(&Address::generate(&env));
    }

    #[test]
    fn property_test_edge_cases_and_boundary_rejection() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000_000);

        // 1. Amount == 0 must panic
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &0,
                &String::from_bytes(&env, b"zero"),
            );
        }))
        .is_err());

        // 2. Negative amount must panic
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &-500,
                &String::from_bytes(&env, b"negative"),
            );
        }))
        .is_err());

        // 3. Memo exceeding MAX_MEMO_LENGTH (140 bytes) must panic
        let long_memo_bytes = [b'a'; 141];
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &token_address,
                &100,
                &String::from_bytes(&env, &long_memo_bytes),
            );
        }))
        .is_err());

        // 4. Exactly 140 bytes memo must succeed
        let max_valid_memo = [b'b'; 140];
        let ok_record = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_bytes(&env, &max_valid_memo),
        );
        assert_eq!(ok_record.amount, 100);

        // 5. Non-allowed token must panic
        let unallowed_token = Address::generate(&env);
        assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            donation_client.donate(
                &donor,
                &creator,
                &unallowed_token,
                &100,
                &String::from_bytes(&env, b"unallowed"),
            );
        }))
        .is_err());
    }

    use proptest::prelude::*;

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(15))]

        #[test]
        fn proptest_arbitrary_donation_amounts_invariant(
            amount1 in 1i128..10_000,
            amount2 in 1i128..10_000,
            amount3 in 1i128..10_000
        ) {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (admin, donation_client, registry_client) = setup(&env);

            let donor = Address::generate(&env);
            let creator = Address::generate(&env);
            let token_address = create_token_contract(&env, &admin);
            donation_client.add_allowed_token(&token_address);
            donation_client.register_creator(&creator, &String::from_bytes(&env, b"proptest_creator"));

            let total_donation = amount1 + amount2 + amount3;
            StellarAssetClient::new(&env, &token_address).mint(&donor, &(total_donation + 500));
            let token_client = token::Client::new(&env, &token_address);

            let mut donated_so_far = 0i128;

            for amt in [amount1, amount2, amount3] {
                let rec = donation_client.donate(
                    &donor,
                    &creator,
                    &token_address,
                    &amt,
                    &String::from_bytes(&env, b"prop"),
                );
                prop_assert_eq!(rec.amount, amt);
                donated_so_far += amt;
                // No fee is withheld: the creator balance must equal every
                // stroop donated so far. Any skim would fail this check.
                prop_assert_eq!(token_client.balance(&creator), donated_so_far);
            }

            let profile = registry_client.get_creator(&creator).unwrap();
            prop_assert_eq!(profile.total_donations, total_donation);
            prop_assert_eq!(profile.donation_count, 3);
        }

        #[test]
        fn proptest_subscription_charge_schedule_invariant(
            interval in 100u64..100_000,
            offset in 1u64..99
        ) {
            let env = Env::default();
            env.mock_all_auths_allowing_non_root_auth();
            let (admin, donation_client, _registry_client) = setup(&env);

            let supporter = Address::generate(&env);
            let creator = Address::generate(&env);
            let executor = Address::generate(&env);
            let token_address = create_token_contract(&env, &admin);

            donation_client.add_allowed_token(&token_address);
            donation_client.set_executor(&executor);

            StellarAssetClient::new(&env, &token_address).mint(&supporter, &100_000);
            let token_client = token::Client::new(&env, &token_address);
            token_client.approve(&supporter, &donation_client.address, &100_000, &1000);

            env.ledger().with_mut(|li| {
                li.sequence_number = 100;
                li.timestamp = 1_000;
            });

            let sub_id = donation_client.subscribe(
                &supporter,
                &creator,
                &token_address,
                &50,
                &interval,
            );

            // Time is strictly before next_charge_at (1_000 + offset < 1_000 + interval)
            env.ledger().with_mut(|li| {
                li.timestamp = 1_000 + offset;
            });

            // Charging prematurely must fail with error
            let premature_charge = donation_client.try_charge_subscription(&executor, &sub_id);
            prop_assert!(premature_charge.is_err());
        }
    }

    #[test]
    fn test_subscribe_interval_overflow_panics() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let res =
            donation_client.try_subscribe(&supporter, &creator, &token_address, &100, &u64::MAX);
        assert_eq!(res.unwrap_err().unwrap(), DonationError::Overflow.into());
    }

    #[test]
    fn test_charge_subscription_persists_reschedule_with_the_charge() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &10_000);
        donation_client.register_creator(&creator, &String::from_bytes(&env, b"dev"));

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &5_000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_500);
        donation_client.charge_subscription(&executor, &id);

        // The reschedule and the transfer land together.
        assert_eq!(
            donation_client
                .get_subscription(&id)
                .unwrap()
                .next_charge_at,
            3_500
        );
        assert_eq!(token_client.balance(&creator), 500);

        // A second charge in the same period is rejected because the new
        // schedule was already persisted.
        assert!(donation_client
            .try_charge_subscription(&executor, &id)
            .is_err());
        assert_eq!(token_client.balance(&creator), 500);
    }

    #[test]
    fn test_failed_charge_does_not_reschedule() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100);

        env.ledger().with_mut(|li| li.timestamp = 1_000);
        donation_client.set_executor(&executor);
        let id = donation_client.subscribe(&supporter, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&supporter, &donation_client.address, &5_000, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let result = donation_client.try_charge_subscription(&executor, &id);
        assert_eq!(
            result.unwrap_err().unwrap(),
            ChargeError::InsufficientBalance
        );
        assert_eq!(
            donation_client
                .get_subscription(&id)
                .unwrap()
                .next_charge_at,
            2_000
        );
    }

    #[test]
    fn test_donated_event_payload_for_donate_and_subscription() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &10_000);

        donation_client.set_executor(&executor);

        // 1. One-off donation
        let don = donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &300,
            &String::from_bytes(&env, b"support"),
        );
        assert_eq!(don.amount, 300);
        assert_eq!(don.creator, creator);
        assert_eq!(don.donor, donor);

        // 2. Subscription charge
        env.ledger().with_mut(|li| li.timestamp = 1_000);
        let sub_id = donation_client.subscribe(&donor, &creator, &token_address, &500, &1_000);
        let token_client = token::Client::new(&env, &token_address);
        token_client.approve(&donor, &donation_client.address, &500, &1_000);

        env.ledger().with_mut(|li| li.timestamp = 2_000);
        let sub_don = donation_client.charge_subscription(&executor, &sub_id);
        assert_eq!(sub_don.amount, 500);
        assert_eq!(sub_don.creator, creator);
        assert_eq!(sub_don.donor, donor);
    }

    #[test]
    fn test_cancelled_proposal_rejects_execution() {
        let env = Env::default();
        env.mock_all_auths();
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin1.clone(), admin2.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        let prop_id = client.propose_admin_action(&admin1, &AdminAction::Pause);
        client.cancel_admin_action(&admin1, &prop_id);

        let prop = client.get_proposal(&prop_id).unwrap();
        assert!(prop.cancelled);
        assert!(!prop.executed);

        assert!(client.try_execute_admin_action(&admin1, &prop_id).is_err());
    }

    #[test]
    fn test_expired_proposal_cannot_execute() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        let prop_id = client.propose_admin_action(&admin, &AdminAction::Pause);
        let prop = client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop.expires_at, ADMIN_PROPOSAL_TTL_SECONDS);

        env.ledger()
            .with_mut(|li| li.timestamp = ADMIN_PROPOSAL_TTL_SECONDS + 1);
        assert!(client.try_execute_admin_action(&admin, &prop_id).is_err());
    }

    #[test]
    fn test_approve_rejects_cancelled_and_expired_proposals() {
        let env = Env::default();
        env.mock_all_auths();
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin1.clone(), admin2.clone()];
        let (client, _) = deploy_pair(&env, admins, 2, 0);

        let prop_id = client.propose_admin_action(&admin1, &AdminAction::Pause);
        client.cancel_admin_action(&admin1, &prop_id);
        assert_eq!(
            client.try_approve_admin_action(&admin2, &prop_id),
            Err(Ok(DonationError::ProposalCancelled.into()))
        );

        let prop2_id = client.propose_admin_action(&admin1, &AdminAction::Pause);
        env.ledger()
            .with_mut(|li| li.timestamp = ADMIN_PROPOSAL_TTL_SECONDS + 1);
        assert_eq!(
            client.try_approve_admin_action(&admin2, &prop2_id),
            Err(Ok(DonationError::ProposalExpired.into()))
        );
    }

    #[test]
    fn test_approval_from_removed_admin_does_not_count() {
        let env = Env::default();
        env.mock_all_auths();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin1.clone(), admin2.clone(), admin3.clone()];
        let (client, _) = deploy_pair(&env, admins, 2, 10);

        // prop0 collects approvals from admin1 and admin3 (cached count = 2)
        let prop0 = client.propose_admin_action(&admin1, &AdminAction::Pause);
        client.approve_admin_action(&admin3, &prop0);
        assert_eq!(client.get_proposal(&prop0).unwrap().approvals_count, 2);

        // prop1 removes admin3 and is approved by admin1 + admin2
        let prop1 = client.propose_admin_action(&admin1, &AdminAction::RemoveAdmin(admin3.clone()));
        client.approve_admin_action(&admin2, &prop1);

        env.ledger().with_mut(|li| li.timestamp = 20);
        client.execute_admin_action(&admin1, &prop1);
        assert!(!client.is_admin(&admin3));

        // admin3's approval on prop0 no longer counts: recount sees only admin1 (< 2 threshold),
        // so execution fails even though approvals_count says 2.
        assert!(client.try_execute_admin_action(&admin1, &prop0).is_err());
        let prop0_after = client.get_proposal(&prop0).unwrap();
        assert!(!prop0_after.executed);

        // admin2 approves prop0; now recount reaches threshold and execution succeeds.
        client.approve_admin_action(&admin2, &prop0);
        client.execute_admin_action(&admin1, &prop0);
        assert!(client.get_proposal(&prop0).unwrap().executed);
    }

    #[test]
    fn test_cancelled_proposal_returns_specific_error() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        let target = Address::generate(&env);
        let prop_id =
            client.propose_admin_action(&admin, &AdminAction::SetDonationContract(target));

        client.cancel_admin_action(&admin, &prop_id);

        let prop = client.get_proposal(&prop_id).unwrap();
        assert!(prop.cancelled);
        assert!(!prop.executed);

        env.ledger().with_mut(|li| li.timestamp = 10);
        assert_eq!(
            client.try_execute_admin_action(&admin, &prop_id),
            Err(Ok(DonationError::ProposalCancelled.into()))
        );
        let prop_after = client.get_proposal(&prop_id).unwrap();
        assert!(prop_after.cancelled);
        assert!(!prop_after.executed);
    }

    #[test]
    fn test_cancel_requires_threshold_of_non_proposer_admins() {
        let env = Env::default();
        env.mock_all_auths();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admin3 = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin1.clone(), admin2.clone(), admin3.clone()];
        let (client, _) = deploy_pair(&env, admins, 2, 0);

        let target = Address::generate(&env);
        let prop_id =
            client.propose_admin_action(&admin1, &AdminAction::SetDonationContract(target));

        // A single non-proposer request (1 < threshold 2) does not cancel.
        client.cancel_admin_action(&admin2, &prop_id);
        assert!(!client.get_proposal(&prop_id).unwrap().cancelled);

        // The second request reaches the threshold: the proposal is cancelled.
        client.cancel_admin_action(&admin3, &prop_id);
        assert!(client.get_proposal(&prop_id).unwrap().cancelled);
    }

    #[test]
    fn test_timelock_not_elapsed_and_success() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 100);

        let prop_id = client.propose_admin_action(&admin, &AdminAction::Pause);

        // Timelock has not elapsed (now = 0, eta = 100) -> fails with TimelockNotElapsed
        assert_eq!(
            client.try_execute_admin_action(&admin, &prop_id),
            Err(Ok(DonationError::TimelockNotElapsed.into()))
        );

        // Timelock elapses (now = 100, eta = 100) -> succeeds
        env.ledger().with_mut(|li| li.timestamp = 100);
        client.execute_admin_action(&admin, &prop_id);
        assert!(client.get_proposal(&prop_id).unwrap().executed);
        assert!(client.is_paused());
    }

    #[test]
    fn test_already_approved_and_success() {
        let env = Env::default();
        env.mock_all_auths();
        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin1.clone(), admin2.clone()];
        let (client, _) = deploy_pair(&env, admins, 2, 0);

        let prop_id = client.propose_admin_action(&admin1, &AdminAction::Pause);

        // Admin 2 approves once (succeeds)
        client.approve_admin_action(&admin2, &prop_id);

        // Admin 2 attempts to approve a second time -> fails with AlreadyApproved
        assert_eq!(
            client.try_approve_admin_action(&admin2, &prop_id),
            Err(Ok(DonationError::AlreadyApproved.into()))
        );
    }

    #[test]
    #[should_panic(expected = "admin list cannot be empty")]
    fn test_constructor_rejects_empty_admin_list() {
        let env = Env::default();
        env.register(
            DonationContract,
            (
                Vec::<Address>::new(&env),
                1u32,
                0u64,
                Address::generate(&env),
            ),
        );
    }

    #[test]
    #[should_panic(expected = "invalid signature threshold")]
    fn test_constructor_rejects_zero_threshold() {
        let env = Env::default();
        let admin = Address::generate(&env);
        env.register(
            DonationContract,
            (
                Vec::from_array(&env, [admin]),
                0u32,
                0u64,
                Address::generate(&env),
            ),
        );
    }

    #[test]
    #[should_panic(expected = "invalid signature threshold")]
    fn test_constructor_rejects_threshold_greater_than_admins() {
        let env = Env::default();
        let admin = Address::generate(&env);
        env.register(
            DonationContract,
            (
                Vec::from_array(&env, [admin]),
                2u32,
                0u64,
                Address::generate(&env),
            ),
        );
    }

    #[test]
    #[should_panic(expected = "duplicate admin in admin list")]
    fn test_constructor_rejects_duplicate_admins() {
        let env = Env::default();
        let admin = Address::generate(&env);
        env.register(
            DonationContract,
            (
                Vec::from_array(&env, [admin.clone(), admin]),
                1u32,
                0u64,
                Address::generate(&env),
            ),
        );
    }

    #[test]
    fn test_initializers_panic_after_construction() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let other_admin = Address::generate(&env);
        let res_init = donation_client.try_initialize(&other_admin, &registry_client.address);
        assert_eq!(
            res_init.unwrap_err().unwrap(),
            DonationError::AlreadyInitialized.into()
        );

        let admins = Vec::from_array(&env, [other_admin]);
        let res_multisig = donation_client.try_initialize_multisig(
            &admins,
            &1u32,
            &0u64,
            &registry_client.address,
        );
        assert_eq!(
            res_multisig.unwrap_err().unwrap(),
            DonationError::AlreadyInitialized.into()
        );

        assert!(donation_client.is_admin(&admin));
    }

    #[test]
    fn test_state_changing_calls_extend_instance_ttl() {
        use common::{DAY_IN_LEDGERS, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD};

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let executor = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        donation_client.set_executor(&executor);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000_000);

        // 1. donate extends instance TTL
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS);
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);
        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &100,
            &String::from_str(&env, ""),
        );
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );

        // 2. subscribe extends instance TTL
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS);
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);
        let sub_id = donation_client.subscribe(&donor, &creator, &token_address, &50, &86_400);
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );

        // 3. charge_subscription extends instance TTL
        let token_client = token::Client::new(&env, &token_address);
        let exp_ledger = env.ledger().sequence() + INSTANCE_BUMP_AMOUNT;
        token_client.approve(&donor, &donation_client.address, &10_000, &exp_ledger);
        env.ledger().with_mut(|li| {
            li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS;
            li.timestamp += 86_400;
        });
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);
        donation_client.charge_subscription(&executor, &sub_id);
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );

        // 4. register_creator pass-through extends instance TTL
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS);
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);
        let new_creator = Address::generate(&env);
        donation_client.register_creator(&new_creator, &String::from_str(&env, "new_dev"));
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );
        assert!(registry_client.get_creator(&new_creator).is_some());
    }

    #[test]
    fn test_admin_proposals_extend_instance_and_persistent_ttl() {
        use common::{
            DAY_IN_LEDGERS, INSTANCE_BUMP_AMOUNT, INSTANCE_LIFETIME_THRESHOLD,
            PERSISTENT_BUMP_AMOUNT,
        };

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());

        let (donation_client, _) = deploy_pair(&env, admins, 2, 50);

        // Decay instance TTL
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS);
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);

        // Propose
        let new_exec = Address::generate(&env);
        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::SetExecutor(new_exec.clone()));
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );

        let expected_prop_ttl = common::proposal_bump_amount(50);
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &(PROPOSAL_KEY, prop_id)),
            expected_prop_ttl
        );
        assert_eq!(
            persistent_ttl(
                &env,
                &donation_client.address,
                &(APPROVAL_KEY, prop_id, admin1.clone())
            ),
            expected_prop_ttl
        );
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &PROPOSAL_COUNTER_KEY),
            PERSISTENT_BUMP_AMOUNT
        );

        // Decay instance TTL again before approve
        env.ledger()
            .with_mut(|li| li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS);
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);

        donation_client.approve_admin_action(&admin2, &prop_id);
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );
        assert_eq!(
            persistent_ttl(
                &env,
                &donation_client.address,
                &(APPROVAL_KEY, prop_id, admin2.clone())
            ),
            expected_prop_ttl
        );
        assert!(
            persistent_ttl(&env, &donation_client.address, &(PROPOSAL_KEY, prop_id))
                >= expected_prop_ttl - 30 * DAY_IN_LEDGERS
        );

        // Decay instance TTL again before execute
        env.ledger().with_mut(|li| {
            li.sequence_number += INSTANCE_BUMP_AMOUNT - 2 * DAY_IN_LEDGERS;
            li.timestamp += 60;
        });
        assert!(instance_ttl(&env, &donation_client.address) < INSTANCE_LIFETIME_THRESHOLD);

        donation_client.execute_admin_action(&admin1, &prop_id);
        assert_eq!(
            instance_ttl(&env, &donation_client.address),
            INSTANCE_BUMP_AMOUNT
        );
        assert!(
            persistent_ttl(&env, &donation_client.address, &(PROPOSAL_KEY, prop_id))
                >= expected_prop_ttl - 30 * DAY_IN_LEDGERS
        );
    }

    #[test]
    fn test_admin_proposal_cancel_extends_persistent_ttl() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();

        let admin1 = Address::generate(&env);
        let admin2 = Address::generate(&env);
        let mut admins = Vec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());

        let (donation_client, _) = deploy_pair(&env, admins, 2, 100);

        let prop_id = donation_client
            .propose_admin_action(&admin1, &AdminAction::SetExecutor(Address::generate(&env)));

        // Admin2 requests cancellation
        donation_client.cancel_admin_action(&admin2, &prop_id);
        let expected_ttl = common::proposal_bump_amount(100);
        assert_eq!(
            persistent_ttl(
                &env,
                &donation_client.address,
                &(CANCEL_KEY, prop_id, admin2.clone())
            ),
            expected_ttl
        );

        // Proposer cancels
        donation_client.cancel_admin_action(&admin1, &prop_id);
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &(PROPOSAL_KEY, prop_id)),
            expected_ttl
        );
    }

    #[test]
    fn test_non_admin_propose_and_approve_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let non_admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        // Non-admin propose fails
        assert_eq!(
            client.try_propose_admin_action(&non_admin, &AdminAction::Pause),
            Err(Ok(DonationError::Unauthorized.into()))
        );

        // Admin proposes
        let prop_id = client.propose_admin_action(&admin, &AdminAction::Pause);

        // Non-admin approve fails
        assert_eq!(
            client.try_approve_admin_action(&non_admin, &prop_id),
            Err(Ok(DonationError::Unauthorized.into()))
        );

        // Non-admin execute fails
        assert_eq!(
            client.try_execute_admin_action(&non_admin, &prop_id),
            Err(Ok(DonationError::Unauthorized.into()))
        );
    }

    #[test]
    fn test_set_donation_contract_action() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        let new_registry = Address::generate(&env);
        let prop_id = client.propose_admin_action(
            &admin,
            &AdminAction::SetDonationContract(new_registry.clone()),
        );
        client.execute_admin_action(&admin, &prop_id);
        assert!(client.get_proposal(&prop_id).unwrap().executed);
    }

    #[test]
    fn test_bump_and_bump_subscription_ttl() {
        let env = Env::default();
        env.mock_all_auths();
        let admin = Address::generate(&env);
        let admins = soroban_sdk::vec![&env, admin.clone()];
        let (client, _) = deploy_pair(&env, admins, 1, 0);

        // bump instance TTL succeeds
        client.bump();

        // Non-existent subscription bump fails
        assert!(client.try_bump_subscription(&9999).is_err());
    }

    #[test]
    fn test_subscribe_and_donate_extend_persistent_counters_and_entry_ttl() {
        use common::PERSISTENT_BUMP_AMOUNT;

        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let supporter = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        donation_client.add_allowed_token(&token_address);
        StellarAssetClient::new(&env, &token_address).mint(&supporter, &100_000);

        let sub_id = donation_client.subscribe(&supporter, &creator, &token_address, &100, &86_400);

        let expected_sub_ttl = common::subscription_bump_amount(86_400);
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &(SUBSCRIPTIONS_KEY, sub_id)),
            expected_sub_ttl
        );
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &SUB_COUNTER),
            PERSISTENT_BUMP_AMOUNT
        );

        donation_client.donate(
            &supporter,
            &creator,
            &token_address,
            &100,
            &String::from_str(&env, "test"),
        );
        assert_eq!(
            persistent_ttl(&env, &donation_client.address, &DONATION_COUNTER),
            PERSISTENT_BUMP_AMOUNT
        );
    }
}
