#!/usr/bin/env bash
set -euo pipefail

# SupportMe Testnet Deployment Script
# Automates building contracts, deploying to testnet, salt derivation,
# constructor initialization, executor registration, and updating deployments/testnet.json.

NETWORK="${NETWORK:-testnet}"
RPC_URL="${SOROBAN_RPC_URL:-https://soroban-testnet.stellar.org}"
NETWORK_PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
ADMIN_KEY="${ADMIN_KEY:-admin}"
DEPLOYMENTS_FILE="deployments/testnet.json"

FRESH_KEYS=false
for arg in "$@"; do
  case $arg in
    --fresh-keys)
      FRESH_KEYS=true
      shift
      ;;
  esac
done

echo "=== SupportMe Testnet Deployer ==="
echo "Network: $NETWORK"
echo "RPC URL: $RPC_URL"

if [ "$FRESH_KEYS" = true ]; then
  echo "Generating fresh keys for deployer and executor..."
  stellar keys generate deployer --network "$NETWORK" || true
  stellar keys generate executor --network "$NETWORK" || true
  ADMIN_KEY="deployer"
  EXECUTOR_KEY="executor"
else
  EXECUTOR_KEY="${EXECUTOR_KEY:-executor}"
fi

ADMIN_ADDRESS=$(stellar keys address "$ADMIN_KEY" 2>/dev/null || echo "")
EXECUTOR_ADDRESS=$(stellar keys address "$EXECUTOR_KEY" 2>/dev/null || echo "")

echo "Admin address: ${ADMIN_ADDRESS:-<not-set>}"
echo "Executor address: ${EXECUTOR_ADDRESS:-<not-set>}"

echo "Step 1: Building Wasm artifacts..."
# The optimized build is what must be deployed: the raw cargo output exceeds
# Soroban's 64 KB contract size limit.
stellar contract build --optimize --locked

REGISTRY_WASM="target/wasm32v1-none/release/creator_registry.wasm"
DONATION_WASM="target/wasm32v1-none/release/donation.wasm"

if [ ! -f "$REGISTRY_WASM" ] || [ ! -f "$DONATION_WASM" ]; then
  echo "Error: Contract Wasm artifacts not found!"
  exit 1
fi

REGISTRY_WASM_HASH=$(sha256sum "$REGISTRY_WASM" 2>/dev/null | cut -d ' ' -f 1 || openssl dgst -sha256 "$REGISTRY_WASM" | awk '{print $NF}')
DONATION_WASM_HASH=$(sha256sum "$DONATION_WASM" 2>/dev/null | cut -d ' ' -f 1 || openssl dgst -sha256 "$DONATION_WASM" | awk '{print $NF}')

echo "Step 2: Deriving Registry ID from salt and deploying contracts to $NETWORK..."
SALT=$(openssl rand -hex 32)
REGISTRY_ID=$(stellar contract id wasm --salt "$SALT" --source-account "$ADMIN_KEY" --network "$NETWORK" | tail -n 1 | tr -d '\r')
echo "Pre-computed Creator Registry ID: $REGISTRY_ID"

DONATION_DEPLOY=$(stellar contract deploy \
  --wasm "$DONATION_WASM" \
  --source-account "$ADMIN_KEY" --network "$NETWORK" -- \
  --admins "[\"$ADMIN_ADDRESS\"]" --threshold 1 --timelock_delay 0 \
  --registry "$REGISTRY_ID")
DONATION_ID=$(echo "$DONATION_DEPLOY" | tail -n 1 | tr -d '\r')
echo "Deployed Donation Contract ID: $DONATION_ID"
echo "Deployed Creator Registry ID: $REGISTRY_ID"

REGISTRY_DEPLOY=$(stellar contract deploy \
  --wasm "$REGISTRY_WASM" \
  --salt "$SALT" \
  --source-account "$ADMIN_KEY" --network "$NETWORK" -- \
  --admins "[\"$ADMIN_ADDRESS\"]" --threshold 1 --timelock_delay 0 \
  --donation_contract "$DONATION_ID")
ACTUAL_REGISTRY_ID=$(echo "$REGISTRY_DEPLOY" | tail -n 1 | tr -d '\r')
echo "Deployed Creator Registry ID: $ACTUAL_REGISTRY_ID"

if [ "$ACTUAL_REGISTRY_ID" != "$REGISTRY_ID" ]; then
  echo "Error: Registry ID mismatch! Expected $REGISTRY_ID but got $ACTUAL_REGISTRY_ID"
  exit 1
fi

if [ -n "$EXECUTOR_ADDRESS" ]; then
  echo "Step 3: Configuring executor on donation contract..."
  stellar contract invoke --id "$DONATION_ID" \
    --source-account "$ADMIN_KEY" --network "$NETWORK" -- \
    set_executor --executor "$EXECUTOR_ADDRESS"
fi

echo "Step 4: Verifying deployment..."
stellar contract info interface --id "$DONATION_ID" --network "$NETWORK"
stellar contract info interface --id "$REGISTRY_ID" --network "$NETWORK"

echo "=== Deployment Successful ==="
echo ""
echo "Update your environment with:"
echo "NEXT_PUBLIC_DONATION_CONTRACT_ID=$DONATION_ID"
echo "NEXT_PUBLIC_CREATOR_REGISTRY_CONTRACT_ID=$REGISTRY_ID"
echo ""

# Merge deployment details into deployments/testnet.json without overwriting tokens or history
mkdir -p deployments
node -e '
const fs = require("fs");
const file = process.env.DEPLOYMENTS_FILE;
let data = {};
if (fs.existsSync(file)) {
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    data = {};
  }
}
if (!data.history) data.history = [];
if (data.contracts && data.contracts.donation?.id) {
  data.history.push({
    deployedAt: data.deployedAt,
    admin: data.admin,
    executor: data.executor,
    contracts: data.contracts
  });
}
data.network = process.env.NETWORK;
data.rpcUrl = process.env.RPC_URL;
data.networkPassphrase = process.env.NETWORK_PASSPHRASE;
data.deployedAt = new Date().toISOString();
if (process.env.ADMIN_ADDRESS) data.admin = process.env.ADMIN_ADDRESS;
if (process.env.EXECUTOR_ADDRESS) data.executor = process.env.EXECUTOR_ADDRESS;
if (!data.contracts) data.contracts = {};
data.contracts.donation = {
  id: process.env.DONATION_ID,
  wasmHash: process.env.DONATION_WASM_HASH || data.contracts.donation?.wasmHash || "",
  deployTxHash: process.env.DONATION_TX_HASH || data.contracts.donation?.deployTxHash || ""
};
data.contracts.creatorRegistry = {
  id: process.env.REGISTRY_ID,
  wasmHash: process.env.REGISTRY_WASM_HASH || data.contracts.creatorRegistry?.wasmHash || "",
  deployTxHash: process.env.REGISTRY_TX_HASH || data.contracts.creatorRegistry?.deployTxHash || ""
};
if (!data.tokens) data.tokens = {};
fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
' DEPLOYMENTS_FILE="$DEPLOYMENTS_FILE" NETWORK="$NETWORK" RPC_URL="$RPC_URL" \
  NETWORK_PASSPHRASE="$NETWORK_PASSPHRASE" ADMIN_ADDRESS="$ADMIN_ADDRESS" \
  EXECUTOR_ADDRESS="$EXECUTOR_ADDRESS" DONATION_ID="$DONATION_ID" \
  REGISTRY_ID="$REGISTRY_ID" DONATION_WASM_HASH="$DONATION_WASM_HASH" \
  REGISTRY_WASM_HASH="$REGISTRY_WASM_HASH" DONATION_TX_HASH="" REGISTRY_TX_HASH=""

echo "Saved deployment details to $DEPLOYMENTS_FILE"
