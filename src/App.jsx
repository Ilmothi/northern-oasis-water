import React, { useState, useEffect, useRef } from 'react';
import { BarChart3, Package, Users, DollarSign, ClipboardList, TrendingUp, Plus, Edit2, Trash2, X, Save, Download, Calendar, ShoppingCart } from 'lucide-react';
import { supabase } from './supabaseClient';

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
    'Overwraps': { material: 'overwraps', category: 'Overwraps' },
    'Seals - Short Neck 0.5L': { material: 'seals_short_neck_05', category: 'Seals' },
    'Seals - Short Neck 1.5L': { material: 'seals_short_neck_15', category: 'Seals' },
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
  const [saleCustomerSearch, setSaleCustomerSearch] = useState('');
  const [breakdownCard, setBreakdownCard] = useState(null);
  const [cartonCosts, setCartonCosts] = useState({});

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
        // Sales users can't see dashboard, so land them on Sales tab
        if (data.role === 'sales') {
          setActiveTab('sales');
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

  // Role-based record filtering: Sales sees only their own; Admin/Manager see all
  const myUserId = session?.user?.id;
  const visibleSales = role === 'sales'
    ? state.sales.filter(s => s.created_by === myUserId)
    : state.sales;
  const visiblePayments = role === 'sales'
    ? state.payments.filter(p => p.created_by === myUserId)
    : state.payments;
  const visibleExpenses = role === 'sales'
    ? state.expenses.filter(e => e.created_by === myUserId)
    : state.expenses;

  // Load data from Supabase on app start — ONCE per login.
  // Using a guard so silent session/token refreshes don't reload data
  // and overwrite values the user is actively editing (e.g. carton costs).
  const hasLoadedData = useRef(false);
  useEffect(() => {
    if (session && !hasLoadedData.current) {
      hasLoadedData.current = true;
      loadDataFromSupabase();
    }
    if (!session) {
      hasLoadedData.current = false;
    }
  }, [session]);

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

  const loadDataFromSupabase = async () => {
    try {
      // Load customers
      const { data: customersData } = await supabase
        .from('customers')
        .select('*');
      if (customersData && customersData.length > 0) {
        setState(prev => ({ ...prev, customers: customersData }));
      }

      // Load sales
      const { data: salesData } = await supabase
        .from('sales')
        .select('*');
      if (salesData && salesData.length > 0) {
        setState(prev => ({ ...prev, sales: salesData }));
      }

      // Load payments
      const { data: paymentsData } = await supabase
        .from('payments')
        .select('*');
      if (paymentsData && paymentsData.length > 0) {
        setState(prev => ({ ...prev, payments: paymentsData }));
      }

      // Load expenses
      const { data: expensesData } = await supabase
        .from('expenses')
        .select('*');
      if (expensesData && expensesData.length > 0) {
        setState(prev => ({ ...prev, expenses: expensesData }));
      }

      // Load purchases
      const { data: purchasesData } = await supabase
        .from('purchases')
        .select('*');
      if (purchasesData && purchasesData.length > 0) {
        setState(prev => ({ ...prev, purchases: purchasesData }));
      }

      // Load production logs
      const { data: prodData } = await supabase
        .from('production_logs')
        .select('*');
      if (prodData && prodData.length > 0) {
        setState(prev => ({ ...prev, productionLogs: prodData }));
      }

      // Load cost settings (finished-goods carton costs)
      try {
        const { data: costData } = await supabase
          .from('cost_settings')
          .select('costs')
          .eq('id', 1)
          .single();
        if (costData && costData.costs) {
          setCartonCosts(costData.costs);
        }
      } catch (e) {
        console.log('No cost settings yet');
      }

      // Load saved inventory (raw materials + finished goods)
      try {
        const { data: invData } = await supabase
          .from('inventory_state')
          .select('*');
        if (invData && invData.length > 0) {
          const rm = invData.find(r => r.id === 'rawMaterials');
          const fg = invData.find(r => r.id === 'finishedGoods');
          setState(prev => ({
            ...prev,
            rawMaterials: rm && rm.data ? rm.data : prev.rawMaterials,
            finishedGoods: fg && fg.data ? fg.data : prev.finishedGoods
          }));
        }
      } catch (e) {
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
    if (confirm('Delete this purchase?')) {
      setState({
        ...state,
        purchases: state.purchases.filter(p => p.id !== id)
      });
    }
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

    return {
      title: 'Aging Debtors Report',
      date: new Date().toLocaleDateString(),
      data: debtors,
      total: debtors.reduce((sum, d) => sum + d.debt, 0)
    };
  };

  const generateSalesReport = () => {
    let filteredSales = state.sales;
    if (dateRange.start && dateRange.end) {
      filteredSales = state.sales.filter(s => s.date >= dateRange.start && s.date <= dateRange.end);
    }

    const salesByLocation = {};
    const salesBySize = {};
    const bottlesByLocationAndSize = {};
    
    filteredSales.forEach(sale => {
      const customer = state.customers.find(c => c.id === sale.customerId);
      const location = customer?.location || 'Unknown';
      
      salesByLocation[location] = (salesByLocation[location] || 0) + sale.total;
      
      if (!bottlesByLocationAndSize[location]) {
        bottlesByLocationAndSize[location] = {};
      }
      
      sale.items.forEach(item => {
        salesBySize[item.size] = (salesBySize[item.size] || 0) + item.quantity;
        bottlesByLocationAndSize[location][item.size] = (bottlesByLocationAndSize[location][item.size] || 0) + item.quantity;
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
    const byCategory = {};
    filtered.forEach(e => {
      byCategory[e.category] = (byCategory[e.category] || 0) + e.amount;
    });

    return {
      title: 'Expense Report',
      date: new Date().toLocaleDateString(),
      period: dateRange.start ? `${dateRange.start} to ${dateRange.end}` : 'All Time',
      totalExpenses,
      byCategory,
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

    // Operating expenses = Salaries (from Labour) + all Operations.
    // Exclude Casual Pay, Overtime (in COGS), and Raw Materials (in COGS via carton cost).
    let operatingExpenses = 0;
    const operatingBreakdown = {};
    periodExpenses.forEach(e => {
      const isSalary = e.category === 'Labour' && e.subcategory === 'Salaries';
      const isOperations = e.category === 'Operations';
      if (isSalary || isOperations) {
        operatingExpenses += e.amount;
        const key = isSalary ? 'Salaries' : (e.subcategory || 'Operations');
        operatingBreakdown[key] = (operatingBreakdown[key] || 0) + e.amount;
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
      htmlContent += `
        <div class="section">
          <div class="summary">
            Total Outstanding Debt: KES ${reportData.total.toLocaleString()}
          </div>
          <table>
            <thead>
              <tr>
                <th>Customer Name</th>
                <th>Location</th>
                <th>Outstanding</th>
                <th>Days Overdue</th>
                <th>Phone</th>
              </tr>
            </thead>
            <tbody>
      `;
      reportData.data.forEach(d => {
        htmlContent += `
              <tr>
                <td>${d.name}</td>
                <td>${d.location}</td>
                <td>KES ${d.debt.toLocaleString()}</td>
                <td>${d.daysOverdue}</td>
                <td>${d.phone}</td>
              </tr>
        `;
      });
      htmlContent += `
            </tbody>
          </table>
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
            Total Expenses: KES ${reportData.totalExpenses.toLocaleString()}
          </div>
          <h2>Expenses by Category</h2>
          <table>
            <thead>
              <tr>
                <th>Category</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
      `;
      Object.entries(reportData.byCategory).forEach(([category, amount]) => {
        htmlContent += `
              <tr>
                <td>${category}</td>
                <td>KES ${amount.toLocaleString()}</td>
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

    if (editingExpense) {
      const updatedExpenses = state.expenses.map(e =>
        e.id === editingExpense.id ? { ...e, ...formData, amount: parseInt(formData.amount) } : e
      );
      setState({ ...state, expenses: updatedExpenses });

      // Save to Supabase
      const saveToSupabase = async () => {
        try {
          await supabase
            .from('expenses')
            .update({ ...formData, amount: parseInt(formData.amount) })
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
        ...formData,
        amount: parseInt(formData.amount),
        created_by: session?.user?.id || null
      };
      setState({ ...state, expenses: [...state.expenses, newExpense] });

      // Save to Supabase
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
      setState({
        ...state,
        expenses: state.expenses.filter(e => e.id !== id)
      });
      // Remove from Supabase
      (async () => {
        try {
          await supabase.from('expenses').delete().eq('id', id);
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
    setFormData({ items: {}, date: new Date().toISOString().split('T')[0], notes: '', unit: 'cartons' });
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
      notes: formData.notes
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
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 border-4 border-cyan-400 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-cyan-300 text-lg">Loading...</p>
        </div>
      </div>
    );
  }

  // ===== LOGIN SCREEN =====
  if (!session) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900 flex items-center justify-center px-4">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <div className="w-20 h-20 bg-gradient-to-br from-cyan-400 to-blue-500 rounded-full flex items-center justify-center mx-auto mb-4 shadow-lg">
              <span className="text-white text-2xl font-bold">OS</span>
            </div>
            <h1 className="text-2xl md:text-3xl font-bold text-white">Northern Water Co.</h1>
            <p className="text-cyan-300 text-sm mt-1">OASIS Springs Management System</p>
          </div>

          <div className="bg-slate-800/50 border border-blue-400/20 rounded-2xl p-6 md:p-8 shadow-xl backdrop-blur">
            <h2 className="text-white font-semibold text-lg mb-6 text-center">Sign In</h2>

            {loginError && (
              <div className="bg-red-500/20 border border-red-400/40 text-red-300 rounded-lg px-4 py-3 text-sm mb-4">
                {loginError}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label className="block text-blue-300 text-sm font-medium mb-2">Email</label>
                <input
                  type="email"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="you@example.com"
                  className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <div>
                <label className="block text-blue-300 text-sm font-medium mb-2">Password</label>
                <input
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleLogin(); }}
                  placeholder="••••••••"
                  className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-4 py-2.5 text-sm placeholder-slate-400 focus:outline-none focus:border-cyan-400"
                />
              </div>

              <button
                onClick={handleLogin}
                disabled={loggingIn || !loginEmail || !loginPassword}
                className="w-full bg-cyan-500 hover:bg-cyan-600 disabled:bg-slate-600 disabled:cursor-not-allowed text-white font-semibold rounded-lg px-4 py-2.5 text-sm transition"
              >
                {loggingIn ? 'Signing in...' : 'Sign In'}
              </button>
            </div>

            <p className="text-slate-400 text-xs text-center mt-6">
              Contact your administrator if you need an account.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-blue-900 to-slate-900">
      {/* Header */}
      <header className="border-b border-blue-400/20 bg-gradient-to-r from-slate-900 via-blue-900 to-slate-900 backdrop-blur sticky top-0 z-40 shadow-lg">
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
                <h1 className="text-lg md:text-2xl font-bold text-white truncate">Northern Water Co.</h1>
                <p className="text-cyan-300 text-xs md:text-sm truncate font-semibold">🌊 OASIS Springs - Purified Water</p>
              </div>
            </div>
            
            {/* Assets Display + User Menu */}
            <div className="flex items-center gap-3 md:gap-5">
              {role !== 'sales' && (
                <div className="text-right">
                  <p className="text-blue-400 text-xs font-semibold">Total Assets</p>
                  <p className="text-lg md:text-2xl font-bold text-cyan-300">KES {(calculateInventoryValue() + calculateFinishedGoodsValue()).toLocaleString()}</p>
                </div>
              )}
              <div className="flex items-center gap-2 md:gap-3 border-l border-blue-400/20 pl-3 md:pl-5">
                <div className="text-right hidden sm:block">
                  <p className="text-white text-xs md:text-sm font-semibold truncate max-w-[140px]">{userProfile?.email}</p>
                  <p className="text-cyan-400 text-xs capitalize">{role}</p>
                </div>
                <button
                  onClick={handleLogout}
                  className="bg-slate-700/60 hover:bg-red-500/30 border border-blue-400/20 hover:border-red-400/40 text-blue-300 hover:text-red-300 rounded-lg px-3 py-1.5 text-xs md:text-sm transition whitespace-nowrap"
                >
                  Logout
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Navigation */}
      <div className="bg-slate-800/50 border-b border-blue-400/10 sticky top-16 z-30 overflow-x-auto">
        <div className="w-full">
          <div className="flex gap-2 md:gap-8 px-4 md:px-6 min-w-max md:min-w-0">
            {[
              { id: 'dashboard', label: 'Home', icon: BarChart3, roles: ['admin', 'manager'] },
              { id: 'sales', label: 'Sales', icon: DollarSign, roles: ['admin', 'manager', 'sales'] },
              { id: 'inventory', label: 'Stocks', icon: Package, roles: ['admin', 'manager', 'sales'] },
              { id: 'purchases', label: 'Purchases', icon: ShoppingCart, roles: ['admin', 'manager'] },
              { id: 'production', label: 'Production', icon: ClipboardList, roles: ['admin', 'manager', 'sales'] },
              { id: 'payments', label: 'Payments', icon: Users, roles: ['admin', 'manager', 'sales'] },
              { id: 'expenses', label: 'Expenses', icon: DollarSign, roles: ['admin', 'manager', 'sales'] },
              { id: 'customers', label: 'Customers', icon: Users, roles: ['admin', 'manager', 'sales'] },
              { id: 'costsettings', label: 'Costs', icon: DollarSign, roles: ['admin'] },
              { id: 'adjust', label: 'Adjust', icon: Package, roles: ['admin'] },
              { id: 'reports', label: 'Reports', icon: TrendingUp, roles: ['admin', 'manager'] },
            ].filter(tab => tab.roles.includes(role)).map(tab => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-1 md:gap-2 px-2 md:px-4 py-3 md:py-4 border-b-2 transition-all whitespace-nowrap text-sm md:text-base ${
                    activeTab === tab.id
                      ? 'border-cyan-400 text-cyan-400'
                      : 'border-transparent text-blue-300 hover:text-white'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  <span className="hidden sm:inline">{tab.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="w-full px-4 md:px-6 py-4 md:py-8">
        
        {/* Dashboard */}
        {activeTab === 'dashboard' && (
          <div className="space-y-4 md:space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
              {[
                { id: 'customers', label: 'Customers', value: state.customers.length, color: 'from-blue-500 to-blue-600' },
                { id: 'debt', label: 'Debt', value: `KES ${state.customers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0).toLocaleString()}`, color: 'from-red-500 to-red-600' },
                { id: 'sales', label: 'Sales', value: `KES ${state.sales.reduce((sum, s) => sum + s.total, 0).toLocaleString()}`, color: 'from-green-500 to-green-600' },
                { id: 'costs', label: 'Costs', value: `KES ${(getTotalExpenses() + getTotalPurchases()).toLocaleString()}`, color: 'from-purple-500 to-purple-600' },
              ].map((card, i) => (
                <button
                  key={i}
                  onClick={() => setBreakdownCard(card.id)}
                  className={`bg-gradient-to-br ${card.color} rounded-lg md:rounded-xl p-3 md:p-6 text-white shadow-lg text-left hover:brightness-110 transition cursor-pointer`}
                >
                  <p className="text-xs md:text-sm opacity-90 mb-1 md:mb-2">{card.label}</p>
                  <p className="text-sm md:text-3xl font-bold break-words">{card.value}</p>
                  <p className="text-xs opacity-70 mt-1 md:mt-2">Tap for details →</p>
                </button>
              ))}
            </div>

            {/* Quick Actions */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Actions</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
                <button
                  onClick={handleAddSale}
                  className="bg-green-500/20 hover:bg-green-500/30 border border-green-500/50 text-green-300 py-2 md:py-3 rounded-lg transition flex items-center justify-center gap-1 text-xs md:text-sm"
                >
                  <Plus className="w-4 h-4" /> Sale
                </button>
                <button
                  onClick={handleAddPayment}
                  className="bg-cyan-500/20 hover:bg-cyan-500/30 border border-cyan-500/50 text-cyan-300 py-2 md:py-3 rounded-lg transition flex items-center justify-center gap-1 text-xs md:text-sm"
                >
                  <Plus className="w-4 h-4" /> Pay
                </button>
                <button
                  onClick={handleAddProduction}
                  className="bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/50 text-blue-300 py-2 md:py-3 rounded-lg transition flex items-center justify-center gap-1 text-xs md:text-sm"
                >
                  <Plus className="w-4 h-4" /> Prod
                </button>
                <button
                  onClick={handleAddPurchase}
                  className="bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-500/50 text-indigo-300 py-2 md:py-3 rounded-lg transition flex items-center justify-center gap-1 text-xs md:text-sm"
                >
                  <Plus className="w-4 h-4" /> Buy
                </button>
                <button
                  onClick={() => { setActiveTab('reports'); setReportType('aging'); handleGenerateReport('aging'); }}
                  className="bg-yellow-500/20 hover:bg-yellow-500/30 border border-yellow-500/50 text-yellow-300 py-2 md:py-3 rounded-lg transition flex items-center justify-center gap-1 text-xs md:text-sm"
                >
                  <TrendingUp className="w-4 h-4" /> Report
                </button>
              </div>
            </div>

            {/* Recent Activity */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 md:gap-6">
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Recent Sales</h3>
                <div className="space-y-2 md:space-y-3">
                  {state.sales.slice(-5).reverse().map(sale => {
                    const customer = state.customers.find(c => c.id === sale.customerId);
                    return (
                      <div key={sale.id} className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-base">
                        <div>
                          <p className="text-white font-medium truncate">{customer?.name}</p>
                          <p className="text-blue-300 text-xs">{sale.date}</p>
                        </div>
                        <p className="text-green-400 font-semibold">KES {sale.total.toLocaleString()}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Recent Purchases</h3>
                <div className="space-y-2 md:space-y-3">
                  {state.purchases.slice(-5).reverse().map(purchase => (
                    <div key={purchase.id} className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-base">
                      <div>
                        <p className="text-white font-medium truncate">{purchase.supplier}</p>
                        <p className="text-blue-300 text-xs">{purchase.date}</p>
                      </div>
                      <p className="text-indigo-400 font-semibold">KES {purchase.totalAmount.toLocaleString()}</p>
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
              <h2 className="text-xl md:text-2xl font-bold text-white">Raw Materials Purchases</h2>
              <button
                onClick={handleAddPurchase}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Purchase
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              {[
                { label: 'Total Purchased', value: `KES ${getTotalPurchases().toLocaleString()}`, color: 'from-indigo-500 to-indigo-600' },
                { label: 'Purchase Count', value: state.purchases.length, color: 'from-blue-500 to-blue-600' },
                { label: 'Current Stock Value', value: `KES ${calculateInventoryValue().toLocaleString()}`, color: 'from-cyan-500 to-cyan-600' },
              ].map((card, i) => (
                <div key={i} className={`bg-gradient-to-br ${card.color} rounded-lg md:rounded-xl p-3 md:p-6 text-white shadow-lg`}>
                  <p className="text-xs md:text-sm opacity-90 mb-1 md:mb-2">{card.label}</p>
                  <p className="text-lg md:text-3xl font-bold break-words">{card.value}</p>
                </div>
              ))}
            </div>

            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Purchase History</h3>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {state.purchases.length === 0 ? (
                  <p className="text-blue-300 text-center py-4 md:py-8 text-sm">No purchases recorded</p>
                ) : (
                  state.purchases.slice().reverse().map(purchase => (
                    <div key={purchase.id} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border border-blue-400/10">
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-white font-semibold text-sm truncate">{purchase.supplier}</p>
                          <p className="text-blue-300 text-xs">{purchase.date}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <p className="text-indigo-400 font-semibold">KES {purchase.totalAmount.toLocaleString()}</p>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                setEditingPurchase(purchase);
                                setModalType('purchase');
                                setFormData(purchase);
                                setShowModal(true);
                              }}
                              className="p-1 hover:bg-blue-500/30 rounded transition"
                            >
                              <Edit2 className="w-3 h-3 text-blue-300" />
                            </button>
                            <button
                              onClick={() => handleDeletePurchase(purchase.id)}
                              className="p-1 hover:bg-red-500/30 rounded transition"
                            >
                              <Trash2 className="w-3 h-3 text-red-300" />
                            </button>
                          </div>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-xs">
                        {purchase.items.map((item, i) => (
                          <div key={i} className="p-2 bg-slate-600/30 rounded">
                            <p className="text-slate-400 text-xs">{item.description}</p>
                            <p className="text-white font-semibold">{item.quantity} units</p>
                            <p className="text-indigo-300">KES {item.total.toLocaleString()}</p>
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
            <h2 className="text-xl md:text-2xl font-bold text-white">Raw Materials Inventory</h2>

            {/* Empty Bottles */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Empty Bottles</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
                {Object.entries(state.rawMaterials.emptyBottles).map(([size, quantity]) => (
                  <div key={size} className="bg-slate-700/30 rounded-lg p-3 md:p-4 border border-blue-400/10">
                    <p className="text-blue-300 text-xs md:text-sm mb-2">{size}</p>
                    <p className="text-white text-lg md:text-2xl font-bold">{quantity}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Other Materials */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 md:gap-6">
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm">Seals</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.seals).map(([type, qty]) => {
                    let label = type;
                    if (type === 'short_neck') label = 'Short Neck (0.5L & 1.5L)';
                    else if (type === '5L') label = '5L';
                    else if (type === '18.9L') label = '18.9L';
                    return (
                      <div key={type} className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                        <p className="text-blue-300">{label}</p>
                        <p className="text-white font-semibold">{qty}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm">Labels</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.labels).map(([size, qty]) => (
                    <div key={size} className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                      <p className="text-blue-300">{size}</p>
                      <p className="text-white font-semibold">{qty}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm">Caps</h3>
                <div className="space-y-2 md:space-y-3">
                  {Object.entries(state.rawMaterials.caps || {}).map(([size, qty]) => (
                    <div key={size} className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                      <p className="text-blue-300">{size}</p>
                      <p className="text-white font-semibold">{qty}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm">Overwraps by Size</h3>
                <div className="space-y-2 md:space-y-3">
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                    <p className="text-blue-300">0.5L Cartons</p>
                    <p className="text-white font-semibold">{state.rawMaterials.overwraps['0.5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                    <p className="text-blue-300">1.5L Cartons</p>
                    <p className="text-white font-semibold">{state.rawMaterials.overwraps['1.5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                    <p className="text-blue-300">5L Cartons</p>
                    <p className="text-white font-semibold">{state.rawMaterials.overwraps['5L']}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/50 rounded-lg text-xs md:text-sm border border-green-400/30 mt-2">
                    <p className="text-green-300 font-semibold">Total Overwraps</p>
                    <p className="text-green-400 font-bold">{Object.values(state.rawMaterials.overwraps).reduce((a, b) => a + b, 0)}</p>
                  </div>
                </div>
              </div>

              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm">Other Materials</h3>
                <div className="space-y-2 md:space-y-3">
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                    <p className="text-blue-300">KRA Stamps</p>
                    <p className="text-white font-semibold">{state.rawMaterials.kraStamps}</p>
                  </div>
                  <div className="flex justify-between items-center p-2 md:p-3 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                    <p className="text-blue-300">RO Chemical</p>
                    <p className="text-white font-semibold">{state.rawMaterials.roChemical.toFixed(1)}L</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Reports Tab */}
        {activeTab === 'reports' && (
          <div className="space-y-4 md:space-y-6">
            <h2 className="text-xl md:text-2xl font-bold text-white">Reports</h2>

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
                      ? 'border-cyan-400 bg-cyan-500/20'
                      : 'border-blue-400/30 bg-slate-800/30 hover:border-cyan-400'
                  }`}
                >
                  <p className="text-xl md:text-2xl mb-1 md:mb-2">{report.icon}</p>
                  <p className={`font-semibold ${reportType === report.id ? 'text-cyan-300' : 'text-blue-300'}`}>{report.label}</p>
                </button>
              ))}
            </div>

            {/* Date Range — applies to all event-based reports */}
            {(reportType === 'sales' || reportType === 'cash' || reportType === 'expense' || reportType === 'profitloss') && (
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-3 md:p-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
                  <div>
                    <label className="text-blue-300 text-xs md:text-sm block mb-1 md:mb-2">Start Date</label>
                    <input
                      type="date"
                      value={dateRange.start}
                      onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                    />
                  </div>
                  <div>
                    <label className="text-blue-300 text-xs md:text-sm block mb-1 md:mb-2">End Date</label>
                    <input
                      type="date"
                      value={dateRange.end}
                      onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-2 md:px-4 py-1 md:py-2 text-sm"
                    />
                  </div>
                  <div className="flex items-end gap-2">
                    <button
                      onClick={() => handleGenerateReport(reportType)}
                      className="flex-1 bg-cyan-500 hover:bg-cyan-600 text-white px-2 md:px-4 py-1 md:py-2 rounded-lg transition text-sm"
                    >
                      Generate
                    </button>
                    <button
                      onClick={() => { setDateRange({ start: '', end: '' }); setTimeout(() => handleGenerateReport(reportType), 0); }}
                      className="bg-slate-600 hover:bg-slate-500 text-white px-2 md:px-3 py-1 md:py-2 rounded-lg transition text-xs"
                      title="Clear dates (show all time)"
                    >
                      All Time
                    </button>
                  </div>
                </div>
                <p className="text-slate-400 text-xs mt-2">
                  {dateRange.start && dateRange.end ? `Showing: ${dateRange.start} to ${dateRange.end}` : 'Showing: All Time (set dates to filter)'}
                </p>
              </div>
            )}

            {/* Report Display */}
            {reportData && (
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 mb-4 md:mb-6">
                  <div>
                    <h3 className="text-white font-semibold text-base md:text-xl">{reportData.title}</h3>
                    <p className="text-blue-300 text-xs md:text-sm">Generated: {reportData.date}</p>
                  </div>
                  <button
                    onClick={downloadReportAsPDF}
                    className="flex items-center gap-2 bg-cyan-500 hover:bg-cyan-600 text-white px-3 md:px-4 py-2 rounded-lg transition text-sm w-full md:w-auto justify-center"
                  >
                    <Download className="w-4 h-4" /> Save as PDF
                  </button>
                </div>

                {/* Aging Debtors Report */}
                {reportType === 'aging' && (
                  <div className="space-y-3">
                    <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 md:p-4 mb-4">
                      <p className="text-red-300 text-xs md:text-sm">Total Outstanding Debt</p>
                      <p className="text-white text-2xl md:text-3xl font-bold">KES {reportData.total.toLocaleString()}</p>
                    </div>
                    {reportData.data.length === 0 ? (
                      <p className="text-blue-300 text-center py-4 md:py-8 text-sm">No debtors</p>
                    ) : (
                      <div className="space-y-2 md:space-y-3">
                        {reportData.data.map((debtor, i) => (
                          <div key={i} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border-l-4 border-red-500 text-xs md:text-sm">
                            <div className="flex justify-between items-start gap-2 mb-2">
                              <div>
                                <p className="text-white font-semibold">{debtor.name}</p>
                                <p className="text-blue-300 text-xs">{debtor.location}</p>
                              </div>
                              <p className="text-red-400 font-semibold">KES {debtor.debt.toLocaleString()}</p>
                            </div>
                            <div className="flex justify-between text-xs text-slate-400">
                              <span>Ph: {debtor.phone}</span>
                              <span>{debtor.daysOverdue}d overdue</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Sales Report */}
                {reportType === 'sales' && (
                  <div className="space-y-4 md:space-y-6">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                      <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-3 md:p-4">
                        <p className="text-green-300 text-xs md:text-sm">Total Sales</p>
                        <p className="text-white text-xl md:text-2xl font-bold">KES {reportData.totalSales.toLocaleString()}</p>
                      </div>
                      <div className="bg-blue-500/20 border border-blue-500/50 rounded-lg p-3 md:p-4">
                        <p className="text-blue-300 text-xs md:text-sm">Transactions</p>
                        <p className="text-white text-xl md:text-2xl font-bold">{reportData.totalTransactions}</p>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6">
                      <div>
                        <h4 className="text-white font-semibold mb-2 md:mb-3 text-sm">Sales Revenue by Location</h4>
                        <div className="space-y-1 md:space-y-2">
                          {Object.entries(reportData.salesByLocation).map(([location, amount]) => (
                            <div key={location} className="flex justify-between p-2 bg-slate-700/30 rounded text-xs md:text-sm">
                              <p className="text-blue-300">{location}</p>
                              <p className="text-white font-semibold">KES {amount.toLocaleString()}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <h4 className="text-white font-semibold mb-2 md:mb-3 text-sm">Total Cartons by Size</h4>
                        <div className="space-y-1 md:space-y-2">
                          {Object.entries(reportData.salesBySize).map(([size, qty]) => (
                            <div key={size} className="flex justify-between p-2 bg-slate-700/30 rounded text-xs md:text-sm">
                              <p className="text-blue-300">{SIZE_LABELS[size] || size}</p>
                              <p className="text-white font-semibold">{qty} cartons</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* Cartons by Location and Size */}
                    <div className="bg-slate-700/30 rounded-lg p-4 border border-blue-400/20">
                      <h4 className="text-white font-semibold mb-4 text-base">📊 Carton Sales by Location & Size</h4>
                      <div className="space-y-4">
                        {Object.entries(reportData.bottlesByLocationAndSize).map(([location, cartons]) => (
                          <div key={location} className="bg-slate-800/50 rounded-lg p-3 border border-blue-400/10">
                            <p className="text-cyan-400 font-bold text-sm mb-2">{location}</p>
                            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
                              {Object.entries(cartons).map(([size, qty]) => (
                                <div key={`${location}-${size}`} className="bg-slate-700/50 p-2 rounded text-xs text-center">
                                  <p className="text-blue-300 font-semibold">{SIZE_LABELS[size] || size}</p>
                                  <p className="text-white font-bold">{qty} cartons</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* Cash Collected Report */}
                {reportType === 'cash' && (
                  <div className="space-y-3 md:space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-3 md:p-4">
                        <p className="text-green-300 text-xs">Cash Sales Collected</p>
                        <p className="text-white text-lg md:text-xl font-bold">KES {reportData.cashSalesTotal.toLocaleString()}</p>
                      </div>
                      <div className="bg-cyan-500/20 border border-cyan-500/50 rounded-lg p-3 md:p-4">
                        <p className="text-cyan-300 text-xs">Debt Payments Collected</p>
                        <p className="text-white text-lg md:text-xl font-bold">KES {reportData.debtPaymentsTotal.toLocaleString()}</p>
                      </div>
                      <div className="bg-gradient-to-br from-green-500 to-emerald-600 rounded-lg p-3 md:p-4">
                        <p className="text-white/80 text-xs">Total Collected</p>
                        <p className="text-white text-lg md:text-xl font-bold">KES {reportData.totalCollected.toLocaleString()}</p>
                      </div>
                    </div>
                    <p className="text-blue-300 text-xs">Period: {reportData.period}</p>

                    <div className="bg-slate-700/30 rounded-lg p-3 md:p-4">
                      <h4 className="text-white font-semibold mb-2 text-sm">Cash Sales (paid at point of sale)</h4>
                      {reportData.cashSalesList.length === 0 ? (
                        <p className="text-slate-400 text-xs py-2">None in this period</p>
                      ) : reportData.cashSalesList.map((c, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 border-b border-blue-400/10">
                          <span className="text-blue-200">{c.date} · {c.invoice} · {c.customer}</span>
                          <span className="text-green-300">KES {c.amount.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>

                    <div className="bg-slate-700/30 rounded-lg p-3 md:p-4">
                      <h4 className="text-white font-semibold mb-2 text-sm">Debt Payments Received</h4>
                      {reportData.debtPaymentsList.length === 0 ? (
                        <p className="text-slate-400 text-xs py-2">None in this period</p>
                      ) : reportData.debtPaymentsList.map((p, i) => (
                        <div key={i} className="flex justify-between text-xs py-1 border-b border-blue-400/10">
                          <span className="text-blue-200">{p.date} · {p.customer}{p.method ? ` · ${p.method}` : ''}</span>
                          <span className="text-cyan-300">KES {p.amount.toLocaleString()}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Expense Report */}
                {reportType === 'expense' && (
                  <div className="space-y-2 md:space-y-3">
                    <div className="bg-orange-500/20 border border-orange-500/50 rounded-lg p-3 md:p-4 mb-4">
                      <p className="text-orange-300 text-xs md:text-sm">Total Expenses</p>
                      <p className="text-white text-2xl md:text-3xl font-bold">KES {reportData.totalExpenses.toLocaleString()}</p>
                    </div>
                    <h4 className="text-white font-semibold text-sm">By Category:</h4>
                    {Object.entries(reportData.byCategory).map(([category, amount]) => (
                      <div key={category} className="flex justify-between items-center p-3 md:p-4 bg-slate-700/30 rounded-lg text-xs md:text-sm">
                        <p className="text-blue-300">{category}</p>
                        <p className="text-white font-semibold">KES {amount.toLocaleString()}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* P&L Report */}
                {reportType === 'profitloss' && (
                  <div className="space-y-3 md:space-y-4">
                    <p className="text-blue-300 text-xs">Period: {reportData.period}</p>

                    {/* Revenue → COGS → Gross Profit */}
                    <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-300">Sales Revenue</span>
                        <span className="text-white font-semibold">KES {reportData.revenue.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-300">Less: Cost of Goods Sold</span>
                        <span className="text-red-300">− KES {reportData.cogs.toLocaleString()}</span>
                      </div>
                      <div className="flex justify-between text-sm pt-2 border-t border-blue-400/20">
                        <span className="text-green-300 font-semibold">Gross Profit</span>
                        <span className="text-green-300 font-bold">KES {reportData.grossProfit.toLocaleString()}</span>
                      </div>
                      <p className="text-xs text-slate-400 text-right">Gross margin: {reportData.grossMargin}%</p>
                    </div>

                    {/* Operating expenses */}
                    <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 space-y-2">
                      <div className="flex justify-between text-sm">
                        <span className="text-blue-300 font-semibold">Operating Expenses</span>
                        <span className="text-red-300">− KES {reportData.operatingExpenses.toLocaleString()}</span>
                      </div>
                      {Object.entries(reportData.operatingBreakdown).map(([k, v]) => (
                        <div key={k} className="flex justify-between text-xs pl-3">
                          <span className="text-slate-400">{k}</span>
                          <span className="text-slate-300">KES {v.toLocaleString()}</span>
                        </div>
                      ))}
                      {Object.keys(reportData.operatingBreakdown).length === 0 && (
                        <p className="text-slate-400 text-xs pl-3">No operating expenses in period</p>
                      )}
                    </div>

                    {/* Net Profit */}
                    <div className={`border-2 rounded-lg p-3 md:p-4 ${reportData.netProfit >= 0 ? 'border-green-500/50 bg-green-500/20' : 'border-red-500/50 bg-red-500/20'}`}>
                      <p className={reportData.netProfit >= 0 ? 'text-green-300' : 'text-red-300'}>Net Profit</p>
                      <p className={`text-2xl md:text-3xl font-bold ${reportData.netProfit >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        KES {reportData.netProfit.toLocaleString()}
                      </p>
                      <p className="text-xs mt-2">Net margin: {reportData.netMargin}%</p>
                    </div>

                    <p className="text-slate-400 text-xs">Note: COGS is based on cartons sold × cost per carton (which includes casual labour). Raw material purchases and casual/overtime pay are not counted again as operating expenses.</p>
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
              <h2 className="text-xl md:text-2xl font-bold text-white">Production</h2>
              <button
                onClick={handleAddProduction}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New
              </button>
            </div>

            {/* Finished Goods */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Finished Goods</h3>
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 md:gap-4">
                {Object.entries(state.finishedGoods).map(([size, data]) => (
                  <div key={size} className="bg-gradient-to-br from-slate-700 to-slate-800 rounded-lg p-3 md:p-4 border border-green-400/20">
                    <p className="text-green-300 text-xs md:text-sm mb-2">{size}</p>
                    <p className="text-white text-lg md:text-2xl font-bold">{data.quantity}</p>
                    <p className="text-slate-400 text-xs mt-2">{data.quantity * data.bottlesPerCarton} btls</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Production History */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">History</h3>
              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {state.productionLogs.length === 0 ? (
                  <p className="text-blue-300 text-center py-4 md:py-8 text-sm">No logs</p>
                ) : (
                  state.productionLogs.slice().reverse().map(log => (
                    <div key={log.id} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border border-blue-400/10">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <p className="text-white font-semibold text-sm">Prod #{log.id}</p>
                          <p className="text-blue-300 text-xs">{log.date}</p>
                        </div>
                        <span className="bg-purple-500/30 text-purple-300 px-2 py-1 rounded text-xs">
                          {log.unit}
                        </span>
                      </div>
                      <div className="grid grid-cols-2 md:grid-cols-5 gap-1 text-xs mb-2">
                        {Object.entries(log.items).map(([size, qty]) => (
                          <div key={size}>
                            <p className="text-slate-400">{size}</p>
                            <p className="text-white font-semibold">{qty}</p>
                          </div>
                        ))}
                      </div>
                      {log.notes && <p className="text-blue-300 text-xs italic">{log.notes}</p>}
                      {(role === 'admin' || role === 'manager') && (
                        <div className="flex justify-end pt-2 mt-2 border-t border-blue-400/10">
                          <button
                            onClick={() => handleDeleteProduction(log.id)}
                            className="flex items-center gap-1 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/20 px-2 py-1 rounded transition"
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
              <h2 className="text-xl md:text-2xl font-bold text-white">Sales</h2>
              <button
                onClick={handleAddSale}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Sale
              </button>
            </div>

            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">History</h3>
              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {visibleSales.length === 0 ? (
                  <p className="text-blue-300 text-center py-4 md:py-8 text-sm">No sales</p>
                ) : (
                  visibleSales.slice().reverse().map(sale => {
                    const customer = state.customers.find(c => c.id === sale.customerId);
                    return (
                      <div key={sale.id} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border border-blue-400/10">
                        <div className="flex justify-between items-start gap-2 mb-2">
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <p className="text-white font-semibold text-sm truncate">{customer?.name}</p>
                              <p className="text-slate-400 text-xs">{sale.invoiceNumber}</p>
                            </div>
                            <p className="text-blue-300 text-xs">{sale.date}</p>
                          </div>
                          <div className="text-right flex-shrink-0">
                            <p className="text-green-400 font-semibold text-sm">KES {sale.total.toLocaleString()}</p>
                            <span className={`text-xs px-2 py-1 rounded block mt-1 ${sale.status === 'paid' ? 'bg-green-500/30 text-green-300' : sale.status === 'partial' ? 'bg-orange-500/30 text-orange-300' : 'bg-red-500/30 text-red-300'}`}>
                              {sale.status === 'paid' ? '✓' : sale.status === 'partial' ? '◐' : '○'}
                            </span>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-1 text-xs pt-2 border-t border-blue-400/10">
                          {sale.items.slice(0, 2).map((item, i) => (
                            <div key={i}>
                              <p className="text-slate-400">{SIZE_LABELS[item.size] || item.size}</p>
                              <p className="text-white">{item.quantity}×{item.price}</p>
                            </div>
                          ))}
                        </div>
                        {(role === 'admin' || role === 'manager') && (
                          <div className="flex justify-end pt-2 mt-2 border-t border-blue-400/10">
                            <button
                              onClick={() => handleDeleteSale(sale.id)}
                              className="flex items-center gap-1 text-xs text-red-300 hover:text-red-200 hover:bg-red-500/20 px-2 py-1 rounded transition"
                            >
                              <Trash2 className="w-3 h-3" /> Delete
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        )}

        {/* Payments Tab */}
        {activeTab === 'payments' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold text-white">Payments & Debts</h2>
              <button
                onClick={handleAddPayment}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> Record Payment
              </button>
            </div>

            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              {[
                { label: 'Total Debt', value: `KES ${state.customers.reduce((sum, c) => sum + Math.max(0, -c.balance), 0).toLocaleString()}`, color: 'from-red-500 to-red-600' },
                { label: 'Total Credits', value: `KES ${state.customers.reduce((sum, c) => sum + Math.max(0, c.balance), 0).toLocaleString()}`, color: 'from-green-500 to-green-600' },
                { label: 'Total Received', value: `KES ${state.payments.reduce((sum, p) => sum + p.amount, 0).toLocaleString()}`, color: 'from-blue-500 to-blue-600' },
              ].map((card, i) => (
                <div 
                  key={i} 
                  className={`bg-gradient-to-br ${card.color} rounded-lg md:rounded-xl p-3 md:p-6 text-white shadow-lg cursor-pointer transition hover:shadow-xl ${
                    card.label === 'Total Debt' && paymentsTab === 'debts' ? 'ring-2 ring-yellow-300' : ''
                  }`}
                  onClick={() => card.label === 'Total Debt' && setPaymentsTab('debts')}
                >
                  <p className="text-xs md:text-sm opacity-90 mb-1 md:mb-2">{card.label}</p>
                  <p className="text-lg md:text-3xl font-bold break-words">{card.value}</p>
                </div>
              ))}
            </div>

            {/* Tab Navigation */}
            <div className="bg-slate-800/30 border-b border-blue-400/20 rounded-t-lg flex gap-2 p-2">
              <button
                onClick={() => setPaymentsTab('debts')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'debts'
                    ? 'bg-red-500/30 text-red-300 border-b-2 border-red-400'
                    : 'text-blue-300 hover:text-white'
                }`}
              >
                💰 Outstanding Debts
              </button>
              <button
                onClick={() => setPaymentsTab('history')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'history'
                    ? 'bg-cyan-500/30 text-cyan-300 border-b-2 border-cyan-400'
                    : 'text-blue-300 hover:text-white'
                }`}
              >
                📋 Payment History
              </button>
              <button
                onClick={() => setPaymentsTab('accounts')}
                className={`flex-1 py-2 px-4 rounded-t-lg transition text-sm font-semibold ${
                  paymentsTab === 'accounts'
                    ? 'bg-green-500/30 text-green-300 border-b-2 border-green-400'
                    : 'text-blue-300 hover:text-white'
                }`}
              >
                👥 All Accounts
              </button>
            </div>

            {/* Outstanding Debts Tab */}
            {paymentsTab === 'debts' && (
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <h3 className="text-white font-semibold mb-4 text-base">Customers with Outstanding Debts</h3>
                <div className="space-y-3">
                  {state.customers.filter(c => c.balance < 0).length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-green-400 text-lg font-semibold">✓ No Outstanding Debts!</p>
                      <p className="text-blue-300 text-sm mt-2">All customers are up to date</p>
                    </div>
                  ) : (
                    state.customers
                      .filter(c => c.balance < 0)
                      .sort((a, b) => a.balance - b.balance)
                      .map((customer) => {
                        const debt = Math.abs(customer.balance);
                        const sales = state.sales.filter(s => s.customerId === customer.id && s.status !== 'paid');
                        const lastSale = sales.length > 0 ? sales[sales.length - 1] : null;
                        
                        return (
                          <div key={customer.id} className="p-4 bg-red-900/20 border-2 border-red-500/50 rounded-lg">
                            {/* Customer Header */}
                            <div className="flex justify-between items-start mb-3">
                              <div className="flex-1">
                                <p className="text-white text-lg font-bold">{customer.name}</p>
                                <p className="text-red-300 text-sm">{customer.location}</p>
                              </div>
                              <div className="text-right">
                                <p className="text-red-400 text-2xl font-bold">KES {debt.toLocaleString()}</p>
                                <p className="text-red-300 text-xs">Outstanding</p>
                              </div>
                            </div>

                            {/* Customer Details */}
                            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 py-3 border-t border-b border-red-500/30">
                              <div>
                                <p className="text-slate-400 text-xs">Phone</p>
                                <p className="text-white font-semibold text-sm">{customer.phone}</p>
                              </div>
                              <div>
                                <p className="text-slate-400 text-xs">Unpaid Invoices</p>
                                <p className="text-white font-semibold text-sm">{sales.length}</p>
                              </div>
                              <div>
                                <p className="text-slate-400 text-xs">Last Sale Date</p>
                                <p className="text-white font-semibold text-sm">{lastSale?.date || 'N/A'}</p>
                              </div>
                              <div>
                                <p className="text-slate-400 text-xs">Status</p>
                                <p className={`font-semibold text-sm ${customer.isActive ? 'text-green-400' : 'text-orange-400'}`}>
                                  {customer.isActive ? 'Active' : 'Inactive'}
                                </p>
                              </div>
                            </div>

                            {/* Unpaid Invoices */}
                            {sales.length > 0 && (
                              <div className="mt-3 pt-3 border-t border-red-500/30">
                                <p className="text-red-300 font-semibold text-sm mb-2">Unpaid Invoices:</p>
                                <div className="space-y-1">
                                  {sales.map((sale) => (
                                    <div key={sale.id} className="flex justify-between text-xs bg-slate-700/50 p-2 rounded">
                                      <span className="text-white">{sale.invoiceNumber} • {sale.date}</span>
                                      <span className="text-red-300 font-semibold">KES {(sale.total - sale.paid).toLocaleString()}</span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Action Button */}
                            <button
                              onClick={handleAddPayment}
                              className="mt-3 w-full bg-green-500/30 hover:bg-green-500/50 border border-green-500/50 text-green-300 py-2 px-3 rounded-lg transition text-sm font-semibold"
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
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <h3 className="text-white font-semibold mb-4 text-base">Payment History</h3>
                <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                  {visiblePayments.length === 0 ? (
                    <p className="text-blue-300 text-center py-8 text-sm">No payments recorded</p>
                  ) : (
                    visiblePayments.slice().reverse().map(payment => {
                      const customer = state.customers.find(c => c.id === payment.customerId);
                      const sale = state.sales.find(s => s.id === payment.saleId);
                      return (
                        <div key={payment.id} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border border-cyan-400/20">
                          <div className="flex justify-between items-start mb-2">
                            <div className="min-w-0 flex-1">
                              <p className="text-white font-semibold truncate">{customer?.name}</p>
                              <p className="text-blue-300 text-xs">{payment.date}</p>
                            </div>
                            <p className="text-green-400 font-bold text-lg ml-2">KES {payment.amount.toLocaleString()}</p>
                          </div>
                          <div className="flex gap-2 text-xs text-slate-400">
                            <span className="bg-slate-600/50 px-2 py-1 rounded">{payment.method}</span>
                            <span className="bg-slate-600/50 px-2 py-1 rounded">{sale?.invoiceNumber || 'N/A'}</span>
                            {payment.reference && <span className="bg-slate-600/50 px-2 py-1 rounded">Ref: {payment.reference}</span>}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}

            {/* All Accounts Tab */}
            {paymentsTab === 'accounts' && (
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-b-lg rounded-tr-lg p-4 md:p-6">
                <h3 className="text-white font-semibold mb-4 text-base">All Customer Accounts</h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {state.customers.length === 0 ? (
                    <p className="text-blue-300 text-center py-8 text-sm">No customers</p>
                  ) : (
                    state.customers.sort((a, b) => a.balance - b.balance).map(customer => {
                      const isDebtor = customer.balance < 0;
                      const isCreditor = customer.balance > 0;
                      
                      return (
                        <div 
                          key={customer.id} 
                          className={`p-3 md:p-4 rounded-lg flex justify-between items-center border-l-4 transition ${
                            isDebtor 
                              ? 'bg-red-900/20 border-red-500 hover:bg-red-900/30' 
                              : isCreditor 
                              ? 'bg-green-900/20 border-green-500 hover:bg-green-900/30'
                              : 'bg-slate-700/30 border-blue-400/30 hover:bg-slate-700/50'
                          }`}
                        >
                          <div className="min-w-0">
                            <p className="text-white font-semibold truncate">{customer.name}</p>
                            <p className="text-slate-400 text-xs">{customer.location} • {customer.phone}</p>
                          </div>
                          <div className="text-right flex-shrink-0 ml-2">
                            <p className={`font-bold text-base ${
                              isDebtor ? 'text-red-400' : isCreditor ? 'text-green-400' : 'text-blue-300'
                            }`}>
                              {isDebtor ? '- ' : isCreditor ? '+ ' : ''}KES {Math.abs(customer.balance).toLocaleString()}
                            </p>
                            <p className={`text-xs ${isDebtor ? 'text-red-300' : isCreditor ? 'text-green-300' : 'text-blue-300'}`}>
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
              <h2 className="text-xl md:text-2xl font-bold text-white">Expenses</h2>
              <button
                onClick={handleAddExpense}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New Expense
              </button>
            </div>

            {role !== 'sales' && (
            <>
            {/* Summary by Category */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-6">
              {Object.entries(getTotalExpensesByCategory()).map(([category, amount]) => (
                <div key={category} className="bg-orange-500/20 border border-orange-500/50 rounded-lg md:rounded-xl p-3 md:p-4">
                  <p className="text-orange-300 text-xs md:text-sm">{category}</p>
                  <p className="text-white text-lg md:text-2xl font-bold">KES {amount.toLocaleString()}</p>
                </div>
              ))}
            </div>

            {/* Total Expenses */}
            <div className="bg-gradient-to-br from-orange-500 to-orange-600 rounded-lg md:rounded-xl p-4 md:p-6 text-white shadow-lg">
              <p className="text-sm opacity-90 mb-2">Total Expenses</p>
              <p className="text-3xl md:text-4xl font-bold">KES {getTotalExpenses().toLocaleString()}</p>
            </div>

            {/* Expenses List */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 md:mb-4 text-sm md:text-base">Expense Records</h3>
              <div className="space-y-2 md:space-y-3 max-h-96 overflow-y-auto">
                {state.expenses.length === 0 ? (
                  <p className="text-blue-300 text-center py-4 md:py-8 text-sm">No expenses recorded</p>
                ) : (
                  state.expenses.slice().reverse().map(expense => (
                    <div key={expense.id} className="p-3 md:p-4 bg-slate-700/30 rounded-lg border border-blue-400/10">
                      <div className="flex justify-between items-start gap-2 mb-2">
                        <div className="min-w-0 flex-1">
                          <p className="text-white font-semibold text-sm truncate">{expense.description || expense.subcategory}</p>
                          <p className="text-blue-300 text-xs">{expense.date}</p>
                          <p className="text-slate-400 text-xs">{expense.category} • {expense.subcategory}</p>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <p className="text-orange-400 font-semibold">KES {expense.amount.toLocaleString()}</p>
                          <div className="flex gap-1">
                            <button
                              onClick={() => {
                                setEditingExpense(expense);
                                setModalType('expense');
                                setFormData(expense);
                                setShowModal(true);
                              }}
                              className="p-1 hover:bg-blue-500/30 rounded transition"
                            >
                              <Edit2 className="w-3 h-3 text-blue-300" />
                            </button>
                            <button
                              onClick={() => handleDeleteExpense(expense.id)}
                              className="p-1 hover:bg-red-500/30 rounded transition"
                            >
                              <Trash2 className="w-3 h-3 text-red-300" />
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
              <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
                <p className="text-blue-300 text-center py-4 text-sm">Use the "New Expense" button above to record an expense.</p>
              </div>
            )}
          </div>
        )}
        {/* Customers Tab */}
        {activeTab === 'customers' && (
          <div className="space-y-4 md:space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3">
              <h2 className="text-xl md:text-2xl font-bold text-white">Customers</h2>
              <button
                onClick={handleAddCustomer}
                className="w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-4 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Plus className="w-4 h-4" /> New
              </button>
            </div>

            {/* Customer Search Bar */}
            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg p-3 md:p-4">
              <input
                type="text"
                placeholder="Search customers by name, location, or phone..."
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-4 py-2 text-sm placeholder-slate-400"
              />
            </div>

            <div className="grid grid-cols-1 gap-3 md:gap-4">
              {state.customers
                .filter(customer => {
                  const searchTerm = customerSearch.toLowerCase();
                  return (
                    customer.name.toLowerCase().includes(searchTerm) ||
                    customer.location.toLowerCase().includes(searchTerm) ||
                    customer.phone.includes(searchTerm)
                  );
                })
                .map(customer => (
                <div key={customer.id} className="p-4 md:p-6 bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl">
                  <div className="flex justify-between items-start gap-3 mb-3">
                    <div className="min-w-0">
                      <p className="text-white text-base md:text-lg font-semibold">{customer.name}</p>
                      <p className="text-blue-300 text-xs md:text-sm">{customer.location} • {customer.phone}</p>
                    </div>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => {
                          setEditingCustomer(customer);
                          setModalType('customer');
                          setFormData(customer);
                          setShowModal(true);
                        }}
                        className="p-2 hover:bg-blue-500/30 rounded-lg transition"
                      >
                        <Edit2 className="w-4 h-4 text-blue-300" />
                      </button>
                      <button
                        onClick={() => handleDeleteCustomer(customer.id)}
                        className="p-2 hover:bg-red-500/30 rounded-lg transition"
                      >
                        <Trash2 className="w-4 h-4 text-red-300" />
                      </button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between pt-3 border-t border-blue-400/10">
                    <div>
                      <p className="text-slate-400 text-xs md:text-sm">Balance</p>
                      <p className={`text-lg md:text-xl font-semibold ${customer.balance >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                        KES {customer.balance.toLocaleString()}
                      </p>
                    </div>
                    <span className={`px-3 py-1 rounded-full text-xs font-medium ${customer.isActive ? 'bg-green-500/30 text-green-300' : 'bg-red-500/30 text-red-300'}`}>
                      {customer.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Cost Settings Tab (admin only) */}
        {activeTab === 'costsettings' && role === 'admin' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-white">Cost Settings</h2>
              <p className="text-blue-300 text-sm mt-1">Enter the cost per carton for each product size. Used to value finished goods stock. Raw material values come automatically from your latest purchase prices.</p>
            </div>

            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-4 text-sm md:text-base">Finished Goods — Cost per Carton (KES)</h3>
              <div className="space-y-3">
                {['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill', 'refill_10L', 'refill_15L', 'refill_20L'].map(size => (
                  <div key={size} className="flex items-center justify-between gap-3">
                    <label className="text-blue-300 text-sm">
                      {size === '18.9L_disposable' ? '18.9L Disposable' : size === '18.9L_refill' ? '18.9L Refill (bottle)' : size === 'refill_10L' ? 'Water Refill 10L' : size === 'refill_15L' ? 'Water Refill 15L' : size === 'refill_20L' ? 'Water Refill 20L' : size}
                    </label>
                    <input
                      type="number"
                      value={cartonCosts[size] || ''}
                      onChange={(e) => setCartonCosts({ ...cartonCosts, [size]: parseFloat(e.target.value) || 0 })}
                      placeholder="0"
                      className="w-32 bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 py-2 text-sm text-right"
                    />
                  </div>
                ))}
              </div>
              <button
                onClick={handleSaveCartonCosts}
                className="mt-6 w-full md:w-auto bg-cyan-500 hover:bg-cyan-600 text-white px-6 py-2 rounded-lg transition flex items-center justify-center gap-2 text-sm"
              >
                <Save className="w-4 h-4" /> Save Costs
              </button>
            </div>

            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <h3 className="text-white font-semibold mb-3 text-sm md:text-base">Current Asset Valuation</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between p-2 bg-slate-700/30 rounded">
                  <span className="text-blue-300">Raw Materials (at latest purchase prices)</span>
                  <span className="text-white font-semibold">KES {calculateInventoryValue().toLocaleString()}</span>
                </div>
                <div className="flex justify-between p-2 bg-slate-700/30 rounded">
                  <span className="text-blue-300">Finished Goods (at carton cost)</span>
                  <span className="text-white font-semibold">KES {calculateFinishedGoodsValue().toLocaleString()}</span>
                </div>
                <div className="flex justify-between p-2 bg-slate-700/50 rounded border border-green-400/30">
                  <span className="text-green-300 font-semibold">Total Assets</span>
                  <span className="text-green-400 font-bold">KES {(calculateInventoryValue() + calculateFinishedGoodsValue()).toLocaleString()}</span>
                </div>
              </div>
              <p className="text-slate-400 text-xs mt-3">Note: Materials with no purchase recorded yet are valued at 0 until you log a purchase for them.</p>
            </div>
          </div>
        )}

        {/* Stock Adjustment Tab (admin only) */}
        {activeTab === 'adjust' && role === 'admin' && (
          <div className="space-y-4 md:space-y-6">
            <div>
              <h2 className="text-xl md:text-2xl font-bold text-white">Stock Adjustment</h2>
              <p className="text-blue-300 text-sm mt-1">Set the actual quantity of any stock item after a physical count. Use this to align the system with reality (opening stock, stock-take, breakage). Each change is logged.</p>
            </div>

            <div className="bg-slate-800/30 border border-blue-400/20 rounded-lg md:rounded-xl p-4 md:p-6">
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {getStockItems().map(item => (
                  <div key={item.id} className="flex items-center justify-between gap-3 p-2 bg-slate-700/30 rounded-lg">
                    <div className="min-w-0">
                      <p className="text-white text-sm truncate">{item.label}</p>
                      <p className="text-slate-400 text-xs">Current: {item.qty}</p>
                    </div>
                    <button
                      onClick={() => {
                        setModalType('adjust');
                        setFormData({ itemId: item.id, itemLabel: item.label, currentQty: item.qty, newQty: '', reason: '' });
                        setShowModal(true);
                      }}
                      className="bg-cyan-500/80 hover:bg-cyan-500 text-white px-3 py-1.5 rounded text-xs whitespace-nowrap"
                    >
                      Adjust
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Dashboard Card Breakdown Modal */}
        {breakdownCard && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={() => setBreakdownCard(null)}>
            <div className="bg-slate-800 border border-blue-400/30 rounded-xl p-5 md:p-6 max-w-lg w-full max-h-[80vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-between items-center mb-4">
                <h3 className="text-white font-bold text-lg capitalize">
                  {breakdownCard === 'customers' && 'All Customers'}
                  {breakdownCard === 'debt' && 'Outstanding Debts'}
                  {breakdownCard === 'sales' && 'All Sales'}
                  {breakdownCard === 'costs' && 'Cost Breakdown'}
                </h3>
                <button onClick={() => setBreakdownCard(null)} className="text-blue-300 hover:text-white">
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Customers breakdown */}
              {breakdownCard === 'customers' && (
                <div className="space-y-2">
                  {state.customers.length === 0 ? (
                    <p className="text-blue-300 text-center py-4 text-sm">No customers</p>
                  ) : state.customers.map(c => (
                    <div key={c.id} className="flex justify-between items-center p-2 bg-slate-700/30 rounded text-sm">
                      <div>
                        <p className="text-white">{c.name}</p>
                        <p className="text-slate-400 text-xs">{c.location} · {c.phone}</p>
                      </div>
                      <span className={c.balance < 0 ? 'text-red-300' : 'text-green-300'}>
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
                    <p className="text-blue-300 text-center py-4 text-sm">No outstanding debts</p>
                  ) : state.customers.filter(c => c.balance < 0).map(c => (
                    <div key={c.id} className="flex justify-between items-center p-2 bg-slate-700/30 rounded text-sm">
                      <div>
                        <p className="text-white">{c.name}</p>
                        <p className="text-slate-400 text-xs">{c.location} · {c.phone}</p>
                      </div>
                      <span className="text-red-300 font-semibold">KES {Math.abs(c.balance).toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="flex justify-between p-2 bg-red-500/20 rounded border border-red-400/30 mt-2 text-sm">
                    <span className="text-red-300 font-semibold">Total Debt</span>
                    <span className="text-red-300 font-bold">KES {state.customers.reduce((s, c) => s + Math.max(0, -c.balance), 0).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Sales breakdown */}
              {breakdownCard === 'sales' && (
                <div className="space-y-2">
                  {state.sales.length === 0 ? (
                    <p className="text-blue-300 text-center py-4 text-sm">No sales</p>
                  ) : state.sales.slice().reverse().map(s => {
                    const cust = state.customers.find(c => c.id === s.customerId);
                    return (
                      <div key={s.id} className="flex justify-between items-center p-2 bg-slate-700/30 rounded text-sm">
                        <div>
                          <p className="text-white">{s.invoiceNumber} · {cust?.name || 'Unknown'}</p>
                          <p className="text-slate-400 text-xs">{s.date} · {s.status}</p>
                        </div>
                        <span className="text-green-300">KES {s.total.toLocaleString()}</span>
                      </div>
                    );
                  })}
                  <div className="flex justify-between p-2 bg-green-500/20 rounded border border-green-400/30 mt-2 text-sm">
                    <span className="text-green-300 font-semibold">Total Sales</span>
                    <span className="text-green-300 font-bold">KES {state.sales.reduce((sum, s) => sum + s.total, 0).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Costs breakdown */}
              {breakdownCard === 'costs' && (
                <div className="space-y-2">
                  <div className="flex justify-between p-2 bg-slate-700/30 rounded text-sm">
                    <span className="text-blue-300">Total Expenses</span>
                    <span className="text-white font-semibold">KES {getTotalExpenses().toLocaleString()}</span>
                  </div>
                  <div className="flex justify-between p-2 bg-slate-700/30 rounded text-sm">
                    <span className="text-blue-300">Total Purchases</span>
                    <span className="text-white font-semibold">KES {getTotalPurchases().toLocaleString()}</span>
                  </div>
                  <p className="text-blue-300 text-xs font-semibold mt-3 mb-1">Expenses by Category</p>
                  {Object.entries(getTotalExpensesByCategory()).map(([cat, amt]) => (
                    <div key={cat} className="flex justify-between p-2 bg-slate-700/20 rounded text-xs">
                      <span className="text-slate-300">{cat}</span>
                      <span className="text-white">KES {amt.toLocaleString()}</span>
                    </div>
                  ))}
                  <div className="flex justify-between p-2 bg-purple-500/20 rounded border border-purple-400/30 mt-2 text-sm">
                    <span className="text-purple-300 font-semibold">Total Costs</span>
                    <span className="text-purple-300 font-bold">KES {(getTotalExpenses() + getTotalPurchases()).toLocaleString()}</span>
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
          <div className="bg-slate-800 border border-blue-400/20 rounded-lg md:rounded-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center p-4 md:p-6 border-b border-blue-400/10 sticky top-0 bg-slate-800">
              <h3 className="text-white font-semibold text-base md:text-lg">
                {modalType === 'sale' && 'New Sale'}
                {modalType === 'payment' && 'Record Payment'}
                {modalType === 'production' && 'Production Log'}
                {modalType === 'purchase' && (editingPurchase ? 'Edit Purchase' : 'New Purchase')}
                {modalType === 'expense' && (editingExpense ? 'Edit Expense' : 'New Expense')}
                {modalType === 'customer' && (editingCustomer ? 'Edit' : 'New Customer')}
                {modalType === 'adjust' && 'Adjust Stock'}
              </h3>
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-4 md:p-6 space-y-4">
              {/* Purchase Modal */}
              {modalType === 'purchase' && (
                <>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Supplier Name</label>
                    <input
                      type="text"
                      value={formData.supplier || ''}
                      onChange={(e) => setFormData({ ...formData, supplier: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="e.g., Kenya Bottle Co..."
                    />
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Purchase Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 border border-blue-400/10">
                    <h4 className="text-white font-semibold mb-3 text-sm">Materials Purchased</h4>
                    <div className="space-y-3">
                      {formData.items?.map((item, idx) => (
                        <div key={idx} className="space-y-2 p-3 bg-slate-600/30 rounded">
                          <div>
                            <label className="text-blue-300 text-xs block mb-1">Material</label>
                            <select
                              value={item.description || ''}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                const selected = state.rawMaterialOptions[e.target.value];
                                newItems[idx].material = selected.material;
                                newItems[idx].description = e.target.value;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1 text-sm"
                            >
                              <option value="">Select material...</option>
                              {Object.keys(state.rawMaterialOptions).map(opt => (
                                <option key={opt} value={opt}>{opt}</option>
                              ))}
                            </select>
                            {item.description && (
                              <p className="text-green-300 text-xs mt-1 font-semibold">✓ {item.description}</p>
                            )}
                          </div>
                          <div className="grid grid-cols-3 gap-2">
                            <div>
                              <label className="text-blue-300 text-xs block mb-1">Qty</label>
                              <input
                                type="number"
                                value={item.quantity || 0}
                                onChange={(e) => {
                                  const newItems = [...formData.items];
                                  newItems[idx].quantity = parseInt(e.target.value) || 0;
                                  newItems[idx].total = newItems[idx].quantity * newItems[idx].unitPrice;
                                  setFormData({ ...formData, items: newItems });
                                }}
                                className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1 text-sm"
                              />
                            </div>
                            <div>
                              <label className="text-blue-300 text-xs block mb-1">Unit Price</label>
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
                                className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1 text-sm"
                              />
                            </div>
                            <div>
                              <p className="text-blue-300 text-xs mb-1">Total</p>
                              <p className="text-white font-semibold">KES {(item.total || 0).toLocaleString()}</p>
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
                      className="mt-3 text-cyan-300 text-sm"
                    >
                      + Add Item
                    </button>
                  </div>

                  <div className="bg-indigo-500/20 border border-indigo-500/50 rounded-lg p-3 md:p-4">
                    <p className="text-indigo-300 text-xs">Total Purchase Amount</p>
                    <p className="text-white text-lg md:text-xl font-bold">
                      KES {(formData.items?.reduce((sum, i) => sum + (i.total || 0), 0) || 0).toLocaleString()}
                    </p>
                  </div>
                </>
              )}

              {/* Sale Modal */}
              {modalType === 'sale' && (
                <>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Customer</label>
                    <input
                      type="text"
                      value={saleCustomerSearch}
                      onChange={(e) => setSaleCustomerSearch(e.target.value)}
                      placeholder="Search customer by name, location, or phone..."
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm placeholder-slate-400 mb-2"
                    />
                    <div className="max-h-48 overflow-y-auto border border-blue-400/30 rounded-lg divide-y divide-blue-400/10">
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
                                  ? 'bg-cyan-500/30 text-white'
                                  : 'bg-slate-700/30 text-blue-200 hover:bg-slate-700/60'
                              }`}
                            >
                              <span>{c.name}</span>
                              <span className="text-xs text-slate-400">{c.location}</span>
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
                        <p className="text-slate-400 text-sm text-center py-3">No matching customers</p>
                      )}
                    </div>
                    {formData.customerId && (
                      <p className="text-green-300 text-xs mt-2">
                        ✓ Selected: {state.customers.find(c => c.id === parseInt(formData.customerId))?.name}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Payment Status</label>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, paymentStatus: 'unpaid' })}
                        className={`flex-1 py-2 px-3 rounded-lg transition font-semibold text-sm ${
                          formData.paymentStatus === 'unpaid'
                            ? 'bg-red-500 text-white'
                            : 'bg-slate-700/50 text-slate-400 border border-blue-400/30 hover:border-red-400/50'
                        }`}
                      >
                        ✗ UNPAID (Debt)
                      </button>
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, paymentStatus: 'paid' })}
                        className={`flex-1 py-2 px-3 rounded-lg transition font-semibold text-sm ${
                          formData.paymentStatus === 'paid'
                            ? 'bg-green-500 text-white'
                            : 'bg-slate-700/50 text-slate-400 border border-blue-400/30 hover:border-green-400/50'
                        }`}
                      >
                        ✓ PAID
                      </button>
                    </div>
                  </div>

                  <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 border border-blue-400/10">
                    <h4 className="text-white font-semibold mb-3 text-sm">Items</h4>
                    <div className="space-y-3">
                      {formData.items?.map((item, idx) => (
                        <div key={idx} className="grid grid-cols-4 gap-2 items-end text-xs md:text-sm">
                          <div>
                            <label className="text-blue-300 text-xs block mb-1">Size</label>
                            <select
                              value={item.size || ''}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].size = e.target.value;
                                newItems[idx].price = BOTTLE_PRICES[e.target.value] || 0;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1"
                            >
                              {Object.keys(BOTTLE_PRICES).map(s => (
                                <option key={s} value={s}>{SIZE_LABELS[s] || s}</option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-blue-300 text-xs block mb-1">Qty</label>
                            <input
                              type="number"
                              value={item.quantity || 0}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].quantity = parseInt(e.target.value) || 0;
                                newItems[idx].subtotal = newItems[idx].quantity * newItems[idx].price;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1"
                            />
                          </div>
                          <div>
                            <label className="text-blue-300 text-xs block mb-1">Price</label>
                            <input
                              type="number"
                              value={item.price || 0}
                              onChange={(e) => {
                                const newItems = [...formData.items];
                                newItems[idx].price = parseInt(e.target.value) || 0;
                                newItems[idx].subtotal = newItems[idx].quantity * newItems[idx].price;
                                setFormData({ ...formData, items: newItems });
                              }}
                              className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded px-2 py-1"
                            />
                          </div>
                          <div>
                            <p className="text-blue-300 text-xs mb-1">Sub</p>
                            <p className="text-white font-semibold">KES {(item.subtotal || 0).toLocaleString()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      onClick={() => setFormData({
                        ...formData,
                        items: [...(formData.items || []), { size: '0.5L', quantity: 0, price: 100, subtotal: 0 }]
                      })}
                      className="mt-3 text-cyan-300 text-xs"
                    >
                      + Add
                    </button>
                  </div>

                  <div className="bg-green-500/20 border border-green-500/50 rounded-lg p-3 md:p-4">
                    <p className="text-green-300 text-xs">Total</p>
                    <p className="text-white text-lg md:text-xl font-bold">
                      KES {(formData.items?.reduce((sum, i) => sum + (i.subtotal || 0), 0) || 0).toLocaleString()}
                    </p>
                  </div>
                </>
              )}

              {/* Payment Modal */}
              {modalType === 'payment' && (
                <>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Sale</label>
                    <select
                      value={formData.saleId || ''}
                      onChange={(e) => {
                        const sale = state.sales.find(s => s.id === parseInt(e.target.value));
                        setFormData({
                          ...formData,
                          saleId: e.target.value,
                          amount: sale ? sale.total - sale.paid : 0
                        });
                      }}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select...</option>
                      {state.sales.filter(s => s.paid < s.total).map(s => {
                        const customer = state.customers.find(c => c.id === s.customerId);
                        const balance = s.total - s.paid;
                        return (
                          <option key={s.id} value={s.id}>
                            {customer?.name} - KES {balance.toLocaleString()}
                          </option>
                        );
                      })}
                    </select>
                  </div>

                  {formData.saleId && (
                    <>
                      <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 border border-blue-400/10">
                        <p className="text-blue-300 text-xs">Balance</p>
                        <p className="text-white text-lg font-bold">
                          KES {(state.sales.find(s => s.id === parseInt(formData.saleId))?.total - state.sales.find(s => s.id === parseInt(formData.saleId))?.paid || 0).toLocaleString()}
                        </p>
                      </div>

                      <div>
                        <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Amount</label>
                        <input
                          type="number"
                          value={formData.amount || 0}
                          onChange={(e) => setFormData({ ...formData, amount: parseInt(e.target.value) || 0 })}
                          className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                        />
                      </div>

                      <div>
                        <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Method</label>
                        <select
                          value={formData.method || 'cash'}
                          onChange={(e) => setFormData({ ...formData, method: e.target.value })}
                          className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                        >
                          <option value="cash">Cash</option>
                          <option value="bank_transfer">Bank Transfer</option>
                          <option value="cheque">Cheque</option>
                          <option value="mpesa">M-Pesa</option>
                        </select>
                      </div>

                      <div>
                        <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Reference</label>
                        <input
                          type="text"
                          value={formData.reference || ''}
                          onChange={(e) => setFormData({ ...formData, reference: e.target.value })}
                          className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                          placeholder="TRF-123"
                        />
                      </div>

                      <div>
                        <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Date</label>
                        <input
                          type="date"
                          value={formData.date || ''}
                          onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                          className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
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
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div className="bg-green-900/30 border border-green-400/30 rounded-lg p-3 md:p-4">
                    <p className="text-green-300 text-xs md:text-sm font-semibold">📦 All production measured in CARTONS</p>
                    <p className="text-green-300 text-xs mt-1">Raw materials automatically deducted in bottles</p>
                  </div>

                  <div className="bg-slate-700/30 rounded-lg p-3 md:p-4 border border-blue-400/10">
                    <h4 className="text-white font-semibold mb-3 text-sm">Production Items (in CARTONS)</h4>
                    <div className="space-y-3">
                      {['0.5L', '1.5L', '5L', '18.9L_disposable', '18.9L_refill'].map(size => {
                        const bottlesPerCarton = BOTTLES_PER_CARTON[size];
                        const unitLabel = (size.includes('18.9L')) ? 'units' : 'cartons';
                        return (
                          <div key={size} className="flex items-center gap-2 text-xs md:text-sm bg-slate-700/50 p-2 rounded">
                            <label className="text-blue-300 w-32">{size}</label>
                            <input
                              type="number"
                              min="0"
                              value={formData.items?.[size] || 0}
                              onChange={(e) => setFormData({
                                ...formData,
                                items: { ...formData.items, [size]: parseInt(e.target.value) || 0 }
                              })}
                              className="flex-1 bg-slate-700 border border-blue-400/30 text-white rounded px-2 py-1"
                            />
                            <span className="text-green-400 text-xs font-semibold w-16 text-right">{unitLabel}</span>
                            <span className="text-slate-400 text-xs w-32">({bottlesPerCarton} bottles/carton)</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Notes</label>
                    <textarea
                      value={formData.notes || ''}
                      onChange={(e) => setFormData({ ...formData, notes: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
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
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Date</label>
                    <input
                      type="date"
                      value={formData.date || ''}
                      onChange={(e) => setFormData({ ...formData, date: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Category</label>
                    <select
                      value={formData.category || 'Raw Materials'}
                      onChange={(e) => {
                        const category = e.target.value;
                        setFormData({
                          ...formData,
                          category,
                          subcategory: state.expenseCategories[category]?.[0] || ''
                        });
                      }}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      {Object.keys(state.expenseCategories).map(cat => (
                        <option key={cat} value={cat}>{cat}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Sub-Category</label>
                    <select
                      value={formData.subcategory || ''}
                      onChange={(e) => setFormData({ ...formData, subcategory: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select...</option>
                      {state.expenseCategories[formData.category]?.map(sub => (
                        <option key={sub} value={sub}>{sub}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Description</label>
                    <input
                      type="text"
                      value={formData.description || ''}
                      onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="e.g., Salary payment for staff..."
                    />
                  </div>

                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Amount (KES)</label>
                    <input
                      type="number"
                      value={formData.amount || 0}
                      onChange={(e) => setFormData({ ...formData, amount: parseInt(e.target.value) || 0 })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="0"
                    />
                  </div>
                </>
              )}

              {/* Customer Modal */}
              {modalType === 'customer' && (
                <>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Name</label>
                    <input
                      type="text"
                      value={formData.name || ''}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="Name..."
                    />
                  </div>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Location</label>
                    <select
                      value={formData.location || ''}
                      onChange={(e) => setFormData({ ...formData, location: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                    >
                      <option value="">Select...</option>
                      {state.locations.map(loc => (
                        <option key={loc} value={loc}>{loc}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Phone</label>
                    <input
                      type="tel"
                      value={formData.phone || ''}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="0712345678"
                    />
                  </div>
                </>
              )}

              {modalType === 'adjust' && (
                <>
                  <div className="bg-slate-700/30 rounded-lg p-3">
                    <p className="text-white text-sm font-semibold">{formData.itemLabel}</p>
                    <p className="text-slate-400 text-xs mt-1">Current quantity: {formData.currentQty}</p>
                  </div>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">New Actual Quantity</label>
                    <input
                      type="number"
                      step="0.01"
                      value={formData.newQty}
                      onChange={(e) => setFormData({ ...formData, newQty: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
                      placeholder="Enter counted quantity"
                    />
                  </div>
                  <div>
                    <label className="block text-blue-300 text-xs md:text-sm font-medium mb-2">Reason</label>
                    <select
                      value={formData.reason || ''}
                      onChange={(e) => setFormData({ ...formData, reason: e.target.value })}
                      className="w-full bg-slate-700/50 border border-blue-400/30 text-white rounded-lg px-3 md:px-4 py-2 text-sm"
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
            </div>

            <div className="flex gap-2 md:gap-3 p-4 md:p-6 border-t border-blue-400/10 bg-slate-800/50 sticky bottom-0">
              <button
                onClick={() => setShowModal(false)}
                className="flex-1 px-3 md:px-4 py-2 border border-blue-400/30 text-blue-300 rounded-lg hover:bg-slate-700/50 transition text-sm"
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
                }}
                className="flex-1 px-3 md:px-4 py-2 bg-cyan-500 hover:bg-cyan-600 text-white rounded-lg transition flex items-center justify-center gap-2 text-sm"
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