# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Start Vite dev server with HMR
npm run build     # Production build
npm run preview   # Preview production build locally
npm run lint      # ESLint across all JS/JSX files
```

No test runner is configured.

## Architecture

**Stack:** React 19 + Vite + Tailwind CSS 4 + Supabase (PostgreSQL + Auth). Plain JavaScript (no TypeScript).

**The entire application lives in `src/App.jsx`** (~5 000 lines). There is no component splitting — all business logic, UI, and state management are in this one file. `src/supabaseClient.js` exports the Supabase client. `src/main.jsx` is the entry point.

### Navigation

Tab-based SPA with no router library. An `activeTab` state value controls which view renders. The six tabs are: **Home**, **Sales**, **Inventory**, **Expenses**, **Customers**, **HR** (plus a **Reports** section).

### State management

All state lives in `useState` hooks inside `App.jsx`. The central `state` object holds customers, sales, payments, expenses, purchases, production logs, and employees. On app start, data is loaded from Supabase and merged into this object. Inventory changes are auto-persisted on mutation; other records are written to Supabase on form submit.

A `useRef` guard (`isEditingRef`) prevents Supabase subscription callbacks from overwriting form fields the user is actively editing.

### Authentication & roles

Supabase Auth (email/password). On login, the user's row in the `profiles` table is fetched to get `role` and `location`.

| Role | Access |
|------|--------|
| `admin` | Everything |
| `manager` | Sales, Inventory, Customers, Reports — no Expenses, no HR |
| `sales` | Own sales & payments, customers at their location, limited inventory |

Sales-role users have their customer and sales views filtered to `userProfile.location`.

### Supabase tables

`profiles`, `customers`, `sales`, `payments`, `expenses`, `purchases`, `production_logs`, `employees`, `payroll_payments`, `inventory_state`, `cost_settings`, `stock_adjustments`

### Business domain

Northern Oasis Water — a water-bottling business. Product sizes: 0.5 L, 1.5 L, 5 L, 18.9 L (disposable and refill). Raw materials tracked: bottles, seals, labels, overwraps, caps, stamps, chemicals. Inventory uses carton-level conversions. Casual labour is paid per carton produced. Expense types carry a P&L treatment flag (`operating`, `cogs`, or `excluded`).

### Pricing (hardcoded in App.jsx)

| Size | Unit price (KES) |
|------|-----------------|
| 0.5 L | 100 |
| 1.5 L | 150 |
| 5 L | 350 |
| 18.9 L | 650 |

Carton costs and casual-labour rate per carton are configurable and stored in `cost_settings`.

### Environment variables

Defined in `.env.local` (not committed):

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Both are exposed to the browser via `import.meta.env`.
