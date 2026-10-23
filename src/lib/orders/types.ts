export type Money = { amount: string; currencyCode: string };

export type OrderAddress = {
  name: string | null;
  phone: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
};

export type PaidOrder = {
  id: string;
  name: string;
  createdAt: string;
  cancelledAt: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string;
  riskRecommendation: string;
  customerName: string;
  email: string | null;
  phone: string | null;
  shippingAddress: OrderAddress | null;
  billingAddress: OrderAddress | null;
  requiresShipping: boolean;
  deliveryType: string | null;
  shippingMethod: string | null;
  pickupLocation: OrderAddress | null;
  total: Money;
  tax: Money | null;
  refunded: Money;
  payment: {
    id: string;
    gateway: string;
    formattedGateway: string | null;
    processedAt: string | null;
  };
  paymentTerms: {
    name: string | null;
    type: string | null;
    dueInDays: number | null;
    due: boolean;
    overdue: boolean;
  } | null;
  items: Array<{
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
    unitPrice: Money;
    totalPrice: Money;
  }>;
};

export type InvoiceDocument = {
  id: string;
  number: string;
  type: string;
  amount: number;
  currency: string;
  createdAt: string;
};

