/* ============================================================
   VIBRANT WINES — ORDER PORTAL
   app.js — portfolio parsing, filtering, cart, checkout, email.
   No backend. No inventory checks. Reads CONFIG from config.js.
   ============================================================ */

const CART_KEY = "vibrantWinesCart_v1";

let PRODUCERS = [];         // grouped: [{producerId, name, region, bio, why, photos, wines:[...]}]
let WINES = [];             // flat wine list, derived from PRODUCERS, for cart lookups + filter options
let cart = loadCart();      // [{id, qty}]
let activeFilters = { search: "", region: "", style: "", grape: "", producer: "", sort: "default", newArrivalsOnly: false };

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  $("heroMoqNote").innerHTML = `MOQ for free delivery: <strong>${money(CONFIG.FREE_DELIVERY_THRESHOLD)}</strong> (Delivery fee: ${money(CONFIG.DELIVERY_FEE)} below this)`;

  wireStaticEvents();
  renderCart();

  try {
    const html = await fetchPortfolioHtml(CONFIG.PORTFOLIO_URL);
    PRODUCERS = parsePortfolio(html);
    WINES = PRODUCERS.flatMap(p => p.wines);
    if (WINES.length === 0) throw new Error("No wines found on the portfolio page.");
    buildFilterOptions(WINES);
    renderProducts();
  } catch (err) {
    console.error(err);
    $("mainContent").innerHTML = `
      <div class="load-error">
        <p><strong>We couldn't load the current wine list.</strong></p>
        <p>${escapeHtml(err.message || String(err))}</p>
        <p>This usually means the portfolio page at <code>${escapeHtml(CONFIG.PORTFOLIO_URL)}</code>
        is unreachable, or the browser blocked the cross-site request. Try refreshing the page,
        or contact info@vibrantwines.com if this keeps happening.</p>
      </div>`;
  }
}

/* ============================================================
   FETCH + PARSE THE SOURCE PORTFOLIO PAGE
   ============================================================ */

async function fetchPortfolioHtml(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Portfolio page returned HTTP ${res.status}.`);
  return await res.text();
}

function parsePortfolio(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const sections = doc.querySelectorAll("section.producer");
  const producers = [];

  sections.forEach((section, sectionIndex) => {
    const h1 = section.querySelector("h1");
    if (!h1) return;
    const producerName = cleanText(h1.textContent);

    const eyebrowEl = section.querySelector(".eyebrow");
    let region = eyebrowEl ? cleanText(eyebrowEl.textContent) : "Other";
    region = region.split("—")[0].trim();
    region = toTitleCase(region);

    const subtitleEl = section.querySelector(".subtitle");
    const subtitle = subtitleEl ? cleanText(subtitleEl.textContent) : "";

    const etaEl = section.querySelector(".eta-note");
    const eta = etaEl ? cleanText(etaEl.textContent) : "";

    const bioEl = section.querySelector(".bio");
    const bio = bioEl ? cleanText(bioEl.textContent) : "";

    const whyEl = section.querySelector(".why p");
    const why = whyEl ? cleanText(whyEl.textContent) : "";

    const photos = Array.from(section.querySelectorAll(".bandeau img")).map(img => {
      const src = img.getAttribute("src");
      if (!src) return null;
      // Preserve the source catalog's own hand-tuned height for this producer's
      // photo set (e.g. "75mm", "55mm") — it's deliberately different per
      // producer depending on each photo's shape, and is the actual reason
      // photos look right on the source site. Fall back to a sane default
      // only if the source page ever omits it.
      const inlineStyle = img.getAttribute("style") || "";
      const heightMatch = inlineStyle.match(/height:\s*([0-9.]+[a-z%]+)/i);
      return {
        url: new URL(src, CONFIG.PORTFOLIO_URL).href,
        height: heightMatch ? heightMatch[1] : "75mm",
      };
    }).filter(Boolean);

    const producerId = slugify(`${sectionIndex}__${producerName}`);
    const wines = [];

    const rows = section.querySelectorAll("table.wines tbody tr, table.wines tr");
    rows.forEach((tr) => {
      const cuveeTd = tr.querySelector("td.cuvee");
      const vintageTd = tr.querySelector("td.vintage");
      const descTd = tr.querySelector("td.desc");
      const priceTd = tr.querySelector("td.price");
      if ((!cuveeTd && !vintageTd) || !priceTd) return;

      let cuveeName, typeText;
      if (cuveeTd) {
        const typeEl = cuveeTd.querySelector(".type");
        typeText = typeEl ? cleanText(typeEl.textContent) : "";
        const cuveeClone = cuveeTd.cloneNode(true);
        const typeInClone = cuveeClone.querySelector(".type");
        if (typeInClone) typeInClone.remove();
        cuveeName = cleanText(cuveeClone.textContent);
      } else {
        // Vintage-style table (e.g. a single wine listed across many
        // vintages, like Château Bel Air Marquis d'Aligre) — the source
        // uses a "vintage" column instead of "cuvee". Use the vintage
        // year itself as the cuvée, and extract any .type span the same
        // way as the cuvee branch above (the source embeds it inside the
        // vintage cell too, e.g. <td class="vintage">2018<span class="type">...).
        const typeEl = vintageTd.querySelector(".type");
        typeText = typeEl ? cleanText(typeEl.textContent) : "";
        const vintageClone = vintageTd.cloneNode(true);
        const typeInClone = vintageClone.querySelector(".type");
        if (typeInClone) typeInClone.remove();
        cuveeName = cleanText(vintageClone.textContent);
      }
      if (!cuveeName) return;

      const priceRaw = cleanText(priceTd.textContent);
      const soldOut = /sold\s*out/i.test(priceRaw);
      const priceNum = soldOut ? null : parseFloat(priceRaw.replace(/[^0-9.]/g, ""));

      const { style, grape } = splitStyleGrape(typeText);
      const id = slugify(`${producerName}__${cuveeName}`);

      wines.push({
        id, producerId, producer: producerName, region, eta,
        cuvee: cuveeName, type: typeText, style, grape,
        desc: descTd ? cleanText(descTd.textContent) : "",
        price: priceNum, soldOut,
      });
    });

    if (wines.length === 0) return;

    producers.push({
      producerId, name: producerName, region, subtitle, eta, bio, why, photos, wines,
    });
  });

  return producers;
}

function splitStyleGrape(typeText) {
  if (!typeText) return { style: "", grape: "" };
  const m = typeText.match(/^([^(]+)\(?([^)]*)\)?$/);
  const style = m ? m[1].trim() : typeText.trim();
  const grape = m && m[2] ? m[2].trim() : "";
  return { style, grape };
}

function cleanText(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function toTitleCase(s) {
  // Region eyebrows are ALL CAPS on the source site; keep proper wine-region casing.
  const smallWords = new Set(["de", "du", "des", "la", "le", "les", "et", "d'"]);
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      if (i > 0 && smallWords.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function slugify(s) {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/* ============================================================
   FILTER BAR
   ============================================================ */

function buildFilterOptions(wines) {
  fillSelect("producerFilter", uniqueSorted(wines.map(w => w.producer)));
  fillSelect("regionFilter", uniqueSorted(wines.map(p => p.region)));
  fillSelect("styleFilter", uniqueSorted(wines.map(p => p.style).filter(Boolean)));
  fillSelect("grapeFilter", uniqueSorted(wines.flatMap(p => splitGrapeList(p.grape))));
}

function splitGrapeList(grape) {
  if (!grape) return [];
  return grape.split(/\s*\/\s*|\s*,\s*/).map(g => g.trim()).filter(Boolean);
}

function uniqueSorted(arr) {
  return [...new Set(arr)].sort((a, b) => a.localeCompare(b));
}

function fillSelect(id, values) {
  const el = $(id);
  values.forEach(v => {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    el.appendChild(opt);
  });
}

function wireStaticEvents() {
  $("searchInput").addEventListener("input", (e) => { activeFilters.search = e.target.value.toLowerCase(); renderProducts(); });
  $("producerFilter").addEventListener("change", (e) => { activeFilters.producer = e.target.value; renderProducts(); });
  $("regionFilter").addEventListener("change", (e) => { activeFilters.region = e.target.value; renderProducts(); });
  $("styleFilter").addEventListener("change", (e) => { activeFilters.style = e.target.value; renderProducts(); });
  $("grapeFilter").addEventListener("change", (e) => { activeFilters.grape = e.target.value; renderProducts(); });
  $("sortSelect").addEventListener("change", (e) => { activeFilters.sort = e.target.value; renderProducts(); });
  $("newArrivalsFilter").addEventListener("change", (e) => { activeFilters.newArrivalsOnly = e.target.checked; renderProducts(); });
  $("resetFilters").addEventListener("click", () => {
    activeFilters = { search: "", region: "", style: "", grape: "", producer: "", sort: "default", newArrivalsOnly: false };
    $("searchInput").value = "";
    $("producerFilter").value = "";
    $("regionFilter").value = "";
    $("styleFilter").value = "";
    $("grapeFilter").value = "";
    $("sortSelect").value = "default";
    $("newArrivalsFilter").checked = false;
    renderProducts();
  });

  $("openCartBtn").addEventListener("click", openCart);
  $("fabCartBtn").addEventListener("click", openCart);
  $("closeCartBtn").addEventListener("click", closeCart);
  $("overlay").addEventListener("click", closeCart);
  $("checkoutBtn").addEventListener("click", openCheckout);
  $("closeCheckoutBtn").addEventListener("click", closeCheckout);
  $("continueShoppingBtn").addEventListener("click", closeCheckout);
  $("orderForm").addEventListener("submit", submitOrder);

  wireScrollHideFilterBar();
}

/* Hides the filter/search bar while the user is scrolling down (to free
   up screen space, especially useful on mobile), and brings it back as
   soon as they scroll up even slightly — a standard, familiar pattern.
   The top bar (logo + Cart button) is intentionally NOT affected. */
function wireScrollHideFilterBar() {
  const bar = $("filterBar");
  let lastY = window.scrollY;
  let ticking = false;

  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const currentY = window.scrollY;
      const scrollingDown = currentY > lastY;
      if (scrollingDown && currentY > 120) {
        bar.classList.add("filterbar-hidden");
      } else {
        bar.classList.remove("filterbar-hidden");
      }
      lastY = currentY;
      ticking = false;
    });
  }, { passive: true });
}

/* ============================================================
   CATALOG RENDER
   Mirrors the source portfolio page's own layout (producer bio,
   photos, tasting-note table) with an Add-to-Cart column injected
   into each wine row. Filtering hides non-matching rows and, if a
   producer has zero visible rows left, hides that whole section.
   ============================================================ */

function matchesFilters(wine) {
  if (CONFIG.HIDE_SOLD_OUT && wine.soldOut) return false;
  if (activeFilters.newArrivalsOnly && !/new arrivals/i.test(wine.eta || "")) return false;
  if (activeFilters.producer && wine.producer !== activeFilters.producer) return false;
  if (activeFilters.region && wine.region !== activeFilters.region) return false;
  if (activeFilters.style && wine.style !== activeFilters.style) return false;
  if (activeFilters.grape && !splitGrapeList(wine.grape).includes(activeFilters.grape)) return false;
  if (activeFilters.search) {
    const hay = `${wine.producer} ${wine.cuvee} ${wine.desc}`.toLowerCase();
    if (!hay.includes(activeFilters.search)) return false;
  }
  return true;
}

function sortWines(wines) {
  if (activeFilters.sort === "price-asc") return [...wines].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  if (activeFilters.sort === "price-desc") return [...wines].sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity));
  if (activeFilters.sort === "name-asc") return [...wines].sort((a, b) => a.cuvee.localeCompare(b.cuvee));
  return wines;
}

function renderProducts() {
  let totalVisible = 0;
  let html = "";

  PRODUCERS.forEach(producer => {
    const visibleWines = sortWines(producer.wines.filter(matchesFilters));
    if (visibleWines.length === 0) return;
    totalVisible += visibleWines.length;
    html += producerSection(producer, visibleWines);
  });

  $("resultCount").textContent = `${totalVisible} wine${totalVisible === 1 ? "" : "s"}`;

  $("mainContent").innerHTML = totalVisible === 0
    ? `<div class="empty-state">No wines match your filters. Try clearing a filter or search term.</div>`
    : html;

  $("mainContent").querySelectorAll("[data-action]").forEach(el => {
    el.addEventListener("click", handleProductAction);
  });
}

function producerSection(producer, visibleWines) {
  const photosHtml = producer.photos.length
    ? `<div class="producer-photos">${producer.photos.slice(0, 3).map(p => `<img src="${escapeHtml(p.url)}" alt="" loading="lazy" style="height:${escapeHtml(p.height)}">`).join("")}</div>`
    : "";

  return `
    <section class="producer-block">
      <div class="producer-head">
        <div class="producer-eyebrow">${escapeHtml(producer.region)}</div>
        <h2 class="producer-name">${escapeHtml(producer.name)}</h2>
        ${producer.subtitle ? `<div class="producer-subtitle">${escapeHtml(producer.subtitle)}</div>` : ""}
        ${producer.eta ? `<div class="card-eta">${escapeHtml(producer.eta)}</div>` : ""}
        ${producer.bio ? `<p class="producer-bio">${escapeHtml(producer.bio)}</p>` : ""}
        ${producer.why ? `<div class="why-box"><span class="why-label">Why Vibrant</span><p>${escapeHtml(producer.why)}</p></div>` : ""}
      </div>

      <div class="wines-table-wrap">
        <table class="wines-table">
          <thead>
            <tr><th class="col-cuvee">Cuvée</th><th class="col-desc">Tasting Note</th><th class="col-price">Price</th><th class="col-cart"></th></tr>
          </thead>
          <tbody>
            ${visibleWines.map(wineRow).join("")}
          </tbody>
        </table>
      </div>

      ${photosHtml}
    </section>`;
}

function wineRow(w) {
  const inCart = cart.find(i => i.id === w.id);
  const qty = inCart ? inCart.qty : 0;

  let actionHtml;
  if (w.soldOut) {
    actionHtml = `<span class="sold-out-label">Sold out</span>`;
  } else if (qty > 0) {
    actionHtml = `
      <div class="qty-stepper">
        <button type="button" data-action="dec" data-id="${escapeHtml(w.id)}">&minus;</button>
        <span class="qty-val">${qty}</span>
        <button type="button" data-action="inc" data-id="${escapeHtml(w.id)}">+</button>
      </div>`;
  } else {
    actionHtml = `<button type="button" class="add-btn" data-action="add" data-id="${escapeHtml(w.id)}">Add</button>`;
  }

  return `
    <tr>
      <td class="col-cuvee" data-label="Cuvée">
        <div class="row-cuvee-name">${escapeHtml(w.cuvee)}</div>
        ${w.type ? `<div class="row-type">${escapeHtml(w.type)}</div>` : ""}
      </td>
      <td class="col-desc" data-label="Tasting Note">${escapeHtml(w.desc)}</td>
      <td class="col-price" data-label="Price">${w.soldOut ? "" : money(w.price)}</td>
      <td class="col-cart" data-label="">${actionHtml}</td>
    </tr>`;
}

function handleProductAction(e) {
  const action = e.currentTarget.dataset.action;
  const id = e.currentTarget.dataset.id;
  if (action === "add") addToCart(id);
  else if (action === "inc") changeQty(id, 1);
  else if (action === "dec") changeQty(id, -1);
}

/* ============================================================
   CART (persisted to localStorage, keyed by stable product id)
   ============================================================ */

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveCart() {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
}

function addToCart(id) {
  const item = cart.find(i => i.id === id);
  if (item) item.qty += 1;
  else cart.push({ id, qty: 1 });
  saveCart();
  renderProducts();
  renderCart();
}

function changeQty(id, delta) {
  const item = cart.find(i => i.id === id);
  if (!item) return;
  item.qty += delta;
  if (item.qty <= 0) cart = cart.filter(i => i.id !== id);
  saveCart();
  renderProducts();
  renderCart();
}

function removeFromCart(id) {
  cart = cart.filter(i => i.id !== id);
  saveCart();
  renderProducts();
  renderCart();
}

function getCartDetailed() {
  return cart
    .map(i => {
      const p = WINES.find(x => x.id === i.id);
      return p ? { ...p, qty: i.qty, lineTotal: (p.price || 0) * i.qty } : null;
    })
    .filter(Boolean);
}

function cartSubtotal() {
  return getCartDetailed().reduce((sum, x) => sum + x.lineTotal, 0);
}

function deliveryFee() {
  const subtotal = cartSubtotal();
  if (subtotal === 0) return 0;
  return subtotal < CONFIG.FREE_DELIVERY_THRESHOLD ? CONFIG.DELIVERY_FEE : 0;
}

function cartGrandTotal() {
  return cartSubtotal() + deliveryFee();
}

function money(n) {
  return `$${Number(n).toLocaleString("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function renderCart() {
  const detailed = getCartDetailed();
  const totalQty = detailed.reduce((sum, x) => sum + x.qty, 0);
  $("cartCount").textContent = totalQty;
  $("fabCartCount").textContent = totalQty;

  if (detailed.length === 0) {
    $("cartBody").innerHTML = `<div class="drawer-empty">Your cart is empty.</div>`;
    $("cartFooter").style.display = "none";
    return;
  }

  $("cartBody").innerHTML = detailed.map(x => `
    <div class="cart-line">
      <div class="cart-line-info">
        <div class="cart-line-name">${escapeHtml(x.producer)} — ${escapeHtml(x.cuvee)}</div>
        <div class="cart-line-meta">${escapeHtml(x.type || "")}</div>
        <div class="cart-line-controls">
          <div class="qty-stepper">
            <button type="button" data-action="dec" data-id="${escapeHtml(x.id)}">&minus;</button>
            <span class="qty-val">${x.qty}</span>
            <button type="button" data-action="inc" data-id="${escapeHtml(x.id)}">+</button>
          </div>
          <span class="cart-line-price">${money(x.lineTotal)}</span>
        </div>
        <button type="button" class="remove-link" data-action="remove" data-id="${escapeHtml(x.id)}">Remove</button>
      </div>
    </div>`).join("");

  $("cartBody").querySelectorAll("[data-action]").forEach(el => {
    el.addEventListener("click", (e) => {
      const action = e.currentTarget.dataset.action;
      const id = e.currentTarget.dataset.id;
      if (action === "inc") changeQty(id, 1);
      else if (action === "dec") changeQty(id, -1);
      else if (action === "remove") removeFromCart(id);
    });
  });

  $("cartFooter").style.display = "block";
  const subtotal = cartSubtotal();
  const fee = deliveryFee();
  let breakdownHtml = `<div class="cart-breakdown-line"><span>Subtotal</span><span>${money(subtotal)}</span></div>`;
  if (fee > 0) {
    breakdownHtml += `<div class="cart-breakdown-line delivery-line"><span>Delivery fee</span><span>${money(fee)}</span></div>`;
  } else {
    breakdownHtml += `<div class="cart-breakdown-line free-line">✓ Free delivery</div>`;
  }
  breakdownHtml += `<div class="drawer-total"><span>Total${escapeHtml(CONFIG.PRICE_LABEL_SUFFIX)}</span><strong>${money(cartGrandTotal())}</strong></div>`;
  $("cartBreakdown").innerHTML = breakdownHtml;
}

function openCart() { $("cartDrawer").classList.add("open"); $("overlay").classList.add("open"); }
function closeCart() { $("cartDrawer").classList.remove("open"); $("overlay").classList.remove("open"); }

/* ============================================================
   CHECKOUT
   ============================================================ */

function openCheckout() {
  if (cart.length === 0) return;
  closeCart();
  $("checkoutStep").style.display = "block";
  $("thankYouStep").style.display = "none";
  $("modalTitle").textContent = "Checkout";
  $("deliveryNote").textContent = `Free delivery over ${money(CONFIG.FREE_DELIVERY_THRESHOLD)}. ${money(CONFIG.DELIVERY_FEE)} delivery fee for orders below ${money(CONFIG.FREE_DELIVERY_THRESHOLD)}.`;
  renderOrderSummary();
  $("checkoutOverlay").classList.add("open");
}

function closeCheckout() {
  $("checkoutOverlay").classList.remove("open");
}

function renderOrderSummary() {
  const detailed = getCartDetailed();
  const subtotal = cartSubtotal();
  const fee = deliveryFee();
  let html = detailed.map(x => `
      <div class="order-summary-line">
        <span>${escapeHtml(x.producer)} — ${escapeHtml(x.cuvee)} &times; ${x.qty}</span>
        <span>${money(x.lineTotal)}</span>
      </div>`).join("");
  html += `<div class="order-summary-line"><span>Subtotal</span><span>${money(subtotal)}</span></div>`;
  html += fee > 0
    ? `<div class="order-summary-line"><span>Delivery fee</span><span>${money(fee)}</span></div>`
    : `<div class="order-summary-line"><span>Delivery</span><span>Free</span></div>`;
  html += `<div class="order-summary-total"><span>Total${escapeHtml(CONFIG.PRICE_LABEL_SUFFIX)}</span><span>${money(cartGrandTotal())}</span></div>`;
  $("orderSummary").innerHTML = html;
}

async function submitOrder(e) {
  e.preventDefault();
  const name = $("custName").value.trim();
  const phone = $("custPhone").value.trim();
  const email = $("custEmail").value.trim();
  const address = $("custAddress").value.trim();
  const instructions = $("custInstructions").value.trim();
  const paymentPreference = $("paymentPreference").value;

  if (!name || !phone || !email || !address || !paymentPreference) return;

  const detailed = getCartDetailed();
  if (detailed.length === 0) return;

  const submitBtn = $("submitOrderBtn");
  const status = $("formStatus");
  submitBtn.disabled = true;
  status.className = "form-status sending";
  status.textContent = "Sending your order…";

  const subtotal = cartSubtotal();
  const fee = deliveryFee();
  const itemsText = detailed.map(x => `${x.producer} — ${x.cuvee} (${x.type || ""}) x${x.qty} = ${money(x.lineTotal)}`).join("\n")
    + `\n\nSubtotal: ${money(subtotal)}`
    + (fee > 0 ? `\nDelivery fee: ${money(fee)}` : `\nDelivery: Free`);
  const itemsHtml = detailed.map(x => `<div>${escapeHtml(x.producer)} — ${escapeHtml(x.cuvee)} (${escapeHtml(x.type || "")}) &times; ${x.qty} = ${money(x.lineTotal)}</div>`).join("")
    + `<div><br>Subtotal: ${money(subtotal)}</div>`
    + (fee > 0 ? `<div>Delivery fee: ${money(fee)}</div>` : `<div>Delivery: Free</div>`);
  const totalStr = money(cartGrandTotal()) + CONFIG.PRICE_LABEL_SUFFIX;
  const orderDate = new Date().toLocaleString("en-SG", { dateStyle: "medium", timeStyle: "short" });

  const commonParams = {
    customer_name: name,
    customer_phone: phone,
    customer_email: email,
    customer_address: address,
    delivery_instructions: instructions || "—",
    payment_preference: paymentPreference,
    order_items_text: itemsText,
    order_items_html: itemsHtml,
    order_subtotal: money(subtotal),
    delivery_fee: fee > 0 ? money(fee) : "Free",
    order_total: totalStr,
    order_date: orderDate,
    to_email: email,
    admin_email: CONFIG.ADMIN_EMAIL,
  };

  try {
    if (!window.emailjs || !CONFIG.EMAILJS_PUBLIC_KEY || CONFIG.EMAILJS_PUBLIC_KEY.startsWith("PASTE_")) {
      throw new Error("Email is not configured yet (see config.js).");
    }
    emailjs.init({ publicKey: CONFIG.EMAILJS_PUBLIC_KEY });

    await emailjs.send(CONFIG.EMAILJS_SERVICE_ID, CONFIG.EMAILJS_ADMIN_TEMPLATE_ID, commonParams);

    cart = [];
    saveCart();
    renderCart();
    renderProducts();

    $("checkoutStep").style.display = "none";
    $("thankYouStep").style.display = "block";
    $("thankYouName").textContent = `, ${name}`;
    $("orderForm").reset();
    status.textContent = "";
  } catch (err) {
    console.error(err);
    status.className = "form-status error";
    status.textContent = `We couldn't send your order automatically (${err.message || err}). Please email your order to ${CONFIG.ADMIN_EMAIL} directly, or try again.`;
  } finally {
    submitBtn.disabled = false;
  }
}

/* ============================================================
   UTIL
   ============================================================ */

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
