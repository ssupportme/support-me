# SupportMe

SupportMe is a creator tipping and donation platform built for easy open source contribution. The current architecture emphasizes a frontend user experience with a backend API layer for creator profiles and donation tracking.

## What changed

- Added a basic backend API in `backend/`
- Added database schema support with Prisma and PostgreSQL
- Created architecture documentation in `docs/architecture.md`
- Added a contributor guide in `CONTRIBUTING.md`
- Updated the roadmap to remove any required smart contract dependency for the current build
- Follow the updated PRD `PRD(v2).md`

## Features

- **Wallet Integration**: Connect Freighter wallet for Stellar payments
- **Creator Profiles**: Public creator pages with shareable usernames
- **Donation Tracking**: Backend-stored donation history
- **Dashboard Support**: API endpoints for reports and analytics
- **Open Source Ready**: Contributor-friendly backend and documentation

## Tech Stack

- **Frontend**: Next.js, React, TypeScript
- **Backend**: Node.js, Express, Prisma
- **Database**: PostgreSQL
- **Wallet**: Stellar / Freighter

## Project Structure

```
.
├── backend/                # Express API and Prisma schema
│   ├── prisma/
│   ├── src/
│   └── .env.example
├── contracts/              # Legacy smart contract examples (not required)
├── docs/                   # Architecture and contribution docs
├── frontend/               # Next.js application
│   ├── app/
│   ├── components/
│   ├── lib/
│   └── types/
├── PRD(v2).md              # Product requirements document
├── CONTRIBUTING.md         # Contribution guide
└── README.md
```

## Installation

### Prerequisites

- Node.js 18+
- PostgreSQL
- Freighter wallet extension for Stellar interaction

### Backend Setup

```bash
cd backend
npm install
cp .env.example .env
# update DATABASE_URL in .env
npm run prisma:generate
npm run dev
```

### Frontend Setup

```bash
cd frontend
npm install
# create frontend/.env.local with your environment variables
npm run dev
```

### Recommended Environment Variables

In `frontend/.env.local`:

```env
NEXT_PUBLIC_STELLAR_NETWORK=TESTNET
NEXT_PUBLIC_HORIZON_URL=https://horizon-testnet.stellar.org
NEXT_PUBLIC_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

## Usage

- Start the backend: `cd backend && npm run dev`
- Start the frontend: `cd frontend && npm run dev`
- Backend health endpoint: `http://localhost:4000/health`

## Documentation

- Architecture flow: `docs/architecture.md`
- Backend API guide: `backend/README.md`
- Contribution guide: `CONTRIBUTING.md`

## Contributing

Please see `CONTRIBUTING.md` for guidelines on making changes, opening issues, and submitting pull requests.

