type SaleItem = {
  productId: string;
  name: string;
  price: number;
  quantity: number;
  costPrice?: number | null;
};

type Sale = {
  id: string;
  items: SaleItem[];
  subtotal: number;
  total: number;
  paymentMethod: string;
  createdAt: string;
  synced?: boolean;
};

type Business = {
  id: string;
  name: string;
  payment_code: string;
  subscription_status: string;
  subscription_expires_at: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  created_at: string;
};

export const exportSalesToCsv = (sales: Sale[], filename: string = 'sales-export') => {
  const headers = [
    'Date',
    'Time',
    'Sale ID',
    'Product',
    'Quantity',
    'Unit Price',
    'Line Total',
    'Cost Price',
    'COGS Line',
    'Payment Method',
    'Sale Subtotal',
    'Sale Total',
    'Synced'
  ];

  const rows: string[][] = [];
  sales.forEach((sale) => {
    const d = new Date(sale.createdAt);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    const pm = sale.paymentMethod === 'cash' ? 'Cash' : 'Mobile Money';
    const items = Array.isArray(sale.items) ? sale.items : [];
    if (items.length === 0) {
      rows.push([
        date,
        time,
        sale.id,
        '',
        '0',
        '0.00',
        '0.00',
        '0.00',
        '0.00',
        pm,
        sale.subtotal.toFixed(2),
        sale.total.toFixed(2),
        sale.synced ? 'Yes' : 'No'
      ]);
      return;
    }
    items.forEach((i) => {
      const qty = Number(i.quantity) || 0;
      const price = Number(i.price) || 0;
      const cost = Number(i.costPrice) || 0;
      const lineTotal = price * qty;
      const cogsLine = cost * qty;
      rows.push([
        date,
        time,
        sale.id,
        i.name,
        String(qty),
        price.toFixed(2),
        lineTotal.toFixed(2),
        cost.toFixed(2),
        cogsLine.toFixed(2),
        pm,
        sale.subtotal.toFixed(2),
        sale.total.toFixed(2),
        sale.synced ? 'Yes' : 'No'
      ]);
    });
  });

  downloadCsv(headers, rows, filename);
};

export const exportBusinessesToCsv = (businesses: Business[], filename: string = 'businesses-export') => {
  const headers = ['Business Name', 'Payment Code', 'Status', 'Expires At', 'Phone', 'Email', 'Address', 'Created At'];
  
  const rows = businesses.map(b => {
    const formatDate = (s: string | null | undefined) => {
      if (!s) return 'N/A';
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) return 'N/A';
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    return [
      b.name,
      b.payment_code,
      b.subscription_status,
      formatDate(b.subscription_expires_at),
      b.phone || '',
      b.email || '',
      b.address || '',
      formatDate(b.created_at)
    ];
  });

  downloadCsv(headers, rows, filename);
};

const downloadCsv = (headers: string[], rows: string[][], filename: string) => {
  const csvContent = [
    headers.join(','),
    ...rows.map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
  ].join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}-${new Date().toISOString().split('T')[0]}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
