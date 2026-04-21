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
  SUPABASE_ANON_KEY,
  ADMIN_PROMO_SECRET,
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

function createUserSupabaseClient(authHeader) {
  if (!SUPABASE_ANON_KEY) return null;
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader || "" } }
  });
}

async function getUserFromRequest(req) {
  const authHeader = String(req.headers.authorization || "").trim();
  if (!authHeader.startsWith("Bearer ")) return null;
  const client = createUserSupabaseClient(authHeader);
  if (!client) return null;
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user) return null;
  return data.user;
}

function normalizePromoCode(code) {
  return String(code || "").trim().toUpperCase();
}

async function validatePromoForUser(codeRaw, userId) {
  const code = normalizePromoCode(codeRaw);
  if (!code) {
    return { ok: false, error: "Enter a promo code." };
  }
  const { data: row, error } = await supabaseAdmin
    .from("promo_codes")
    .select("code, percent_off, max_total_redemptions, per_user_limit, active")
    .eq("code", code)
    .maybeSingle();
  if (error) {
    console.error("promo_codes read failed:", error.message);
    return { ok: false, error: "Promo validation unavailable." };
  }
  if (!row || !row.active) {
    return { ok: false, error: "Invalid or inactive promo code." };
  }
  const { count: globalCount, error: globalErr } = await supabaseAdmin
    .from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promo_code", code);
  if (globalErr) {
    return { ok: false, error: "Could not validate promo code." };
  }
  if (row.max_total_redemptions != null && (globalCount ?? 0) >= row.max_total_redemptions) {
    return { ok: false, error: "This promo code is no longer available." };
  }
  const { count: userCount, error: userErr } = await supabaseAdmin
    .from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("promo_code", code)
    .eq("user_id", userId);
  if (userErr) {
    return { ok: false, error: "Could not validate promo code." };
  }
  const limit = Math.max(1, Number(row.per_user_limit) || 1);
  if ((userCount ?? 0) >= limit) {
    return { ok: false, error: "You have already used this promo code." };
  }
  return {
    ok: true,
    code,
    percentOff: Math.min(100, Math.max(0, Number(row.percent_off) || 0))
  };
}

function buildShippingAddressString(customer) {
  const single = String(customer.shippingAddress || "").trim();
  if (single) return single;
  const line1 = String(customer.addressLine1 || "").trim();
  const line2 = String(customer.addressLine2 || "").trim();
  const city = String(customer.city || "").trim();
  const state = String(customer.state || "").trim();
  const postal = String(customer.postalCode || "").trim();
  const country = String(customer.country || "").trim() || "United States";
  const parts = [line1, line2, [city, state, postal].filter(Boolean).join(", "), country].filter(Boolean);
  return parts.join("\n");
}

function computeCartSubtotal(cart) {
  let subtotal = 0;
  let hasUnknown = false;
  for (const item of cart) {
    const quantity = Math.max(1, Number(item.quantity) || 1);
    const unitPrice = Number(item.price);
    if (Number.isNaN(unitPrice) || item.price === null) {
      hasUnknown = true;
      break;
    }
    subtotal += unitPrice * quantity;
  }
  return { subtotal, hasUnknown };
}

function computeTotalsWithDiscount(cart, discountPercent) {
  const { subtotal, hasUnknown } = computeCartSubtotal(cart);
  if (hasUnknown) {
    return { subtotal: null, tax: null, shipping: null, total: null, hasUnknownPrice: true };
  }
  const factor = discountPercent > 0 ? 1 - Math.min(100, discountPercent) / 100 : 1;
  const discountedSubtotal = subtotal * factor;
  const tax = discountedSubtotal * 0.08;
  const shipping = discountedSubtotal > 0 ? 6.99 : 0;
  return {
    subtotal: discountedSubtotal,
    tax,
    shipping,
    total: discountedSubtotal + tax + shipping,
    hasUnknownPrice: false,
    discountPercent
  };
}

async function recordPromoRedemptionIfNeeded(orderId) {
  try {
    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("id, promo_code, shopper_user_id")
      .eq("id", orderId)
      .maybeSingle();
    if (error || !order?.promo_code || !order?.shopper_user_id) return;
    const { error: insertError } = await supabaseAdmin.from("promo_redemptions").insert({
      user_id: order.shopper_user_id,
      promo_code: order.promo_code,
      order_id: order.id
    });
    if (insertError && insertError.code !== "23505") {
      console.error("Promo redemption insert failed:", insertError.message || insertError);
    }
  } catch (e) {
    console.warn("recordPromoRedemptionIfNeeded:", e.message || e);
  }
}
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
    const isRenderPreview = /^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin);
    if (origin === FRONTEND_URL || isLocalhostOrigin || isRenderPreview) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  }
}));

app.use((error, _req, res, next) => {
  if (!error) return next();
  if (error.message && error.message.startsWith("CORS blocked")) {
    return res.status(403).json({ error: error.message });
  }
  return next(error);
});

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

app.post("/api/promo/validate", async (req, res) => {
  try {
    const user = await getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Sign in or create an account to use a promo code." });
    }
    const code = req.body?.code;
    const result = await validatePromoForUser(code, user.id);
    if (!result.ok) {
      return res.status(400).json({ ok: false, error: result.error });
    }
    return res.json({ ok: true, code: result.code, percentOff: result.percentOff });
  } catch (error) {
    console.error("Promo validate error:", error);
    return res.status(500).json({ ok: false, error: "Promo validation failed." });
  }
});

app.get("/api/admin/promos", async (req, res) => {
  if (!ADMIN_PROMO_SECRET) {
    return res.status(503).json({ error: "ADMIN_PROMO_SECRET is not configured." });
  }
  if (String(req.headers["x-admin-secret"] || "") !== ADMIN_PROMO_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .select("code, percent_off, max_total_redemptions, per_user_limit, active, created_at")
    .order("created_at", { ascending: false });
  if (error) {
    return res.status(500).json({ error: error.message });
  }
  return res.json({ promos: data || [] });
});

app.post("/api/admin/promos", async (req, res) => {
  if (!ADMIN_PROMO_SECRET) {
    return res.status(503).json({ error: "ADMIN_PROMO_SECRET is not configured." });
  }
  if (String(req.headers["x-admin-secret"] || "") !== ADMIN_PROMO_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const body = req.body || {};
  const code = normalizePromoCode(body.code);
  const percentOff = Number(body.percentOff);
  const perUserLimit = Math.max(1, parseInt(body.perUserLimit, 10) || 1);
  const maxTotal = body.maxTotalRedemptions;
  const maxTotalRedemptions = maxTotal === null || maxTotal === "" || maxTotal === undefined
    ? null
    : Math.max(0, parseInt(maxTotal, 10));
  const active = body.active !== false;
  if (!code || Number.isNaN(percentOff) || percentOff <= 0 || percentOff > 100) {
    return res.status(400).json({ error: "Invalid code or percentOff (1-100)." });
  }
  const { data, error } = await supabaseAdmin
    .from("promo_codes")
    .upsert({
      code,
      percent_off: percentOff,
      max_total_redemptions: maxTotalRedemptions,
      per_user_limit: perUserLimit,
      active
    }, { onConflict: "code" })
    .select("code, percent_off, max_total_redemptions, per_user_limit, active")
    .single();
  if (error) {
    console.error("Admin promo upsert failed:", error);
    return res.status(500).json({ error: error.message || "Save failed" });
  }
  return res.json({ ok: true, promo: data });
});

app.post("/api/create-checkout-session", async (req, res) => {
  try {
    const { customer, cart, totals, promoCode: promoCodeRaw } = req.body || {};
    if (!customer || !Array.isArray(cart) || cart.length === 0 || !totals) {
      return res.status(400).json({ error: "Missing checkout payload." });
    }

    const customerName = String(customer.name || "").trim();
    const customerEmail = String(customer.email || "").trim().toLowerCase();
    const customerPhone = String(customer.phone || "").trim();
    const shippingAddress = buildShippingAddressString(customer);
    const notes = String(customer.notes || "").trim();
    if (!customerName || !customerEmail || !customerPhone || !shippingAddress) {
      return res.status(400).json({ error: "Missing required customer fields." });
    }

    const promoCodeInput = String(promoCodeRaw || "").trim();
    const user = await getUserFromRequest(req);
    let discountPercent = 0;
    let appliedPromoCode = null;
    if (promoCodeInput) {
      if (!user) {
        return res.status(401).json({ error: "Sign in or create an account to use a promo code." });
      }
      const promoResult = await validatePromoForUser(promoCodeInput, user.id);
      if (!promoResult.ok) {
        return res.status(400).json({ error: promoResult.error });
      }
      discountPercent = promoResult.percentOff;
      appliedPromoCode = promoResult.code;
    }

    const serverTotals = computeTotalsWithDiscount(cart, discountPercent);
    if (serverTotals.hasUnknownPrice || serverTotals.total === null) {
      return res.status(400).json({ error: "Invalid cart pricing." });
    }

    const { subtotal, tax, shipping: shippingCost, total } = serverTotals;
    const clientSubtotal = Number(totals.subtotal);
    const clientTax = Number(totals.tax);
    const clientShip = Number(totals.shipping);
    const clientTotal = Number(totals.total);
    const drift = Math.abs(clientSubtotal - subtotal) + Math.abs(clientTax - tax)
      + Math.abs(clientShip - shippingCost) + Math.abs(clientTotal - total);
    if (drift > 0.02) {
      return res.status(400).json({ error: "Order totals are out of date. Refresh checkout and try again." });
    }

    const discountFactor = discountPercent > 0 ? 1 - Math.min(100, discountPercent) / 100 : 1;

    const lineItems = cart.map((item) => {
      const quantity = Math.max(1, Number(item.quantity) || 1);
      const unitPrice = Number(item.price) || 0;
      const variantText = item.color ? ` (${item.color})` : "";
      return {
        price_data: {
          currency: "usd",
          product_data: { name: `${item.name}${variantText}` },
          unit_amount: Math.max(0, Math.round(unitPrice * 100 * discountFactor))
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
    const orderInsert = {
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
      owner_notification_email: customerEmail
    };
    if (appliedPromoCode) {
      orderInsert.promo_code = appliedPromoCode;
      orderInsert.discount_percent = discountPercent;
      orderInsert.shopper_user_id = user.id;
    }

    const { data: orderRow, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert(orderInsert)
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

  const updated = Array.isArray(response.data) && response.data.length > 0;
  if (updated) {
    await recordPromoRedemptionIfNeeded(orderId);
  }

  return {
    error: response.error,
    updated
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
