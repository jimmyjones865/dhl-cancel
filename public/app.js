// Captures barcode scanner input (keyboard-emulation, ends with Enter),
// POSTs to /cancel, and shows OK / human-readable error.
(() => {
  const input = document.getElementById("scan");
  const banner = document.getElementById("banner");
  const indicator = document.getElementById("indicator");
  const manualForm = document.getElementById("manual-form");
  const manualInput = document.getElementById("manual");

  let busy = false;
  let resetTimer = null;

  // Always keep focus on the hidden input so a scan "just types" into it,
  // unless the user is typing into the manual entry field.
  const focusInput = () => {
    if (document.activeElement === manualInput) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
  };
  focusInput();
  window.addEventListener("click", focusInput);
  window.addEventListener("focus", focusInput);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) focusInput();
  });
  // Re-focus aggressively in case something steals focus.
  setInterval(focusInput, 500);

  function setBanner(state, statusText, detail, ship) {
    banner.className = `banner ${state}`;
    banner.innerHTML = "";
    const s = document.createElement("div");
    s.className = "status";
    s.textContent = statusText;
    banner.appendChild(s);
    if (detail) {
      const d = document.createElement("div");
      d.className = "detail";
      d.textContent = detail;
      banner.appendChild(d);
    }
    if (ship) {
      const sh = document.createElement("div");
      sh.className = "ship";
      sh.textContent = ship;
      banner.appendChild(sh);
    }
  }

  function scheduleReset(ms) {
    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(() => {
      setBanner("idle", "—");
      focusInput();
    }, ms);
  }

  async function submit(shipment) {
    if (busy) return;
    busy = true;
    indicator.style.visibility = "hidden";
    setBanner("busy", "…", `Sendung ${shipment} wird storniert`);

    try {
      const res = await fetch("/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shipment }),
      });
      let data = null;
      try { data = await res.json(); } catch { /* ignore */ }

      if (data && data.ok) {
        setBanner("ok", "OK", "Sendung storniert", shipment);
        scheduleReset(3000);
      } else {
        const msg = (data && data.message) || `Fehler (HTTP ${res.status})`;
        setBanner("err", "FEHLER", msg, shipment);
        scheduleReset(8000);
      }
    } catch {
      setBanner("err", "FEHLER", "Verbindung zum Service fehlgeschlagen.", shipment);
      scheduleReset(8000);
    } finally {
      busy = false;
      indicator.style.visibility = "visible";
      input.value = "";
      focusInput();
    }
  }

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      const v = input.value.trim();
      input.value = "";
      if (v) submit(v);
    }
  });

  manualForm.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const v = manualInput.value.trim();
    manualInput.value = "";
    if (v) submit(v);
  });
})();
