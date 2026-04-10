# SupportMe — Product Requirements Document

**Version:** 1.0  
**Date:** March 2026  
**Project:** SupportMe — Static Donation Page on Stellar Testnet  
**Stack:** Next.js · Stellar SDK · Freighter Wallet · Soroban

---

## 1. Overview

SupportMe is a static, shareable donation page built on the Stellar blockchain (testnet). It allows individuals to receive XLM tips from supporters via a public URL. The page auto-generates a QR code from its own URL, making it easy to share in person or digitally. Supporters can connect their Freighter wallet, send a donation, and receive real-time transaction feedback. Creators can track incoming donations from a personal dashboard.

---

## 2. Goals

- Provide a frictionless, one-page donation experience for creators and individuals.
- Leverage Stellar testnet for safe, fast, and low-cost transactions.
- Offer a shareable QR code tied to the user's unique support page URL.
- Give donors clear transaction feedback (success/failure, hash).
- Give recipients a dashboard to track donation history.

---

## 3. Design Tokens

| Token | Value |
|---|---|
| Primary Accent | `#6366F1` |
| Background | `#FFFFFF` |
| Card | `#F8F9FB` |
| Text | `#1F2937` |
| Border | `#E5E7EB` |

All UI components must strictly follow these tokens. No external color values should be introduced without explicit design approval.

---

## 4. User Roles

| Role | Description |
|---|---|
| **Creator** | The individual who owns and shares the SupportMe page |
| **Supporter** | A visitor who connects their wallet and sends a tip |

---

## 5. Feature Requirements

### 5.1 Wallet Setup

**Requirement:** Integrate Freighter as the sole wallet provider for this application.

- The app targets **Stellar Testnet** exclusively during this phase.
- Freighter must be detected on page load. If not installed, show a clear prompt with a link to the Freighter extension.
- Network must be validated on connection — reject Mainnet connections with a user-facing error.

**Environment Configuration (`next.config.js` / `.env.local`):**

```env
NEXT_PUBLIC_STELLAR_NETWORK=TESTNET
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

**Dependencies:**

```bash
npm install @stellar/stellar-sdk @stellar/freighter-api
```

**Freighter Detection Example:**

```typescript
import { isConnected } from "@stellar/freighter-api";

const checkFreighter = async () => {
  const connected = await isConnected();
  if (!connected) {
    // Render install prompt UI
  }
};
```

---

### 5.2 Wallet Connection

**Requirement:** Users must be able to connect and disconnect their Freighter wallet within the UI.

#### 5.2.1 Connect Wallet

- A **"Connect Wallet"** button is displayed prominently when no wallet is connected.
- On click, trigger Freighter's `requestAccess()`.
- On success, store the public key in component state (not localStorage).
- Display a truncated public key (e.g., `GBXXX...YYYY`) in the header once connected.
- Show a loading/spinner state while the connection request is pending.

**Connect Logic Example:**

```typescript
import { requestAccess, getPublicKey } from "@stellar/freighter-api";

const connectWallet = async () => {
  try {
    await requestAccess();
    const publicKey = await getPublicKey();
    setWalletAddress(publicKey);
  } catch (error) {
    setError("Wallet connection was rejected.");
  }
};
```

#### 5.2.2 Disconnect Wallet

- A **"Disconnect"** option is available when a wallet is connected (e.g., dropdown or secondary button).
- On disconnect, clear all wallet state from the component: address, balance, transaction history.
- Return the UI to the pre-connection state.

**Disconnect Logic Example:**

```typescript
const disconnectWallet = () => {
  setWalletAddress(null);
  setBalance(null);
};
```

---

### 5.3 Balance Handling

**Requirement:** Fetch and display the connected wallet's XLM balance after a successful connection.

- Query Horizon testnet for account details using the connected public key.
- Extract the native XLM balance from the account balances array.
- Display the balance in a clearly labeled card component within the UI.
- Refresh balance automatically after every outgoing transaction.
- Handle the case where the account has not yet been funded (show a "Account not funded" message with a link to Friendbot).

**Balance Fetch Example:**

```typescript
import StellarSdk from "@stellar/stellar-sdk";

const server = new StellarSdk.Horizon.Server(
  "https://horizon-testnet.stellar.org"
);

const fetchBalance = async (publicKey: string) => {
  try {
    const account = await server.loadAccount(publicKey);
    const xlmBalance = account.balances.find(
      (b) => b.asset_type === "native"
    );
    setBalance(xlmBalance?.balance ?? "0");
  } catch (error) {
    setBalance(null);
    setError("Account not found. Fund it via Stellar Friendbot.");
  }
};
```

**UI Display:**

```
┌─────────────────────────────┐
│  Your XLM Balance           │
│  ─────────────────────────  │
│  1,250.00 XLM               │
└─────────────────────────────┘
```

Card background: `#F8F9FB` | Text: `#1F2937` | Border: `#E5E7EB`

---

### 5.4 Transaction Flow

**Requirement:** Allow a supporter to send an XLM tip to the creator's Stellar address on testnet, with clear success/failure feedback.

#### 5.4.1 Transaction UI

- Display an amount input field (numeric, min 1 XLM, no decimals beyond 7 places).
- Display the creator's destination address (read-only, pre-filled from the page config).
- A **"Send Tip"** button initiates the transaction.
- Button is disabled if: no wallet is connected, amount is invalid, or a transaction is in progress.

#### 5.4.2 Transaction Logic

```typescript
import StellarSdk from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

const sendTip = async (amount: string, destinationAddress: string) => {
  setTxStatus("pending");

  try {
    const sourceAccount = await server.loadAccount(walletAddress);

    const transaction = new StellarSdk.TransactionBuilder(sourceAccount, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destinationAddress,
          asset: StellarSdk.Asset.native(),
          amount: amount,
        })
      )
      .setTimeout(30)
      .build();

    const signedXdr = await signTransaction(transaction.toXDR(), {
      network: "TESTNET",
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });

    const signedTx = StellarSdk.TransactionBuilder.fromXDR(
      signedXdr,
      StellarSdk.Networks.TESTNET
    );

    const result = await server.submitTransaction(signedTx);
    setTxStatus("success");
    setTxHash(result.hash);
    fetchBalance(walletAddress); // Refresh balance
  } catch (error) {
    setTxStatus("error");
    setTxError(error?.message ?? "Transaction failed.");
  }
};
```

#### 5.4.3 Transaction Feedback States

| State | UI Behaviour |
|---|---|
| `idle` | Show amount input and send button |
| `pending` | Disable button, show spinner, display "Awaiting signature…" |
| `success` | Show green confirmation card with transaction hash and Stellar Explorer link |
| `error` | Show red error card with error message and retry option |

**Success Feedback Example:**

```
✅ Tip Sent Successfully!
Transaction Hash: a3f8...d92c
[View on Stellar Explorer →]
```

**Error Feedback Example:**

```
❌ Transaction Failed
Insufficient balance or network error.
[Try Again]
```

---

### 5.5 QR Code — Page URL to QR

**Requirement:** Automatically convert the current support page URL into a QR code for easy sharing.

- On page load, read `window.location.href` to get the current URL.
- Generate a QR code from this URL and display it on the support page.
- The QR code should be download-able as a PNG.
- Style the QR code using the brand's primary accent color (`#6366F1`) for foreground and white (`#FFFFFF`) for background.

**Dependency:**

```bash
npm install qrcode.react
```

**QR Code Component Example:**

```tsx
import { QRCodeSVG } from "qrcode.react";

const PageQRCode = () => {
  const pageUrl = typeof window !== "undefined" ? window.location.href : "";

  return (
    <div className="qr-wrapper">
      <QRCodeSVG
        value={pageUrl}
        size={180}
        fgColor="#6366F1"
        bgColor="#FFFFFF"
        level="H"
      />
      <p>Scan to support</p>
    </div>
  );
};
```

---

### 5.6 Donation Tracking Dashboard

**Requirement:** Creators can view a history of all donations received to their Stellar address.

- Accessible via a `/dashboard` route (protected by wallet connection check).
- Fetch incoming payment operations for the creator's address from Horizon.
- Display a list/table of donations with: sender address, amount (XLM), date/time, and transaction hash.
- Implement cursor-based pagination (load more button) for large histories.
- Show a running total of all donations received.

**Dashboard Data Fetch Example:**

```typescript
const fetchDonations = async (creatorAddress: string) => {
  const payments = await server
    .payments()
    .forAccount(creatorAddress)
    .order("desc")
    .limit(20)
    .call();

  const donations = payments.records
    .filter(
      (p) =>
        p.type === "payment" &&
        p.asset_type === "native" &&
        p.to === creatorAddress
    )
    .map((p) => ({
      from: p.from,
      amount: p.amount,
      createdAt: p.created_at,
      hash: p.transaction_hash,
    }));

  setDonations(donations);
};
```

**Dashboard UI Layout:**

```
┌─────────────────────────────────────────────────────┐
│  SupportMe Dashboard                                │
│  Total Received: 3,400.00 XLM                       │
├──────────────┬───────────┬────────────┬─────────────┤
│  From        │  Amount   │  Date      │  Tx Hash    │
├──────────────┼───────────┼────────────┼─────────────┤
│  GBXXX...    │  50 XLM   │ Mar 12 26  │  a3f8...    │
│  GCYYY...    │  100 XLM  │ Mar 11 26  │  b7c2...    │
└──────────────┴───────────┴────────────┴─────────────┘
```

---

## 6. Page Structure

### 6.1 Support Page (`/[username]` or `/`)

| Section | Content |
|---|---|
| Header | SupportMe logo + wallet connect/disconnect button |
| Hero | Creator name, avatar placeholder, short bio |
| QR Code Card | Auto-generated QR from page URL + download button |
| Wallet Card | Connected wallet address + XLM balance |
| Donation Card | Amount input + Send Tip button |
| Transaction Feedback | Success or error state after transaction |
| Footer | Powered by Stellar |

### 6.2 Dashboard Page (`/dashboard`)

| Section | Content |
|---|---|
| Header | SupportMe logo + connected wallet |
| Summary Card | Total XLM received, number of donations |
| Donations Table | From, Amount, Date, Tx Hash with pagination |

---

## 7. Error Handling Requirements

| Scenario | Expected Behaviour |
|---|---|
| Freighter not installed | Show install prompt with extension link |
| User rejects wallet connection | Show dismissible error banner |
| Wrong network (Mainnet) | Block connection, show network mismatch message |
| Account not funded | Show Friendbot link for testnet funding |
| Insufficient balance | Show inline validation before submission |
| Transaction rejected by user | Reset to idle state, show dismissible message |
| Horizon API error | Show retry button with error detail |
| Invalid destination address | Show inline validation error |

---

## 8. Development Standards

### 8.1 Project Structure

```
support-me/
├── contracts/                  # Soroban Rust contracts
├── frontend/
│   ├── src/
│   │   ├── app/
│   │   │   ├── page.tsx        # Support page
│   │   │   ├── dashboard/
│   │   │   │   └── page.tsx    # Donation dashboard
│   │   ├── components/
│   │   │   ├── Button.tsx
│   │   │   ├── ConnectWalletButton.tsx
│   │   │   ├── BalanceCard.tsx
│   │   │   ├── DonationForm.tsx
│   │   │   ├── TxFeedback.tsx
│   │   │   ├── PageQRCode.tsx
│   │   │   └── DonationsTable.tsx
│   │   ├── hooks/
│   │   │   ├── useWallet.ts
│   │   │   ├── useBalance.ts
│   │   │   └── useDonations.ts
│   │   ├── lib/
│   │   │   ├── stellar.ts      # Horizon server config
│   │   │   └── transactions.ts # Transaction builder
│   │   └── types/
│   │       └── index.ts
│   ├── .env.local
│   └── package.json
```

### 8.2 Coding Standards

- **Language:** TypeScript strict mode
- **Styling:** Tailwind CSS utility classes only — no inline styles
- **State Management:** React `useState` / `useReducer` — no external store needed
- **No browser storage:** Do not use `localStorage` or `sessionStorage` for wallet state
- **Async handling:** All Stellar and Freighter calls must be wrapped in `try/catch`
- **Environment variables:** All network config via `.env.local`, prefixed `NEXT_PUBLIC_`
- **No hardcoded addresses:** Creator address must come from environment config

### 8.3 Accessibility

- All interactive elements must have `aria-label` attributes
- Color contrast must meet WCAG AA (primary accent `#6366F1` on white passes)
- Loading states must be communicated via `aria-live` regions

---

## 9. Out of Scope (v1.0)

- Mainnet support
- Multi-currency donations (USDC, etc.)
- Custom tip amounts beyond a single input field
- Social sharing integrations
- Authentication / user accounts (wallet address is the identity)
- Smart contract tipping logic (direct Horizon payments only for v1)

---

## 10. Success Metrics

| Metric | Target |
|---|---|
| Wallet connection success rate | > 95% |
| Transaction success rate | > 98% (testnet) |
| Page load time | < 2 seconds |
| QR code generation | Instant (client-side) |
| Dashboard donation load time | < 3 seconds |

---

*SupportMe PRD v1.0 — Built on Stellar Testnet*