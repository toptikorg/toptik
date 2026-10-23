import "server-only";
import { shopifyAdminGraphql } from "@/lib/shopify/admin-api";

const ORDER_WEBHOOK_URI = "https://landing.toptik.co.il/api/webhooks/shopify/orders";
const ORDER_WEBHOOK_TOPICS = [
  "ORDERS_PAID",
  "ORDERS_UPDATED",
  "ORDERS_CANCELLED",
  "REFUNDS_CREATE",
] as const;

type OrderWebhookTopic = (typeof ORDER_WEBHOOK_TOPICS)[number];

type ExistingSubscriptions = {
  webhookSubscriptions: {
    nodes: Array<{ id: string; topic: OrderWebhookTopic | string; uri: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
};

type CreateSubscription = {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; topic: OrderWebhookTopic; uri: string } | null;
    userErrors: Array<{ field: string[] | null; message: string }>;
  };
};

const EXISTING_QUERY = `
  query TopTikOrderWebhookSubscriptions($uri: String!) {
    webhookSubscriptions(first: 50, uri: $uri) {
      nodes { id topic uri }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const CREATE_MUTATION = `
  mutation TopTikOrderWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
      webhookSubscription { id topic uri }
      userErrors { field message }
    }
  }
`;

/**
 * Idempotently installs only the four order events used by the automation.
 * The destination is deliberately fixed so this helper cannot become an
 * arbitrary data-forwarding endpoint.
 */
export async function ensureOrderWebhookSubscriptions(): Promise<{
  existing: OrderWebhookTopic[];
  created: OrderWebhookTopic[];
}> {
  const current = await shopifyAdminGraphql<ExistingSubscriptions>(EXISTING_QUERY, {
    uri: ORDER_WEBHOOK_URI,
  });
  if (current.webhookSubscriptions.pageInfo.hasNextPage) {
    throw new Error("ORDER_WEBHOOK_SUBSCRIPTION_LIMIT");
  }

  const existing = new Set(
    current.webhookSubscriptions.nodes
      .filter(node => node.uri === ORDER_WEBHOOK_URI)
      .map(node => node.topic),
  );
  const created: OrderWebhookTopic[] = [];

  for (const topic of ORDER_WEBHOOK_TOPICS) {
    if (existing.has(topic)) continue;
    const result = await shopifyAdminGraphql<CreateSubscription>(CREATE_MUTATION, {
      topic,
      subscription: { uri: ORDER_WEBHOOK_URI, format: "JSON" },
    });
    const payload = result.webhookSubscriptionCreate;
    if (payload.userErrors.length || payload.webhookSubscription?.topic !== topic ||
        payload.webhookSubscription.uri !== ORDER_WEBHOOK_URI) {
      const details = payload.userErrors
        .map(error => error.message.replace(/[\r\n]+/g, " ").slice(0, 240))
        .join(" | ") || "unexpected Shopify response";
      throw new Error(`ORDER_WEBHOOK_SUBSCRIPTION_CREATE_REJECTED [${topic}]: ${details}`);
    }
    created.push(topic);
  }

  return {
    existing: ORDER_WEBHOOK_TOPICS.filter(topic => existing.has(topic)),
    created,
  };
}
