import "server-only";
import { shopifyOrderGraphql } from "@/lib/shopify/admin-api";
import type { OrderAddress, PaidOrder } from "./types";

const ORDER_QUERY = `
  query TopTikPaidOrder($id: ID!) {
    order(id: $id) {
      id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      requiresShipping
      totalPriceSet { shopMoney { amount currencyCode } }
      currentTotalTaxSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      shippingLine { title }
      lineItems(first: 250) {
        nodes {
          title variantTitle sku quantity
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
          discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount currencyCode } }
        }
        pageInfo { hasNextPage }
      }
    }
  }
`;

const CONTACT_QUERY = `
  query TopTikOrderContact($id: ID!) {
    order(id: $id) {
      email phone
      shippingAddress { name phone address1 address2 city zip country }
      billingAddress { name phone address1 address2 city zip country }
    }
  }
`;

const PAYMENT_QUERY = `
  query TopTikOrderPayment($id: ID!) {
    order(id: $id) {
      transactions(first: 20) {
        id gateway formattedGateway kind status processedAt
        amountSet { shopMoney { amount currencyCode } }
      }
    }
  }
`;

const RISK_QUERY = `
  query TopTikOrderRisk($id: ID!) {
    order(id: $id) { risk { recommendation } }
  }
`;

const FULFILLMENT_QUERY = `
  query TopTikOrderFulfillment($id: ID!) {
    order(id: $id) {
      fulfillmentOrders(first: 10) {
        nodes {
          deliveryMethod { methodType presentedName }
          assignedLocation { name phone address1 address2 city zip countryCode }
        }
      }
    }
  }
`;

type RawOrder = {
  id: string; name: string; createdAt: string; cancelledAt: string | null;
  displayFinancialStatus: string | null; displayFulfillmentStatus: string;
  requiresShipping: boolean;
  totalPriceSet: { shopMoney: PaidOrder["total"] };
  currentTotalTaxSet: { shopMoney: PaidOrder["tax"] } | null;
  totalRefundedSet: { shopMoney: PaidOrder["refunded"] };
  shippingLine: { title: string } | null;
  lineItems: { nodes: Array<{
    title: string; variantTitle: string | null; sku: string | null; quantity: number;
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: PaidOrder["total"] };
    discountedTotalSet: { shopMoney: PaidOrder["total"] };
  }>; pageInfo: { hasNextPage: boolean } };
};

type RawContact = { order: null | {
  email: string | null; phone: string | null;
  shippingAddress: OrderAddress | null; billingAddress: OrderAddress | null;
} };
type RawPayment = { order: null | { transactions: Array<{
    id: string; gateway: string | null; formattedGateway: string | null;
    kind: string; status: string; processedAt: string | null;
    amountSet: { shopMoney: PaidOrder["total"] };
  }> } };
type RawRisk = { order: null | { risk: { recommendation: string } } };

type RawFulfillmentNode = {
  deliveryMethod: { methodType: string; presentedName: string | null } | null;
  assignedLocation: { name: string; phone: string | null; address1: string | null; address2: string | null; city: string | null; zip: string | null; countryCode: string };
};
type RawFulfillment = { order: null | { fulfillmentOrders: { nodes: RawFulfillmentNode[] } } };

function sameMoney(a: PaidOrder["total"], b: PaidOrder["total"]) {
  return a.currencyCode === b.currencyCode && Number(a.amount) === Number(b.amount);
}

async function requiredSection<T>(query: string, orderGid: string, deniedCode: string): Promise<T> {
  try {
    return await shopifyOrderGraphql<T>(query, { id: orderGid });
  } catch (error) {
    if (error instanceof Error && error.message === "SHOPIFY_GRAPHQL_ACCESS_DENIED") throw new Error(deniedCode);
    throw error;
  }
}

export async function fetchPaidOrder(orderGid: string): Promise<PaidOrder | null> {
  if (!/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderGid)) throw new Error("ORDER_ID_INVALID");
  const result = await requiredSection<{ order: RawOrder | null }>(ORDER_QUERY, orderGid, "SHOPIFY_ORDER_CORE_ACCESS_DENIED");
  const order = result.order;
  if (!order) return null;
  if (order.lineItems.pageInfo.hasNextPage) throw new Error("ORDER_LINE_ITEM_LIMIT");
  const [contactResult, paymentResult, riskResult] = await Promise.all([
    requiredSection<RawContact>(CONTACT_QUERY, orderGid, "SHOPIFY_ORDER_CONTACT_ACCESS_DENIED"),
    requiredSection<RawPayment>(PAYMENT_QUERY, orderGid, "SHOPIFY_ORDER_PAYMENT_ACCESS_DENIED"),
    requiredSection<RawRisk>(RISK_QUERY, orderGid, "SHOPIFY_ORDER_RISK_ACCESS_DENIED"),
  ]);
  const contact = contactResult.order;
  const paymentData = paymentResult.order;
  const risk = riskResult.order;
  if (!contact || !paymentData || !risk) throw new Error("ORDER_NOT_FOUND");
  const payment = paymentData.transactions.find(transaction =>
    transaction.status === "SUCCESS" && ["SALE", "CAPTURE"].includes(transaction.kind) &&
    sameMoney(transaction.amountSet.shopMoney, order.totalPriceSet.shopMoney));
  if (!payment) throw new Error("ORDER_SUCCESSFUL_PAYMENT_MISSING");
  let fulfillment: RawFulfillmentNode | null = null;
  try {
    const fulfillmentResult = await shopifyOrderGraphql<RawFulfillment>(FULFILLMENT_QUERY, { id: orderGid });
    fulfillment = fulfillmentResult.order?.fulfillmentOrders.nodes[0] ?? null;
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "SHOPIFY_GRAPHQL_ACCESS_DENIED") throw error;
  }
  const assigned = fulfillment?.assignedLocation;
  const isPickup = fulfillment?.deliveryMethod?.methodType === "PICK_UP";
  return {
    id: order.id,
    name: order.name,
    createdAt: order.createdAt,
    cancelledAt: order.cancelledAt,
    financialStatus: order.displayFinancialStatus,
    fulfillmentStatus: order.displayFulfillmentStatus,
    riskRecommendation: risk.risk.recommendation,
    customerName: contact.shippingAddress?.name || contact.billingAddress?.name || "לא צוין",
    email: contact.email,
    phone: contact.phone || contact.shippingAddress?.phone || contact.billingAddress?.phone || null,
    shippingAddress: contact.shippingAddress,
    billingAddress: contact.billingAddress,
    requiresShipping: order.requiresShipping,
    deliveryType: fulfillment?.deliveryMethod?.methodType ?? null,
    shippingMethod: fulfillment?.deliveryMethod?.presentedName || order.shippingLine?.title || null,
    pickupLocation: isPickup && assigned ? {
      name: assigned.name, phone: assigned.phone, address1: assigned.address1, address2: assigned.address2,
      city: assigned.city, zip: assigned.zip, country: assigned.countryCode,
    } : null,
    total: order.totalPriceSet.shopMoney,
    tax: order.currentTotalTaxSet?.shopMoney ?? null,
    refunded: order.totalRefundedSet.shopMoney,
    payment: {
      id: payment.id,
      gateway: payment.gateway || "לא ידוע",
      formattedGateway: payment.formattedGateway,
      processedAt: payment.processedAt,
    },
    paymentTerms: null,
    items: order.lineItems.nodes.map(item => ({
      title: item.title, variantTitle: item.variantTitle, sku: item.sku, quantity: item.quantity,
      unitPrice: item.discountedUnitPriceAfterAllDiscountsSet.shopMoney,
      totalPrice: item.discountedTotalSet.shopMoney,
    })),
  };
}

