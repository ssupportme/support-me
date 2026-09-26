#![no_std]

//! Donation contract: moves the donated token from donor to creator and
//! keeps a local, append-only log of donations. Creator profile state
//! (username, lifetime totals) lives in a separate `creator-registry`
//! contract — this contract talks to it exclusively through cross-contract
//! calls (`env.invoke_contract`), so the two contracts can be deployed,
//! upgraded, and audited independently.
//!
//! Multi-signature and timelock governance:
//! High-risk administrative operations (setting executor, rotating admins,
//! adjusting threshold, pausing operations) require multi-signature proposal,
//! approval threshold, and timelock delay before execution.

use common::{AdminAction, AdminProposal, CreatorProfile, DonationRecord, Subscription};
use soroban_sdk::{
    contract, contractevent, contractimpl, symbol_short, token, Address, Env, IntoVal, String,
    Symbol, Val, Vec as SorobanVec,
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
const PAUSED_KEY: Symbol = symbol_short!("paused");
const REGISTRY_KEY: Symbol = symbol_short!("registry");
const SUBSCRIPTIONS_KEY: Symbol = symbol_short!("subs");
const SUB_COUNTER: Symbol = symbol_short!("sub_ctr");
const EXECUTOR_KEY: Symbol = symbol_short!("executor");
pub const MAX_MEMO_LENGTH: u32 = 140;

/// Emitted whenever a donation is settled on-chain.
#[contractevent(topics = ["donated"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DonatedEvent {
    #[topic]
    pub donor: Address,
    #[topic]
    pub creator: Address,
    pub token: Address,
    pub amount: i128,
    pub memo: String,
    pub timestamp: u64,
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

/// Emitted when an admin proposal is created.
#[contractevent(topics = ["prop_created"])]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProposalCreatedEvent {
    pub proposal_id: u64,
    #[topic]
    pub proposer: Address,
    pub eta: u64,
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

#[contract]
pub struct DonationContract;

#[contractimpl]
impl DonationContract {
    /// One-time single-admin setup: backwards compatible wrapper initializing 1-of-1 admin setup.
    pub fn initialize(env: Env, admin: Address, registry: Address) {
        admin.require_auth();
        assert!(
            !env.storage().instance().has(&ADMIN_KEY) && !env.storage().instance().has(&ADMINS_KEY),
            "donation contract already initialized"
        );

        let mut admins = SorobanVec::new(&env);
        admins.push_back(admin.clone());

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &1u32);
        env.storage().instance().set(&TIMELOCK_DELAY_KEY, &0u64);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
    }

    /// One-time multi-sig setup: configures admin list, threshold, and timelock delay.
    pub fn initialize_multisig(
        env: Env,
        admins: SorobanVec<Address>,
        threshold: u32,
        timelock_delay: u64,
        registry: Address,
    ) {
        assert!(
            !env.storage().instance().has(&ADMIN_KEY) && !env.storage().instance().has(&ADMINS_KEY),
            "donation contract already initialized"
        );
        assert!(admins.len() > 0, "admin list cannot be empty");
        assert!(threshold > 0 && threshold <= admins.len(), "invalid signature threshold");

        for i in 0..admins.len() {
            admins.get(i).unwrap().require_auth();
        }

        let primary_admin = admins.get(0).unwrap();
        env.storage().instance().set(&ADMIN_KEY, &primary_admin);
        env.storage().instance().set(&ADMINS_KEY, &admins);
        env.storage().instance().set(&THRESHOLD_KEY, &threshold);
        env.storage().instance().set(&TIMELOCK_DELAY_KEY, &timelock_delay);
        env.storage().instance().set(&PAUSED_KEY, &false);
        env.storage().instance().set(&REGISTRY_KEY, &registry);
    }

    /// Returns whether a given address is an authorized contract admin.
    pub fn is_admin(env: Env, address: Address) -> bool {
        let admins: SorobanVec<Address> = env
            .storage()
            .instance()
            .get(&ADMINS_KEY)
            .unwrap_or_else(|| SorobanVec::new(&env));
        Self::contains_address(&admins, &address)
    }

    /// Returns whether contract transfers/operations are currently paused.
    pub fn is_paused(env: Env) -> bool {
        env.storage().instance().get(&PAUSED_KEY).unwrap_or(false)
    }

    /// Emergency pause: any authorized admin can instantly freeze contract operations.
    pub fn emergency_pause(env: Env, admin: Address) {
        admin.require_auth();
        assert!(Self::is_admin(env.clone(), admin), "caller is not an admin");
        env.storage().instance().set(&PAUSED_KEY, &true);
    }

    /// Proposes a multi-signature administrative action.
    pub fn propose_admin_action(env: Env, proposer: Address, action: AdminAction) -> u64 {
        proposer.require_auth();
        assert!(Self::is_admin(env.clone(), proposer.clone()), "proposer is not an admin");

        let prop_id: u64 = env.storage().persistent().get(&PROPOSAL_COUNTER_KEY).unwrap_or(0);
        let timelock: u64 = env.storage().instance().get(&TIMELOCK_DELAY_KEY).unwrap_or(0);
        let now = env.ledger().timestamp();
        let eta = now + timelock;

        let proposal = AdminProposal {
            id: prop_id,
            action,
            proposer: proposer.clone(),
            approvals_count: 1,
            created_at: now,
            eta,
            executed: false,
        };

        env.storage().persistent().set(&(PROPOSAL_KEY, prop_id), &proposal);
        env.storage().persistent().set(&(APPROVAL_KEY, prop_id, proposer.clone()), &true);
        env.storage().persistent().set(&PROPOSAL_COUNTER_KEY, &(prop_id + 1));

        ProposalCreatedEvent {
            proposal_id: prop_id,
            proposer,
            eta,
        }
        .publish(&env);

        prop_id
    }

    /// Approves an existing administrative proposal.
    pub fn approve_admin_action(env: Env, admin: Address, proposal_id: u64) {
        admin.require_auth();
        assert!(Self::is_admin(env.clone(), admin.clone()), "caller is not an admin");

        let mut proposal: AdminProposal = env
            .storage()
            .persistent()
            .get(&(PROPOSAL_KEY, proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed, "proposal already executed");

        let has_approved: bool = env
            .storage()
            .persistent()
            .get(&(APPROVAL_KEY, proposal_id, admin.clone()))
            .unwrap_or(false);
        assert!(!has_approved, "admin has already approved this proposal");

        env.storage().persistent().set(&(APPROVAL_KEY, proposal_id, admin.clone()), &true);
        proposal.approvals_count += 1;
        env.storage().persistent().set(&(PROPOSAL_KEY, proposal_id), &proposal);

        ProposalApprovedEvent {
            proposal_id,
            admin,
            approvals_count: proposal.approvals_count,
        }
        .publish(&env);
    }

    /// Executes an administrative proposal once signature threshold & timelock criteria are met.
    pub fn execute_admin_action(env: Env, executor: Address, proposal_id: u64) {
        executor.require_auth();
        assert!(Self::is_admin(env.clone(), executor.clone()), "caller is not an admin");

        let mut proposal: AdminProposal = env
            .storage()
            .persistent()
            .get(&(PROPOSAL_KEY, proposal_id))
            .expect("proposal not found");
        assert!(!proposal.executed, "proposal already executed");

        let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).expect("threshold not set");
        assert!(
            proposal.approvals_count >= threshold,
            "insufficient signatures to execute proposal"
        );

        let now = env.ledger().timestamp();
        assert!(now >= proposal.eta, "proposal timelock delay has not elapsed");

        match proposal.action.clone() {
            AdminAction::SetExecutor(target) => {
                env.storage().instance().set(&EXECUTOR_KEY, &target);
            }
            AdminAction::SetDonationContract(target) => {
                env.storage().instance().set(&REGISTRY_KEY, &target);
            }
            AdminAction::AddAdmin(new_admin) => {
                let mut admins: SorobanVec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                if !Self::contains_address(&admins, &new_admin) {
                    admins.push_back(new_admin);
                    env.storage().instance().set(&ADMINS_KEY, &admins);
                }
            }
            AdminAction::RemoveAdmin(old_admin) => {
                let admins: SorobanVec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                let mut new_admins = SorobanVec::new(&env);
                for i in 0..admins.len() {
                    let a = admins.get(i).unwrap();
                    if a != old_admin {
                        new_admins.push_back(a);
                    }
                }
                assert!(new_admins.len() > 0, "cannot remove all admins");
                let threshold: u32 = env.storage().instance().get(&THRESHOLD_KEY).unwrap();
                assert!(threshold <= new_admins.len(), "threshold exceeds remaining admin count");
                env.storage().instance().set(&ADMINS_KEY, &new_admins);
            }
            AdminAction::SetThreshold(new_threshold) => {
                let admins: SorobanVec<Address> = env.storage().instance().get(&ADMINS_KEY).unwrap();
                assert!(
                    new_threshold > 0 && new_threshold <= admins.len(),
                    "invalid new threshold"
                );
                env.storage().instance().set(&THRESHOLD_KEY, &new_threshold);
            }
            AdminAction::Pause => {
                env.storage().instance().set(&PAUSED_KEY, &true);
            }
            AdminAction::Unpause => {
                env.storage().instance().set(&PAUSED_KEY, &false);
            }
        }

        proposal.executed = true;
        env.storage().persistent().set(&(PROPOSAL_KEY, proposal_id), &proposal);

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
            let admin: Address = env
                .storage()
                .instance()
                .get(&ADMIN_KEY)
                .expect("donation contract not initialized");
            admin.require_auth();
            env.storage().instance().set(&EXECUTOR_KEY, &executor);
        } else {
            panic!("multi-sig required: use propose_admin_action to set executor");
        }
    }

    /// Cross-contract call: delegates creator registration to the CreatorRegistry contract.
    pub fn register_creator(env: Env, creator: Address, username: String) -> CreatorProfile {
        assert!(!Self::is_paused(env.clone()), "contract is currently paused");
        let registry = Self::registry_address(&env);
        let args: SorobanVec<Val> = (creator, username).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "register_creator"), args)
    }

    /// Cross-contract call: reads a creator's profile from CreatorRegistry.
    pub fn get_creator(env: Env, creator: Address) -> Option<CreatorProfile> {
        let registry = Self::registry_address(&env);
        let args: SorobanVec<Val> = (creator,).into_val(&env);
        env.invoke_contract(&registry, &Symbol::new(&env, "get_creator"), args)
    }

    /// Transfer `amount` of `token` from `donor` to `creator`, record donation, update registry.
    pub fn donate(
        env: Env,
        donor: Address,
        creator: Address,
        token: Address,
        amount: i128,
        memo: String,
    ) -> DonationRecord {
        assert!(!Self::is_paused(env.clone()), "contract is currently paused");
        donor.require_auth();
        assert!(amount > 0, "Donation amount must be positive");
        assert!(
            memo.len() <= MAX_MEMO_LENGTH,
            "Donation memo exceeds maximum length"
        );

        let token_client = token::Client::new(&env, &token);
        token_client.transfer(&donor, &creator, &amount);

        let registry = Self::registry_address(&env);
        let record_args: SorobanVec<Val> =
            (env.current_contract_address(), creator.clone(), amount).into_val(&env);
        let (): () = env.invoke_contract(&registry, &Symbol::new(&env, "record_donation"), record_args);

        let donation = DonationRecord {
            donor: donor.clone(),
            creator: creator.clone(),
            amount,
            fee_amount: 0,
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
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &(counter + 1));

        DonatedEvent {
            donor,
            creator,
            token,
            amount,
            memo,
            timestamp: env.ledger().timestamp(),
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
        assert!(!Self::is_paused(env.clone()), "contract is currently paused");
        supporter.require_auth();
        assert!(amount > 0, "Subscription amount must be positive");
        assert!(interval_secs > 0, "Interval must be positive");

        let id: u64 = env.storage().persistent().get(&SUB_COUNTER).unwrap_or(0);
        let now = env.ledger().timestamp();

        let subscription = Subscription {
            supporter: supporter.clone(),
            creator: creator.clone(),
            token: token.clone(),
            amount,
            interval_secs,
            next_charge_at: now + interval_secs,
            active: true,
        };

        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, id), &subscription);
        env.storage().persistent().set(&SUB_COUNTER, &(id + 1));

        SubscribedEvent {
            supporter,
            creator,
            subscription_id: id,
            token,
            amount,
            interval_secs,
            next_charge_at: now + interval_secs,
        }
        .publish(&env);

        id
    }

    /// Executes one due charge of a subscription.
    pub fn charge_subscription(env: Env, executor: Address, subscription_id: u64) -> DonationRecord {
        assert!(!Self::is_paused(env.clone()), "contract is currently paused");
        executor.require_auth();
        let authorized_executor: Address = env
            .storage()
            .instance()
            .get(&EXECUTOR_KEY)
            .expect("executor not set: call set_executor() first");
        assert_eq!(
            executor, authorized_executor,
            "caller is not the authorized executor"
        );

        let mut subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        assert!(subscription.active, "subscription is not active");

        let now = env.ledger().timestamp();
        assert!(now >= subscription.next_charge_at, "subscription not yet due");

        let token_client = token::Client::new(&env, &subscription.token);
        token_client.transfer_from(
            &env.current_contract_address(),
            &subscription.supporter,
            &subscription.creator,
            &subscription.amount,
        );

        let registry = Self::registry_address(&env);
        let record_args: SorobanVec<Val> = (
            env.current_contract_address(),
            subscription.creator.clone(),
            subscription.amount,
        )
            .into_val(&env);
        let (): () =
            env.invoke_contract(&registry, &Symbol::new(&env, "record_donation"), record_args);

        let memo = String::from_str(&env, "recurring");
        let donation = DonationRecord {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            amount: subscription.amount,
            fee_amount: 0,
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
        env.storage()
            .persistent()
            .set(&DONATION_COUNTER, &(counter + 1));

        subscription.next_charge_at = now + subscription.interval_secs;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);

        DonatedEvent {
            donor: subscription.supporter.clone(),
            creator: subscription.creator.clone(),
            token: subscription.token.clone(),
            amount: subscription.amount,
            memo,
            timestamp: now,
        }
        .publish(&env);

        donation
    }

    /// Cancels a subscription and revokes allowance.
    pub fn cancel_subscription(env: Env, supporter: Address, subscription_id: u64) {
        supporter.require_auth();

        let mut subscription: Subscription = env
            .storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
            .expect("subscription not found");
        assert_eq!(
            subscription.supporter, supporter,
            "not the subscription owner"
        );

        subscription.active = false;
        env.storage()
            .persistent()
            .set(&(SUBSCRIPTIONS_KEY, subscription_id), &subscription);

        let token_client = token::Client::new(&env, &subscription.token);
        token_client.approve(&supporter, &env.current_contract_address(), &0, &0);

        SubscriptionCancelledEvent {
            supporter,
            creator: subscription.creator,
            subscription_id,
        }
        .publish(&env);
    }

    /// Fetch a subscription by its ID.
    pub fn get_subscription(env: Env, subscription_id: u64) -> Option<Subscription> {
        env.storage()
            .persistent()
            .get(&(SUBSCRIPTIONS_KEY, subscription_id))
    }

    /// Get total donations count.
    pub fn get_total_donations_count(env: Env) -> u32 {
        env.storage()
            .persistent()
            .get(&DONATION_COUNTER)
            .unwrap_or(0)
    }

    /// Fetch a single donation record by index.
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
            .expect("donation contract not initialized: call initialize() first")
    }

    fn contains_address(vec: &SorobanVec<Address>, target: &Address) -> bool {
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
    use super::*;
    use creator_registry::{CreatorRegistryContract, CreatorRegistryContractClient};
    use soroban_sdk::testutils::{Address as _, Ledger};
    use soroban_sdk::token::StellarAssetClient;

    fn create_token_contract(env: &Env, admin: &Address) -> Address {
        env.register_stellar_asset_contract_v2(admin.clone())
            .address()
    }

    fn setup(env: &Env) -> (Address, DonationContractClient<'_>, CreatorRegistryContractClient<'_>) {
        let admin = Address::generate(env);
        let registry_id = env.register(CreatorRegistryContract, ());
        let donation_id = env.register(DonationContract, ());

        let registry_client = CreatorRegistryContractClient::new(env, &registry_id);
        let donation_client = DonationContractClient::new(env, &donation_id);

        registry_client.initialize(&admin, &donation_id);
        donation_client.initialize(&admin, &registry_id);

        (admin, donation_client, registry_client)
    }

    #[test]
    fn test_register_creator_via_registry() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (_admin, donation_client, _registry_client) = setup(&env);

        let creator = Address::generate(&env);
        env.ledger().with_mut(|li| li.sequence_number = 100);

        let profile = donation_client.register_creator(&creator, &String::from_bytes(&env, b"awesome_dev"));

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

        let mut admins = SorobanVec::new(&env);
        admins.push_back(admin1.clone());
        admins.push_back(admin2.clone());
        admins.push_back(admin3.clone());

        let registry_id = env.register(CreatorRegistryContract, ());
        let donation_id = env.register(DonationContract, ());

        let donation_client = DonationContractClient::new(&env, &donation_id);

        // 2-of-3 threshold with 100 seconds timelock delay
        donation_client.initialize_multisig(&admins, &2, &100, &registry_id);

        let prop_id = donation_client.propose_admin_action(&admin1, &AdminAction::SetExecutor(executor.clone()));

        let prop = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop.approvals_count, 1);
        assert_eq!(prop.executed, false);

        donation_client.approve_admin_action(&admin2, &prop_id);

        let prop2 = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop2.approvals_count, 2);

        // Timelock has not elapsed yet (timestamp 0 < eta 100)
        env.ledger().with_mut(|li| li.timestamp = 150);

        donation_client.execute_admin_action(&admin1, &prop_id);

        let prop_exec = donation_client.get_proposal(&prop_id).unwrap();
        assert_eq!(prop_exec.executed, true);
    }

    #[test]
    fn test_emergency_pause() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        assert_eq!(donation_client.is_paused(), false);
        donation_client.emergency_pause(&admin);
        assert_eq!(donation_client.is_paused(), true);
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
        assert_eq!(donation_client.get_donation(&0).unwrap().memo, donation.memo);

        let token_client = token::Client::new(&env, &token_address);
        assert_eq!(token_client.balance(&creator), 1000);
        assert_eq!(token_client.balance(&donor), 9_000);

        let stats = registry_client.get_creator(&creator).unwrap();
        assert_eq!(stats.total_donations, 1000);
        assert_eq!(stats.donation_count, 1);
    }

    #[test]
    #[should_panic(expected = "Donation amount must be positive")]
    fn test_donate_rejects_non_positive_amount() {
        let env = Env::default();
        env.mock_all_auths_allowing_non_root_auth();
        let (admin, donation_client, _registry_client) = setup(&env);

        let donor = Address::generate(&env);
        let creator = Address::generate(&env);
        let token_address = create_token_contract(&env, &admin);
        StellarAssetClient::new(&env, &token_address).mint(&donor, &1_000);

        donation_client.donate(
            &donor,
            &creator,
            &token_address,
            &0,
            &String::from_bytes(&env, b"nope"),
        );
    }
}
