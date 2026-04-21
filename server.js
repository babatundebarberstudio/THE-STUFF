import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();
if (!process.env.STRIPE_SECRET_KEY || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  dotenv.config({ path: ".env.example" });
}

const {
  PORT = 4242,
  FRONTEND_URL = "http://127.0.0.1:5500",
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  TELNYX_API_KEY,
  TELNYX_FROM_NUMBER,
  TELNYX_MESSAGING_PROFILE_ID,
  FEEDBACK_URL = `${FRONTEND_URL}/#contact-us`
} = process.env;

if (!STRIPE_SECRET_KEY || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing required env vars. Check .env.example.");
}

const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const smsEnabled = Boolean(TELNYX_API_KEY && TELNYX_FROM_NUMBER);
const paymentColumnsHealth = {
  checkedAt: null,
  ready: false,
  error: null
};

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serve static frontend files from the project root.
app.use(express.static(__dirname));

app.use(cors({
  origin(origin, callback) {
    if (!origin || origin === "null") return callback(null, true);
    const isLocalhostOrigin = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
    if (origin === FRONTEND_URL || isLocalhostOrigin) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));

app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    return res.status(500).send("Missing STRIPE_WEBHOOK_SECRET");
  }

  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    return res.status(400).send(`Webhook signature verification failed: ${error.message}`);
  }

  if (event.type === "checkout.session.completed") {
    try {
      const session = event.data.object;
      const resolvedOrder = await resolveOrderForSession(session);
      if (!resolvedOrder.orderId) {
        return res.json({ received: true });
      }

      // For $0 checkouts Stripe returns no_payment_required instead of paid.
      const isCheckoutConfirmed = session.payment_status === "paid"
        || session.payment_status === "no_payment_required"
        || session.status === "complete";
      if (!isCheckoutConfirmed) {
        return res.json({ received: true });
      }

      const { error, updated } = await markOrderPaid(resolvedOrder.orderId, session.id);
      if (error) {
        console.error("Failed to mark order as paid:", error);
        // Return 500 so Stripe retries this webhook event.
        return res.status(500).json({ error: "Failed to persist paid status" });
      }
      if (!updated) {
        console.error("Webhook could not find matching order to update. session_id=", session.id);
        return res.status(500).json({ error: "No matching order found for webhook session" });
      }
      await sendCustomerOrderSms(resolvedOrder.orderId);
    } catch (error) {
      console.error("Webhook processing error:", error);
      return res.status(500).json({ error: "Webhook processing failed" });
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: "2mb" }));

function createOrderNumber() {
  const now = new Date();
  const timestamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
  return "NOIRE-" + timestamp.slice(0, 15);
}

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { customer, cart, totals } = req.body || {};
    if (!customer || !Array.isArray(cart) || cart.length === 0 || !totals) {
      return res.status(400).json({ error: "Missing checkout payload." });
    }

    const customerName = String(customer.name || "").trim();
    const customerEmail = String(customer.email || "").trim().toLowerCase();
    const customerPhone = String(customer.phone || "").trim();
    const shippingAddress = String(customer.shippingAddress || "").trim();
    const notes = String(customer.notes || "").trim();
    if (!customerName || !customerEmail || !customerPhone || !shippingAddress) {
      return res.status(400).json({ error: "Missing required customer fields." });
    }

    const subtotal = Number(totals.subtotal);
    const tax = Number(totals.tax);
    const shippingCost = Number(totals.shipping);
    const total = Number(totals.total);
    if ([subtotal, tax, shippingCost, total].some((value) => Number.isNaN(value))) {
      return res.status(400).json({ error: "Invalid totals." });
    }

    const lineItems = cart.map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = Number(item.price) || 0;
      const variantText = item.color ? ` (${item.color})` : "";
      return {
        price_data: {
          currency: "usd",
          product_data: { name: `${item.name}${variantText}` },
          unit_amount: Math.max(0, Math.round(unitPrice * 100))
        },
        quantity
      };
    });
    if (tax > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Sales Tax" },
          unit_amount: Math.max(0, Math.round(tax * 100))
        },
        quantity: 1
      });
    }
    if (shippingCost > 0) {
      lineItems.push({
        price_data: {
          currency: "usd",
          product_data: { name: "Shipping" },
          unit_amount: Math.max(0, Math.round(shippingCost * 100))
        },
        quantity: 1
      });
    }

    const orderNumber = createOrderNumber();
    const { data: orderRow, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert({
        order_number: orderNumber,
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        shipping_address: shippingAddress,
        notes,
        subtotal,
        tax,
        shipping_cost: shippingCost,
        total,
        status: "pending",
        // Required by existing Supabase schema; does not trigger email sending.
        owner_notification_email: customerEmail
      })
      .select("id, order_number")
      .single();

    if (orderError || !orderRow) {
      console.error("Failed to create order row:", orderError);
      return res.status(500).json({ error: "Could not create order." });
    }

    const orderItemsRows = cart.map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = Number(item.price) || 0;
      const variantText = item.color ? ` (${item.color})` : "";
      return {
        order_id: orderRow.id,
        product_slug: String(item.slug || "unknown"),
        product_name: `${item.name || "Product"}${variantText}`,
        unit_price: unitPrice,
        quantity,
        line_total: unitPrice * quantity
      };
    });

    const { error: orderItemsError } = await supabaseAdmin.from("order_items").insert(orderItemsRows);
    if (orderItemsError) {
      console.error("Failed to create order item rows:", orderItemsError);
      return res.status(500).json({ error: "Could not save order items." });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: customerEmail,
      phone_number_collection: {
        enabled: true
      },
      line_items: lineItems,
      metadata: {
        order_id: orderRow.id,
        order_number: orderRow.order_number
      },
      success_url: `${FRONTEND_URL}/success.html?order=${orderRow.order_number}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html?checkout=cancelled#checkout`
    });
    const bindSessionResponse = await supabaseAdmin
      .from("orders")
      .update({ stripe_session_id: session.id })
      .eq("id", orderRow.id);
    if (bindSessionResponse.error && bindSessionResponse.error.code !== "PGRST204") {
      console.warn("Could not persist stripe_session_id on create:", bindSessionResponse.error.message);
    }

    return res.json({ sessionId: session.id });
  } catch (error) {
    console.error("Checkout session error:", error);
    return res.status(500).json({ error: "Checkout session failed." });
  }
});

app.post("/api/confirm-checkout-session", async (req, res) => {
  try {
    const sessionId = String(req.body?.sessionId || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "Missing sessionId" });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const resolvedOrder = await resolveOrderForSession(session);
    const orderId = resolvedOrder.orderId;
    const orderNumber = resolvedOrder.orderNumber || session.metadata?.order_number || "";
    console.log("Confirm checkout session:", sessionId, "payment_status=", session.payment_status, "status=", session.status, "order_id=", orderId);
    if (!orderId) {
      return res.status(404).json({ error: "Order metadata missing on session" });
    }

    const isCheckoutConfirmed = session.payment_status === "paid"
      || session.payment_status === "no_payment_required"
      || session.status === "complete";
    if (isCheckoutConfirmed) {
      const { error, updated } = await markOrderPaid(orderId, session.id);

      if (error) {
        console.error("Failed to confirm paid order:", error);
        return res.status(500).json({ error: "Could not update order status" });
      }
      if (!updated) {
        console.error("Confirm endpoint could not find matching order to update. session_id=", session.id, "order_id=", orderId);
        return res.status(500).json({ error: "Could not locate order row for this session" });
      }
      await sendCustomerOrderSms(orderId);
      console.log("Order marked paid from confirm endpoint:", orderId);
    }

    const { data: orderData, error: orderLookupError } = await supabaseAdmin
      .from("orders")
      .select("order_number, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_cost, total")
      .eq("id", orderId)
      .single();
    if (orderLookupError) {
      console.error("Failed to load order details for confirmation:", orderLookupError);
    }

    return res.json({
      orderNumber,
      paymentStatus: session.payment_status,
      customerName: orderData?.customer_name || "",
      customerEmail: orderData?.customer_email || "",
      customerPhone: orderData?.customer_phone || "",
      shippingAddress: orderData?.shipping_address || "",
      subtotal: orderData?.subtotal ?? null,
      tax: orderData?.tax ?? null,
      shippingCost: orderData?.shipping_cost ?? null,
      total: orderData?.total ?? null
    });
  } catch (error) {
    console.error("Failed to confirm checkout session:", error);
    return res.status(500).json({ error: "Could not confirm checkout session" });
  }
});

app.post("/api/confirm-order-number", async (req, res) => {
  try {
    const orderNumber = String(req.body?.orderNumber || "").trim();
    if (!orderNumber) {
      return res.status(400).json({ error: "Missing orderNumber" });
    }

    const { data: orderData, error: lookupError } = await supabaseAdmin
      .from("orders")
      .select("id, order_number, status")
      .eq("order_number", orderNumber)
      .maybeSingle();
    if (lookupError) {
      return res.status(500).json({ error: "Could not load order by number" });
    }
    if (!orderData?.id) {
      return res.status(404).json({ error: "Order not found" });
    }

    const { error, updated } = await markOrderPaid(orderData.id, null);
    if (error || !updated) {
      return res.status(500).json({ error: "Could not mark order paid by number" });
    }
    await sendCustomerOrderSms(orderData.id);
    console.log("Order marked paid from order-number fallback:", orderData.id, orderNumber);

    return res.json({ ok: true, orderId: orderData.id, orderNumber: orderData.order_number });
  } catch (error) {
    console.error("Failed to confirm order number:", error);
    return res.status(500).json({ error: "Could not confirm order number" });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    app: "noire-checkout-server",
    build: "telnyx-sms-2"
  });
});

app.get("/api/payment-columns-health", (_req, res) => {
  res.json({
    ok: paymentColumnsHealth.ready,
    checkedAt: paymentColumnsHealth.checkedAt,
    error: paymentColumnsHealth.error
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function markOrderPaid(orderId, sessionId) {
  const updatePayload = {
    status: "paid",
    paid_at: new Date().toISOString()
  };
  if (sessionId) {
    updatePayload.stripe_session_id = sessionId;
  }

  let response = await supabaseAdmin
    .from("orders")
    .update(updatePayload)
    .eq("id", orderId)
    .neq("status", "paid")
    .select("id");

  // Backward compatible if older schema doesn't include paid_at/stripe_session_id yet.
  if (response.error && response.error.code === "PGRST204") {
    paymentColumnsHealth.ready = false;
    paymentColumnsHealth.error = "Missing stripe_session_id and/or paid_at columns";
    paymentColumnsHealth.checkedAt = new Date().toISOString();
    response = await supabaseAdmin
      .from("orders")
      .update({ status: "paid" })
      .eq("id", orderId)
      .neq("status", "paid")
      .select("id");
  }

  return {
    error: response.error,
    updated: Array.isArray(response.data) && response.data.length > 0
  };
}

async function resolveOrderForSession(session) {
  const metadataOrderId = String(session.metadata?.order_id || "").trim();
  const metadataOrderNumber = String(session.metadata?.order_number || "").trim();
  if (metadataOrderId) {
    return { orderId: metadataOrderId, orderNumber: metadataOrderNumber };
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, order_number")
    .eq("stripe_session_id", session.id)
    .maybeSingle();
  if (error) {
    console.error("Failed to resolve order by stripe_session_id:", error);
    return { orderId: "", orderNumber: metadataOrderNumber };
  }
  if (data?.id) {
    return { orderId: data.id, orderNumber: data.order_number || metadataOrderNumber };
  }
  return { orderId: "", orderNumber: metadataOrderNumber };
}

function formatMoney(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "N/A";
  return "$" + Number(value).toFixed(2);
}

async function fetchOrderForSms(orderId) {
  return await supabaseAdmin
    .from("orders")
    .select("order_number, customer_phone, total")
    .eq("id", orderId)
    .single();
}

function normalizePhoneNumber(rawPhone) {
  const value = String(rawPhone || "").trim();
  if (!value) return "";
  if (value.startsWith("+")) {
    const normalized = "+" + value.slice(1).replace(/\D/g, "");
    return normalized.length >= 11 ? normalized : "";
  }

  const digits = value.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

async function sendCustomerOrderSms(orderId) {
  if (!smsEnabled) {
    console.warn("Skipping SMS: Telnyx is not configured (set TELNYX_API_KEY and TELNYX_FROM_NUMBER).");
    return;
  }
  const { data, error } = await fetchOrderForSms(orderId);
  if (error || !data) {
    console.error("Could not load order for SMS:", error);
    return;
  }
  const toPhone = normalizePhoneNumber(data.customer_phone);
  if (!toPhone) {
    console.warn("Skipping SMS: invalid customer phone format for order", data.order_number, data.customer_phone);
    return;
  }

  const smsBody = [
    `Noire order ${data.order_number || ""} is confirmed.`,
    `Total: ${formatMoney(data.total)}.`,
    "Estimated delivery: 4-7 business days.",
    `How was your site experience? Reply to this text or share feedback: ${FEEDBACK_URL}`
  ].join(" ");

  try {
    const payload = {
      from: TELNYX_FROM_NUMBER,
      to: toPhone,
      text: smsBody
    };
    if (TELNYX_MESSAGING_PROFILE_ID) {
      payload.messaging_profile_id = TELNYX_MESSAGING_PROFILE_ID;
    }

    const response = await fetch("https://api.telnyx.com/v2/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TELNYX_API_KEY}`
      },
      body: JSON.stringify(payload)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errMsg = json.errors?.[0]?.detail || json.message || JSON.stringify(json);
      console.error("Customer SMS failed:", response.status, errMsg);
      return;
    }
    const messageId = json.data?.id || "unknown";
    const recipients = Array.isArray(json.data?.to) ? json.data.to : [];
    const statusLine = recipients
      .map((r) => `${r.phone_number || "?"}=${r.status || "?"}`)
      .join(", ");
    if (json.data?.errors?.length) {
      console.warn("Telnyx message-level errors:", data.order_number, messageId, json.data.errors);
    }
    const failedRecipient = recipients.find((r) =>
      ["sending_failed", "delivery_failed", "expired"].includes(r.status)
    );
    if (failedRecipient) {
      console.warn(
        "Customer SMS failed at carrier/Telnyx:",
        data.order_number,
        messageId,
        statusLine || toPhone,
        failedRecipient.errors || ""
      );
      return;
    }
    console.log(
      "Customer SMS accepted by Telnyx (API OK; handset may still be queued):",
      data.order_number,
      messageId,
      "to",
      toPhone,
      statusLine ? `telnyx_status: ${statusLine}` : ""
    );
  } catch (smsError) {
    console.error("Customer SMS failed:", smsError.message || smsError);
  }
}

async function reconcilePendingOrders() {
  try {
    const { data: pendingOrders, error } = await supabaseAdmin
      .from("orders")
      .select("id, order_number, stripe_session_id")
      .eq("status", "pending")
      .not("stripe_session_id", "is", null)
      .limit(25);
    if (error) {
      console.error("Pending-order reconcile query failed:", error.message || error);
      return;
    }
    if (!pendingOrders || pendingOrders.length === 0) return;

    for (const order of pendingOrders) {
      const sessionId = String(order.stripe_session_id || "").trim();
      if (!sessionId) continue;

      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const isCheckoutConfirmed = session.payment_status === "paid"
          || session.payment_status === "no_payment_required"
          || session.status === "complete";
        if (!isCheckoutConfirmed) continue;

        const { error: updateError, updated } = await markOrderPaid(order.id, sessionId);
        if (updateError) {
          console.error("Reconcile failed to mark order paid:", order.order_number, updateError);
          continue;
        }
        if (updated) {
          await sendCustomerOrderSms(order.id);
          console.log("Reconcile marked order paid:", order.order_number);
        }
      } catch (sessionError) {
        console.error("Reconcile failed to fetch Stripe session:", order.order_number, sessionError.message || sessionError);
      }
    }
  } catch (error) {
    console.error("Unexpected reconcile error:", error.message || error);
  }
}

async function checkOrderPaymentColumns() {
  const { error } = await supabaseAdmin
    .from("orders")
    .select("id, stripe_session_id, paid_at")
    .limit(1);

  paymentColumnsHealth.checkedAt = new Date().toISOString();
  if (error) {
    paymentColumnsHealth.ready = false;
    paymentColumnsHealth.error = error.message || "Unknown schema check error";
    console.warn("Order payment columns check failed:", error.message);
    return;
  }

  paymentColumnsHealth.ready = true;
  paymentColumnsHealth.error = null;
}

app.listen(PORT, () => {
  console.log(`Checkout server running on http://localhost:${PORT}`);
  console.log(`SMS (Telnyx) ${smsEnabled ? "enabled" : "disabled"}.`);
  checkOrderPaymentColumns();
  setInterval(checkOrderPaymentColumns, 5 * 60 * 1000);
  reconcilePendingOrders();
  setInterval(reconcilePendingOrders, 20 * 1000);
});
