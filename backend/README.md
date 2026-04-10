# SupportMe Backend

This backend is a lightweight API layer for the SupportMe application.
It is built with TypeScript, Express, and Prisma, and is designed to support creator profiles, donations, and backend-driven dashboards.

## Features

- REST API for creators and donations
- PostgreSQL-compatible Prisma schema
- Local development server with hot reload
- Clear extension points for contributors

## Getting Started

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Create a `.env` from the example:
   ```bash
   cp .env.example .env
   ```

3. Set your database URL in `.env`.

4. Generate Prisma client:
   ```bash
   npm run prisma:generate
   ```

5. Run the backend in development mode:
   ```bash
   npm run dev
   ```

6. Visit the health check:
   ```bash
   http://localhost:4000/health
   ```

## API Endpoints

- `GET /health`
- `GET /api/creators`
- `POST /api/creators`
- `GET /api/creators/:username`
- `PUT /api/creators/:username`
- `GET /api/donations?creatorUsername={username}`
- `POST /api/donations`

## Notes for Contributors

- The backend is intentionally simple so contributors can add authentication, payment workflows, and dashboard queries.
- There is no contract dependency for this API layer.
- If you add a new database model, update `prisma/schema.prisma` and run `npm run prisma:generate`.
