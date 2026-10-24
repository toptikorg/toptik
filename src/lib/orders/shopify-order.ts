import "server-only";
import { shopifyOrderGraphql } from "@/lib/shopify/admin-api";
import type { OrderAddress, PaidOrder } from "./types";

const ORDER_QUERY = `
  query TopTikPaidOrder($id: ID!) {
    order(id: $id) {
      id name createdAt cancelledAt displayFinancialStatus displayFulfillmentStatus
      email phone requiresShipping
      totalPriceSet { shopMoney { amount currencyCode } }
      currentTotalTaxSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      risk { recommendation }
      customer { displayName }
      shippingAddress { name phone address1 address2 city zip country }
      billingAddress { name phone address1 address2 city zip country }
      shippingLine { title }
      lineItems(first: 250) {
        nodes {
          title variantTitle sku quantity
          discountedUnitPriceAfterAllDiscountsSet { shopMoney { amount currencyCode } }
          discountedTotalSet(withCodeDiscounts: true) { shopMoney { amount currencyCode } }
        }
        pageInfo { hasNextPage }
      }
      transactions(first: 20) {
        id gateway formattedGateway kind status processedAt
        amountSet { shopMoney { amount currencyCode } }
      }
    }
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
  email: string | null; phone: string | null; requiresShipping: boolean;
  totalPriceSet: { shopMoney: PaidOrder["total"] };
  currentTotalTaxSet: { shopMoney: PaidOrder["tax"] } | null;
  totalRefundedSet: { shopMoney: PaidOrder["refunded"] };
  risk: { recommendation: string };
  customer: { displayName: string } | null;
  shippingAddress: OrderAddress | null; billingAddress: OrderAddress | null;
  shippingLine: { title: string } | null;
  lineItems: { nodes: Array<{
    title: string; variantTitle: string | null; sku: string | null; quantity: number;
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: PaidOrder["total"] };
    discountedTotalSet: { shopMoney: PaidOrder["total"] };
  }>; pageInfo: { hasNextPage: boolean } };
  transactions: Array<{
    id: string; gateway: string | null; formattedGateway: string | null;
    kind: string; status: string; processedAt: string | null;
    amountSet: { shopMoney: PaidOrder["total"] };
  }>;
};

type RawFulfillmentNode = {
  deliveryMethod: { methodType: string; presentedName: string | null } | null;
  assignedLocation: { name: string; phone: string | null; address1: string | null; address2: string | null; city: string | null; zip: string | null; countryCode: string };
};
type RawFulfillment = { order: null | { fulfillmentOrders: { nodes: RawFulfillmentNode[] } } };

function sameMoney(a: PaidOrder["total"], b: PaidOrder["total"]) {
  return a.currencyCode === b.currencyCode && Number(a.amount) === Number(b.amount);
}

export async function fetchPaidOrder(orderGid: string): Promise<PaidOrder | null> {
  if (!/^gid:\/\/shopify\/Order\/[1-9]\d*$/.test(orderGid)) throw new Error("ORDER_ID_INVALID");
  const result = await shopifyOrderGraphql<{ order: RawOrder | null }>(ORDER_QUERY, { id: orderGid });
  const order = result.order;
  if (!order) return null;
  if (order.lineItems.pageInfo.hasNextPage) throw new Error("ORDER_LINE_ITEM_LIMIT");
  const payment = order.transactions.find(transaction =>
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
    riskRecommendation: order.risk.recommendation,
    customerName: order.customer?.displayName || order.shippingAddress?.name || order.billingAddress?.name || "לא צוין",
    email: order.email,
    phone: order.phone || order.shippingAddress?.phone || order.billingAddress?.phone || null,
    shippingAddress: order.shippingAddress,
    billingAddress: order.billingAddress,
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

