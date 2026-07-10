/**
 * Proton2025 Theme - Settings Synchronization Module
 * Copyright 2025-2026 ChesterGoodiny
 * Licensed under the Apache License, Version 2.0
 * See LICENSE and NOTICE for details.
 *
 * Implements a hybrid storage approach:
 * - localStorage: Fast cache for instant UI updates (no flicker)
 * - UCI (via ubus): Persistent storage, syncs across browsers/devices
 *
 * Flow:
 * 1. On page load: Apply from localStorage immediately (sync, in <head>)
 * 2. After load: Fetch from UCI, seed localStorage for keys that don't
 *    exist yet (first visit / new device). Never overwrite a value the
 *    user has already set in this browser.
 * 3. On change: Update localStorage + apply immediately, then save to UCI async
 */

"use strict";

(function () {
  // Mapping between localStorage keys and UCI option names
  const SETTINGS_MAP = {
    "proton-theme-mode": "mode",
    "proton-accent-color": "accent",
    "proton-accent-custom": "accent_custom",
    "proton-zoom": "zoom",
    "proton-transparency": "transparency",
    "proton-border-radius": "border_radius",
    "proton-tab-outline": "tab_outline",
    "proton-animations": "animations",
    "proton-services-widget-enabled": "services_widget",
    "proton-temp-widget-enabled": "temp_widget",
    "proton-services-log": "services_log",
    "proton-table-wrap": "table_wrap",
    "proton-log-highlight": "log_highlight",
    "proton-page-width": "page_width",
    "proton-background-pattern": "background_pattern",
    "proton-pattern-scale": "pattern_scale",
    "proton-custom-font": "custom_font",
    "proton-login-animation": "login_animation",
    "proton-login-branding": "login_branding",
    "proton-login-name": "login_name",
    "proton-login-logo": "login_logo",
    "proton-login-logo-only": "login_logo_only",
  };

  // Reverse mapping
  const UCI_TO_LOCAL = {};
  for (const [local, uci] of Object.entries(SETTINGS_MAP)) {
    UCI_TO_LOCAL[uci] = local;
  }

  const PENDING_SESSION_KEY = "proton-settings-pending";
  const SAVE_DEBOUNCE_MS = 500;

  // Convert UCI value to localStorage format
  function uciToLocal(uciName, uciValue) {
    // Boolean options stored as '0'/'1' in UCI
    const booleanOptions = [
      "transparency",
      "animations",
      "services_widget",
      "temp_widget",
      "services_log",
      "table_wrap",
      "log_highlight",
      "custom_font",
      "tab_outline",
      "login_branding",
      "login_logo_only",
    ];

    if (booleanOptions.includes(uciName)) {
      return uciValue === "1" ? "true" : "false";
    }

    // Numeric options: keep as-is
    return uciValue;
  }

  // Convert localStorage value to UCI format
  function localToUci(localName, localValue) {
    const uciName = SETTINGS_MAP[localName];
    const booleanOptions = [
      "transparency",
      "animations",
      "services_widget",
      "temp_widget",
      "services_log",
      "table_wrap",
      "log_highlight",
      "custom_font",
      "tab_outline",
      "login_branding",
      "login_logo_only",
    ];

    if (booleanOptions.includes(uciName)) {
      return localValue === "true" || localValue === true ? "1" : "0";
    }

    return String(localValue);
  }

  function getSessionStorage() {
    try {
      return window.sessionStorage;
    } catch (err) {
      return null;
    }
  }

  function readPendingChanges() {
    const storage = getSessionStorage();
    if (!storage) return {};

    try {
      const raw = storage.getItem(PENDING_SESSION_KEY);
      if (!raw) return {};

      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (err) {
      return {};
    }
  }

  function hasPendingChanges() {
    return Object.keys(pendingChanges).length > 0;
  }

  function persistPendingChanges() {
    const storage = getSessionStorage();
    if (!storage) return;

    try {
      if (!hasPendingChanges()) {
        storage.removeItem(PENDING_SESSION_KEY);
        return;
      }

      storage.setItem(PENDING_SESSION_KEY, JSON.stringify(pendingChanges));
    } catch (err) {
      // Ignore sessionStorage failures
    }
  }

  function getRpcPath() {
    return (window.L && L.env && L.env.ubuspath) || "/ubus/";
  }

  function getRpcSessionId() {
    return (
      (window.L && L.env && L.env.sessionid) ||
      "00000000000000000000000000000000"
    );
  }

  async function callSettingsRpc(method, args, options = {}) {
    const response = await fetch(getRpcPath(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: !!options.keepalive,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "call",
        params: [getRpcSessionId(), "luci.proton-settings", method, args || {}],
      }),
    });

    if (options.fireAndForget) {
      return null;
    }

    return response.json();
  }

  // Sync status tracking
  let syncInProgress = false;
  let pendingChanges = readPendingChanges();
  let saveTimeout = null;

  // Track the last time the user made a local change, so syncFromUci
  // can skip overwriting localStorage if the user just changed something
  // and the UCI save hasn't round-tripped yet.
  const SYNC_COOLDOWN_MS = 3000;
  let lastLocalChange = 0;

  // Debounced save to UCI
  function scheduleSaveToUci(delayMs = SAVE_DEBOUNCE_MS) {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }

    saveTimeout = setTimeout(() => {
      saveTimeout = null;
      saveToUci();
    }, delayMs);
  }

  // Save pending changes to UCI
  async function saveToUci() {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    if (!hasPendingChanges()) return;

    // Keep the pending changes queued (persisted) until the save is
    // *confirmed*. If we cleared them up front and the page navigated
    // mid-save, the next page would see no pending changes, run its UCI
    // sync against not-yet-committed data, and clobber the new value
    // (e.g. a freshly chosen custom accent reverting on navigation).
    const changes = { ...pendingChanges };

    try {
      const result = await callSettingsRpc("setSettings", {
        settings: changes,
      });
      const payload = result?.result?.[1];

      if (!payload?.success) {
        if (payload?.errors?.length) {
          console.warn("[Proton2025] UCI save errors:", payload.errors);
        }

        throw new Error("Settings save was not confirmed by ubus");
      }

      // Confirmed — drop only the keys we saved (and only if they weren't
      // changed again meanwhile).
      for (const k of Object.keys(changes)) {
        if (pendingChanges[k] === changes[k]) delete pendingChanges[k];
      }
      persistPendingChanges();
    } catch (err) {
      console.warn("[Proton2025] Failed to save to UCI:", err);
      // Leave the pending changes in place so they are retried on the
      // next page load (and guard that page's sync in the meantime).
    }
  }

  function flushPendingChangesOnPageHide() {
    if (!hasPendingChanges()) return;

    // Cancel any pending debounced save to avoid double-save race.
    if (saveTimeout) {
      clearTimeout(saveTimeout);
      saveTimeout = null;
    }

    callSettingsRpc(
      "setSettings",
      { settings: { ...pendingChanges } },
      { keepalive: true, fireAndForget: true },
    ).catch(() => {
      // The session-backed queue will be retried on the next page.
    });
  }

  // Load settings from UCI and sync to localStorage
  async function syncFromUci() {
    if (syncInProgress || hasPendingChanges()) return;

    // If the user made local changes recently, skip sync and let the
    // debounced UCI save complete first — otherwise UCI may still
    // carry stale values and overwrite the user's just-changed setting.
    if (Date.now() - lastLocalChange < SYNC_COOLDOWN_MS) return;

    syncInProgress = true;

    try {
      const result = await callSettingsRpc("getSettings", {});

      const settings = result?.result?.[1]?.settings;
      if (!settings) {
        // No UCI settings found, using localStorage
        return;
      }

      let updated = false;

      // Set flag to prevent sync loop
      isSyncingFromUci = true;

      try {
        // A deliberately-picked-but-not-yet-saved local value is protected at
        // the top: syncFromUci() bails out while hasPendingChanges() is true
        // (that queue is persisted in sessionStorage across navigation) and
        // within SYNC_COOLDOWN_MS of the last local change. Here we only seed
        // keys absent from localStorage (see loop below) — UCI is never allowed
        // to clobber a value the user already set in this browser, because the
        // UCI write can lag behind / be lost and would otherwise revert it.
        for (const [uciName, uciValue] of Object.entries(settings)) {
          const localKey = UCI_TO_LOCAL[uciName];
          if (!localKey) continue;

          const localValue = uciToLocal(uciName, uciValue);
          const currentLocal = localStorage.getItem(localKey);

          // Only seed keys that are *absent* from localStorage. Never
          // clobber a value the user explicitly set in this browser.
          //
          // Previously this block treated UCI as authoritative and overwrote
          // localStorage whenever the two diverged. But the UCI write is
          // debounced (500ms) and, on unload, flushed via an unreliable
          // `keepalive` request that browsers frequently drop. So after a
          // change the just-written UCI value could still be stale while
          // localStorage already held the new value — the next syncFromUci()
          // would then revert the user's choice back to the old setting.
          //
          // localStorage is the source of truth for this browser; UCI only
          // provides values for keys that don't exist locally yet (first
          // visit / new device). This fixes settings reverting on reload or
          // tab-switch.
          if (currentLocal === null) {
            originalSetItem(localKey, localValue); // Use original to avoid triggering save back
            updated = true;
          }
        }

        if (updated) {
          // Dispatch event for UI to update
          window.dispatchEvent(new CustomEvent("proton-settings-synced"));
        }
      } finally {
        isSyncingFromUci = false;
      }
    } catch (err) {
      console.warn("[Proton2025] Failed to sync from UCI:", err);
    } finally {
      syncInProgress = false;
    }
  }

  // Flag to prevent sync loop
  let isSyncingFromUci = false;

  // Intercept localStorage.setItem for proton settings
  const originalSetItem = localStorage.setItem.bind(localStorage);

  localStorage.setItem = function (key, value) {
    originalSetItem(key, value);

    // If this is a proton setting and not syncing from UCI, queue for UCI save
    if (SETTINGS_MAP[key] && !isSyncingFromUci) {
      lastLocalChange = Date.now();
      const uciName = SETTINGS_MAP[key];
      const uciValue = localToUci(key, value);
      pendingChanges[uciName] = uciValue;
      persistPendingChanges();
      scheduleSaveToUci();
    }
  };

  // Export sync function for manual trigger
  window.protonSettingsSync = {
    syncFromUci: syncFromUci,
    saveToUci: saveToUci,
    flushPendingChanges: saveToUci,

    // Force full sync (useful after login)
    forceSync: async function () {
      await syncFromUci();
    },

    // Reset all settings to defaults
    resetToDefaults: async function () {
      const defaults = {
        "proton-theme-mode": "auto",
        "proton-accent-color": "blue",
        "proton-accent-custom": "#5e9eff",
        "proton-zoom": "100",
        "proton-transparency": "true",
        "proton-border-radius": "default",
        "proton-tab-outline": "false",
        "proton-animations": "true",
        "proton-services-widget-enabled": "true",
        "proton-temp-widget-enabled": "true",
        "proton-services-log": "false",
        "proton-table-wrap": "false",
        "proton-log-highlight": "true",
        "proton-page-width": "0",
        "proton-background-pattern": "none",
        "proton-pattern-scale": "100",
        "proton-custom-font": "true",
        "proton-login-animation": "particles",
        "proton-login-branding": "false",
        "proton-login-name": "",
        "proton-login-logo": "",
        "proton-login-logo-only": "false",
      };

      // Clear all proton settings from localStorage
      Object.keys(SETTINGS_MAP).forEach((key) => {
        localStorage.removeItem(key);
      });

      // Apply defaults to localStorage
      Object.entries(defaults).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          originalSetItem(key, value);
        }
      });

      // Reset UCI settings on server
      try {
        const resetData = {};
        Object.keys(SETTINGS_MAP).forEach((key) => {
          const uciName = SETTINGS_MAP[key];
          const defaultValue = defaults[key];
          resetData[uciName] = (defaultValue !== undefined && defaultValue !== null)
            ? localToUci(key, defaultValue)
            : "";
        });

        await callSettingsRpc("setSettings", { settings: resetData });
      } catch (err) {
        console.warn("[Proton2025] Failed to reset UCI settings:", err);
      }

      // Reload page to apply defaults
      window.location.reload();
    },
  };

  if (hasPendingChanges()) {
    scheduleSaveToUci(50);
  }

  // Auto-sync after page load
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      // Delay sync to let LuCI initialize
      setTimeout(syncFromUci, 1000);
    });
  } else {
    setTimeout(syncFromUci, 1000);
  }

  // Re-sync when tab becomes visible (user might have changed settings in another tab).
  // Only re-sync if there are no pending local changes to avoid overwriting them.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushPendingChangesOnPageHide();
      return;
    }

    if (!hasPendingChanges()) {
      syncFromUci();
    }
  });

  window.addEventListener("pagehide", flushPendingChangesOnPageHide);
  window.addEventListener("beforeunload", flushPendingChangesOnPageHide);
})();
