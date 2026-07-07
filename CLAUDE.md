# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this app is

A production business management system for Northern Water Company Ltd (OASIS Springs), a purified water company in northern Kenya, deployed at northernoasiswc.com. It handles sales, payments, debt tracking, production, purchases, expenses, inventory, reporting, assets, and HR. Real money and real business records flow through this system — treat all changes with production-level caution.

## Commands

```bash
npm run dev       # Start Vite dev server with HMR
npm run build     # Production build (run this and fix all TypeScript errors before marking a task done)
npm run preview   # Preview production build locally
npm run lint      # ESLint across all JS/JSX files
```

No test runner is configured.

## Stack

React + TypeScript + Vite + Tailwind CSS 4 + Supabase (PostgreSQL + Auth). Deployed on Netlify; auto-deploys from the GitHub `main` branch. Light-mode UI with a 6-pillar navigation structure.

## Business context

- **Currency is KES everywhere.** Never format as USD or use `$`.
- **Multi-location:** Loglogo, Marsabit, Laisamis, Korr, Merille. Most records are scoped to a location. New features must respect location scoping.
- **Role-based access control exists.** Never bypass or weaken permission checks. When adding a feature, ask which roles should access it if unclear.
- **Production uses a BOM (bill of materials):** producing finished goods deducts raw materials automatically. Do not break this chain when touching production or inventory code.
- Product sizes: 0.5 L, 1.5 L, 5 L, 18.9 L (disposable and refill). Raw materials: bottles, seals, labels, overwraps, caps, stamps, chemicals. Inventory uses carton-level conversions. Casual labour is paid per carton produced.
- Expense types carry a P&L treatment flag (`operating`, `cogs`, or `excluded`).

## Architecture

**The entire application lives in `src/App.jsx`** (~6 000 lines). There is no component splitting — all business logic, UI, and state management are in this one file. `src/supabaseClient.js` exports the Supabase client. `src/main.jsx` is the entry point.

### Navigation

Tab-based SPA with no router library. An `activeTab` state value controls which view renders. The six tabs are: **Home**, **Sales**, **Inventory**, **Expenses**, **Customers**, **HR** (plus a **Reports** section).

### State management

All state lives in `useState` hooks inside `App.jsx`. The central `state` object holds customers, sales, payments, expenses, purchases, production logs, and employees. Data is loaded from Supabase **once per login** — there is no realtime subscription and no periodic refresh, so two concurrently logged-in users do not see each other's changes until they log in again. Inventory changes are auto-persisted on mutation (last-write-wins on a shared `inventory_state` row); other records are written to Supabase on form submit, persist-first (local state only updates after the database confirms the write).

### Authentication & roles

Supabase Auth (email/password). On login, the user's row in the `profiles` table is fetched to get `role` and `location`.

| Role | Access |
|------|--------|
| `admin` | Everything, including all deletes (RLS DELETE policies are admin-only on every financial table) |
| `manager` | Sales, Inventory, Purchases, Expenses, Customers, Reports — no HR, no Cost Settings, no Stock Adjustments, **no deletes** |
| `sales` | Own/location sales & payments, customers at their location, limited inventory, production logging |

Sales-role users have their customer and sales views filtered to `userProfile.location`.

### Supabase tables

`profiles`, `customers`, `sales`, `payments`, `expenses`, `purchases`, `production_logs`, `employees`, `payroll_payments`, `inventory_state`, `cost_settings`, `stock_adjustments`

### Pricing

Sale prices are **not** hardcoded — staff enter the unit price manually on every sale line, so it can vary by customer/order. Carton costs (used to value finished goods and compute P&L COGS) and the casual-labour rate per carton are configurable and stored in `cost_settings`.

### Environment variables

Defined in `.env.local` (not committed):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Both are exposed to the browser via `import.meta.env`.

## Data integrity rules (non-negotiable)

- **Never hard-delete or directly edit financial records** (sales, payments, expenses, purchases). Use the existing delete/reverse flows so the audit trail stays intact.
- **Stock changes must go through stock adjustment flows**, not direct quantity edits.
- **Reports (P&L, Cash Collected, Debtors) must always reconcile with underlying transaction records.** If a change could affect report totals, say so explicitly before implementing.

## Database / Supabase workflow

- **Do not run schema changes or destructive SQL against the live database.**
- For any schema change: write a migration file (SQL) for review and manual application.
- **RLS is the security boundary; UI role checks are convenience only.** Never rely on hiding a button or tab to enforce access control.
- Any new table must have RLS enabled and its policies defined in the same migration that creates it — never in a follow-up.
- Respect existing RLS policies. Flag any change that touches them.

## Git / deploy workflow

- **Never commit directly to `main`.** Always create a feature branch.
- `main` auto-deploys to production via Netlify. Assume anything merged is live.
- Run `npm run build` and fix all TypeScript errors before considering a task done.

## How to work

- For any non-trivial feature: present a short plan first, wait for approval, then implement.
- Explain anything that touches money, deletions, permissions, or report calculations in plain language before and after implementing.
- Prefer small, reviewable changes over large rewrites.
- Match the existing code style and component patterns rather than introducing new libraries or patterns without asking.

## Current focus

- HR module (in progress): employee records, and likely payroll later.
- Ongoing hardening of inventory persistence and stock adjustments.
