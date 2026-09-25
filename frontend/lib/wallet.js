import { StellarWalletsKit, Networks } from '@creit.tech/stellar-wallets-kit';
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter';
import { xBullModule } from '@creit.tech/stellar-wallets-kit/modules/xbull';
import { AlbedoModule } from '@creit.tech/stellar-wallets-kit/modules/albedo';
import { RabetModule } from '@creit.tech/stellar-wallets-kit/modules/rabet';
import { LobstrModule } from '@creit.tech/stellar-wallets-kit/modules/lobstr';

const NETWORK_PASSPHRASE = Networks.TESTNET;

let initialized = false;

// Normalized error thrown by every wallet operation in this module. The kit
// and individual wallets reject with plain objects (e.g. `{ code, message }`)
// or loosely-typed messages, so we wrap them in a real Error carrying the
// original `code` for downstream categorization.
export class WalletConnectionError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WalletConnectionError';
    this.code = options.code;
    this.details = options.raw;
  }
}

const toWalletError = (err) => {
  if (err instanceof WalletConnectionError) return err;
  const message =
    err?.message || err?.error?.message || 'Could not connect to your wallet.';
  return new WalletConnectionError(message, {
    code: err?.error?.code ?? err?.code,
    raw: err,
  });
};

const ensureInit = () => {
  if (initialized) return;

  StellarWalletsKit.init({
    network: NETWORK_PASSPHRASE,
    modules: [
      new FreighterModule(),
      new xBullModule(),
      new AlbedoModule(),
      new RabetModule(),
      new LobstrModule(),
    ],
  });

  initialized = true;
};

// Opens the built-in wallet picker modal (Freighter, xBull, Albedo, Rabet, Lobstr)
// and returns the connected public address.
const connectWallet = async () => {
  if (typeof window !== 'undefined' && window.__SUPPORTME_MOCK_WALLET__?.connectWallet) {
    return window.__SUPPORTME_MOCK_WALLET__.connectWallet();
  }
  ensureInit();
  try {
    const { address } = await StellarWalletsKit.authModal();
    return address;
  } catch (err) {
    throw toWalletError(err);
  }
};

const disconnectWallet = async () => {
  if (typeof window !== 'undefined' && window.__SUPPORTME_MOCK_WALLET__?.disconnectWallet) {
    return window.__SUPPORTME_MOCK_WALLET__.disconnectWallet();
  }
  if (!initialized) return;
  await StellarWalletsKit.disconnect();
};

// Signs an XDR transaction using whichever wallet the user picked in the modal.
const signTransaction = async (xdr, address) => {
  if (typeof window !== 'undefined' && window.__SUPPORTME_MOCK_WALLET__?.signTransaction) {
    return window.__SUPPORTME_MOCK_WALLET__.signTransaction(xdr, address);
  }
  ensureInit();
  try {
    return await StellarWalletsKit.signTransaction(xdr, {
      address,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  } catch (err) {
    throw toWalletError(err);
  }
};

// Signs an arbitrary text message (used for the wallet sign-in challenge).
// Returns the base64-encoded signed message.
const signMessage = async (message, address) => {
  if (typeof window !== 'undefined' && window.__SUPPORTME_MOCK_WALLET__?.signMessage) {
    return window.__SUPPORTME_MOCK_WALLET__.signMessage(message, address);
  }
  ensureInit();
  try {
    const { signedMessage } = await StellarWalletsKit.signMessage(message, {
      address,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    return signedMessage;
  } catch (err) {
    throw toWalletError(err);
  }
};

export { connectWallet, disconnectWallet, signTransaction, signMessage };
