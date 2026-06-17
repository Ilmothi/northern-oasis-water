import React, { useState, useEffect, useRef } from 'react';
import { BarChart3, Package, Users, DollarSign, ClipboardList, TrendingUp, Plus, Edit2, Trash2, X, Save, Download, Calendar, ShoppingCart, Wallet, Search, Filter } from 'lucide-react';
import { supabase } from './supabaseClient';

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

  customers: [
    { id: 1, name: 'Loglogo Store', location: 'Loglogo', phone: '0712345678', balance: 5000, isActive: true },
    { id: 2, name: 'Marsabit Market', location: 'Marsabit', phone: '0723456789', balance: -2000, isActive: true },
    { id: 3, name: 'Laisamis Mini Shop', location: 'Laisamis', phone: '0734567890', balance: 0, isActive: true },
  ],

  sales: [
    { id: 1, customerId: 1, date: '2025-04-15', items: [{ size: '0.5L', quantity: 24, price: 100, subtotal: 2400 }], total: 2400, paid: 2400, status: 'paid', invoiceNumber: 'INV-001' },
    { id: 2, customerId: 2, date: '2025-05-01', items: [{ size: '5L', quantity: 4, price: 350, subtotal: 1400 }], total: 1400, paid: 0, status: 'pending', invoiceNumber: 'INV-002' },
    { id: 3, customerId: 1, date: '2025-05-05', items: [{ size: '1.5L', quantity: 12, price: 150, subtotal: 1800 }], total: 1800, paid: 1800, status: 'paid', invoiceNumber: 'INV-003' },
    { id: 4, customerId: 3, date: '2025-05-08', items: [{ size: '0.5L', quantity: 24, price: 100, subtotal: 2400 }], total: 2400, paid: 1200, status: 'partial', invoiceNumber: 'INV-004' },
  ],

  payments: [
    { id: 1, saleId: 1, customerId: 1, date: '2025-04-15', amount: 2400, method: 'cash', reference: 'CASH-001' },
    { id: 2, saleId: 3, customerId: 1, date: '2025-05-05', amount: 1800, method: 'bank_transfer', reference: 'TRF-12345' },
    { id: 3, saleId: 4, customerId: 3, date: '2025-05-08', amount: 1200, method: 'cash', reference: 'CASH-002' },
  ],

  productionLogs: [
    { id: 1, date: '2025-04-25', items: { '0.5L': 576, '1.5L': 360, '5L': 40 }, unit: 'bottles', notes: 'Morning shift' },
    { id: 2, date: '2025-04-27', items: { '0.5L': 480, '1.5L': 240, '18.9L_disposable': 5 }, unit: 'bottles', notes: 'Afternoon shift' },
  ],

  purchases: [
    { id: 1, date: '2025-04-25', supplier: 'Kenya Bottle Co', items: [{ material: 'emptyBottles_0.5L', description: 'Empty Bottles 0.5L', quantity: 2000, unitPrice: 4, total: 8000 }], totalAmount: 8000, status: 'received' },
    { id: 2, date: '2025-04-28', supplier: 'Packaging Ltd', items: [{ material: 'overwraps', description: 'Overwraps', quantity: 5000, unitPrice: 1, total: 5000 }], totalAmount: 5000, status: 'received' },
  ],

  expenses: [
    { id: 1, date: '2025-04-20', category: 'Raw Materials', subcategory: 'Empty Bottles', description: 'Bulk order 0.5L bottles', amount: 5000 },
    { id: 2, date: '2025-04-22', category: 'Labour', subcategory: 'Salaries', description: 'Monthly salaries - April', amount: 25000 },
    { id: 3, date: '2025-04-25', category: 'Operations', subcategory: 'Electricity', description: 'Electricity bill', amount: 3500 },
  ],

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

const BOTTLE_PRICES = {
  '0.5L': 100,
  '1.5L': 150,
  '5L': 350,
  '18.9L_disposable': 650,
  '18.9L_refill': 600,
  'refill_10L': 50,
  'refill_15L': 75,
  'refill_20L': 100
};

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
  // Purchases / COGS — recorded, not operating
  { name: 'Bottles Costs', treatment: 'cogs' },
  { name: 'Labels Costs', treatment: 'cogs' },
  { name: 'KRA Stamp Costs', treatment: 'cogs' },
  { name: 'Overwraps Costs', treatment: 'cogs' },
  { name: 'Excise Duty', treatment: 'cogs' },
  { name: 'Seals Expenses', treatment: 'cogs' },
  // Excluded from P&L — cash tracking only
  { name: 'Casual Labour', treatment: 'operating' },
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
  const [dateRange, setDateRange] = useState({ start: '', end: '' });
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerStatusFilter, setCustomerStatusFilter] = useState('all'); // all | active | inactive
  const [saleCustomerSearch, setSaleCustomerSearch] = useState('');
  const [paymentSaleSearch, setPaymentSaleSearch] = useState('');
  const [salesFilterDate, setSalesFilterDate] = useState('');
  const [salesSearch, setSalesSearch] = useState('');
  const [paymentsSearch, setPaymentsSearch] = useState('');
  const [debtsSearch, setDebtsSearch] = useState('');
  const [invoiceDetail, setInvoiceDetail] = useState(null);
  const [breakdownCard, setBreakdownCard] = useState(null);
  const [cartonCosts, setCartonCosts] = useState({});
  const [employees, setEmployees] = useState([]);
  const [editingEmployee, setEditingEmployee] = useState(null);
  const [hrView, setHrView] = useState('registry');
  const [hrMonth, setHrMonth] = useState(new Date().toISOString().slice(0, 7));
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
    } catch (error) {
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

  // Expenses aren't tied to a customer/location, so keep them as own-records for sales
  const visibleExpenses = role === 'sales'
    ? state.expenses.filter(e => e.created_by === myUserId)
    : state.expenses;

  // Customers visible to a sales user (for the debts list): their location only,
  // or all of their own debtors if no location set. Admin/manager see all.
  const visibleCustomers = role !== 'sales'
    ? state.customers
    : myLocation
      ? state.customers.filter(c => c.location === myLocation)
      : state.customers;

  // Load data from Supabase on app start — ONCE per login.
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

  // Persist inventory (raw materials + finished goods) to Supabase whenever
  // it changes — but only after the initial load, so we don't overwrite the
  // saved data with the hardcoded defaults before it's loaded.
  const inventorySaveReady = useRef(false);
  useEffect(() => {
    if (!hasLoadedData.current) return; // wait until initial load done
    if (!inventorySaveReady.current) {
      // skip the very first run right after load
      inventorySaveReady.current = true;
      return;
    }
    const saveInventory = async () => {
      try {
        await supabase.from('inventory_state').upsert([
          { id: 'rawMaterials', data: state.rawMaterials, updated_at: new Date().toISOString() },
          { id: 'finishedGoods', data: state.finishedGoods, updated_at: new Date().toISOString() }
        ]);
      } catch (e) {
        console.error('❌ Error saving inventory:', e);
      }
    };
    saveInventory();
  }, [state.rawMaterials, state.finishedGoods]);

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

      setState(prev => ({
        ...prev,
        ...(customersData?.length > 0 && { customers: customersData }),
        ...(salesData?.length > 0 && { sales: salesData }),
        ...(paymentsData?.length > 0 && { payments: paymentsData }),
      }));

      // Tier 2: admin + manager — operational records, fetched in parallel
      if (isAdminOrManager) {
        const [
          { data: expensesData },
          { data: purchasesData },
          { data: prodData },
        ] = await Promise.all([
          supabase.from('expenses').select('*'),
          supabase.from('purchases').select('*'),
          supabase.from('production_logs').select('*'),
        ]);

        setState(prev => ({
          ...prev,
          ...(expensesData?.length > 0 && { expenses: expensesData }),
          ...(purchasesData?.length > 0 && { purchases: purchasesData }),
          ...(prodData?.length > 0 && { productionLogs: prodData }),
        }));
      }

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
        }
      } catch {
        console.log('No saved inventory yet');
      }

      console.log('✅ Data loaded from Supabase successfully');
    } catch (error) {
      console.error('❌ Error loading data from Supabase:', error);
    }
  };

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

  // Finished goods valued at admin-entered cost per carton (0 if not set)
  const calculateFinishedGoodsValue = () => {
    let total = 0;
    Object.entries(state.finishedGoods).forEach(([size, data]) => {
      const costPerCarton = cartonCosts[size] || 0;
      total += data.quantity * costPerCarton;
    });
    return total;
  };

  const getTotalExpensesByCategory = () => {
    const totals = {};
    state.expenses.forEach(exp => {
      totals[exp.category] = (totals[exp.category] || 0) + exp.amount;
    });
    return totals;
  };

  const getTotalExpenses = () => {
    return state.expenses.reduce((sum, exp) => sum + exp.amount, 0);
  };

  const getTotalPurchases = () => {
    return state.purchases.reduce((sum, p) => sum + p.totalAmount, 0);
  };

  // Purchase Management
  const handleAddPurchase = () => {
    setEditingPurchase(null);
    setModalType('purchase');
    setFormData({
      date: new Date().toISOString().split('T')[0],
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

  // Does a casual date range overlap any already-paid casual period?
  const casualRangeOverlaps = (range) => {
    if (!range.start || !range.end) return false;
    return payrollPayments.some(p =>
      p.type === 'casual' && p.period_start && p.period_end &&
      !(range.end < p.period_start || range.start > p.period_end)
    );
  };

  // Record a permanent salary payment: logs it AND creates a Salary expense.
  const recordSalaryPayment = async (emp, month, netAmount) => {
    if (netAmount <= 0) { alert('Nothing to pay for this month.'); return; }
    if (isSalaryPaid(emp.id, month)) { alert('Salary already recorded for this employee this month.'); return; }
    if (!confirm(`Record salary payment of KES ${netAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })} for ${emp.name} (${month})? This also creates a Salary expense.`)) return;

    const datePaid = new Date().toISOString().split('T')[0];
    const newExpense = {
      id: Math.max(...state.expenses.map(e => e.id), 0) + 1,
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
    setState({ ...state, expenses: [...state.expenses, newExpense] });
    try {
      await supabase.from('expenses').insert([newExpense]);
      const { data } = await supabase.from('payroll_payments').insert([{ ...payment, expense_id: newExpense.id }]).select();
      if (data && data[0]) setPayrollPayments([...payrollPayments, data[0]]);
      alert('Salary payment recorded.');
    } catch (err) {
      console.error('❌ Error recording salary payment:', err);
      alert('Error recording payment.');
    }
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

    const datePaid = new Date().toISOString().split('T')[0];
    const rangeLabel = `${range.start} to ${range.end}`;
    const newExpense = {
      id: Math.max(...state.expenses.map(e => e.id), 0) + 1,
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

    const updatedLogs = state.productionLogs.map(log =>
      paidRunIds.includes(log.id) ? { ...log, casual_paid: true, casual_expense_id: newExpense.id } : log
    );

    setState({ ...state, expenses: [...state.expenses, newExpense], productionLogs: updatedLogs });

    const paymentRows = rows.map(e => ({
      type: 'casual', employee_id: e.id, employee_name: e.name,
      period_label: rangeLabel, period_start: range.start, period_end: range.end,
      amount: pay[e.id].pay, date_paid: datePaid, expense_id: newExpense.id
    }));
    try {
      await supabase.from('expenses').insert([newExpense]);
      const { data } = await supabase.from('payroll_payments').insert(paymentRows).select();
      if (data) setPayrollPayments([...payrollPayments, ...data]);
      // Persist the paid flag on each production run
      for (const runId of paidRunIds) {
        await supabase.from('production_logs').update({ casual_paid: true, casual_expense_id: newExpense.id }).eq('id', runId);
      }
      alert('Casual payout recorded.');
    } catch (err) {
      console.error('❌ Error recording casual payment:', err);
      alert('Error recording payout.');
    }
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
    try {
      if (editingEmployee) {
        await supabase.from('employees').update(payload).eq('id', editingEmployee.id);
        setEmployees(employees.map(e => e.id === editingEmployee.id ? { ...e, ...payload } : e));
      } else {
        const { data } = await supabase.from('employees').insert([payload]).select();
        if (data && data[0]) setEmployees([...employees, data[0]]);
      }
      setShowModal(false);
      setEditingEmployee(null);
    } catch (err) {
      console.error('❌ Error saving employee:', err);
      alert('Error saving employee. Please try again.');
    }
  };

  const handleDeleteEmployee = (id) => {
    if (!confirm('Remove this employee?')) return;
    setEmployees(employees.filter(e => e.id !== id));
    (async () => {
      try {
        await supabase.from('employees').delete().eq('id', id);
      } catch (err) {
        console.error('❌ Error deleting employee:', err);
      }
    })();
  };

  const handleSaveCasualRate = async () => {
    try {
      const merged = { ...cartonCosts, casual_rate: casualRate };
      await supabase.from('cost_settings').update({
        costs: merged,
        updated_at: new Date().toISOString()
      }).eq('id', 1);
      setCartonCosts(merged);
      alert('Casual rate saved');
    } catch (error) {
      console.error('❌ Error saving casual rate:', error);
      alert('Error saving casual rate.');
    }
  };

  const handleSaveCartonCosts = async () => {
    try {
      await supabase.from('cost_settings').update({
        costs: cartonCosts,
        updated_at: new Date().toISOString()
      }).eq('id', 1);
      console.log('✅ Carton costs saved to Supabase');
      alert('Costs saved successfully');
    } catch (error) {
      console.error('❌ Error saving costs:', error);
      alert('Error saving costs. Please try again.');
    }
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

  const handleStockAdjustment = () => {
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

    const updatedRaw = JSON.parse(JSON.stringify(state.rawMaterials));
    const updatedFG = JSON.parse(JSON.stringify(state.finishedGoods));
    let oldQty = 0;
    let label = '';

    if (itemId.startsWith('rm:')) {
      const parts = itemId.split(':');
      if (parts.length === 3) {
        const [, cat, key] = parts;
        oldQty = updatedRaw[cat][key];
        updatedRaw[cat][key] = qty;
        label = `${cat} ${key}`;
      } else {
        const [, simpleKey] = parts;
        oldQty = updatedRaw[simpleKey];
        updatedRaw[simpleKey] = qty;
        label = simpleKey;
      }
    } else if (itemId.startsWith('fg:')) {
      const size = itemId.replace('fg:', '');
      oldQty = updatedFG[size].quantity;
      updatedFG[size].quantity = qty;
      label = `Finished Goods ${size}`;
    }

    setState({ ...state, rawMaterials: updatedRaw, finishedGoods: updatedFG });

    // Log the adjustment to Supabase
    (async () => {
      try {
        await supabase.from('stock_adjustments').insert([{
          item: label,
          old_qty: oldQty,
          new_qty: qty,
          reason: reason || '',
          adjusted_by: userProfile?.email || '',
          date: new Date().toISOString()
        }]);
        console.log('✅ Stock adjustment saved');
      } catch (e) {
        console.error('❌ Error saving adjustment:', e);
      }
    })();

    setShowModal(false);
    alert(`Updated ${label}: ${oldQty} → ${qty}`);
  };

  const handleSavePurchase = () => {
    if (!formData.supplier || !formData.date || formData.items.filter(i => i.material && i.quantity > 0).length === 0) {
      alert('Please fill supplier, date, and add items');
      return;
    }

    const validItems = formData.items.filter(i => i.material && i.quantity > 0);
    const totalAmount = validItems.reduce((sum, i) => sum + i.total, 0);

    if (editingPurchase) {
      const updatedPurchases = state.purchases.map(p =>
        p.id === editingPurchase.id ? { ...editingPurchase, ...formData, items: validItems, totalAmount } : p
      );
      setState({ ...state, purchases: updatedPurchases });

      (async () => {
        try {
          await supabase.from('purchases').update({
            date: formData.date,
            supplier: formData.supplier,
            items: validItems,
            totalAmount
          }).eq('id', editingPurchase.id);
          console.log('✅ Purchase updated in Supabase');
        } catch (error) {
          console.error('❌ Error updating purchase:', error);
        }
      })();
    } else {
      const newPurchase = {
        id: Math.max(...state.purchases.map(p => p.id), 0) + 1,
        date: formData.date,
        supplier: formData.supplier,
        items: validItems,
        totalAmount,
        status: 'received'
      };

      // Update raw materials
      const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
      validItems.forEach(item => {
        const [category, subcategory] = item.material.split('_');
        
        if (category === 'emptyBottles') {
          const size = item.material.replace('emptyBottles_', '');
          if (updatedRawMaterials.emptyBottles[size]) {
            updatedRawMaterials.emptyBottles[size] += item.quantity;
          }
        } else if (category === 'seals') {
          const type = item.material.replace('seals_', '');
          if (updatedRawMaterials.seals[type]) {
            updatedRawMaterials.seals[type] += item.quantity;
          }
        } else if (category === 'labels') {
          const size = item.material.replace('labels_', '');
          if (updatedRawMaterials.labels[size]) {
            updatedRawMaterials.labels[size] += item.quantity;
          }
        } else if (category === 'caps') {
          const size = item.material.replace('caps_', '');
          if (updatedRawMaterials.caps && updatedRawMaterials.caps[size] != null) {
            updatedRawMaterials.caps[size] += item.quantity;
          }
        } else if (category === 'overwraps') {
          const size = item.material.replace('overwraps_', '');
          if (updatedRawMaterials.overwraps[size] != null) {
            updatedRawMaterials.overwraps[size] += item.quantity;
          }
        } else if (updatedRawMaterials[category]) {
          updatedRawMaterials[category] += item.quantity;
        }
      });

      setState({
        ...state,
        purchases: [...state.purchases, newPurchase],
        rawMaterials: updatedRawMaterials
      });

      (async () => {
        try {
          await supabase.from('purchases').insert([newPurchase]);
          console.log('✅ Purchase saved to Supabase');
        } catch (error) {
          console.error('❌ Error saving purchase:', error);
        }
      })();
    }

    setShowModal(false);
  };

  const handleDeletePurchase = (id) => {
    const purchase = state.purchases.find(p => p.id === id);
    if (!purchase) return;
    if (!confirm('Delete this purchase? The materials it added will be removed from inventory. This cannot be undone.')) return;

    // Reverse the inventory that this purchase added
    const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
    (purchase.items || []).forEach(item => {
      if (!item.material) return;
      const category = item.material.split('_')[0];

      if (category === 'emptyBottles') {
        const size = item.material.replace('emptyBottles_', '');
        if (updatedRawMaterials.emptyBottles[size] != null) {
          updatedRawMaterials.emptyBottles[size] -= item.quantity;
        }
      } else if (category === 'seals') {
        const type = item.material.replace('seals_', '');
        if (updatedRawMaterials.seals[type] != null) {
          updatedRawMaterials.seals[type] -= item.quantity;
        }
      } else if (category === 'labels') {
        const size = item.material.replace('labels_', '');
        if (updatedRawMaterials.labels[size] != null) {
          updatedRawMaterials.labels[size] -= item.quantity;
        }
      } else if (category === 'caps') {
        const size = item.material.replace('caps_', '');
        if (updatedRawMaterials.caps && updatedRawMaterials.caps[size] != null) {
          updatedRawMaterials.caps[size] -= item.quantity;
        }
      } else if (category === 'overwraps') {
        const size = item.material.replace('overwraps_', '');
        if (updatedRawMaterials.overwraps[size] != null) {
          updatedRawMaterials.overwraps[size] -= item.quantity;
        }
      } else if (updatedRawMaterials[item.material] != null) {
        // simple categories like kraStamps, roChemical
        updatedRawMaterials[item.material] -= item.quantity;
      }
    });

    setState({
      ...state,
      purchases: state.purchases.filter(p => p.id !== id),
      rawMaterials: updatedRawMaterials
    });

    // Remove from Supabase
    (async () => {
      try {
        await supabase.from('purchases').delete().eq('id', id);
        console.log('✅ Purchase deleted and inventory reversed');
      } catch (error) {
        console.error('❌ Error deleting purchase:', error);
      }
    })();
  };

  // Report Generators
  const generateAgingDebtorsReport = () => {
    const today = new Date();
    const debtors = state.customers.filter(c => c.balance < 0).map(c => {
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
      data: debtors,
      byLocation,
      total: debtors.reduce((sum, d) => sum + d.debt, 0)
    };
  };

  const generateSalesReport = () => {
    let filteredSales = state.sales;
    if (dateRange.start && dateRange.end) {
      filteredSales = state.sales.filter(s => s.date >= dateRange.start && s.date <= dateRange.end);
    }

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
      period: dateRange.start ? `${dateRange.start} to ${dateRange.end}` : 'All Time',
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
    const inPeriod = (d) => {
      if (!dateRange.start || !dateRange.end) return true;
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
      period: dateRange.start ? `${dateRange.start} to ${dateRange.end}` : 'All Time',
      cashSalesTotal,
      debtPaymentsTotal,
      totalCollected: cashSalesTotal + debtPaymentsTotal,
      cashSalesList: cashSalesList.sort((a, b) => new Date(b.date) - new Date(a.date)),
      debtPaymentsList: debtPaymentsList.sort((a, b) => new Date(b.date) - new Date(a.date))
    };
  };

  const generateExpenseReport = () => {
    let filtered = state.expenses;
    if (dateRange.start && dateRange.end) {
      filtered = state.expenses.filter(e => e.date >= dateRange.start && e.date <= dateRange.end);
    }

    const totalExpenses = filtered.reduce((sum, e) => sum + e.amount, 0);
    const byType = {};       // group by the actual expense type (subcategory)
    let operatingTotal = 0, cogsTotal = 0, excludedTotal = 0;
    filtered.forEach(e => {
      const type = e.subcategory || 'Other';
      byType[type] = (byType[type] || 0) + e.amount;
      const treatment = EXPENSE_TREATMENT[e.subcategory] || e.category || 'operating';
      if (treatment === 'operating') operatingTotal += e.amount;
      else if (treatment === 'cogs') cogsTotal += e.amount;
      else excludedTotal += e.amount;
    });

    return {
      title: 'Expense Report',
      date: new Date().toLocaleDateString(),
      period: dateRange.start ? `${dateRange.start} to ${dateRange.end}` : 'All Time',
      totalExpenses,
      byCategory: byType,
      operatingTotal,
      cogsTotal,
      excludedTotal,
      expenses: filtered.slice().sort((a, b) => new Date(b.date) - new Date(a.date))
    };
  };

  const generateProfitLossReport = () => {
    const inPeriod = (d) => {
      if (!dateRange.start || !dateRange.end) return true;
      return d >= dateRange.start && d <= dateRange.end;
    };

    const periodSales = state.sales.filter(s => inPeriod(s.date));
    const periodExpenses = state.expenses.filter(e => inPeriod(e.date));

    // Sales revenue in period
    const totalRevenue = periodSales.reduce((sum, s) => sum + s.total, 0);

    // COGS = cartons sold × cost per carton (carton cost already includes
    // casual labour and overtime). Counts only what was actually sold.
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
    periodExpenses.forEach(e => {
      // Treatment comes from the expense type; fall back to the stored category
      // (which we now set to the treatment), then default to operating for old records.
      const treatment = EXPENSE_TREATMENT[e.subcategory] || e.category || 'operating';
      if (treatment === 'operating') {
        operatingExpenses += e.amount;
        const key = e.subcategory || 'Other';
        operatingBreakdown[key] = (operatingBreakdown[key] || 0) + e.amount;
      } else if (treatment === 'cogs') {
        cogsExpenses += e.amount;
      } else {
        excludedExpenses += e.amount;
      }
    });

    const netProfit = grossProfit - operatingExpenses;

    return {
      title: 'Profit & Loss Statement',
      date: new Date().toLocaleDateString(),
      period: dateRange.start ? `${dateRange.start} to ${dateRange.end}` : 'All Time',
      revenue: totalRevenue,
      cogs,
      grossProfit,
      grossMargin: totalRevenue > 0 ? ((grossProfit / totalRevenue) * 100).toFixed(1) : 0,
      operatingExpenses,
      operatingBreakdown,
      cogsExpenses,
      excludedExpenses,
      netProfit,
      netMargin: totalRevenue > 0 ? ((netProfit / totalRevenue) * 100).toFixed(1) : 0
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
        </div>
    `;

    // Add report-specific content
    if (reportType === 'aging') {
      htmlContent += `<div class="section">`;
      Object.entries(reportData.byLocation)
        .sort((a, b) => b[1].total - a[1].total)
        .forEach(([location, group]) => {
          htmlContent += `
            <h2>${location} — KES ${group.total.toLocaleString('en-US', { minimumFractionDigits: 2 })}</h2>
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
                <td>${d.name}</td>
                <td>KES ${d.debt.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                <td>${d.daysOverdue}</td>
                <td>${d.phone || '-'}</td>
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
                <td>${location}</td>
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
            <thead><tr><th>Date</th><th>Invoice</th><th>Customer</th><th>Amount</th></tr></thead>
            <tbody>
      `;
      if (reportData.cashSalesList.length === 0) {
        htmlContent += `<tr><td colspan="4">None in this period</td></tr>`;
      }
      reportData.cashSalesList.forEach(c => {
        htmlContent += `<tr><td>${c.date}</td><td>${c.invoice}</td><td>${c.customer}</td><td>KES ${c.amount.toLocaleString()}</td></tr>`;
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
      reportData.debtPaymentsList.forEach(p => {
        htmlContent += `<tr><td>${p.date}</td><td>${p.customer}</td><td>${p.method}</td><td>KES ${p.amount.toLocaleString()}</td></tr>`;
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
                <th>Type</th>
                <th>Treatment</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
      `;
      Object.entries(reportData.byCategory).forEach(([type, amount]) => {
        htmlContent += `
              <tr>
                <td>${type}</td>
                <td>${EXPENSE_TREATMENT[type] || 'operating'}</td>
                <td>KES ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
              </tr>
        `;
      });
      htmlContent += `
            </tbody>
          </table>
        </div>
      `;
    } else if (reportType === 'profitloss') {
      let opRows = '';
      Object.entries(reportData.operatingBreakdown).forEach(([k, v]) => {
        opRows += `<tr><td style="padding-left:20px;">${k}</td><td>KES ${v.toLocaleString()}</td></tr>`;
      });
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
          </table>
          <p style="font-size:11px;color:#666;margin-top:10px;">COGS is based on cartons sold × cost per carton (includes casual labour). Raw material purchases and casual/overtime pay are not counted again as operating expenses.</p>
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
      try { printWindow.focus(); printWindow.print(); } catch (e) {}
    }, 500);
  };

  // Expense Management
  const handleAddExpense = () => {
    setEditingExpense(null);
    setModalType('expense');
    setFormData({ 
      date: new Date().toISOString().split('T')[0],
      category: 'Raw Materials',
      subcategory: '',
      description: '',
      amount: 0
    });
    setShowModal(true);
  };

  const handleSaveExpense = () => {
    if (!formData.category || !formData.subcategory || formData.amount <= 0) {
      alert('Please fill all fields');
      return;
    }

    const advanceId = formData.advanceEmployeeId ? parseInt(formData.advanceEmployeeId) : null;

    if (editingExpense) {
      const updated = { ...editingExpense, ...formData, amount: parseFloat(formData.amount), advance_employee_id: advanceId };
      const updatedExpenses = state.expenses.map(e =>
        e.id === editingExpense.id ? updated : e
      );
      setState({ ...state, expenses: updatedExpenses });

      const saveToSupabase = async () => {
        try {
          await supabase
            .from('expenses')
            .update({
              date: formData.date,
              category: formData.category,
              subcategory: formData.subcategory,
              description: formData.description || '',
              amount: parseFloat(formData.amount),
              advance_employee_id: advanceId
            })
            .eq('id', editingExpense.id);
          console.log('✅ Expense updated in Supabase');
        } catch (error) {
          console.error('❌ Error updating expense:', error);
        }
      };
      saveToSupabase();
    } else {
      const newExpense = {
        id: Math.max(...state.expenses.map(e => e.id), 0) + 1,
        date: formData.date,
        category: formData.category,
        subcategory: formData.subcategory,
        description: formData.description || '',
        amount: parseFloat(formData.amount),
        advance_employee_id: advanceId,
        created_by: session?.user?.id || null
      };
      setState({ ...state, expenses: [...state.expenses, newExpense] });

      const saveToSupabase = async () => {
        try {
          await supabase.from('expenses').insert([newExpense]);
          console.log('✅ Expense saved to Supabase');
        } catch (error) {
          console.error('❌ Error saving expense:', error);
        }
      };
      saveToSupabase();
    }
    setShowModal(false);
  };

  const handleDeleteExpense = (id) => {
    if (confirm('Delete this expense?')) {
      // If this expense was created by a payroll payment, remove those payment
      // records too, so salary "Paid" status and casual history stay accurate.
      const linkedPayments = payrollPayments.filter(p => p.expense_id === id);
      if (linkedPayments.length > 0) {
        setPayrollPayments(payrollPayments.filter(p => p.expense_id !== id));
      }
      // If this was a casual payout, un-flag the production runs it paid for,
      // so they return to "Pay Due".
      const runsToUnflag = state.productionLogs.filter(log => log.casual_expense_id === id).map(log => log.id);
      const updatedLogs = runsToUnflag.length > 0
        ? state.productionLogs.map(log => log.casual_expense_id === id ? { ...log, casual_paid: false, casual_expense_id: null } : log)
        : state.productionLogs;

      setState({
        ...state,
        expenses: state.expenses.filter(e => e.id !== id),
        productionLogs: updatedLogs
      });
      // Remove from Supabase
      (async () => {
        try {
          await supabase.from('expenses').delete().eq('id', id);
          if (linkedPayments.length > 0) {
            await supabase.from('payroll_payments').delete().eq('expense_id', id);
          }
          for (const runId of runsToUnflag) {
            await supabase.from('production_logs').update({ casual_paid: false, casual_expense_id: null }).eq('id', runId);
          }
          console.log('✅ Expense deleted from Supabase');
        } catch (error) {
          console.error('❌ Error deleting expense:', error);
        }
      })();
    }
  };

  // Delete Sale — reverses inventory deduction and customer debt
  const handleDeleteSale = (id) => {
    const sale = state.sales.find(s => s.id === id);
    if (!sale) return;

    const linkedPayments = state.payments.filter(p => p.saleId === id);
    let confirmMsg = `Delete sale ${sale.invoiceNumber}? This will return the stock to inventory`;
    if (sale.paid > 0 || linkedPayments.length > 0) {
      confirmMsg += ` and remove ${linkedPayments.length} linked payment(s)`;
    }
    confirmMsg += '. This cannot be undone.';
    if (!confirm(confirmMsg)) return;

    // 1. Return cartons to finished goods
    const updatedFinishedGoods = { ...state.finishedGoods };
    sale.items.forEach(item => {
      if (updatedFinishedGoods[item.size]) {
        updatedFinishedGoods[item.size] = {
          ...updatedFinishedGoods[item.size],
          quantity: updatedFinishedGoods[item.size].quantity + item.quantity
        };
      }
    });

    // 2. Reverse customer balance:
    //    Original sale reduced balance by the unpaid amount (debt).
    //    Payments later increased the balance back. Net effect to undo:
    //    add back the debt (total - paid) that is still outstanding,
    //    and remove the effect of the payments too.
    //    Simplest correct approach: undo the net = -(total) + (paid)
    //    i.e. balance should increase by (total - paid) when we remove the sale,
    //    then removing payments would subtract (paid). Net: +total - paid - paid... 
    //    To avoid confusion we recompute: removing the sale cancels the original
    //    debit of (total - originalPaidAtCreation) AND we remove all linked payments
    //    which had credited (sum of payments). Net balance change = +(total - paid).
    const outstanding = sale.total - sale.paid;
    const updatedCustomers = state.customers.map(c =>
      c.id === sale.customerId
        ? { ...c, balance: c.balance + outstanding }
        : c
    );

    // 3. Remove the sale and any linked payments from state
    const updatedSales = state.sales.filter(s => s.id !== id);
    const updatedPayments = state.payments.filter(p => p.saleId !== id);

    setState({
      ...state,
      sales: updatedSales,
      payments: updatedPayments,
      finishedGoods: updatedFinishedGoods,
      customers: updatedCustomers
    });

    // 4. Reflect all of this in Supabase
    (async () => {
      try {
        await supabase.from('payments').delete().eq('saleId', id);
        await supabase.from('sales').delete().eq('id', id);
        const cust = updatedCustomers.find(c => c.id === sale.customerId);
        if (cust) {
          await supabase.from('customers').update({ balance: cust.balance }).eq('id', cust.id);
        }
        console.log('✅ Sale deleted and reversed in Supabase');
      } catch (error) {
        console.error('❌ Error deleting sale:', error);
      }
    })();
  };

  // Delete Production Log — returns finished goods and restores raw materials
  const handleDeleteProduction = (id) => {
    const log = state.productionLogs.find(p => p.id === id);
    if (!log) return;
    if (!confirm('Delete this production log? This will reverse the raw materials used and the finished goods produced. This cannot be undone.')) return;

    const updatedRawMaterials = JSON.parse(JSON.stringify(state.rawMaterials));
    const updatedFinishedGoods = JSON.parse(JSON.stringify(state.finishedGoods));

    Object.entries(log.items).forEach(([size, cartonsProduced]) => {
      if (!cartonsProduced) return;
      const bottlesPerCarton = BOTTLES_PER_CARTON[size];
      const bottlesProduced = cartonsProduced * bottlesPerCarton;

      // Restore empty bottles
      if (size === '0.5L') updatedRawMaterials.emptyBottles['0.5L'] += bottlesProduced;
      else if (size === '1.5L') updatedRawMaterials.emptyBottles['1.5L'] += bottlesProduced;
      else if (size === '5L') updatedRawMaterials.emptyBottles['5L'] += bottlesProduced;
      else if (size === '18.9L_disposable') updatedRawMaterials.emptyBottles['18.9L_disposable'] += cartonsProduced;
      else if (size === '18.9L_refill') updatedRawMaterials.emptyBottles['18.9L_refill'] += cartonsProduced;

      // Restore seals (5L and 18.9L here; short neck handled below)
      if (size === '5L') updatedRawMaterials.seals['5L'] += bottlesProduced;
      else if (size === '18.9L_disposable' || size === '18.9L_refill') updatedRawMaterials.seals['18.9L'] += cartonsProduced;

      // Restore labels
      if (size === '0.5L') updatedRawMaterials.labels['0.5L'] += bottlesProduced;
      else if (size === '1.5L') updatedRawMaterials.labels['1.5L'] += bottlesProduced;
      else if (size === '5L') updatedRawMaterials.labels['5L'] += bottlesProduced;
      else if (size === '18.9L_disposable' || size === '18.9L_refill') updatedRawMaterials.labels['18.9L'] += cartonsProduced;

      // Restore caps (18.9L only)
      if (size === '18.9L_disposable' || size === '18.9L_refill') {
        if (updatedRawMaterials.caps && updatedRawMaterials.caps['18.9L'] != null) {
          updatedRawMaterials.caps['18.9L'] += cartonsProduced;
        }
      }

      // Restore overwraps (by size)
      if (updatedRawMaterials.overwraps[size] !== undefined) {
        updatedRawMaterials.overwraps[size] += cartonsProduced;
      }

      // Restore KRA stamps
      updatedRawMaterials.kraStamps += cartonsProduced;

      // Restore RO chemical
      updatedRawMaterials.roChemical += (bottlesProduced / 1000);

      // Remove the produced finished goods
      if (updatedFinishedGoods[size]) {
        updatedFinishedGoods[size].quantity -= cartonsProduced;
      }
    });

    // Restore combined short neck seals (0.5L + 1.5L)
    const totalShortNeckBottles =
      ((log.items['0.5L'] || 0) * BOTTLES_PER_CARTON['0.5L']) +
      ((log.items['1.5L'] || 0) * BOTTLES_PER_CARTON['1.5L']);
    if (totalShortNeckBottles > 0) {
      updatedRawMaterials.seals['short_neck'] += totalShortNeckBottles;
    }

    setState({
      ...state,
      productionLogs: state.productionLogs.filter(p => p.id !== id),
      rawMaterials: updatedRawMaterials,
      finishedGoods: updatedFinishedGoods
    });

    (async () => {
      try {
        await supabase.from('production_logs').delete().eq('id', id);
        console.log('✅ Production log deleted and reversed in Supabase');
      } catch (error) {
        console.error('❌ Error deleting production log:', error);
      }
    })();
  };

  // Add Sale
  const handleAddSale = () => {
    setModalType('sale');
    setSaleCustomerSearch('');
    setFormData({ 
      customerId: '', 
      items: [{ size: '0.5L', quantity: 0, price: 100 }],
      date: new Date().toISOString().split('T')[0],
      paymentStatus: 'unpaid'
    });
    setShowModal(true);
  };

  const handleSaveSale = () => {
    if (!formData.customerId || formData.items.filter(i => i.quantity > 0).length === 0) {
      alert('Please select customer and add items');
      return;
    }

    const customer = state.customers.find(c => c.id === parseInt(formData.customerId));

    // Use prices as entered manually - NO auto-pricing
    const validItems = formData.items.filter(i => i.quantity > 0).map(item => ({
      ...item
      // Price stays as entered by user - no auto-lookup
    }));

    const total = validItems.reduce((sum, i) => sum + (i.quantity * i.price), 0);
    const isPaid = formData.paymentStatus === 'paid';
    
    const newSale = {
      id: Math.max(...state.sales.map(s => s.id), 0) + 1,
      customerId: parseInt(formData.customerId),
      date: formData.date,
      items: validItems,
      total,
      paid: isPaid ? total : 0,
      status: isPaid ? 'paid' : 'pending',
      invoiceNumber: `INV-${String(Math.max(...state.sales.map(s => parseInt(s.invoiceNumber?.split('-')[1] || 0)), 0) + 1).padStart(3, '0')}`,
      created_by: session?.user?.id || null
    };

    const updatedFinishedGoods = { ...state.finishedGoods };
    validItems.forEach(item => {
      // Items already come in CARTONS from sales input
      // No conversion needed - just deduct directly
      if (updatedFinishedGoods[item.size]) {
        updatedFinishedGoods[item.size].quantity -= item.quantity;
      }
    });

    const debtAmount = isPaid ? 0 : total;
    const updatedCustomers = state.customers.map(c => 
      c.id === parseInt(formData.customerId) 
        ? { ...c, balance: c.balance - debtAmount }
        : c
    );

    setState({
      ...state,
      sales: [...state.sales, newSale],
      finishedGoods: updatedFinishedGoods,
      customers: updatedCustomers
    });

    // Save to Supabase (STEP 7D)
    const saveToSupabase = async () => {
      try {
        await supabase.from('sales').insert([newSale]);
        await supabase
          .from('customers')
          .update({ balance: updatedCustomers.find(c => c.id === parseInt(formData.customerId)).balance })
          .eq('id', parseInt(formData.customerId));
        console.log('✅ Sale saved to Supabase');
      } catch (error) {
        console.error('❌ Error saving sale to Supabase:', error);
      }
    };
    saveToSupabase();

    setShowModal(false);
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
    setFormData({ saleId: '', amount: 0, method: 'cash', reference: '', date: new Date().toISOString().split('T')[0] });
    setShowModal(true);
  };

  const handleSavePayment = () => {
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

    const newPayment = {
      id: Math.max(...state.payments.map(p => p.id), 0) + 1,
      saleId: parseInt(formData.saleId),
      customerId: sale.customerId,
      date: formData.date,
      amount: formData.amount,
      method: formData.method,
      reference: formData.reference,
      created_by: session?.user?.id || null
    };

    const newSalesState = state.sales.map(s => {
      if (s.id === parseInt(formData.saleId)) {
        const newPaid = s.paid + formData.amount;
        return {
          ...s,
          paid: newPaid,
          status: newPaid >= s.total ? 'paid' : 'partial'
        };
      }
      return s;
    });

    const updatedCustomers = state.customers.map(c => {
      if (c.id === sale.customerId) {
        return { ...c, balance: c.balance + formData.amount };
      }
      return c;
    });

    setState({
      ...state,
      payments: [...state.payments, newPayment],
      sales: newSalesState,
      customers: updatedCustomers
    });

    // Save to Supabase
    const savePaymentToSupabase = async () => {
      try {
        await supabase.from('payments').insert([newPayment]);
        const updatedSale = newSalesState.find(s => s.id === parseInt(formData.saleId));
        await supabase.from('sales').update({ paid: updatedSale.paid, status: updatedSale.status }).eq('id', updatedSale.id);
        const updatedCust = updatedCustomers.find(c => c.id === sale.customerId);
        await supabase.from('customers').update({ balance: updatedCust.balance }).eq('id', updatedCust.id);
        console.log('✅ Payment saved to Supabase');
      } catch (error) {
        console.error('❌ Error saving payment:', error);
      }
    };
    savePaymentToSupabase();

    setShowModal(false);
  };

  // Production
  const handleAddProduction = () => {
    setModalType('production');
    setFormData({ items: {}, date: new Date().toISOString().split('T')[0], notes: '', unit: 'cartons', casuals: [] });
    setShowModal(true);
  };

  const handleSaveProduction = () => {
    if (Object.keys(formData.items).length === 0) {
      alert('Please add items');
      return;
    }

    // Input is in CARTONS for all sizes
    const newProduction = {
      id: Math.max(...state.productionLogs.map(p => p.id), 0) + 1,
      date: formData.date,
      items: formData.items, // Cartons produced
      unit: 'cartons', // Always cartons
      notes: formData.notes,
      casuals: formData.casuals || []
    };

    const updatedRawMaterials = { ...state.rawMaterials };
    const updatedFinishedGoods = { ...state.finishedGoods };

    Object.entries(formData.items).forEach(([size, cartonsProduced]) => {
      if (cartonsProduced === 0) return;
      
      // cartonsProduced is in CARTONS
      const bottlesPerCarton = BOTTLES_PER_CARTON[size];
      
      // Calculate bottles needed from raw materials
      const bottlesNeeded = cartonsProduced * bottlesPerCarton;

      // ===== DEDUCT EMPTY BOTTLES (based on size) =====
      if (size === '0.5L') updatedRawMaterials.emptyBottles['0.5L'] -= bottlesNeeded;
      else if (size === '1.5L') updatedRawMaterials.emptyBottles['1.5L'] -= bottlesNeeded;
      else if (size === '5L') updatedRawMaterials.emptyBottles['5L'] -= bottlesNeeded;
      else if (size === '18.9L_disposable') updatedRawMaterials.emptyBottles['18.9L_disposable'] -= cartonsProduced;
      else if (size === '18.9L_refill') updatedRawMaterials.emptyBottles['18.9L_refill'] -= cartonsProduced;

      // ===== DEDUCT SEALS =====
      // 0.5L and 1.5L both use SHORT NECK seals - add both and deduct once
      if (size === '0.5L') {
        // Will be handled below when we sum both 0.5L and 1.5L
      } else if (size === '1.5L') {
        // Will be handled below when we sum both 0.5L and 1.5L
      } else if (size === '5L') {
        updatedRawMaterials.seals['5L'] -= bottlesNeeded;
      } else if (size === '18.9L_disposable' || size === '18.9L_refill') {
        updatedRawMaterials.seals['18.9L'] -= cartonsProduced;
      }

      // ===== DEDUCT LABELS (based on size) =====
      if (size === '0.5L') updatedRawMaterials.labels['0.5L'] -= bottlesNeeded;
      else if (size === '1.5L') updatedRawMaterials.labels['1.5L'] -= bottlesNeeded;
      else if (size === '5L') updatedRawMaterials.labels['5L'] -= bottlesNeeded;
      else if (size === '18.9L_disposable' || size === '18.9L_refill') updatedRawMaterials.labels['18.9L'] -= cartonsProduced;

      // ===== DEDUCT CAPS (18.9L only — both disposable and refill) =====
      if (size === '18.9L_disposable' || size === '18.9L_refill') {
        if (updatedRawMaterials.caps && updatedRawMaterials.caps['18.9L'] != null) {
          updatedRawMaterials.caps['18.9L'] -= cartonsProduced;
        }
      }

      // ===== DEDUCT OVERWRAPS (per carton, BY SIZE) =====
      if (updatedRawMaterials.overwraps[size]) {
        updatedRawMaterials.overwraps[size] -= cartonsProduced;
      }

      // ===== DEDUCT KRA STAMPS (per carton) =====
      updatedRawMaterials.kraStamps -= cartonsProduced;

      // ===== DEDUCT RO CHEMICAL (based on bottles) =====
      updatedRawMaterials.roChemical -= (bottlesNeeded / 1000);

      // ===== INCREASE FINISHED GOODS (in CARTONS) =====
      if (updatedFinishedGoods[size]) {
        updatedFinishedGoods[size].quantity += cartonsProduced;
      }
    });

    // ===== DEDUCT COMBINED SHORT NECK SEALS (for both 0.5L and 1.5L) =====
    const totalShortNeckBottles = 
      ((formData.items['0.5L'] || 0) * BOTTLES_PER_CARTON['0.5L']) +
      ((formData.items['1.5L'] || 0) * BOTTLES_PER_CARTON['1.5L']);
    
    if (totalShortNeckBottles > 0) {
      updatedRawMaterials.seals['short_neck'] -= totalShortNeckBottles;
    }

    setState({
      ...state,
      productionLogs: [...state.productionLogs, newProduction],
      rawMaterials: updatedRawMaterials,
      finishedGoods: updatedFinishedGoods
    });

    // Persist the production log to Supabase
    (async () => {
      try {
        await supabase.from('production_logs').insert([newProduction]);
        console.log('✅ Production log saved to Supabase');
      } catch (error) {
        console.error('❌ Error saving production log:', error);
      }
    })();

    setShowModal(false);
  };

  // Customer Management
  const handleAddCustomer = () => {
    setEditingCustomer(null);
    setModalType('customer');
    setFormData({ name: '', location: '', phone: '' });
    setShowModal(true);
  };

  const handleSaveCustomer = () => {
    if (!formData.name || !formData.location || !formData.phone) {
      alert('Please fill in all fields');
      return;
    }

    if (editingCustomer) {
      const updatedCustomers = state.customers.map(c =>
        c.id === editingCustomer.id ? { ...c, ...formData } : c
      );
      setState({ ...state, customers: updatedCustomers });

      // Save to Supabase
      const saveToSupabase = async () => {
        try {
          await supabase
            .from('customers')
            .update(formData)
            .eq('id', editingCustomer.id);
          console.log('✅ Customer updated in Supabase');
        } catch (error) {
          console.error('❌ Error updating customer:', error);
        }
      };
      saveToSupabase();
    } else {
      const newCustomer = {
        id: Math.max(...state.customers.map(c => c.id), 0) + 1,
        ...formData,
        balance: 0,
        isActive: true
      };
      setState({ ...state, customers: [...state.customers, newCustomer] });

      // Save to Supabase
      const saveToSupabase = async () => {
        try {
          await supabase.from('customers').insert([newCustomer]);
          console.log('✅ Customer saved to Supabase');
        } catch (error) {
          console.error('❌ Error saving customer:', error);
        }
      };
      saveToSupabase();
    }
    setShowModal(false);
  };

  const handleDeleteCustomer = (id) => {
    if (confirm('Delete this customer?')) {
      setState({
        ...state,
        customers: state.customers.filter(c => c.id !== id)
      });
    }
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
                  <p className="text-lg md:text-2xl font-bold text-sky-600">KES {(calculateInventoryValue() + calculateFinishedGoodsValue()).toLocaleString()}</p>
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
            { id: 'sales', label: 'Sales History', roles: ['admin', 'manager', 'sales'] },
            { id: 'payments', label: 'Payments', roles: ['admin', 'manager', 'sales'] },
          ]},
          { id: 'inventory', label: 'Inventory', icon: Package, tabs: [
            { id: 'inventory', label: 'Raw Stock', roles: ['admin', 'manager', 'sales'] },
            { id: 'production', label: 'Production', roles: ['admin', 'manager', 'sales'] },
            { id: 'purchases', label: 'Purchases', roles: ['admin', 'manager'] },
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
          const now = new Date();
          const monthPrefix = now.toISOString().slice(0, 7); // YYYY-MM
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

        {activeTab === 'dashboard' && (
          <div className="space-y-4 md:space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
              {[
                { id: 'customers', label: 'Customers', value: state.customers.length.toLocaleString(), accent: 'sky', icon: Users, sub: 'total accounts' },
                { id: 'debt', label: 'Outstanding Debts', value: `KES ${state.customers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'rose', icon: Wallet, sub: 'across debtors' },
                { id: 'sales', label: 'Sales', value: `KES ${state.sales.reduce((sum, s) => sum + s.total, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'emerald', icon: DollarSign, sub: 'total sales' },
                { id: 'costs', label: 'Operating Costs', value: `KES ${(getTotalExpenses() + getTotalPurchases()).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, accent: 'amber', icon: ShoppingCart, sub: 'expenses + purchases' },
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
        )}

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
                label="Total Purchased"
                value={`KES ${getTotalPurchases().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={ShoppingCart}
                accent="sky"
              />
              <StatCard
                label="Purchase Count"
                value={state.purchases.length.toLocaleString()}
                icon={ClipboardList}
                accent="slate"
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
                            <button
                              onClick={() => handleDeletePurchase(purchase.id)}
                              className="p-1 hover:bg-rose-50 rounded transition"
                            >
                              <Trash2 className="w-3 h-3 text-rose-600" />
                            </button>
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

            {/* Date Range — applies to all event-based reports */}
            {(reportType === 'sales' || reportType === 'cash' || reportType === 'expense' || reportType === 'profitloss') && (
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
                      title="Clear dates (show all time)"
                    >
                      All Time
                    </button>
                  </div>
                </div>
                <p className="text-slate-500 text-xs mt-2">
                  {dateRange.start && dateRange.end ? `Showing: ${dateRange.start} to ${dateRange.end}` : 'Showing: All Time (set dates to filter)'}
                </p>
              </div>
            )}

            {/* Report Display */}
            {reportData && (
              <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4 md:mb-6">
                  <div>
                    <h3 className="text-slate-900 font-semibold text-base md:text-xl">{reportData.title}</h3>
                    <p className="text-slate-500 text-xs md:text-sm">Generated: {reportData.date}</p>
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
                      <p className="text-slate-500 text-center py-4 md:py-8 text-sm">No debtors</p>
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
                            <p className="text-sky-600 font-bold text-sm mb-2">{location}</p>
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
                      {reportData.cashSalesList.length === 0 ? (
                        <p className="text-slate-500 text-xs py-2">None in this period</p>
                      ) : reportData.cashSalesList.map((c, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 border-b border-slate-100">
                          <span className="text-slate-600">{c.date} · {c.invoice} · {c.customer}</span>
                          <span className="text-emerald-600">KES {c.amount.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>

                    <div className="bg-slate-50 rounded-lg p-3 md:p-4">
                      <h4 className="text-slate-900 font-semibold mb-2 text-sm">Debt Payments Received</h4>
                      {reportData.debtPaymentsList.length === 0 ? (
                        <p className="text-slate-500 text-xs py-2">None in this period</p>
                      ) : reportData.debtPaymentsList.map((p, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 border-b border-slate-100">
                          <span className="text-slate-600">{p.date} · {p.customer}{p.method ? ` · ${p.method}` : ''}</span>
                          <span className="text-sky-600">KES {p.amount.toLocaleString()}</span>
                        </div>
                      ))}
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
                    {Object.entries(reportData.byCategory).map(([type, amount]) => (
                      <div key={type} className="flex justify-between items-center p-3 md:p-4 bg-slate-50 rounded-lg text-xs md:text-sm">
                        <p className="text-slate-500">{type} <span className="text-slate-400">· {EXPENSE_TREATMENT[type] || 'operating'}</span></p>
                        <p className="text-slate-900 font-semibold">KES {amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
                      </div>
                    ))}
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

                    {/* Net Profit */}
                    <div className={`border-2 rounded-lg p-3 md:p-4 ${reportData.netProfit >= 0 ? 'border-emerald-200 bg-emerald-50' : 'border-rose-200 bg-rose-50'}`}>
                      <p className={reportData.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}>Net Profit</p>
                      <p className={`text-2xl md:text-3xl font-bold ${reportData.netProfit >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                        KES {reportData.netProfit.toLocaleString()}
                      </p>
                      <p className="text-xs mt-2">Net margin: {reportData.netMargin}%</p>
                    </div>

                    <p className="text-slate-500 text-xs">Note: COGS is based on cartons sold × cost per carton (which includes casual labour). Raw material purchases and casual/overtime pay are not counted again as operating expenses.</p>
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
                      {(role === 'admin' || role === 'manager') && (
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
              <h2 className="text-xl md:text-2xl font-bold text-slate-900">Sales</h2>
              <button
                onClick={handleAddSale}
                className="w-full md:w-auto bg-sky-500 hover:bg-sky-600 text-white font-medium px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Sale
              </button>
            </div>

            <div className="bg-white border border-slate-200 rounded-lg md:rounded-xl p-4 md:p-6">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 mb-3 md:mb-4">
                <h3 className="text-slate-900 font-semibold text-sm md:text-base">History</h3>
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

                // Day summary: cash collected vs debt (handles partial payments)
                if (salesFilterDate) {
                  const dayTotal = filtered.reduce((sum, s) => sum + s.total, 0);
                  const dayCash = filtered.reduce((sum, s) => sum + (s.paid || 0), 0);
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
                        {(role === 'admin' || role === 'manager') && (
                          <div className="flex justify-end pt-2 mt-2 border-t border-slate-100">
                            <button
                              onClick={() => handleDeleteSale(sale.id)}
                              className="flex items-center gap-1 text-xs text-rose-600 hover:text-rose-700 hover:bg-rose-50 px-2 py-1 rounded transition"
                            >
                              <Trash2 className="w-3 h-3" /> Delete
                            </button>
                          </div>
                        )}
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
                label="Total Received"
                value={`KES ${state.payments.reduce((sum, p) => sum + p.amount, 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                icon={DollarSign}
                accent="sky"
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

                            {/* Action Button */}
                            <button
                              onClick={handleAddPayment}
                              className="mt-3 w-full bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 text-emerald-700 py-2 px-3 rounded-lg transition text-sm font-semibold"
                            >
                              Record Payment
                            </button>
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
                  <input
                    type="text"
                    value={paymentsSearch}
                    onChange={(e) => setPaymentsSearch(e.target.value)}
                    placeholder="Search customer..."
                    className="bg-slate-50 border border-slate-300 text-slate-900 rounded-lg px-3 py-1.5 text-sm placeholder-slate-400"
                  />
                </div>
                <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                  {(() => {
                    const list = visiblePayments.filter(p => {
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
                          <div className="flex gap-2 text-xs text-slate-500">
                            <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">{payment.method}</span>
                            {sale ? (
                              <button onClick={() => setInvoiceDetail(sale)} className="bg-sky-50 text-sky-700 underline px-2 py-1 rounded hover:bg-sky-100 transition">{sale.invoiceNumber}</button>
                            ) : (
                              <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">N/A</span>
                            )}
                            {payment.reference && <span className="bg-slate-100 text-slate-600 px-2 py-1 rounded">Ref: {payment.reference}</span>}
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
              {Object.entries(getTotalExpensesByCategory()).map(([category, amount]) => (
                <div key={category} className="bg-amber-50 border border-amber-200 rounded-lg md:rounded-xl p-3 md:p-4">
                  <p className="text-amber-600 text-xs md:text-sm">{category}</p>
                  <p className="text-slate-900 text-lg md:text-2xl font-bold">KES {amount.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {/* Total Expenses */}
            <StatCard
              label="Total Expenses"
              value={`KES ${getTotalExpenses().toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
              icon={Wallet}
              accent="amber"
              sub="all recorded expenses"
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
                                setFormData(expense);
                                setShowModal(true);
                              }}
                              className="p-1 hover:bg-slate-100 rounded transition"
                            >
                              <Edit2 className="w-3 h-3 text-slate-500" />
                            </button>
                            <button
                              onClick={() => handleDeleteExpense(expense.id)}
                              className="p-1 hover:bg-rose-50 rounded transition"
                            >
                              <Trash2 className="w-3 h-3 text-rose-600" />
                            </button>
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
          const allCustomers = state.customers;
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
              <StatCard label="Outstanding Debt" value={`KES ${outstandingDebt.toLocaleString()}`} icon={Wallet} accent="rose" sub="owed across all accounts" />
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
                    <tr key={customer.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition">
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
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <button onClick={() => openEdit(customer)} className="p-2 hover:bg-slate-100 rounded-lg transition" title="Edit">
                            <Edit2 className="w-4 h-4 text-slate-500" />
                          </button>
                          <button onClick={() => handleDeleteCustomer(customer.id)} className="p-2 hover:bg-rose-50 rounded-lg transition" title="Delete">
                            <Trash2 className="w-4 h-4 text-rose-600" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {/* Mobile cards */}
              <div className="md:hidden divide-y divide-slate-100">
                {filtered.map(customer => (
                  <div key={customer.id} className="p-4">
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
                      <div className="flex gap-1 flex-shrink-0">
                        <button onClick={() => openEdit(customer)} className="p-2 hover:bg-slate-100 rounded-lg transition">
                          <Edit2 className="w-4 h-4 text-slate-500" />
                        </button>
                        <button onClick={() => handleDeleteCustomer(customer.id)} className="p-2 hover:bg-rose-50 rounded-lg transition">
                          <Trash2 className="w-4 h-4 text-rose-600" />
                        </button>
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
                  <span className="text-slate-500">Finished Goods (at carton cost)</span>
                  <span className="text-slate-900 font-semibold">KES {calculateFinishedGoodsValue().toLocaleString()}</span>
                </div>
                <div className="flex justify-between p-2 bg-slate-50 rounded border border-emerald-200">
                  <span className="text-emerald-600 font-semibold">Total Assets</span>
                  <span className="text-emerald-600 font-bold">KES {(calculateInventoryValue() + calculateFinishedGoodsValue()).toLocaleString()}</span>
                </div>
              </div>
              <p className="text-slate-500 text-xs mt-3">Note: Materials with no purchase recorded yet are valued at 0 until you log a purchase for them.</p>
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
              <div className="bg-white rounded-xl max-w-md w-full max-h-[85vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center justify-between p-4 md:p-6 border-b border-slate-100 sticky top-0 bg-white">
                  <div>
                    <h3 className="text-slate-900 font-bold">{invoiceDetail.invoiceNumber}</h3>
                    <p className="text-slate-400 text-xs">{invoiceDetail.date}</p>
                  </div>
                  <button onClick={() => setInvoiceDetail(null)} className="text-slate-400 hover:text-slate-700"><X className="w-5 h-5" /></button>
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
                      {invoiceDetail.items.map((item, i) => (
                        <div key={i} className="flex justify-between items-center p-2 text-sm">
                          <span className="text-slate-700">{SIZE_LABELS[item.size] || item.size}</span>
                          <span className="text-slate-500 text-xs">{item.quantity} × {item.price}</span>
                          <span className="text-slate-900 font-medium">KES {(item.subtotal || item.quantity * item.price).toLocaleString()}</span>
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

        {/* Dashboard Card Breakdown Modal */}
        {breakdownCard && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setBreakdownCard(null)}>
            <div className="bg-white border border-slate-300 rounded-xl p-5 md:p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-slate-900 font-bold text-lg capitalize">
                  {breakdownCard === 'customers' && 'All Customers'}
                  {breakdownCard === 'debt' && 'Outstanding Debts'}
                  {breakdownCard === 'sales' && 'All Sales'}
                  {breakdownCard === 'costs' && 'Cost Breakdown'}
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
                  {state.sales.length === 0 ? (
                    <p className="text-slate-500 text-center py-4 text-sm">No sales</p>
                  ) : state.sales.slice().reverse().map(s => {
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
                    <span className="text-emerald-600 font-bold">KES {state.sales.reduce((sum, s) => sum + s.total, 0).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Costs breakdown */}
              {breakdownCard === 'costs' && (
                <div className="space-y-2">
                  <div className="flex justify-between p-2 bg-slate-50 rounded text-sm">
                    <span className="text-slate-500">Total Expenses</span>
                    <span className="text-slate-900 font-semibold">KES {getTotalExpenses().toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between p-2 bg-slate-50 rounded text-sm">
                    <span className="text-slate-500">Total Purchases</span>
                    <span className="text-slate-900 font-semibold">KES {getTotalPurchases().toLocaleString()}</span>
                  </div>
                  <p className="text-slate-500 text-xs font-semibold mt-3 mb-1">Expenses by Category</p>
                  {Object.entries(getTotalExpensesByCategory()).map(([cat, amt]) => (
                    <div key={cat} className="flex justify-between p-2 bg-slate-100/20 rounded text-xs">
                      <span className="text-slate-600">{cat}</span>
                      <span className="text-slate-900">KES {amt.toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="flex justify-between p-2 bg-purple-50 rounded border border-purple-200 mt-2 text-sm">
                    <span className="text-purple-600 font-semibold">Total Costs</span>
                    <span className="text-purple-600 font-bold">KES {(getTotalExpenses() + getTotalPurchases()).toLocaleString()}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
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
                      {state.customers
                        .filter(c => {
                          const q = saleCustomerSearch.toLowerCase();
                          return !q ||
                            c.name.toLowerCase().includes(q) ||
                            (c.location || '').toLowerCase().includes(q) ||
                            (c.phone || '').includes(q);
                        })
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
                      {state.customers.filter(c => {
                        const q = saleCustomerSearch.toLowerCase();
                        return !q ||
                          c.name.toLowerCase().includes(q) ||
                          (c.location || '').toLowerCase().includes(q) ||
                          (c.phone || '').includes(q);
                      }).length === 0 && (
                        <p className="text-slate-500 text-sm text-center py-3">No matching customers</p>
                      )}
                    </div>
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

                  <div>
                    <label className="block text-slate-500 text-xs md:text-sm font-medium mb-2">Payment Status</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, paymentStatus: 'unpaid' })}
                        className={`flex-1 py-2 px-3 rounded-lg transition font-semibold text-sm ${
                          formData.paymentStatus === 'unpaid'
                            ? 'bg-red-500 text-slate-900'
                            : 'bg-slate-50 text-slate-500 border border-slate-300 hover:border-red-400/50'
                        }`}
                      >
                        ✗ UNPAID (Debt)
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, paymentStatus: 'paid' })}
                        className={`flex-1 py-2 px-3 rounded-lg transition font-semibold text-sm ${
                          formData.paymentStatus === 'paid'
                            ? 'bg-green-500 text-slate-900'
                            : 'bg-slate-50 text-slate-500 border border-slate-300 hover:border-green-400/50'
                        }`}
                      >
                        ✓ PAID
                      </button>
                    </div>
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
                                newItems[idx].price = BOTTLE_PRICES[e.target.value] || 0;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-50 border border-slate-300 text-slate-900 rounded px-2 py-1"
                            >
                              {Object.keys(BOTTLE_PRICES).map(s => (
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
                        items: [...(formData.items || []), { size: '0.5L', quantity: 0, price: 100, subtotal: 0 }]
                      })}
                      className="mt-3 text-sky-600 text-xs"
                    >
                      + Add
                    </button>
                  </div>

                  <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 md:p-4">
                    <p className="text-emerald-600 text-xs">Total</p>
                    <p className="text-slate-900 text-lg md:text-xl font-bold">
                      KES {(formData.items?.reduce((sum, i) => sum + (i.subtotal || 0), 0) || 0).toLocaleString()}
                    </p>
                  </div>
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
                className="flex-1 px-3 md:px-4 py-2 border border-slate-300 text-slate-500 rounded-lg hover:bg-slate-50 transition text-sm"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (modalType === 'sale') handleSaveSale();
                  else if (modalType === 'payment') handleSavePayment();
                  else if (modalType === 'production') handleSaveProduction();
                  else if (modalType === 'purchase') handleSavePurchase();
                  else if (modalType === 'expense') handleSaveExpense();
                  else if (modalType === 'customer') handleSaveCustomer();
                  else if (modalType === 'adjust') handleStockAdjustment();
                  else if (modalType === 'employee') handleSaveEmployee();
                }}
                className="flex-1 px-3 md:px-4 py-2 bg-sky-500 hover:bg-sky-600 text-white font-medium rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Save className="w-4 h-4" /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}