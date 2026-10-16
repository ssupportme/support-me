# Testnet Troubleshooting & FAQ

This page maps every user-facing error message in SupportMe to its likely cause on testnet and how to fix it.

## Wallet Errors

### No Stellar wallet detected
**Cause:** No Stellar wallet extension is installed in your browser.

**Fix:** Install a Stellar wallet like [Freighter](https://freighter.app), [xBull](https://xbull.app), or [Albedo](https://albedo.link/).

---

### Wallet connection cancelled
**Cause:** You cancelled the wallet connection request in your wallet extension.

**Fix:** Click the connect button again and approve the request in your wallet.

---

### Wrong network
**Cause:** Your wallet is set to Mainnet or Futurenet instead of Testnet.

**Fix:** Open your wallet extension and switch to **Testnet**. SupportMe only runs on Stellar testnet.

---

### Could not connect your wallet
**Cause:** The wallet extension is not responding or there's a network issue.

**Fix:** 
1. Refresh the page
2. Make sure your wallet extension is unlocked
3. Try reconnecting

---

## Donation/Subscription Errors

### Signature declined
**Cause:** You cancelled the transaction signing request in your wallet.

**Fix:** Try again and approve the transaction in your wallet. No funds were moved.

---

### Not enough balance
**Cause:** Your account doesn't have enough XLM (or the token you're sending) to cover the donation + transaction fee.

**Fix:** 
1. Fund your account with [Friendbot](https://friendbot.stellar.org/) if it's new
2. Make sure you have enough XLM for the transaction fee (~0.00001 XLM)
3. If you're donating USDC, make sure you have a USDC trustline and enough USDC balance

---

### Transaction rejected
**Cause:** The transaction simulation failed. This can be due to:
- Contract paused
- Below minimum donation amount
- Token not allowed
- Soroban RPC outage

**Fix:** 
1. Check if the contract is paused (try again in a few minutes)
2. Make sure your donation is above the minimum
3. Try a different token
4. Refresh the page and try again

---

### Confirmation timed out
**Cause:** The transaction was submitted but not confirmed within the expected time.

**Fix:** 
1. Check your transaction on [stellar.expert](https://stellar.expert/explorer/public)
2. If it's still pending, wait a few more minutes
3. If it failed, try again

---

### Transaction failed
**Cause:** The transaction was submitted but failed on-chain.

**Fix:** Check the error message in the transaction details on stellar.expert.

---

### Network error
**Cause:** There's a network connectivity issue.

**Fix:** 
1. Check your internet connection
2. Refresh the page
3. Try again

---

## Anchor / Cash-out Errors

### The anchor window was blocked. Allow popups for this site and try again.
**Cause:** Your browser blocked the anchor popup window.

**Fix:** Allow popups for this site and try again.

---

### Trustline missing
**Cause:** You don't have a trustline for the anchor's asset (e.g. SRT).

**Fix:** Add a trustline for the anchor's asset in your wallet first.

---

## FAQ

### Why is my USD total lower than my balance?
The price feed updates periodically. Your balance in XLM (or other tokens) is converted to USD using the current price. Small fluctuations are normal.

---

### Why did my subscription stop charging?
Your subscription stops charging when:
- You cancel it
- Your allowance runs out
- The executor can't process the payment (insufficient balance, etc.)

---

### How do I see my transaction on stellar.expert?
1. Copy your transaction hash
2. Go to [stellar.expert](https://stellar.expert/explorer/public)
3. Paste the transaction hash in the search bar

---

### Why does cash-out open a popup?
Cash-out uses SEP-24 interactive anchor flow, which opens a popup window for the anchor's KYC/bank form. This is required by the anchor provider.
