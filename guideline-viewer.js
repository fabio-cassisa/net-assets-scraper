// ─── Brand Guideline Viewer ──────────────────────────────────────────
// Extension page that renders brand kit data with full interactivity.
// Data arrives via chrome.storage.session (set by panel.js before opening).
// This is a 'self' script — CSP allows it on chrome-extension:// pages.

(async function () {
  const esc = (s) => {
    const d = document.createElement("div");
    d.textContent = String(s || "");
    return d.innerHTML;
  };

  // ── Load kit data from session storage ──
  let kit;
  try {
    const result = await chrome.storage.session.get("guidelineKit");
    kit = result.guidelineKit;
  } catch (e) {
    // Fallback for older Chrome without session storage
    const result = await chrome.storage.local.get("guidelineKit");
    kit = result.guidelineKit;
  }

  const loading = document.getElementById("loadingState");
  const content = document.getElementById("content");

  if (!kit) {
    loading.textContent = "No brand data found. Scan a page first, then click Open Brand Guideline.";
    return;
  }

  // ── Auto-detect theme: dark brands → light page ──
  function hexLuminance(hex) {
    const c = (hex || "#000000").replace("#", "");
    const r = parseInt(c.substr(0, 2), 16) / 255;
    const g = parseInt(c.substr(2, 2), 16) / 255;
    const b = parseInt(c.substr(4, 2), 16) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  const allHexes = (kit.colors.all || []).map((c) => c.hex).filter(Boolean);
  const avgLum = allHexes.length > 0 ? allHexes.reduce((sum, h) => sum + hexLuminance(h), 0) / allHexes.length : 0.5;
  const themeToggle = document.getElementById("themeToggle");

  // Check localStorage for user preference, otherwise auto-detect
  const stored = localStorage.getItem("nas-guide-theme");
  if (stored === "light") {
    themeToggle.checked = true;
  } else if (stored === "dark") {
    themeToggle.checked = false;
  } else if (avgLum < 0.4) {
    // Dark brand → light page for contrast
    themeToggle.checked = true;
  }

  // Persist theme changes
  themeToggle.addEventListener("change", () => {
    localStorage.setItem("nas-guide-theme", themeToggle.checked ? "light" : "dark");
  });

  // ── Toast ──
  const toastEl = document.getElementById("toast");
  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastEl._tid);
    toastEl._tid = setTimeout(() => toastEl.classList.remove("show"), 1800);
  }

  // ── Copy helper ──
  function copyText(text) {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => showToast("Copied: " + text.substring(0, 50)),
      () => showToast("Select and Cmd+C to copy")
    );
  }

  // ── Download helper — creates a Blob download link ──
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    showToast("Downloaded: " + filename);
  }

  // ─── Token Generators ─────────────────────────────────────────────

  /** Generate CSS custom properties from brand kit */
  function generateBrandTokensCSS(kit) {
    const lines = [
      "/* ─── Brand Tokens ─── */",
      `/* Generated from ${kit.brand.name || "Brand"} · ${kit.brand.url || ""} */`,
      `/* ${new Date(kit.exportedAt).toISOString()} */`,
      "",
      ":root {",
    ];

    // Colors
    lines.push("  /* Colors */");
    if (kit.colors.primary) lines.push(`  --brand-primary: ${kit.colors.primary};`);
    if (kit.colors.secondary) lines.push(`  --brand-secondary: ${kit.colors.secondary};`);
    if (kit.colors.background) lines.push(`  --brand-bg: ${kit.colors.background};`);
    if (kit.colors.text) lines.push(`  --brand-text: ${kit.colors.text};`);
    (kit.colors.all || []).forEach((c, i) => {
      lines.push(`  --brand-color-${i + 1}: ${c.hex};${c.name ? " /* " + c.name + " */" : ""}`);
    });

    // Typography
    const scale = kit.typography.scale || [];
    const declared = kit.typography.fonts?.declared || [];
    if (declared.length > 0 || scale.length > 0) {
      lines.push("");
      lines.push("  /* Typography */");
    }
    const headingFont = declared.find((f) => f.name) || scale.find((t) => t.element?.startsWith("h"));
    const bodyFont = scale.find((t) => t.element === "p" || t.element === "body");
    if (headingFont) lines.push(`  --font-heading: "${headingFont.name || headingFont.fontFamily}", sans-serif;`);
    if (bodyFont) lines.push(`  --font-body: "${bodyFont.fontFamily}", sans-serif;`);
    for (const t of scale) {
      const tag = t.element.replace(/[^a-z0-9]/g, "");
      lines.push(`  --font-size-${tag}: ${t.fontSize};`);
      lines.push(`  --line-height-${tag}: ${t.lineHeight};`);
      lines.push(`  --font-weight-${tag}: ${t.fontWeight};`);
    }

    // CTAs
    const ctas = kit.ctas || [];
    if (ctas.length > 0) {
      lines.push("");
      lines.push("  /* CTA */");
      const cta = ctas[0]; // primary CTA
      lines.push(`  --cta-bg: ${cta.backgroundColor};`);
      lines.push(`  --cta-color: ${cta.color};`);
      lines.push(`  --cta-font: "${cta.fontFamily}", sans-serif;`);
      lines.push(`  --cta-weight: ${cta.fontWeight};`);
      lines.push(`  --cta-size: ${cta.fontSize};`);
      lines.push(`  --cta-radius: ${cta.borderRadius};`);
      lines.push(`  --cta-padding: ${cta.padding};`);
    }

    lines.push("}");
    return lines.join("\n");
  }

  /** Generate W3C Design Tokens JSON (Style Dictionary / Tokens Studio compatible) */
  function generateDesignTokensJSON(kit) {
    const tokens = {};

    // Colors
    tokens.color = {};
    if (kit.colors.primary) tokens.color.primary = { $value: kit.colors.primary, $type: "color" };
    if (kit.colors.secondary) tokens.color.secondary = { $value: kit.colors.secondary, $type: "color" };
    if (kit.colors.background) tokens.color.background = { $value: kit.colors.background, $type: "color" };
    if (kit.colors.text) tokens.color.text = { $value: kit.colors.text, $type: "color" };
    (kit.colors.all || []).forEach((c, i) => {
      const key = c.name ? c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") : `palette-${i + 1}`;
      tokens.color[key] = { $value: c.hex, $type: "color" };
    });

    // Typography
    const scale = kit.typography.scale || [];
    const declared = kit.typography.fonts?.declared || [];
    if (declared.length > 0) {
      tokens.fontFamily = {};
      const headingFont = declared[0];
      const bodyFont = declared.length > 1 ? declared[1] : declared[0];
      tokens.fontFamily.heading = { $value: headingFont.name, $type: "fontFamily" };
      tokens.fontFamily.body = { $value: bodyFont.name, $type: "fontFamily" };
    }
    if (scale.length > 0) {
      tokens.fontSize = {};
      tokens.lineHeight = {};
      tokens.fontWeight = {};
      for (const t of scale) {
        const key = t.element.replace(/[^a-z0-9]/g, "");
        tokens.fontSize[key] = { $value: t.fontSize, $type: "dimension" };
        tokens.lineHeight[key] = { $value: t.lineHeight, $type: "dimension" };
        tokens.fontWeight[key] = { $value: t.fontWeight, $type: "fontWeight" };
      }
    }

    // CTA
    const ctas = kit.ctas || [];
    if (ctas.length > 0) {
      const cta = ctas[0];
      tokens.cta = {
        background: { $value: cta.backgroundColor, $type: "color" },
        color: { $value: cta.color, $type: "color" },
        borderRadius: { $value: cta.borderRadius, $type: "dimension" },
        padding: { $value: cta.padding, $type: "dimension" },
        fontFamily: { $value: cta.fontFamily, $type: "fontFamily" },
        fontWeight: { $value: cta.fontWeight, $type: "fontWeight" },
        fontSize: { $value: cta.fontSize, $type: "dimension" },
      };
    }

    return JSON.stringify(tokens, null, 2);
  }

  /** Generate markdown brand brief for AI agents / handoff */
  function generateBrandBriefMD(kit) {
    const lines = [];
    const br = kit.brand;

    lines.push(`# Brand Brief: ${br.name || "Unknown"}`);
    lines.push("");
    lines.push(`> Auto-extracted by Net Assets Scraper · ${new Date(kit.exportedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
    lines.push("");

    // Identity
    lines.push("## Identity");
    if (br.url) lines.push(`- **URL**: ${br.url}`);
    if (br.description) lines.push(`- **Description**: ${br.description}`);
    lines.push("");

    // Colors
    const colors = kit.colors;
    lines.push("## Colors");
    lines.push("");
    lines.push("| Role | Hex |");
    lines.push("|------|-----|");
    if (colors.primary) lines.push(`| Primary | \`${colors.primary}\` |`);
    if (colors.secondary) lines.push(`| Secondary | \`${colors.secondary}\` |`);
    if (colors.background) lines.push(`| Background | \`${colors.background}\` |`);
    if (colors.text) lines.push(`| Text | \`${colors.text}\` |`);
    for (const c of (colors.all || []).slice(0, 12)) {
      lines.push(`| ${c.name || "Palette"} | \`${c.hex}\` |`);
    }
    lines.push("");

    // Typography
    const scale = kit.typography.scale || [];
    const declared = kit.typography.fonts?.declared || [];
    if (scale.length > 0 || declared.length > 0) {
      lines.push("## Typography");
      lines.push("");
      if (declared.length > 0) {
        lines.push("**Fonts**: " + declared.map((f) => `${f.name} (${f.source})`).join(", "));
        lines.push("");
      }
      if (scale.length > 0) {
        lines.push("| Element | Font | Weight | Size | Line Height |");
        lines.push("|---------|------|--------|------|-------------|");
        for (const t of scale) {
          lines.push(`| ${t.element} | ${t.fontFamily} | ${t.fontWeight} | ${t.fontSize} | ${t.lineHeight} |`);
        }
        lines.push("");
      }
    }

    // CTAs
    const ctas = kit.ctas || [];
    if (ctas.length > 0) {
      lines.push("## Call-to-Action Buttons");
      lines.push("");
      for (const cta of ctas) {
        lines.push(`- **"${cta.text}"** — bg: \`${cta.backgroundColor}\`, color: \`${cta.color}\`, font: ${cta.fontFamily} ${cta.fontWeight} ${cta.fontSize}, radius: ${cta.borderRadius}, padding: ${cta.padding}`);
      }
      lines.push("");
    }

    // Copy bank
    const copy = kit.copy || {};
    const headlines = copy.headlines || [];
    if (headlines.length > 0 || copy.tagline || copy.description) {
      lines.push("## Copy Bank");
      lines.push("");
      if (copy.tagline) lines.push(`- **Tagline**: "${copy.tagline}"`);
      if (copy.description) lines.push(`- **Description**: "${copy.description}"`);
      if (headlines.length > 0) {
        lines.push("- **Headlines**:");
        for (const h of headlines.slice(0, 10)) lines.push(`  - "${h}"`);
      }
      lines.push("");
    }

    // Social
    const social = Object.entries(br.socialLinks || {}).filter(([, url]) => url);
    if (social.length > 0) {
      lines.push("## Social Presence");
      lines.push("");
      for (const [platform, url] of social) {
        lines.push(`- **${platform}**: ${url}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /** Generate plain-text quick summary for sales / non-technical */
  function generateQuickSummary(kit) {
    const lines = [];
    const br = kit.brand;
    lines.push(`${br.name || "Brand"} — ${(br.url || "").replace(/^https?:\/\//, "")}`);
    lines.push("");
    if (br.description) lines.push(br.description);
    if (br.description) lines.push("");

    const colors = kit.colors;
    const colorParts = [];
    if (colors.primary) colorParts.push(`Primary: ${colors.primary}`);
    if (colors.secondary) colorParts.push(`Secondary: ${colors.secondary}`);
    if (colors.background) colorParts.push(`Background: ${colors.background}`);
    if (colors.text) colorParts.push(`Text: ${colors.text}`);
    if (colorParts.length > 0) lines.push("Colors: " + colorParts.join("  ·  "));

    const declared = kit.typography.fonts?.declared || [];
    if (declared.length > 0) lines.push("Fonts: " + declared.map((f) => f.name).join(", "));

    const ctas = kit.ctas || [];
    if (ctas.length > 0) {
      const cta = ctas[0];
      lines.push(`CTA style: ${cta.borderRadius !== "0px" ? "rounded" : "sharp"}, ${cta.fontWeight >= 600 ? "bold" : "regular"}, ${cta.backgroundColor} on ${cta.color}`);
    }

    return lines.join("\n");
  }

  /**
   * Generate Adobe Swatch Exchange (.ase) binary file.
   * Spec: https://www.cyotek.com/blog/reading-adobe-swatch-exchange-ase-files-using-csharp
   * Used by: Photoshop, Illustrator, InDesign, Affinity Designer, Procreate
   */
  function generateASE(kit) {
    const colors = [];
    // Semantic colors first
    if (kit.colors.primary) colors.push({ name: "Primary", hex: kit.colors.primary });
    if (kit.colors.secondary) colors.push({ name: "Secondary", hex: kit.colors.secondary });
    if (kit.colors.background) colors.push({ name: "Background", hex: kit.colors.background });
    if (kit.colors.text) colors.push({ name: "Text", hex: kit.colors.text });
    // Palette colors
    for (const c of (kit.colors.all || []).slice(0, 50)) {
      colors.push({ name: c.name || c.hex, hex: c.hex });
    }
    if (colors.length === 0) return null;

    // Parse hex to RGB floats (0-1 range)
    function hexToRGB(hex) {
      const h = (hex || "#000000").replace("#", "");
      return [
        parseInt(h.substr(0, 2), 16) / 255,
        parseInt(h.substr(2, 2), 16) / 255,
        parseInt(h.substr(4, 2), 16) / 255,
      ];
    }

    // Calculate total binary size
    // Header: 4 (signature) + 2 (version major) + 2 (version minor) + 4 (block count)
    // Group start: 2 (type) + 4 (block length) + 2 (name length) + name chars * 2 + 2 (null term)
    // Color entry: 2 (type) + 4 (block length) + 2 (name length) + name chars * 2 + 2 (null term) + 4 (color model) + 12 (RGB floats) + 2 (color type)
    // Group end: 2 (type) + 4 (block length = 0)

    const groupName = (kit.brand.name || "Brand") + " Colors";

    // Pre-calculate sizes
    let totalSize = 12; // header
    totalSize += 2 + 4 + (2 + (groupName.length + 1) * 2); // group start
    for (const c of colors) {
      const nameLen = c.name.length + 1; // +1 for null terminator
      totalSize += 2 + 4 + (2 + nameLen * 2) + 4 + 12 + 2; // color entry
    }
    totalSize += 2 + 4; // group end

    const buf = new ArrayBuffer(totalSize);
    const view = new DataView(buf);
    let offset = 0;

    // Write helpers
    function writeUint32(val) { view.setUint32(offset, val, false); offset += 4; }
    function writeUint16(val) { view.setUint16(offset, val, false); offset += 2; }
    function writeFloat32(val) { view.setFloat32(offset, val, false); offset += 4; }
    function writeString(str) {
      // Write as UTF-16BE (each char = 2 bytes)
      for (let i = 0; i < str.length; i++) {
        view.setUint16(offset, str.charCodeAt(i), false);
        offset += 2;
      }
      // Null terminator
      view.setUint16(offset, 0, false);
      offset += 2;
    }

    // ── Header ──
    // Signature: "ASEF"
    view.setUint8(offset++, 0x41); // A
    view.setUint8(offset++, 0x53); // S
    view.setUint8(offset++, 0x45); // E
    view.setUint8(offset++, 0x46); // F
    writeUint16(1); // version major
    writeUint16(0); // version minor
    writeUint32(colors.length + 2); // block count (colors + group start + group end)

    // ── Group start ──
    writeUint16(0xC001); // group start marker
    const groupNameBytes = 2 + (groupName.length + 1) * 2; // name length field + UTF-16BE chars + null
    writeUint32(groupNameBytes); // block length
    writeUint16(groupName.length + 1); // name length (chars including null)
    writeString(groupName);

    // ── Color entries ──
    for (const c of colors) {
      writeUint16(0x0001); // color entry marker
      const nameBytes = 2 + (c.name.length + 1) * 2;
      const blockLen = nameBytes + 4 + 12 + 2; // name + color model + RGB + color type
      writeUint32(blockLen);
      writeUint16(c.name.length + 1);
      writeString(c.name);
      // Color model: "RGB " (4 bytes)
      view.setUint8(offset++, 0x52); // R
      view.setUint8(offset++, 0x47); // G
      view.setUint8(offset++, 0x42); // B
      view.setUint8(offset++, 0x20); // space
      // RGB values as floats
      const [r, g, b] = hexToRGB(c.hex);
      writeFloat32(r);
      writeFloat32(g);
      writeFloat32(b);
      // Color type: 0 = Global
      writeUint16(0);
    }

    // ── Group end ──
    writeUint16(0xC002); // group end marker
    writeUint32(0); // block length = 0

    return buf;
  }

  // ── Build page title ──
  const brandName = kit.brand.name || "Brand Kit";
  const brandUrl = kit.brand.url || "";
  const cleanUrl = brandUrl.replace(/^https?:\/\//, "");
  const exportDate = new Date(kit.exportedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const assetCount = kit.assetCount || 0;
  document.title = `${brandName} — Brand Guideline`;

  // ── Render ──
  let html = "";

  // Header
  html += `<header class="brand-header">
    <div class="brand-header-left">
      <h1>${esc(brandName)}<em>.</em></h1>
      <div class="meta">
        ${brandUrl ? `<a href="${esc(brandUrl)}" target="_blank" rel="noopener">${esc(cleanUrl)}</a>` : ""}
        <span>${exportDate}</span>
        <span>${assetCount > 0 ? `${assetCount} asset${assetCount !== 1 ? "s" : ""} in this kit` : "brand data only — no media assets"}</span>
      </div>
    </div>
    <label class="theme-label" for="themeToggle" title="Switch light/dark theme"><span class="icon-moon">🌙</span><span class="icon-sun">☀️</span></label>
  </header>`;

  html += `<div class="copy-hint-banner">click any value to copy · colors, fonts, text, CSS specs</div>`;

  // ── Quick Summary (sales / non-technical lane) ──
  const summary = generateQuickSummary(kit);
  html += `<div class="quick-summary">
    <div class="quick-summary-header">
      <span class="quick-summary-label">📋 QUICK SUMMARY</span>
      <button class="btn-summary-copy" id="copySummary">Copy to clipboard</button>
    </div>
    <pre class="quick-summary-text">${esc(summary)}</pre>
  </div>`;

  // ── Colors ──
  const semanticColors = [
    { label: "Primary", hex: kit.colors.primary },
    { label: "Secondary", hex: kit.colors.secondary },
    { label: "Background", hex: kit.colors.background },
    { label: "Text", hex: kit.colors.text },
  ].filter((c) => c.hex);

  if (semanticColors.length > 0 || (kit.colors.all && kit.colors.all.length > 0)) {
    html += `<section><h2>Colors</h2>`;
    if (semanticColors.length > 0) {
      html += `<div class="color-grid color-semantic">`;
      for (const c of semanticColors) {
        html += `<div class="swatch semantic" data-copy="${esc(c.hex)}" title="Click to copy">
          <div class="swatch-color" style="background:${esc(c.hex)}"></div>
          <span class="swatch-label">${esc(c.label)}</span>
          <span class="swatch-hex">${esc(c.hex)}</span>
        </div>`;
      }
      html += `</div>`;
    }
    if (kit.colors.all && kit.colors.all.length > 0) {
      html += `<div class="color-grid" style="margin-top:16px">`;
      for (const c of kit.colors.all) {
        html += `<div class="swatch" data-copy="${esc(c.hex)}" title="Click to copy">
          <div class="swatch-color" style="background:${esc(c.hex)}"></div>
          <span class="swatch-hex">${esc(c.hex)}</span>
          ${c.name ? `<span class="swatch-name">${esc(c.name)}</span>` : ""}
        </div>`;
      }
      html += `</div>`;
    }
    html += `</section>`;
  }

  // ── Typography scale ──
  const scale = kit.typography.scale || [];
  if (scale.length > 0) {
    html += `<section><h2>Typography</h2>`;
    for (const t of scale) {
      const sample = t.element.startsWith("h") ? "The quick brown fox" : t.element === "button" ? "Click here" : "The quick brown fox jumps over the lazy dog";
      html += `<div class="type-row">
        <div class="type-meta">
          <strong>${esc(t.element)}</strong>
          <span>${esc(t.fontFamily)} · ${esc(t.fontWeight)} · ${esc(t.fontSize)} / ${esc(t.lineHeight)}</span>
          ${t.letterSpacing && t.letterSpacing !== "0" ? `<span>tracking: ${esc(t.letterSpacing)}</span>` : ""}
          ${t.textTransform ? `<span>transform: ${esc(t.textTransform)}</span>` : ""}
        </div>
        <div class="type-sample" style="font-size:${esc(t.fontSize)};font-weight:${esc(t.fontWeight)};line-height:${esc(t.lineHeight)};letter-spacing:${t.letterSpacing || "normal"};${t.textTransform ? "text-transform:" + esc(t.textTransform) + ";" : ""}">${sample}</div>
      </div>`;
    }
    html += `</section>`;
  }

  // ── Fonts ──
  const declared = kit.typography.fonts?.declared || [];
  const used = kit.typography.fonts?.used || [];
  if (declared.length > 0 || used.length > 0) {
    html += `<section><h2>Fonts</h2>`;
    if (declared.length > 0) {
      html += `<ul class="font-list">`;
      for (const f of declared) {
        html += `<li><strong>${esc(f.name)}</strong> <span class="tag">${esc(f.source)}</span> <button class="copy-btn" data-copy="${esc(f.name)}">copy</button></li>`;
      }
      html += `</ul>`;
    }
    if (used.length > 0) {
      html += `<p style="font-size:11px;color:var(--muted);margin-top:12px;margin-bottom:6px">Also detected in computed styles:</p><ul class="font-list">`;
      for (const f of used) {
        html += `<li>${esc(f)} <button class="copy-btn" data-copy="${esc(f)}">copy</button></li>`;
      }
      html += `</ul>`;
    }
    html += `</section>`;
  }

  // ── Copy bank ──
  const headlines = kit.copy.headlines || [];
  const tagline = kit.copy.tagline;
  const description = kit.copy.description;
  if (headlines.length > 0 || tagline || description) {
    html += `<section><h2>Copy</h2>`;
    for (const h of headlines) {
      html += `<div class="copy-item" data-copy="${esc(h)}">
        <span class="copy-text">${esc(h)}</span>
        <span class="copy-hint">click to copy</span>
      </div>`;
    }
    if (tagline) {
      html += `<div class="copy-item" data-copy="${esc(tagline)}">
        <span class="copy-label">Tagline</span>
        <span class="copy-text">${esc(tagline)}</span>
        <span class="copy-hint">click to copy</span>
      </div>`;
    }
    if (description) {
      html += `<div class="copy-item" data-copy="${esc(description)}">
        <span class="copy-label">Description</span>
        <span class="copy-text">${esc(description)}</span>
        <span class="copy-hint">click to copy</span>
      </div>`;
    }
    html += `</section>`;
  }

  // ── CTA buttons ──
  const ctas = kit.ctas || [];
  if (ctas.length > 0) {
    html += `<section><h2>Call-to-Action Buttons</h2>`;
    for (const cta of ctas) {
      const cssSpec = `background: ${cta.backgroundColor}; color: ${cta.color}; font-family: ${cta.fontFamily}, sans-serif; font-weight: ${cta.fontWeight}; font-size: ${cta.fontSize}; border-radius: ${cta.borderRadius}; padding: ${cta.padding};`;
      html += `<div class="cta-card">
        <div class="cta-preview" style="background:${esc(cta.backgroundColor)};color:${esc(cta.color)};font-family:${esc(cta.fontFamily)},sans-serif;font-weight:${esc(cta.fontWeight)};font-size:${esc(cta.fontSize)};border-radius:${esc(cta.borderRadius)};padding:${esc(cta.padding)};display:inline-block">${esc(cta.text)}</div>
        <div class="cta-specs">
          <span>bg: <strong>${esc(cta.backgroundColor)}</strong></span>
          <span>color: <strong>${esc(cta.color)}</strong></span>
          <span>font: ${esc(cta.fontFamily)} ${esc(cta.fontWeight)} ${esc(cta.fontSize)}</span>
          <span>radius: ${esc(cta.borderRadius)}</span>
          <span>padding: ${esc(cta.padding)}</span>
        </div>
        <div class="cta-css" data-copy="${esc(cssSpec)}" title="Click to copy CSS">📋 ${esc(cssSpec)}</div>
      </div>`;
    }
    html += `</section>`;
  }

  // ── Social links ──
  const socialEntries = Object.entries(kit.brand.socialLinks || {}).filter(([, url]) => url);
  if (socialEntries.length > 0) {
    html += `<section><h2>Social</h2><div class="social-links">`;
    for (const [platform, url] of socialEntries) {
      html += `<a href="${esc(url)}" class="social-link" target="_blank" rel="noopener">${esc(platform)}</a>`;
    }
    html += `</div></section>`;
  }

  // ── Structured data ──
  if (kit.structuredData && kit.structuredData.length > 0) {
    html += `<section><h2>Structured Data (JSON-LD)</h2>`;
    for (const d of kit.structuredData) {
      const lines = [`<strong>${esc(d.type)}</strong>`];
      if (d.name) lines.push(`Name: ${esc(d.name)}`);
      if (d.url) lines.push(`URL: <a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url)}</a>`);
      if (d.description) lines.push(`Desc: ${esc(d.description)}`);
      if (d.sameAs) lines.push(`Links: ${d.sameAs.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`).join(", ")}`);
      html += `<div class="structured-item">${lines.join("<br>")}</div>`;
    }
    html += `</section>`;
  }

  // ── Export Tokens ──
  html += `<section class="export-section">
    <h2>Export</h2>
    <div class="export-buttons">
      <button class="btn-export" id="exportCSS" title="CSS custom properties for web projects">⬇ CSS Tokens</button>
      <button class="btn-export" id="exportDesignTokens" title="W3C Design Tokens JSON for Figma / Style Dictionary">⬇ Design Tokens</button>
      <button class="btn-export" id="exportJSON" title="Full brand kit data — colors, fonts, typography, CTAs, copy, social">⬇ Brand JSON</button>
      <button class="btn-export" id="exportBrief" title="Markdown brand brief for AI agents">⬇ Brand Brief</button>
      <button class="btn-export" id="exportASE" title="Adobe Swatch Exchange — import colors into Photoshop, Illustrator, InDesign">⬇ Adobe Swatches</button>
      <button class="btn-export btn-export-secondary" id="printPDF" title="Print or save as PDF">🖨 Print / PDF</button>
    </div>
  </section>`;

  // Footer
  html += `<footer class="guide-footer">
    <p>Extracted by <strong>Net Assets Scraper</strong> v${chrome.runtime.getManifest().version} · ${exportDate}</p>
  </footer>`;

  // ── Inject into page ──
  loading.style.display = "none";
  content.style.display = "block";
  content.innerHTML = html;

  // ── Wire up click-to-copy on all [data-copy] elements ──
  content.addEventListener("click", (e) => {
    const target = e.target.closest("[data-copy]");
    if (target) {
      copyText(target.dataset.copy);
    }
  });

  // ── Wire up Quick Summary copy ──
  document.getElementById("copySummary")?.addEventListener("click", () => {
    copyText(summary);
  });

  // ── Wire up Export buttons ──
  const safeName = (kit.brand.name || "brand").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  document.getElementById("exportCSS")?.addEventListener("click", () => {
    downloadFile(generateBrandTokensCSS(kit), `${safeName}-tokens.css`, "text/css");
  });

  document.getElementById("exportDesignTokens")?.addEventListener("click", () => {
    downloadFile(generateDesignTokensJSON(kit), `${safeName}-tokens.json`, "application/json");
  });

  document.getElementById("exportJSON")?.addEventListener("click", () => {
    downloadFile(JSON.stringify(kit, null, 2), `${safeName}-brand.json`, "application/json");
  });

  document.getElementById("exportBrief")?.addEventListener("click", () => {
    downloadFile(generateBrandBriefMD(kit), `${safeName}-brand-brief.md`, "text/markdown");
  });

  document.getElementById("exportASE")?.addEventListener("click", () => {
    const aseBuffer = generateASE(kit);
    if (aseBuffer) {
      const blob = new Blob([aseBuffer], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-colors.ase`;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
      showToast("Downloaded: " + `${safeName}-colors.ase`);
    } else {
      showToast("No colors to export");
    }
  });

  document.getElementById("printPDF")?.addEventListener("click", () => {
    window.print();
  });

  // Clean up session storage
  try {
    chrome.storage.session.remove("guidelineKit");
  } catch {
    chrome.storage.local.remove("guidelineKit");
  }
})();
