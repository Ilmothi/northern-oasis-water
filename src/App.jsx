import { useState, useEffect, useRef } from 'react';
import { BarChart3, Package, Users, DollarSign, ClipboardList, TrendingUp, Plus, Edit2, Trash2, X, Save, Download, ShoppingCart, Wallet, Search, Filter, ChevronRight, ChevronDown, Maximize2, Minimize2 } from 'lucide-react';
import { supabase } from './supabaseClient';
import { OASIS_LOGO } from './oasisLogo';

// Seller details printed on customer invoices.
const COMPANY = {
  name: 'Northern Oasis Water Company',
  brand: 'OASIS Springs — Purified Drinking Water',
  phone: '0718662867',
  kraPin: 'P052211072N',
};

// Today's date in LOCAL time as YYYY-MM-DD. Record dates and "this month"
// filters must use local time (Kenya, UTC+3), not toISOString() (UTC) —
// otherwise entries between midnight and 3 a.m. are dated to the previous
// day, and on the 1st of the month booked to the previous month.
// DB timestamps (updated_at etc.) still use toISOString(), which is correct.
const localDateString = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Current month in LOCAL time as YYYY-MM, for month-to-date filters.
const localMonthPrefix = () => localDateString().slice(0, 7);

// Escape user-entered text (names, descriptions, references) before it is
// interpolated into the printable-HTML documents opened via document.write —
// otherwise a value containing markup would render (or run) in that window.
const escapeHtml = (v) => String(v ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

// Group a date-sorted transaction list into one bucket per day.
// Input order is preserved (callers pass already-sorted lists), so the
// returned groups stay in the same date order. Pure display helper — it
// only sums amounts that are already in the list, never reads records.
const groupByDay = (list) => {
  const groups = [];
  const byDate = new Map();
  list.forEach(item => {
    let group = byDate.get(item.date);
    if (!group) {
      group = { date: item.date, total: 0, items: [] };
      byDate.set(item.date, group);
      groups.push(group);
    }
    group.total += item.amount;
    group.items.push(item);
  });
  return groups;
};

// ─── Shared presentational primitives ───────────────────────────────
// Small, style-only building blocks reused across modules. No business
// logic lives here — callers pass already-computed values.

const ACCENT_STYLES = {
  sky: 'bg-sky-50 text-sky-600',
  emerald: 'bg-emerald-50 text-emerald-600',
  rose: 'bg-rose-50 text-rose-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-600',
};

// Summary tile: label + big value + optional sub-text and accent icon.
// Renders as a button when onClick is provided (e.g. dashboard drill-downs).
function StatCard({ label, value, icon: Icon, accent = 'sky', sub, onClick }) {
  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-slate-500 text-[11px] md:text-xs font-medium uppercase tracking-wide">{label}</p>
        <p className="text-slate-900 text-lg md:text-2xl font-bold mt-2 break-words">{value}</p>
        {sub && <p className="text-slate-400 text-xs mt-1">{sub}</p>}
      </div>
      {Icon && (
        <div className={`flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center ${ACCENT_STYLES[accent] || ACCENT_STYLES.sky}`}>
          <Icon className="w-5 h-5" />
        </div>
      )}
    </div>
  );
  const base = 'bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-5';
  if (onClick) {
    return (
      <button onClick={onClick} className={`${base} text-left w-full hover:border-sky-300 transition cursor-pointer`}>
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}

const BADGE_STYLES = {
  slate: 'bg-slate-100 text-slate-600',
  emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700',
  sky: 'bg-sky-50 text-sky-700',
  amber: 'bg-amber-50 text-amber-700',
};

// Pill label with an optional leading status dot.
function Badge({ children, color = 'slate', dot = false }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap ${BADGE_STYLES[color] || BADGE_STYLES.slate}`}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

const initialState = {
  rawMaterials: {
    emptyBottles: {
      '0.5L': 5000,
      '1.5L': 3000,
      '5L': 800,
      '18.9L_disposable': 400,
      '18.9L_refill': 300
    },
    overwraps: {
      '0.5L': 3000,
      '1.5L': 3000,
      '5L': 2000
    },
    seals: {
      'short_neck': 20000,  // For both 0.5L and 1.5L bottles
      '5L': 4000,
      '18.9L': 2000
    },
    labels: {
      '0.5L': 15000,
      '1.5L': 10000,
      '5L': 3000,
      '18.9L': 1500
    },
    caps: {
      '18.9L': 2000
    },
    kraStamps: 50000,
    roChemical: 1000
  },

  finishedGoods: {
    '0.5L': { quantity: 200, bottlesPerCarton: 24 },
    '1.5L': { quantity: 150, bottlesPerCarton: 12 },
    '5L': { quantity: 80, bottlesPerCarton: 4 },
    '18.9L_disposable': { quantity: 100, bottlesPerCarton: 1 },
    '18.9L_refill': { quantity: 60, bottlesPerCarton: 1 }
  },

  // Transactional records start EMPTY and are filled from Supabase on login.
  // (These used to hold hardcoded demo rows — "Loglogo Store", INV-001, fake
  // balances — which showed as if they were real whenever a fetch returned no
  // rows. Real records only, always.)
  customers: [],
  sales: [],
  payments: [],
  productionLogs: [],
  purchases: [],
  expenses: [],
  // Append-only ledger of stock moved between the plant and consignment shops.
  // Stock on hand at a shop is derived by summing this (see getConsignmentOnHand).
  consignmentMovements: [],

  locations: ['Loglogo', 'Marsabit', 'Laisamis', 'Korr', 'Merille'],

  // Pricing is now entered manually per sale - no auto-pricing from location

  expenseCategories: {
    'Raw Materials': ['Empty Bottles', 'Overwraps', 'Seals', 'Labels', 'KRA Stamps', 'RO Machine Chemicals'],
    'Labour': ['Salaries', 'Casual Pay', 'Overtime'],
    'Operations': ['Rent', 'Electricity', 'Water', 'Transport', 'Maintenance', 'Other']
  },

  rawMaterialOptions: {
    'Empty Bottles - 0.5L': { material: 'emptyBottles_0.5L', category: 'Empty Bottles' },
    'Empty Bottles - 1.5L': { material: 'emptyBottles_1.5L', category: 'Empty Bottles' },
    'Empty Bottles - 5L': { material: 'emptyBottles_5L', category: 'Empty Bottles' },
    'Empty Bottles - 18.9L Disposable': { material: 'emptyBottles_18.9L_disposable', category: 'Empty Bottles' },
    'Empty Bottles - 18.9L Refill': { material: 'emptyBottles_18.9L_refill', category: 'Empty Bottles' },
    'Overwraps - 0.5L': { material: 'overwraps_0.5L', category: 'Overwraps' },
    'Overwraps - 1.5L': { material: 'overwraps_1.5L', category: 'Overwraps' },
    'Overwraps - 5L': { material: 'overwraps_5L', category: 'Overwraps' },
    'Seals - Short Neck (0.5L & 1.5L)': { material: 'seals_short_neck', category: 'Seals' },
    'Seals - 5L': { material: 'seals_5L', category: 'Seals' },
    'Seals - 18.9L': { material: 'seals_18.9L', category: 'Seals' },
    'Labels - 0.5L': { material: 'labels_0.5L', category: 'Labels' },
    'Labels - 1.5L': { material: 'labels_1.5L', category: 'Labels' },
    'Labels - 5L': { material: 'labels_5L', category: 'Labels' },
    'Labels - 18.9L': { material: 'labels_18.9L', category: 'Labels' },
    'Caps - 18.9L': { material: 'caps_18.9L', category: 'Caps' },
    'KRA Stamps': { material: 'kraStamps', category: 'KRA Stamps' },
    'RO Machine Chemicals': { material: 'roChemical', category: 'RO Machine Chemicals' }
  }
};

// Sizes available on a sale. Prices are NOT hardcoded — staff enter the
// price manually for each line so it can vary by customer / order.
const SALE_SIZES = ['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill', 'refill_10L', 'refill_15L', 'refill_20L'];

// Friendly labels for sale item sizes
const SIZE_LABELS = {
  '0.5L': '0.5L',
  '1.5L': '1.5L',
  '5L': '5L',
  '18.9L_disposable': '18.9L Disposable',
  '18.9L_refill': '18.9L Refill (bottle)',
  'refill_10L': 'Water Refill 10L',
  'refill_15L': 'Water Refill 15L',
  'refill_20L': 'Water Refill 20L'
};

// Expense types, each tagged with its P&L treatment:
//   'operating'  -> counts in the P&L as an operating expense (below gross profit)
//   'cogs'       -> a raw-material / purchase cost (already in carton costs); recorded but NOT operating
//   'excluded'   -> recorded for cash tracking only; NOT in P&L at all
const EXPENSE_TYPES = [
  // Operating — affects P&L
  { name: 'Rent', treatment: 'operating' },
  { name: 'Raw Water', treatment: 'operating' },
  { name: 'Statutory Payments', treatment: 'operating' },
  { name: 'Salary', treatment: 'operating' },
  { name: 'Chemicals & Filters', treatment: 'operating' },
  { name: 'Equipment Maintenance & Repair', treatment: 'operating' },
  { name: 'Staff Welfare', treatment: 'operating' },
  { name: 'Marketing', treatment: 'operating' },
  { name: 'Administrative Costs', treatment: 'operating' },
  { name: 'Heat Gun Purchase & Repair', treatment: 'operating' },
  { name: 'Security Expenses', treatment: 'operating' },
  { name: 'Premises Maintenance', treatment: 'operating' },
  { name: 'Delivery Expenses', treatment: 'operating' },
  { name: 'Electricity', treatment: 'operating' },
  { name: 'Generator Expenses', treatment: 'operating' },
  { name: 'Lorry Expenses', treatment: 'operating' },
  { name: 'Date Stamp Ink', treatment: 'operating' },
  { name: 'Transport Expenses', treatment: 'operating' },
  { name: 'LPG Gas Blow Torch', treatment: 'operating' },
  { name: 'Directors', treatment: 'operating' },
  { name: 'Offloading & Onloading', treatment: 'operating' },
  { name: 'Loan Interest', treatment: 'operating' },
  // Casual labour is an operating expense — it is NOT part of the carton cost / COGS.
  { name: 'Casual Labour', treatment: 'operating' },
  // Purchases / COGS — recorded, not operating
  { name: 'Bottles Costs', treatment: 'cogs' },
  { name: 'Labels Costs', treatment: 'cogs' },
  { name: 'KRA Stamp Costs', treatment: 'cogs' },
  { name: 'Overwraps Costs', treatment: 'cogs' },
  { name: 'Excise Duty', treatment: 'cogs' },
  { name: 'Seals Expenses', treatment: 'cogs' },
  // Excluded from P&L — cash tracking only
  { name: 'Empty Bottles Transport', treatment: 'excluded' },
  { name: 'Loan Principal', treatment: 'excluded' },
];

const EXPENSE_TREATMENT = EXPENSE_TYPES.reduce((m, t) => { m[t.name] = t.treatment; return m; }, {});

const BOTTLES_PER_CARTON = {
  '0.5L': 24,
  '1.5L': 12,
  '5L': 4,
  '18.9L_disposable': 1,
  '18.9L_refill': 1
};

// Apply a purchase's line items to a raw-materials object. Mutates the object in
// place, so always pass a clone. sign = +1 to add stock (new purchase), -1 to
// reverse it (deleted or edited purchase). Uses != null throughout so a material
// currently sitting at 0 is still updated — a truthy check would silently skip
// restocking an emptied material.
function applyPurchaseItemsToRawMaterials(rawMaterials, items, sign) {
  (items || []).forEach(item => {
    if (!item.material) return;
    const category = item.material.split('_')[0];
    const delta = sign * item.quantity;

    if (category === 'emptyBottles') {
      const size = item.material.replace('emptyBottles_', '');
      if (rawMaterials.emptyBottles[size] != null) rawMaterials.emptyBottles[size] += delta;
    } else if (category === 'seals') {
      const type = item.material.replace('seals_', '');
      if (rawMaterials.seals[type] != null) rawMaterials.seals[type] += delta;
    } else if (category === 'labels') {
      const size = item.material.replace('labels_', '');
      if (rawMaterials.labels[size] != null) rawMaterials.labels[size] += delta;
    } else if (category === 'caps') {
      const size = item.material.replace('caps_', '');
      if (rawMaterials.caps && rawMaterials.caps[size] != null) rawMaterials.caps[size] += delta;
    } else if (category === 'overwraps') {
      const size = item.material.replace('overwraps_', '');
      if (rawMaterials.overwraps[size] != null) rawMaterials.overwraps[size] += delta;
    } else if (rawMaterials[item.material] != null) {
      // simple categories like kraStamps, roChemical
      rawMaterials[item.material] += delta;
    }
  });
}

export default function NorthernWaterSystemApp() {
  const [state, setState] = useState(initialState);
  const [activeTab, setActiveTab] = useState('dashboard');
  const [paymentsTab, setPaymentsTab] = useState('history');
  const [editingCustomer, setEditingCustomer] = useState(null);
  const [editingExpense, setEditingExpense] = useState(null);
  const [editingPurchase, setEditingPurchase] = useState(null);
  const [showModal, setShowModal] = useState(false);
  const [modalType, setModalType] = useState('');
  const [formData, setFormData] = useState({});
  const [reportType, setReportType] = useState('aging');
  const [reportData, setReportData] = useState(null);
  // Which day rows are expanded in the Cash Collected report. Keyed by
  // `${section}:${date}` (e.g. "cash:2026-06-29") so the two lists are independent.
  const [expandedDays, setExpandedDays] = useState({});
  const toggleDay = (key) => setExpandedDays(prev => ({ ...prev, [key]: !prev[key] }));
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [debtorsLocation, setDebtorsLocation] = useState('all'); // 'all' or a location name — filters the Debtors report
  const [reportCustomerId, setReportCustomerId] = useState(''); // selected customer for the per-customer reports (Revenue Over Time, Product Mix)
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerStatusFilter, setCustomerStatusFilter] = useState('all'); // all | active | inactive
  const [saleCustomerSearch, setSaleCustomerSearch] = useState('');
  const [paymentSaleSearch, setPaymentSaleSearch] = useState('');
  const [salesFilterDate, setSalesFilterDate] = useState('');
  const [salesSearch, setSalesSearch] = useState('');
  const [paymentsSearch, setPaymentsSearch] = useState('');
  const [paymentsFilterDate, setPaymentsFilterDate] = useState('');
  const [debtsSearch, setDebtsSearch] = useState('');
  const [statementRange, setStatementRange] = useState({ start: '', end: '' });
  const [invoiceDetail, setInvoiceDetail] = useState(null);
  // The open customer card, held as an ID rather than the customer object: the
  // card is looked up from state on every render, so a sale or payment recorded
  // from inside it shows the new balance instead of a stale snapshot.
  const [customerDetail, setCustomerDetail] = useState(null);
  const [customerCardTab, setCustomerCardTab] = useState('sales');
  // Maximised card: near-full-screen, for reading a long ledger without the
  // table scrolling sideways. Kept across cards so the preference sticks for
  // the session.
  const [customerCardExpanded, setCustomerCardExpanded] = useState(false);
  const [breakdownCard, setBreakdownCard] = useState(null);
  const [cartonCosts, setCartonCosts] = useState({});
  const [employees, setEmployees] = useState([]);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [hrView, setHrView] = useState('registry');
  const [hrMonth, setHrMonth] = useState(localMonthPrefix());
  const [casualRange, setCasualRange] = useState({ start: '', end: '' });
  const [casualRate, setCasualRate] = useState(0);
  const [payrollPayments, setPayrollPayments] = useState([]);

  // ===== AUTH STATE =====
  const [session, setSession] = useState(null);
  const [userProfile, setUserProfile] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginEmail, setLoginEmail] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // Guards the modal's Save button against double submission. Two taps on a
  // phone are two separate click events, and `setSaving(true)` has not
  // necessarily re-rendered the disabled button by the time the second one
  // lands — so the ref, not the state, is what actually blocks it. The state
  // exists only to show "Saving…".
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  // Declared before the session useEffect below so the effect never references
  // it inside its temporal dead zone (react-hooks/immutability).
  const fetchUserProfile = async (userId) => {
    try {
      const { data } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();
      if (data) {
        setUserProfile(data);
        // Sales users land on their own Home dashboard
        if (data.role === 'sales') {
          setActiveTab('salesdashboard');
        }
      }
    } catch (error) {
      console.error('Error fetching profile:', error);
    } finally {
      setAuthLoading(false);
    }
  };

  // Check for existing session on app start
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        fetchUserProfile(session.user.id);
      } else {
        setAuthLoading(false);
      }
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        fetchUserProfile(session.user.id);
      } else {
        setUserProfile(null);
        setAuthLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const handleLogin = async () => {
    setLoginError('');
    setLoggingIn(true);
    try {
      const { error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword
      });
      if (error) {
        setLoginError(error.message);
      }
    } catch {
      setLoginError('Login failed. Please try again.');
    } finally {
      setLoggingIn(false);
    }
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setUserProfile(null);
    setSession(null);
    setActiveTab('dashboard');
  };

  const role = userProfile?.role || 'sales';

  // Sales visibility:
  //  - Admin/Manager: see everything
  //  - Sales WITH a location set: see records whose customer is in their location
  //    (regardless of who entered them)
  //  - Sales WITHOUT a location: fall back to only their own records
  const myUserId = session?.user?.id;
  const myLocation = userProfile?.location || null;

  // Helper: does a record's customer belong to my location?
  const customerInMyLocation = (customerId) => {
    const cust = state.customers.find(c => c.id === customerId);
    return cust && myLocation && cust.location === myLocation;
  };

  const visibleSales = role !== 'sales'
    ? state.sales
    : myLocation
      ? state.sales.filter(s => customerInMyLocation(s.customerId))
      : state.sales.filter(s => s.created_by === myUserId);

  const visiblePayments = role !== 'sales'
    ? state.payments
    : myLocation
      ? state.payments.filter(p => customerInMyLocation(p.customerId))
      : state.payments.filter(p => p.created_by === myUserId);

  // Customers visible to a sales user (for the debts list): their location only,
  // or all of their own debtors if no location set. Admin/manager see all.
  const visibleCustomers = role !== 'sales'
    ? state.customers
    : myLocation
      ? state.customers.filter(c => c.location === myLocation)
      : state.customers;

  // True once the login-time inventory fetch actually returned rows. If the
  // fetch fails/returns empty the session keeps the hardcoded demo defaults —
  // safe for DELTA writes (they touch the DB's own value, not the client's),
  // but NOT for the absolute stock-count correction, which is gated on this.
  const inventoryLoaded = useRef(false);

  // ===== ATOMIC INVENTORY PERSISTENCE (see migration 009) =====
  // Stock is no longer saved by overwriting the whole blob. Instead each change
  // is sent as a set of DELTAS and applied server-side under a row lock, so
  // concurrent writers and stale sessions can't clobber one another. The RPC
  // returns the fresh authoritative blobs, which callers write back to state so
  // the session re-syncs to DB truth after every stock change.

  // Walk two versions of an inventory blob and emit one {id,path,delta} per
  // numeric leaf that changed. bottlesPerCarton never moves, so it drops out
  // naturally (delta 0). This reuses each caller's existing per-item math —
  // the delta is exactly the change the user made, independent of DB state.
  const diffInventoryLeaves = (id, prev, next, path, out) => {
    Object.keys(next || {}).forEach(key => {
      const nv = next[key];
      const pv = prev ? prev[key] : undefined;
      if (typeof nv === 'number') {
        const delta = nv - (typeof pv === 'number' ? pv : 0);
        if (delta !== 0) out.push({ id, path: [...path, key], delta });
      } else if (nv && typeof nv === 'object') {
        diffInventoryLeaves(id, pv, nv, [...path, key], out);
      }
    });
  };

  // Persist a stock change as deltas. Pass the pre-change and post-change blobs;
  // returns the fresh { rawMaterials, finishedGoods } from the server, or null
  // on error (caller decides how to surface it). A no-op change returns the
  // current state unchanged without a round-trip.
  const persistInventoryDeltas = async (prev, next) => {
    const changes = [];
    diffInventoryLeaves('rawMaterials', prev.rawMaterials, next.rawMaterials, [], changes);
    diffInventoryLeaves('finishedGoods', prev.finishedGoods, next.finishedGoods, [], changes);
    if (changes.length === 0) {
      return { rawMaterials: state.rawMaterials, finishedGoods: state.finishedGoods };
    }
    const { data, error } = await supabase.rpc('apply_inventory_deltas', { changes });
    if (error || !data) {
      console.error('❌ Error applying inventory deltas:', error);
      return null;
    }
    return { rawMaterials: data.rawMaterials, finishedGoods: data.finishedGoods };
  };

  // Merge the authoritative rows a money RPC returns (migration 011) back into
  // local state. Covers the two slices every one of those functions can touch:
  // the customer's balance and the inventory blobs. Callers handle their own
  // sales/payments rows themselves, since those differ per flow — inserted,
  // updated, or removed. `customer` and `sale` come back null when the parent row
  // no longer exists, which is why both are guarded.
  // ===== SUBMISSION SAFETY =====
  //
  // Two related failure modes, both of which were creating duplicate sales,
  // payments and production runs in production:
  //
  //   1. Double-tapping Save fired the handler twice. Each call was a valid,
  //      independent transaction, so nothing downstream could tell the second
  //      one was unwanted. `runSave` stops it at the source.
  //   2. A connection dropped mid-save left the request hanging forever (fetch
  //      has no default timeout), so staff assumed it had failed and re-entered
  //      the record later. `withTimeout` makes that fail loudly instead — and
  //      deliberately says the outcome is UNKNOWN rather than "not recorded",
  //      because the write may well have committed before the link died.
  //
  // The duplicate that neither of these can catch — the server commits, the
  // response never arrives, and the operator legitimately retries — is closed
  // server-side by the client key below. See migration 021.

  const SAVE_TIMEOUT_MS = 20000;

  // Runs one save at a time. Any second invocation while a save is in flight is
  // refused outright rather than queued: the user pressing Save twice means
  // "save this once", never "save it twice".
  const runSave = async (fn) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await fn();
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // supabase-js query builders and .rpc() are thenables resolving to
  // { data, error } and do not throw on network failure — but they also never
  // settle at all if the connection drops mid-flight. Race them against a timer
  // and normalise the timeout into the same { data, error } shape every caller
  // already handles, flagged so the message can tell the truth about it.
  const withTimeout = async (query) => {
    let timer;
    try {
      return await Promise.race([
        query,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('save-timeout')), SAVE_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (err?.message === 'save-timeout') {
        return { data: null, error: { message: 'Timed out', timedOut: true } };
      }
      return { data: null, error: { message: err?.message || 'Unknown error' } };
    } finally {
      clearTimeout(timer);
    }
  };

  // Wording is the whole point of this helper. On an ordinary refusal the
  // database rolled everything back and "nothing was recorded" is true. On a
  // timeout it is NOT true — we never heard back — and telling staff it is, is
  // exactly what produces a duplicate when they re-enter the record.
  // `replaySafe` says whether this form carries a client key (migration 021 —
  // sales, payments and production only). Where it does, pressing Save again is
  // genuinely safe and staff should be told so. Where it does not, the honest
  // advice is to go and look first, so the flag defaults to false.
  const saveFailureMessage = (error, refusedMessage, whereToCheck, replaySafe = false) => {
    if (error?.timedOut) {
      return `The connection was lost while saving.\n\n` +
        `THIS MAY OR MAY NOT HAVE BEEN SAVED. Check ${whereToCheck} before entering it again.\n\n` +
        (replaySafe
          ? 'If you press Save again on this same form it is safe — the system will recognise it and will not record it twice.'
          : 'If it is already there, close this form — pressing Save again would record it a second time.');
    }
    return `${refusedMessage}\n\n${error?.message || 'Unknown error'}`;
  };

  // Identifies one filled-in form, so the database can recognise a resend of
  // that same form and return what it already saved instead of saving it again.
  // Generated when the form opens and kept for as long as it stays open, which
  // is what makes retrying after a timeout safe.
  const newClientKey = () => {
    if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
    // Some of the field tablets run WebViews old enough to lack randomUUID.
    // The column is `uuid`, so the fallback has to be v4-shaped.
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  };

  // Replaces the row if it is already in local state, appends it otherwise. A
  // replayed save returns a row we may already be holding; appending it would
  // put the duplicate back on screen that the database just refused to create.
  const upsertById = (rows, row) =>
    rows.some(r => r.id === row.id) ? rows.map(r => (r.id === row.id ? row : r)) : [...rows, row];

  const applyRpcRows = (data) => {
    const patch = {};
    if (data?.customer) {
      patch.customers = state.customers.map(c => (c.id === data.customer.id ? data.customer : c));
    }
    if (data?.inventory) {
      patch.rawMaterials = data.inventory.rawMaterials;
      patch.finishedGoods = data.inventory.finishedGoods;
    }
    return patch;
  };

  const loadDataFromSupabase = async (role) => {
    const isAdminOrManager = role === 'admin' || role === 'manager';
    const isAdmin = role === 'admin';

    try {
      // Tier 1: all roles — core transactional data, fetched in parallel
      const [
        { data: customersData },
        { data: salesData },
        { data: paymentsData },
      ] = await Promise.all([
        supabase.from('customers').select('*'),
        supabase.from('sales').select('*'),
        supabase.from('payments').select('*'),
      ]);

      // Replace state whenever the fetch SUCCEEDED (data is an array, possibly
      // empty) — keying off length left stale/default records showing when a
      // table was genuinely empty. On a failed fetch data is null: keep prev.
      setState(prev => ({
        ...prev,
        ...(customersData && { customers: customersData }),
        ...(salesData && { sales: salesData }),
        ...(paymentsData && { payments: paymentsData }),
      }));

      // Tier 2: admin + manager — operational records, fetched in parallel
      if (isAdminOrManager) {
        const [
          { data: expensesData },
          { data: purchasesData },
          { data: consignmentData },
        ] = await Promise.all([
          supabase.from('expenses').select('*'),
          supabase.from('purchases').select('*'),
          supabase.from('consignment_movements').select('*'),
        ]);

        setState(prev => ({
          ...prev,
          ...(expensesData && { expenses: expensesData }),
          ...(purchasesData && { purchases: purchasesData }),
          ...(consignmentData && { consignmentMovements: consignmentData }),
        }));
      }

      // Production logs — all roles. RLS returns every run for admin/manager and
      // only the user's own runs for sales, so a rep's production history and the
      // inventory effects they recorded are visible to them after a reload.
      const { data: prodData } = await supabase.from('production_logs').select('*');
      setState(prev => ({
        ...prev,
        ...(prodData && { productionLogs: prodData }),
      }));

      // Employees — all roles (RLS filters sales to casual employees only; needed for production log)
      const { data: empData } = await supabase.from('employees').select('*');
      if (empData) setEmployees(empData);

      // Tier 3: admin only — payroll records
      if (isAdmin) {
        const { data: payData } = await supabase.from('payroll_payments').select('*');
        if (payData) setPayrollPayments(payData);
      }

      // Cost settings — all roles (used in production cost calculations)
      try {
        const { data: costData } = await supabase
          .from('cost_settings')
          .select('costs')
          .eq('id', 1)
          .single();
        if (costData?.costs) {
          setCartonCosts(costData.costs);
          if (costData.costs.casual_rate != null) setCasualRate(Number(costData.costs.casual_rate) || 0);
        }
      } catch {
        console.log('No cost settings yet');
      }

      // Inventory state — all roles
      try {
        const { data: invData } = await supabase.from('inventory_state').select('*');
        if (invData?.length > 0) {
          const rm = invData.find(r => r.id === 'rawMaterials');
          const fg = invData.find(r => r.id === 'finishedGoods');
          setState(prev => ({
            ...prev,
            rawMaterials: rm?.data ?? prev.rawMaterials,
            finishedGoods: fg?.data ?? prev.finishedGoods,
          }));
          // Real stock is loaded — the absolute stock-count correction is now safe.
          inventoryLoaded.current = true;
        }
      } catch {
        console.log('No saved inventory yet');
      }

      console.log('✅ Data loaded from Supabase successfully');
    } catch (error) {
      console.error('❌ Error loading data from Supabase:', error);
    }
  };

  // Load data from Supabase on app start — ONCE per login. Declared after
  // loadDataFromSupabase so the effect doesn't reference it inside its temporal
  // dead zone (react-hooks/immutability).
  // Triggered by userProfile (not session) so the role is known before fetching.
  // The guard resets on logout because handleLogout sets userProfile to null.
  const hasLoadedData = useRef(false);
  useEffect(() => {
    if (userProfile && !hasLoadedData.current) {
      hasLoadedData.current = true;
      loadDataFromSupabase(userProfile.role);
    }
    if (!userProfile) {
      hasLoadedData.current = false;
    }
  }, [userProfile]);

  // Find the most recent purchase unit price for a given material key
  // (e.g. 'emptyBottles_0.5L', 'seals_short_neck', 'labels_5L', 'kraStamps').
  // Returns 0 if the material has never been purchased.
  const getLatestUnitPrice = (materialKey) => {
    let latestDate = null;
    let latestPrice = 0;
    state.purchases.forEach(purchase => {
      (purchase.items || []).forEach(item => {
        if (item.material === materialKey && item.unitPrice != null) {
          if (!latestDate || new Date(purchase.date) >= new Date(latestDate)) {
            latestDate = purchase.date;
            latestPrice = item.unitPrice;
          }
        }
      });
    });
    return latestPrice;
  };

  // Raw materials valued at their latest purchase unit price (0 if never bought)
  const calculateInventoryValue = () => {
    let total = 0;
    const rm = state.rawMaterials;

    // Object-type categories: emptyBottles, seals, labels, overwraps
    ['emptyBottles', 'seals', 'labels', 'overwraps', 'caps'].forEach(category => {
      if (rm[category] && typeof rm[category] === 'object') {
        Object.entries(rm[category]).forEach(([key, qty]) => {
          if (typeof qty === 'number') {
            total += qty * getLatestUnitPrice(`${category}_${key}`);
          }
        });
      }
    });

    // Simple number categories: kraStamps, roChemical
    if (typeof rm.kraStamps === 'number') {
      total += rm.kraStamps * getLatestUnitPrice('kraStamps');
    }
    if (typeof rm.roChemical === 'number') {
      total += rm.roChemical * getLatestUnitPrice('roChemical');
    }

    return total;
  };

  // Finished goods AT THE PLANT, valued at admin-entered cost per carton (0 if
  // not set). Cartons held by consignment shops are still ours but have already
  // left this figure — see calculateConsignmentStockValue, and use
  // calculateTotalAssets for the combined number.
  const calculateFinishedGoodsValue = () => {
    let total = 0;
    Object.entries(state.finishedGoods).forEach(([size, data]) => {
      const costPerCarton = cartonCosts[size] || 0;
      total += data.quantity * costPerCarton;
    });
    return total;
  };

  // Expenses-tab summary cards are month-to-date, matching the dashboard.
  // Full history stays available in the records list and the Expense Report.
  const getMonthExpensesByCategory = () => {
    const monthPrefix = localMonthPrefix();
    const totals = {};
    state.expenses.forEach(exp => {
      if ((exp.date || '').slice(0, 7) !== monthPrefix) return;
      totals[exp.category] = (totals[exp.category] || 0) + exp.amount;
    });
    return totals;
  };

  const getMonthExpenses = () => {
    const monthPrefix = localMonthPrefix();
    return state.expenses
      .filter(exp => (exp.date || '').slice(0, 7) === monthPrefix)
      .reduce((sum, exp) => sum + exp.amount, 0);
  };

  // Purchases-tab summary cards are month-to-date, matching the dashboard.
  // Full history stays available in the purchases list below them.
  const getMonthPurchasesList = () => {
    const monthPrefix = localMonthPrefix();
    return state.purchases.filter(p => (p.date || '').slice(0, 7) === monthPrefix);
  };

  // Purchase Management
  const handleAddPurchase = () => {
    setEditingPurchase(null);
    setModalType('purchase');
    setFormData({
      date: localDateString(),
      supplier: '',
      items: [{ material: '', description: '', quantity: 0, unitPrice: 0, total: 0 }]
    });
    setShowModal(true);
  };

  // Save finished-goods carton costs to Supabase (admin only)
  // ===== HR: Payroll calculations =====
  // Permanent: net = monthly salary - advances (expenses tagged to them) in the month
  const getAdvancesForEmployee = (empId, month) => {
    return state.expenses
      .filter(e => e.advance_employee_id === empId && (e.date || '').slice(0, 7) === month)
      .reduce((sum, e) => sum + (e.amount || 0), 0);
  };

  // Casual pay over a date range: for each production log in range, split
  // (total cartons in that run) equally among the casuals on duty, × shared rate.
  const getCasualPay = (range) => {
    const sharedRate = Number(casualRate) || 0;
    const result = {}; // empId -> { days, cartons, pay }
    state.productionLogs.forEach(log => {
      if (log.casual_paid) return; // already paid — don't show as due
      const d = log.date || '';
      if (range.start && range.end && (d < range.start || d > range.end)) return;
      const casuals = log.casuals || [];
      if (casuals.length === 0) return;
      const totalCartons = Object.values(log.items || {}).reduce((s, q) => s + (q || 0), 0);
      if (totalCartons === 0) return;
      const sharePerCasual = totalCartons / casuals.length;
      casuals.forEach(empId => {
        if (!result[empId]) result[empId] = { days: 0, cartons: 0, pay: 0 };
        result[empId].days += 1;
        result[empId].cartons += sharePerCasual;
        result[empId].pay += sharePerCasual * sharedRate;
      });
    });
    return result;
  };

  // Has a salary already been paid for this employee+month?
  const isSalaryPaid = (empId, month) =>
    payrollPayments.some(p => p.type === 'salary' && p.employee_id === empId && p.period_label === month);

  // Record a permanent salary payment: logs it AND creates a Salary expense.
  // (Double-payment of casuals is prevented per production run via the
  // casual_paid flag, not by comparing payout date ranges.)
  const recordSalaryPayment = async (emp, month, netAmount) => {
    if (netAmount <= 0) { alert('Nothing to pay for this month.'); return; }
    if (isSalaryPaid(emp.id, month)) { alert('Salary already recorded for this employee this month.'); return; }
    if (!confirm(`Record salary payment of KES ${netAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} for ${emp.name} (${month})? This also creates a Salary expense.`)) return;

    const datePaid = localDateString();
    const newExpense = {
      date: datePaid,
      category: 'operating',
      subcategory: 'Salary',
      description: `Salary - ${emp.name} (${month})`,
      amount: netAmount,
      advance_employee_id: null,
      created_by: session?.user?.id || null
    };
    const payment = {
      type: 'salary', employee_id: emp.id, employee_name: emp.name,
      period_label: month, period_start: `${month}-01`, period_end: `${month}-28`,
      amount: netAmount, date_paid: datePaid
    };

    // Persist the expense first so payroll links to its real (DB-assigned) id.
    const { data: savedExpense, error: expError } = await supabase
      .from('expenses').insert([newExpense]).select().single();
    if (expError || !savedExpense) {
      console.error('❌ Error recording salary payment:', expError);
      alert('Error recording payment — nothing was saved.');
      return;
    }
    const { data, error: payError } = await supabase
      .from('payroll_payments').insert([{ ...payment, expense_id: savedExpense.id }]).select();
    if (payError) {
      console.error('❌ Error recording salary payroll row:', payError);
      alert('Expense saved but the payroll record failed — please check HR.');
    }
    setState({ ...state, expenses: [...state.expenses, savedExpense] });
    if (data && data[0]) setPayrollPayments([...payrollPayments, data[0]]);
    alert('Salary payment recorded.');
  };

  // Record a casual payout for a date range: logs each casual's payment AND
  // creates ONE Casual Labour expense for the total (casual labour is now a P&L cost).
  const recordCasualPayment = async (range) => {
    if (!range.start || !range.end) { alert('Pick a start and end date first.'); return; }
    const pay = getCasualPay(range);
    const rows = employees.filter(e => e.category === 'casual' && pay[e.id]);
    const total = rows.reduce((s, e) => s + pay[e.id].pay, 0);
    if (total <= 0) { alert('No unpaid casual pay to record for this range.'); return; }
    if (!confirm(`Record casual payout of KES ${total.toLocaleString('en-US', { minimumFractionDigits: 2 })} for ${range.start} to ${range.end}? This also creates a Casual Labour expense.`)) return;

    const datePaid = localDateString();
    const rangeLabel = `${range.start} to ${range.end}`;
    const newExpense = {
      date: datePaid,
      category: 'operating',
      subcategory: 'Casual Labour',
      description: `Casual labour (${rangeLabel})`,
      amount: total,
      advance_employee_id: null,
      created_by: session?.user?.id || null
    };

    // Identify the unpaid production runs being paid now, and mark them paid
    const paidRunIds = state.productionLogs.filter(log => {
      if (log.casual_paid) return false;
      const d = log.date || '';
      if (range.start && range.end && (d < range.start || d > range.end)) return false;
      return (log.casuals || []).length > 0 &&
        Object.values(log.items || {}).reduce((s, q) => s + (q || 0), 0) > 0;
    }).map(log => log.id);

    // Persist the expense first so payroll/production link to its real id.
    const { data: savedExpense, error: expError } = await supabase
      .from('expenses').insert([newExpense]).select().single();
    if (expError || !savedExpense) {
      console.error('❌ Error recording casual payment:', expError);
      alert('Error recording payout — nothing was saved.');
      return;
    }
    const expenseId = savedExpense.id;

    const updatedLogs = state.productionLogs.map(log =>
      paidRunIds.includes(log.id) ? { ...log, casual_paid: true, casual_expense_id: expenseId } : log
    );
    const paymentRows = rows.map(e => ({
      type: 'casual', employee_id: e.id, employee_name: e.name,
      period_label: rangeLabel, period_start: range.start, period_end: range.end,
      amount: pay[e.id].pay, date_paid: datePaid, expense_id: expenseId
    }));

    const { data, error: payError } = await supabase.from('payroll_payments').insert(paymentRows).select();
    if (payError) {
      console.error('❌ Error recording casual payroll rows:', payError);
      alert('Expense saved but the payroll records failed — please check HR.');
    }
    let flagFailures = 0;
    for (const runId of paidRunIds) {
      const { error: flagError } = await supabase.from('production_logs')
        .update({ casual_paid: true, casual_expense_id: expenseId }).eq('id', runId);
      if (flagError) {
        flagFailures++;
        console.error('❌ Error marking production run paid:', runId, flagError);
      }
    }
    if (flagFailures > 0) {
      alert(`Payout recorded, but ${flagFailures} production run(s) could not be marked as paid — they may show as "Pay Due" again. Do NOT record a second payout for this range; please report this.`);
    }

    setState({ ...state, expenses: [...state.expenses, savedExpense], productionLogs: updatedLogs });
    if (data) setPayrollPayments([...payrollPayments, ...data]);
    alert('Casual payout recorded.');
  };

  // ===== HR: Employee management (admin only) =====
  const handleAddEmployee = (category) => {
    setEditingEmployee(null);
    setModalType('employee');
    setFormData({ name: '', category: category || 'permanent', rate: '', phone: '', active: true });
    setShowModal(true);
  };

  const handleEditEmployee = (emp) => {
    setEditingEmployee(emp);
    setModalType('employee');
    setFormData({ name: emp.name, category: emp.category, rate: emp.rate, phone: emp.phone || '', active: emp.active });
    setShowModal(true);
  };

  const handleSaveEmployee = async () => {
    if (!formData.name || !formData.category) {
      alert('Please enter a name and category');
      return;
    }
    const payload = {
      name: formData.name,
      category: formData.category,
      rate: parseFloat(formData.rate) || 0,
      phone: formData.phone || '',
      active: formData.active !== false,
    };
    // supabase returns errors rather than throwing — check them explicitly.
    if (editingEmployee) {
      const { error } = await supabase.from('employees').update(payload).eq('id', editingEmployee.id);
      if (error) {
        console.error('❌ Error updating employee:', error);
        alert('Could not save this employee — nothing was changed. Please try again.\n\n' + (error.message || 'Unknown error'));
        return;
      }
      setEmployees(employees.map(e => e.id === editingEmployee.id ? { ...e, ...payload } : e));
    } else {
      const { data, error } = await supabase.from('employees').insert([payload]).select();
      if (error || !data || !data[0]) {
        console.error('❌ Error saving employee:', error);
        alert('Could not save this employee — nothing was recorded. Please try again.\n\n' + (error?.message || 'Unknown error'));
        return;
      }
      setEmployees([...employees, data[0]]);
    }
    setShowModal(false);
    setEditingEmployee(null);
  };

  const handleDeleteEmployee = async (id) => {
    if (!confirm('Remove this employee?')) return;
    const { error } = await supabase.from('employees').delete().eq('id', id);
    if (error) {
      console.error('❌ Error deleting employee:', error);
      alert('Could not remove this employee — nothing was changed. Please try again.\n\n' + (error.message || 'Unknown error'));
      return;
    }
    setEmployees(employees.filter(e => e.id !== id));
  };

  // supabase-js returns errors rather than throwing, so both cost-settings
  // saves check the result explicitly — previously they alerted success even
  // when the UPDATE was rejected.
  const handleSaveCasualRate = async () => {
    const merged = { ...cartonCosts, casual_rate: casualRate };
    const { error } = await supabase.from('cost_settings').update({
      costs: merged,
      updated_at: new Date().toISOString()
    }).eq('id', 1);
    if (error) {
      console.error('❌ Error saving casual rate:', error);
      alert('Error saving casual rate — it was NOT saved. Please try again.\n\n' + (error.message || 'Unknown error'));
      return;
    }
    setCartonCosts(merged);
    alert('Casual rate saved');
  };

  const handleSaveCartonCosts = async () => {
    const { error } = await supabase.from('cost_settings').update({
      costs: cartonCosts,
      updated_at: new Date().toISOString()
    }).eq('id', 1);
    if (error) {
      console.error('❌ Error saving costs:', error);
      alert('Error saving costs — they were NOT saved. Please try again.\n\n' + (error.message || 'Unknown error'));
      return;
    }
    console.log('✅ Carton costs saved to Supabase');
    alert('Costs saved successfully');
  };

  // ===== STOCK ADJUSTMENT (admin only) =====
  // Build a flat list of every adjustable stock item with current quantity.
  const getStockItems = () => {
    const items = [];
    // Raw materials — object categories
    ['emptyBottles', 'overwraps', 'seals', 'labels', 'caps'].forEach(cat => {
      if (state.rawMaterials[cat] && typeof state.rawMaterials[cat] === 'object') {
        Object.keys(state.rawMaterials[cat]).forEach(key => {
          items.push({
            id: `rm:${cat}:${key}`,
            label: `${cat} — ${SIZE_LABELS[key] || key}`,
            qty: state.rawMaterials[cat][key]
          });
        });
      }
    });
    // Raw materials — simple numbers
    items.push({ id: 'rm:kraStamps', label: 'KRA Stamps', qty: state.rawMaterials.kraStamps });
    items.push({ id: 'rm:roChemical', label: 'RO Chemical', qty: state.rawMaterials.roChemical });
    // Finished goods
    Object.keys(state.finishedGoods).forEach(size => {
      items.push({
        id: `fg:${size}`,
        label: `Finished Goods — ${SIZE_LABELS[size] || size}`,
        qty: state.finishedGoods[size].quantity
      });
    });
    return items;
  };

  const handleStockAdjustment = async () => {
    const { itemId, newQty, reason } = formData;
    if (!itemId || newQty === '' || newQty == null) {
      alert('Please select an item and enter a new quantity');
      return;
    }
    const qty = parseFloat(newQty);
    if (isNaN(qty) || qty < 0) {
      alert('Enter a valid quantity (0 or more)');
      return;
    }

    // A stock-count correction writes an ABSOLUTE quantity. If real stock never
    // loaded this session, the on-screen number is the demo default — writing an
    // absolute value from here would overwrite real stock. Block it. (Deltas from
    // sales/production stay safe because they touch the DB's own value, not this.)
    if (!inventoryLoaded.current) {
      alert('Inventory has not loaded this session, so a stock correction is not safe right now. Please reload the page and try again.');
      return;
    }

    // Resolve the item to the JSONB blob id + path used by set_inventory_value,
    // and read the current on-screen quantity for the audit record.
    let invId = '';
    let path = [];
    let oldQty = 0;
    let label = '';

    if (itemId.startsWith('rm:')) {
      const parts = itemId.split(':');
      invId = 'rawMaterials';
      if (parts.length === 3) {
        const [, cat, key] = parts;
        path = [cat, key];
        oldQty = state.rawMaterials[cat][key];
        label = `${cat} ${key}`;
      } else {
        const [, simpleKey] = parts;
        path = [simpleKey];
        oldQty = state.rawMaterials[simpleKey];
        label = simpleKey;
      }
    } else if (itemId.startsWith('fg:')) {
      const size = itemId.replace('fg:', '');
      invId = 'finishedGoods';
      path = [size, 'quantity'];
      oldQty = state.finishedGoods[size].quantity;
      label = `Finished Goods ${size}`;
    }

    // Persist the audit-trail record FIRST; only apply the stock change once the
    // log is confirmed, so no adjustment can happen without a record behind it.
    const { error: logError } = await supabase.from('stock_adjustments').insert([{
      item: label,
      old_qty: oldQty,
      new_qty: qty,
      reason: reason || '',
      adjusted_by: userProfile?.email || '',
      date: new Date().toISOString()
    }]);
    if (logError) {
      console.error('❌ Error saving adjustment:', logError);
      alert('Could not record this adjustment — stock was NOT changed. Please try again.\n\n' + (logError.message || 'Unknown error'));
      return;
    }

    // Set the absolute quantity server-side and re-sync state from the result.
    const { data, error: rpcError } = await supabase.rpc('set_inventory_value', {
      p_id: invId, p_path: path, p_value: qty
    });
    if (rpcError || !data) {
      console.error('❌ Error setting stock value:', rpcError);
      alert('The adjustment was logged, but the stock quantity could not be updated. Please retry the adjustment.\n\n' + (rpcError?.message || 'Unknown error'));
      return;
    }
    console.log('✅ Stock adjustment saved');

    setState({ ...state, rawMaterials: data.rawMaterials, finishedGoods: data.finishedGoods });
    setShowModal(false);
    alert(`Updated ${label}: ${oldQty} → ${qty}`);
  };

  const handleSavePurchase = async () => {
    if (!formData.supplier || !formData.date || formData.items.filter(i => i.material && i.quantity > 0).length === 0) {
      alert('Please fill supplier, date, and add items');
      return;
    }

    const validItems = formData.items.filter(i => i.material && i.quantity > 0);
    const totalAmount = validItems.reduce((sum, i) => sum + i.total, 0);

    if (editingPurchase) {
      // Persist the edit FIRST; only adjust raw materials (via the atomic delta
      // RPC) once the update is confirmed.
      const { error: updateError } = await withTimeout(supabase.from('purchases').update({
        date: formData.date,
        supplier: formData.supplier,
        items: validItems,
        totalAmount
      }).eq('id', editingPurchase.id));
      if (updateError) {
        console.error('❌ Error updating purchase:', updateError);
        alert(saveFailureMessage(
          updateError,
          'Could not update this purchase — it has NOT been changed and stock was not adjusted. Please try again.',
          'the purchase in the Purchases list'
        ));
        return;
      }

      // Reverse the materials the OLD purchase added, then apply the NEW items,
      // so editing a quantity / material keeps inventory in step. Previously the
      // edit updated only the record and left raw materials untouched.
      const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
      applyPurchaseItemsToRawMaterials(updatedRawMaterials, editingPurchase.items, -1);
      applyPurchaseItemsToRawMaterials(updatedRawMaterials, validItems, +1);

      const fresh = await persistInventoryDeltas(
        { rawMaterials: state.rawMaterials, finishedGoods: state.finishedGoods },
        { rawMaterials: updatedRawMaterials, finishedGoods: state.finishedGoods }
      );
      if (!fresh) {
        alert('The purchase was updated, but the raw-material stock could not be adjusted. Please run a stock adjustment or reload.');
      }
      const updatedPurchases = state.purchases.map(p =>
        p.id === editingPurchase.id ? { ...editingPurchase, ...formData, items: validItems, totalAmount } : p
      );
      setState({
        ...state,
        purchases: updatedPurchases,
        ...(fresh && { rawMaterials: fresh.rawMaterials, finishedGoods: fresh.finishedGoods }),
      });
    } else {
      const newPurchase = {
        date: formData.date,
        supplier: formData.supplier,
        items: validItems,
        totalAmount,
        status: 'received'
      };

      // Persist the purchase FIRST; only apply the raw-material increase (via the
      // atomic delta RPC) on a confirmed save, so a failed insert can't raise
      // stock with no purchase record behind it.
      const { data: savedPurchase, error: purchaseError } = await withTimeout(supabase
        .from('purchases')
        .insert([newPurchase])
        .select()
        .single());
      if (purchaseError || !savedPurchase) {
        console.error('❌ Error saving purchase:', purchaseError);
        alert(saveFailureMessage(
          purchaseError,
          'Could not save this purchase — it has NOT been recorded and stock was not changed. Please try again.',
          'the Purchases list'
        ));
        return;
      }

      // Update raw materials
      const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
      applyPurchaseItemsToRawMaterials(updatedRawMaterials, validItems, +1);

      const fresh = await persistInventoryDeltas(
        { rawMaterials: state.rawMaterials, finishedGoods: state.finishedGoods },
        { rawMaterials: updatedRawMaterials, finishedGoods: state.finishedGoods }
      );
      if (!fresh) {
        alert('The purchase was saved, but the raw-material stock could not be updated. Please run a stock adjustment or reload.');
      }
      setState({
        ...state,
        purchases: [...state.purchases, savedPurchase],
        ...(fresh && { rawMaterials: fresh.rawMaterials, finishedGoods: fresh.finishedGoods }),
      });
    }

    setShowModal(false);
  };

  // Persist-first: the purchase row is deleted (and the result checked) before
  // the raw-material reversal is applied, so a rejected delete can't strip
  // stock while the purchase record survives.
  const handleDeletePurchase = async (id) => {
    const purchase = state.purchases.find(p => p.id === id);
    if (!purchase) return;
    if (!confirm('Delete this purchase? The materials it added will be removed from inventory. This cannot be undone.')) return;

    const { error: delError } = await supabase.from('purchases').delete().eq('id', id);
    if (delError) {
      console.error('❌ Error deleting purchase:', delError);
      alert('Could not delete this purchase — nothing was changed. Please try again.\n\n' + (delError.message || 'Unknown error'));
      return;
    }

    // Reverse the inventory that this purchase added
    const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
    applyPurchaseItemsToRawMaterials(updatedRawMaterials, purchase.items, -1);

    const fresh = await persistInventoryDeltas(
      { rawMaterials: state.rawMaterials, finishedGoods: state.finishedGoods },
      { rawMaterials: updatedRawMaterials, finishedGoods: state.finishedGoods }
    );
    if (!fresh) {
      alert('The purchase was deleted, but the raw-material stock could not be reversed. Please run a stock adjustment or reload.');
    }
    setState({
      ...state,
      purchases: state.purchases.filter(p => p.id !== id),
      ...(fresh && { rawMaterials: fresh.rawMaterials, finishedGoods: fresh.finishedGoods }),
    });
    console.log('✅ Purchase deleted and inventory reversed');
  };

  // Report Generators
  const generateAgingDebtorsReport = (locationFilter = debtorsLocation) => {
    const today = new Date();
    const debtors = state.customers
      .filter(c => c.balance < 0)
      .filter(c => locationFilter === 'all' || (c.location || 'Unspecified') === locationFilter)
      .map(c => {
      // Find this customer's oldest sale that isn't fully paid
      const unpaidSales = state.sales
        .filter(s => s.customerId === c.id && (s.paid || 0) < s.total)
        .sort((a, b) => new Date(a.date) - new Date(b.date));

      let daysOverdue = 0;
      if (unpaidSales.length > 0) {
        const oldest = new Date(unpaidSales[0].date);
        daysOverdue = Math.max(0, Math.floor((today - oldest) / (1000 * 60 * 60 * 24)));
      }

      return {
        ...c,
        debt: Math.abs(c.balance),
        daysOverdue
      };
    }).sort((a, b) => b.debt - a.debt);

    // Group debts by location, with a per-location total
    const byLocation = {};
    debtors.forEach(d => {
      const loc = d.location || 'Unspecified';
      if (!byLocation[loc]) byLocation[loc] = { debtors: [], total: 0 };
      byLocation[loc].debtors.push(d);
      byLocation[loc].total += d.debt;
    });

    return {
      title: 'Aging Debtors Report',
      date: new Date().toLocaleDateString(),
      locationLabel: locationFilter === 'all' ? 'All Locations' : locationFilter,
      data: debtors,
      byLocation,
      total: debtors.reduce((sum, d) => sum + d.debt, 0)
    };
  };

  const generateSalesReport = () => {
    // With no date range selected, default to the current month (not all time),
    // matching the Cash Collected report and the dashboard cards.
    const monthPrefix = localMonthPrefix();
    const filteredSales = (dateRange.start && dateRange.end)
      ? state.sales.filter(s => s.date >= dateRange.start && s.date <= dateRange.end)
      : state.sales.filter(s => (s.date || '').slice(0, 7) === monthPrefix);

    const REFILL_KEYS = ['refill_10L', 'refill_15L', 'refill_20L'];

    const salesByLocation = {};
    const salesBySize = {};
    const bottlesByLocationAndSize = {};
    const refillsBySize = {};   // refill_10L/15L/20L -> bottle (unit) count
    let refillRevenue = 0;

    filteredSales.forEach(sale => {
      const customer = state.customers.find(c => c.id === sale.customerId);
      const location = customer?.location || 'Unknown';

      salesByLocation[location] = (salesByLocation[location] || 0) + sale.total;

      if (!bottlesByLocationAndSize[location]) {
        bottlesByLocationAndSize[location] = {};
      }

      sale.items.forEach(item => {
        if (REFILL_KEYS.includes(item.size)) {
          // Refills: separate section, counted as bottles (= quantity), not by location
          refillsBySize[item.size] = (refillsBySize[item.size] || 0) + item.quantity;
          refillRevenue += (item.quantity * (item.price || 0));
        } else {
          // Bottled products: by location + size, in cartons (as before)
          salesBySize[item.size] = (salesBySize[item.size] || 0) + item.quantity;
          bottlesByLocationAndSize[location][item.size] = (bottlesByLocationAndSize[location][item.size] || 0) + item.quantity;
        }
      });
    });

    return {
      title: 'Sales Report',
      date: new Date().toLocaleDateString(),
      period: (dateRange.start && dateRange.end)
        ? `${dateRange.start} to ${dateRange.end}`
        : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      totalSales: filteredSales.reduce((sum, s) => sum + s.total, 0),
      totalTransactions: filteredSales.length,
      salesByLocation,
      salesBySize,
      bottlesByLocationAndSize,
      refillsBySize,
      refillRevenue,
      data: filteredSales
    };
  };

  const generateCashCollectedReport = () => {
    // With no date range selected, default to the current month (not all time)
    // so the summary cards and the day lists below them stay in sync.
    const monthPrefix = localMonthPrefix();
    const inPeriod = (d) => {
      if (!dateRange.start || !dateRange.end) return (d || '').slice(0, 7) === monthPrefix;
      return d >= dateRange.start && d <= dateRange.end;
    };

    // Cash sales: sales paid on the spot (paid > 0 at sale), counted on sale date
    let cashSalesTotal = 0;
    const cashSalesList = [];
    state.sales.forEach(s => {
      if (inPeriod(s.date) && (s.paid || 0) > 0) {
        // Only the portion paid AT point of sale. Later debt payments are counted
        // separately via payment records. A sale created "paid" has status 'paid'.
        // To avoid double-counting, count the sale's paid amount only if there are
        // no separate payment records linked to it.
        const linkedPayments = state.payments.filter(p => p.saleId === s.id);
        const paidViaPayments = linkedPayments.reduce((sum, p) => sum + p.amount, 0);
        const paidAtSale = (s.paid || 0) - paidViaPayments;
        if (paidAtSale > 0) {
          cashSalesTotal += paidAtSale;
          const customer = state.customers.find(c => c.id === s.customerId);
          cashSalesList.push({
            date: s.date,
            invoice: s.invoiceNumber,
            customer: customer?.name || 'Unknown',
            method: s.method || '',
            amount: paidAtSale
          });
        }
      }
    });

    // Debt payments: payment records within the period
    let debtPaymentsTotal = 0;
    const debtPaymentsList = [];
    state.payments.forEach(p => {
      if (inPeriod(p.date)) {
        debtPaymentsTotal += p.amount;
        const customer = state.customers.find(c => c.id === p.customerId);
        debtPaymentsList.push({
          date: p.date,
          customer: customer?.name || 'Unknown',
          method: p.method || '',
          reference: p.reference || '',
          amount: p.amount
        });
      }
    });

    return {
      title: 'Cash Collected Report',
      date: new Date().toLocaleDateString(),
      period: (dateRange.start && dateRange.end)
        ? `${dateRange.start} to ${dateRange.end}`
        : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      cashSalesTotal,
      debtPaymentsTotal,
      totalCollected: cashSalesTotal + debtPaymentsTotal,
      cashSalesList: cashSalesList.sort((a, b) => new Date(b.date) - new Date(a.date)),
      debtPaymentsList: debtPaymentsList.sort((a, b) => new Date(b.date) - new Date(a.date))
    };
  };

  const generateExpenseReport = () => {
    // With no date range selected, default to the current month (not all time).
    const monthPrefix = localMonthPrefix();
    const filtered = (dateRange.start && dateRange.end)
      ? state.expenses.filter(e => e.date >= dateRange.start && e.date <= dateRange.end)
      : state.expenses.filter(e => (e.date || '').slice(0, 7) === monthPrefix);

    const totalExpenses = filtered.reduce((sum, e) => sum + e.amount, 0);
    const byType = {};       // group by the actual expense type (subcategory)
    const entriesByType = {}; // individual expense entries that make up each type
    let operatingTotal = 0, cogsTotal = 0, excludedTotal = 0;
    filtered.forEach(e => {
      const type = e.subcategory || 'Other';
      byType[type] = (byType[type] || 0) + e.amount;
      (entriesByType[type] = entriesByType[type] || []).push(e);
      const treatment = EXPENSE_TREATMENT[e.subcategory] || e.category || 'operating';
      if (treatment === 'operating') operatingTotal += e.amount;
      else if (treatment === 'cogs') cogsTotal += e.amount;
      else excludedTotal += e.amount;
    });
    // newest entries first within each type
    Object.values(entriesByType).forEach(list => list.sort((a, b) => new Date(b.date) - new Date(a.date)));

    return {
      title: 'Expense Report',
      date: new Date().toLocaleDateString(),
      period: (dateRange.start && dateRange.end)
        ? `${dateRange.start} to ${dateRange.end}`
        : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      totalExpenses,
      byCategory: byType,
      entriesByType,
      operatingTotal,
      cogsTotal,
      excludedTotal,
      expenses: filtered.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
    };
  };

  const generateProfitLossReport = () => {
    // With no date range selected, default to the current month (not all time).
    const monthPrefix = localMonthPrefix();
    const inPeriod = (d) => {
      if (!dateRange.start || !dateRange.end) return (d || '').slice(0, 7) === monthPrefix;
      return d >= dateRange.start && d <= dateRange.end;
    };

    const periodSales = state.sales.filter(s => inPeriod(s.date));
    const periodExpenses = state.expenses.filter(e => inPeriod(e.date));

    // Sales revenue in period
    const totalRevenue = periodSales.reduce((sum, s) => sum + s.total, 0);

    // COGS = cartons sold × cost per carton (carton cost is raw materials only —
    // it does NOT include casual labour, which is a separate operating expense).
    // Counts only what was actually sold.
    let cogs = 0;
    periodSales.forEach(sale => {
      sale.items.forEach(item => {
        const costPerCarton = cartonCosts[item.size] || 0;
        cogs += item.quantity * costPerCarton;
      });
    });

    const grossProfit = totalRevenue - cogs;

    // Operating expenses = expense types tagged 'operating' (Rent, Electricity,
    // Salary, Loan Interest, etc.). COGS-tagged and excluded-tagged are NOT operating.
    let operatingExpenses = 0;
    let cogsExpenses = 0;
    let excludedExpenses = 0;
    const operatingBreakdown = {};
    // cogs- and excluded-tagged expenses are NOT deducted here (see the memo note
    // below), but they are broken down by type so the P&L can be reconciled
    // line-for-line against the Expense Report instead of silently dropping them.
    const cogsBreakdown = {};
    const excludedBreakdown = {};
    periodExpenses.forEach(e => {
      // Treatment comes from the expense type; fall back to the stored category
      // (which we now set to the treatment), then default to operating for old records.
      const treatment = EXPENSE_TREATMENT[e.subcategory] || e.category || 'operating';
      const key = e.subcategory || 'Other';
      if (treatment === 'operating') {
        operatingExpenses += e.amount;
        operatingBreakdown[key] = (operatingBreakdown[key] || 0) + e.amount;
      } else if (treatment === 'cogs') {
        cogsExpenses += e.amount;
        cogsBreakdown[key] = (cogsBreakdown[key] || 0) + e.amount;
      } else {
        excludedExpenses += e.amount;
        excludedBreakdown[key] = (excludedBreakdown[key] || 0) + e.amount;
      }
    });

    // Net profit deliberately excludes cogs-tagged expenses: those are the raw
    // material / excise costs already carried by the admin-entered cost per carton
    // above, so deducting them again would double-count. excluded-tagged types
    // (loan principal, empty-bottle transport) are cash movements, not P&L costs.
    // Both are reported as memo lines so the omission is visible, not silent.
    const netProfit = grossProfit - operatingExpenses;

    return {
      title: 'Profit & Loss Statement',
      date: new Date().toLocaleDateString(),
      period: (dateRange.start && dateRange.end)
        ? `${dateRange.start} to ${dateRange.end}`
        : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      revenue: totalRevenue,
      cogs,
      grossProfit,
      grossMargin: totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : 0,
      operatingExpenses,
      operatingBreakdown,
      cogsExpenses,
      cogsBreakdown,
      excludedExpenses,
      excludedBreakdown,
      netProfit,
      netMargin: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(1) : 0
    };
  };

  // Format a 'YYYY-MM' key as e.g. "Jul 2026" for the customer trend report.
  const monthLabel = (m) => m
    ? new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
    : '—';

  // Top Customers — ranks customers by invoiced revenue (Σ sale.total) over the
  // period. Defaults to the current month (like Sales/Cash), overridable by date
  // range. Paid/outstanding are shown as columns but ranking is on invoiced.
  const generateTopCustomersReport = () => {
    const hasRange = dateRange.start && dateRange.end;
    const monthPrefix = localMonthPrefix();
    const inPeriod = (d) => hasRange
      ? (d >= dateRange.start && d <= dateRange.end)
      : (d || '').slice(0, 7) === monthPrefix;
    const periodSales = state.sales.filter(s => inPeriod(s.date));

    // Keyed by the customer's native id (Map avoids id-type coercion issues).
    const byCustomer = new Map();
    periodSales.forEach(s => {
      let row = byCustomer.get(s.customerId);
      if (!row) {
        const customer = state.customers.find(c => c.id === s.customerId);
        row = { name: customer?.name || 'Unknown', location: customer?.location || '—', invoiced: 0, paid: 0, invoices: 0 };
        byCustomer.set(s.customerId, row);
      }
      row.invoiced += s.total;
      row.paid += (s.paid || 0);
      row.invoices += 1;
    });

    const totalInvoiced = periodSales.reduce((sum, s) => sum + s.total, 0);
    const rows = [...byCustomer.values()]
      .map(r => ({ ...r, outstanding: r.invoiced - r.paid, pct: totalInvoiced > 0 ? (r.invoiced / totalInvoiced) * 100 : 0 }))
      .sort((a, b) => b.invoiced - a.invoiced);

    return {
      title: 'Top Customers',
      date: new Date().toLocaleDateString(),
      period: hasRange ? `${dateRange.start} to ${dateRange.end}` : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      rows,
      totalInvoiced
    };
  };

  // Customer Sales Summary — the whole book at a glance. Per-period invoiced/paid
  // per customer plus their current outstanding balance and last purchase date.
  // Defaults to all-time (no range) so last-purchase and the ledger read fully.
  const generateCustomerSalesSummaryReport = () => {
    const hasRange = dateRange.start && dateRange.end;
    const inPeriod = (d) => hasRange ? (d >= dateRange.start && d <= dateRange.end) : true;
    const periodSales = state.sales.filter(s => inPeriod(s.date));

    const byCustomer = new Map();
    periodSales.forEach(s => {
      let row = byCustomer.get(s.customerId);
      if (!row) { row = { invoiced: 0, paid: 0, invoices: 0, lastPurchase: '' }; byCustomer.set(s.customerId, row); }
      row.invoiced += s.total;
      row.paid += (s.paid || 0);
      row.invoices += 1;
      if (!row.lastPurchase || s.date > row.lastPurchase) row.lastPurchase = s.date;
    });

    const rows = state.customers.map(c => {
      const r = byCustomer.get(c.id) || { invoiced: 0, paid: 0, invoices: 0, lastPurchase: '' };
      return {
        name: c.name,
        location: c.location || '—',
        invoiced: r.invoiced,
        paid: r.paid,
        invoices: r.invoices,
        outstanding: Math.max(0, -(c.balance || 0)),
        lastPurchase: r.lastPurchase || '—'
      };
    })
      .filter(r => r.invoices > 0 || r.outstanding > 0)   // skip dormant, zero-balance customers
      .sort((a, b) => b.invoiced - a.invoiced);

    return {
      title: 'Customer Sales Summary',
      date: new Date().toLocaleDateString(),
      period: hasRange ? `${dateRange.start} to ${dateRange.end}` : 'All time',
      rows,
      totalInvoiced: rows.reduce((s, r) => s + r.invoiced, 0),
      totalPaid: rows.reduce((s, r) => s + r.paid, 0),
      totalOutstanding: rows.reduce((s, r) => s + r.outstanding, 0)
    };
  };

  // Customer Revenue Over Time — one customer's invoiced revenue by month.
  // Defaults to all-time so the trend is visible; date range narrows it.
  const generateCustomerRevenueReport = (customerId = reportCustomerId) => {
    const customer = state.customers.find(c => String(c.id) === String(customerId));
    if (!customer) {
      return { title: 'Customer Revenue Over Time', date: new Date().toLocaleDateString(), period: '—', noCustomer: true, months: [], totalRevenue: 0, maxRevenue: 0 };
    }
    const hasRange = dateRange.start && dateRange.end;
    const inPeriod = (d) => hasRange ? (d >= dateRange.start && d <= dateRange.end) : true;
    const custSales = state.sales.filter(s => s.customerId === customer.id && inPeriod(s.date));

    const byMonth = {};
    custSales.forEach(s => {
      const m = (s.date || '').slice(0, 7);
      const row = byMonth[m] || (byMonth[m] = { revenue: 0, invoices: 0 });
      row.revenue += s.total;
      row.invoices += 1;
    });
    const months = Object.entries(byMonth)
      .map(([month, r]) => ({ month, revenue: r.revenue, invoices: r.invoices }))
      .sort((a, b) => a.month.localeCompare(b.month));

    return {
      title: 'Customer Revenue Over Time',
      date: new Date().toLocaleDateString(),
      period: hasRange ? `${dateRange.start} to ${dateRange.end}` : 'All time',
      customerName: customer.name,
      customerLocation: customer.location || '—',
      months,
      totalRevenue: months.reduce((s, m) => s + m.revenue, 0),
      maxRevenue: months.reduce((mx, m) => Math.max(mx, m.revenue), 0)
    };
  };

  // Product Mix by Customer — one customer's purchases broken down by size,
  // in quantity and revenue. Refills counted in bottles, bottled in cartons.
  const generateProductMixReport = (customerId = reportCustomerId) => {
    const customer = state.customers.find(c => String(c.id) === String(customerId));
    if (!customer) {
      return { title: 'Product Mix by Customer', date: new Date().toLocaleDateString(), period: '—', noCustomer: true, rows: [], totalRevenue: 0, totalQuantity: 0 };
    }
    const REFILL_KEYS = ['refill_10L', 'refill_15L', 'refill_20L'];
    const hasRange = dateRange.start && dateRange.end;
    const inPeriod = (d) => hasRange ? (d >= dateRange.start && d <= dateRange.end) : true;
    const custSales = state.sales.filter(s => s.customerId === customer.id && inPeriod(s.date));

    const bySize = {};
    custSales.forEach(s => {
      s.items.forEach(item => {
        const row = bySize[item.size] || (bySize[item.size] = { quantity: 0, revenue: 0, isRefill: REFILL_KEYS.includes(item.size) });
        row.quantity += item.quantity;
        row.revenue += item.total ?? item.subtotal ?? (item.quantity * (item.price || 0));
      });
    });
    const rows = Object.entries(bySize)
      .map(([size, r]) => ({ size, label: SIZE_LABELS[size] || size, quantity: r.quantity, revenue: r.revenue, isRefill: r.isRefill }))
      .sort((a, b) => b.revenue - a.revenue);

    return {
      title: 'Product Mix by Customer',
      date: new Date().toLocaleDateString(),
      period: hasRange ? `${dateRange.start} to ${dateRange.end}` : 'All time',
      customerName: customer.name,
      customerLocation: customer.location || '—',
      rows,
      totalRevenue: rows.reduce((s, r) => s + r.revenue, 0),
      totalQuantity: rows.reduce((s, r) => s + r.quantity, 0)
    };
  };

  const generateProductionReport = () => {
    // With no date range selected, default to the current month (not all time),
    // matching the Sales / Cash / Expense reports.
    const monthPrefix = localMonthPrefix();
    const hasRange = dateRange.start && dateRange.end;
    const logs = hasRange
      ? state.productionLogs.filter(l => l.date >= dateRange.start && l.date <= dateRange.end)
      : state.productionLogs.filter(l => (l.date || '').slice(0, 7) === monthPrefix);

    const cartonsBySize = {};
    const bottlesBySize = {};
    let totalCartons = 0;
    let totalBottles = 0;
    let fgValue = 0; // estimated finished-goods value at carton cost (information only)

    logs.forEach(log => {
      Object.entries(log.items || {}).forEach(([size, ctns]) => {
        const cartons = ctns || 0;
        if (cartons === 0) return;
        const bottles = cartons * (BOTTLES_PER_CARTON[size] || 1);
        cartonsBySize[size] = (cartonsBySize[size] || 0) + cartons;
        bottlesBySize[size] = (bottlesBySize[size] || 0) + bottles;
        totalCartons += cartons;
        totalBottles += bottles;
        fgValue += cartons * (cartonCosts[size] || 0);
      });
    });

    // Casual labour is paid per carton produced (× the shared rate). This is an
    // estimate for information only — it does NOT post to the P&L; the actual
    // Casual Labour expense is created when a payout is recorded in HR.
    const casualCost = totalCartons * (Number(casualRate) || 0);

    // Per-run rows, newest first, for the detail table.
    const runs = logs.slice()
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .map(log => {
        const runCartons = Object.values(log.items || {}).reduce((s, q) => s + (q || 0), 0);
        return {
          id: log.id,
          date: log.date,
          items: log.items || {},
          totalCartons: runCartons,
          casualCount: (log.casuals || []).length,
          notes: log.notes || ''
        };
      });

    return {
      title: 'Production Report',
      date: new Date().toLocaleDateString(),
      period: hasRange
        ? `${dateRange.start} to ${dateRange.end}`
        : `This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })})`,
      totalRuns: logs.length,
      totalCartons,
      totalBottles,
      cartonsBySize,
      bottlesBySize,
      fgValue,
      casualCost,
      runs
    };
  };

  const handleGenerateReport = (type) => {
    let data;
    if (type === 'aging') {
      data = generateAgingDebtorsReport();
    } else if (type === 'sales') {
      data = generateSalesReport();
    } else if (type === 'cash') {
      data = generateCashCollectedReport();
    } else if (type === 'expense') {
      data = generateExpenseReport();
    } else if (type === 'profitloss') {
      data = generateProfitLossReport();
    } else if (type === 'topcustomers') {
      data = generateTopCustomersReport();
    } else if (type === 'customersummary') {
      data = generateCustomerSalesSummaryReport();
    } else if (type === 'customerrevenue') {
      data = generateCustomerRevenueReport();
    } else if (type === 'productmix') {
      data = generateProductMixReport();
    } else if (type === 'productionreport') {
      data = generateProductionReport();
    }
    setReportData(data);
    setReportType(type);
  };

  const downloadReportAsPDF = () => {
    if (!reportData) return;
    
    // Create HTML content for the report
    let htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>${reportData.title}</title>
        <style>
          body {
            font-family: Arial, sans-serif;
            margin: 20px;
            color: #333;
            background: white;
          }
          h1 {
            color: #0369a1;
            border-bottom: 3px solid #0369a1;
            padding-bottom: 10px;
          }
          h2 {
            color: #0284c7;
            margin-top: 20px;
            margin-bottom: 10px;
          }
          .header {
            background: #f0f9ff;
            padding: 15px;
            border-radius: 5px;
            margin-bottom: 20px;
          }
          .section {
            margin-bottom: 25px;
          }
          table {
            width: 100%;
            border-collapse: collapse;
            margin: 15px 0;
          }
          th, td {
            border: 1px solid #ddd;
            padding: 12px;
            text-align: left;
          }
          th {
            background: #0369a1;
            color: white;
          }
          tr:nth-child(even) {
            background: #f9fafb;
          }
          tr.daytotal td {
            background: #eef2f7;
            font-weight: bold;
            border-top: 2px solid #cbd5e1;
          }
          td.detail {
            padding-left: 28px;
            color: #475569;
          }
          .summary {
            background: #ecfdf5;
            padding: 15px;
            border-left: 4px solid #10b981;
            margin: 15px 0;
            font-weight: bold;
          }
          .generated {
            color: #666;
            font-size: 12px;
            margin-top: 30px;
            padding-top: 10px;
            border-top: 1px solid #ddd;
          }
        </style>
      </head>
      <body>
        <h1>${reportData.title}</h1>
        <div class="header">
          <p><strong>Generated:</strong> ${reportData.date}</p>
          <p><strong>Report Type:</strong> ${reportType.toUpperCase()}</p>
          ${reportData.locationLabel ? `<p><strong>Location:</strong> ${reportData.locationLabel}</p>` : ''}
        </div>
    `;

    // Add report-specific content
    if (reportType === 'aging') {
      htmlContent += `<div class="section">`;
      Object.entries(reportData.byLocation)
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([location, group]) => {
          htmlContent += `
            <h2>${escapeHtml(location)} — KES ${group.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</h2>
            <table>
              <thead>
                <tr>
                  <th>Customer Name</th>
                  <th>Outstanding</th>
                  <th>Days Overdue</th>
                  <th>Phone</th>
                </tr>
              </thead>
              <tbody>
          `;
          group.debtors.forEach(d => {
            htmlContent += `
              <tr>
                <td>${escapeHtml(d.name)}</td>
                <td>KES ${d.debt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                <td>${d.daysOverdue}</td>
                <td>${escapeHtml(d.phone || '-')}</td>
              </tr>
            `;
          });
          htmlContent += `</tbody></table>`;
        });
      htmlContent += `
          <div class="summary"><strong>Total Outstanding Debt: KES ${reportData.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></div>
        </div>
      `;
    } else if (reportType === 'sales') {
      htmlContent += `
        <div class="section">
          <h2>Sales Summary</h2>
          <div class="summary">
            Period: ${reportData.period} | Total Sales: KES ${reportData.totalSales.toLocaleString()} | Transactions: ${reportData.totalTransactions}
          </div>
          <h2>Sales by Location</h2>
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Sales Amount</th>
              </tr>
            </thead>
            <tbody>
      `;
      Object.entries(reportData.salesByLocation).forEach(([location, amount]) => {
        htmlContent += `
              <tr>
                <td>${escapeHtml(location)}</td>
                <td>KES ${amount.toLocaleString()}</td>
              </tr>
        `;
      });
      htmlContent += `
            </tbody>
          </table>
          
          <h2>Cartons Sold by Size</h2>
          <table>
            <thead>
              <tr>
                <th>Bottle Size</th>
                <th>Cartons</th>
              </tr>
            </thead>
            <tbody>
      `;
      Object.entries(reportData.salesBySize).forEach(([size, qty]) => {
        htmlContent += `
              <tr>
                <td>${SIZE_LABELS[size] || size}</td>
                <td>${qty} cartons</td>
              </tr>
        `;
      });
      htmlContent += `
            </tbody>
          </table>

          <h2>Total Cartons Sold by Location</h2>
          <table>
            <thead>
              <tr>
                <th>Location</th>
                <th>Total Cartons</th>
              </tr>
            </thead>
            <tbody>
      `;
      let overallCartons = 0;
      Object.entries(reportData.bottlesByLocationAndSize).forEach(([location, cartons]) => {
        const locTotal = Object.values(cartons).reduce((s, q) => s + q, 0);
        overallCartons += locTotal;
        htmlContent += `
              <tr>
                <td>${escapeHtml(location)}</td>
                <td>${locTotal} cartons</td>
              </tr>
        `;
      });
      htmlContent += `
              <tr>
                <td><strong>Overall Total</strong></td>
                <td><strong>${overallCartons} cartons</strong></td>
              </tr>
            </tbody>
          </table>
      `;
      // Water refills — separate, in bottles
      if (reportData.refillsBySize && Object.keys(reportData.refillsBySize).length > 0) {
        htmlContent += `
          <h2>Water Refills (bottles)</h2>
          <table>
            <thead><tr><th>Refill</th><th>Bottles</th></tr></thead>
            <tbody>
        `;
        ['refill_10L', 'refill_15L', 'refill_20L'].filter(k => reportData.refillsBySize[k]).forEach(k => {
          htmlContent += `<tr><td>${SIZE_LABELS[k] || k}</td><td>${reportData.refillsBySize[k]} bottles</td></tr>`;
        });
        htmlContent += `
            </tbody>
          </table>
          <div class="summary">Refill Revenue: KES ${reportData.refillRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</div>
        `;
      }
      htmlContent += `
        </div>
      `;
    } else if (reportType === 'cash') {
      htmlContent += `
        <div class="section">
          <h2>Cash Collected Report</h2>
          <div class="summary">
            Period: ${reportData.period}<br/>
            Cash Sales Collected: KES ${reportData.cashSalesTotal.toLocaleString()}<br/>
            Debt Payments Collected: KES ${reportData.debtPaymentsTotal.toLocaleString()}<br/>
            <strong>Total Collected: KES ${reportData.totalCollected.toLocaleString()}</strong>
          </div>
          <h2>Cash Sales (paid at point of sale)</h2>
          <table>
            <thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Method</th><th>Amount</th></tr></thead>
            <tbody>
      `;
      if (reportData.cashSalesList.length === 0) {
        htmlContent += `<tr><td colspan="5">None in this period</td></tr>`;
      }
      groupByDay(reportData.cashSalesList).forEach(g => {
        htmlContent += `<tr class="daytotal"><td>${g.date}</td><td colspan="3">${g.items.length} ${g.items.length === 1 ? 'sale' : 'sales'}</td><td>KES ${g.total.toLocaleString()}</td></tr>`;
        g.items.forEach(c => {
          htmlContent += `<tr><td></td><td class="detail">${escapeHtml(c.invoice)}</td><td>${escapeHtml(c.customer)}</td><td>${escapeHtml(c.method || '')}</td><td>KES ${c.amount.toLocaleString()}</td></tr>`;
        });
      });
      htmlContent += `
            </tbody>
          </table>
          <h2>Debt Payments Received</h2>
          <table>
            <thead><tr><th>Date</th><th>Customer</th><th>Method</th><th>Amount</th></tr></thead>
            <tbody>
      `;
      if (reportData.debtPaymentsList.length === 0) {
        htmlContent += `<tr><td colspan="4">None in this period</td></tr>`;
      }
      groupByDay(reportData.debtPaymentsList).forEach(g => {
        htmlContent += `<tr class="daytotal"><td>${g.date}</td><td colspan="2">${g.items.length} ${g.items.length === 1 ? 'payment' : 'payments'}</td><td>KES ${g.total.toLocaleString()}</td></tr>`;
        g.items.forEach(p => {
          htmlContent += `<tr><td></td><td class="detail">${escapeHtml(p.customer)}</td><td>${escapeHtml(p.method)}</td><td>KES ${p.amount.toLocaleString()}</td></tr>`;
        });
      });
      htmlContent += `
            </tbody>
          </table>
        </div>
      `;
    } else if (reportType === 'expense') {
      htmlContent += `
        <div class="section">
          <div class="summary">
            Total Spent (all cash out): KES ${reportData.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}<br/>
            P&L Operating: KES ${reportData.operatingTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}<br/>
            Purchases / COGS: KES ${reportData.cogsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}<br/>
            Excluded (cash only): KES ${reportData.excludedTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <h2>Expenses by Type</h2>
          <table>
            <thead>
              <tr>
                <th>Type / Entry</th>
                <th>Treatment</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
      `;
      Object.entries(reportData.byCategory).forEach(([type, amount]) => {
        htmlContent += `
              <tr>
                <td><strong>${escapeHtml(type)}</strong></td>
                <td>${EXPENSE_TREATMENT[type] || 'operating'}</td>
                <td><strong>KES ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</strong></td>
              </tr>
        `;
        (reportData.entriesByType[type] || []).forEach(e => {
          htmlContent += `
              <tr>
                <td style="padding-left:20px;color:#64748b;">${escapeHtml(e.date)}${e.description ? ' · ' + escapeHtml(e.description) : ''}</td>
                <td></td>
                <td style="color:#64748b;">KES ${e.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
              </tr>
          `;
        });
      });
      htmlContent += `
            </tbody>
          </table>
        </div>
      `;
    } else if (reportType === 'profitloss') {
      let opRows = '';
      Object.entries(reportData.operatingBreakdown).forEach(([k, v]) => {
        opRows += `<tr><td style="padding-left:20px;">${escapeHtml(k)}</td><td>KES ${v.toLocaleString()}</td></tr>`;
      });

      // Memo rows: recorded expenses that are deliberately NOT deducted, listed so
      // the printed P&L reconciles with the Expense Report rather than dropping them.
      let memoRows = '';
      const memoGroup = (label, total, breakdown) => {
        if (!(total > 0)) return;
        memoRows += `<tr><td><strong>${label}</strong></td><td>KES ${total.toLocaleString()}</td></tr>`;
        Object.entries(breakdown).forEach(([k, v]) => {
          memoRows += `<tr><td style="padding-left:20px;color:#64748b;">${escapeHtml(k)}</td><td style="color:#64748b;">KES ${v.toLocaleString()}</td></tr>`;
        });
      };
      memoGroup('Material &amp; excise purchases', reportData.cogsExpenses, reportData.cogsBreakdown);
      memoGroup('Excluded from P&amp;L (cash only)', reportData.excludedExpenses, reportData.excludedBreakdown);
      if (memoRows) {
        memoRows = `
            <tr><td colspan="2" style="padding-top:14px;font-size:11px;color:#666;text-transform:uppercase;letter-spacing:0.5px;">Recorded, not deducted</td></tr>
            ${memoRows}
        `;
      }
      htmlContent += `
        <div class="section">
          <div class="summary">Period: ${reportData.period}</div>
          <table>
            <tr>
              <td><strong>Sales Revenue</strong></td>
              <td><strong>KES ${reportData.revenue.toLocaleString()}</strong></td>
            </tr>
            <tr>
              <td>Less: Cost of Goods Sold</td>
              <td>− KES ${reportData.cogs.toLocaleString()}</td>
            </tr>
            <tr style="background: #ecfdf5;">
              <td><strong>Gross Profit</strong></td>
              <td><strong>KES ${reportData.grossProfit.toLocaleString()} (${reportData.grossMargin}%)</strong></td>
            </tr>
            <tr>
              <td><strong>Operating Expenses</strong></td>
              <td>− KES ${reportData.operatingExpenses.toLocaleString()}</td>
            </tr>
            ${opRows}
            <tr style="background: #10b981; color: white;">
              <td><strong>Net Profit/Loss</strong></td>
              <td><strong>KES ${reportData.netProfit.toLocaleString()} (${reportData.netMargin}%)</strong></td>
            </tr>
            ${memoRows}
          </table>
          <p style="font-size:11px;color:#666;margin-top:10px;">COGS is based on cartons sold × cost per carton (raw materials only). Casual labour is an operating expense, not part of COGS. Raw material purchases are not counted again as operating expenses.</p>
          <p style="font-size:11px;color:#666;margin-top:6px;">“Recorded, not deducted” lists expenses that are already carried by the cost per carton in COGS, or held outside the P&amp;L by design. They are shown so this statement ties back to the Expense Report for the same period.</p>
        </div>
      `;
    } else if (reportType === 'topcustomers') {
      let rows = '';
      reportData.rows.forEach((r, i) => {
        rows += `<tr><td>${i + 1}</td><td>${escapeHtml(r.name)}<br/><span style="color:#666;font-size:11px;">${escapeHtml(r.location)}</span></td><td>KES ${r.invoiced.toLocaleString()}</td><td>KES ${r.paid.toLocaleString()}</td><td>KES ${r.outstanding.toLocaleString()}</td><td>${r.invoices}</td><td>${r.pct.toFixed(1)}%</td></tr>`;
      });
      htmlContent += `
        <div class="section">
          <div class="summary">Period: ${reportData.period} · Total Invoiced: KES ${reportData.totalInvoiced.toLocaleString()}</div>
          <table>
            <tr><th>#</th><th>Customer</th><th>Invoiced</th><th>Paid</th><th>Outstanding</th><th>Invoices</th><th>Share</th></tr>
            ${rows || '<tr><td colspan="7">No sales in this period</td></tr>'}
          </table>
          <p style="font-size:11px;color:#666;">Ranked by invoiced revenue.</p>
        </div>
      `;
    } else if (reportType === 'customersummary') {
      let rows = '';
      reportData.rows.forEach(r => {
        rows += `<tr><td>${escapeHtml(r.name)}<br/><span style="color:#666;font-size:11px;">${escapeHtml(r.location)} · ${r.invoices} inv.</span></td><td>KES ${r.invoiced.toLocaleString()}</td><td>KES ${r.paid.toLocaleString()}</td><td>KES ${r.outstanding.toLocaleString()}</td><td>${escapeHtml(r.lastPurchase)}</td></tr>`;
      });
      htmlContent += `
        <div class="section">
          <div class="summary">Period: ${reportData.period}<br/>Invoiced: KES ${reportData.totalInvoiced.toLocaleString()} · Paid: KES ${reportData.totalPaid.toLocaleString()} · Outstanding: KES ${reportData.totalOutstanding.toLocaleString()}</div>
          <table>
            <tr><th>Customer</th><th>Invoiced</th><th>Paid</th><th>Outstanding</th><th>Last purchase</th></tr>
            ${rows || '<tr><td colspan="5">No customer activity</td></tr>'}
          </table>
        </div>
      `;
    } else if (reportType === 'customerrevenue') {
      if (reportData.noCustomer) {
        htmlContent += `<div class="section"><p>No customer selected.</p></div>`;
      } else {
        let rows = '';
        reportData.months.forEach(m => {
          rows += `<tr><td>${escapeHtml(monthLabel(m.month))}</td><td>${m.invoices}</td><td>KES ${m.revenue.toLocaleString()}</td></tr>`;
        });
        htmlContent += `
          <div class="section">
            <div class="summary">${escapeHtml(reportData.customerName)} · ${escapeHtml(reportData.customerLocation)}<br/>Period: ${reportData.period} · Total Revenue: KES ${reportData.totalRevenue.toLocaleString()}</div>
            <table>
              <tr><th>Month</th><th>Invoices</th><th>Revenue</th></tr>
              ${rows || '<tr><td colspan="3">No sales in the selected period</td></tr>'}
            </table>
          </div>
        `;
      }
    } else if (reportType === 'productmix') {
      if (reportData.noCustomer) {
        htmlContent += `<div class="section"><p>No customer selected.</p></div>`;
      } else {
        let rows = '';
        reportData.rows.forEach(r => {
          const share = reportData.totalRevenue > 0 ? ((r.revenue / reportData.totalRevenue) * 100).toFixed(1) : '0.0';
          rows += `<tr><td>${escapeHtml(r.label)}</td><td>${r.quantity.toLocaleString()} ${r.isRefill ? 'btls' : 'ctns'}</td><td>KES ${r.revenue.toLocaleString()}</td><td>${share}%</td></tr>`;
        });
        htmlContent += `
          <div class="section">
            <div class="summary">${escapeHtml(reportData.customerName)} · ${escapeHtml(reportData.customerLocation)}<br/>Period: ${reportData.period} · Total Revenue: KES ${reportData.totalRevenue.toLocaleString()}</div>
            <table>
              <tr><th>Product</th><th>Quantity</th><th>Revenue</th><th>Share</th></tr>
              ${rows || '<tr><td colspan="4">No purchases in the selected period</td></tr>'}
            </table>
          </div>
        `;
      }
    } else if (reportType === 'productionreport') {
      let cartonRows = '';
      Object.entries(reportData.cartonsBySize).forEach(([size, qty]) => {
        cartonRows += `<tr><td>${SIZE_LABELS[size] || size}</td><td>${qty.toLocaleString()} cartons</td><td>${(reportData.bottlesBySize[size] || 0).toLocaleString()} bottles</td></tr>`;
      });
      let runRows = '';
      reportData.runs.forEach(run => {
        const items = Object.entries(run.items).filter(([, q]) => q).map(([size, q]) => `${q}× ${SIZE_LABELS[size] || size}`).join(', ') || '-';
        runRows += `<tr><td>#${run.id}</td><td>${run.date}</td><td>${escapeHtml(items)}</td><td>${run.totalCartons.toLocaleString()}</td><td>${run.casualCount}</td></tr>`;
      });
      htmlContent += `
        <div class="section">
          <div class="summary">
            Period: ${reportData.period} | Runs: ${reportData.totalRuns} | Cartons: ${reportData.totalCartons.toLocaleString()} | Bottles: ${reportData.totalBottles.toLocaleString()}
          </div>
          <h2>Production by Size</h2>
          <table>
            <thead><tr><th>Bottle Size</th><th>Cartons</th><th>Bottles</th></tr></thead>
            <tbody>${cartonRows || '<tr><td colspan="3">No production in the selected period</td></tr>'}</tbody>
          </table>
          <h2>Estimated Costs (information only — not posted to the P&L)</h2>
          <table>
            <tbody>
              <tr><td>Est. Finished-Goods Value</td><td>KES ${reportData.fgValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
              <tr><td>Est. Casual Labour Cost</td><td>KES ${reportData.casualCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td></tr>
            </tbody>
          </table>
          <h2>Production Runs</h2>
          <table>
            <thead><tr><th>Run</th><th>Date</th><th>Items</th><th>Cartons</th><th>Casuals</th></tr></thead>
            <tbody>${runRows || '<tr><td colspan="5">No production in the selected period</td></tr>'}</tbody>
          </table>
        </div>
      `;
    }

    htmlContent += `
        <div class="generated">
          <p>Generated by OASIS Springs Management System</p>
          <p>Northern Water Company Limited</p>
        </div>
      </body>
      </html>
    `;

    // Open the formatted report in a new window and trigger the print dialog.
    // The user chooses "Save as PDF" (built into every browser and phone),
    // which produces a genuine PDF that any reader can open.
    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups for this site to download the report.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();

    // Give the new window a moment to render, then open the print dialog
    printWindow.onload = () => {
      printWindow.focus();
      printWindow.print();
    };
    // Fallback in case onload doesn't fire
    setTimeout(() => {
      try { printWindow.focus(); printWindow.print(); } catch { /* window already closed */ }
    }, 500);
  };

  // Build a printable customer invoice and open it for printing / Save-as-PDF.
  // Read-only: renders an existing sale as a document, changes no records.
  const downloadInvoiceAsPDF = (sale) => {
    if (!sale) return;
    const customer = state.customers.find(c => c.id === sale.customerId);
    const paid = sale.paid || 0;
    const balance = sale.total - paid;
    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const statusLabel = balance <= 0 ? 'PAID' : paid > 0 ? 'PARTIALLY PAID' : 'UNPAID';
    const statusColor = balance <= 0 ? '#10b981' : paid > 0 ? '#d97706' : '#e11d48';

    const rows = sale.items.map(item => {
      const amount = item.subtotal || (item.quantity * item.price);
      return `
        <tr>
          <td>${SIZE_LABELS[item.size] || item.size}</td>
          <td style="text-align:center;">${item.quantity}</td>
          <td style="text-align:right;">${fmt(item.price)}</td>
          <td style="text-align:right;">${fmt(amount)}</td>
        </tr>`;
    }).join('');

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Invoice ${escapeHtml(sale.invoiceNumber)}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 32px; color: #1e293b; background: #fff; }
          .invoice { max-width: 760px; margin: 0 auto; }
          .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0369a1; padding-bottom: 16px; }
          .brand { display: flex; gap: 14px; align-items: center; }
          .brand img { width: 72px; height: 72px; border-radius: 50%; }
          .brand h1 { margin: 0; font-size: 20px; color: #0369a1; }
          .brand p { margin: 2px 0 0; font-size: 12px; color: #64748b; }
          .seller { text-align: right; font-size: 12px; color: #475569; }
          .seller strong { color: #0f172a; }
          .title { text-align: right; margin-top: 18px; }
          .title h2 { margin: 0; font-size: 28px; letter-spacing: 2px; color: #0f172a; }
          .meta { margin-top: 6px; font-size: 13px; color: #475569; }
          .billto { margin-top: 24px; }
          .billto .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 4px; }
          .billto .name { font-size: 16px; font-weight: bold; color: #0f172a; }
          .billto .sub { font-size: 13px; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 13px; }
          thead th { background: #0369a1; color: #fff; padding: 10px 12px; text-align: left; }
          thead th:nth-child(2) { text-align: center; }
          thead th:nth-child(3), thead th:nth-child(4) { text-align: right; }
          tbody td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
          tbody tr:nth-child(even) { background: #f8fafc; }
          .totals { margin-top: 18px; margin-left: auto; width: 280px; font-size: 13px; }
          .totals .row { display: flex; justify-content: space-between; padding: 6px 0; }
          .totals .row.grand { border-top: 2px solid #0f172a; margin-top: 6px; padding-top: 10px; font-size: 16px; font-weight: bold; }
          .totals .balance { color: #e11d48; font-weight: bold; }
          .status { display: inline-block; margin-top: 18px; padding: 6px 14px; border-radius: 999px; color: #fff; font-size: 12px; font-weight: bold; letter-spacing: 1px; background: ${statusColor}; }
          .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
          @media print { body { padding: 0; } .invoice { max-width: 100%; } }
        </style>
      </head>
      <body>
        <div class="invoice">
          <div class="top">
            <div class="brand">
              <img src="${OASIS_LOGO}" alt="OASIS Springs" />
              <div>
                <h1>${COMPANY.name}</h1>
                <p>${COMPANY.brand}</p>
              </div>
            </div>
            <div class="seller">
              <p><strong>Tel:</strong> ${COMPANY.phone}</p>
              <p><strong>KRA PIN:</strong> ${COMPANY.kraPin}</p>
            </div>
          </div>

          <div class="title">
            <h2>INVOICE</h2>
            <div class="meta"><strong>${escapeHtml(sale.invoiceNumber)}</strong> &nbsp;•&nbsp; ${escapeHtml(sale.date)}</div>
          </div>

          <div class="billto">
            <div class="label">Bill To</div>
            <div class="name">${escapeHtml(customer?.name || 'Walk-in Customer')}</div>
            ${customer?.location ? `<div class="sub">${escapeHtml(customer.location)}</div>` : ''}
            ${customer?.phone ? `<div class="sub">Tel: ${escapeHtml(customer.phone)}</div>` : ''}
          </div>

          <table>
            <thead>
              <tr><th>Description</th><th>Qty</th><th>Unit Price (KES)</th><th>Amount (KES)</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>

          <div class="totals">
            <div class="row"><span>Total</span><span>KES ${fmt(sale.total)}</span></div>
            <div class="row"><span>Paid</span><span>KES ${fmt(paid)}</span></div>
            <div class="row grand"><span>Balance Due</span><span class="${balance > 0 ? 'balance' : ''}">KES ${fmt(balance)}</span></div>
          </div>

          <div><span class="status">${statusLabel}</span></div>

          <div class="footer">
            <p>Thank you for your business.</p>
            <p>${COMPANY.name} • Generated by OASIS Springs Management System</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups for this site to download the invoice.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    printWindow.onload = () => { printWindow.focus(); printWindow.print(); };
    setTimeout(() => {
      try { printWindow.focus(); printWindow.print(); } catch { /* window already closed */ }
    }, 500);
  };

  // Build a printable customer account statement: a chronological ledger of
  // invoices (debits) and payments (credits) with a running balance. Optionally
  // scoped to a date range, in which case an opening balance carries forward all
  // activity before the start date. With no range, the closing balance equals the
  // customer's current outstanding debt, so it reconciles with the balance shown
  // in the UI and the Aging Debtors report.
  // Read-only — renders existing records, changes nothing.
  const downloadAccountStatementAsPDF = (customer, range = { start: '', end: '' }) => {
    if (!customer) return;
    const fmt = (n) => Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const prettyMethod = (m) => (m ? String(m).replace(/_/g, ' ') : '');
    const hasRange = !!(range.start && range.end);

    const sales = state.sales.filter(s => s.customerId === customer.id);
    const payments = state.payments.filter(p => p.customerId === customer.id);

    // Ledger entries: each sale is a debit of its total. Its payment is split into
    // recorded debt-payments and any amount paid at point of sale (mirrors the Cash
    // Collected report so nothing is double-counted or dropped).
    const allEntries = [];
    sales.forEach(s => {
      const items = (s.items || []).map(i => `${i.quantity}× ${SIZE_LABELS[i.size] || i.size}`).join(', ');
      allEntries.push({
        date: s.date,
        order: 0,
        ref: s.invoiceNumber || `Sale #${s.id}`,
        desc: `Invoice${items ? ' · ' + items : ''}`,
        debit: s.total || 0,
        credit: 0
      });
      const linkedPayments = payments.filter(p => p.saleId === s.id);
      const paidViaPayments = linkedPayments.reduce((sum, p) => sum + (p.amount || 0), 0);
      const paidAtSale = (s.paid || 0) - paidViaPayments;
      if (paidAtSale > 0) {
        allEntries.push({
          date: s.date,
          order: 1,
          ref: s.invoiceNumber || `Sale #${s.id}`,
          desc: 'Payment at point of sale',
          debit: 0,
          credit: paidAtSale
        });
      }
    });
    payments.forEach(p => {
      allEntries.push({
        date: p.date,
        order: 1,
        ref: p.reference || (p.invoiceNumber || ''),
        desc: `Payment${p.method ? ' · ' + prettyMethod(p.method) : ''}`,
        debit: 0,
        credit: p.amount || 0
      });
    });

    // Chronological order; on the same date show the invoice before its payment.
    allEntries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));

    // Opening balance = net of everything before the start date; in-range entries
    // are those within [start, end]. With no range, opening is 0 and all show.
    let opening = 0;
    const entries = [];
    allEntries.forEach(e => {
      const d = e.date || '';
      if (hasRange && d && d < range.start) {
        opening += e.debit - e.credit;
      } else if (!hasRange || (d >= range.start && d <= range.end)) {
        entries.push(e);
      }
    });

    let running = opening;
    let rows = hasRange ? `
        <tr style="background:#f0f9ff;">
          <td>${range.start}</td>
          <td>—</td>
          <td><strong>Opening balance</strong></td>
          <td style="text-align:right;">—</td>
          <td style="text-align:right;">—</td>
          <td style="text-align:right;font-weight:bold;">${fmt(opening)}</td>
        </tr>` : '';
    rows += entries.map(e => {
      running += e.debit - e.credit;
      return `
        <tr>
          <td>${escapeHtml(e.date || '—')}</td>
          <td>${escapeHtml(e.ref || '—')}</td>
          <td>${escapeHtml(e.desc)}</td>
          <td style="text-align:right;">${e.debit ? fmt(e.debit) : '—'}</td>
          <td style="text-align:right;color:#059669;">${e.credit ? fmt(e.credit) : '—'}</td>
          <td style="text-align:right;font-weight:bold;">${fmt(running)}</td>
        </tr>`;
    }).join('');

    // Totals reflect the shown period. In-range charges/payments plus the opening
    // balance give the closing balance as at the end date.
    const totalCharged = entries.reduce((sum, e) => sum + e.debit, 0);
    const totalPaid = entries.reduce((sum, e) => sum + e.credit, 0);
    const closing = opening + totalCharged - totalPaid; // positive => customer owes

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <title>Statement - ${escapeHtml(customer.name)}</title>
        <style>
          * { box-sizing: border-box; }
          body { font-family: Arial, Helvetica, sans-serif; margin: 0; padding: 32px; color: #1e293b; background: #fff; }
          .stmt { max-width: 800px; margin: 0 auto; }
          .top { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 3px solid #0369a1; padding-bottom: 16px; }
          .brand { display: flex; gap: 14px; align-items: center; }
          .brand img { width: 72px; height: 72px; border-radius: 50%; }
          .brand h1 { margin: 0; font-size: 20px; color: #0369a1; }
          .brand p { margin: 2px 0 0; font-size: 12px; color: #64748b; }
          .seller { text-align: right; font-size: 12px; color: #475569; }
          .seller strong { color: #0f172a; }
          .title { text-align: right; margin-top: 18px; }
          .title h2 { margin: 0; font-size: 26px; letter-spacing: 2px; color: #0f172a; }
          .meta { margin-top: 6px; font-size: 13px; color: #475569; }
          .billto { margin-top: 24px; }
          .billto .label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: #94a3b8; margin-bottom: 4px; }
          .billto .name { font-size: 16px; font-weight: bold; color: #0f172a; }
          .billto .sub { font-size: 13px; color: #64748b; }
          table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 12px; }
          thead th { background: #0369a1; color: #fff; padding: 9px 10px; text-align: left; }
          thead th:nth-child(4), thead th:nth-child(5), thead th:nth-child(6) { text-align: right; }
          tbody td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          tbody tr:nth-child(even) { background: #f8fafc; }
          .totals { margin-top: 18px; margin-left: auto; width: 300px; font-size: 13px; }
          .totals .row { display: flex; justify-content: space-between; padding: 6px 0; }
          .totals .row.grand { border-top: 2px solid #0f172a; margin-top: 6px; padding-top: 10px; font-size: 16px; font-weight: bold; }
          .totals .owed { color: #e11d48; font-weight: bold; }
          .totals .credit { color: #059669; font-weight: bold; }
          .footer { margin-top: 40px; padding-top: 14px; border-top: 1px solid #e2e8f0; font-size: 11px; color: #94a3b8; text-align: center; }
          .empty { margin-top: 24px; padding: 20px; text-align: center; color: #94a3b8; font-size: 13px; border: 1px dashed #e2e8f0; border-radius: 8px; }
          @media print { body { padding: 0; } .stmt { max-width: 100%; } }
        </style>
      </head>
      <body>
        <div class="stmt">
          <div class="top">
            <div class="brand">
              <img src="${OASIS_LOGO}" alt="OASIS Springs" />
              <div>
                <h1>${COMPANY.name}</h1>
                <p>${COMPANY.brand}</p>
              </div>
            </div>
            <div class="seller">
              <p><strong>Tel:</strong> ${COMPANY.phone}</p>
              <p><strong>KRA PIN:</strong> ${COMPANY.kraPin}</p>
            </div>
          </div>

          <div class="title">
            <h2>STATEMENT OF ACCOUNT</h2>
            <div class="meta">${hasRange ? `Period: ${range.start} to ${range.end}` : `As at ${new Date().toLocaleDateString()}`}</div>
          </div>

          <div class="billto">
            <div class="label">Account</div>
            <div class="name">${escapeHtml(customer.name)}</div>
            ${customer.location ? `<div class="sub">${escapeHtml(customer.location)}</div>` : ''}
            ${customer.phone ? `<div class="sub">Tel: ${escapeHtml(customer.phone)}</div>` : ''}
          </div>

          ${entries.length === 0 && !hasRange ? `<div class="empty">No transactions on record for this account.</div>` : entries.length === 0 ? `<div class="empty">No transactions in this period. Opening balance carried: KES ${fmt(opening)}.</div>` : `
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Reference</th>
                <th>Description</th>
                <th>Charge (KES)</th>
                <th>Paid (KES)</th>
                <th>Balance (KES)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>`}

          <div class="totals">
            ${hasRange ? `<div class="row"><span>Opening Balance</span><span>KES ${fmt(opening)}</span></div>` : ''}
            <div class="row"><span>${hasRange ? 'Invoiced (period)' : 'Total Invoiced'}</span><span>KES ${fmt(totalCharged)}</span></div>
            <div class="row"><span>${hasRange ? 'Paid (period)' : 'Total Paid'}</span><span>KES ${fmt(totalPaid)}</span></div>
            <div class="row grand"><span>${closing >= 0 ? 'Balance Due' : 'Credit Balance'}</span><span class="${closing > 0 ? 'owed' : closing < 0 ? 'credit' : ''}">KES ${fmt(Math.abs(closing))}</span></div>
          </div>

          <div class="footer">
            <p>${hasRange ? 'This statement reflects invoices and payments within the period shown, carried forward from the opening balance.' : 'This statement reflects all invoices and payments on record as at the date shown above.'}</p>
            <p>${COMPANY.name} • Generated by OASIS Springs Management System</p>
          </div>
        </div>
      </body>
      </html>
    `;

    const printWindow = window.open('', '_blank');
    if (!printWindow) {
      alert('Please allow pop-ups for this site to download the statement.');
      return;
    }
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    printWindow.onload = () => { printWindow.focus(); printWindow.print(); };
    setTimeout(() => {
      try { printWindow.focus(); printWindow.print(); } catch { /* window already closed */ }
    }, 500);
  };

  // Expense Management
  const handleAddExpense = () => {
    setEditingExpense(null);
    setModalType('expense');
    setFormData({ 
      date: localDateString(),
      category: 'Raw Materials',
      subcategory: '',
      description: '',
      amount: 0
    });
    setShowModal(true);
  };

  const handleSaveExpense = async () => {
    if (!formData.category || !formData.subcategory || formData.amount <= 0) {
      alert('Please fill all fields');
      return;
    }

    const advanceId = formData.advanceEmployeeId ? parseInt(formData.advanceEmployeeId) : null;

    if (editingExpense) {
      // Persist FIRST — only reflect the edit locally once the database
      // accepts it (supabase returns errors rather than throwing).
      const { error: updError } = await withTimeout(supabase
        .from('expenses')
        .update({
          date: formData.date,
          category: formData.category,
          subcategory: formData.subcategory,
          description: formData.description || '',
          amount: parseFloat(formData.amount),
          advance_employee_id: advanceId
        })
        .eq('id', editingExpense.id));
      if (updError) {
        console.error('❌ Error updating expense:', updError);
        alert(saveFailureMessage(
          updError,
          'Could not update this expense — it has NOT been changed. Please try again.',
          'the expense in the Expenses list'
        ));
        return;
      }

      const updated = { ...editingExpense, ...formData, amount: parseFloat(formData.amount), advance_employee_id: advanceId };
      const updatedExpenses = state.expenses.map(e =>
        e.id === editingExpense.id ? updated : e
      );
      setState({ ...state, expenses: updatedExpenses });
      console.log('✅ Expense updated in Supabase');
    } else {
      const newExpense = {
        date: formData.date,
        category: formData.category,
        subcategory: formData.subcategory,
        description: formData.description || '',
        amount: parseFloat(formData.amount),
        advance_employee_id: advanceId,
        created_by: session?.user?.id || null
      };

      const { data: savedExpense, error: expError } = await withTimeout(supabase
        .from('expenses')
        .insert([newExpense])
        .select()
        .single());
      if (expError || !savedExpense) {
        console.error('❌ Error saving expense:', expError);
        alert(saveFailureMessage(
          expError,
          'Could not save this expense — it has NOT been recorded. Please try again.',
          'the Expenses list'
        ));
        return;
      }

      setState({ ...state, expenses: [...state.expenses, savedExpense] });
    }
    setShowModal(false);
  };

  // Persist-first: the expense row is deleted (and the result checked) before
  // any local change. Only after a confirmed delete are the linked payroll
  // records removed and production runs un-flagged — previously a rejected
  // expense delete could still un-flag runs, showing casual pay as due again
  // and inviting a double payout.
  const handleDeleteExpense = async (id) => {
    if (!confirm('Delete this expense?')) return;

    const { error: delError } = await supabase.from('expenses').delete().eq('id', id);
    if (delError) {
      console.error('❌ Error deleting expense:', delError);
      alert('Could not delete this expense — nothing was changed. Please try again.\n\n' + (delError.message || 'Unknown error'));
      return;
    }

    // If this expense was created by a payroll payment, remove those payment
    // records too, so salary "Paid" status and casual history stay accurate.
    const linkedPayments = payrollPayments.filter(p => p.expense_id === id);
    // If this was a casual payout, un-flag the production runs it paid for,
    // so they return to "Pay Due".
    const runsToUnflag = state.productionLogs.filter(log => log.casual_expense_id === id).map(log => log.id);
    const updatedLogs = runsToUnflag.length > 0
      ? state.productionLogs.map(log => log.casual_expense_id === id ? { ...log, casual_paid: false, casual_expense_id: null } : log)
      : state.productionLogs;

    if (linkedPayments.length > 0) {
      setPayrollPayments(payrollPayments.filter(p => p.expense_id !== id));
      const { error: payDelError } = await supabase.from('payroll_payments').delete().eq('expense_id', id);
      if (payDelError) {
        console.error('❌ Error deleting linked payroll records:', payDelError);
        alert('Expense deleted, but its payroll records could not be removed — the HR "Paid" status may be wrong. Please check HR.');
      }
    }
    for (const runId of runsToUnflag) {
      const { error: unflagError } = await supabase.from('production_logs')
        .update({ casual_paid: false, casual_expense_id: null }).eq('id', runId);
      if (unflagError) {
        console.error('❌ Error un-flagging production run:', unflagError);
        alert('Expense deleted, but a production run could not be returned to "Pay Due". Please check the Casual Pay view.');
      }
    }

    setState({
      ...state,
      expenses: state.expenses.filter(e => e.id !== id),
      productionLogs: updatedLogs
    });
    console.log('✅ Expense deleted from Supabase');
  };

  // Delete Sale — reverses inventory deduction and customer debt.
  // The whole reversal (linked payments, the sale, the cartons and the balance)
  // happens in ONE transaction server-side, so it can no longer half-complete.
  // The consignment guard and the balance arithmetic are enforced there too;
  // the checks here are for a clear message before anything is attempted.
  // See migration 011.
  const handleDeleteSale = async (id) => {
    const sale = state.sales.find(s => s.id === id);
    if (!sale) return;

    // Consignment sales must not be deleted through this flow: their stock was
    // deducted at DELIVERY, not at the sale, so the normal reversal below would
    // add cartons back that were never taken here — silently inflating stock.
    // (Reconciliation credit notes are also consignment-linked.)
    if (state.consignmentMovements.some(m => m.sale_id === id)) {
      alert('This sale is linked to consignment stock and cannot be deleted here — deleting it would corrupt the consignment stock and finished-goods counts. Handle it from the Consignment view instead (record a return or an opposing entry).');
      return;
    }

    const linkedPayments = state.payments.filter(p => p.saleId === id);
    let confirmMsg = `Delete sale ${sale.invoiceNumber}? This will return the stock to inventory`;
    if (sale.paid > 0 || linkedPayments.length > 0) {
      confirmMsg += ` and remove ${linkedPayments.length} linked payment(s)`;
    }
    confirmMsg += '. This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    // One transaction: linked payments, the sale, the returned cartons and the
    // balance reversal all succeed together or none of them happen. There is no
    // longer a "payments deleted but sale survived" state to compensate for.
    const { data, error } = await supabase.rpc('delete_sale', { p_sale_id: id });
    if (error) {
      console.error('❌ Error deleting sale:', error);
      alert('Could not delete this sale — nothing was changed. The sale, its payments, the stock and the balance are all as they were.\n\n' + (error.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      sales: state.sales.filter(s => s.id !== id),
      payments: state.payments.filter(p => p.saleId !== id),
      ...applyRpcRows(data),
    });
    console.log('✅ Sale deleted and reversed in Supabase');
  };

  // Delete Production Log — returns finished goods and restores raw materials.
  // One transaction (migration 015): the row is removed and the stock reversed
  // together, or neither happens. A refused delete can no longer leave stock
  // reversed with the run still on the books, or the run deleted with its stock
  // never returned. The reversal is derived server-side from the stored run, so
  // it is by construction the exact inverse of what the run deducted.
  const handleDeleteProduction = async (id) => {
    const log = state.productionLogs.find(p => p.id === id);
    if (!log) return;
    if (!confirm('Delete this production log? This will reverse the raw materials used and the finished goods produced. This cannot be undone.')) return;

    const { data, error } = await supabase.rpc('delete_production', { p_id: id });
    if (error) {
      console.error('❌ Error deleting production log:', error);
      alert('Could not delete this production log — nothing was changed. Please try again.\n\n' + (error.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      productionLogs: state.productionLogs.filter(p => p.id !== id),
      ...(data?.inventory && {
        rawMaterials: data.inventory.rawMaterials,
        finishedGoods: data.inventory.finishedGoods,
      }),
    });
    console.log('✅ Production log deleted and reversed in Supabase');
  };

  // Add Sale
  const handleAddSale = () => {
    setModalType('sale');
    setSaleCustomerSearch('');
    setFormData({
      customerId: '',
      items: [{ size: '0.5L', quantity: 0, price: 0 }],
      date: localDateString(),
      // null = "paid in full": the Amount Paid input tracks the running total
      // until the cashier types an amount themselves (partial/credit sale).
      amountPaid: null,
      method: 'cash',
      clientKey: newClientKey()
    });
    setShowModal(true);
  };

  const handleSaveSale = async () => {
    if (!formData.customerId || formData.items.filter(i => i.quantity > 0).length === 0) {
      alert('Please select customer and add items');
      return;
    }

    // Belt-and-braces: the picker already hides consignment shops, but a shop
    // flagged while this form was open would otherwise slip through and deduct
    // finished goods a second time (they left the plant at delivery).
    const saleCustomer = state.customers.find(c => c.id === parseInt(formData.customerId));
    if (saleCustomer?.is_consignee) {
      alert(`${saleCustomer.name} is a consignment shop, so it cannot be invoiced from here — the stock it holds was already deducted when it was delivered.\n\nRecord what it sold under Inventory → Consignment → Report Sold instead.`);
      return;
    }

    // Prices are entered manually — guard against accidentally saving a
    // line that has a quantity but no price (which would be a KES 0 invoice).
    if (formData.items.some(i => i.quantity > 0 && (!i.price || i.price <= 0))) {
      alert('Please enter a price for every item with a quantity.');
      return;
    }

    // Use prices as entered manually - NO auto-pricing
    const validItems = formData.items.filter(i => i.quantity > 0).map(item => ({
      ...item
      // Price stays as entered by user - no auto-lookup
    }));

    const total = validItems.reduce((sum, i) => sum + (i.quantity * i.price), 0);
    // null means the cashier never touched the Amount Paid field → paid in full.
    const amountPaid = formData.amountPaid === null ? total : (parseInt(formData.amountPaid) || 0);

    if (amountPaid < 0 || amountPaid > total) {
      alert(`Amount paid must be between 0 and the sale total of KES ${total.toLocaleString()}`);
      return;
    }

    // id and invoiceNumber are assigned by the database (identity column +
    // invoice-number sequence) — never on the client, which only ever sees an
    // RLS-filtered subset of sales and would generate colliding values.
    const newSale = {
      customerId: parseInt(formData.customerId),
      date: formData.date,
      items: validItems,
      total,
      paid: amountPaid,
      status: amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'pending',
      // How the point-of-sale amount was received; later repayments carry their
      // own method on the payment record.
      method: amountPaid > 0 ? (formData.method || 'cash') : null,
      created_by: session?.user?.id || null,
      // Identifies this filled-in form. If the sale committed but the response
      // was lost, resending it returns the sale already recorded instead of
      // writing a second one.
      client_key: formData.clientKey || null
    };

    // One transaction: the sale row, the finished-goods deduction and the
    // customer's debt all move together or not at all. The balance is applied
    // server-side as a delta on the committed value, so a stale session can no
    // longer overwrite someone else's payment. See migration 011.
    const { data, error } = await withTimeout(supabase.rpc('record_sale', { p_sale: newSale }));
    if (error || !data?.sale) {
      console.error('❌ Error recording sale:', error);
      alert(saveFailureMessage(
        error,
        'Could not save this sale — nothing was recorded, and stock and balances are unchanged. Please try again.',
        'the Sales list',
        true
      ));
      return; // leave the modal open with the entry intact
    }

    setState({
      ...state,
      sales: upsertById(state.sales, data.sale),
      ...applyRpcRows(data),
    });

    // The database recognised this form as one it had already saved — the
    // earlier attempt did commit, its response just never arrived.
    if (data.replayed) {
      alert(`This sale was already recorded as invoice ${data.sale.invoiceNumber}. It has not been saved twice.`);
    }

    setShowModal(false);
  };

  // ===== CONSIGNMENT =====
  // Consignment shops hold OUR finished-goods stock. Delivering to a shop is a
  // TRANSFER, not a sale — no revenue and no debt until the shop reports what it
  // actually sold. Money always lives in `sales`; this ledger tracks stock only.
  // See migration 008_consignment.sql.

  const consignees = () => state.customers.filter(c => c.is_consignee);

  // Customers selectable on a new sale, honouring the search box. Consignment
  // shops are excluded on purpose: their cartons already left finished goods at
  // delivery, so an ordinary sale to them would deduct stock a second time and
  // double-count the revenue that Report Sold recognises.
  //
  // Filters visibleCustomers, not state.customers: a sales user may only insert
  // a sale for a customer at their own location (sales_insert_non_admin), so
  // offering them anyone else produces an RLS refusal at save time instead of
  // the customer simply not being on the list. Every other sales-role view
  // already goes through this filter; this one was missed.
  const saleCustomerOptions = () => {
    const q = saleCustomerSearch.toLowerCase();
    return visibleCustomers.filter(c =>
      !c.is_consignee && (
        !q ||
        c.name.toLowerCase().includes(q) ||
        (c.location || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q)
      )
    );
  };

  // Cartons a shop currently holds, per size, derived from the movement ledger.
  const getConsignmentOnHand = (shopId) => {
    const onHand = {};
    state.consignmentMovements
      .filter(m => m.shop_id === shopId)
      .forEach(m => {
        const sign = (m.type === 'deliver' || m.type === 'reconcile') ? 1 : -1;
        onHand[m.size] = (onHand[m.size] || 0) + sign * Number(m.quantity);
      });
    return onHand;
  };

  // Stock sitting at consignment shops, valued at the same carton cost as plant
  // finished goods. Delivering to a shop is a transfer, not a sale, so these
  // cartons are still a company asset — they were just deducted from
  // finishedGoods at delivery and would otherwise vanish from the balance sheet
  // until the shop reports them sold.
  //
  // Note this reads the movement ledger, which is only loaded for admin/manager
  // (loadDataFromSupabase tier 2). Sales users get 0 here, which is correct
  // because no asset figure is shown to them.
  const calculateConsignmentStockValue = () => {
    let total = 0;
    consignees().forEach(shop => {
      Object.entries(getConsignmentOnHand(shop.id)).forEach(([size, cartons]) => {
        total += (cartons || 0) * (cartonCosts[size] || 0);
      });
    });
    return total;
  };

  // The single source for the headline asset figure, so the dashboard header and
  // the Cost Settings panel can never drift apart.
  const calculateTotalAssets = () =>
    calculateInventoryValue() + calculateFinishedGoodsValue() + calculateConsignmentStockValue();

  const openConsignment = (action, shopId) => {
    const sizes = Object.keys(state.finishedGoods);
    const lines = {}; const prices = {};
    sizes.forEach(s => { lines[s] = ''; prices[s] = ''; });
    setModalType('consignment');
    setFormData({
      consignAction: action,
      shopId: shopId ? String(shopId) : '',
      date: localDateString(),
      lines, prices, amountPaid: '', method: 'cash', note: ''
    });
    setShowModal(true);
  };

  // Parse the per-size line inputs into [{ size, quantity, price }] (qty > 0 only).
  const consignmentLines = () =>
    Object.entries(formData.lines || {})
      .map(([size, q]) => ({
        size,
        quantity: parseFloat(q) || 0,
        price: parseFloat((formData.prices || {})[size]) || 0,
      }))
      .filter(l => l.quantity > 0);

  // Deliver stock to a shop: plant finished goods DOWN, shop consignment UP. No money.
  const handleConsignDeliver = async () => {
    const shopId = parseInt(formData.shopId);
    if (!shopId) { alert('Select a consignment shop'); return; }
    const lines = consignmentLines();
    if (lines.length === 0) { alert('Enter at least one quantity to deliver'); return; }

    for (const l of lines) {
      const avail = state.finishedGoods[l.size]?.quantity ?? 0;
      if (l.quantity > avail) {
        alert(`Not enough ${SIZE_LABELS[l.size] || l.size} in the plant — have ${avail}, trying to send ${l.quantity}.`);
        return;
      }
    }

    // One transaction (migration 016): the ledger rows and the plant stock move
    // together or not at all. The old two-step version could commit the movement
    // rows and then fail to deduct finished goods, which double-counted those
    // cartons — once as plant stock, once as consignment stock, both feeding
    // calculateTotalAssets. created_by and the stock delta are set server-side,
    // and the "enough at the plant" limit is re-checked there under the row lock.
    const { data, error } = await supabase.rpc('consignment_move_stock', {
      p_shop_id: shopId,
      p_type: 'deliver',
      p_movements: lines.map(l => ({
        size: l.size,
        quantity: l.quantity,
        date: formData.date || localDateString(),
        note: formData.note || null,
      })),
    });

    if (error || !data?.movements) {
      console.error('❌ Error saving consignment delivery:', error);
      alert('Could not record this delivery — nothing was changed. Please try again.\n\n' + (error?.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      ...(data.inventory && {
        rawMaterials: data.inventory.rawMaterials,
        finishedGoods: data.inventory.finishedGoods,
      }),
      consignmentMovements: [...state.consignmentMovements, ...data.movements],
    });
    setShowModal(false);
  };

  // Take stock back from a shop: shop consignment DOWN, plant finished goods UP. No money.
  const handleConsignReturn = async () => {
    const shopId = parseInt(formData.shopId);
    if (!shopId) { alert('Select a consignment shop'); return; }
    const lines = consignmentLines();
    if (lines.length === 0) { alert('Enter at least one quantity to take back'); return; }

    const onHand = getConsignmentOnHand(shopId);
    for (const l of lines) {
      if (l.quantity > (onHand[l.size] || 0)) {
        alert(`${SIZE_LABELS[l.size] || l.size}: the shop holds only ${onHand[l.size] || 0}, cannot take back ${l.quantity}.`);
        return;
      }
    }

    // Atomic, same as the delivery above (migration 016). The "shop holds that
    // much" limit is re-derived server-side from the ledger after the rows are
    // inserted, so a stale local copy of the movements can no longer let a shop
    // hand back more than it has.
    const { data, error } = await supabase.rpc('consignment_move_stock', {
      p_shop_id: shopId,
      p_type: 'return',
      p_movements: lines.map(l => ({
        size: l.size,
        quantity: l.quantity,
        date: formData.date || localDateString(),
        note: formData.note || null,
      })),
    });

    if (error || !data?.movements) {
      console.error('❌ Error saving consignment return:', error);
      alert('Could not record this take-back — nothing was changed. Please try again.\n\n' + (error?.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      ...(data.inventory && {
        rawMaterials: data.inventory.rawMaterials,
        finishedGoods: data.inventory.finishedGoods,
      }),
      consignmentMovements: [...state.consignmentMovements, ...data.movements],
    });
    setShowModal(false);
  };

  // Shop reports what it sold: creates a REAL sale (revenue + debt) and draws the
  // stock down from consignment. Finished goods are NOT touched — already deducted
  // at delivery. This is where money is finally recognised.
  const handleConsignReportSold = async () => {
    const shopId = parseInt(formData.shopId);
    if (!shopId) { alert('Select a consignment shop'); return; }
    const lines = consignmentLines();
    if (lines.length === 0) { alert('Enter the quantities the shop sold'); return; }
    if (lines.some(l => l.price <= 0)) { alert('Enter a unit price for every size sold'); return; }

    const onHand = getConsignmentOnHand(shopId);
    for (const l of lines) {
      if (l.quantity > (onHand[l.size] || 0)) {
        alert(`${SIZE_LABELS[l.size] || l.size}: the shop holds only ${onHand[l.size] || 0}, cannot report ${l.quantity} sold.`);
        return;
      }
    }

    const items = lines.map(l => ({ size: l.size, quantity: l.quantity, price: l.price }));
    const total = items.reduce((s, i) => s + i.quantity * i.price, 0);
    const amountPaid = formData.amountPaid === '' || formData.amountPaid == null ? 0 : (parseFloat(formData.amountPaid) || 0);
    if (amountPaid < 0 || amountPaid > total) {
      alert(`Amount paid must be between 0 and the total of KES ${total.toLocaleString()}`);
      return;
    }

    const date = formData.date || localDateString();
    const newSale = {
      customerId: shopId,
      date,
      items,
      total,
      paid: amountPaid,
      status: amountPaid >= total ? 'paid' : amountPaid > 0 ? 'partial' : 'pending',
      method: amountPaid > 0 ? (formData.method || 'cash') : null,
      created_by: session?.user?.id || null,
    };

    const rows = lines.map(l => ({
      type: 'sold',
      date,
      size: l.size,
      quantity: l.quantity,
      unit_price: l.price,
      created_by: session?.user?.id || null,
    }));

    // One transaction: the sale, the 'sold' movements that reference it, and the
    // shop's debt. The books and the stock ledger can no longer separate.
    const { data, error } = await supabase.rpc('consignment_post_sale', {
      p_sale: newSale, p_movements: rows,
    });
    if (error || !data?.sale) {
      console.error('❌ Error recording consignment sale:', error);
      alert('Could not record this sale — nothing was changed. The shop\'s stock and balance are as they were.\n\n' + (error?.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      sales: [...state.sales, data.sale],
      consignmentMovements: [...state.consignmentMovements, ...(data.movements || [])],
      ...applyRpcRows(data),
    });

    setShowModal(false);
  };

  // Cutover reconciliation (admin): enter the stock a shop is PHYSICALLY holding
  // that was previously (wrongly) booked as a credit sale. Seeds that as
  // consignment stock and posts a credit-note sale (negative total + negative
  // quantities) that reverses the over-recognised revenue AND cost of goods, and
  // lifts the same value off the shop's debt.
  const handleConsignReconcile = async () => {
    const shopId = parseInt(formData.shopId);
    if (!shopId) { alert('Select a consignment shop'); return; }
    const lines = consignmentLines();
    if (lines.length === 0) { alert('Enter the stock the shop is physically holding'); return; }
    if (lines.some(l => l.price <= 0)) { alert('Enter the unit price each size was originally invoiced at'); return; }

    const value = lines.reduce((s, l) => s + l.quantity * l.price, 0);
    const cartons = lines.reduce((s, l) => s + l.quantity, 0);
    const shop = state.customers.find(c => c.id === shopId);
    if (!confirm(
      `Reconcile ${shop?.name || 'shop'}:\n\n` +
      `• Seed ${cartons} carton(s) as consignment stock they still hold.\n` +
      `• Reverse KES ${value.toLocaleString()} of previously-booked revenue.\n` +
      `• Reduce their debt by KES ${value.toLocaleString()}.\n\n` +
      `A credit-note sale is created for the audit trail. Continue?`
    )) return;

    const date = formData.date || localDateString();
    // Negative total reverses revenue; negative-quantity items reverse the COGS
    // that was recognised on the original sale. status 'paid' (0 >= negative total).
    const creditNote = {
      customerId: shopId,
      date,
      items: lines.map(l => ({ size: l.size, quantity: -l.quantity, price: l.price })),
      total: -value,
      paid: 0,
      status: 'paid',
      method: null,
      created_by: session?.user?.id || null,
    };
    const rows = lines.map(l => ({
      type: 'reconcile',
      date,
      size: l.size,
      quantity: l.quantity,
      unit_price: l.price,
      note: 'Cutover reconciliation',
      created_by: session?.user?.id || null,
    }));

    // Same transaction as Report Sold, with a negative total: the credit note,
    // the seeded stock and the debt reduction all land together. The server
    // reduces the balance by -(total - paid), which for a negative total is a
    // credit. Only an admin may post either half (migration 010).
    const { data, error } = await supabase.rpc('consignment_post_sale', {
      p_sale: creditNote, p_movements: rows,
    });
    if (error || !data?.sale) {
      console.error('❌ Error recording reconciliation:', error);
      alert('Could not record the reconciliation — nothing was changed. The shop\'s stock and debt are as they were.\n\n' + (error?.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      sales: [...state.sales, data.sale],
      consignmentMovements: [...state.consignmentMovements, ...(data.movements || [])],
      ...applyRpcRows(data),
    });

    setShowModal(false);
  };

  const handleSaveConsignment = () => {
    switch (formData.consignAction) {
      case 'deliver': return handleConsignDeliver();
      case 'return': return handleConsignReturn();
      case 'sold': return handleConsignReportSold();
      case 'reconcile': return handleConsignReconcile();
      default: return;
    }
  };

  // Add Payment
  const handleAddPayment = () => {
    const pendingSales = state.sales.filter(s => s.paid < s.total);
    if (pendingSales.length === 0) {
      alert('No pending sales');
      return;
    }
    setModalType('payment');
    setPaymentSaleSearch('');
    setFormData({ saleId: '', amount: 0, method: 'cash', reference: '', date: localDateString(), clientKey: newClientKey() });
    setShowModal(true);
  };

  // Open the sale modal from a customer card with that customer preselected.
  // Same modal, same save path as the Sales tab — this only fills in who it is
  // for. The card closes so the two modals never stack.
  const handleAddSaleForCustomer = (customer) => {
    handleAddSale();
    setFormData(prev => ({ ...prev, customerId: customer.id }));
    setSaleCustomerSearch(customer.name);
    setCustomerDetail(null);
  };

  // Same idea for payments. The modal's sale picker filters by customer name,
  // so seeding the search box scopes the list to this customer's unpaid
  // invoices; when there is exactly one, it is preselected with its full
  // balance, which is the common case from a card.
  const handleAddPaymentForCustomer = (customer) => {
    const pending = visibleSales.filter(s => s.customerId === customer.id && s.paid < s.total);
    if (pending.length === 0) {
      alert(`${customer.name} has no unpaid invoices.`);
      return;
    }
    setModalType('payment');
    setPaymentSaleSearch(customer.name);
    setFormData({
      saleId: pending.length === 1 ? String(pending[0].id) : '',
      amount: pending.length === 1 ? pending[0].total - pending[0].paid : 0,
      method: 'cash',
      reference: '',
      date: localDateString(),
      clientKey: newClientKey(),
    });
    setCustomerDetail(null);
    setShowModal(true);
  };

  const handleSavePayment = async () => {
    if (!formData.saleId || formData.amount <= 0) {
      alert('Please select sale and enter amount');
      return;
    }

    const sale = state.sales.find(s => s.id === parseInt(formData.saleId));
    const remainingBalance = sale.total - sale.paid;

    if (formData.amount > remainingBalance) {
      alert(`Amount exceeds remaining balance of KES ${remainingBalance}`);
      return;
    }

    // id is assigned by the database (identity column) — see handleSaveSale.
    const newPayment = {
      saleId: parseInt(formData.saleId),
      customerId: sale.customerId,
      date: formData.date,
      amount: formData.amount,
      method: formData.method,
      reference: formData.reference,
      created_by: session?.user?.id || null,
      // See handleSaveSale — makes a retry after a lost connection safe.
      client_key: formData.clientKey || null
    };

    // One transaction: the payment row, the invoice's paid/status and the
    // customer's balance move together. The over-payment check above is repeated
    // server-side against the CURRENT committed invoice, so two cashiers taking
    // money for the same invoice at once can no longer overpay it or overwrite
    // each other's payment. See migration 011.
    const { data, error } = await withTimeout(supabase.rpc('record_payment', { p_payment: newPayment }));
    if (error || !data?.payment) {
      console.error('❌ Error recording payment:', error);
      alert(saveFailureMessage(
        error,
        'Could not save this payment — nothing was recorded, and the invoice and balance are unchanged. Please try again.',
        "the customer's payment history",
        true
      ));
      return; // leave the modal open with the entry intact
    }

    setState({
      ...state,
      payments: upsertById(state.payments, data.payment),
      ...(data.sale && { sales: state.sales.map(s => (s.id === data.sale.id ? data.sale : s)) }),
      ...applyRpcRows(data),
    });

    if (data.replayed) {
      alert(`This payment of KES ${Number(data.payment.amount).toLocaleString()} was already recorded. It has not been saved twice.`);
    }

    setShowModal(false);
  };

  // Delete Payment — reverses a mistakenly-entered payment.
  // Mirrors handleSavePayment in reverse: rolls back the sale's paid/status
  // and the customer's balance, then removes the payment record.
  const handleDeletePayment = async (id) => {
    const payment = state.payments.find(p => p.id === id);
    if (!payment) return;

    const customer = state.customers.find(c => c.id === payment.customerId);
    const sale = state.sales.find(s => s.id === payment.saleId);

    let confirmMsg = `Delete this payment of KES ${payment.amount.toLocaleString()}`;
    if (customer) confirmMsg += ` from ${customer.name}`;
    confirmMsg += '? This will increase the outstanding balance';
    if (sale) confirmMsg += ` on invoice ${sale.invoiceNumber}`;
    confirmMsg += ' and reduce cash collected. This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    // One transaction: the payment row, the invoice's paid/status and the
    // customer's balance are reversed together, so the payment can no longer
    // vanish while the invoice still shows it as paid.
    const { data, error } = await supabase.rpc('delete_payment', { p_payment_id: id });
    if (error) {
      console.error('❌ Error deleting payment:', error);
      alert('Could not delete this payment — nothing was changed. The payment, the invoice and the balance are all as they were.\n\n' + (error.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      payments: state.payments.filter(p => p.id !== id),
      ...(data?.sale && { sales: state.sales.map(s => (s.id === data.sale.id ? data.sale : s)) }),
      ...applyRpcRows(data),
    });
    console.log('✅ Payment deleted and reversed in Supabase');
  };

  // Production
  const handleAddProduction = () => {
    setModalType('production');
    setFormData({ items: {}, date: localDateString(), notes: '', unit: 'cartons', casuals: [], clientKey: newClientKey() });
    setShowModal(true);
  };

  const handleSaveProduction = async () => {
    if (Object.keys(formData.items).length === 0) {
      alert('Please add items');
      return;
    }

    // Input is in CARTONS for all sizes.
    //
    // The BOM — which raw materials a run consumes and how many cartons it
    // yields — lives in the database as of migration 015, so it is no longer
    // computed here. record_production writes the log AND moves the stock in a
    // single transaction: both land or neither does. The old two-step version
    // could record a run and then fail to post the finished goods, leaving a
    // stock discrepancy no report could see.
    //
    // id, created_by and the stock movement are all assigned server-side —
    // created_by from the session rather than the payload, which is what
    // production_logs' RLS policy checks for sales users.
    const { data, error } = await withTimeout(supabase.rpc('record_production', {
      p_log: {
        date: formData.date,
        items: formData.items, // cartons produced
        unit: 'cartons', // always cartons
        notes: formData.notes,
        casuals: formData.casuals || [],
        // See handleSaveSale — makes a retry after a lost connection safe.
        client_key: formData.clientKey || null,
      },
    }));

    if (error || !data?.production) {
      console.error('❌ Error saving production log:', error);
      alert(saveFailureMessage(
        error,
        'Could not save this production run — nothing was recorded and stock was not changed. Please try again.',
        "today's production logs",
        true
      ));
      return; // leave the modal open with the entry intact
    }

    setState({
      ...state,
      productionLogs: upsertById(state.productionLogs, data.production),
      ...(data.inventory && {
        rawMaterials: data.inventory.rawMaterials,
        finishedGoods: data.inventory.finishedGoods,
      }),
    });

    if (data.replayed) {
      alert('This production run was already recorded. It has not been saved twice, and stock was not deducted again.');
    }

    setShowModal(false);
  };

  // Customer Management
  const handleAddCustomer = () => {
    setEditingCustomer(null);
    setModalType('customer');
    setFormData({ name: '', location: '', phone: '' });
    setShowModal(true);
  };

  const handleSaveCustomer = async () => {
    if (!formData.name || !formData.location || !formData.phone) {
      alert('Please fill in all fields');
      return;
    }

    // Send ONLY the fields this form edits. openEdit seeds formData with the
    // whole customer row, so spreading it sent `balance` back too — a value read
    // once at login, which quietly overwrote any debt movement another user had
    // recorded since. It is also the only column-level write the database still
    // allows: `balance` is derived from the sales ledger by
    // recompute_customer_balance and is not grantable to the client.
    const editableFields = {
      name: formData.name,
      location: formData.location,
      phone: formData.phone,
      is_consignee: !!formData.is_consignee,
    };

    if (editingCustomer) {
      // Persist FIRST — only reflect the edit locally once the database
      // accepts it (supabase returns errors rather than throwing).
      const { error: updError } = await withTimeout(supabase
        .from('customers')
        .update(editableFields)
        .eq('id', editingCustomer.id));
      if (updError) {
        console.error('❌ Error updating customer:', updError);
        alert(saveFailureMessage(
          updError,
          'Could not update this customer — nothing was changed. Please try again.',
          'the customer record'
        ));
        return;
      }

      const updatedCustomers = state.customers.map(c =>
        c.id === editingCustomer.id ? { ...c, ...editableFields } : c
      );
      setState({ ...state, customers: updatedCustomers });
      console.log('✅ Customer updated in Supabase');
    } else {
      const newCustomer = {
        ...editableFields,
        balance: 0,
        isActive: true
      };

      // The DB assigns the id — a sales user only sees an RLS-filtered subset of
      // customers and would otherwise generate a colliding id.
      const { data: savedCustomer, error: custError } = await withTimeout(supabase
        .from('customers')
        .insert([newCustomer])
        .select()
        .single());
      if (custError || !savedCustomer) {
        console.error('❌ Error saving customer:', custError);
        alert(saveFailureMessage(
          custError,
          'Could not save this customer — it has NOT been recorded. Please try again.',
          'the Customers list'
        ));
        return;
      }

      setState({ ...state, customers: [...state.customers, savedCustomer] });
    }
    setShowModal(false);
  };

  // Delete a customer — admin only (matches RLS), and only when the account
  // has no financial history: a non-zero balance or any sales/payments on
  // record must stay visible in Debtors and the reports, so those accounts
  // are deactivated instead of deleted. Previously this only filtered local
  // state (no Supabase call at all) and the customer reappeared on reload.
  const handleDeleteCustomer = async (id) => {
    const customer = state.customers.find(c => c.id === id);
    if (!customer) return;

    const hasHistory =
      state.sales.some(s => s.customerId === id) ||
      state.payments.some(p => p.customerId === id);
    if (customer.balance !== 0 || hasHistory) {
      alert(`${customer.name} has a balance or sales/payment history and cannot be deleted — that would break the Debtors report and the audit trail. Edit the customer and mark them inactive instead.`);
      return;
    }

    if (!confirm(`Delete ${customer.name}? This cannot be undone.`)) return;

    const { error } = await supabase.from('customers').delete().eq('id', id);
    if (error) {
      console.error('❌ Error deleting customer:', error);
      alert('Could not delete this customer — nothing was changed. Please try again.\n\n' + (error.message || 'Unknown error'));
      return;
    }

    setState({
      ...state,
      customers: state.customers.filter(c => c.id !== id)
    });
  };

  // ===== LOADING SCREEN =====
  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-sky-600 text-lg">Loading...</p>
        </div>
      </div>
    );
  }

  // ===== LOGIN SCREEN =====
  if (!session) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
              <span className="text-white text-2xl font-bold">OS</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-slate-900">Northern Water Co.</h1>
            <p className="text-sky-600 text-sm mt-1">OASIS Springs Management System</p>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl p-6 md:p-8 shadow-xl backdrop-blur">
            <h2 className="text-slate-900 font-semibold text-lg mb-6 text-center">Sign In</h2>

            {loginError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-600 rounded-lg px-4 py-3 text-sm mb-4">
                {loginError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-slate-500 text-sm font-medium mb-2">Email</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="you@example.com"
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-slate-500 text-sm font-medium mb-2">Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="••••••••"
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <button
                onClick={handleLogin}
                disabled={loggingIn || !loginEmail || !loginPassword}
                className="w-full bg-sky-500 hover:bg-sky-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition"
              >
                {loggingIn ? 'Signing in...' : 'Sign In'}
              </button>
            </div>

            <p className="text-slate-500 text-xs text-center mt-6">
              Contact your administrator if you need an account.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <style>{`
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
      {/* Header */}
      <header className="border-b border-slate-200 bg-white/90 backdrop-blur sticky top-0 z-40 shadow-sm">
        <div className="w-full px-4 md:px-6 py-3 md:py-4">
          <div className="flex items-center justify-between gap-3">
            {/* Logo and Company Name */}
            <div className="flex items-center gap-2 md:gap-3 min-w-0">
              {/* OASIS Springs Logo SVG */}
              <svg 
                viewBox="0 0 120 120" 
                className="w-10 h-10 md:w-12 md:h-12 flex-shrink-0"
                xmlns="http://www.w3.org/2000/svg"
              >
                {/* Circle background */}
                <circle cx="60" cy="60" r="58" fill="#B3E5FC" stroke="#1E40AF" strokeWidth="3"/>
                
                {/* Water wave at bottom */}
                <path d="M 10 75 Q 20 70, 30 75 T 50 75 T 70 75 T 90 75 T 110 75 L 110 110 Q 60 115, 10 110 Z" 
                      fill="#0EA5E9" opacity="0.6"/>
                
                {/* Water drops */}
                <circle cx="25" cy="40" r="4" fill="#F3F4F6" opacity="0.8"/>
                <circle cx="95" cy="35" r="3" fill="#F3F4F6" opacity="0.6"/>
                <circle cx="50" cy="85" r="3" fill="#F3F4F6" opacity="0.7"/>
                
                {/* OASIS text (simplified) */}
                <text x="60" y="55" fontSize="28" fontWeight="bold" fill="#0369A1" 
                      textAnchor="middle" fontFamily="Arial, sans-serif">OASIS</text>
                
                {/* Springs text (simplified) */}
                <text x="60" y="68" fontSize="12" fontWeight="bold" fill="#1E3A8A" 
                      textAnchor="middle" fontFamily="Arial, sans-serif" letterSpacing="2">Springs</text>
              </svg>
              
              <div className="min-w-0">
                <h1 className="text-lg md:text-2xl font-bold text-slate-900 truncate">Northern Water Co.</h1>
                <p className="text-sky-600 text-xs md:text-sm truncate font-semibold">🌊 OASIS Springs - Purified Water</p>
              </div>
            </div>
            
            {/* Assets Display + User Menu */}
            <div className="flex items-center gap-3 md:gap-5">
              {role !== 'sales' && (
                <div className="text-right">
                  <p className="text-sky-600 text-xs font-semibold">Total Assets</p>
                  <p className="text-lg md:text-2xl font-bold text-sky-600">KES {calculateTotalAssets().toLocaleString()}</p>
                </div>
              )}
              <div className="flex items-center gap-2 md:gap-3 border-l border-slate-200 pl-3 md:pl-5">
                <div className="text-right hidden sm:block">
                  <p className="text-slate-900 text-xs md:text-sm font-semibold truncate max-w-[140px]">{userProfile?.email}</p>
                  <p className="text-sky-600 text-xs capitalize">{role}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="bg-slate-100 hover:bg-rose-50 border border-slate-200 hover:border-rose-200 text-slate-500 hover:text-rose-600 rounded-lg px-3 py-1.5 text-xs md:text-sm transition whitespace-nowrap"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation — consolidated pillars */}
      {(() => {
        // Pillar definitions. Each pillar shows if the user can access at least
        // one of its tabs. Sub-tabs are individually role-gated.
        const PILLARS = [
          { id: 'home', label: 'Home', icon: BarChart3, tabs: [
            { id: 'dashboard', roles: ['admin', 'manager'] },
            { id: 'salesdashboard', roles: ['sales'] },
          ] },
          { id: 'sales', label: 'Sales', icon: DollarSign, tabs: [
            { id: 'sales', label: 'Invoices', roles: ['admin', 'manager', 'sales'] },
            { id: 'payments', label: 'Payments', roles: ['admin', 'manager', 'sales'] },
          ]},
          { id: 'inventory', label: 'Inventory', icon: Package, tabs: [
            { id: 'inventory', label: 'Raw Stock', roles: ['admin', 'manager', 'sales'] },
            { id: 'production', label: 'Production', roles: ['admin', 'manager', 'sales'] },
            { id: 'purchases', label: 'Purchases', roles: ['admin', 'manager'] },
            { id: 'consignment', label: 'Consignment', roles: ['admin', 'manager'] },
            { id: 'costsettings', label: 'Cost Settings', roles: ['admin'] },
            { id: 'adjust', label: 'Stock Adjustments', roles: ['admin'] },
          ]},
          { id: 'expenses', label: 'Expenses', icon: DollarSign, tabs: [{ id: 'expenses', roles: ['admin', 'manager'] }] },
          { id: 'customers', label: 'Customers', icon: Users, tabs: [{ id: 'customers', roles: ['admin', 'manager', 'sales'] }] },
          { id: 'hr', label: 'HR', icon: Users, tabs: [{ id: 'hr', roles: ['admin'] }] },
          { id: 'reports', label: 'Reports', icon: TrendingUp, tabs: [{ id: 'reports', roles: ['admin', 'manager'] }] },
        ];

        // Filter to pillars/tabs this role can see
        const visiblePillars = PILLARS
          .map(p => ({ ...p, tabs: p.tabs.filter(t => t.roles.includes(role)) }))
          .filter(p => p.tabs.length > 0);

        // Which pillar contains the current activeTab?
        const currentPillar = visiblePillars.find(p => p.tabs.some(t => t.id === activeTab)) || visiblePillars[0];
        const subTabs = currentPillar && currentPillar.tabs.length > 1 ? currentPillar.tabs : [];

        return (
          <div className="bg-white border-b border-slate-100 sticky top-16 z-30">
            {/* Top pillar row */}
            <div className="overflow-x-auto">
              <div className="flex justify-between sm:justify-start sm:gap-8 px-2 sm:px-6 sm:min-w-0">
                {visiblePillars.map(p => {
                  const Icon = p.icon;
                  const isActive = currentPillar && currentPillar.id === p.id;
                  return (
                    <button
                      key={p.id}
                      onClick={() => setActiveTab(p.tabs[0].id)}
                      className={`flex flex-col sm:flex-row items-center gap-0.5 sm:gap-2 px-1 sm:px-4 py-2 sm:py-4 border-b-2 transition-all whitespace-nowrap flex-1 sm:flex-none ${
                        isActive ? 'border-sky-500 text-sky-600' : 'border-transparent text-slate-500 hover:text-slate-900'
                      }`}
                    >
                      <Icon className="w-5 h-5 sm:w-4 sm:h-4" />
                      <span className="text-[10px] sm:text-base leading-tight">{p.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Sub-tab row (only when the active pillar has more than one tab) */}
            {subTabs.length > 0 && (
              <div className="overflow-x-auto bg-slate-50 border-t border-slate-100">
                <div className="flex gap-1 px-4 md:px-6 py-2 min-w-max md:min-w-0">
                  {subTabs.map(t => (
                    <button
                      key={t.id}
                      onClick={() => setActiveTab(t.id)}
                      className={`px-3 py-1.5 rounded-md text-xs md:text-sm font-medium whitespace-nowrap transition ${
                        activeTab === t.id ? 'bg-sky-500 text-white' : 'text-slate-500 hover:text-slate-800 hover:bg-slate-100'
                      }`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* Main Content */}
      <main className="w-full px-4 md:px-6 py-4 md:py-8">
        
        {/* Dashboard */}
        {/* Sales person's Home dashboard (location-scoped) */}
        {activeTab === 'salesdashboard' && role === 'sales' && (() => {
          const REFILL_KEYS = ['refill_10L', 'refill_15L', 'refill_20L'];
          const monthPrefix = localMonthPrefix();
          const monthSales = visibleSales.filter(s => (s.date || '').slice(0, 7) === monthPrefix);

          const cartonsBySize = {};
          const refillsBySize = {};
          monthSales.forEach(sale => {
            sale.items.forEach(item => {
              if (REFILL_KEYS.includes(item.size)) {
                refillsBySize[item.size] = (refillsBySize[item.size] || 0) + item.quantity;
              } else {
                cartonsBySize[item.size] = (cartonsBySize[item.size] || 0) + item.quantity;
              }
            });
          });

          const totalCustomers = visibleCustomers.length;
          const totalDebt = visibleCustomers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0);

          return (
            <div className="space-y-4 md:space-y-6">
              <div className="grid grid-cols-2 gap-3 md:gap-4">
                <StatCard
                  label="Customers"
                  value={totalCustomers.toLocaleString()}
                  icon={Users}
                  accent="sky"
                  sub="in your area →"
                  onClick={() => setActiveTab('customers')}
                />
                <StatCard
                  label="Outstanding Debts"
                  value={`KES ${totalDebt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                  icon={Wallet}
                  accent="rose"
                  sub="across debtors →"
                  onClick={() => { setActiveTab('payments'); setPaymentsTab('debts'); }}
                />
              </div>

              {/* Monthly cartons by size */}
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
                <h3 className="text-slate-700 font-semibold mb-1 text-sm">This Month's Sales — Cartons by Size</h3>
                <p className="text-slate-400 text-xs mb-3">{monthPrefix}</p>
                {Object.keys(cartonsBySize).length === 0 ? (
                  <p className="text-slate-400 text-sm py-2">No carton sales this month</p>
                ) : (
                  <>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                      {Object.entries(cartonsBySize).map(([size, qty]) => (
                        <div key={size} className="bg-slate-50 p-3 rounded-lg text-center">
                          <p className="text-slate-500 text-xs font-semibold">{SIZE_LABELS[size] || size}</p>
                          <p className="text-slate-900 font-bold">{qty} cartons</p>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between items-center mt-3 pt-3 border-t border-slate-100">
                      <span className="text-slate-700 font-semibold text-sm">Total Cartons</span>
                      <span className="text-slate-900 font-bold">{Object.values(cartonsBySize).reduce((s, q) => s + q, 0)} cartons</span>
                    </div>
                  </>
                )}

                {Object.keys(refillsBySize).length > 0 && (
                  <>
                    <h4 className="text-slate-700 font-semibold mt-4 mb-2 text-sm">💧 Refills (bottles)</h4>
                    <div className="grid grid-cols-3 gap-2">
                      {['refill_10L', 'refill_15L', 'refill_20L'].filter(k => refillsBySize[k]).map(k => (
                        <div key={k} className="bg-slate-50 p-3 rounded-lg text-center">
                          <p className="text-slate-500 text-xs font-semibold">{SIZE_LABELS[k] || k}</p>
                          <p className="text-slate-900 font-bold">{refillsBySize[k]} bottles</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {/* Recent sales */}
              <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
                <h3 className="text-slate-700 font-semibold mb-3 text-sm">Recent Sales</h3>
                {visibleSales.length === 0 ? (
                  <p className="text-slate-400 text-sm py-2">No sales yet</p>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {visibleSales.slice().reverse().slice(0, 8).map(sale => {
                      const customer = state.customers.find(c => c.id === sale.customerId);
                      return (
                        <div key={sale.id} className="flex items-center justify-between py-3">
                          <div className="min-w-0">
                            <p className="text-slate-900 text-sm font-medium truncate">{customer?.name || 'Unknown'}</p>
                            <p className="text-slate-400 text-xs">{sale.date}</p>
                          </div>
                          <p className="text-emerald-600 text-sm font-semibold">KES {sale.total.toLocaleString()}</p>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          );
        })()}

        {activeTab === 'dashboard' && (() => {
          // Sales and costs cards show month-to-date, not all-time (customers
          // and debts are point-in-time balances, so they stay as-is).
          const monthPrefix = localMonthPrefix();
          const inMonth = (d) => (d || '').slice(0, 7) === monthPrefix;
          const monthSalesTotal = state.sales.filter(s => inMonth(s.date)).reduce((sum, s) => sum + s.total, 0);
          const monthCostsTotal = state.expenses.filter(e => inMonth(e.date)).reduce((sum, e) => sum + e.amount, 0)
            + state.purchases.filter(p => inMonth(p.date)).reduce((sum, p) => sum + p.totalAmount, 0);
          return (
          <div className="space-y-4 md:space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              {[
                { id: 'customers', label: 'Customers', value: state.customers.length.toLocaleString(), accent: 'sky', icon: Users, sub: 'total accounts' },
                { id: 'debt', label: 'Outstanding Debts', value: `KES ${state.customers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'rose', icon: Wallet, sub: 'across debtors' },
                { id: 'sales', label: 'Sales', value: `KES ${monthSalesTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'emerald', icon: DollarSign, sub: 'this month' },
                { id: 'costs', label: 'Operating Costs', value: `KES ${monthCostsTotal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'amber', icon: ShoppingCart, sub: 'expenses + purchases · this month' },
              ].map((card, i) => (
                <StatCard
                  key={i}
                  label={card.label}
                  value={card.value}
                  icon={card.icon}
                  accent={card.accent}
                  sub={card.sub}
                  onClick={() => setBreakdownCard(card.id)}
                />
              ))}
            </div>

            {/* Quick Actions */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
              <h3 className="text-slate-700 font-semibold mb-3 md:mb-4 text-sm">Quick Actions</h3>
              <div className="grid grid-cols-5 gap-2">
                <button onClick={handleAddSale} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition">
                  <Plus className="w-4 h-4 text-sky-600" /> <span className="text-[11px] text-slate-600">Sale</span>
                </button>
                <button onClick={handleAddPayment} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition">
                  <Wallet className="w-4 h-4 text-sky-600" /> <span className="text-[11px] text-slate-600">Pay</span>
                </button>
                <button onClick={handleAddProduction} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition">
                  <ClipboardList className="w-4 h-4 text-sky-600" /> <span className="text-[11px] text-slate-600">Prod</span>
                </button>
                <button onClick={handleAddPurchase} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition">
                  <ShoppingCart className="w-4 h-4 text-sky-600" /> <span className="text-[11px] text-slate-600">Buy</span>
                </button>
                <button onClick={() => { setActiveTab('reports'); setReportType('aging'); handleGenerateReport('aging'); }} className="flex flex-col items-center gap-1.5 py-3 rounded-lg bg-slate-50 hover:bg-slate-100 border border-slate-200 transition">
                  <BarChart3 className="w-4 h-4 text-sky-600" /> <span className="text-[11px] text-slate-600">Report</span>
                </button>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Recent Sales</h3>
                <div className="space-y-2 md:space-y-3">
                  {state.sales.slice(-5).reverse().map(sale => {
                    const customer = state.customers.find(c => c.id === sale.customerId);
                    return (
                      <div key={sale.id} className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-base">
                        <div>
                          <p className="text-slate-900 font-medium truncate">{customer?.name}</p>
                          <p className="text-slate-500 text-xs">{sale.date}</p>
                        </div>
                        <p className="text-emerald-600 font-semibold">KES {sale.total.toLocaleString()}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Recent Purchases</h3>
                <div className="space-y-2 md:space-y-3">
                  {state.purchases.slice(-5).reverse().map(purchase => (
                    <div key={purchase.id} className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-base">
                      <div>
                        <p className="text-slate-900 font-medium truncate">{purchase.supplier}</p>
                        <p className="text-slate-500 text-xs">{purchase.date}</p>
                      </div>
                      <p className="text-sky-600 font-semibold">KES {purchase.totalAmount.toLocaleString()}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
          );
        })()}

        {/* Purchases Tab */}
        {activeTab === 'purchases' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Raw Materials Purchases</h2>
              <button
                onClick={handleAddPurchase}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Purchase
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              <StatCard
                label="Purchased This Month"
                value={`KES ${getMonthPurchasesList().reduce((sum, p) => sum + p.totalAmount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={ShoppingCart}
                accent="sky"
                sub="this month"
              />
              <StatCard
                label="Purchase Count"
                value={getMonthPurchasesList().length.toLocaleString()}
                icon={ClipboardList}
                accent="slate"
                sub="this month"
              />
              <StatCard
                label="Current Stock Value"
                value={`KES ${calculateInventoryValue().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={Package}
                accent="emerald"
              />
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Purchase History</h3>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {state.purchases.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No purchases recorded</p>
                ) : (
                  state.purchases.slice().reverse().map(purchase => (
                    <div key={purchase.id} className="p-3 md:p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-slate-900 font-semibold text-sm truncate">{purchase.supplier}</p>
                          <p className="text-slate-500 text-xs">{purchase.date}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <p className="text-sky-600 font-semibold">KES {purchase.totalAmount.toLocaleString()}</p>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                setEditingPurchase(purchase);
                                setModalType('purchase');
                                setFormData(purchase);
                                setShowModal(true);
                              }}
                              className="p-1 hover:bg-slate-100 rounded transition"
                            >
                              <Edit2 className="w-3 h-3 text-slate-500" />
                            </button>
                            {/* RLS only permits admin to delete purchases. */}
                            {role === 'admin' && (
                              <button
                                onClick={() => handleDeletePurchase(purchase.id)}
                                className="p-1 hover:bg-rose-50 rounded transition"
                              >
                                <Trash2 className="w-3 h-3 text-rose-600" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-xs">
                        {purchase.items.map((item, i) => (
                          <div key={i} className="p-2 bg-slate-100 rounded">
                            <p className="text-slate-500 text-xs">{item.description}</p>
                            <p className="text-slate-900 font-semibold">{item.quantity} units</p>
                            <p className="text-sky-600">KES {item.total.toLocaleString()}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Inventory Tab */}
        {activeTab === 'inventory' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Raw Materials Inventory</h2>
              <p className="text-slate-500 text-sm mt-1">Live stock counts for bottles, seals, labels, caps, overwraps, and consumables.</p>
            </div>

            {/* Empty Bottles */}
            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Empty Bottles</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
                {Object.entries(state.rawMaterials.emptyBottles).map(([size, quantity]) => (
                  <div key={size} className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                    <p className="text-slate-500 text-xs md:text-sm mb-2">{size}</p>
                    <p className="text-slate-900 text-lg md:text-2xl font-bold">{quantity}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Other Materials */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-6">
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm">Seals</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.seals).map(([type, qty]) => {
                    let label = type;
                    if (type === 'short_neck') label = 'Short Neck (0.5L & 1.5L)';
                    else if (type === '5L') label = '5L';
                    else if (type === '18.9L') label = '18.9L';
                    return (
                      <div key={type} className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                        <p className="text-slate-500">{label}</p>
                        <p className="text-slate-900 font-semibold">{qty}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm">Labels</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.labels).map(([size, qty]) => (
                    <div key={size} className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                      <p className="text-slate-500">{size}</p>
                      <p className="text-slate-900 font-semibold">{qty}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm">Caps</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.caps || {}).map(([size, qty]) => (
                    <div key={size} className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                      <p className="text-slate-500">{size}</p>
                      <p className="text-slate-900 font-semibold">{qty}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm">Overwraps by Size</h3>
                <div className="space-y-2 md:space-y-3">
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                    <p className="text-slate-500">0.5L Cartons</p>
                    <p className="text-slate-900 font-semibold">{state.rawMaterials.overwraps['0.5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                    <p className="text-slate-500">1.5L Cartons</p>
                    <p className="text-slate-900 font-semibold">{state.rawMaterials.overwraps['1.5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                    <p className="text-slate-500">5L Cartons</p>
                    <p className="text-slate-900 font-semibold">{state.rawMaterials.overwraps['5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm border border-emerald-200 mt-2">
                    <p className="text-emerald-600 font-semibold">Total Overwraps</p>
                    <p className="text-emerald-600 font-bold">{Object.values(state.rawMaterials.overwraps).reduce((a, b) => a + b, 0)}</p>
                  </div>
                </div>
              </div>

              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm">Other Materials</h3>
                <div className="space-y-2 md:space-y-3">
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                    <p className="text-slate-500">KRA Stamps</p>
                    <p className="text-slate-900 font-semibold">{state.rawMaterials.kraStamps}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-50 rounded-lg text-xs md:text-sm">
                    <p className="text-slate-500">RO Chemical</p>
                    <p className="text-slate-900 font-semibold">{state.rawMaterials.roChemical.toFixed(1)}L</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Consignment Tab */}
        {activeTab === 'consignment' && (role === 'admin' || role === 'manager') && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Consignment Shops</h2>
              <p className="text-slate-500 text-sm mt-1">
                Shops that hold our stock and pay after selling. Delivering stock is a transfer — no sale or debt is
                recorded until you use <span className="font-medium">Report Sold</span>.
              </p>
            </div>

            {consignees().length === 0 ? (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-6 text-center">
                <p className="text-slate-500 text-sm">
                  No consignment shops yet. Go to <span className="font-medium">Customers</span>, add or edit a shop, and
                  tick <span className="font-medium">“Consignment shop”</span>.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-6">
                {consignees().map(shop => {
                  const onHand = getConsignmentOnHand(shop.id);
                  const sizes = Object.keys(state.finishedGoods).filter(s => (onHand[s] || 0) !== 0);
                  const totalCartons = Object.values(onHand).reduce((a, b) => a + b, 0);
                  const debt = shop.balance < 0 ? Math.abs(shop.balance) : 0;
                  return (
                    <div key={shop.id} className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                      <div className="flex justify-between items-start gap-2">
                        <div>
                          <h3 className="text-slate-900 font-semibold text-sm md:text-base">{shop.name}</h3>
                          <p className="text-slate-500 text-xs">{shop.location}</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-slate-500">Owes</p>
                          <p className={`font-bold text-sm md:text-base ${debt > 0 ? 'text-rose-600' : 'text-slate-400'}`}>
                            KES {debt.toLocaleString()}
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 md:mt-4">
                        <p className="text-slate-500 text-xs mb-2">Stock on hand ({totalCartons} cartons)</p>
                        {sizes.length === 0 ? (
                          <p className="text-slate-400 text-xs italic">None on consignment right now.</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-2">
                            {sizes.map(s => (
                              <div key={s} className="flex justify-between items-center p-2 bg-slate-50 rounded-lg text-xs">
                                <span className="text-slate-500">{SIZE_LABELS[s] || s}</span>
                                <span className="text-slate-900 font-semibold">{onHand[s]}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>

                      <div className="flex flex-wrap gap-2 mt-4">
                        <button
                          onClick={() => openConsignment('deliver', shop.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sky-500 hover:bg-sky-600 text-white transition"
                        >
                          Deliver
                        </button>
                        <button
                          onClick={() => openConsignment('sold', shop.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500 hover:bg-emerald-600 text-white transition"
                        >
                          Report Sold
                        </button>
                        <button
                          onClick={() => openConsignment('return', shop.id)}
                          className="px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-300 text-slate-600 hover:bg-slate-50 transition"
                        >
                          Take Back
                        </button>
                        {role === 'admin' && (
                          <button
                            onClick={() => openConsignment('reconcile', shop.id)}
                            className="px-3 py-1.5 text-xs font-medium rounded-lg border border-amber-300 text-amber-700 hover:bg-amber-50 transition"
                          >
                            Reconcile
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Reports Tab */}
        {activeTab === 'reports' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Reports</h2>
              <p className="text-slate-500 text-sm mt-1">Generate debtor, sales, cash, expense, and P&amp;L summaries, then export to PDF.</p>
            </div>

            {/* Report Selection */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
              {[
                { id: 'aging', label: 'Debtors', icon: '📊' },
                { id: 'sales', label: 'Sales', icon: '📈' },
                { id: 'cash', label: 'Cash Collected', icon: '💵' },
                { id: 'expense', label: 'Expenses', icon: '💰' },
                { id: 'profitloss', label: 'P&L', icon: '📉' },
                { id: 'topcustomers', label: 'Top Customers', icon: '🏆' },
                { id: 'customersummary', label: 'Customer Summary', icon: '👥' },
                { id: 'customerrevenue', label: 'Customer Trend', icon: '📅' },
                { id: 'productmix', label: 'Product Mix', icon: '🧴' },
                { id: 'productionreport', label: 'Production', icon: '🏭' },
              ].map(report => (
                <button
                  key={report.id}
                  onClick={() => handleGenerateReport(report.id)}
                  className={`p-3 md:p-4 rounded-lg md:rounded-xl border-2 transition text-sm md:text-base ${
                    reportType === report.id
                      ? 'border-sky-400 bg-sky-50'
                      : 'border-slate-200 bg-white hover:border-sky-300'
                  }`}
                >
                  <p className="text-xl md:text-2xl mb-1 md:mb-2">{report.icon}</p>
                  <p className={`font-semibold ${reportType === report.id ? 'text-sky-600' : 'text-slate-500'}`}>{report.label}</p>
                </button>
              ))}
            </div>

            {/* Location filter — Debtors report only */}
            {reportType === 'aging' && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-3 md:p-4">
                <label className="text-slate-500 text-xs md:text-sm block mb-1 md:mb-2">Location</label>
                <select
                  value={debtorsLocation}
                  onChange={(e) => {
                    const loc = e.target.value;
                    setDebtorsLocation(loc);
                    setReportData(generateAgingDebtorsReport(loc));
                  }}
                  className="w-full md:w-64 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                >
                  <option value="all">All Locations</option>
                  {state.locations.map(loc => (
                    <option key={loc} value={loc}>{loc}</option>
                  ))}
                </select>
                <p className="text-slate-500 text-xs mt-2">
                  {debtorsLocation === 'all' ? 'Showing debtors across all locations' : `Showing debtors in ${debtorsLocation} only — the PDF will cover this location`}
                </p>
              </div>
            )}

            {/* Customer picker — the per-customer reports only */}
            {(reportType === 'customerrevenue' || reportType === 'productmix') && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-3 md:p-4">
                <label className="text-slate-500 text-xs md:text-sm block mb-1 md:mb-2">Customer</label>
                <select
                  value={reportCustomerId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setReportCustomerId(id);
                    setReportData(reportType === 'customerrevenue' ? generateCustomerRevenueReport(id) : generateProductMixReport(id));
                  }}
                  className="w-full md:w-64 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                >
                  <option value="">Select a customer…</option>
                  {state.customers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(c => (
                    <option key={c.id} value={c.id}>{c.name}{c.location ? ` · ${c.location}` : ''}</option>
                  ))}
                </select>
                <p className="text-slate-500 text-xs mt-2">Pick a customer to see their {reportType === 'customerrevenue' ? 'revenue by month' : 'product mix'}. Set a date range below to narrow the period.</p>
              </div>
            )}

            {/* Date Range — applies to all event-based reports */}
            {(reportType === 'sales' || reportType === 'cash' || reportType === 'expense' || reportType === 'profitloss' || reportType === 'topcustomers' || reportType === 'customersummary' || reportType === 'customerrevenue' || reportType === 'productmix' || reportType === 'productionreport') && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-3 md:p-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
                  <div>
                    <label className="text-slate-500 text-xs md:text-sm block mb-1 md:mb-2">Start Date</label>
                    <input
                      type="date"
                      value={dateRange.start}
                      onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-slate-500 text-xs md:text-sm block mb-1 md:mb-2">End Date</label>
                    <input
                      type="date"
                      value={dateRange.end}
                      onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      onClick={() => handleGenerateReport(reportType)}
                      className="flex-1 bg-sky-500 hover:bg-sky-600 text-white font-medium px-2 md:px-4 py-1 md:py-2 rounded-lg transition text-sm"
                    >
                      Generate
                    </button>
                    <button
                      onClick={() => { setDateRange({ start: '', end: '' }); setTimeout(() => handleGenerateReport(reportType), 0); }}
                      className="bg-slate-100 hover:bg-slate-200 text-slate-700 border border-slate-300 px-2 md:px-3 py-1 md:py-2 rounded-lg transition text-xs"
                      title="Clear dates"
                    >
                      {['customersummary', 'customerrevenue', 'productmix'].includes(reportType) ? 'All Time' : 'This Month'}
                    </button>
                  </div>
                </div>
                <p className="text-slate-500 text-xs mt-2">
                  {dateRange.start && dateRange.end
                    ? `Showing: ${dateRange.start} to ${dateRange.end}`
                    : ['customersummary', 'customerrevenue', 'productmix'].includes(reportType)
                      ? 'Showing: All time — set dates for a specific period'
                      : `Showing: This Month (${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}) — set dates for another period`}
                </p>
              </div>
            )}

            {/* Report Display */}
            {reportData && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4 md:mb-6">
                  <div>
                    <h3 className="text-slate-900 font-semibold text-base md:text-xl">{reportData.title}</h3>
                    <p className="text-slate-500 text-xs md:text-sm">Generated: {reportData.date}{reportData.locationLabel ? ` · ${reportData.locationLabel}` : ''}</p>
                  </div>
                  <button
                    onClick={downloadReportAsPDF}
                    className="flex items-center gap-2 bg-sky-500 hover:bg-sky-600 text-white font-medium px-3 md:px-4 py-2 rounded-lg transition text-sm w-full md:w-auto justify-center"
                  >
                    <Download className="w-4 h-4" /> Save as PDF
                  </button>
                </div>

                {/* Aging Debtors Report */}
                {reportType === 'aging' && (
                  <div className="space-y-4">
                    {reportData.data.length === 0 ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No debtors{debtorsLocation !== 'all' ? ` in ${debtorsLocation}` : ''}</p>
                    ) : (
                      <>
                        {Object.entries(reportData.byLocation)
                          .sort((a, b) => b[1].total - a[1].total)
                          .map(([location, group]) => (
                          <div key={location} className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 md:p-4">
                            <div className="flex justify-between items-center mb-3 pb-2 border-b border-slate-100">
                              <h4 className="text-slate-900 font-semibold text-sm">{location}</h4>
                              <p className="text-rose-600 font-bold text-sm">KES {group.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="space-y-2">
                              {group.debtors.map((debtor, i) => (
                                <div key={i} className="p-2 md:p-3 bg-slate-50 rounded-lg border-l-4 border-rose-400 text-xs md:text-sm">
                                  <div className="flex justify-between items-start gap-2">
                                    <div>
                                      <p className="text-slate-900 font-semibold">{debtor.name}</p>
                                      <p className="text-slate-400 text-xs">Ph: {debtor.phone || '—'} · {debtor.daysOverdue}d overdue</p>
                                    </div>
                                    <p className="text-rose-600 font-semibold">KES {debtor.debt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}

                        {/* Grand total */}
                        <div className="bg-rose-50 border-2 border-rose-200 rounded-xl p-4">
                          <div className="flex justify-between items-center">
                            <p className="text-rose-700 font-semibold text-sm">Total Outstanding Debt</p>
                            <p className="text-rose-700 text-xl md:text-2xl font-bold">KES {reportData.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}

                {/* Sales Report */}
                {reportType === 'sales' && (
                  <div className="space-y-4 md:space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                        <p className="text-emerald-600 text-xs md:text-sm">Total Sales</p>
                        <p className="text-slate-900 text-xl md:text-2xl font-bold">KES {reportData.totalSales.toLocaleString()}</p>
                      </div>
                      <div className="bg-sky-50 border border-slate-200 rounded-lg p-3 md:p-4">
                        <p className="text-slate-500 text-xs md:text-sm">Transactions</p>
                        <p className="text-slate-900 text-xl md:text-2xl font-bold">{reportData.totalTransactions}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6">
                      <div>
                        <h4 className="text-slate-900 font-semibold mb-2 md:mb-3 text-sm">Sales Revenue by Location</h4>
                        <div className="space-y-1 md:space-y-2">
                          {Object.entries(reportData.salesByLocation).map(([location, amount]) => (
                            <div key={location} className="flex justify-between p-2 bg-slate-50 rounded text-xs md:text-sm">
                              <p className="text-slate-500">{location}</p>
                              <p className="text-slate-900 font-semibold">KES {amount.toLocaleString()}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <h4 className="text-slate-900 font-semibold mb-2 md:mb-3 text-sm">Total Cartons by Size</h4>
                        <div className="space-y-1 md:space-y-2">
                          {Object.entries(reportData.salesBySize).map(([size, qty]) => (
                            <div key={size} className="flex justify-between p-2 bg-slate-50 rounded text-xs md:text-sm">
                              <p className="text-slate-500">{SIZE_LABELS[size] || size}</p>
                              <p className="text-slate-900 font-semibold">{qty} cartons</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Cartons by Location and Size */}
                    <div className="bg-slate-50 rounded-lg p-4 border border-slate-200">
                      <h4 className="text-slate-900 font-semibold mb-4 text-base">📊 Carton Sales by Location & Size</h4>
                      <div className="space-y-4">
                        {Object.entries(reportData.bottlesByLocationAndSize).map(([location, cartons]) => (
                          <div key={location} className="bg-white rounded-lg p-3 border border-slate-100">
                            <div className="flex justify-between items-center mb-2">
                              <p className="text-sky-600 font-bold text-sm">{location}</p>
                              <p className="text-slate-900 font-bold text-sm">
                                {Object.values(cartons).reduce((s, q) => s + q, 0)} cartons total
                              </p>
                            </div>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                              {Object.entries(cartons).map(([size, qty]) => (
                                <div key={`${location}-${size}`} className="bg-slate-50 p-2 rounded text-xs text-center">
                                  <p className="text-slate-500 font-semibold">{SIZE_LABELS[size] || size}</p>
                                  <p className="text-slate-900 font-bold">{qty} cartons</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between items-center mt-4 pt-3 border-t border-slate-300">
                        <p className="text-slate-900 font-bold text-sm">Overall Total Cartons Sold</p>
                        <p className="text-emerald-600 font-bold text-lg">
                          {Object.values(reportData.bottlesByLocationAndSize)
                            .reduce((sum, cartons) => sum + Object.values(cartons).reduce((s, q) => s + q, 0), 0)} cartons
                        </p>
                      </div>
                    </div>

                    {/* Water Refills — separate, shown as bottles, not by location */}
                    {reportData.refillsBySize && Object.keys(reportData.refillsBySize).length > 0 && (
                      <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
                        <h4 className="text-slate-900 font-semibold mb-1 text-base">💧 Water Refills</h4>
                        <p className="text-slate-400 text-xs mb-3">Service refills, counted in bottles (units)</p>
                        <div className="grid grid-cols-3 gap-2">
                          {['refill_10L', 'refill_15L', 'refill_20L'].filter(k => reportData.refillsBySize[k]).map(k => (
                            <div key={k} className="bg-slate-50 p-3 rounded text-center">
                              <p className="text-slate-500 text-xs font-semibold">{SIZE_LABELS[k] || k}</p>
                              <p className="text-slate-900 font-bold">{reportData.refillsBySize[k]} bottles</p>
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-between items-center mt-3 pt-3 border-t border-slate-100">
                          <span className="text-slate-500 text-sm">Refill Revenue</span>
                          <span className="text-slate-900 font-bold">KES {reportData.refillRevenue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Cash Collected Report */}
                {reportType === 'cash' && (
                  <div className="space-y-3 md:space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                        <p className="text-emerald-600 text-xs">Cash Sales Collected</p>
                        <p className="text-slate-900 text-lg md:text-xl font-bold">KES {reportData.cashSalesTotal.toLocaleString()}</p>
                      </div>
                      <div className="bg-sky-500/20 border border-sky-200 rounded-lg p-3 md:p-4">
                        <p className="text-sky-600 text-xs">Debt Payments Collected</p>
                        <p className="text-slate-900 text-lg md:text-xl font-bold">KES {reportData.debtPaymentsTotal.toLocaleString()}</p>
                      </div>
                      <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-lg p-3 md:p-4">
                        <p className="text-white/80 text-xs">Total Collected</p>
                        <p className="text-white text-lg md:text-xl font-bold">KES {reportData.totalCollected.toLocaleString()}</p>
                      </div>
                    </div>
                    <p className="text-slate-500 text-xs">Period: {reportData.period}</p>

                    <div className="bg-slate-50 rounded-lg p-3 md:p-4">
                      <h4 className="text-slate-900 font-semibold mb-2 text-sm">Cash Sales (paid at point of sale)</h4>
                      <div className="max-h-96 overflow-y-auto">
                      {reportData.cashSalesList.length === 0 ? (
                        <p className="text-slate-500 text-xs py-2">None in this period</p>
                      ) : groupByDay(reportData.cashSalesList).map((g) => {
                        const key = `cash:${g.date}`;
                        const open = !!expandedDays[key];
                        return (
                          <div key={key} className="border-b border-slate-100 last:border-0">
                            <button
                              onClick={() => toggleDay(key)}
                              className="w-full flex justify-between items-center text-xs py-2 hover:bg-slate-100 -mx-1 px-1 rounded transition"
                            >
                              <span className="flex items-center gap-1 text-slate-700 font-medium">
                                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                {g.date}
                                <span className="text-slate-400 font-normal">· {g.items.length} {g.items.length === 1 ? 'sale' : 'sales'}</span>
                              </span>
                              <span className="text-emerald-600 font-semibold">KES {g.total.toLocaleString()}</span>
                            </button>
                            {open && g.items.map((c, i) => (
                              <div key={i} className="flex justify-between text-xs py-1 pl-5 border-t border-slate-100">
                                <span className="text-slate-500">{c.invoice} · {c.customer}{c.method ? ` · ${c.method}` : ''}</span>
                                <span className="text-emerald-600">KES {c.amount.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      </div>
                    </div>

                    <div className="bg-slate-50 rounded-lg p-3 md:p-4">
                      <h4 className="text-slate-900 font-semibold mb-2 text-sm">Debt Payments Received</h4>
                      <div className="max-h-96 overflow-y-auto">
                      {reportData.debtPaymentsList.length === 0 ? (
                        <p className="text-slate-500 text-xs py-2">None in this period</p>
                      ) : groupByDay(reportData.debtPaymentsList).map((g) => {
                        const key = `debt:${g.date}`;
                        const open = !!expandedDays[key];
                        return (
                          <div key={key} className="border-b border-slate-100 last:border-0">
                            <button
                              onClick={() => toggleDay(key)}
                              className="w-full flex justify-between items-center text-xs py-2 hover:bg-slate-100 -mx-1 px-1 rounded transition"
                            >
                              <span className="flex items-center gap-1 text-slate-700 font-medium">
                                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                {g.date}
                                <span className="text-slate-400 font-normal">· {g.items.length} {g.items.length === 1 ? 'payment' : 'payments'}</span>
                              </span>
                              <span className="text-sky-600 font-semibold">KES {g.total.toLocaleString()}</span>
                            </button>
                            {open && g.items.map((p, i) => (
                              <div key={i} className="flex justify-between text-xs py-1 pl-5 border-t border-slate-100">
                                <span className="text-slate-500">{p.customer}{p.method ? ` · ${p.method}` : ''}</span>
                                <span className="text-sky-600">KES {p.amount.toLocaleString()}</span>
                              </div>
                            ))}
                          </div>
                        );
                      })}
                      </div>
                    </div>
                  </div>
                )}

                {/* Expense Report */}
                {reportType === 'expense' && (
                  <div className="space-y-2 md:space-y-3">
                    <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 md:p-4 mb-2">
                      <p className="text-amber-600 text-xs md:text-sm">Total Spent (all cash out)</p>
                      <p className="text-slate-900 text-2xl md:text-3xl font-bold">KES {reportData.totalExpenses.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                    </div>
                    {/* Treatment split */}
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="bg-white border border-slate-200 rounded-lg p-3">
                        <p className="text-slate-400 text-[11px]">P&L Operating</p>
                        <p className="text-slate-900 font-bold text-sm">KES {reportData.operatingTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                      <div className="bg-white border border-slate-200 rounded-lg p-3">
                        <p className="text-slate-400 text-[11px]">Purchases / COGS</p>
                        <p className="text-slate-900 font-bold text-sm">KES {reportData.cogsTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                      <div className="bg-white border border-slate-200 rounded-lg p-3">
                        <p className="text-slate-400 text-[11px]">Excluded (cash only)</p>
                        <p className="text-slate-900 font-bold text-sm">KES {reportData.excludedTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                    </div>
                    <h4 className="text-slate-900 font-semibold text-sm">By Type:</h4>
                    {Object.entries(reportData.byCategory).map(([type, amount]) => {
                      const entries = reportData.entriesByType[type] || [];
                      return (
                        <div key={type} className="bg-slate-50 rounded-lg p-3 md:p-4">
                          <div className="flex justify-between items-center text-xs md:text-sm">
                            <p className="text-slate-500">{type} <span className="text-slate-400">· {EXPENSE_TREATMENT[type] || 'operating'}</span> <span className="text-slate-400">({entries.length})</span></p>
                            <p className="text-slate-900 font-semibold">KES {amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          </div>
                          <div className="mt-2 pt-2 border-t border-slate-200 space-y-1">
                            {entries.map(e => (
                              <div key={e.id} className="flex justify-between items-start gap-2 text-[11px] md:text-xs">
                                <span className="text-slate-500">
                                  <span className="text-slate-400">{e.date}</span>
                                  {e.description ? ` · ${e.description}` : ''}
                                </span>
                                <span className="text-slate-700 whitespace-nowrap">KES {e.amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* P&L Report */}
                {reportType === 'profitloss' && (
                  <div className="space-y-3 md:space-y-4">
                    <p className="text-slate-500 text-xs">Period: {reportData.period}</p>

                    {/* Revenue → COGS → Gross Profit */}
                    <div className="bg-slate-50 rounded-lg p-3 md:p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Sales Revenue</span>
                        <span className="text-slate-900 font-semibold">KES {reportData.revenue.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500">Less: Cost of Goods Sold</span>
                        <span className="text-rose-600">− KES {reportData.cogs.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm pt-2 border-t border-slate-200">
                        <span className="text-emerald-600 font-semibold">Gross Profit</span>
                        <span className="text-emerald-600 font-bold">KES {reportData.grossProfit.toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-slate-500 text-right">Gross margin: {reportData.grossMargin}%</p>
                    </div>

                    {/* Operating expenses */}
                    <div className="bg-slate-50 rounded-lg p-3 md:p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 font-semibold">Operating Expenses</span>
                        <span className="text-rose-600">− KES {reportData.operatingExpenses.toLocaleString()}</span>
                      </div>
                      {Object.entries(reportData.operatingBreakdown).map(([k, v]) => (
                        <div key={k} className="flex justify-between text-xs pl-3">
                          <span className="text-slate-500">{k}</span>
                          <span className="text-slate-600">KES {v.toLocaleString()}</span>
                        </div>
                      ))}
                      {Object.keys(reportData.operatingBreakdown).length === 0 && (
                        <p className="text-slate-500 text-xs pl-3">No operating expenses in period</p>
                      )}
                    </div>

                    {/* Recorded but not deducted — shown so this report reconciles
                        with the Expense Report instead of silently dropping them. */}
                    {(reportData.cogsExpenses > 0 || reportData.excludedExpenses > 0) && (
                      <div className="bg-slate-50 rounded-lg p-3 md:p-4 space-y-2 border border-dashed border-slate-300">
                        <p className="text-slate-500 text-xs font-semibold uppercase tracking-wide">
                          Recorded, not deducted
                        </p>
                        {reportData.cogsExpenses > 0 && (
                          <>
                            <div className="flex justify-between text-sm">
                              <span className="text-slate-500">Material &amp; excise purchases</span>
                              <span className="text-slate-600">KES {reportData.cogsExpenses.toLocaleString()}</span>
                            </div>
                            {Object.entries(reportData.cogsBreakdown).map(([k, v]) => (
                              <div key={k} className="flex justify-between text-xs pl-3">
                                <span className="text-slate-400">{k}</span>
                                <span className="text-slate-500">KES {v.toLocaleString()}</span>
                              </div>
                            ))}
                          </>
                        )}
                        {reportData.excludedExpenses > 0 && (
                          <>
                            <div className="flex justify-between text-sm pt-1">
                              <span className="text-slate-500">Excluded from P&amp;L (cash only)</span>
                              <span className="text-slate-600">KES {reportData.excludedExpenses.toLocaleString()}</span>
                            </div>
                            {Object.entries(reportData.excludedBreakdown).map(([k, v]) => (
                              <div key={k} className="flex justify-between text-xs pl-3">
                                <span className="text-slate-400">{k}</span>
                                <span className="text-slate-500">KES {v.toLocaleString()}</span>
                              </div>
                            ))}
                          </>
                        )}
                        <p className="text-slate-500 text-xs pt-1">
                          Already carried by the cost per carton in COGS above, or outside the P&amp;L by design.
                          Listed here so this report ties back to the Expense Report.
                        </p>
                      </div>
                    )}

                    {/* Net Profit */}
                    <div className={`border-2 rounded-lg p-3 md:p-4 ${reportData.netProfit >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                      <p className={reportData.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}>Net Profit</p>
                      <p className={`text-2xl md:text-3xl font-bold ${reportData.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        KES {reportData.netProfit.toLocaleString()}
                      </p>
                      <p className="text-xs mt-2">Net margin: {reportData.netMargin}%</p>
                    </div>

                    <p className="text-slate-500 text-xs">Note: COGS is based on cartons sold × cost per carton (raw materials only). Casual labour is an operating expense, not part of COGS. Raw material purchases are not counted again as operating expenses.</p>
                  </div>
                )}

                {/* Top Customers Report */}
                {reportType === 'topcustomers' && (
                  <div className="space-y-3 md:space-y-4">
                    <p className="text-slate-500 text-xs">Period: {reportData.period} · Ranked by invoiced revenue</p>
                    <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4 flex justify-between items-center">
                      <span className="text-emerald-600 text-sm font-semibold">Total Invoiced</span>
                      <span className="text-slate-900 font-bold">KES {reportData.totalInvoiced.toLocaleString()}</span>
                    </div>
                    {reportData.rows.length === 0 ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No sales in this period</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-slate-500 border-b border-slate-200">
                              <th className="py-2 pr-2">#</th>
                              <th className="py-2 pr-2">Customer</th>
                              <th className="py-2 pr-2 text-right">Invoiced</th>
                              <th className="py-2 pr-2 text-right">Paid</th>
                              <th className="py-2 pr-2 text-right">Outstanding</th>
                              <th className="py-2 pr-2 text-right">Inv.</th>
                              <th className="py-2 text-right">Share</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportData.rows.map((r, i) => (
                              <tr key={i} className="border-b border-slate-100">
                                <td className="py-2 pr-2 text-slate-400">{i + 1}</td>
                                <td className="py-2 pr-2">
                                  <p className="text-slate-900">{r.name}</p>
                                  <p className="text-slate-400 text-xs">{r.location}</p>
                                </td>
                                <td className="py-2 pr-2 text-right text-slate-900 font-semibold">KES {r.invoiced.toLocaleString()}</td>
                                <td className="py-2 pr-2 text-right text-emerald-600">KES {r.paid.toLocaleString()}</td>
                                <td className="py-2 pr-2 text-right text-rose-600">KES {r.outstanding.toLocaleString()}</td>
                                <td className="py-2 pr-2 text-right text-slate-600">{r.invoices}</td>
                                <td className="py-2 text-right text-slate-600">{r.pct.toFixed(1)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Customer Sales Summary Report */}
                {reportType === 'customersummary' && (
                  <div className="space-y-3 md:space-y-4">
                    <p className="text-slate-500 text-xs">Period: {reportData.period}</p>
                    <div className="grid grid-cols-3 gap-2 md:gap-3">
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                        <p className="text-emerald-600 text-xs">Invoiced</p>
                        <p className="text-slate-900 font-bold text-sm md:text-base">KES {reportData.totalInvoiced.toLocaleString()}</p>
                      </div>
                      <div className="bg-sky-50 border border-sky-200 rounded-lg p-3">
                        <p className="text-sky-600 text-xs">Paid</p>
                        <p className="text-slate-900 font-bold text-sm md:text-base">KES {reportData.totalPaid.toLocaleString()}</p>
                      </div>
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-3">
                        <p className="text-rose-600 text-xs">Outstanding</p>
                        <p className="text-slate-900 font-bold text-sm md:text-base">KES {reportData.totalOutstanding.toLocaleString()}</p>
                      </div>
                    </div>
                    {reportData.rows.length === 0 ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No customer activity</p>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="text-left text-slate-500 border-b border-slate-200">
                              <th className="py-2 pr-2">Customer</th>
                              <th className="py-2 pr-2 text-right">Invoiced</th>
                              <th className="py-2 pr-2 text-right">Paid</th>
                              <th className="py-2 pr-2 text-right">Outstanding</th>
                              <th className="py-2 text-right">Last purchase</th>
                            </tr>
                          </thead>
                          <tbody>
                            {reportData.rows.map((r, i) => (
                              <tr key={i} className="border-b border-slate-100">
                                <td className="py-2 pr-2">
                                  <p className="text-slate-900">{r.name}</p>
                                  <p className="text-slate-400 text-xs">{r.location} · {r.invoices} inv.</p>
                                </td>
                                <td className="py-2 pr-2 text-right text-slate-900">KES {r.invoiced.toLocaleString()}</td>
                                <td className="py-2 pr-2 text-right text-emerald-600">KES {r.paid.toLocaleString()}</td>
                                <td className="py-2 pr-2 text-right text-rose-600">KES {r.outstanding.toLocaleString()}</td>
                                <td className="py-2 text-right text-slate-600">{r.lastPurchase}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}

                {/* Customer Revenue Over Time Report */}
                {reportType === 'customerrevenue' && (
                  <div className="space-y-3 md:space-y-4">
                    {reportData.noCustomer ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">Select a customer above to see their revenue by month.</p>
                    ) : (
                      <>
                        <p className="text-slate-500 text-xs">{reportData.customerName} · {reportData.customerLocation} · Period: {reportData.period}</p>
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4 flex justify-between items-center">
                          <span className="text-emerald-600 text-sm font-semibold">Total Revenue</span>
                          <span className="text-slate-900 font-bold">KES {reportData.totalRevenue.toLocaleString()}</span>
                        </div>
                        {reportData.months.length === 0 ? (
                          <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No sales for this customer in the selected period</p>
                        ) : (
                          <div className="space-y-2">
                            {reportData.months.map(m => (
                              <div key={m.month}>
                                <div className="flex justify-between text-sm mb-1">
                                  <span className="text-slate-600">{monthLabel(m.month)} · {m.invoices} inv.</span>
                                  <span className="text-slate-900 font-semibold">KES {m.revenue.toLocaleString()}</span>
                                </div>
                                <div className="h-2 bg-slate-100 rounded">
                                  <div className="h-2 bg-emerald-400 rounded" style={{ width: `${reportData.maxRevenue > 0 ? (m.revenue / reportData.maxRevenue) * 100 : 0}%` }} />
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Product Mix by Customer Report */}
                {reportType === 'productmix' && (
                  <div className="space-y-3 md:space-y-4">
                    {reportData.noCustomer ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">Select a customer above to see their product mix.</p>
                    ) : (
                      <>
                        <p className="text-slate-500 text-xs">{reportData.customerName} · {reportData.customerLocation} · Period: {reportData.period}</p>
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4 flex justify-between items-center">
                          <span className="text-emerald-600 text-sm font-semibold">Total Revenue</span>
                          <span className="text-slate-900 font-bold">KES {reportData.totalRevenue.toLocaleString()}</span>
                        </div>
                        {reportData.rows.length === 0 ? (
                          <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No purchases for this customer in the selected period</p>
                        ) : (
                          <div className="overflow-x-auto">
                            <table className="w-full text-sm">
                              <thead>
                                <tr className="text-left text-slate-500 border-b border-slate-200">
                                  <th className="py-2 pr-2">Product</th>
                                  <th className="py-2 pr-2 text-right">Quantity</th>
                                  <th className="py-2 pr-2 text-right">Revenue</th>
                                  <th className="py-2 text-right">Share</th>
                                </tr>
                              </thead>
                              <tbody>
                                {reportData.rows.map((r, i) => (
                                  <tr key={i} className="border-b border-slate-100">
                                    <td className="py-2 pr-2 text-slate-900">{r.label}</td>
                                    <td className="py-2 pr-2 text-right text-slate-600">{r.quantity.toLocaleString()} {r.isRefill ? 'btls' : 'ctns'}</td>
                                    <td className="py-2 pr-2 text-right text-slate-900 font-semibold">KES {r.revenue.toLocaleString()}</td>
                                    <td className="py-2 text-right text-slate-600">{reportData.totalRevenue > 0 ? ((r.revenue / reportData.totalRevenue) * 100).toFixed(1) : '0.0'}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Production Report */}
                {reportType === 'productionreport' && (
                  <div className="space-y-4 md:space-y-6">
                    <p className="text-slate-500 text-xs">Period: {reportData.period}</p>

                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
                      <div className="bg-sky-50 border border-slate-200 rounded-lg p-3 md:p-4">
                        <p className="text-slate-500 text-xs md:text-sm">Production Runs</p>
                        <p className="text-slate-900 text-xl md:text-2xl font-bold">{reportData.totalRuns}</p>
                      </div>
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                        <p className="text-emerald-600 text-xs md:text-sm">Cartons Produced</p>
                        <p className="text-slate-900 text-xl md:text-2xl font-bold">{reportData.totalCartons.toLocaleString()}</p>
                      </div>
                      <div className="bg-sky-50 border border-slate-200 rounded-lg p-3 md:p-4">
                        <p className="text-slate-500 text-xs md:text-sm">Bottles Produced</p>
                        <p className="text-slate-900 text-xl md:text-2xl font-bold">{reportData.totalBottles.toLocaleString()}</p>
                      </div>
                    </div>

                    {reportData.totalRuns === 0 ? (
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No production in the selected period</p>
                    ) : (
                      <>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6">
                          <div>
                            <h4 className="text-slate-900 font-semibold mb-2 md:mb-3 text-sm">Cartons by Size</h4>
                            <div className="space-y-1 md:space-y-2">
                              {Object.entries(reportData.cartonsBySize).map(([size, qty]) => (
                                <div key={size} className="flex justify-between p-2 bg-slate-50 rounded text-xs md:text-sm">
                                  <p className="text-slate-500">{SIZE_LABELS[size] || size}</p>
                                  <p className="text-slate-900 font-semibold">{qty.toLocaleString()} cartons</p>
                                </div>
                              ))}
                            </div>
                          </div>
                          <div>
                            <h4 className="text-slate-900 font-semibold mb-2 md:mb-3 text-sm">Bottles by Size</h4>
                            <div className="space-y-1 md:space-y-2">
                              {Object.entries(reportData.bottlesBySize).map(([size, qty]) => (
                                <div key={size} className="flex justify-between p-2 bg-slate-50 rounded text-xs md:text-sm">
                                  <p className="text-slate-500">{SIZE_LABELS[size] || size}</p>
                                  <p className="text-slate-900 font-semibold">{qty.toLocaleString()} bottles</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>

                        {/* Estimated costs — information only, not posted to the P&L */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                          <div className="bg-white border border-slate-200 rounded-lg p-3 md:p-4">
                            <p className="text-slate-500 text-xs md:text-sm">Est. Finished-Goods Value</p>
                            <p className="text-slate-900 text-lg md:text-xl font-bold">KES {reportData.fgValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          </div>
                          <div className="bg-white border border-slate-200 rounded-lg p-3 md:p-4">
                            <p className="text-slate-500 text-xs md:text-sm">Est. Casual Labour Cost</p>
                            <p className="text-slate-900 text-lg md:text-xl font-bold">KES {reportData.casualCost.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          </div>
                        </div>
                        <p className="text-slate-400 text-xs">
                          Finished-goods value uses configured carton costs; casual labour is estimated at the current per-carton rate. Both are for information only — they are not posted to the P&L.
                        </p>

                        {/* Per-run detail */}
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-slate-500 border-b border-slate-200">
                                <th className="py-2 pr-2">Run</th>
                                <th className="py-2 pr-2">Date</th>
                                <th className="py-2 pr-2">Items</th>
                                <th className="py-2 pr-2 text-right">Cartons</th>
                                <th className="py-2 text-right">Casuals</th>
                              </tr>
                            </thead>
                            <tbody>
                              {reportData.runs.map(run => (
                                <tr key={run.id} className="border-b border-slate-100">
                                  <td className="py-2 pr-2 text-slate-900">#{run.id}</td>
                                  <td className="py-2 pr-2 text-slate-600">{run.date}</td>
                                  <td className="py-2 pr-2 text-slate-600">
                                    {Object.entries(run.items).filter(([, q]) => q).map(([size, q]) => `${q}× ${SIZE_LABELS[size] || size}`).join(', ') || '—'}
                                  </td>
                                  <td className="py-2 pr-2 text-right text-slate-900 font-semibold">{run.totalCartons.toLocaleString()}</td>
                                  <td className="py-2 text-right text-slate-600">{run.casualCount}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Production Tab */}
        {activeTab === 'production' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Production</h2>
              <button
                onClick={handleAddProduction}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New
              </button>
            </div>

            {/* Finished Goods */}
            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Finished Goods</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
                {Object.entries(state.finishedGoods).map(([size, data]) => (
                  <div key={size} className="bg-slate-50 border border-slate-200 rounded-lg p-3 md:p-4">
                    <p className="text-slate-500 text-xs md:text-sm mb-2">{SIZE_LABELS[size] || size}</p>
                    <p className="text-slate-900 text-lg md:text-2xl font-bold">{data.quantity}</p>
                    <p className="text-slate-400 text-xs mt-2">{data.quantity * data.bottlesPerCarton} btls</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Production History */}
            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">History</h3>
              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {state.productionLogs.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No logs</p>
                ) : (
                  state.productionLogs.slice().reverse().map(log => (
                    <div key={log.id} className="p-3 md:p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="text-slate-900 font-semibold text-sm">Prod #{log.id}</p>
                          <p className="text-slate-500 text-xs">{log.date}</p>
                        </div>
                        <span className="bg-sky-50 text-sky-700 border border-sky-200 px-2 py-1 rounded text-xs">
                          {log.unit}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-1 text-xs mb-2">
                        {Object.entries(log.items).map(([size, qty]) => (
                          <div key={size}>
                            <p className="text-slate-500">{size}</p>
                            <p className="text-slate-900 font-semibold">{qty}</p>
                          </div>
                        ))}
                      </div>
                      {log.notes && <p className="text-slate-500 text-xs italic">{log.notes}</p>}
                      {/* RLS only permits admin to delete production logs. */}
                      {role === 'admin' && (
                        <div className="flex justify-end pt-2 mt-2 border-t border-slate-100">
                          <button
                            onClick={() => handleDeleteProduction(log.id)}
                            className="flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded transition"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* Sales Tab */}
        {activeTab === 'sales' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-900">Invoices</h2>
                <p className="text-slate-500 text-sm mt-1">Record sales and download printable invoices for customers.</p>
              </div>
              <button
                onClick={handleAddSale}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Sale
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3 md:mb-4">
                <h3 className="text-slate-900 font-semibold text-sm md:text-base">Invoice History</h3>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={salesSearch}
                    onChange={(e) => setSalesSearch(e.target.value)}
                    placeholder="Search name / invoice..."
                    className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm placeholder-slate-400"
                  />
                  <input
                    type="date"
                    value={salesFilterDate}
                    onChange={(e) => setSalesFilterDate(e.target.value)}
                    className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm"
                  />
                  {(salesFilterDate || salesSearch) && (
                    <button onClick={() => { setSalesFilterDate(''); setSalesSearch(''); }} className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1">Clear</button>
                  )}
                </div>
              </div>

              {(() => {
                const matchesSearch = (s) => {
                  if (!salesSearch) return true;
                  const c = state.customers.find(c => c.id === s.customerId);
                  const q = salesSearch.toLowerCase();
                  return (c?.name || '').toLowerCase().includes(q) || (s.invoiceNumber || '').toLowerCase().includes(q);
                };
                const filtered = visibleSales
                  .filter(s => !salesFilterDate || s.date === salesFilterDate)
                  .filter(matchesSearch);

                // Day summary: cash taken at the point of sale that day vs what
                // went to debt. Uses paid-at-sale (sale.paid minus linked debt
                // repayments, same formula as the Cash Collected report) — raw
                // sale.paid also includes repayments received on LATER dates,
                // which overstated the day's cash as old debts were settled.
                if (salesFilterDate) {
                  const dayTotal = filtered.reduce((sum, s) => sum + s.total, 0);
                  const dayCash = filtered.reduce((sum, s) => {
                    const paidViaPayments = state.payments
                      .filter(p => p.saleId === s.id)
                      .reduce((pSum, p) => pSum + (p.amount || 0), 0);
                    return sum + Math.max(0, (s.paid || 0) - paidViaPayments);
                  }, 0);
                  const dayDebt = dayTotal - dayCash;
                  return (
                    <div className="grid grid-cols-3 gap-2 mb-4">
                      <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                        <p className="text-slate-500 text-xs">Total</p>
                        <p className="text-slate-900 font-bold text-sm">KES {dayTotal.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-center">
                        <p className="text-emerald-600 text-xs">Cash</p>
                        <p className="text-slate-900 font-bold text-sm">KES {dayCash.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                      <div className="bg-rose-50 border border-rose-200 rounded-lg p-3 text-center">
                        <p className="text-rose-600 text-xs">Debt</p>
                        <p className="text-slate-900 font-bold text-sm">KES {dayDebt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {(() => {
                  const matchesSearch = (s) => {
                    if (!salesSearch) return true;
                    const c = state.customers.find(c => c.id === s.customerId);
                    const q = salesSearch.toLowerCase();
                    return (c?.name || '').toLowerCase().includes(q) || (s.invoiceNumber || '').toLowerCase().includes(q);
                  };
                  const list = visibleSales
                    .filter(s => !salesFilterDate || s.date === salesFilterDate)
                    .filter(matchesSearch);
                  return list.length === 0 ? (
                    <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No matching sales</p>
                  ) : (
                    list.slice().reverse().map(sale => {
                    const customer = state.customers.find(c => c.id === sale.customerId);
                    return (
                      <div key={sale.id} className="p-3 md:p-4 bg-slate-50 rounded-lg border border-slate-100">
                        <div className="flex justify-between items-start gap-2 mb-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-slate-900 font-semibold text-sm truncate">{customer?.name}</p>
                              <button onClick={() => setInvoiceDetail(sale)} className="text-sky-700 text-xs underline hover:text-sky-800">{sale.invoiceNumber}</button>
                            </div>
                            <p className="text-slate-500 text-xs">{sale.date}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-emerald-600 font-semibold text-sm">KES {sale.total.toLocaleString()}</p>
                            <span className={`text-xs px-2 py-1 rounded block mt-1 ${sale.status === 'paid' ? 'bg-slate-100 text-emerald-600' : sale.status === 'partial' ? 'bg-amber-50 text-amber-700' : 'bg-rose-50 text-rose-700'}`}>
                              {sale.status === 'paid' ? '✓' : sale.status === 'partial' ? '◐' : '○'}
                            </span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs pt-2 border-t border-slate-100">
                          {sale.items.slice(0, 2).map((item, i) => (
                            <div key={i}>
                              <p className="text-slate-500">{SIZE_LABELS[item.size] || item.size}</p>
                              <p className="text-slate-900">{item.quantity}×{item.price}</p>
                            </div>
                          ))}
                        </div>
                        <div className="flex justify-end gap-1 pt-2 mt-2 border-t border-slate-100">
                          <button
                            onClick={() => downloadInvoiceAsPDF(sale)}
                            className="flex items-center gap-1 text-xs text-sky-700 hover:text-sky-800 hover:bg-sky-50 px-2 py-1 rounded transition"
                          >
                            <Download className="w-3 h-3" /> Invoice PDF
                          </button>
                          {/* RLS only permits admin to delete sales — showing the
                              button to managers produced silent failures. */}
                          {role === 'admin' && (
                            <button
                              onClick={() => handleDeleteSale(sale.id)}
                              className="flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded transition"
                            >
                              <Trash2 className="w-3 h-3" /> Delete
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Payments Tab */}
        {activeTab === 'payments' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Payments & Debts</h2>
              <button
                onClick={handleAddPayment}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> Record Payment
              </button>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              <StatCard
                label="Total Debt"
                value={`KES ${visibleCustomers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={Wallet}
                accent="rose"
                onClick={() => setPaymentsTab('debts')}
              />
              <StatCard
                label="Total Credits"
                value={`KES ${state.customers.reduce((sum, c) => sum + Math.max(0, c.balance), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={TrendingUp}
                accent="emerald"
              />
              <StatCard
                label="Received This Month"
                value={`KES ${visiblePayments.filter(p => (p.date || '').slice(0, 7) === localMonthPrefix()).reduce((sum, p) => sum + p.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={DollarSign}
                accent="sky"
                sub="debt payments this month"
              />
            </div>

            {/* Tab Navigation */}
            <div className="bg-white border-b border-slate-200 rounded-t-lg flex gap-2 p-2">
              <button
                onClick={() => setPaymentsTab('debts')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'debts'
                    ? 'bg-rose-50 text-rose-700 border-b-2 border-rose-400'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                💰 Outstanding Debts
              </button>
              <button
                onClick={() => setPaymentsTab('history')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'history'
                    ? 'bg-sky-50 text-sky-700 border-b-2 border-sky-400'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                📋 Payment History
              </button>
              <button
                onClick={() => setPaymentsTab('accounts')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'accounts'
                    ? 'bg-emerald-50 text-emerald-700 border-b-2 border-emerald-400'
                    : 'text-slate-500 hover:text-slate-900'
                }`}
              >
                👥 All Accounts
              </button>
            </div>

            {/* Outstanding Debts Tab */}
            {paymentsTab === 'debts' && (
              <div className="bg-white border border-slate-200 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
                  <h3 className="text-slate-900 font-semibold text-base">Customers with Outstanding Debts</h3>
                  <input
                    type="text"
                    value={debtsSearch}
                    onChange={(e) => setDebtsSearch(e.target.value)}
                    placeholder="Search customer..."
                    className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm placeholder-slate-400"
                  />
                </div>
                <div className="flex flex-col sm:flex-row sm:items-end gap-3 mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                  <div className="flex-1">
                    <label className="block text-slate-500 text-xs mb-1">Statement from</label>
                    <input
                      type="date"
                      value={statementRange.start}
                      onChange={(e) => setStatementRange({ ...statementRange, start: e.target.value })}
                      className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm"
                    />
                  </div>
                  <div className="flex-1">
                    <label className="block text-slate-500 text-xs mb-1">Statement to</label>
                    <input
                      type="date"
                      value={statementRange.end}
                      onChange={(e) => setStatementRange({ ...statementRange, end: e.target.value })}
                      className="w-full bg-white border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm"
                    />
                  </div>
                  <button
                    onClick={() => setStatementRange({ start: '', end: '' })}
                    className="bg-white hover:bg-slate-100 border border-slate-300 text-slate-600 rounded-lg px-3 py-1.5 text-sm font-semibold"
                  >
                    Clear
                  </button>
                  <p className="text-slate-400 text-xs sm:self-center">
                    {statementRange.start && statementRange.end ? `Statements: ${statementRange.start} → ${statementRange.end}` : 'Statements: all time (set both dates to filter)'}
                  </p>
                </div>
                <div className="space-y-3">
                  {visibleCustomers.filter(c => c.balance < 0).filter(c => !debtsSearch || (c.name || '').toLowerCase().includes(debtsSearch.toLowerCase())).length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-emerald-600 text-lg font-semibold">✓ No Outstanding Debts!</p>
                      <p className="text-slate-500 text-sm mt-2">{debtsSearch ? 'No matching debtors' : 'All customers are up to date'}</p>
                    </div>
                  ) : (
                    visibleCustomers
                      .filter(c => c.balance < 0)
                      .filter(c => !debtsSearch || (c.name || '').toLowerCase().includes(debtsSearch.toLowerCase()))
                      .sort((a, b) => a.balance - b.balance)
                      .map((customer) => {
                        const debt = Math.abs(customer.balance);
                        const sales = state.sales.filter(s => s.customerId === customer.id && s.status !== 'paid');
                        const lastSale = sales.length > 0 ? sales[sales.length - 1] : null;
                        
                        return (
                          <div key={customer.id} className="p-4 bg-rose-50 border-2 border-rose-200 rounded-lg">
                            {/* Customer Header */}
                            <div className="flex justify-between items-start mb-3">
                              <div className="flex-1">
                                <p className="text-slate-900 text-lg font-bold">{customer.name}</p>
                                <p className="text-rose-600 text-sm">{customer.location}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-rose-600 text-2xl font-bold">KES {debt.toLocaleString()}</p>
                                <p className="text-rose-600 text-xs">Outstanding</p>
                              </div>
                            </div>

                            {/* Customer Details */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 py-3 border-t border-b border-rose-200">
                              <div>
                                <p className="text-slate-500 text-xs">Phone</p>
                                <p className="text-slate-900 font-semibold text-sm">{customer.phone}</p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs">Unpaid Invoices</p>
                                <p className="text-slate-900 font-semibold text-sm">{sales.length}</p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs">Last Sale Date</p>
                                <p className="text-slate-900 font-semibold text-sm">{lastSale?.date || 'N/A'}</p>
                              </div>
                              <div>
                                <p className="text-slate-500 text-xs">Status</p>
                                <p className={`font-semibold text-sm ${customer.isActive ? 'text-emerald-600' : 'text-amber-600'}`}>
                                  {customer.isActive ? 'Active' : 'Inactive'}
                                </p>
                              </div>
                            </div>

                            {/* Unpaid Invoices */}
                            {sales.length > 0 && (
                              <div className="mt-3 pt-3 border-t border-rose-200">
                                <p className="text-rose-600 font-semibold text-sm mb-2">Unpaid Invoices:</p>
                                <div className="space-y-1">
                                  {sales.map((sale) => (
                                    <button key={sale.id} onClick={() => setInvoiceDetail(sale)} className="w-full flex justify-between text-xs bg-slate-50 hover:bg-sky-50 p-2 rounded transition text-left">
                                      <span className="text-sky-700 underline">{sale.invoiceNumber} • {sale.date}</span>
                                      <span className="text-rose-600 font-semibold">KES {(sale.total - sale.paid).toLocaleString()}</span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Action Buttons */}
                            <div className="mt-3 flex flex-col sm:flex-row gap-2">
                              <button
                                onClick={handleAddPayment}
                                className="flex-1 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 py-2 px-3 rounded-lg transition text-sm font-semibold"
                              >
                                Record Payment
                              </button>
                              <button
                                onClick={() => downloadAccountStatementAsPDF(customer, statementRange)}
                                className="flex-1 bg-sky-50 hover:bg-sky-100 border border-sky-200 text-sky-700 py-2 px-3 rounded-lg transition text-sm font-semibold"
                              >
                                Download Statement (PDF)
                              </button>
                            </div>
                          </div>
                        );
                      })
                  )}
                </div>
              </div>
            )}

            {/* Payment History Tab */}
            {paymentsTab === 'history' && (
              <div className="bg-white border border-slate-200 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-4">
                  <h3 className="text-slate-900 font-semibold text-base">Payment History</h3>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={paymentsSearch}
                      onChange={(e) => setPaymentsSearch(e.target.value)}
                      placeholder="Search customer..."
                      className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm placeholder-slate-400"
                    />
                    <input
                      type="date"
                      value={paymentsFilterDate}
                      onChange={(e) => setPaymentsFilterDate(e.target.value)}
                      className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm"
                    />
                    {(paymentsFilterDate || paymentsSearch) && (
                      <button onClick={() => { setPaymentsFilterDate(''); setPaymentsSearch(''); }} className="text-xs text-slate-500 hover:text-slate-800 px-2 py-1">Clear</button>
                    )}
                  </div>
                </div>
                {(() => {
                  if (!paymentsFilterDate) return null;
                  const dayList = visiblePayments
                    .filter(p => p.date === paymentsFilterDate)
                    .filter(p => {
                      if (!paymentsSearch) return true;
                      const c = state.customers.find(c => c.id === p.customerId);
                      return (c?.name || '').toLowerCase().includes(paymentsSearch.toLowerCase());
                    });
                  const dayTotal = dayList.reduce((sum, p) => sum + p.amount, 0);
                  return (
                    <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-3 flex justify-between items-center">
                      <span className="text-emerald-700 text-sm font-medium">Collected on {paymentsFilterDate} ({dayList.length} payment{dayList.length === 1 ? '' : 's'})</span>
                      <span className="text-emerald-600 font-bold text-lg">KES {dayTotal.toLocaleString()}</span>
                    </div>
                  );
                })()}
                <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                  {(() => {
                    const list = visiblePayments
                      .filter(p => !paymentsFilterDate || p.date === paymentsFilterDate)
                      .filter(p => {
                        if (!paymentsSearch) return true;
                        const c = state.customers.find(c => c.id === p.customerId);
                        return (c?.name || '').toLowerCase().includes(paymentsSearch.toLowerCase());
                      });
                    return list.length === 0 ? (
                      <p className="text-slate-500 text-center py-8 text-sm">No matching payments</p>
                    ) : (
                      list.slice().reverse().map(payment => {
                      const customer = state.customers.find(c => c.id === payment.customerId);
                      const sale = state.sales.find(s => s.id === payment.saleId);
                      return (
                        <div key={payment.id} className="p-3 md:p-4 bg-slate-50 rounded-lg border border-slate-200">
                          <div className="flex justify-between items-start mb-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-slate-900 font-semibold truncate">{customer?.name}</p>
                              <p className="text-slate-500 text-xs">{payment.date}</p>
                            </div>
                            <p className="text-emerald-600 font-bold text-lg ml-2">KES {payment.amount.toLocaleString()}</p>
                          </div>
                          <div className="flex gap-2 text-xs text-slate-500 items-center">
                            <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">{payment.method}</span>
                            {sale ? (
                              <button onClick={() => setInvoiceDetail(sale)} className="bg-sky-50 text-sky-700 underline px-2 py-1 rounded hover:bg-sky-100 transition">{sale.invoiceNumber}</button>
                            ) : (
                              <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">N/A</span>
                            )}
                            {payment.reference && <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">Ref: {payment.reference}</span>}
                            {/* RLS only permits admin to delete payments. */}
                            {role === 'admin' && (
                              <button
                                onClick={() => handleDeletePayment(payment.id)}
                                className="flex items-center gap-1 text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded transition ml-auto"
                                title="Delete payment"
                              >
                                <Trash2 className="w-3 h-3" /> Delete
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                    );
                  })()}
                </div>
              </div>
            )}

            {/* All Accounts Tab */}
            {paymentsTab === 'accounts' && (
              <div className="bg-white border border-slate-200 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <h3 className="text-slate-900 font-semibold mb-4 text-base">All Customer Accounts</h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {state.customers.length === 0 ? (
                    <p className="text-slate-500 text-center py-8 text-sm">No customers</p>
                  ) : (
                    state.customers.sort((a, b) => a.balance - b.balance).map(customer => {
                      const isDebtor = customer.balance < 0;
                      const isCreditor = customer.balance > 0;
                      
                      return (
                        <div 
                          key={customer.id} 
                          className={`p-3 md:p-4 rounded-lg flex justify-between items-center border-l-4 transition ${
                            isDebtor
                              ? 'bg-rose-50 border-rose-400 hover:bg-rose-100'
                              : isCreditor
                              ? 'bg-emerald-50 border-emerald-400 hover:bg-emerald-100'
                              : 'bg-slate-50 border-slate-300 hover:bg-slate-100'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-slate-900 font-semibold truncate">{customer.name}</p>
                            <p className="text-slate-500 text-xs">{customer.location} • {customer.phone}</p>
                          </div>
                          <div className="text-right flex-shrink-0 ml-2">
                            <p className={`font-bold text-base ${
                              isDebtor ? 'text-rose-600' : isCreditor ? 'text-emerald-600' : 'text-slate-500'
                            }`}>
                              {isDebtor ? '- ' : isCreditor ? '+ ' : ''}KES {Math.abs(customer.balance).toLocaleString()}
                            </p>
                            <p className={`text-xs ${isDebtor ? 'text-rose-600' : isCreditor ? 'text-emerald-600' : 'text-slate-500'}`}>
                              {isDebtor ? 'OWES' : isCreditor ? 'CREDIT' : 'BALANCED'}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Expenses Tab */}
        {activeTab === 'expenses' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-900">Expenses</h2>
                <p className="text-slate-500 text-sm mt-1">Track operating costs and cost-of-goods spending by category.</p>
              </div>
              <button
                onClick={handleAddExpense}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Expense
              </button>
            </div>

            {role !== 'sales' && (
            <>
            {/* Summary by Category */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              {Object.entries(getMonthExpensesByCategory()).map(([category, amount]) => (
                <div key={category} className="bg-amber-50 border border-amber-200 rounded-lg md:rounded-xl p-3 md:p-4">
                  <p className="text-amber-600 text-xs md:text-sm">{category}</p>
                  <p className="text-slate-900 text-lg md:text-2xl font-bold">KES {amount.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {/* Total Expenses */}
            <StatCard
              label="Total Expenses"
              value={`KES ${getMonthExpenses().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              icon={Wallet}
              accent="amber"
              sub="this month"
            />

            {/* Expenses List */}
            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 md:mb-4 text-sm md:text-base">Expense Records</h3>
              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {state.expenses.length === 0 ? (
                  <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No expenses recorded</p>
                ) : (
                  state.expenses.slice().reverse().map(expense => (
                    <div key={expense.id} className="p-3 md:p-4 bg-slate-50 rounded-lg border border-slate-100">
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-slate-900 font-semibold text-sm truncate">{expense.description || expense.subcategory}</p>
                          <p className="text-slate-500 text-xs">{expense.date}</p>
                          <p className="text-slate-500 text-xs">{expense.category} • {expense.subcategory}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <p className="text-amber-600 font-semibold">KES {expense.amount.toLocaleString()}</p>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                setEditingExpense(expense);
                                setModalType('expense');
                                // Map the stored advance link into the form field the
                                // modal and save handler use — without this, editing an
                                // advance expense silently cleared advance_employee_id
                                // and the advance stopped being deducted from salary.
                                setFormData({ ...expense, advanceEmployeeId: expense.advance_employee_id ?? '' });
                                setShowModal(true);
                              }}
                              className="p-1 hover:bg-slate-100 rounded transition"
                            >
                              <Edit2 className="w-3 h-3 text-slate-500" />
                            </button>
                            {/* RLS only permits admin to delete expenses. */}
                            {role === 'admin' && (
                              <button
                                onClick={() => handleDeleteExpense(expense.id)}
                                className="p-1 hover:bg-rose-50 rounded transition"
                              >
                                <Trash2 className="w-3 h-3 text-rose-600" />
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
            </>
            )}

            {role === 'sales' && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <p className="text-slate-500 text-center py-4 text-sm">Use the "New Expense" button above to record an expense.</p>
              </div>
            )}
          </div>
        )}
        {/* Customers Tab */}
        {activeTab === 'customers' && (() => {
          // Stats reflect ALL customers in scope (not the current search).
          // visibleCustomers, not state.customers: a sales user must only ever
          // see their own location's accounts and debt. RLS scopes this at the
          // database too — this is the second line of defence, and the reason
          // the Customers module is no longer the odd one out among the
          // sales-facing views.
          const allCustomers = visibleCustomers;
          const totalCustomers = allCustomers.length;
          const activeCount = allCustomers.filter(c => c.isActive).length;
          const outstandingDebt = allCustomers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0);

          // Helper for initials avatar.
          const initialsOf = (name) =>
            (name || '?').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();

          // Apply search + status filter to the visible list.
          const filtered = allCustomers.filter(customer => {
            const searchTerm = customerSearch.toLowerCase();
            const matchesSearch =
              customer.name.toLowerCase().includes(searchTerm) ||
              customer.location.toLowerCase().includes(searchTerm) ||
              customer.phone.includes(searchTerm);
            const matchesStatus =
              customerStatusFilter === 'all' ||
              (customerStatusFilter === 'active' && customer.isActive) ||
              (customerStatusFilter === 'inactive' && !customer.isActive);
            return matchesSearch && matchesStatus;
          });

          const openEdit = (customer) => {
            setEditingCustomer(customer);
            setModalType('customer');
            setFormData(customer);
            setShowModal(true);
          };

          return (
          <div className="space-y-4 md:space-y-6">
            {/* Page header */}
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <div>
                <h2 className="text-xl md:text-2xl font-bold text-slate-900">Customer Management</h2>
                <p className="text-slate-500 text-sm mt-1">Manage and monitor accounts for hotels, shops, and individual clients.</p>
              </div>
              <button
                onClick={handleAddCustomer}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm font-medium shadow-sm"
              >
                <Plus className="w-4 h-4" /> New Customer
              </button>
            </div>

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4">
              <StatCard label="Total Customers" value={totalCustomers.toLocaleString()} icon={Users} accent="sky" sub="accounts in your scope" />
              {/* "all accounts" read as company-wide to a sales user whose view is
                  location-scoped; say whose accounts these actually are. */}
              <StatCard label="Outstanding Debt" value={`KES ${outstandingDebt.toLocaleString()}`} icon={Wallet} accent="rose" sub={role === 'sales' && myLocation ? `owed across ${myLocation} accounts` : 'owed across all accounts'} />
              <StatCard label="Active Accounts" value={activeCount.toLocaleString()} icon={TrendingUp} accent="emerald" sub={`${totalCustomers - activeCount} inactive`} />
            </div>

            {/* Search + filter bar */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-3 md:p-4 flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  placeholder="Search by name, location, or phone..."
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg pl-9 pr-4 py-2 text-sm placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-400"
                />
              </div>
              <div className="relative sm:w-44">
                <Filter className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <select
                  value={customerStatusFilter}
                  onChange={(e) => setCustomerStatusFilter(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg pl-9 pr-4 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-200 focus:border-sky-400"
                >
                  <option value="all">Any Status</option>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
            </div>

            {/* Customer list */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
              {/* Desktop table */}
              <table className="hidden md:table w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="font-medium px-5 py-3">Customer Details</th>
                    <th className="font-medium px-5 py-3">Location</th>
                    <th className="font-medium px-5 py-3">Status</th>
                    <th className="font-medium px-5 py-3 text-right">Balance</th>
                    <th className="font-medium px-5 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map(customer => (
                    <tr
                      key={customer.id}
                      onClick={() => { setCustomerCardTab('sales'); setCustomerDetail(customer.id); }}
                      className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition cursor-pointer"
                    >
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <div className="flex-shrink-0 w-9 h-9 rounded-full bg-sky-50 text-sky-600 flex items-center justify-center text-xs font-semibold">
                            {initialsOf(customer.name)}
                          </div>
                          <div className="min-w-0">
                            <p className="text-slate-900 font-semibold truncate">{customer.name}</p>
                            <p className="text-slate-500 text-xs truncate">{customer.phone}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-3 text-slate-600">{customer.location}</td>
                      <td className="px-5 py-3">
                        <Badge color={customer.isActive ? 'emerald' : 'rose'} dot>
                          {customer.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </td>
                      <td className={`px-5 py-3 text-right font-semibold ${customer.balance >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>
                        KES {customer.balance.toLocaleString()}
                      </td>
                      {/* stopPropagation so the row's card does not open behind
                          the edit modal or the delete confirmation. */}
                      <td className="px-5 py-3" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => openEdit(customer)} className="p-2 hover:bg-slate-100 rounded-lg transition" title="Edit">
                            <Edit2 className="w-4 h-4 text-slate-500" />
                          </button>
                          {/* RLS only permits admin to delete customers. */}
                          {role === 'admin' && (
                            <button onClick={() => handleDeleteCustomer(customer.id)} className="p-2 hover:bg-rose-50 rounded-lg transition" title="Delete">
                              <Trash2 className="w-4 h-4 text-rose-600" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-slate-100">
                {filtered.map(customer => (
                  <div
                    key={customer.id}
                    onClick={() => { setCustomerCardTab('sales'); setCustomerDetail(customer.id); }}
                    className="p-4 active:bg-slate-50 transition cursor-pointer"
                  >
                    <div className="flex justify-between items-start gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="flex-shrink-0 w-9 h-9 rounded-full bg-sky-50 text-sky-600 flex items-center justify-center text-xs font-semibold">
                          {initialsOf(customer.name)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-slate-900 font-semibold truncate">{customer.name}</p>
                          <p className="text-slate-500 text-xs truncate">{customer.location} • {customer.phone}</p>
                        </div>
                      </div>
                      <div className="flex gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => openEdit(customer)} className="p-2 hover:bg-slate-100 rounded-lg transition">
                          <Edit2 className="w-4 h-4 text-slate-500" />
                        </button>
                        {role === 'admin' && (
                          <button onClick={() => handleDeleteCustomer(customer.id)} className="p-2 hover:bg-rose-50 rounded-lg transition">
                            <Trash2 className="w-4 h-4 text-rose-600" />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center justify-between pt-3 mt-3 border-t border-slate-100">
                      <Badge color={customer.isActive ? 'emerald' : 'rose'} dot>
                        {customer.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                      <p className={`text-base font-semibold ${customer.balance >= 0 ? 'text-slate-900' : 'text-rose-600'}`}>
                        KES {customer.balance.toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))}
              </div>

              {/* Empty state */}
              {filtered.length === 0 && (
                <div className="px-5 py-12 text-center text-slate-400 text-sm">
                  No customers match your search.
                </div>
              )}
            </div>

            {filtered.length > 0 && (
              <p className="text-slate-400 text-xs px-1">
                Showing {filtered.length} of {totalCustomers} customer{totalCustomers === 1 ? '' : 's'}
              </p>
            )}
          </div>
          );
        })()}

        {/* Cost Settings Tab (admin only) */}
        {activeTab === 'costsettings' && role === 'admin' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Cost Settings</h2>
              <p className="text-slate-500 text-sm mt-1">Enter the cost per carton for each product size. Used to value finished goods stock. Raw material values come automatically from your latest purchase prices.</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-4 text-sm md:text-base">Finished Goods — Cost per Carton (KES)</h3>
              <div className="space-y-3">
                {['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill', 'refill_10L', 'refill_15L', 'refill_20L'].map(size => (
                  <div key={size} className="flex items-center justify-between gap-3">
                    <label className="text-slate-500 text-sm">
                      {size === '18.9L_disposable' ? '18.9L Disposable' : size === '18.9L_refill' ? '18.9L Refill (bottle)' : size === 'refill_10L' ? 'Water Refill 10L' : size === 'refill_15L' ? 'Water Refill 15L' : size === 'refill_20L' ? 'Water Refill 20L' : size}
                    </label>
                    <input
                      type="number"
                      value={cartonCosts[size] || ''}
                      onChange={(e) => setCartonCosts({ ...cartonCosts, [size]: parseFloat(e.target.value) || 0 })}
                      placeholder="0"
                      className="w-32 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm text-right"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={handleSaveCartonCosts}
                className="mt-6 w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-6 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Save className="w-4 h-4" /> Save Costs
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-slate-900 font-semibold mb-3 text-sm md:text-base">Current Asset Valuation</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between p-2 bg-slate-50 rounded">
                  <span className="text-slate-500">Raw Materials (at latest purchase prices)</span>
                  <span className="text-slate-900 font-semibold">KES {calculateInventoryValue().toLocaleString()}</span>
                </div>
                <div className="flex justify-between p-2 bg-slate-50 rounded">
                  <span className="text-slate-500">Finished Goods at the plant (at carton cost)</span>
                  <span className="text-slate-900 font-semibold">KES {calculateFinishedGoodsValue().toLocaleString()}</span>
                </div>
                {consignees().length > 0 && (
                  <div className="flex justify-between p-2 bg-slate-50 rounded">
                    <span className="text-slate-500">Stock at consignment shops (at carton cost)</span>
                    <span className="text-slate-900 font-semibold">KES {calculateConsignmentStockValue().toLocaleString()}</span>
                  </div>
                )}
                <div className="flex justify-between p-2 bg-slate-50 rounded border border-emerald-200">
                  <span className="text-emerald-600 font-semibold">Total Assets</span>
                  <span className="text-emerald-600 font-bold">KES {calculateTotalAssets().toLocaleString()}</span>
                </div>
              </div>
              <p className="text-slate-500 text-xs mt-3">Note: Materials with no purchase recorded yet are valued at 0 until you log a purchase for them.</p>
              {consignees().length > 0 && (
                <p className="text-slate-500 text-xs mt-1">Stock delivered to a consignment shop is still ours until the shop reports it sold, so it is counted as an asset — just held off-site rather than at the plant.</p>
              )}
            </div>
          </div>
        )}

        {/* Stock Adjustment Tab (admin only) */}
        {activeTab === 'adjust' && role === 'admin' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Stock Adjustment</h2>
              <p className="text-slate-500 text-sm mt-1">Set the actual quantity of any stock item after a physical count. Use this to align the system with reality (opening stock, stock-take, breakage). Each change is logged.</p>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {getStockItems().map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 p-2 bg-slate-50 rounded-lg">
                    <div className="min-w-0">
                      <p className="text-slate-900 text-sm truncate">{item.label}</p>
                      <p className="text-slate-500 text-xs">Current: {item.qty}</p>
                    </div>
                    <button
                      onClick={() => {
                        setModalType('adjust');
                        setFormData({ itemId: item.id, itemLabel: item.label, currentQty: item.qty, newQty: '', reason: '' });
                        setShowModal(true);
                      }}
                      className="bg-sky-500 hover:bg-sky-600 text-white font-medium px-3 py-1.5 rounded text-xs whitespace-nowrap"
                    >
                      Adjust
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* HR Tab (admin only) — Stage A: Employee Registry */}
        {activeTab === 'hr' && role === 'admin' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Human Resources</h2>
              <p className="text-slate-500 text-sm mt-1">Manage employees and their pay rates. Permanent staff have a fixed monthly salary; casuals are paid per carton produced.</p>
            </div>

            {/* HR sub-navigation */}
            <div className="flex gap-1 bg-slate-100 border border-slate-200 rounded-lg p-1 overflow-x-auto">
              {[
                { id: 'registry', label: 'Employees' },
                { id: 'permanent', label: 'Permanent Payroll' },
                { id: 'casual', label: 'Casual Pay' },
              ].map(v => (
                <button
                  key={v.id}
                  onClick={() => setHrView(v.id)}
                  className={`px-3 py-1.5 rounded-md text-xs md:text-sm font-medium whitespace-nowrap transition ${
                    hrView === v.id ? 'bg-sky-500 text-white' : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>

            {/* Casual shared rate setting */}
            {hrView === 'registry' && (
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-slate-700 font-semibold text-sm">Casual Rate per Carton (shared)</h3>
                  <p className="text-slate-400 text-xs mt-0.5">One rate applied to all casuals' carton shares.</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-slate-400 text-xs">KES</span>
                  <input
                    type="number"
                    step="0.01"
                    value={casualRate || ''}
                    onChange={(e) => setCasualRate(parseFloat(e.target.value) || 0)}
                    className="w-28 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm text-right"
                  />
                  <button onClick={handleSaveCasualRate} className="bg-sky-500 hover:bg-sky-600 text-white text-xs rounded-lg px-3 py-1.5">Save</button>
                </div>
              </div>
            </div>
            )}

            {hrView === 'registry' && (<>
            {/* Permanent employees */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-slate-700 font-semibold text-sm">Permanent Employees</h3>
                <button onClick={() => handleAddEmployee('permanent')} className="bg-sky-500 hover:bg-sky-600 text-white text-xs rounded-lg px-3 py-1.5 flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
              {employees.filter(e => e.category === 'permanent').length === 0 ? (
                <p className="text-slate-400 text-sm text-center py-4">No permanent employees yet</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {employees.filter(e => e.category === 'permanent').map(emp => (
                    <div key={emp.id} className="flex items-center justify-between py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-slate-900 text-sm font-medium">{emp.name}</p>
                          <span className={`text-[10px] rounded px-1.5 py-0.5 border ${emp.active ? 'text-emerald-700 border-emerald-200 bg-emerald-50' : 'text-slate-400 border-slate-200 bg-slate-50'}`}>
                            {emp.active ? 'active' : 'inactive'}
                          </span>
                        </div>
                        <p className="text-slate-400 text-xs mt-0.5">{emp.phone || 'No phone'}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-slate-900 text-sm font-semibold">KES {Number(emp.rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          <p className="text-slate-400 text-[10px]">per month</p>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => handleEditEmployee(emp)} className="text-slate-400 hover:text-sky-600"><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => handleDeleteEmployee(emp.id)} className="text-slate-400 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Casual employees */}
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-slate-700 font-semibold text-sm">Casual Employees</h3>
                <button onClick={() => handleAddEmployee('casual')} className="bg-sky-500 hover:bg-sky-600 text-white text-xs rounded-lg px-3 py-1.5 flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
              {employees.filter(e => e.category === 'casual').length === 0 ? (
                <p className="text-slate-400 text-sm text-center py-4">No casual employees yet</p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {employees.filter(e => e.category === 'casual').map(emp => (
                    <div key={emp.id} className="flex items-center justify-between py-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-slate-900 text-sm font-medium">{emp.name}</p>
                          <span className={`text-[10px] rounded px-1.5 py-0.5 border ${emp.active ? 'text-emerald-700 border-emerald-200 bg-emerald-50' : 'text-slate-400 border-slate-200 bg-slate-50'}`}>
                            {emp.active ? 'active' : 'inactive'}
                          </span>
                        </div>
                        <p className="text-slate-400 text-xs mt-0.5">{emp.phone || 'No phone'}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="text-slate-900 text-sm font-semibold">KES {Number(emp.rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                          <p className="text-slate-400 text-[10px]">per carton</p>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => handleEditEmployee(emp)} className="text-slate-400 hover:text-sky-600"><Edit2 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => handleDeleteEmployee(emp.id)} className="text-slate-400 hover:text-rose-500"><Trash2 className="w-3.5 h-3.5" /></button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            </>)}

            {/* Permanent Payroll view */}
            {hrView === 'permanent' && (
              <div className="space-y-4">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                  <label className="text-slate-500 text-xs block mb-2">Month</label>
                  <input
                    type="month"
                    value={hrMonth}
                    onChange={(e) => setHrMonth(e.target.value)}
                    className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm"
                  />
                </div>
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
                  <h3 className="text-slate-700 font-semibold text-sm mb-3">Net Payable — {hrMonth}</h3>
                  {employees.filter(e => e.category === 'permanent' && e.active).length === 0 ? (
                    <p className="text-slate-400 text-sm text-center py-4">No active permanent employees</p>
                  ) : (
                    <div className="divide-y divide-slate-100">
                      {employees.filter(e => e.category === 'permanent' && e.active).map(emp => {
                        const advances = getAdvancesForEmployee(emp.id, hrMonth);
                        const net = Number(emp.rate) - advances;
                        const paid = isSalaryPaid(emp.id, hrMonth);
                        return (
                          <div key={emp.id} className="py-3">
                            <div className="flex items-center justify-between">
                              <p className="text-slate-900 text-sm font-medium">{emp.name}</p>
                              <p className="text-slate-900 text-sm font-bold">KES {net.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                            </div>
                            <div className="flex items-center justify-between text-xs text-slate-400 mt-1">
                              <span>Salary KES {Number(emp.rate).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                              <span className={advances > 0 ? 'text-rose-500' : ''}>− advances KES {advances.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                            </div>
                            <div className="mt-2">
                              {paid ? (
                                <span className="text-emerald-600 text-xs font-medium">✓ Paid</span>
                              ) : (
                                <button onClick={() => recordSalaryPayment(emp, hrMonth, net)} className="bg-sky-500 hover:bg-sky-600 text-white text-xs rounded-lg px-3 py-1.5">
                                  Record Payment
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <p className="text-slate-400 text-xs mt-3">Advances are expenses tagged to an employee in the selected month. Recording a payment creates a Salary expense (so it hits the P&L) and marks the month paid — so don't also enter salaries manually.</p>
                </div>
              </div>
            )}

            {/* Casual Pay view */}
            {hrView === 'casual' && (
              <div className="space-y-4">
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">Start Date</label>
                      <input type="date" value={casualRange.start} onChange={(e) => setCasualRange({ ...casualRange, start: e.target.value })} className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm" />
                    </div>
                    <div>
                      <label className="text-slate-500 text-xs block mb-1">End Date</label>
                      <input type="date" value={casualRange.end} onChange={(e) => setCasualRange({ ...casualRange, end: e.target.value })} className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-2 text-sm" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-slate-500 text-xs">Casual rate per carton (KES):</span>
                    <input
                      type="number"
                      step="0.01"
                      value={casualRate || ''}
                      onChange={(e) => setCasualRate(parseFloat(e.target.value) || 0)}
                      className="w-24 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 py-1 text-sm text-right"
                      placeholder="0"
                    />
                    <button onClick={handleSaveCasualRate} className="bg-sky-500 hover:bg-sky-600 text-white text-xs rounded-lg px-3 py-1">Save</button>
                  </div>
                </div>
                <div className="bg-white border border-slate-200 rounded-xl shadow-sm p-4 md:p-6">
                  <h3 className="text-slate-700 font-semibold text-sm mb-3">Casual Pay Due</h3>
                  {(() => {
                    const pay = getCasualPay(casualRange);
                    const rows = employees.filter(e => e.category === 'casual' && pay[e.id]);
                    if (rows.length === 0) {
                      return <p className="text-slate-400 text-sm text-center py-4">No casual work recorded in this range</p>;
                    }
                    let grand = 0;
                    return (
                      <>
                        <div className="divide-y divide-slate-100">
                          {rows.map(emp => {
                            const r = pay[emp.id];
                            grand += r.pay;
                            return (
                              <div key={emp.id} className="py-3">
                                <div className="flex items-center justify-between">
                                  <p className="text-slate-900 text-sm font-medium">{emp.name}</p>
                                  <p className="text-slate-900 text-sm font-bold">KES {r.pay.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                                </div>
                                <p className="text-slate-400 text-xs mt-1">{r.days} day(s) · {r.cartons.toFixed(1)} cartons credited</p>
                              </div>
                            );
                          })}
                        </div>
                        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-200">
                          <span className="text-slate-700 font-semibold text-sm">Total Casual Pay</span>
                          <span className="text-slate-900 font-bold">KES {grand.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                        </div>
                        <button onClick={() => recordCasualPayment(casualRange)} className="mt-3 w-full bg-sky-500 hover:bg-sky-600 text-white text-sm rounded-lg px-4 py-2">
                          Record Payout for this Range
                        </button>
                      </>
                    );
                  })()}
                  <p className="text-slate-400 text-xs mt-3">Calculated from production runs: each run's total cartons split equally among the casuals on duty, × shared rate. Recording a payout logs each casual's payment and creates one Casual Labour expense (now a P&L cost). Use the date range to control what's been paid.</p>

                  {/* Payment history */}
                  {payrollPayments.filter(p => p.type === 'casual').length > 0 && (
                    <div className="mt-4 pt-3 border-t border-slate-100">
                      <h4 className="text-slate-700 font-semibold text-sm mb-2">Casual Payout History</h4>
                      <div className="space-y-1">
                        {Object.values(payrollPayments.filter(p => p.type === 'casual').reduce((acc, p) => {
                          const key = `${p.period_label}|${p.date_paid}`;
                          if (!acc[key]) acc[key] = { label: p.period_label, date: p.date_paid, total: 0 };
                          acc[key].total += Number(p.amount);
                          return acc;
                        }, {})).map((g, i) => (
                          <div key={i} className="flex justify-between text-xs text-slate-500 py-1">
                            <span>{g.label} <span className="text-slate-400">· paid {g.date}</span></span>
                            <span className="font-semibold text-slate-700">KES {g.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Invoice Detail Modal */}
        {invoiceDetail && (() => {
          const customer = state.customers.find(c => c.id === invoiceDetail.customerId);
          const balance = invoiceDetail.total - (invoiceDetail.paid || 0);
          const linkedPayments = state.payments.filter(p => p.saleId === invoiceDetail.id);
          return (
            <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={() => setInvoiceDetail(null)}>
              {/* Sized to sit alongside the customer card rather than jumping
                  from 896px to 448px when you open an invoice from it. Height
                  stays a cap, not a fixed 85vh: an invoice is a short static
                  document, so a fixed height would open a mostly empty box. */}
              <div className="bg-white rounded-xl max-w-2xl w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 md:p-6 border-b border-slate-100 sticky top-0 bg-white z-10">
                  <div>
                    <h3 className="text-slate-900 font-bold">{invoiceDetail.invoiceNumber}</h3>
                    <p className="text-slate-400 text-xs">{invoiceDetail.date}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => downloadInvoiceAsPDF(invoiceDetail)}
                      className="flex items-center gap-1.5 bg-sky-500 hover:bg-sky-600 text-white font-medium px-3 py-1.5 rounded-lg transition text-xs"
                    >
                      <Download className="w-3.5 h-3.5" /> Download / Print
                    </button>
                    <button onClick={() => setInvoiceDetail(null)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
                  </div>
                </div>
                <div className="p-4 md:p-6 space-y-4">
                  <div>
                    <p className="text-slate-500 text-xs">Customer</p>
                    <p className="text-slate-900 font-semibold">{customer?.name || 'Unknown'}</p>
                    {customer?.location && <p className="text-slate-400 text-xs">{customer.location}</p>}
                  </div>

                  <div>
                    <p className="text-slate-500 text-xs mb-2">Items</p>
                    <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                      {/* Columns, not justify-between: at the card's new width
                          three spread spans drift to opposite edges and stop
                          reading as a line item. */}
                      {invoiceDetail.items.map((item, i) => (
                        <div key={i} className="grid grid-cols-[1fr_auto_9rem] gap-3 items-center p-2.5 text-sm">
                          <span className="text-slate-700">{SIZE_LABELS[item.size] || item.size}</span>
                          <span className="text-slate-500 text-xs whitespace-nowrap">{item.quantity} × {item.price}</span>
                          <span className="text-slate-900 font-medium text-right">KES {(item.subtotal || item.quantity * item.price).toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-3 space-y-1 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">Total</span><span className="text-slate-900 font-semibold">KES {invoiceDetail.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Paid</span><span className="text-emerald-600 font-semibold">KES {(invoiceDetail.paid || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">Balance</span><span className={`font-semibold ${balance > 0 ? 'text-rose-600' : 'text-emerald-600'}`}>KES {balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}</span></div>
                  </div>

                  {linkedPayments.length > 0 && (
                    <div>
                      <p className="text-slate-500 text-xs mb-2">Payments against this invoice</p>
                      <div className="divide-y divide-slate-100">
                        {linkedPayments.map(p => (
                          <div key={p.id} className="flex justify-between items-center py-2 text-sm">
                            <span className="text-slate-400 text-xs">{p.date} · {p.method}</span>
                            <span className="text-emerald-600 font-medium">KES {p.amount.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Customer Card */}
        {customerDetail !== null && (() => {
          // Looked up fresh from visibleCustomers on every render: holding the
          // ID keeps the balance live after a sale or payment, and reading from
          // the scoped list means a sales user cannot open a card for an
          // account outside their location even by stale ID.
          const customer = visibleCustomers.find(c => c.id === customerDetail);
          if (!customer) return null;

          const fmt = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const initials = (customer.name || '?').split(' ').filter(Boolean).map(w => w[0]).slice(0, 2).join('').toUpperCase();
          const owed = Math.max(0, -(customer.balance || 0));

          // visibleSales / visiblePayments, never state.*: the card must not
          // show a sales user records their own tabs would hide from them.
          const sales = visibleSales.filter(s => s.customerId === customer.id);
          const payments = visiblePayments.filter(p => p.customerId === customer.id);
          const salesNewestFirst = sales.slice().sort((a, b) =>
            (a.date < b.date ? 1 : a.date > b.date ? -1 : (b.id || 0) - (a.id || 0)));

          // Ledger: invoices are debits, payments credits, with a running
          // balance. A sale's `paid` splits into its linked payment records and
          // whatever was handed over at the till, so money is neither
          // double-counted nor dropped (same split the Cash Collected report
          // uses).
          const ledger = [];
          sales.forEach(s => {
            const items = (s.items || []).map(i => `${i.quantity}× ${SIZE_LABELS[i.size] || i.size}`).join(', ');
            ledger.push({
              date: s.date, order: 0,
              ref: s.invoiceNumber || `Sale #${s.id}`,
              desc: (s.total || 0) < 0 ? 'Credit note' : `Invoice${items ? ' · ' + items : ''}`,
              debit: s.total || 0, credit: 0,
            });
            const paidViaPayments = payments.filter(p => p.saleId === s.id).reduce((sum, p) => sum + (p.amount || 0), 0);
            const paidAtSale = (s.paid || 0) - paidViaPayments;
            if (paidAtSale > 0) {
              ledger.push({
                date: s.date, order: 1,
                ref: s.invoiceNumber || `Sale #${s.id}`,
                desc: 'Payment at point of sale', debit: 0, credit: paidAtSale,
              });
            }
          });
          payments.forEach(p => {
            ledger.push({
              date: p.date, order: 1,
              ref: p.reference || p.invoiceNumber || '',
              desc: `Payment${p.method ? ' · ' + String(p.method).replace(/_/g, ' ') : ''}`,
              debit: 0, credit: p.amount || 0,
            });
          });
          ledger.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.order - b.order));
          let runningBalance = 0;

          const closeCard = () => setCustomerDetail(null);

          return (
            <div
              className={`fixed inset-0 bg-black/50 flex items-center justify-center z-50 ${customerCardExpanded ? 'p-2 md:p-4' : 'p-4'}`}
              onClick={closeCard}
            >
              {/* Fixed height rather than max-height: the card keeps its size
                  when you switch between a short sales list and a long ledger,
                  instead of resizing under the cursor. */}
              <div
                className={`bg-white rounded-xl w-full flex flex-col ${
                  customerCardExpanded ? 'max-w-none h-[96vh]' : 'max-w-4xl h-[85vh]'
                }`}
                onClick={(e) => e.stopPropagation()}
              >

                {/* Details */}
                <div className="p-4 md:p-6 border-b border-slate-100">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="flex-shrink-0 w-12 h-12 rounded-full bg-sky-50 text-sky-600 flex items-center justify-center text-sm font-semibold">
                        {initials}
                      </div>
                      <div className="min-w-0">
                        <h3 className="text-slate-900 font-bold text-lg truncate">{customer.name}</h3>
                        <p className="text-slate-500 text-xs truncate">
                          {customer.location}{customer.phone ? ` · ${customer.phone}` : ''}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <Badge color={customer.isActive ? 'emerald' : 'rose'} dot>
                        {customer.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                      <button
                        onClick={() => setCustomerCardExpanded(v => !v)}
                        className="hidden md:block text-slate-400 hover:text-slate-700 p-1"
                        title={customerCardExpanded ? 'Shrink card' : 'Maximise card'}
                      >
                        {customerCardExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                      </button>
                      <button onClick={closeCard} className="text-slate-400 hover:text-slate-700" title="Close"><X className="w-5 h-5" /></button>
                    </div>
                  </div>

                  <div className="mt-4 flex items-baseline justify-between bg-slate-50 border border-slate-100 rounded-lg px-3 py-2">
                    <span className="text-slate-500 text-xs">{owed > 0 ? 'Outstanding balance' : 'Balance'}</span>
                    <span className={`text-lg font-bold ${owed > 0 ? 'text-rose-600' : 'text-slate-900'}`}>
                      KES {fmt(owed > 0 ? owed : Math.abs(customer.balance || 0))}
                      {owed > 0 ? '' : (customer.balance || 0) > 0 ? ' in credit' : ''}
                    </span>
                  </div>
                </div>

                {/* Actions */}
                <div className="px-4 md:px-6 py-3 border-b border-slate-100 flex flex-wrap gap-2">
                  {/* Consignment shops are invoiced through Report Sold, which
                      is why the sale picker hides them — offering New Sale here
                      would only lead to a rejection at save. */}
                  {!customer.is_consignee && (
                    <button
                      onClick={() => handleAddSaleForCustomer(customer)}
                      className="flex items-center gap-1.5 bg-sky-500 hover:bg-sky-600 text-white font-medium px-3 py-1.5 rounded-lg transition text-xs"
                    >
                      <Plus className="w-3.5 h-3.5" /> New Sale
                    </button>
                  )}
                  <button
                    onClick={() => handleAddPaymentForCustomer(customer)}
                    className="flex items-center gap-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition text-xs"
                  >
                    <Wallet className="w-3.5 h-3.5" /> Record Payment
                  </button>
                  <button
                    onClick={() => downloadAccountStatementAsPDF(customer)}
                    className="flex items-center gap-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition text-xs"
                  >
                    <Download className="w-3.5 h-3.5" /> Statement
                  </button>
                  <button
                    onClick={() => {
                      setEditingCustomer(customer);
                      setModalType('customer');
                      setFormData(customer);
                      setCustomerDetail(null);
                      setShowModal(true);
                    }}
                    className="flex items-center gap-1.5 bg-white hover:bg-slate-100 border border-slate-300 text-slate-700 font-medium px-3 py-1.5 rounded-lg transition text-xs"
                  >
                    <Edit2 className="w-3.5 h-3.5" /> Edit
                  </button>
                  {customer.is_consignee && (
                    <p className="w-full text-slate-400 text-xs mt-1">
                      Consignment shop — record what it sells under Inventory → Consignment → Report Sold.
                    </p>
                  )}
                </div>

                {/* Tabs */}
                <div className="px-4 md:px-6 pt-3 flex gap-4 border-b border-slate-100">
                  {[['sales', `Sales History (${sales.length})`], ['ledger', 'Ledger Entries']].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setCustomerCardTab(key)}
                      className={`pb-2 text-sm font-medium transition border-b-2 ${
                        customerCardTab === key
                          ? 'border-sky-500 text-slate-900'
                          : 'border-transparent text-slate-400 hover:text-slate-600'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Sales history — rows open the existing invoice card */}
                <div className="overflow-y-auto p-4 md:p-6">
                  {customerCardTab === 'sales' && (
                    salesNewestFirst.length === 0 ? (
                      <p className="text-slate-400 text-sm text-center py-8">No sales recorded for this customer yet.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 border border-slate-200 rounded-lg">
                        {salesNewestFirst.map(s => {
                          const outstanding = Math.round(((s.total || 0) - (s.paid || 0)) * 100) / 100;
                          const label = outstanding <= 0 ? 'Paid' : (s.paid || 0) > 0 ? 'Part paid' : 'Unpaid';
                          const colour = outstanding <= 0 ? 'emerald' : (s.paid || 0) > 0 ? 'amber' : 'rose';
                          return (
                            <button
                              key={s.id}
                              onClick={() => { setCustomerDetail(null); setInvoiceDetail(s); }}
                              className="w-full text-left px-3 py-2.5 hover:bg-slate-50 transition flex items-center justify-between gap-3"
                            >
                              <div className="min-w-0">
                                <p className="text-slate-900 text-sm font-medium truncate">{s.invoiceNumber || `Sale #${s.id}`}</p>
                                <p className="text-slate-400 text-xs">{s.date}</p>
                              </div>
                              <div className="flex items-center gap-3 flex-shrink-0">
                                <div className="text-right">
                                  <p className="text-slate-900 text-sm font-semibold">KES {fmt(s.total)}</p>
                                  {outstanding > 0 && <p className="text-rose-600 text-xs">KES {fmt(outstanding)} owing</p>}
                                </div>
                                <Badge color={colour}>{label}</Badge>
                                <ChevronRight className="w-4 h-4 text-slate-300" />
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )
                  )}

                  {customerCardTab === 'ledger' && (
                    ledger.length === 0 ? (
                      <p className="text-slate-400 text-sm text-center py-8">No transactions on this account yet.</p>
                    ) : (
                      <>
                        <div className="overflow-x-auto border border-slate-200 rounded-lg">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="bg-slate-50 text-slate-500 text-left">
                                <th className="font-medium px-3 py-2">Date</th>
                                <th className="font-medium px-3 py-2">Reference</th>
                                <th className="font-medium px-3 py-2">Description</th>
                                <th className="font-medium px-3 py-2 text-right">Charge</th>
                                <th className="font-medium px-3 py-2 text-right">Paid</th>
                                <th className="font-medium px-3 py-2 text-right">Balance</th>
                              </tr>
                            </thead>
                            <tbody>
                              {ledger.map((e, i) => {
                                runningBalance += e.debit - e.credit;
                                return (
                                  <tr key={i} className="border-t border-slate-100">
                                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{e.date || '—'}</td>
                                    <td className="px-3 py-2 text-slate-600">{e.ref || '—'}</td>
                                    <td className="px-3 py-2 text-slate-600">{e.desc}</td>
                                    <td className="px-3 py-2 text-right text-slate-900">{e.debit ? fmt(e.debit) : '—'}</td>
                                    <td className="px-3 py-2 text-right text-emerald-600">{e.credit ? fmt(e.credit) : '—'}</td>
                                    <td className="px-3 py-2 text-right font-semibold text-slate-900">{fmt(runningBalance)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                        <p className="text-slate-400 text-xs mt-2">
                          Every invoice and payment on this account, oldest first. The closing balance is what the customer owes today.
                        </p>
                      </>
                    )
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* Dashboard Card Breakdown Modal */}
        {breakdownCard && (() => {
          // Sales and costs breakdowns are month-to-date, matching the cards.
          const monthPrefix = localMonthPrefix();
          const inMonth = (d) => (d || '').slice(0, 7) === monthPrefix;
          const monthSales = state.sales.filter(s => inMonth(s.date));
          const monthExpenses = state.expenses.filter(e => inMonth(e.date));
          const monthExpensesTotal = monthExpenses.reduce((sum, e) => sum + e.amount, 0);
          const monthPurchasesTotal = state.purchases.filter(p => inMonth(p.date)).reduce((sum, p) => sum + p.totalAmount, 0);
          return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setBreakdownCard(null)}>
            <div className="bg-white border border-slate-300 rounded-xl p-5 md:p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-slate-900 font-bold text-lg capitalize">
                  {breakdownCard === 'customers' && 'All Customers'}
                  {breakdownCard === 'debt' && 'Outstanding Debts'}
                  {breakdownCard === 'sales' && "This Month's Sales"}
                  {breakdownCard === 'costs' && "This Month's Costs"}
                </h3>
                <button onClick={() => setBreakdownCard(null)} className="text-slate-500 hover:text-slate-900">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Customers breakdown */}
              {breakdownCard === 'customers' && (
                <div className="space-y-2">
                  {state.customers.length === 0 ? (
                    <p className="text-slate-500 text-center py-4 text-sm">No customers</p>
                  ) : state.customers.map(c => (
                    <div key={c.id} className="flex justify-between items-center p-2 bg-slate-50 rounded text-sm">
                      <div>
                        <p className="text-slate-900">{c.name}</p>
                        <p className="text-slate-500 text-xs">{c.location} · {c.phone}</p>
                      </div>
                      <span className={c.balance < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                        KES {c.balance.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Debt breakdown */}
              {breakdownCard === 'debt' && (
                <div className="space-y-2">
                  {state.customers.filter(c => c.balance < 0).length === 0 ? (
                    <p className="text-slate-500 text-center py-4 text-sm">No outstanding debts</p>
                  ) : state.customers.filter(c => c.balance < 0).map(c => (
                    <div key={c.id} className="flex justify-between items-center p-2 bg-slate-50 rounded text-sm">
                      <div>
                        <p className="text-slate-900">{c.name}</p>
                        <p className="text-slate-500 text-xs">{c.location} · {c.phone}</p>
                      </div>
                      <span className="text-rose-600 font-semibold">KES {Math.abs(c.balance).toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="flex justify-between p-2 bg-rose-50 rounded border border-rose-200 mt-2 text-sm">
                    <span className="text-rose-600 font-semibold">Total Debt</span>
                    <span className="text-rose-600 font-bold">KES {state.customers.reduce((s, c) => s + Math.max(0, -c.balance), 0).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Sales breakdown */}
              {breakdownCard === 'sales' && (
                <div className="space-y-2">
                  {monthSales.length === 0 ? (
                    <p className="text-slate-500 text-center py-4 text-sm">No sales this month</p>
                  ) : monthSales.slice().reverse().map(s => {
                    const cust = state.customers.find(c => c.id === s.customerId);
                    return (
                      <div key={s.id} className="flex justify-between items-center p-2 bg-slate-50 rounded text-sm">
                        <div>
                          <p className="text-slate-900">{s.invoiceNumber} · {cust?.name || 'Unknown'}</p>
                          <p className="text-slate-500 text-xs">{s.date} · {s.status}</p>
                        </div>
                        <span className="text-emerald-600">KES {s.total.toLocaleString()}</span>
                      </div>
                    );
                  })}
                  <div className="flex justify-between p-2 bg-emerald-50 rounded border border-emerald-200 mt-2 text-sm">
                    <span className="text-emerald-600 font-semibold">Total Sales</span>
                    <span className="text-emerald-600 font-bold">KES {monthSales.reduce((sum, s) => sum + s.total, 0).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Costs breakdown */}
              {breakdownCard === 'costs' && (
                <div className="space-y-2">
                  <div className="flex justify-between p-2 bg-slate-50 rounded text-sm">
                    <span className="text-slate-500">Total Expenses</span>
                    <span className="text-slate-900 font-semibold">KES {monthExpensesTotal.toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between p-2 bg-slate-50 rounded text-sm">
                    <span className="text-slate-500">Total Purchases</span>
                    <span className="text-slate-900 font-semibold">KES {monthPurchasesTotal.toLocaleString()}</span>
                  </div>
                  <p className="text-slate-500 text-xs font-semibold mt-3 mb-1">Expenses by Category</p>
                  {Object.entries(monthExpenses.reduce((totals, exp) => {
                    totals[exp.category] = (totals[exp.category] || 0) + exp.amount;
                    return totals;
                  }, {})).map(([cat, amt]) => (
                    <div key={cat} className="flex justify-between p-2 bg-slate-100/20 rounded text-xs">
                      <span className="text-slate-600">{cat}</span>
                      <span className="text-slate-900">KES {amt.toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="flex justify-between p-2 bg-purple-50 rounded border border-purple-200 mt-2 text-sm">
                    <span className="text-purple-600 font-semibold">Total Costs</span>
                    <span className="text-purple-600 font-bold">KES {(monthExpensesTotal + monthPurchasesTotal).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
          );
        })()}
      </main>

      {/* Modals */}
      {showModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-4 md:p-6 border-b border-slate-100 sticky top-0 bg-white">
              <h3 className="text-slate-900 font-semibold text-base md:text-lg">
                {modalType === 'sale' && 'New Sale'}
                {modalType === 'payment' && 'Record Payment'}
                {modalType === 'production' && 'Production Log'}
                {modalType === 'purchase' && (editingPurchase ? 'Edit Purchase' : 'New Purchase')}
                {modalType === 'expense' && (editingExpense ? 'Edit Expense' : 'New Expense')}
                {modalType === 'customer' && (editingCustomer ? 'Edit' : 'New Customer')}
                {modalType === 'adjust' && 'Adjust Stock'}
                {modalType === 'consignment' && formData.consignAction === 'deliver' && 'Deliver to Shop'}
                {modalType === 'consignment' && formData.consignAction === 'sold' && 'Report Stock Sold'}
                {modalType === 'consignment' && formData.consignAction === 'return' && 'Take Stock Back'}
                {modalType === 'consignment' && formData.consignAction === 'reconcile' && 'Reconcile Shop Stock'}
                {modalType === 'employee' && (editingEmployee ? 'Edit Employee' : 'New Employee')}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-slate-500 hover:text-slate-900">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 md:p-6 space-y-4">
              {/* Purchase Modal */}
              {modalType === 'purchase' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Supplier Name</label>
                    <input
                      type="text"
                      value={formData.supplier || ''}
                      onChange={(e) => setFormData({ ...formData, supplier: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="e.g., Kenya Bottle Co..."
                    />
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Purchase Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                    <h4 className="text-slate-900 font-semibold mb-3 text-sm">Materials Purchased</h4>
                    <div className="space-y-3">
                      {formData.items?.map((item, idx) => (
                        <div key={idx} className="space-y-2 p-3 bg-slate-100 rounded">
                          <div>
                            <label className="text-slate-500 text-xs block mb-1">Material</label>
                            <select
                              value={item.description || ''}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                const selected = state.rawMaterialOptions[e.target.value];
                                newItems[idx].material = selected.material;
                                newItems[idx].description = e.target.value;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1 text-sm"
                            >
                              <option value="">Select material...</option>
                              {Object.keys(state.rawMaterialOptions).map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                            {item.description && (
                              <p className="text-emerald-600 text-xs mt-1 font-semibold">✓ {item.description}</p>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="text-slate-500 text-xs block mb-1">Qty</label>
                              <input
                                type="number"
                                value={item.quantity || 0}
                                onChange={(e) => {
                                  const newItems = [...formData.items];
                                  newItems[idx].quantity = parseInt(e.target.value) || 0;
                                  newItems[idx].total = newItems[idx].quantity * newItems[idx].unitPrice;
                                  setFormData({ ...formData, items: newItems });
                                }}
                                className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1 text-sm"
                              />
                            </div>
                            <div>
                              <label className="text-slate-500 text-xs block mb-1">Unit Price</label>
                              <input
                                type="number"
                                step="0.01"
                                value={item.unitPrice || ''}
                                onChange={(e) => {
                                  const newItems = [...formData.items];
                                  newItems[idx].unitPrice = parseFloat(e.target.value) || 0;
                                  newItems[idx].total = newItems[idx].quantity * newItems[idx].unitPrice;
                                  setFormData({ ...formData, items: newItems });
                                }}
                                className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1 text-sm"
                              />
                            </div>
                            <div>
                              <p className="text-slate-500 text-xs mb-1">Total</p>
                              <p className="text-slate-900 font-semibold">KES {(item.total || 0).toLocaleString()}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => setFormData({
                        ...formData,
                        items: [...(formData.items || []), { material: '', description: '', quantity: 0, unitPrice: 0, total: 0 }]
                      })}
                      className="mt-3 text-sky-600 text-sm"
                    >
                      + Add Item
                    </button>
                  </div>

                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 md:p-4">
                    <p className="text-sky-600 text-xs">Total Purchase Amount</p>
                    <p className="text-slate-900 text-lg md:text-xl font-bold">
                      KES {(formData.items?.reduce((sum, i) => sum + (i.total || 0), 0) || 0).toLocaleString()}
                    </p>
                  </div>
                </>
              )}

              {/* Sale Modal */}
              {modalType === 'sale' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Customer</label>
                    <input
                      type="text"
                      value={saleCustomerSearch}
                      onChange={(e) => setSaleCustomerSearch(e.target.value)}
                      placeholder="Search customer by name, location, or phone..."
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm placeholder-slate-400 mb-2"
                    />
                    <div className="max-h-48 overflow-y-auto border border-slate-300 rounded-lg divide-y divide-blue-400/10">
                      {saleCustomerOptions()
                        .map(c => {
                          const selected = parseInt(formData.customerId) === c.id;
                          return (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => setFormData({ ...formData, customerId: c.id })}
                              className={`w-full text-left px-3 py-2 text-sm transition flex justify-between items-center ${
                                selected
                                  ? 'bg-sky-500/30 text-slate-900'
                                  : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                              }`}
                            >
                              <span>{c.name}</span>
                              <span className="text-xs text-slate-500">{c.location}</span>
                            </button>
                          );
                        })}
                      {saleCustomerOptions().length === 0 && (
                        <p className="text-slate-500 text-sm text-center py-3">No matching customers</p>
                      )}
                    </div>
                    {consignees().length > 0 && (
                      <p className="text-slate-500 text-xs mt-2">
                        Consignment shops are not listed here. Record what they sell under{' '}
                        <span className="font-medium">Inventory → Consignment → Report Sold</span>, so their
                        stock and debt stay correct.
                      </p>
                    )}
                    {formData.customerId && (
                      <p className="text-emerald-600 text-xs mt-2">
                        ✓ Selected: {state.customers.find(c => c.id === parseInt(formData.customerId))?.name}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                    <h4 className="text-slate-900 font-semibold mb-3 text-sm">Items</h4>
                    <div className="space-y-3">
                      {formData.items?.map((item, idx) => (
                        <div key={idx} className="grid grid-cols-4 gap-2 items-end text-xs md:text-sm">
                          <div>
                            <label className="text-slate-500 text-xs block mb-1">Size</label>
                            <select
                              value={item.size || ''}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].size = e.target.value;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1"
                            >
                              {SALE_SIZES.map(s => (
                                <option key={s} value={s}>{SIZE_LABELS[s] || s}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-slate-500 text-xs block mb-1">Qty</label>
                            <input
                              type="number"
                              value={item.quantity || 0}
                              onWheel={(e) => e.target.blur()}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].quantity = parseInt(e.target.value) || 0;
                                newItems[idx].subtotal = newItems[idx].quantity * newItems[idx].price;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1"
                            />
                          </div>
                          <div>
                            <label className="text-slate-500 text-xs block mb-1">Price</label>
                            <input
                              type="number"
                              value={item.price || 0}
                              onWheel={(e) => e.target.blur()}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].price = parseInt(e.target.value) || 0;
                                newItems[idx].subtotal = newItems[idx].quantity * newItems[idx].price;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1"
                            />
                          </div>
                          <div>
                            <p className="text-slate-500 text-xs mb-1">Sub</p>
                            <p className="text-slate-900 font-semibold">KES {(item.subtotal || 0).toLocaleString()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => setFormData({
                        ...formData,
                        items: [...(formData.items || []), { size: '0.5L', quantity: 0, price: 0, subtotal: 0 }]
                      })}
                      className="mt-3 text-sky-600 text-xs"
                    >
                      + Add
                    </button>
                  </div>

                  {(() => {
                    const saleTotal = formData.items?.reduce((sum, i) => sum + (i.subtotal || 0), 0) || 0;
                    const amountPaid = formData.amountPaid === null ? saleTotal : formData.amountPaid;
                    const balance = saleTotal - amountPaid;
                    return (
                      <>
                        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                          <p className="text-emerald-600 text-xs">Total</p>
                          <p className="text-slate-900 text-lg md:text-xl font-bold">
                            KES {saleTotal.toLocaleString()}
                          </p>
                        </div>

                        <div>
                          <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Amount Paid Now</label>
                          <input
                            type="number"
                            value={amountPaid}
                            onWheel={(e) => e.target.blur()}
                            onChange={(e) => setFormData({ ...formData, amountPaid: parseInt(e.target.value) || 0 })}
                            className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                          />
                          <p className="text-slate-400 text-xs mt-1">Defaults to the full total — reduce it for a partial or credit sale.</p>
                        </div>

                        {amountPaid > 0 && (
                          <div>
                            <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Payment Method</label>
                            <select
                              value={formData.method || 'cash'}
                              onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                            >
                              <option value="cash">Cash</option>
                              <option value="mpesa">M-Pesa</option>
                            </select>
                          </div>
                        )}

                        <div className={`rounded-lg p-3 md:p-4 border ${balance > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
                          <p className={`text-xs ${balance > 0 ? 'text-rose-600' : 'text-slate-500'}`}>Balance (Debt)</p>
                          <p className="text-slate-900 text-lg md:text-xl font-bold">
                            KES {balance.toLocaleString()}
                          </p>
                          {balance > 0 && amountPaid > 0 && (
                            <p className="text-rose-600 text-xs mt-1">Partial payment — the remainder becomes customer debt</p>
                          )}
                          {balance > 0 && amountPaid === 0 && (
                            <p className="text-rose-600 text-xs mt-1">Unpaid — the full amount becomes customer debt</p>
                          )}
                          {balance < 0 && (
                            <p className="text-rose-600 text-xs mt-1">Amount paid exceeds the sale total</p>
                          )}
                        </div>
                      </>
                    );
                  })()}
                </>
              )}

              {/* Payment Modal */}
              {modalType === 'payment' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Sale</label>
                    <input
                      type="text"
                      value={paymentSaleSearch}
                      onChange={(e) => setPaymentSaleSearch(e.target.value)}
                      placeholder="Search by customer name..."
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm placeholder-slate-400 mb-2"
                    />
                    <div className="max-h-48 overflow-y-auto border border-slate-300 rounded-lg divide-y divide-slate-100">
                      {state.sales.filter(s => s.paid < s.total).filter(s => {
                        const customer = state.customers.find(c => c.id === s.customerId);
                        const q = paymentSaleSearch.toLowerCase();
                        return !q || (customer?.name || '').toLowerCase().includes(q);
                      }).map(s => {
                        const customer = state.customers.find(c => c.id === s.customerId);
                        const balance = s.total - s.paid;
                        const selected = parseInt(formData.saleId) === s.id;
                        return (
                          <button
                            key={s.id}
                            type="button"
                            onClick={() => setFormData({ ...formData, saleId: String(s.id), amount: balance })}
                            className={`w-full text-left px-3 py-2 text-sm transition flex justify-between items-center ${
                              selected ? 'bg-sky-500/20 text-slate-900' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                            }`}
                          >
                            <span>{customer?.name || 'Unknown'} <span className="text-xs text-slate-400">({s.invoiceNumber || 'INV'})</span></span>
                            <span className="text-xs font-semibold text-rose-600">KES {balance.toLocaleString()}</span>
                          </button>
                        );
                      })}
                      {state.sales.filter(s => s.paid < s.total).filter(s => {
                        const customer = state.customers.find(c => c.id === s.customerId);
                        const q = paymentSaleSearch.toLowerCase();
                        return !q || (customer?.name || '').toLowerCase().includes(q);
                      }).length === 0 && (
                        <p className="text-slate-500 text-sm text-center py-3">No matching unpaid sales</p>
                      )}
                    </div>
                  </div>

                  {formData.saleId && (
                    <>
                      <div className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                        <p className="text-slate-500 text-xs">Balance</p>
                        <p className="text-slate-900 text-lg font-bold">
                          KES {(state.sales.find(s => s.id === parseInt(formData.saleId))?.total - state.sales.find(s => s.id === parseInt(formData.saleId))?.paid || 0).toLocaleString()}
                        </p>
                      </div>

                      <div>
                        <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Amount</label>
                        <input
                          type="number"
                          value={formData.amount || 0}
                          onChange={(e) => setFormData({ ...formData, amount: parseInt(e.target.value) || 0 })}
                          className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Method</label>
                        <select
                          value={formData.method || 'cash'}
                          onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                        >
                          <option value="cash">Cash</option>
                          <option value="bank_transfer">Bank Transfer</option>
                          <option value="cheque">Cheque</option>
                          <option value="mpesa">M-Pesa</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Reference</label>
                        <input
                          type="text"
                          value={formData.reference || ''}
                          onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                          placeholder="TRF-123"
                        />
                      </div>

                      <div>
                        <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Date</label>
                        <input
                          type="date"
                          value={formData.date || ''}
                          onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                          className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                        />
                      </div>
                    </>
                  )}
                </>
              )}

              {/* Production Modal */}
              {modalType === 'production' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                    <p className="text-emerald-600 text-xs md:text-sm font-semibold">📦 All production measured in CARTONS</p>
                    <p className="text-emerald-600 text-xs mt-1">Raw materials automatically deducted in bottles</p>
                  </div>

                  <div className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                    <h4 className="text-slate-900 font-semibold mb-3 text-sm">Production Items (in CARTONS)</h4>
                    <div className="space-y-3">
                      {['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill'].map(size => {
                        const bottlesPerCarton = BOTTLES_PER_CARTON[size];
                        const unitLabel = (size.includes('18.9L')) ? 'units' : 'cartons';
                        return (
                          <div key={size} className="flex items-center gap-2 text-xs md:text-sm bg-slate-50 p-2 rounded">
                            <label className="text-slate-500 w-32">{SIZE_LABELS[size] || size}</label>
                            <input
                              type="number"
                              min="0"
                              value={formData.items?.[size] || 0}
                              onChange={(e) => setFormData({
                                ...formData,
                                items: { ...formData.items, [size]: parseInt(e.target.value) || 0 }
                              })}
                              className="flex-1 bg-slate-100 border border-slate-300 text-slate-900 rounded px-2 py-1"
                            />
                            <span className="text-emerald-600 text-xs font-semibold w-16 text-right">{unitLabel}</span>
                            <span className="text-slate-500 text-xs w-32">({bottlesPerCarton} bottles/carton)</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Casuals on duty (Stage C) */}
                  <div className="bg-slate-50 rounded-lg p-3 md:p-4 border border-slate-100">
                    <h4 className="text-slate-900 font-semibold mb-1 text-sm">Casuals on Duty</h4>
                    <p className="text-slate-400 text-xs mb-3">Select casuals who worked this run. Total cartons are split equally among them for pay.</p>
                    {employees.filter(e => e.category === 'casual' && e.active).length === 0 ? (
                      <p className="text-slate-400 text-xs">No active casual employees. Add them in the HR tab.</p>
                    ) : (
                      <div className="space-y-1">
                        {employees.filter(e => e.category === 'casual' && e.active).map(emp => {
                          const selected = (formData.casuals || []).includes(emp.id);
                          return (
                            <label key={emp.id} className="flex items-center gap-2 text-sm py-1 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={selected}
                                onChange={(e) => {
                                  const current = formData.casuals || [];
                                  setFormData({
                                    ...formData,
                                    casuals: e.target.checked
                                      ? [...current, emp.id]
                                      : current.filter(id => id !== emp.id)
                                  });
                                }}
                                className="w-4 h-4"
                              />
                              <span className="text-slate-700">{emp.name}</span>
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Notes</label>
                    <textarea
                      value={formData.notes || ''}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      rows="2"
                      placeholder="Notes..."
                    />
                  </div>
                </>
              )}

              {/* Expense Modal */}
              {modalType === 'expense' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Expense Type</label>
                    <select
                      value={formData.subcategory || ''}
                      onChange={(e) => {
                        const type = e.target.value;
                        setFormData({
                          ...formData,
                          subcategory: type,
                          category: EXPENSE_TREATMENT[type] || 'operating'
                        });
                      }}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select expense type...</option>
                      <optgroup label="Operating (affects P&L)">
                        {EXPENSE_TYPES.filter(t => t.treatment === 'operating').map(t => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Purchases / COGS">
                        {EXPENSE_TYPES.filter(t => t.treatment === 'cogs').map(t => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label="Other (cash only, not in P&L)">
                        {EXPENSE_TYPES.filter(t => t.treatment === 'excluded').map(t => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                        ))}
                      </optgroup>
                    </select>
                    {formData.subcategory && (
                      <p className="text-xs mt-1 text-slate-400">
                        {EXPENSE_TREATMENT[formData.subcategory] === 'operating' && '✓ Counts as an operating expense in the P&L'}
                        {EXPENSE_TREATMENT[formData.subcategory] === 'cogs' && 'ℹ Raw material / purchase cost — not an operating expense'}
                        {EXPENSE_TREATMENT[formData.subcategory] === 'excluded' && 'ℹ Recorded for cash only — excluded from the P&L'}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Description</label>
                    <input
                      type="text"
                      value={formData.description || ''}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="e.g., Salary payment for staff..."
                    />
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Amount (KES)</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.amount || ''}
                      onChange={(e) => setFormData({ ...formData, amount: parseFloat(e.target.value) || 0 })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="0"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Salary advance to (optional)</label>
                    <select
                      value={formData.advanceEmployeeId || ''}
                      onChange={(e) => setFormData({ ...formData, advanceEmployeeId: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Not an advance</option>
                      {employees.filter(emp => emp.category === 'permanent' && emp.active).map(emp => (
                        <option key={emp.id} value={emp.id}>{emp.name}</option>
                      ))}
                    </select>
                    <p className="text-slate-400 text-xs mt-1">If this expense is a salary advance, select the employee. It will be deducted from their monthly net pay in HR.</p>
                  </div>
                </>
              )}

              {/* Customer Modal */}
              {modalType === 'customer' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Name</label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="Name..."
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Location</label>
                    <select
                      value={formData.location || ''}
                      onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select...</option>
                      {state.locations.map(loc => (
                        <option key={loc} value={loc}>{loc}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Phone</label>
                    <input
                      type="tel"
                      value={formData.phone || ''}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="0712345678"
                    />
                  </div>
                  <label className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
                    <input
                      type="checkbox"
                      checked={!!formData.is_consignee}
                      onChange={(e) => setFormData({ ...formData, is_consignee: e.target.checked })}
                      className="mt-0.5"
                    />
                    <span className="text-xs md:text-sm text-slate-700">
                      <span className="font-medium text-amber-700">Consignment shop</span> — holds our stock and pays after selling.
                      Stock is moved via the Consignment view (not recorded as a sale on delivery).
                    </span>
                  </label>
                </>
              )}

              {modalType === 'adjust' && (
                <>
                  <div className="bg-slate-50 rounded-lg p-3">
                    <p className="text-slate-900 text-sm font-semibold">{formData.itemLabel}</p>
                    <p className="text-slate-500 text-xs mt-1">Current quantity: {formData.currentQty}</p>
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">New Actual Quantity</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.newQty}
                      onChange={(e) => setFormData({ ...formData, newQty: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="Enter counted quantity"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Reason</label>
                    <select
                      value={formData.reason || ''}
                      onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select reason...</option>
                      <option value="Opening stock">Opening stock</option>
                      <option value="Stock-take correction">Stock-take correction</option>
                      <option value="Breakage / damage">Breakage / damage</option>
                      <option value="Loss / theft">Loss / theft</option>
                      <option value="Other">Other</option>
                    </select>
                  </div>
                </>
              )}

              {modalType === 'consignment' && (() => {
                const action = formData.consignAction;
                const shopId = parseInt(formData.shopId);
                const onHand = shopId ? getConsignmentOnHand(shopId) : {};
                const showPrice = action === 'sold' || action === 'reconcile';
                const showAvail = action !== 'deliver'; // show shop's current stock
                const blurb = {
                  deliver: 'Move stock from the plant to this shop. No sale or debt is recorded.',
                  sold: 'Record what the shop actually sold. This creates a sale (revenue + debt) and draws the stock down.',
                  return: 'Bring stock back from the shop to the plant. No money changes.',
                  reconcile: 'Seed stock the shop already holds and reverse the revenue/debt it was wrongly booked at.',
                }[action];
                const lineTotal = Object.entries(formData.lines || {}).reduce((sum, [size, q]) => {
                  const qty = parseFloat(q) || 0;
                  const price = parseFloat((formData.prices || {})[size]) || 0;
                  return sum + (showPrice ? qty * price : 0);
                }, 0);
                return (
                  <>
                    <div className={`rounded-lg p-3 text-xs md:text-sm ${action === 'reconcile' ? 'bg-amber-50 text-amber-800 border border-amber-200' : 'bg-slate-50 text-slate-600'}`}>
                      {blurb}
                    </div>
                    <div>
                      <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Shop</label>
                      <select
                        value={formData.shopId || ''}
                        onChange={(e) => setFormData({ ...formData, shopId: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      >
                        <option value="">Select shop...</option>
                        {consignees().map(c => (
                          <option key={c.id} value={c.id}>{c.name} — {c.location}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Date</label>
                      <input
                        type="date"
                        value={formData.date || ''}
                        onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                        className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      />
                    </div>
                    <div className="space-y-2">
                      <div className="flex text-xs text-slate-500 font-medium px-1">
                        <span className="flex-1">Size</span>
                        {showAvail && <span className="w-16 text-right">Held</span>}
                        <span className="w-20 text-right">Cartons</span>
                        {showPrice && <span className="w-24 text-right">Unit price</span>}
                      </div>
                      {Object.keys(state.finishedGoods).map(size => (
                        <div key={size} className="flex items-center gap-2">
                          <span className="flex-1 text-slate-700 text-xs md:text-sm">{SIZE_LABELS[size] || size}</span>
                          {showAvail && (
                            <span className="w-16 text-right text-slate-400 text-xs">{onHand[size] || 0}</span>
                          )}
                          <input
                            type="number"
                            min="0"
                            value={(formData.lines || {})[size] ?? ''}
                            onChange={(e) => setFormData({ ...formData, lines: { ...formData.lines, [size]: e.target.value } })}
                            className="w-20 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 py-1.5 text-sm text-right"
                            placeholder="0"
                          />
                          {showPrice && (
                            <input
                              type="number"
                              min="0"
                              value={(formData.prices || {})[size] ?? ''}
                              onChange={(e) => setFormData({ ...formData, prices: { ...formData.prices, [size]: e.target.value } })}
                              className="w-24 bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-2 py-1.5 text-sm text-right"
                              placeholder="KES"
                            />
                          )}
                        </div>
                      ))}
                    </div>

                    {showPrice && (
                      <div className="flex justify-between items-center px-1 text-sm">
                        <span className="text-slate-500">{action === 'reconcile' ? 'Debt to reverse' : 'Sale total'}</span>
                        <span className="font-bold text-slate-900">KES {lineTotal.toLocaleString()}</span>
                      </div>
                    )}

                    {action === 'sold' && (
                      <>
                        <div>
                          <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Amount paid now (leave 0 if paying later)</label>
                          <input
                            type="number"
                            min="0"
                            value={formData.amountPaid ?? ''}
                            onChange={(e) => setFormData({ ...formData, amountPaid: e.target.value })}
                            className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                            placeholder="0"
                          />
                        </div>
                        {parseFloat(formData.amountPaid) > 0 && (
                          <div>
                            <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Payment method</label>
                            <select
                              value={formData.method || 'cash'}
                              onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                            >
                              <option value="cash">Cash</option>
                              <option value="mpesa">M-Pesa</option>
                              <option value="bank">Bank</option>
                            </select>
                          </div>
                        )}
                      </>
                    )}
                  </>
                );
              })()}

              {modalType === 'employee' && (
                <>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Name</label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="Employee name"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Category</label>
                    <select
                      value={formData.category || 'permanent'}
                      onChange={(e) => setFormData({ ...formData, category: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="permanent">Permanent</option>
                      <option value="casual">Casual</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">
                      {formData.category === 'casual' ? 'Rate per Carton (KES)' : 'Monthly Salary (KES)'}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.rate || ''}
                      onChange={(e) => setFormData({ ...formData, rate: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="0.00"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Phone (optional)</label>
                    <input
                      type="text"
                      value={formData.phone || ''}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="07..."
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      id="emp-active"
                      checked={formData.active !== false}
                      onChange={(e) => setFormData({ ...formData, active: e.target.checked })}
                      className="w-4 h-4"
                    />
                    <label htmlFor="emp-active" className="text-slate-600 text-sm">Active</label>
                  </div>
                </>
              )}
            </div>

            <div className="flex gap-2 md:gap-3 p-4 md:p-6 border-t border-slate-100 bg-white sticky bottom-0">
              <button
                onClick={() => setShowModal(false)}
                disabled={saving}
                className="flex-1 px-3 md:px-4 py-2 border border-slate-300 text-slate-500 rounded-lg hover:bg-slate-50 transition text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              {/* Every save in the app funnels through this one button, so the
                  double-submit guard lives here rather than in nine handlers.
                  `runSave` refuses a second tap while the first is still in
                  flight; `disabled` is what the user sees, but the ref inside
                  runSave is what actually enforces it. */}
              <button
                onClick={() => runSave(async () => {
                  if (modalType === 'sale') await handleSaveSale();
                  else if (modalType === 'payment') await handleSavePayment();
                  else if (modalType === 'production') await handleSaveProduction();
                  else if (modalType === 'purchase') await handleSavePurchase();
                  else if (modalType === 'expense') await handleSaveExpense();
                  else if (modalType === 'customer') await handleSaveCustomer();
                  else if (modalType === 'adjust') await handleStockAdjustment();
                  else if (modalType === 'consignment') await handleSaveConsignment();
                  else if (modalType === 'employee') await handleSaveEmployee();
                })}
                disabled={saving}
                className="flex-1 px-3 md:px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-lg transition flex items-center justify-center gap-2 text-sm disabled:bg-sky-300 disabled:cursor-not-allowed"
              >
                <Save className="w-4 h-4" /> {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}